import { ARCH, archetype, BFLAG } from '../sim/catalog.ts';
import { countBuildings } from './progress.ts';
import type { CommandBody } from '../sim/commands.ts';
import { tileReadOf } from '../sim/estimate.ts';
import { placeName } from '../sim/disasters/names.ts';
import { BMAX, S } from '../sim/layers.ts';
import type { ViewState } from '../render/viewState.ts';
import { tileIdx } from '../sim/tiles.ts';
import type { SimEvent } from '../sim/world.ts';
import { ToolController, type ToolAction, type ToolWorld } from '../render/tools/controller.ts';
import { findFlatSite, findWaterTile } from '../render/tools/sites.ts';
import { buildingAnchor, selectionFrom, type KeyAction, type Tile } from '../render/tools/toolSpec.ts';
import { FESTIVALS, GROUP_NAMES, VERY_LOW } from '../sim/council/tables.ts';
import { DIRECTIVES } from '../sim/directives.ts';
import { MEGA } from '../sim/megaprojects.ts';
import { copyOf } from './directiveCopy.ts';
import { TIERS } from '../sim/unlocks.ts';
import { money, projectLabel } from './projects.ts';
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
  locked: 'That is not unlocked yet. Grow the city to the next milestone.',
  approval: 'The people are not happy enough for a festival. Approval must be above 70.',
  busy: 'A festival is already on.',
  cooldown: 'That festival needs more time to rest.',
  night: 'Fireworks only work after dark.',
  'no-city': 'There is nothing to celebrate yet.',
  'no-request': 'That request is gone.',
  'no-road': 'A project needs a road along one edge so the robots can reach it.',
  exists: 'That project is already built or under construction.',
  requirements: 'The city does not meet that project\'s requirements yet. See the Projects panel.',
};

/** Plain-words text for a sim or estimate rejection reason. */
export const reasonText = (reason: string): string => REASONS[reason] ?? 'That could not be done.';

/**
 * `tone: 'hint'` is advice, not an error; `good` marks a celebration (milestone, project progress) so it is not styled like a refusal;
 * `jump` is the tile a "Jump to" button on the toast flies the camera to, and `alert` toasts (disasters) stay longer.
 */
export interface Toast { id: number; text: string; tone?: 'hint'; good?: boolean; jump?: { x: number; y: number }; alert?: boolean }

/** The nudge a player gets when drawing roads or zones before any Robot Depot exists. */
export const NO_DEPOT_HINT = 'Robots build your city. Place a Robot Depot first.';
const HINT_GAP_MS = 20000;
/** A large centred announcement (a megaproject finished, the game won); shown for BANNER_MS. */
export interface Banner { id: number; text: string; victory: boolean }
export interface FloatText { id: number; text: string; x: number; y: number; gain: boolean }

interface Pending {
  kind: 'build' | 'undo' | 'sandbox';
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
export const BANNER_MS = 6000;
const ALERT_MS = 12000;

export type SandboxDisaster = 'fire' | 'quake' | 'meteor';

/** The toast a disaster event earns, or null when it needs none (spread is silent, a meteor's impact follows its warning). */
export function disasterToast(e: Extract<SimEvent, { type: 'disaster' }>): { text: string; jump: { x: number; y: number } } | null {
  const jump = { x: e.x, y: e.y };
  if (e.kind === 'fire') return e.phase === 'start' ? { text: `Fire at ${placeName(e.arch)}!`, jump } : null;
  if (e.kind === 'quake') return { text: 'Earthquake!', jump };
  return e.phase === 'start' ? { text: 'Meteor incoming!', jump } : null;
}

const SANDBOX_REJECT: Record<string, string> = {
  noop: 'There is no building to set alight near the middle of the view.',
  blocked: 'A meteor is already on its way.',
};
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
  banner: Banner | null = null;
  floats: FloatText[] = [];
  lastEvent: SimEvent | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<() => void>();
  private readonly eventListeners = new Set<(e: SimEvent) => void>();
  private seq = 1;
  private lastHintAt = -Infinity;
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

  toast(text: string, kind?: 'hint' | 'good' | { jump: { x: number; y: number } }): void {
    const id = this.seq++;
    const toast: Toast = typeof kind === 'object' ? { id, text, jump: kind.jump, alert: true } : kind === 'hint' ? { id, text, tone: 'hint' } : kind === 'good' ? { id, text, good: true } : { id, text };
    this.toasts = [...this.toasts.slice(-2), toast];
    this.later(toast.alert ? ALERT_MS : TOAST_MS, () => { this.toasts = this.toasts.filter((t) => t.id !== id); });
    this.notify();
  }

  /** Sandbox: ask the sim for a fire, quake or meteor at a tile (the view's centre, from the HUD). Works with disasters set to Off. */
  triggerDisaster(kind: SandboxDisaster, x: number, y: number): number {
    const id = this.deps.submit({ type: 'triggerDisaster', kind, x, y });
    this.pending.set(id, { kind: 'sandbox', cost: 0, label: kind, at: { x, y } });
    return id;
  }

  showBanner(text: string, victory = false): void {
    const id = this.seq++;
    this.banner = { id, text, victory };
    this.later(BANNER_MS, () => { if (this.banner?.id === id) this.banner = null; });
    this.notify();
  }

  /** Milestones and megaproject progress become toasts; a finished project (and the win) also gets a banner. */
  private celebrate(e: SimEvent): void {
    switch (e.type) {
      case 'milestone': this.toast(`${TIERS[e.tier]!.name} reached! +${money(e.bonus)} bonus`, 'good'); break;
      case 'megaStage': this.toast(`${projectLabel(e.arch)}: ${MEGA[e.arch]!.stages[e.stage]!.name} done (${e.stage + 1}/${e.stages})`, 'good'); break;
      case 'megaComplete': this.showBanner(`${projectLabel(e.arch)} complete!`); break;
      case 'victory': this.showBanner('Victory! The Space Elevator reaches orbit.', true); break;
      case 'directiveReady': this.toast(`UNIT-0: ${copyOf(DIRECTIVES[e.index]?.id ?? '')?.done ?? 'Directive done.'} Claim your reward.`, 'good'); break;
      case 'directiveClaimed': this.toast(`UNIT-0 paid ${money(e.reward)}`, 'good'); break;
      case 'firstBuilding': this.toast('Your first building is finished! The bots are cheering.', 'good'); break;
      case 'council': this.councilToast(e); break;
      case 'festival': if (e.phase === 'start') this.toast(`${FESTIVALS[e.festival]?.name ?? 'Festival'} has begun!`, 'good'); break;
      case 'approvalWarning': this.toast(`The people are furious: approval has been under ${VERY_LOW} for ${e.months} months. Open the Council.`); break;
    }
  }

  private councilToast(e: Extract<SimEvent, { type: 'council' }>): void {
    const who = GROUP_NAMES[e.group] ?? 'Citizens';
    switch (e.phase) {
      case 'posted': this.toast(`${who} have a request. Open the Council.`, 'hint'); break;
      case 'completed': this.toast(`${who} are pleased: +${money(e.cash)}, +${e.approval} approval, +${e.rp} RP`, 'good'); break;
      case 'failed': this.toast(`${who} are angry: approval ${e.approval}`); break;
      case 'expired': this.toast(`${who} gave up waiting for an answer.`, 'hint'); break;
    }
  }

  private float(text: string, at: { x: number; y: number }, gain: boolean): void {
    const id = this.seq++;
    this.floats = [...this.floats.slice(-4), { id, text, x: at.x, y: at.y, gain }];
    this.later(FLOAT_MS, () => { this.floats = this.floats.filter((f) => f.id !== id); });
  }

  private onAction(a: ToolAction): void {
    if (a.kind === 'refused') { this.toast(reasonText(a.reason)); return; }
    this.pending.set(a.id, { kind: 'build', cost: a.cost, label: labelOf(a.cmd), at: a.at });
    const t = a.cmd.type;
    if ((t === 'placeRoad' || t === 'zone') && countBuildings(this.deps.world.layers, ARCH.DEPOT) === 0) {
      const now = Date.now();
      if (now - this.lastHintAt >= HINT_GAP_MS) { this.lastHintAt = now; this.toast(NO_DEPOT_HINT, 'hint'); }
    }
  }

  /** Feed the sim's events; only those for commands this runtime sent are used. */
  /** Every accepted or rejected command event, including commands other panels sent (the budget panel's loans and taxes). */
  onCommandEvent(fn: (e: SimEvent) => void): () => void { this.eventListeners.add(fn); return () => { this.eventListeners.delete(fn); }; }

  handleEvents(events: readonly SimEvent[]): void {
    let changed = false;
    for (const e of events) {
      if (e.type === 'disaster') {
        const t = disasterToast(e);
        if (t) this.toast(t.text, { jump: t.jump });
        continue;
      }
      if (e.type === 'accepted' || e.type === 'rejected') for (const fn of this.eventListeners) fn(e);
      if (e.type !== 'accepted' && e.type !== 'rejected') { this.celebrate(e); continue; }
      const p = this.pending.get(e.cmd);
      if (!p) continue;
      this.pending.delete(e.cmd);
      this.lastEvent = e;
      changed = true;
      if (e.type === 'rejected') {
        if (p.kind === 'undo') this.undo.rejected(p.target!, e.reason);
        this.toast(p.kind === 'sandbox' ? (SANDBOX_REJECT[e.reason] ?? reasonText(e.reason)) : reasonText(e.reason));
      } else if (p.kind === 'sandbox') {
        continue;
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

  /** Population tier the city has reached, as the mirror last heard it. */
  get tier(): number { return this.deps.world.scalars[S.tier] ?? 0; }

  /** The sim state was replaced (snapshot loaded): journal ids and in-flight commands from before mean nothing now. */
  reset(): void {
    this.undo.clear();
    this.pending.clear();
    this.lastEvent = null;
    this.floats = [];
    this.toasts = [];
    this.banner = null;
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
      disaster: (kind, x, y) => rt.triggerDisaster(kind, x, y),
      findSite: (size = 14) => findFlatSite(tileReadOf(w.layers), size, undefined, 6),
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
  /** The sandbox trigger the HUD menu uses: a fire, quake or meteor at a tile. Returns the command id. */
  disaster(kind: SandboxDisaster, x: number, y: number): number;
}

declare module '../render/debug.ts' {
  interface IronDebug { tools?: ToolsDebug }
}
