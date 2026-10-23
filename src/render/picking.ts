import { MAP } from '../sim/layers.ts';
import { surfaceHeight, type HeightLayer } from './heightfield.ts';

export interface Ray { ox: number; oy: number; oz: number; dx: number; dy: number; dz: number }
/** Anything with the mirror's height layer; RenderMirror satisfies it. */
export interface HeightMirror { layers: Record<string, HeightLayer> }
export interface GroundHit { x: number; y: number; z: number }

const STEP = 0.25;
const BISECT = 12;
/** Terrain never rises above this (tile units); the march starts where the ray drops below it. */
const MAX_HEIGHT = 80;

/** March a ray against the mirror height grid. No GPU readback. Returns the first surface hit, or null. */
export function pickPoint(ray: Ray, mirror: HeightMirror, maxLen = 3000): GroundHit | null {
  const len = Math.hypot(ray.dx, ray.dy, ray.dz);
  if (!(len > 0)) return null;
  const dx = ray.dx / len, dy = ray.dy / len, dz = ray.dz / len;
  let t0 = 0, t1 = maxLen;
  const slab = (o: number, d: number): boolean => {
    if (Math.abs(d) < 1e-9) return o >= 0 && o <= MAP;
    const a = (0 - o) / d, b = (MAP - o) / d;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
    return true;
  };
  if (!slab(ray.ox, dx) || !slab(ray.oz, dz)) return null;
  if (ray.oy > MAX_HEIGHT) {
    if (dy >= 0) return null;
    t0 = Math.max(t0, (MAX_HEIGHT - ray.oy) / dy);
  }
  if (t0 > t1) return null;

  const h = mirror.layers.height!;
  const at = (t: number): number => ray.oy + dy * t - surfaceHeight(h, ray.ox + dx * t, ray.oz + dz * t);
  let prev = t0;
  if (at(t0) <= 0) return hit(ray, dx, dy, dz, t0);
  for (let t = t0 + STEP; ; t += STEP) {
    const cur = Math.min(t, t1);
    if (at(cur) <= 0) {
      let lo = prev, hi = cur;
      for (let i = 0; i < BISECT; i++) {
        const mid = (lo + hi) / 2;
        if (at(mid) <= 0) hi = mid; else lo = mid;
      }
      return hit(ray, dx, dy, dz, hi);
    }
    if (cur >= t1) return null;
    prev = cur;
  }
}

function hit(r: Ray, dx: number, dy: number, dz: number, t: number): GroundHit {
  return { x: r.ox + dx * t, y: r.oy + dy * t, z: r.oz + dz * t };
}

export const tileOfPoint = (p: { x: number; z: number }): { x: number; y: number } => ({
  x: Math.min(MAP - 1, Math.max(0, Math.floor(p.x))),
  y: Math.min(MAP - 1, Math.max(0, Math.floor(p.z))),
});

/** Screen ray -> tile by marching the ray against the mirror height grid. */
export function pickTile(ray: Ray, mirror: HeightMirror): { x: number; y: number } | null {
  const p = pickPoint(ray, mirror);
  return p ? tileOfPoint(p) : null;
}
