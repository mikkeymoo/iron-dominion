import type { CommandBody } from '../../sim/commands.ts';
import { estimate, tileReadOf, type Estimate } from '../../sim/estimate.ts';
import { MAP, S } from '../../sim/layers.ts';
import { commandFor, type Tile, type ToolSel } from './toolSpec.ts';

/** The slice of RenderMirror the tools read: the ghost estimate runs on these arrays exactly as the sim runs on its own. */
export interface ToolWorld {
  layers: Record<string, ArrayLike<number>>;
  scalars: ArrayLike<number>;
  tick: number;
}

export interface Plan {
  cmd: CommandBody;
  est: Estimate;
  /** Tile the pointer is on (hover or drag end). */
  tile: Tile;
}

export type ToolAction =
  | { kind: 'submitted'; id: number; cmd: CommandBody; cost: number; at: { x: number; y: number } }
  | { kind: 'refused'; reason: string; cmd: CommandBody };

export interface ToolControllerDeps {
  world: ToolWorld;
  /** Sends a command to the sim and returns its command id. */
  submit(body: CommandBody): number;
  /** True while the underground view is on: bulldoze then digs up pipes only. */
  underground?(): boolean;
}

/** Identity of everything the ghost and cost label show: the command, the estimate's cost, reason and tile lists. */
function planKey(p: Plan | null): string {
  if (!p) return '';
  const e = p.est;
  let h = 2166136261;
  for (const list of [e.validTiles, e.invalidTiles]) {
    for (const i of list) h = Math.imul(h ^ i, 16777619);
    h = Math.imul(h ^ 0x9e37, 16777619);
  }
  return `${JSON.stringify(p.cmd)}|${e.cost}|${e.reason ?? ''}|${e.validTiles.length}|${e.invalidTiles.length}|${h >>> 0}|${p.tile.x},${p.tile.y}`;
}

const inMap =(t: Tile): boolean => t.x >= 0 && t.y >= 0 && t.x < MAP && t.y < MAP;

/**
 * Tool state and the drag state machine. Pointer input arrives as tile coordinates (picked against the mirror), so the same
 * begin/move/end path serves a mouse, a finger and the smoke test's dragTiles(). The current plan is the estimate for the
 * command the drag would issue; releasing the pointer submits it unless the estimate already says the sim would refuse it.
 */
export class ToolController {
  sel: ToolSel | null = null;
  rot = 0;
  plan: Plan | null = null;
  /** Last pointer position in canvas pixels, for the cost label. */
  screen = { x: 0, y: 0 };
  /** Bumped whenever the selection, rotation, drag or plan changes. */
  version = 0;
  private drag: { from: Tile; to: Tile } | null = null;
  private hoverTile: Tile | null = null;
  private lastKey = '';
  private readonly listeners = new Set<() => void>();
  private readonly actionListeners = new Set<(a: ToolAction) => void>();

  constructor(private readonly deps: ToolControllerDeps) {}

  get dragging(): boolean { return this.drag !== null; }
  get active(): boolean { return this.sel !== null; }

  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  onAction(fn: (a: ToolAction) => void): () => void { this.actionListeners.add(fn); return () => { this.actionListeners.delete(fn); }; }

  private changed(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  /** Re-estimate; returns whether the plan the ghost shows actually differs from the previous one. */
  private recompute(): boolean {
    const before = planKey(this.plan);
    const t = this.drag ? this.drag.to : this.hoverTile;
    if (!this.sel || !t || !inMap(t)) this.plan = null;
    else {
      const cmd = commandFor(this.sel, this.drag ? this.drag.from : t, t, this.rot, this.deps.underground?.() ?? false);
      const w = this.deps.world;
      this.plan = { cmd, est: estimate(tileReadOf(w.layers, w.scalars), cmd, w.scalars[S.treasury]), tile: t };
    }
    this.lastKey = this.mirrorKey();
    return planKey(this.plan) !== before;
  }

  private mirrorKey(): string { return `${this.deps.world.tick}|${this.deps.world.scalars[S.treasury]}|${this.deps.world.scalars[S.tier]}`; }

  select(sel: ToolSel | null): void {
    this.sel = sel;
    this.drag = null;
    if (!sel) this.hoverTile = null;
    this.recompute();
    this.changed();
  }

  /** Re-plan after something outside the controller changed what the tool would do (the underground view toggled). */
  refresh(): void {
    if (!this.sel) return;
    this.recompute();
    this.changed();
  }

  rotate(): void {
    if (this.sel?.tool !== 'service') return;
    this.rot = (this.rot + 1) & 3;
    this.recompute();
    this.changed();
  }

  /** Escape: abandon a drag in progress, else clear the tool. */
  escape(): void {
    if (this.drag) this.abortDrag();
    else this.cancel();
  }

  /** Clear the tool and any drag. */
  cancel(): void {
    this.drag = null;
    this.hoverTile = null;
    this.sel = null;
    this.plan = null;
    this.changed();
  }

  abortDrag(): void {
    if (!this.drag) return;
    this.drag = null;
    this.recompute();
    this.changed();
  }

  setScreen(x: number, y: number): void { this.screen = { x, y }; }

  /** The pointer left (a finger lifted): there is no cursor to preview under any more. */
  clearHover(): void {
    if (this.drag || !this.hoverTile) return;
    this.hoverTile = null;
    this.recompute();
    this.changed();
  }

  begin(tile: Tile): boolean {
    if (!this.sel || !inMap(tile)) return false;
    this.drag = { from: tile, to: tile };
    this.hoverTile = tile;
    this.recompute();
    this.changed();
    return true;
  }

  move(tile: Tile): void {
    if (!this.sel || !inMap(tile)) return;
    const cur = this.drag ? this.drag.to : this.hoverTile;
    if (cur && cur.x === tile.x && cur.y === tile.y) return;
    if (this.drag) this.drag.to = tile;
    this.hoverTile = tile;
    this.recompute();
    this.changed();
  }

  /** Release: submit the planned command. Returns its command id, or 0 when nothing was sent. */
  end(): number {
    const d = this.drag;
    if (!d) return 0;
    const plan = this.plan;
    this.drag = null;
    let id = 0;
    if (plan) {
      if (plan.est.reason) this.emit({ kind: 'refused', reason: plan.est.reason, cmd: plan.cmd });
      else {
        id = this.deps.submit(plan.cmd);
        this.emit({ kind: 'submitted', id, cmd: plan.cmd, cost: plan.est.cost, at: { ...this.screen } });
      }
    }
    this.recompute();
    this.changed();
    return id;
  }

  /** Drag from one tile to another through the same path the pointer uses. */
  dragTiles(from: Tile, to: Tile): number {
    if (!this.begin(from)) return 0;
    this.move(to);
    return this.end();
  }

  /** Re-estimate when the mirror has moved on (a placement landed, treasury changed) so the ghost never shows stale validity. */
  sync(): void {
    if (this.plan && this.mirrorKey() !== this.lastKey && this.recompute()) this.changed();
  }

  private emit(a: ToolAction): void {
    for (const fn of this.actionListeners) fn(a);
  }
}
