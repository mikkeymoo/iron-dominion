import { ARCH, archetype } from '../sim/catalog.ts';
import { footprintOf } from '../sim/estimate.ts';
import { TILES } from '../sim/layers.ts';
import type { AgentInfo, BuildingInfo, InfoKind, InfoMsg, Issue, Stats } from '../sim/protocol.ts';
import { depotDoors, doorOfBuilding, reachLayer, type Footprint } from '../render/depotReach.ts';
import type { RenderMirror } from '../render/mirror.ts';
import type { TapTarget } from '../render/tap.ts';
import type { ViewState } from '../render/viewState.ts';
import type { ToolsRuntime } from './toolsStore.ts';

// Everything "why is this happening" that is not drawing: the advisor's issue list (from Stats), the building or robot the player
// tapped and what the sim says it is thinking (a RequestInfo round trip, refreshed while the card is open), and the depot work-radius
// tint that follows the depot tool and a selected depot. The components in this folder only read it.

export type Selection =
  | { kind: 'building'; ref: number; x: number; y: number }
  | { kind: 'agent'; ref: number; akind: number; x: number; y: number };

export interface WhyDeps {
  requestInfo(kind: InfoKind, ref: number): Promise<InfoMsg>;
  mirror: RenderMirror;
  view: ViewState;
  tools: ToolsRuntime;
}

const BUILDING_POLL_MS = 1000;
const AGENT_POLL_MS = 500;
const REACH_POLL_MS = 250;

const issueSig = (list: readonly Issue[]): string => list.map((i) => `${i.id}:${i.count}:${i.severity}:${i.x}:${i.y}:${i.text}`).join('|');

export class WhyStore {
  issues: Issue[] = [];
  selection: Selection | null = null;
  info: BuildingInfo | AgentInfo | null = null;
  /** The tapped robot has gone inside its depot (or the vehicle has arrived): the card shows its last words. */
  gone = false;
  /** The info request itself failed (the worker answered with an error or never answered): the card says it could not load. */
  failed = false;
  version = 0;
  private sig = '';
  private readonly listeners = new Set<() => void>();
  private poll: ReturnType<typeof setInterval> | undefined;
  private reachTimer: ReturnType<typeof setInterval> | undefined;
  private reachKey = '';
  private readonly reachLayerBuf = new Uint8Array(TILES);
  private unsubTools: (() => void) | undefined;

  constructor(private readonly deps: WhyDeps) {
    // A tool in hand means taps build instead of inspect: the card steps aside.
    this.unsubTools = deps.tools.controller.subscribe(() => { if (deps.tools.controller.active && this.selection) this.clear(); });
  }

  get mirror(): RenderMirror { return this.deps.mirror; }
  get view(): ViewState { return this.deps.view; }
  get tools(): ToolsRuntime { return this.deps.tools; }

  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private notify(): void { this.version++; for (const fn of this.listeners) fn(); }

  /** Feed each Stats message: the issue list changes the advisor only when it actually differs. */
  stats(s: Pick<Stats, 'issues'>): void {
    const sig = issueSig(s.issues);
    if (sig === this.sig) return;
    this.sig = sig;
    this.issues = s.issues;
    this.notify();
  }

  /** The player tapped the map: open the card for what is under the finger, or close it on empty ground. */
  tap(t: TapTarget): void {
    if (t.kind === 'none') { this.clear(); return; }
    this.selection = t.kind === 'building' ? { kind: 'building', ref: t.slot, x: t.x, y: t.y } : { kind: 'agent', ref: t.key, akind: t.akind, x: t.x, y: t.y };
    this.info = null;
    this.gone = false;
    this.failed = false;
    this.restartPoll();
    this.notify();
    void this.fetch();
  }

  clear(): void {
    if (!this.selection && !this.info) return;
    this.selection = null; this.info = null; this.gone = false; this.failed = false;
    this.stopPoll();
    this.notify();
  }

  private async fetch(): Promise<void> {
    const sel = this.selection;
    if (!sel) return;
    let m: InfoMsg;
    try { m = await this.deps.requestInfo(sel.kind, sel.ref); } catch {
      if (this.selection !== sel) return;
      this.failed = true;
      this.notify();
      return;
    }
    if (this.selection !== sel) return;
    this.failed = false;
    if (m.ok && m.info) { this.info = m.info; this.gone = false; } else if (sel.kind === 'building') { this.clear(); return; } else this.gone = true;
    this.notify();
  }

  private restartPoll(): void {
    this.stopPoll();
    const ms = this.selection?.kind === 'agent' ? AGENT_POLL_MS : BUILDING_POLL_MS;
    this.poll = setInterval(() => { if (!this.gone) void this.fetch(); }, ms);
  }

  private stopPoll(): void {
    if (this.poll !== undefined) clearInterval(this.poll);
    this.poll = undefined;
  }

  /**
   * Show the depot work radius while the depot tool is in hand (every depot plus the ghost's) or a depot is selected (that one).
   * Cheap when nothing changed: the tint is recomputed only when roads, buildings or the ghost footprint moved.
   */
  syncReach(): void {
    const { mirror, view, tools } = this.deps, c = tools.controller, sel = c.sel;
    const tool = sel?.tool === 'service' && sel.arch === ARCH.DEPOT;
    const slot = this.selection?.kind === 'building' ? this.selection.ref : -1;
    const picked = !tool && slot >= 0 && mirror.table.bArch[slot] === ARCH.DEPOT;
    view.setDepotReach(tool || picked);
    if (!tool && !picked) { this.reachKey = ''; return; }
    let ghost: Footprint | undefined;
    const plan = c.plan;
    // A ghost the player cannot afford yet still shows where the radius would reach.
    if (tool && plan && plan.cmd.type === 'placeBuilding' && (!plan.est.reason || plan.est.reason === 'funds')) {
      const a = archetype(plan.cmd.arch);
      if (a) { const f = footprintOf(a, plan.cmd.rot); ghost = { x: plan.cmd.x, y: plan.cmd.y, w: f.w, h: f.h }; }
    }
    const key = `${tool ? 'T' : `S${slot}`}|${mirror.roadVersion}|${mirror.buildingVersion}|${ghost ? `${ghost.x},${ghost.y},${ghost.w},${ghost.h}` : ''}`;
    if (key === this.reachKey) return;
    this.reachKey = key;
    const doors = picked ? [doorOfBuilding(mirror.layers, slot)].filter((t) => t >= 0) : depotDoors(mirror.layers, ghost);
    reachLayer(mirror.layers, doors, this.reachLayerBuf);
    mirror.setDepotReach(this.reachLayerBuf);
  }

  /** Start the reach tint's poll; returns the stop function (a React effect cleanup). */
  start(): () => void {
    this.syncReach();
    this.reachTimer = setInterval(() => this.syncReach(), REACH_POLL_MS);
    return () => { if (this.reachTimer !== undefined) clearInterval(this.reachTimer); this.reachTimer = undefined; this.deps.view.setDepotReach(false); };
  }

  /** Bulldoze the selected building through the same path the tool takes (cost, undo and toasts included). */
  bulldoze(): void {
    const info = this.info;
    if (!info || info.kind !== 'building') return;
    const c = this.deps.tools.controller;
    c.select({ tool: 'bulldoze' });
    c.dragTiles({ x: info.x, y: info.y }, { x: info.x + info.w - 1, y: info.y + info.h - 1 });
    c.cancel();
    this.clear();
  }

  dispose(): void {
    this.stopPoll();
    if (this.reachTimer !== undefined) clearInterval(this.reachTimer);
    this.unsubTools?.();
    this.listeners.clear();
  }
}
