// Cinematic camera paths for the orbit rig. Pure (no three, no DOM) so the path math is unit-testable.
// A path maps seconds to a RigState (target x/z/ty, yaw, pitch, dist). The photo-mode tour uses it, and megaproject
// completion cams can reuse orbit(), flyTo(), dolly(), spline() and sequence() the same way:
//   const player = new CinematicPlayer(); player.play(sequence([flyTo(here, there, 3), orbit(there, 40, 8)]));
//   rig.script((dt) => player.step(dt));

import type { RigState } from './camera.ts';

export type EasingName = 'linear' | 'in' | 'out' | 'inOut' | 'inOutQuint';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export const EASINGS: Record<EasingName, (t: number) => number> = {
  linear: (t) => t,
  in: (t) => t * t * t,
  out: (t) => 1 - (1 - t) ** 3,
  inOut: (t) => t * t * (3 - 2 * t),
  inOutQuint: (t) => (t < 0.5 ? 16 * t ** 5 : 1 - (-2 * t + 2) ** 5 / 2),
};

/** Eased progress for a clamped t in 0..1; 0 maps to 0 and 1 maps to 1 exactly. */
export function ease(name: EasingName, t: number): number {
  const c = clamp01(Number.isFinite(t) ? t : 0);
  if (c === 0 || c === 1) return c;
  return EASINGS[name](c);
}

export interface Path {
  /** Seconds. */
  readonly duration: number;
  /** Camera state at `t` seconds, clamped to 0..duration. Writes into `out` when given. */
  at(t: number, out?: RigState): RigState;
}

export interface Target { x: number; z: number; ty: number }

const TAU = Math.PI * 2;
const wrap = (a: number): number => { let d = a % TAU; if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU; return d; };
const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;
const lerpLog = (a: number, b: number, k: number): number => Math.exp(lerp(Math.log(Math.max(1e-6, a)), Math.log(Math.max(1e-6, b)), k));

const blank = (): RigState => ({ x: 0, z: 0, yaw: 0, pitch: 0, dist: 1, ty: 0 });
const put = (out: RigState | undefined, x: number, z: number, yaw: number, pitch: number, dist: number, ty: number): RigState => {
  const o = out ?? blank();
  o.x = x; o.z = z; o.yaw = yaw; o.pitch = pitch; o.dist = dist; o.ty = ty;
  return o;
};
const clampT = (t: number, d: number): number => (t < 0 || !Number.isFinite(t) ? 0 : t > d ? d : t);
const progress = (t: number, d: number): number => (d > 0 ? clampT(t, d) / d : 1);

/** Circle the target at a fixed camera distance (`radius` is the rig distance, camera to target). `turns` is signed: negative circles the other way. */
export function orbit(
  target: Target, radius: number, duration: number,
  opt: { pitch?: number; startYaw?: number; turns?: number; easing?: EasingName } = {},
): Path {
  const pitch = opt.pitch ?? 0.5, yaw0 = opt.startYaw ?? 0, turns = opt.turns ?? 1, easing = opt.easing ?? 'linear';
  const d = Math.max(0, duration);
  return {
    duration: d,
    at: (t, out) => put(out, target.x, target.z, yaw0 + TAU * turns * ease(easing, progress(t, d)), pitch, radius, target.ty),
  };
}

/** Straight move between two states: yaw takes the short way round, dist changes geometrically, `lift` pulls the camera back mid-flight. */
export function flyTo(from: RigState, to: RigState, duration: number, opt: { easing?: EasingName; lift?: number } = {}): Path {
  const easing = opt.easing ?? 'inOut';
  const d = Math.max(0, duration);
  const a = { ...from }, b = { ...to };
  const dyaw = wrap(b.yaw - a.yaw);
  const travel = Math.hypot(b.x - a.x, b.z - a.z);
  const lift = Math.max(0, opt.lift ?? 0.3) * travel;
  return {
    duration: d,
    at(t, out) {
      const k = ease(easing, progress(t, d));
      if (k === 0) return put(out, a.x, a.z, a.yaw, a.pitch, a.dist, a.ty);
      if (k === 1) return put(out, b.x, b.z, b.yaw, b.pitch, b.dist, b.ty);
      const arc = Math.sin(Math.PI * k) * lift;
      return put(out, lerp(a.x, b.x, k), lerp(a.z, b.z, k), a.yaw + dyaw * k, lerp(a.pitch, b.pitch, k), lerpLog(a.dist, b.dist, k) + arc, lerp(a.ty, b.ty, k));
    },
  };
}

/** Push in or pull out along the view axis. */
export function dolly(from: RigState, toDist: number, duration: number, opt: { easing?: EasingName } = {}): Path {
  return flyTo(from, { ...from, dist: toDist }, duration, { easing: opt.easing, lift: 0 });
}

/**
 * Smooth path through every key (Catmull-Rom on target, pitch and log distance; yaw unwrapped so it never spins the long way).
 * The whole path takes `duration` seconds, eased as one.
 */
export function spline(keys: readonly RigState[], duration: number, opt: { easing?: EasingName } = {}): Path {
  if (keys.length === 0) throw new Error('spline needs at least one key');
  const easing = opt.easing ?? 'inOut';
  const d = Math.max(0, duration);
  const yaws: number[] = [keys[0]!.yaw];
  for (let i = 1; i < keys.length; i++) yaws.push(yaws[i - 1]! + wrap(keys[i]!.yaw - yaws[i - 1]!));
  const logs = keys.map((k) => Math.log(Math.max(1e-6, k.dist)));
  const n = keys.length;
  const cr = (p0: number, p1: number, p2: number, p3: number, u: number): number => {
    const u2 = u * u, u3 = u2 * u;
    return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
  };
  const pick = (f: (i: number) => number, i: number, u: number): number => {
    const at = (j: number): number => f(Math.min(n - 1, Math.max(0, j)));
    return cr(at(i - 1), at(i), at(i + 1), at(i + 2), u);
  };
  return {
    duration: d,
    at(t, out) {
      if (n === 1) { const k = keys[0]!; return put(out, k.x, k.z, k.yaw, k.pitch, k.dist, k.ty); }
      const s = ease(easing, progress(t, d)) * (n - 1);
      if (s <= 0) { const k = keys[0]!; return put(out, k.x, k.z, k.yaw, k.pitch, k.dist, k.ty); }
      if (s >= n - 1) { const k = keys[n - 1]!; return put(out, k.x, k.z, yaws[n - 1]!, k.pitch, k.dist, k.ty); }
      const i = Math.min(n - 2, Math.floor(s)), u = s - i;
      return put(
        out, pick((j) => keys[j]!.x, i, u), pick((j) => keys[j]!.z, i, u), pick((j) => yaws[j]!, i, u),
        pick((j) => keys[j]!.pitch, i, u), Math.exp(pick((j) => logs[j]!, i, u)), pick((j) => keys[j]!.ty, i, u),
      );
    },
  };
}

/** Play paths one after another. Each should start where the one before it ends; the tour planner guarantees that. */
export function sequence(paths: readonly Path[]): Path {
  if (paths.length === 0) throw new Error('sequence needs at least one path');
  const total = paths.reduce((s, p) => s + p.duration, 0);
  return {
    duration: total,
    at(t, out) {
      let left = clampT(t, total);
      for (let i = 0; i < paths.length; i++) {
        const p = paths[i]!;
        if (left <= p.duration || i === paths.length - 1) return p.at(left, out);
        left -= p.duration;
      }
      return paths[paths.length - 1]!.at(paths[paths.length - 1]!.duration, out);
    },
  };
}

export const pathEnd = (p: Path): RigState => p.at(p.duration);

export interface TourCandidate { x: number; z: number; ty: number; score: number }

/** Highest-scoring candidates, skipping any within `minSep` tiles of one already chosen, so the tour visits distinct places. */
export function pickTourStops(cands: readonly TourCandidate[], count: number, minSep = 24): TourCandidate[] {
  const sorted = [...cands].sort((a, b) => b.score - a.score || a.x - b.x || a.z - b.z);
  const out: TourCandidate[] = [];
  for (const c of sorted) {
    if (out.length >= count) break;
    if (out.every((o) => Math.hypot(o.x - c.x, o.z - c.z) >= minSep)) out.push(c);
  }
  return out;
}

/** A tour stop: the point to circle, and optionally its own orbit distance (tall buildings need more room). */
export interface TourStop extends Target { radius?: number }

export interface TourOptions { orbitSeconds?: number; flySeconds?: number; radius?: number; pitch?: number; turns?: number }

/**
 * A short tour: fly to each stop, circle it part of the way, then fly back to where the camera started. With no stops it
 * is a slow orbit of the start target, so a new empty city still gets a shot.
 */
export function planTour(start: RigState, stops: readonly TourStop[], opt: TourOptions = {}): Path {
  const orbitS = opt.orbitSeconds ?? 5, flyS = opt.flySeconds ?? 3.5, radius = opt.radius ?? 36, pitch = opt.pitch ?? 0.42, turns = opt.turns ?? 0.4;
  if (stops.length === 0) {
    return sequence([orbit({ x: start.x, z: start.z, ty: start.ty }, start.dist, orbitS * 2, { pitch: start.pitch, startYaw: start.yaw, turns: 1, easing: 'inOut' })]);
  }
  const legs: Path[] = [];
  let at: RigState = { ...start };
  stops.forEach((s, i) => {
    const yaw0 = start.yaw + i * 1.1;
    const circle = orbit(s, s.radius ?? radius, orbitS, { pitch, startYaw: yaw0, turns, easing: 'inOut' });
    legs.push(flyTo(at, circle.at(0), flyS, { lift: 0.25 }), circle);
    at = pathEnd(circle);
  });
  legs.push(flyTo(at, start, flyS, { lift: 0.25 }));
  return sequence(legs);
}

/**
 * Drives one path at a time. `step(dt)` returns the pose to apply, including on the final frame, then null.
 * `skip()` ends playback where the camera is (a tap or Escape), so the player keeps the view they interrupted.
 */
export class CinematicPlayer {
  private path: Path | null = null;
  private t = 0;
  private done: ((completed: boolean) => void) | null = null;
  private readonly pose: RigState = blank();

  get active(): boolean { return this.path !== null; }
  get elapsed(): number { return this.t; }

  play(path: Path, onEnd?: (completed: boolean) => void): void {
    this.finish(false);
    this.path = path;
    this.t = 0;
    this.done = onEnd ?? null;
  }

  skip(): void { this.finish(false); }

  step(dt: number): RigState | null {
    const p = this.path;
    if (!p) return null;
    this.t += Math.max(0, dt);
    const last = this.t >= p.duration;
    p.at(this.t, this.pose);
    if (last) this.finish(true);
    return this.pose;
  }

  private finish(completed: boolean): void {
    const cb = this.done;
    this.path = null;
    this.done = null;
    cb?.(completed);
  }
}

export const MEGA_CINEMATIC_SECONDS = 6;

export interface MegaTarget {
  /** Footprint centre in tile units. */
  x: number; z: number;
  /** Ground height there, and how tall the project stands (the camera looks at 40% of it, at most MEGA_MAX_LOOK). */
  ground: number; height: number;
  /** Footprint edge in tiles. */
  size: number;
}

const MEGA_MAX_LOOK = 10;

/** The megaproject completion move: swing in to an orbit around the finished project, circle it, and return to `from`. */
export function megaOrbit(from: RigState, target: MegaTarget): Path {
  const ty = target.ground + Math.min(MEGA_MAX_LOOK, target.height * 0.4);
  const dist = Math.max(14, target.size * 2.6 + Math.min(target.height, 30) * 0.9);
  const pitch = 0.42, turns = 0.85;
  const centre: Target = { x: target.x, z: target.z, ty };
  const swing = MEGA_CINEMATIC_SECONDS * 0.18, lap = MEGA_CINEMATIC_SECONDS - swing * 2;
  const lapPath = orbit(centre, dist, lap, { pitch, startYaw: from.yaw, turns });
  return sequence([
    flyTo(from, lapPath.at(0), swing, { lift: 0 }),
    lapPath,
    flyTo(pathEnd(lapPath), from, swing, { lift: 0 }),
  ]);
}
