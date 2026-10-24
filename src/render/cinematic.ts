import { clamp, type RigState } from './camera.ts';

// The completion camera move: swing in to an orbit around a finished megaproject, circle it, and hand the camera back where it was.
// Pure state and math (no three, no DOM), like camera.ts, so the timing and the hand-back are unit-tested.

export const CINEMATIC_SECONDS = 6;
/** Fractions of the move: the swing in ends at IN, the orbit ends at OUT, the rest is the swing back. */
const IN = 0.18, OUT = 0.82;

export interface CineTarget {
  /** Footprint centre in tile units. */
  x: number; z: number;
  /** Ground height there, and how tall the project stands (the camera looks at 40% of it, at most MAX_LOOK). */
  ground: number; height: number;
  /** Footprint edge in tiles. */
  size: number;
}

const MAX_LOOK = 10;
const smooth = (t: number): number => { const k = clamp(t, 0, 1); return k * k * (3 - 2 * k); };
const wrap = (a: number): number => { let d = a % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; else if (d < -Math.PI) d += Math.PI * 2; return d; };
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

/** The orbit pose at `t` in [0, 1] of the move, easing from `from` and back to it. */
export function cinematicPose(t: number, from: RigState, target: CineTarget): RigState {
  const look = target.ground + Math.min(MAX_LOOK, target.height * 0.4);
  const dist = Math.max(14, target.size * 2.6 + Math.min(target.height, 30) * 0.9);
  const pitch = 0.42;
  const yawStart = from.yaw;
  const orbit: RigState = { x: target.x, z: target.z, yaw: yawStart, pitch, dist, ty: look };
  if (t <= IN) return lerpRig(from, { ...orbit, yaw: yawStart }, smooth(t / IN));
  if (t >= OUT) {
    const end: RigState = { ...orbit, yaw: yawStart + Math.PI * 1.7 };
    return lerpRig(end, from, smooth((t - OUT) / (1 - OUT)));
  }
  const k = (t - IN) / (OUT - IN);
  return { ...orbit, yaw: yawStart + Math.PI * 1.7 * k, pitch: mix(pitch, pitch * 0.8, k), dist: dist * (1 - 0.12 * Math.sin(k * Math.PI)) };
}

function lerpRig(a: RigState, b: RigState, t: number): RigState {
  return {
    x: mix(a.x, b.x, t), z: mix(a.z, b.z, t), pitch: mix(a.pitch, b.pitch, t), dist: mix(a.dist, b.dist, t), ty: mix(a.ty, b.ty, t),
    yaw: a.yaw + wrap(b.yaw - a.yaw) * t,
  };
}

/** One running move. `step` writes the pose into the rig state each frame; `skip` ends it at once and puts the camera back. */
export class Cinematic {
  private from: RigState | null = null;
  private target: CineTarget | null = null;
  private t = 0;

  get active(): boolean { return this.from !== null; }
  get progress(): number { return this.t; }

  /** Begin a move from the rig's current state. Ignored while one is already running. */
  start(rig: RigState, target: CineTarget): boolean {
    if (this.from) return false;
    this.from = { ...rig };
    this.target = target;
    this.t = 0;
    return true;
  }

  /** Advance by `dt` seconds and write the pose into `rig`. Returns false once the move is over (the rig then holds its old state). */
  step(dt: number, rig: RigState): boolean {
    if (!this.from || !this.target) return false;
    this.t += dt / CINEMATIC_SECONDS;
    if (this.t >= 1) { this.finish(rig); return false; }
    Object.assign(rig, cinematicPose(this.t, this.from, this.target));
    return true;
  }

  /** Tap or Escape: give the camera back where it was. */
  skip(rig: RigState): void { if (this.from) this.finish(rig); }

  private finish(rig: RigState): void {
    Object.assign(rig, this.from);
    this.from = null;
    this.target = null;
    this.t = 0;
  }
}
