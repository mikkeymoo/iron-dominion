import type { Pose } from './camera.ts';

// Tap handling for the map, free of DOM and three so it can be unit-tested: telling a tap from a drag, projecting world points to
// canvas pixels, and choosing what the tap landed on (a robot or vehicle first, else a building).

export type TapTarget =
  | { kind: 'building'; slot: number; x: number; y: number }
  | { kind: 'agent'; key: number; akind: number; x: number; y: number }
  | { kind: 'none' };

/** A press that moves less than this (CSS px) and lifts within TAP_MS is a tap, not the start of a pan. */
export const TAP_SLOP_PX = 9;
export const TAP_MS = 450;
/** How close (CSS px) a tap must land to a robot, or to the line from a building's base to its roof, to pick it. */
export const AGENT_PICK_PX = 26;
export const BUILDING_PICK_PX = 22;

export interface TapOwner {
  /** Something is listening for taps. */
  handler: boolean;
  /** A build tool owns the press. */
  toolActive: boolean;
  primary: boolean;
  /** Pointer type and button of the press. */
  mouse: boolean;
  button: number;
  /** The radial menu is open: this press only dismisses it. */
  radialOpen: boolean;
}

/** Whether a press may become a map tap. A press that dismisses the radial menu never also opens an info card. */
export const tapEligible = (o: TapOwner): boolean => o.handler && !o.toolActive && !o.radialOpen && o.primary && (!o.mouse || o.button === 0);

/** Pointer-event state machine: feed it down, move, up and cancel; `up` returns the tap position when the gesture was one. */
export class TapDetector {
  private start: { id: number; x: number; y: number; t: number } | null = null;
  private down2 = false;

  /** `ok` is false when something else owns the press (a tool is active, photo mode, a button other than the primary one). */
  down(id: number, x: number, y: number, t: number, ok: boolean): void {
    if (this.start || this.down2) { this.down2 = true; return; }
    if (ok) this.start = { id, x, y, t };
    else this.down2 = true;
  }

  move(id: number, x: number, y: number): void {
    const s = this.start;
    if (s && s.id === id && Math.hypot(x - s.x, y - s.y) > TAP_SLOP_PX) { this.start = null; this.down2 = true; }
  }

  /** Lift of pointer `id`; returns the tap, or null. The detector is ready for the next press once every pointer is up (`lastUp`). */
  up(id: number, x: number, y: number, t: number, lastUp: boolean): { x: number; y: number } | null {
    const s = this.start;
    let tap: { x: number; y: number } | null = null;
    if (s && s.id === id && !this.down2 && t - s.t <= TAP_MS && Math.hypot(x - s.x, y - s.y) <= TAP_SLOP_PX) tap = { x, y };
    if (s && s.id === id) this.start = null;
    if (lastUp) { this.start = null; this.down2 = false; }
    return tap;
  }

  cancel(): void { this.start = null; this.down2 = false; }
}

export interface Projected { px: number; py: number; depth: number }

/** Canvas pixel of a world point (x right, y up, z toward the viewer at yaw 0) seen from `pose`, or null behind the camera. Mirrors rayFromPose. */
export function projectToPixel(pose: Pose, fovDeg: number, w: number, h: number, x: number, y: number, z: number): Projected | null {
  let fx = pose.tx - pose.px, fy = pose.ty - pose.py, fz = pose.tz - pose.pz;
  const fl = Math.hypot(fx, fy, fz) || 1;
  fx /= fl; fy /= fl; fz /= fl;
  let rx = -fz, rz = fx;
  const rl = Math.hypot(rx, rz) || 1;
  rx /= rl; rz /= rl;
  const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
  const dx = x - pose.px, dy = y - pose.py, dz = z - pose.pz;
  const depth = dx * fx + dy * fy + dz * fz;
  if (depth <= 0.05) return null;
  const th = Math.tan((fovDeg * Math.PI) / 360), aspect = w / Math.max(1, h);
  const nx = (dx * rx + dz * rz) / (depth * th * aspect), ny = (dx * ux + dy * uy + dz * uz) / (depth * th);
  return { px: ((nx + 1) / 2) * w, py: ((1 - ny) / 2) * h, depth };
}

export interface PickPoint { id: number; x: number; y: number; z: number }

/** The point whose projection is nearest the tap within `radius` px (nearer to the camera wins a tie within a pixel), or null. */
export function nearestPoint(points: Iterable<PickPoint>, project: (x: number, y: number, z: number) => Projected | null, px: number, py: number, radius: number): number | null {
  let best: number | null = null, bestD = Infinity, bestDepth = Infinity;
  for (const p of points) {
    const q = project(p.x, p.y, p.z);
    if (!q) continue;
    const d = Math.hypot(q.px - px, q.py - py);
    if (d > radius) continue;
    if (best === null || d < bestD - 1 || (Math.abs(d - bestD) <= 1 && q.depth < bestDepth)) { best = p.id; bestD = d; bestDepth = q.depth; }
  }
  return best;
}

export interface PickSegment { id: number; ax: number; ay: number; az: number; bx: number; by: number; bz: number }

const toSegment = (px: number, py: number, ax: number, ay: number, bx: number, by: number): number => {
  const vx = bx - ax, vy = by - ay, len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2));
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
};

/** The segment (a building's base to its roof) nearest the tap within `radius` px; the nearer one to the camera wins near-ties. */
export function nearestSegment(segs: Iterable<PickSegment>, project: (x: number, y: number, z: number) => Projected | null, px: number, py: number, radius: number): number | null {
  let best: number | null = null, bestD = Infinity, bestDepth = Infinity;
  for (const s of segs) {
    const a = project(s.ax, s.ay, s.az), b = project(s.bx, s.by, s.bz);
    if (!a || !b) continue;
    const d = toSegment(px, py, a.px, a.py, b.px, b.py);
    if (d > radius) continue;
    const depth = Math.min(a.depth, b.depth);
    if (best === null || d < bestD - 2 || (Math.abs(d - bestD) <= 2 && depth < bestDepth)) { best = s.id; bestD = d; bestDepth = depth; }
  }
  return best;
}
