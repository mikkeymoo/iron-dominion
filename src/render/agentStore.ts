import type { AgentsMsg } from '../sim/protocol.ts';
import { hatOfMeta, liveryOfMeta } from '../sim/robots/names.ts';

// Main-thread copy of the sim's moving agents (robots and vehicles). The worker sends the agents in view whenever the sim ticks;
// positions only change when it does, so the store keeps the last two tick snapshots and interpolates between them. Agents are
// matched by key (slot | generation << 16), so a slot reused by another agent is a new agent that snaps, never one that slides.

export const AGENT_KIND = { BUILDER: 1, HAULER: 2, CAR: 3, TAXI: 4, TRUCK: 5, BUS: 6, FIREFIGHTER: 7 } as const;
/** Mirrors AST in sim/robots/constants.ts and VST in sim/traffic/constants.ts (the renderer does not import sim internals beyond the protocol). */
export const AGENT_STATE = { IDLE: 0, TO_SITE: 1, WORK: 2, RETURN: 3, TO_PICKUP: 4, HAUL: 5, FF_GO: 6, FF_SPRAY: 7, REPAIR_GO: 8, REPAIR_WORK: 9, DRIVE: 10, SLOW: 11 } as const;
/** Vehicles are the kinds from this up to BUS; robots are builders, haulers and firefighters. */
export const FIRST_VEHICLE_KIND = AGENT_KIND.CAR;
export const isVehicleKind = (kind: number): boolean => kind >= AGENT_KIND.CAR && kind <= AGENT_KIND.BUS;
export type AgentGroup = 'robots' | 'vehicles';

interface Frame { tick: number; t: number; count: number; pos: Float32Array; ids: Uint32Array; index: Map<number, number> }

const emptyFrame = (): Frame => ({ tick: -1, t: 0, count: 0, pos: new Float32Array(0), ids: new Uint32Array(0), index: new Map() });

export interface AgentSample {
  count: number;
  /** x, z (tile units, z = sim y) and yaw per agent. */
  pos: Float32Array;
  key: Uint32Array;
  kind: Uint8Array;
  state: Uint8Array;
  carry: Uint8Array;
  /** Paint scheme of the home depot (0..5). */
  livery: Uint8Array;
  /** Hat of a named bot (1..3), 0 for a bot that has not earned a name. */
  hat: Uint8Array;
}

const MIN_TICK_MS = 16;
const MAX_TICK_MS = 1000;
/**
 * Two snapshots further apart than this many ticks are not blended (the newest wins): at max speed one message can span dozens of
 * ticks, and a straight line between two poses that far apart cuts across corners, so a vehicle would be drawn off its road.
 */
const MAX_BLEND_TICKS = 4;

const lerpAngle = (a: number, b: number, t: number): number => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2; else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};

const inGroup = (kind: number, group: AgentGroup | undefined): boolean =>
  group === undefined || isVehicleKind(kind) === (group === 'vehicles');

export class AgentStore {
  private prev: Frame = emptyFrame();
  private cur: Frame = emptyFrame();
  /** Smoothed milliseconds between sim ticks as observed on arrival. */
  private tickMs = 100;
  private lastTickAt = 0;
  private sel = new Int32Array(0);
  private dist = new Float32Array(0);
  private sorted = new Float32Array(0);
  /** Latest message tick, for the stats readout. */
  get tick(): number { return this.cur.tick; }
  get count(): number { return this.cur.count; }

  /** Copy a worker message in. The caller may return the transferred buffers straight away. */
  ingest(m: Pick<AgentsMsg, 'tick' | 'count' | 'pos' | 'ids'>, nowMs: number): void {
    const frame: Frame = {
      tick: m.tick, t: nowMs, count: m.count, pos: m.pos.slice(0, m.count * 3), ids: m.ids.slice(0, m.count * 2), index: new Map(),
    };
    for (let i = 0; i < m.count; i++) frame.index.set(frame.ids[i * 2]!, i);
    if (m.tick !== this.cur.tick) {
      if (this.lastTickAt > 0 && this.cur.tick >= 0 && m.tick > this.cur.tick) {
        const per = (nowMs - this.lastTickAt) / (m.tick - this.cur.tick);
        this.tickMs = Math.min(MAX_TICK_MS, Math.max(MIN_TICK_MS, this.tickMs * 0.8 + per * 0.2));
      }
      this.lastTickAt = nowMs;
      this.prev = this.cur;
      this.cur = frame;
    } else {
      // Same tick again (the view rect moved and added agents): keep the newer set.
      frame.t = this.cur.t;
      this.cur = frame;
    }
  }

  reset(): void {
    this.prev = emptyFrame(); this.cur = emptyFrame(); this.lastTickAt = 0;
  }

  /** True when the previous snapshot is close enough in sim time (1 to MAX_BLEND_TICKS ticks) to interpolate from. */
  private canBlend(): boolean {
    const gap = this.cur.tick - this.prev.tick;
    return this.prev.tick >= 0 && gap > 0 && gap <= MAX_BLEND_TICKS;
  }

  /**
   * Indices (into the latest frame) of the agents of `group` to draw, written to `this.sel`: all of them, or the `cap` nearest to
   * (fx, fz) when there are more, in frame order. Linear: a typed-array sort of the distances finds the cut, then ties at the
   * cut keep the earliest agents, so the choice is deterministic.
   */
  private select(group: AgentGroup | undefined, cap: number, fx: number, fz: number): number {
    const cur = this.cur, n = cur.count;
    if (this.sel.length < n) { this.sel = new Int32Array(n); this.dist = new Float32Array(n); this.sorted = new Float32Array(n); }
    const sel = this.sel, dist = this.dist;
    let m = 0;
    for (let i = 0; i < n; i++) if (inGroup(cur.ids[i * 2 + 1]! & 0xff, group)) sel[m++] = i;
    if (m <= cap) return m;
    for (let j = 0; j < m; j++) {
      const i = sel[j]!, dx = cur.pos[i * 3]! - fx, dz = cur.pos[i * 3 + 1]! - fz;
      dist[j] = dx * dx + dz * dz;
    }
    const sorted = this.sorted.subarray(0, m);
    sorted.set(dist.subarray(0, m));
    sorted.sort();
    const cut = cap > 0 ? sorted[cap - 1]! : -1;
    let less = 0;
    for (let j = 0; j < m; j++) if (dist[j]! < cut) less++;
    let ties = cap - less, k = 0;
    for (let j = 0; j < m; j++) {
      const d = dist[j]!;
      if (d < cut || (d === cut && ties > 0)) { if (d === cut) ties--; sel[k++] = sel[j]!; }
    }
    return k;
  }

  /**
   * Interpolated state of the agents of `group` (all agents when omitted) at `nowMs`, up to `cap` (the nearest to `(fx, fz)` when
   * there are more). Returns the filled sample.
   */
  sample(nowMs: number, out: AgentSample, cap: number, fx = 0, fz = 0, group?: AgentGroup): AgentSample {
    const cur = this.cur, prev = this.prev;
    const alpha = cur.tick < 0 ? 1 : Math.min(1, Math.max(0, (nowMs - cur.t) / this.tickMs));
    const m = this.select(group, cap, fx, fz);
    const sel = this.sel;
    const blend = this.canBlend();
    for (let j = 0; j < m; j++) {
      const i = sel[j]!;
      const key = cur.ids[i * 2]!, meta = cur.ids[i * 2 + 1]!;
      let x = cur.pos[i * 3]!, z = cur.pos[i * 3 + 1]!, yaw = cur.pos[i * 3 + 2]!;
      const p = blend ? prev.index.get(key) : undefined;
      if (p !== undefined && (prev.ids[p * 2 + 1]! & 0xff00) !== 0) {
        const px = prev.pos[p * 3]!, pz = prev.pos[p * 3 + 1]!;
        // A jump of more than a few tiles in one tick is a teleport (replan from a lot, respawn): snap.
        if (Math.abs(x - px) + Math.abs(z - pz) < 6) {
          x = px + (x - px) * alpha; z = pz + (z - pz) * alpha;
          yaw = lerpAngle(prev.pos[p * 3 + 2]!, yaw, alpha);
        }
      }
      out.pos[j * 3] = x; out.pos[j * 3 + 1] = z; out.pos[j * 3 + 2] = yaw;
      out.key[j] = key;
      out.kind[j] = meta & 0xff;
      out.state[j] = (meta >> 8) & 0xff;
      out.carry[j] = (meta >> 16) & 0xf;
      out.livery[j] = liveryOfMeta(meta);
      out.hat[j] = hatOfMeta(meta);
    }
    out.count = m;
    return out;
  }

  /** Keys of agents currently doing something, in slot order: the robots by default, one kind when `kind` is given. */
  activeKeys(kind?: number, includeIdle = false): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.cur.count; i++) {
      const meta = this.cur.ids[i * 2 + 1]!, k = meta & 0xff;
      if (!includeIdle && (meta & 0xff00) === 0) continue;
      if (kind === undefined ? !isVehicleKind(k) : k === kind) out.push(this.cur.ids[i * 2]!);
    }
    return out;
  }

  /** Distinct agent kinds in the latest message, ascending. Lets a camera offer "follow a vehicle" once traffic kinds exist. */
  kinds(): number[] {
    const seen = new Set<number>();
    for (let i = 0; i < this.cur.count; i++) seen.add(this.cur.ids[i * 2 + 1]! & 0xff);
    return [...seen].sort((a, b) => a - b);
  }

  /** Current interpolated pose of one agent, or null when it is gone. */
  poseOf(key: number, nowMs: number): { x: number; z: number; yaw: number } | null {
    const i = this.cur.index.get(key);
    if (i === undefined) return null;
    const cur = this.cur, prev = this.prev;
    const alpha = Math.min(1, Math.max(0, (nowMs - cur.t) / this.tickMs));
    let x = cur.pos[i * 3]!, z = cur.pos[i * 3 + 1]!, yaw = cur.pos[i * 3 + 2]!;
    const p = this.canBlend() ? prev.index.get(key) : undefined;
    if (p !== undefined && Math.abs(x - prev.pos[p * 3]!) + Math.abs(z - prev.pos[p * 3 + 1]!) < 6) {
      x = prev.pos[p * 3]! + (x - prev.pos[p * 3]!) * alpha;
      z = prev.pos[p * 3 + 1]! + (z - prev.pos[p * 3 + 1]!) * alpha;
      yaw = lerpAngle(prev.pos[p * 3 + 2]!, yaw, alpha);
    }
    return { x, z, yaw };
  }

  /** Counts of the robots in the latest message by kind. */
  counts(): { builders: number; haulers: number; fighters: number } {
    let builders = 0, haulers = 0, fighters = 0;
    for (let i = 0; i < this.cur.count; i++) {
      const k = this.cur.ids[i * 2 + 1]! & 0xff;
      if (k === AGENT_KIND.BUILDER) builders++; else if (k === AGENT_KIND.FIREFIGHTER) fighters++; else if (k === AGENT_KIND.HAULER) haulers++;
    }
    return { builders, haulers, fighters };
  }

  /** Vehicles in the latest message. */
  vehicleCount(): number {
    let n = 0;
    for (let i = 0; i < this.cur.count; i++) if (isVehicleKind(this.cur.ids[i * 2 + 1]! & 0xff)) n++;
    return n;
  }
}

export function makeSample(capacity: number): AgentSample {
  return {
    count: 0, pos: new Float32Array(capacity * 3), key: new Uint32Array(capacity), kind: new Uint8Array(capacity), state: new Uint8Array(capacity), carry: new Uint8Array(capacity),
    livery: new Uint8Array(capacity), hat: new Uint8Array(capacity),
  };
}
