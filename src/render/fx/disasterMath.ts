// Pure timing and shape math for the disaster effects, so it runs in Vitest without a renderer.

export interface Shake { x: number; z: number; t0: number; dur: number; amp: number; reach: number }

/** Strength 0..1 of one shake at `now` seen from (fx, fz): a squared fade over its duration, weaker the farther the camera is from the epicentre. */
export function shakeStrength(s: Shake, now: number, fx: number, fz: number): number {
  const u = (now - s.t0) / s.dur;
  if (u < 0 || u >= 1) return 0;
  const d = Math.hypot(fx - s.x, fz - s.z);
  const near = Math.min(1, Math.max(0.15, 1 - d / s.reach));
  return s.amp * (1 - u) * (1 - u) * near;
}

/**
 * Camera translation (tile units) for the strongest of the active shakes. `dist` is the camera's orbit distance, so a close view
 * is shaken as hard on screen as a far one. Zero when nothing shakes.
 */
export function shakeOffset(shakes: readonly Shake[], now: number, fx: number, fz: number, dist: number): [number, number, number] {
  let k = 0;
  for (const s of shakes) k = Math.max(k, shakeStrength(s, now, fx, fz));
  if (k <= 0) return [0, 0, 0];
  const a = k * Math.max(2, dist) * 0.012;
  return [
    (Math.sin(now * 47.3) + 0.5 * Math.sin(now * 91.7 + 1.3)) * a,
    (Math.sin(now * 61.1 + 0.7) + 0.5 * Math.sin(now * 113.9)) * a * 0.7,
    (Math.sin(now * 53.9 + 2.1) + 0.5 * Math.sin(now * 83.3 + 0.4)) * a,
  ];
}

/** Meteor flight: from (sx, sy, sz) high and off to one side to the impact point; `u` runs 0..1, speed picks up toward the ground. */
export function meteorAt(from: readonly [number, number, number], to: readonly [number, number, number], u: number): [number, number, number] {
  const e = u * u * (0.35 + 0.65 * u);
  return [from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e, from[2] + (to[2] - from[2]) * e];
}

/** Shockwave ring radius and opacity at progress u (0..1): fast out, slowing, fading squared. */
export function ringAt(u: number, maxRadius: number): { radius: number; opacity: number } {
  const k = Math.min(1, Math.max(0, u));
  return { radius: maxRadius * (1 - (1 - k) * (1 - k)), opacity: 0.85 * (1 - k) * (1 - k) };
}

/** Impact flash: a bright sphere that swells and fades; returns scale factor and opacity at progress u. */
export function flashAt(u: number): { scale: number; opacity: number } {
  const k = Math.min(1, Math.max(0, u));
  return { scale: 0.6 + 2.2 * k, opacity: (1 - k) * (1 - k) };
}
