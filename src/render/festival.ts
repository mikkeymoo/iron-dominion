import { MAP, ROAD } from '../sim/layers.ts';
import type { ParticleKind } from './fx/particles.ts';

// The festival show: a parade of robots along a road, fireworks over the shops and confetti. The sim only says "festival 1 began at (x, y)";
// everything here is drawn and timed on the main thread and never touches the sim. The path and the burst schedule are pure functions so
// they are unit-tested without a GPU.

export const FESTIVAL_IDS = { BLOCK_PARTY: 0, ROBOT_PARADE: 1, FIREWORKS: 2 } as const;

/** Real seconds a show runs at most, however long the sim festival is (the sim's `end` event stops it sooner). */
export const SHOW_SECONDS = 45;
export const PARADE_BOTS = 12;
export const PARADE_SPACING = 1.5;
export const PARADE_SPEED = 1.8;
const PATH_TILES = 28;
const BURST_GAP = 0.7;

const DIRS = [[0, -1, ROAD.N], [1, 0, ROAD.E], [0, 1, ROAD.S], [-1, 0, ROAD.W]] as const;

/** Nearest road tile to (x, y) within `reach`: the first ring (Chebyshev) holding a road, the closest by straight line within it; -1 when none. */
export function nearestRoadTile(road: ArrayLike<number>, x: number, y: number, reach = 12): number {
  for (let r = 0; r <= reach; r++) {
    let best = -1, bestD = Infinity;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const tx = x + dx, ty = y + dy;
      if (tx < 0 || ty < 0 || tx >= MAP || ty >= MAP || (road[ty * MAP + tx]! & ROAD.CLASS_MASK) === 0) continue;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = ty * MAP + tx; }
    }
    if (best >= 0) return best;
  }
  return -1;
}

/**
 * A route for the parade along the road network from the road nearest (x, y): it goes straight on whenever the road does, otherwise turns
 * to a tile it has not been to, and stops at a dead end or after `max` tiles. Returns tile centres as x, z pairs; empty when no road is near.
 */
export function paradePath(road: ArrayLike<number>, x: number, y: number, max = PATH_TILES): number[] {
  const start = nearestRoadTile(road, x, y);
  if (start < 0) return [];
  const seen = new Set<number>([start]);
  const out = [(start % MAP) + 0.5, Math.floor(start / MAP) + 0.5];
  let cur = start, heading = -1;
  // Begin along the longest straight run from the start tile.
  const runFrom = (tile: number, d: number): number => {
    let n = 0, t = tile;
    for (;;) {
      const r = road[t]!;
      if ((r & DIRS[d]![2]) === 0) return n;
      t += DIRS[d]![1] * MAP + DIRS[d]![0];
      if (t < 0 || t >= MAP * MAP || (road[t]! & ROAD.CLASS_MASK) === 0) return n;
      n++;
      if (n >= max) return n;
    }
  };
  let best = -1, bestRun = 0;
  for (let d = 0; d < 4; d++) { const run = runFrom(start, d); if (run > bestRun) { bestRun = run; best = d; } }
  if (best < 0) return out;
  heading = best;
  while (out.length / 2 < max) {
    const r = road[cur]!;
    let pick = -1;
    if ((r & DIRS[heading]![2]) !== 0) {
      const t = cur + DIRS[heading]![1] * MAP + DIRS[heading]![0];
      if (t >= 0 && t < MAP * MAP && !seen.has(t) && (road[t]! & ROAD.CLASS_MASK) !== 0) pick = heading;
    }
    if (pick < 0) {
      for (let d = 0; d < 4; d++) {
        if (d === (heading + 2) % 4 || (r & DIRS[d]![2]) === 0) continue;
        const t = cur + DIRS[d]![1] * MAP + DIRS[d]![0];
        if (t >= 0 && t < MAP * MAP && !seen.has(t) && (road[t]! & ROAD.CLASS_MASK) !== 0) { pick = d; break; }
      }
    }
    if (pick < 0) break;
    heading = pick;
    cur += DIRS[pick]![1] * MAP + DIRS[pick]![0];
    seen.add(cur);
    out.push((cur % MAP) + 0.5, Math.floor(cur / MAP) + 0.5);
  }
  return out;
}

/** Position and heading at arc length `s` along a path of x, z pairs, which the parade walks to its end and back. */
export function alongPath(path: readonly number[], s: number, out: { x: number; z: number; yaw: number }): void {
  const n = path.length / 2;
  if (n === 0) { out.x = 0; out.z = 0; out.yaw = 0; return; }
  if (n === 1) { out.x = path[0]!; out.z = path[1]!; out.yaw = 0; return; }
  const len = n - 1, loop = 2 * len;
  let u = ((s % loop) + loop) % loop;
  const back = u > len;
  if (back) u = loop - u;
  const i = Math.min(len - 1, Math.floor(u)), f = u - i;
  const ax = path[i * 2]!, az = path[i * 2 + 1]!, bx = path[i * 2 + 2]!, bz = path[i * 2 + 3]!;
  out.x = ax + (bx - ax) * f;
  out.z = az + (bz - az) * f;
  const dx = back ? ax - bx : bx - ax, dz = back ? az - bz : bz - az;
  out.yaw = Math.atan2(dx, dz);
}

/** Deterministic 0..1 from two ints, so the same show sparkles the same way. */
export function hash01(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
  return ((h >>> 0) % 100000) / 100000;
}

export interface Show { festival: number; x: number; y: number; ticks: number }

export interface ShowDeps {
  emit(kind: ParticleKind, x: number, y: number, z: number, count: number, size: number, energy: number): void;
  ground(x: number, z: number): number;
  /** The mirrored road layer, TILES values. */
  road(): ArrayLike<number>;
}

export interface ParadePose { x: number; z: number; yaw: number; hauler: boolean }

/** One running show. `step` emits confetti and fireworks; `parade` reports the marching robots for the robot renderer to draw. */
export class FestivalFx {
  private show: Show | null = null;
  private t = 0;
  private bursts = 0;
  private confetti = 0;
  private path: number[] = [];
  private readonly pose = { x: 0, z: 0, yaw: 0 };

  constructor(private readonly deps: ShowDeps) {}

  get active(): boolean { return this.show !== null; }
  get running(): Show | null { return this.show; }

  start(show: Show): void {
    this.show = show;
    this.t = 0; this.bursts = 0; this.confetti = 0;
    this.path = show.festival === FESTIVAL_IDS.ROBOT_PARADE ? paradePath(this.deps.road(), show.x, show.y) : [];
  }

  stop(): void { this.show = null; this.path = []; }

  /** Robots marching now, filled into `out` (x, z, yaw, kind); returns how many. */
  parade(out: ParadePose[]): number {
    const s = this.show;
    if (!s || s.festival !== FESTIVAL_IDS.ROBOT_PARADE || this.path.length < 4) return 0;
    const head = this.t * PARADE_SPEED;
    for (let i = 0; i < PARADE_BOTS; i++) {
      alongPath(this.path, head - i * PARADE_SPACING, this.pose);
      const o = (out[i] ??= { x: 0, z: 0, yaw: 0, hauler: false });
      o.x = this.pose.x; o.z = this.pose.z; o.yaw = this.pose.yaw; o.hauler = i % 3 === 2;
    }
    return PARADE_BOTS;
  }

  step(dt: number): void {
    const s = this.show;
    if (!s) return;
    this.t += Math.min(0.1, Math.max(0, dt));
    if (this.t > SHOW_SECONDS) { this.stop(); return; }
    const d = this.deps, cx = s.x + 0.5, cz = s.y + 0.5;
    if (s.festival === FESTIVAL_IDS.FIREWORKS) {
      // A shell goes up every BURST_GAP seconds at a spot round the shops: a gold spark ring and a little confetti falling from it.
      while (this.bursts * BURST_GAP <= this.t) {
        const k = this.bursts++, a = hash01(k, 1) * Math.PI * 2, r = 3 + hash01(k, 2) * 9;
        const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r, y = d.ground(x, z) + 7 + hash01(k, 3) * 6;
        d.emit('spark', x, y, z, 70, 2.6, 3.4);
        d.emit('confetti', x, y, z, 14, 1.4, 1.6);
      }
      return;
    }
    // Block party and parade: a steady rain of confetti over the shops, heavier along the parade.
    this.confetti += dt * (s.festival === FESTIVAL_IDS.ROBOT_PARADE ? 14 : 9);
    while (this.confetti >= 1) {
      this.confetti -= 1;
      const k = this.bursts++;
      if (s.festival === FESTIVAL_IDS.ROBOT_PARADE && this.path.length >= 4) {
        alongPath(this.path, this.t * PARADE_SPEED - hash01(k, 4) * PARADE_BOTS * PARADE_SPACING, this.pose);
        d.emit('confetti', this.pose.x, d.ground(this.pose.x, this.pose.z) + 1.2, this.pose.z, 3, 1.1, 1.4);
      } else {
        const a = hash01(k, 5) * Math.PI * 2, r = hash01(k, 6) * 8, x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
        d.emit('confetti', x, d.ground(x, z) + 3 + hash01(k, 7) * 3, z, 4, 1.2, 1.2);
      }
    }
  }
}
