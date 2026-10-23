// Sun and moon placement from the sim clock, plus the renderer-side smoothing of that clock. Pure: no three, no DOM.
// dayFrac 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset (the same convention the HUD clock prints).

export type Vec3 = [number, number, number];

export const TAU = Math.PI * 2;
/** Tilt of the sun's orbit away from the vertical plane, so noon shadows fall toward -z at ~44 degrees elevation (long enough to read from the satellite view). */
export const SUN_TILT = 0.8;
/** The whole orbit is turned about the vertical so the noon sun sits south-west of the default camera and shadows fall to its right instead of straight away from it. */
export const SUN_AZIMUTH = 0.6;
/** Fastest the displayed clock may advance (dayFrac per second): 25 s for a full day, however fast the sim runs. */
export const MAX_DAY_RATE = 0.04;

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

export const wrap01 = (v: number): number => v - Math.floor(v);

/** Shortest signed distance from `from` to `to` on the day circle, in [-0.5, 0.5). */
export function wrapDelta(from: number, to: number): number {
  const d = wrap01(to - from + 0.5) - 0.5;
  return d;
}

/** Unit vector from the scene toward the sun. y is the sine of its elevation. */
export function sunDirection(dayFrac: number): Vec3 {
  const th = TAU * (dayFrac - 0.25);
  const x = Math.cos(th), z = Math.sin(th) * Math.sin(SUN_TILT);
  const c = Math.cos(SUN_AZIMUTH), s = Math.sin(SUN_AZIMUTH);
  return norm([x * c - z * s, Math.sin(th) * Math.cos(SUN_TILT), x * s + z * c]);
}

/** The moon sits opposite the sun with a small fixed offset so it never lines up with the shadows exactly. */
export function moonDirection(dayFrac: number): Vec3 {
  const s = sunDirection(dayFrac);
  return norm([-s[0] + 0.08, -s[1], -s[2] + 0.18]);
}

/** Angle between two unit vectors, radians. */
export function angleBetween(a: Vec3, b: Vec3): number {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return Math.acos(Math.min(1, Math.max(-1, d)));
}

/**
 * Displayed time of day. Chases the sim clock with a short ease and a hard cap on its rate, so 'max' sim speed sweeps
 * the sky quickly instead of strobing it. A pinned time (?time=) snaps once and then holds.
 */
export class DayClock {
  value: number;
  constructor(initial = 0.3, private readonly maxRate = MAX_DAY_RATE, private readonly ease = 4) {
    this.value = wrap01(initial);
  }

  snap(v: number): void { this.value = wrap01(v); }

  step(target: number, dt: number): number {
    if (!(dt > 0)) return this.value;
    const delta = wrapDelta(this.value, wrap01(target));
    const eased = delta * (1 - Math.exp(-dt * this.ease));
    const cap = this.maxRate * dt;
    this.value = wrap01(this.value + Math.max(-cap, Math.min(cap, eased)));
    return this.value;
  }
}
