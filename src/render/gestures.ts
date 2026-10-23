import { CAMERA } from './camera.ts';

// Pointer and touch math, free of DOM so it can be unit-tested.

export const ROTATE_PER_PX = 0.0055;
export const TILT_PER_PX = 0.0045;
const WHEEL_ZOOM = 0.0016;
const LINE_PX = 16;

/** World units per screen pixel on the ground at the look-at point (side: across the view, fwd: into the view). */
export function groundScale(dist: number, viewH: number, pitch: number, fovDeg: number = CAMERA.fovDeg): { side: number; fwd: number } {
  const side = (2 * dist * Math.tan((fovDeg * Math.PI) / 360)) / Math.max(1, viewH);
  return { side, fwd: side / Math.max(0.2, Math.sin(pitch)) };
}

/** Drag-to-pan: the ground follows the pointer, so the target moves opposite to the drag. */
export function panDelta(yaw: number, dxPx: number, dyPx: number, scale: { side: number; fwd: number }): { dx: number; dz: number } {
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const sx = -dxPx * scale.side, sf = dyPx * scale.fwd;
  return { dx: rx * sx + fx * sf, dz: rz * sx + fz * sf };
}

export function rotateDelta(dxPx: number, dyPx: number): { dyaw: number; dpitch: number } {
  return { dyaw: -dxPx * ROTATE_PER_PX, dpitch: dyPx * TILT_PER_PX };
}

/** Distance multiplier for a wheel event; deltaMode 1 = lines, 2 = pages. Positive deltaY zooms out. */
export function wheelFactor(deltaY: number, deltaMode: number): number {
  const px = deltaMode === 1 ? deltaY * LINE_PX : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(Math.max(-600, Math.min(600, px)) * WHEEL_ZOOM);
}

export interface Pt { x: number; y: number }
export interface TwoFingerDelta {
  /** Distance multiplier: fingers moving apart returns < 1 (zoom in). */
  zoomFactor: number;
  /** Camera yaw change from the twist (a clockwise twist turns the scene clockwise). */
  dyaw: number;
  /** Camera pitch change from the vertical midpoint drag. */
  dpitch: number;
  mid: Pt;
}

const wrap = (a: number): number => (a > Math.PI ? a - 2 * Math.PI : a < -Math.PI ? a + 2 * Math.PI : a);

export function twoFingerDelta(prev: readonly [Pt, Pt], cur: readonly [Pt, Pt]): TwoFingerDelta {
  const d0 = Math.hypot(prev[1].x - prev[0].x, prev[1].y - prev[0].y);
  const d1 = Math.hypot(cur[1].x - cur[0].x, cur[1].y - cur[0].y);
  const a0 = Math.atan2(prev[1].y - prev[0].y, prev[1].x - prev[0].x);
  const a1 = Math.atan2(cur[1].y - cur[0].y, cur[1].x - cur[0].x);
  const m0 = (prev[0].y + prev[1].y) / 2;
  const mid = { x: (cur[0].x + cur[1].x) / 2, y: (cur[0].y + cur[1].y) / 2 };
  return {
    zoomFactor: d0 > 1 && d1 > 1 ? d0 / d1 : 1,
    dyaw: -wrap(a1 - a0),
    dpitch: (mid.y - m0) * TILT_PER_PX,
    mid,
  };
}
