import { MAP } from '../sim/layers.ts';
import type { Ray } from './picking.ts';

// Orbit rig. Pure state and math (no three, no DOM) so clamps and gestures are unit-testable.
// World axes: x = tile x, z = tile y, y = height. yaw 0 puts the camera on +z of the target looking toward -z.

export const CAMERA = {
  minDist: 3,
  maxDist: 300,
  minPitch: 0.15,
  maxPitch: 1.45,
  fovDeg: 45,
  clearance: 0.8,
} as const;

export interface RigState { x: number; z: number; yaw: number; pitch: number; dist: number; ty: number }
export interface Pose { px: number; py: number; pz: number; tx: number; ty: number; tz: number }
export type GroundFn = (x: number, z: number) => number;

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Camera position and look-at point. The camera is lifted above terrain without moving the look-at point. */
export function poseOf(s: RigState, ground: GroundFn, clearance: number = CAMERA.clearance): Pose {
  const cp = Math.cos(s.pitch);
  const px = s.x + Math.sin(s.yaw) * cp * s.dist;
  const pz = s.z + Math.cos(s.yaw) * cp * s.dist;
  const py = Math.max(s.ty + Math.sin(s.pitch) * s.dist, ground(px, pz) + clearance);
  return { px, py, pz, tx: s.x, ty: s.ty, tz: s.z };
}

/** Ray through a normalised device coordinate (nx right, ny up, both -1..1). */
export function rayFromPose(p: Pose, fovDeg: number, aspect: number, nx: number, ny: number): Ray {
  let fx = p.tx - p.px, fy = p.ty - p.py, fz = p.tz - p.pz;
  const fl = Math.hypot(fx, fy, fz);
  fx /= fl; fy /= fl; fz /= fl;
  // right = normalize(cross(f, worldUp)) = (-fz, 0, fx)
  let rx = -fz, rz = fx;
  const rl = Math.hypot(rx, rz) || 1;
  rx /= rl; rz /= rl;
  // up = cross(right, f)
  const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
  const th = Math.tan((fovDeg * Math.PI) / 360);
  const a = nx * th * aspect, b = ny * th;
  return { ox: p.px, oy: p.py, oz: p.pz, dx: fx + rx * a + ux * b, dy: fy + uy * b, dz: fz + rz * a + uz * b };
}

export const pixelToNdc = (px: number, py: number, w: number, h: number): { nx: number; ny: number } => ({
  nx: (px / w) * 2 - 1,
  ny: 1 - (py / h) * 2,
});

/** Keep the ground point under the cursor fixed while the distance changes. */
export function zoomToward(
  target: { x: number; z: number }, anchor: { x: number; z: number }, oldDist: number, newDist: number,
): { x: number; z: number } {
  const k = 1 - newDist / oldDist;
  return { x: target.x + (anchor.x - target.x) * k, z: target.z + (anchor.z - target.z) * k };
}

const KEY_PAN_PER_DIST = 0.9;
const KEY_YAW_RATE = 1.6;
const DRAG_DAMP = 25;
const GLIDE_DAMP = 5;

/** Chase-camera framing behind a followed robot: street level, a few tiles back, looking slightly down. */
export const FOLLOW = { dist: 1.9, pitch: 0.22, lift: 0.2, clearance: 0.12, damp: 5, minDist: 1.2 } as const;

/** Where a followed thing is: tile coordinates (x, z) and the direction it faces (forward = (sin yaw, cos yaw)). */
export type FollowPose = { x: number; z: number; yaw: number };

const wrapAngle = (a: number): number => { let d = a % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; else if (d < -Math.PI) d += Math.PI * 2; return d; };

export class CameraRig {
  readonly state: RigState = { x: MAP / 2, z: MAP / 2, yaw: 0.6, pitch: 0.7, dist: 90, ty: 0 };
  private follow: (() => FollowPose | null) | null = null;
  private snapFollow = false;
  private scripted: ((dt: number) => RigState | null) | null = null;
  private vx = 0; private vz = 0; private vyaw = 0; private vpitch = 0;
  private held = 0;
  private readonly keys = new Set<string>();
  /** Bumped whenever the pose changes, so the view rect sender and debug hook can detect motion. */
  version = 0;

  constructor(private readonly ground: GroundFn) {}

  reset(x: number, z: number, yaw: number, pitch: number, dist: number): void {
    const s = this.state;
    s.x = clamp(x, 0, MAP); s.z = clamp(z, 0, MAP);
    s.yaw = yaw;
    s.pitch = clamp(pitch, CAMERA.minPitch, CAMERA.maxPitch);
    s.dist = clamp(dist, CAMERA.minDist, CAMERA.maxDist);
    s.ty = this.ground(s.x, s.z);
    this.vx = this.vz = this.vyaw = this.vpitch = 0;
    this.version++;
  }

  pose(): Pose { return poseOf(this.state, this.ground, this.follow ? FOLLOW.clearance : CAMERA.clearance); }

  /** Chase a moving target at street level until stopFollow(). `getPos` returning null (the target is gone) ends the follow. */
  followTarget(getPos: () => FollowPose | null): void {
    this.follow = getPos;
    this.snapFollow = true;
    this.vx = this.vz = this.vyaw = this.vpitch = 0;
  }

  stopFollow(): void { this.follow = null; }

  get following(): boolean { return this.follow !== null; }

  /**
   * Hand the camera to a script (a cinematic path) until it returns null or script(null) is called. The script supplies the whole
   * state each frame, including the target height, which the rig does not ease while scripted.
   */
  script(fn: ((dt: number) => RigState | null) | null): void {
    this.scripted = fn;
    if (fn) { this.follow = null; this.vx = this.vz = this.vyaw = this.vpitch = 0; }
  }

  get scripting(): boolean { return this.scripted !== null; }

  beginDrag(): void { this.held++; }
  endDrag(): void { this.held = Math.max(0, this.held - 1); }

  get velocity(): { x: number; z: number; yaw: number; pitch: number } {
    return { x: this.vx, z: this.vz, yaw: this.vyaw, pitch: this.vpitch };
  }

  /** Set the release velocity (world units/s, rad/s); called once per frame from the combined gesture. */
  impulse(vx: number, vz: number, vyaw: number, vpitch: number): void {
    this.vx = vx; this.vz = vz; this.vyaw = vyaw; this.vpitch = vpitch;
  }

  /** Move the target by a world delta. A positive `dt` (seconds) also sets the release velocity. */
  pan(dx: number, dz: number, dt: number): void {
    this.state.x += dx; this.state.z += dz;
    if (dt > 0) { this.vx = dx / dt; this.vz = dz / dt; }
    this.clampState();
  }

  rotate(dyaw: number, dpitch: number, dt: number): void {
    this.state.yaw += dyaw; this.state.pitch += dpitch;
    if (dt > 0) { this.vyaw = dyaw / dt; this.vpitch = dpitch / dt; }
    this.clampState();
  }

  /** Multiply the distance by `factor` (<1 zooms in), optionally keeping a ground point fixed on screen. */
  zoom(factor: number, anchor?: { x: number; z: number }): void {
    const s = this.state;
    const next = clamp(s.dist * factor, CAMERA.minDist, CAMERA.maxDist);
    if (anchor) {
      const t = zoomToward(s, anchor, s.dist, next);
      s.x = t.x; s.z = t.z;
    }
    s.dist = next;
    this.clampState();
  }

  setKey(code: string, down: boolean): void {
    if (down) this.keys.add(code); else this.keys.delete(code);
  }
  clearKeys(): void { this.keys.clear(); }

  /** Advance inertia, keyboard motion and the eased target height. */
  step(dt: number): void {
    const s = this.state;
    const before = `${s.x}|${s.z}|${s.yaw}|${s.pitch}|${s.dist}|${s.ty}`;
    if (this.scripted) {
      const p = this.scripted(dt);
      if (p) {
        s.x = p.x; s.z = p.z; s.yaw = p.yaw; s.pitch = p.pitch; s.dist = p.dist; s.ty = p.ty;
        this.clampState();
        if (`${s.x}|${s.z}|${s.yaw}|${s.pitch}|${s.dist}|${s.ty}` !== before) this.version++;
        return;
      }
      this.scripted = null;
    }
    if (this.follow) {
      const p = this.follow();
      if (!p) this.follow = null;
      else {
        const snap = this.snapFollow;
        const k = snap ? 1 : 1 - Math.exp(-dt * FOLLOW.damp);
        this.snapFollow = false;
        s.x += (p.x - s.x) * k; s.z += (p.z - s.z) * k;
        s.yaw += wrapAngle(p.yaw + Math.PI - s.yaw) * k * 0.6;
        s.pitch += (FOLLOW.pitch - s.pitch) * k; s.dist += (FOLLOW.dist - s.dist) * k;
        this.clampState();
        const g = this.ground(s.x, s.z) + FOLLOW.lift;
        s.ty += (g - s.ty) * (snap ? 1 : 1 - Math.exp(-dt * 10));
        if (`${s.x}|${s.z}|${s.yaw}|${s.pitch}|${s.dist}|${s.ty}` !== before) this.version++;
        return;
      }
    }
    const k = this.keys;
    const fwd = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    const side = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    const spin = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);
    if (fwd || side) {
      const speed = s.dist * KEY_PAN_PER_DIST * (k.has('ShiftLeft') || k.has('ShiftRight') ? 2.5 : 1);
      s.x += (-Math.sin(s.yaw) * fwd + Math.cos(s.yaw) * side) * speed * dt;
      s.z += (-Math.cos(s.yaw) * fwd - Math.sin(s.yaw) * side) * speed * dt;
    }
    if (spin) s.yaw -= spin * KEY_YAW_RATE * dt;

    const damp = Math.exp(-dt * (this.held > 0 ? DRAG_DAMP : GLIDE_DAMP));
    if (this.held === 0) {
      s.x += this.vx * dt; s.z += this.vz * dt;
      s.yaw += this.vyaw * dt; s.pitch += this.vpitch * dt;
    }
    this.vx *= damp; this.vz *= damp; this.vyaw *= damp; this.vpitch *= damp;
    if (Math.abs(this.vx) + Math.abs(this.vz) < 0.01) this.vx = this.vz = 0;
    if (Math.abs(this.vyaw) + Math.abs(this.vpitch) < 0.0005) this.vyaw = this.vpitch = 0;
    this.clampState();

    const g = this.ground(s.x, s.z);
    s.ty += (g - s.ty) * (1 - Math.exp(-dt * 8));
    if (Math.abs(g - s.ty) < 1e-3) s.ty = g;
    if (`${s.x}|${s.z}|${s.yaw}|${s.pitch}|${s.dist}|${s.ty}` !== before) this.version++;
  }

  private clampState(): void {
    const s = this.state;
    s.x = clamp(s.x, 0, MAP); s.z = clamp(s.z, 0, MAP);
    s.pitch = clamp(s.pitch, CAMERA.minPitch, CAMERA.maxPitch);
    s.dist = clamp(s.dist, this.follow ? FOLLOW.minDist : CAMERA.minDist, CAMERA.maxDist);
    if (s.yaw > Math.PI) s.yaw -= Math.PI * 2; else if (s.yaw < -Math.PI) s.yaw += Math.PI * 2;
  }
}
