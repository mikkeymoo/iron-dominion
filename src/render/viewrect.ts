import { MAP } from '../sim/layers.ts';
import { rayFromPose, type Pose } from './camera.ts';
import { pickPoint, type HeightMirror } from './picking.ts';

export interface ViewRect { x0: number; y0: number; x1: number; y1: number }

/**
 * Tile rectangle the camera can see, for the worker's agent culling. Each corner ray (plus the centre) is marched
 * against the terrain; a ray that finds none (it points at the sky) falls back to a ground point `maxDist` away along
 * that ray's own horizontal direction, so yaw is respected. The result is clamped to the map.
 */
export function computeViewRect(pose: Pose, fovDeg: number, aspect: number, mirror: HeightMirror, maxDist: number): ViewRect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const fwdLen = Math.hypot(pose.tx - pose.px, pose.tz - pose.pz) || 1;
  for (const [nx, ny] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0]] as const) {
    const ray = rayFromPose(pose, fovDeg, aspect, nx, ny);
    const hit = pickPoint(ray, mirror);
    let x: number, z: number;
    if (hit) { x = hit.x; z = hit.z; }
    else {
      let hx = ray.dx, hz = ray.dz;
      let hl = Math.hypot(hx, hz);
      if (hl < 1e-6) { hx = (pose.tx - pose.px) / fwdLen; hz = (pose.tz - pose.pz) / fwdLen; hl = 1; }
      x = pose.px + (hx / hl) * maxDist;
      z = pose.pz + (hz / hl) * maxDist;
    }
    x0 = Math.min(x0, x); y0 = Math.min(y0, z); x1 = Math.max(x1, x); y1 = Math.max(y1, z);
  }
  const c = (v: number): number => Math.min(MAP, Math.max(0, v));
  return { x0: Math.floor(c(x0)), y0: Math.floor(c(y0)), x1: Math.ceil(c(x1)), y1: Math.ceil(c(y1)) };
}
