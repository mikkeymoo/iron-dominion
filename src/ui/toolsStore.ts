import { archetype, BFLAG } from '../sim/catalog.ts';
import type { CommandBody } from '../sim/commands.ts';
import { tileReadOf } from '../sim/estimate.ts';
import { BMAX, S } from '../sim/layers.ts';
import type { ViewState } from '../render/viewState.ts';
import { tileIdx } from '../sim/tiles.ts';
import type { SimEvent } from '../sim/world.ts';
import { ToolController, type ToolAction, type ToolWorld } from '../render/tools/controller.ts';
import { findFlatSite, findWaterTile } from '../render/tools/sites.ts';
import { buildingAnchor, selectionFrom, type KeyAction, type Tile } from '../render/tools/toolSpec.ts';
import { UndoStack } from './undoStack.ts';

const REASONS: Record<string, string> = {
  funds: 'Not enough money for that.',
  blocked: 'Something is already in the way.',
  terrain: 'That ground cannot be built on, it is water or the wrong kind of land.',
  bounds: 'That reaches past the edge of the map.',
  'too-large': 'That area is too big. Try a smaller one.',
  noop: 'Nothing would change there.',
  slope: 'That would make the ground too steep.',
  flood: 'Digging that low would flood it from the water next to it.',
  limit: 'The land cannot go any higher or lower than that.',
  consumed: 'Cannot undo that, the area has changed since.',
  'not-undoable': 'That can no longer be undone.',
  'not-placeable': 'The robots build that one themselves.',
  'unknown-archetype': 'That building is not available.',
  full: 'The city cannot hold more buildings.',
  superseded: 'That order was dropped when the city was reloaded.',
  invalid: 'That order was not valid.',
  'max-loans': 'You already have three loans. Repay one first.',
  'no-loan': 'That loan has already been repaid.',
  locked: 'That is not unlocked yet.',
};

/** Plain-words text for a sim or estimate rejection reason. */
export const reasonText = (reason: string): string => REASONS[reason] ?? 'That could not be done.';

export interface Toast { id: number; text: string }
export interface FloatText { id: number; text: string; x: number; y: number; gain: boolean }

interface Pending {
  kind: 'build' | 'undo';
  cost: number;
  label: string;
  /** Journal id an undo targets. */
  target?: number;
  at: { x: number; y: number };
}

export interface ToolsRuntimeDeps {
  world: ToolWorld;
  submit(body: CommandBody): number;
  /** The player's view mode: bulldoze digs up pipes while the underground view is on. */
  view?: ViewState;
}

const TOAST_MS = 4000;
const FLOAT_MS = 1600;

const labelOf = (cmd: CommandBody): string =>
  cmd.type === 'placeBuilding' ? (archetype(cmd.arch)?.name ?? 'building') : cmd.type === 'placeLine' ? (cmd.kind === 'power' ? 'power line' : 'water pipe') : cmd.type;

/**
 * Everything the tool UI and the smoke test share for one city: the controller, the player's undo stack, toasts and floating
 * treasury text. Sim events for the commands this runtime sent arrive through handleEvents().
 */
export class ToolsRuntime {
  readonly controller: ToolController;
  readonly undo = new UndoStack();
  toasts: Toast[] = [];
  floats: FloatText[] = [];
  lastEvent: SimEvent | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<() => void>();
  private readonly eventListeners = new Set<(e: SimEvent) => void>();
  private seq = 1;
  private unsubscribeView: (() => void) | undefined;

  constructor(private readonly deps: ToolsRuntimeDeps) {
    this.controller = new ToolController({ world: deps.world, submit: deps.submit, underground: () => deps.view?.underground ?? false });
    this.controller.onAction((a) => this.onAction(a));
    this.controller.subscribe(() => this.notify());
    // The underground view changes what the bulldoze tool would do, so the ghost and cost must follow it.
    this.unsubscribeView = deps.view?.subscribe(() => this.controller.refresh());
  }

  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private notify(): void { for (const fn of this.listeners) fn(); }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => { this.timers.delete(t); fn(); this.notify(); }, ms);
    this.timers.add(t);
  }

  toast(text: string): void {
    const id = this.seq++;
    this.toasts = [...this.toasts.slice(-2), { id, text }];
    this.later(TOAST_MS, () => { this.toasts = this.toasts.filter((t) => t.id !== id); });
    this.notify();
  }

  private float(text: string, at: { x: number; y: number }, gain: boolean): void {
    const id = this.seq++;
    this.floats = [...this.floats.slice(-4), { id, text, x: at.x, y: at.y, gain }];
    this.later(FLOAT_MS, () => { this.floats = this.floats.filter((f) => f.id !== id); });
  }

  private onAction(a: ToolAction): void {
    if (a.kind === 'refused') { this.toast(reasonText(a.reason)); return; }
    this.pending.set(a.id, { kind: 'build', cost: a.cost, label: labelOf(a.cmd), at: a.at });
  }

  /** Feed the sim's events; only those for commands this runtime sent are used. */
  /** Every accepted or rejected command event, including commands other panels sent (the budget panel's loans and taxes). */
  onCommandEvent(fn: (e: SimEvent) => void): () => void { this.eventListeners.add(fn); return () => { this.eventListeners.delete(fn); }; }

  handleEvents(events: readonly SimEvent[]): void {
    let changed = false;
    for (const e of events) {
      if (e.type === 'accepted' || e.type === 'rejected') for (const fn of this.eventListeners) fn(e);
      if (e.type !== 'accepted' && e.type !== 'rejected') continue;
      const p = this.pending.get(e.cmd);
      if (!p) continue;
      this.pending.delete(e.cmd);
      this.lastEvent = e;
      changed = true;
      if (e.type === 'rejected') {
        if (p.kind === 'undo') this.undo.rejected(p.target!, e.reason);
        this.toast(reasonText(e.reason));
      } else if (p.kind === 'build') {
        if (e.journal) this.undo.push({ id: e.journal, cost: p.cost, label: p.label });
        if (p.cost > 0) this.float(`-$${p.cost.toLocaleString('en-US')}`, p.at, false);
      } else {
        const gone = this.undo.undone(p.target!);
        if (gone && gone.cost > 0) this.float(`+$${gone.cost.toLocaleString('en-US')}`, p.at, true);
      }
    }
    if (changed) this.notify();
  }

  /** Undo the newest undoable action. Returns the command id, or 0 when there is nothing to undo. */
  undoLast(): number {
    const top = this.undo.top();
    if (!top) return 0;
    const id = this.deps.submit({ type: 'undo', target: top.id });
    this.undo.begin(top.id);
    this.pending.set(id, { kind: 'undo', cost: 0, label: `undo ${top.label}`, target: top.id, at: { ...this.controller.screen } });
    this.notify();
    return id;
  }

  get canUndo(): boolean { return this.undo.canUndo; }

  /** The sim state was replaced (snapshot loaded): journal ids and in-flight commands from before mean nothing now. */
  reset(): void {
    this.undo.clear();
    this.pending.clear();
    this.lastEvent = null;
    this.floats = [];
    this.toasts = [];
    this.controller.cancel();
    this.notify();
  }

  apply(a: KeyAction): void {
    switch (a.kind) {
      case 'select': this.controller.select(a.sel); break;
      case 'rotate': this.controller.rotate(); break;
      case 'undo': this.undoLast(); break;
      case 'escape': this.controller.escape(); break;
    }
  }

  dispose(): void {
    this.unsubscribeView?.();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.listeners.clear();
    this.eventListeners.clear();
  }

  /** `window.__iron.tools`: the same code paths the pointer and keyboard use, for the smoke test. */
  get debug(): ToolsDebug {
    const rt = this, w = this.deps.world;
    return {
      select: (tool, opts) => {
        const sel = selectionFrom(tool, opts);
        rt.controller.select(sel);
        return sel !== null;
      },
      dragTiles: (from, to) => rt.controller.dragTiles(from, to),
      undo: () => rt.undoLast(),
      cancel: () => rt.controller.cancel(),
      get lastEvent() { return rt.lastEvent; },
      get treasury() { return w.scalars[S.treasury]!; },
      get undoDepth() { return rt.undo.size; },
      get toasts() { return rt.toasts.map((t) => t.text); },
      get selected() { return rt.controller.sel; },
      peek: (layer, x, y) => w.layers[layer]![tileIdx(x, y)]!,
      buildings: () => {
        const L = w.layers, out: BuildingStatus[] = [];
        for (let s = 0; s < BMAX; s++) {
          const arch = L.bArch![s]!;
          if (arch === 0) continue;
          const flags = L.bFlags![s]!;
          out.push({
            slot: s, arch, x: L.bX![s]!, y: L.bY![s]!, constructing: (flags & BFLAG.CONSTRUCTING) !== 0,
            powered: (flags & BFLAG.UNPOWERED) === 0, watered: (flags & BFLAG.UNWATERED) === 0,
          });
        }
        return out;
      },
      findSite: (size = 14) => findFlatSite(tileReadOf(w.layers), size),
      findWater: () => findWaterTile(tileReadOf(w.layers)),
      tileFor: (name, topLeft) => {
        const sel = selectionFrom('service', { name });
        if (!sel || sel.tool !== 'service') return topLeft;
        const back = buildingAnchor(sel.arch, 0, { x: 0, y: 0 });
        return { x: topLeft.x - back.x, y: topLeft.y - back.y };
      },
    };
  }
}

export interface BuildingStatus { slot: number; arch: number; x: number; y: number; constructing: boolean; powered: boolean; watered: boolean }

export interface ToolsDebug {
  select(tool: string, opts?: Record<string, unknown>): boolean;
  /** Drag from one tile to another through the pointer's begin/move/end path; returns the command id (0 = nothing sent). */
  dragTiles(from: Tile, to: Tile): number;
  undo(): number;
  cancel(): void;
  readonly lastEvent: SimEvent | null;
  readonly treasury: number;
  readonly undoDepth: number;
  readonly toasts: string[];
  readonly selected: unknown;
  peek(layer: string, x: number, y: number): number;
  /** Every building in the mirror with the outage flags the utilities solve last set (a new building counts as served). */
  buildings(): BuildingStatus[];
  /** Top-left of a flat free land window near the map centre. */
  findSite(size?: number): Tile | null;
  findWater(): Tile | null;
  /** The cursor tile that puts a building (by catalog name) with its top-left at `topLeft`. */
  tileFor(name: string, topLeft: Tile): Tile;
}

declare module '../render/debug.ts' {
  interface IronDebug { tools?: ToolsDebug }
}
