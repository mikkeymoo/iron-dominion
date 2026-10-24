// Sky palette and light rig as a pure function of sun elevation and weather. The sky dome, the fog, the hemisphere light and
// the water's sky reflection all read the same numbers, so the horizon the fog fades into is the horizon the sky paints.
// Colours are linear RGB; the dome renders them as HDR values and the pipeline tone maps them.

export type RGB = [number, number, number];

export interface SkyLook {
  zenith: RGB;
  horizon: RGB;
  /** Warm band around the sun (mie-ish), added in the dome. */
  glow: RGB;
  sunColor: RGB;
  sunIntensity: number;
  moonColor: RGB;
  moonIntensity: number;
  hemiSky: RGB;
  hemiGround: RGB;
  hemiIntensity: number;
  fogColor: RGB;
  /** 0 by day, 1 in full night: drives lit windows, stars and streetlights. */
  night: number;
  starAlpha: number;
  exposure: number;
}

interface Key { e: number; zenith: RGB; horizon: RGB; glow: RGB; sun: RGB; sunI: number; hemiSky: RGB; hemiGround: RGB; hemiI: number }

// Keyed on sun elevation (sine of the angle above the horizon).
const KEYS: Key[] = [
  { e: -0.30, zenith: [0.004, 0.009, 0.034], horizon: [0.014, 0.024, 0.06], glow: [0, 0, 0], sun: [1, 0.5, 0.25], sunI: 0, hemiSky: [0.16, 0.22, 0.42], hemiGround: [0.05, 0.055, 0.07], hemiI: 0.72 },
  { e: -0.10, zenith: [0.012, 0.03, 0.10], horizon: [0.09, 0.07, 0.13], glow: [0.1, 0.04, 0.05], sun: [1, 0.42, 0.18], sunI: 0, hemiSky: [0.2, 0.22, 0.4], hemiGround: [0.07, 0.06, 0.07], hemiI: 0.62 },
  // Sunrise and sunset: a deeper violet zenith over a hotter, wider horizon band, so low-sun light reads orange and the shade side cool.
  { e: 0.00, zenith: [0.09, 0.11, 0.37], horizon: [1.22, 0.4, 0.16], glow: [1.75, 0.55, 0.14], sun: [1, 0.42, 0.16], sunI: 1.5, hemiSky: [0.5, 0.4, 0.6], hemiGround: [0.34, 0.2, 0.14], hemiI: 0.95 },
  { e: 0.05, zenith: [0.09, 0.17, 0.5], horizon: [1.1, 0.52, 0.3], glow: [1.4, 0.58, 0.24], sun: [1, 0.55, 0.26], sunI: 1.95, hemiSky: [0.54, 0.5, 0.72], hemiGround: [0.38, 0.27, 0.2], hemiI: 1.02 },
  { e: 0.10, zenith: [0.1, 0.22, 0.58], horizon: [0.95, 0.63, 0.44], glow: [1.05, 0.55, 0.28], sun: [1, 0.66, 0.38], sunI: 2.2, hemiSky: [0.52, 0.58, 0.8], hemiGround: [0.42, 0.34, 0.26], hemiI: 0.95 },
  { e: 0.30, zenith: [0.1, 0.27, 0.72], horizon: [0.72, 0.8, 0.9], glow: [0.7, 0.5, 0.3], sun: [1, 0.88, 0.7], sunI: 2.7, hemiSky: [0.6, 0.74, 0.98], hemiGround: [0.5, 0.42, 0.32], hemiI: 0.88 },
  { e: 0.70, zenith: [0.08, 0.24, 0.7], horizon: [0.62, 0.78, 0.95], glow: [0.5, 0.42, 0.3], sun: [1, 0.95, 0.85], sunI: 3.0, hemiSky: [0.62, 0.78, 1.0], hemiGround: [0.5, 0.44, 0.34], hemiI: 0.9 },
  { e: 1.00, zenith: [0.08, 0.24, 0.7], horizon: [0.62, 0.78, 0.95], glow: [0.5, 0.42, 0.3], sun: [1, 0.95, 0.85], sunI: 3.0, hemiSky: [0.62, 0.78, 1.0], hemiGround: [0.5, 0.44, 0.34], hemiI: 0.9 },
];

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerp3 = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smoothstep = (a: number, b: number, v: number): number => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

const OVERCAST_ZENITH: RGB = [0.22, 0.25, 0.3];
const OVERCAST_HORIZON: RGB = [0.42, 0.45, 0.5];
const luma = (c: RGB): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

function sampleKeys(e: number): { a: Key; b: Key; t: number } {
  const x = Math.max(KEYS[0]!.e, Math.min(KEYS[KEYS.length - 1]!.e, e));
  let i = 0;
  while (i < KEYS.length - 2 && x > KEYS[i + 1]!.e) i++;
  const a = KEYS[i]!, b = KEYS[i + 1]!;
  const t = (x - a.e) / (b.e - a.e);
  return { a, b, t: t * t * (3 - 2 * t) };
}

/** `overcast` 0..1 greys and darkens the sky and light; `flash` 0..1 is the lightning envelope. */
export function skyLook(sunElev: number, moonElev: number, overcast: number, flash = 0): SkyLook {
  const { a, b, t } = sampleKeys(sunElev);
  const oc = clamp01(overcast);
  const grey = (c: RGB, target: RGB, amount: number): RGB => {
    const l = luma(c);
    const toward = lerp3(c, [l, l, l], amount);
    return lerp3(toward, [target[0] * Math.max(l / luma(target), 0.02), target[1] * Math.max(l / luma(target), 0.02), target[2] * Math.max(l / luma(target), 0.02)], amount * 0.6);
  };
  let zenith = lerp3(a.zenith, b.zenith, t);
  let horizon = lerp3(a.horizon, b.horizon, t);
  const glow = lerp3(a.glow, b.glow, t).map((v) => v * (1 - oc * 0.85)) as RGB;
  zenith = grey(zenith, OVERCAST_ZENITH, oc * 0.9);
  horizon = grey(horizon, OVERCAST_HORIZON, oc * 0.9);
  const dayness = smoothstep(-0.12, 0.2, sunElev);
  const f = clamp01(flash);
  if (f > 0) {
    zenith = [zenith[0] + f * 0.5, zenith[1] + f * 0.55, zenith[2] + f * 0.8];
    horizon = [horizon[0] + f * 0.6, horizon[1] + f * 0.62, horizon[2] + f * 0.8];
  }
  const sunC = lerp3(a.sun, b.sun, t);
  const moonUp = smoothstep(0.02, 0.35, moonElev);
  const night = 1 - smoothstep(-0.08, 0.12, sunElev);
  const hemiSky = grey(lerp3(a.hemiSky, b.hemiSky, t), OVERCAST_HORIZON, oc * 0.7);
  const hemiGround = lerp3(a.hemiGround, b.hemiGround, t);
  const hemiI = lerp(a.hemiI, b.hemiI, t) * (1 - oc * 0.18) + f * 1.6;
  return {
    zenith, horizon, glow,
    sunColor: sunC,
    sunIntensity: lerp(a.sunI, b.sunI, t) * (1 - oc * 0.72),
    moonColor: [0.55, 0.66, 1.0],
    moonIntensity: 0.8 * moonUp * (1 - dayness) * (1 - oc * 0.5),
    hemiSky, hemiGround, hemiIntensity: hemiI,
    fogColor: horizon,
    night,
    starAlpha: night * (1 - oc),
    exposure: lerp(0.95, 1.35, night),
  };
}
