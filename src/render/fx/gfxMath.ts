// Pure math behind the graphics push: wind sway, cloud-shadow projection, terrain surface weights and the height-fog
// integral. The TSL graphs evaluate the same formulas on the GPU; keeping them here lets tests pin the behaviour.

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smoothstep = (a: number, b: number, v: number): number => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// ---- wind ----

/** The weather map's smoothed wind speed (0.05 clear, 0.12 rain, 0.3 storm) as a sway amplitude in 0..1.1. */
export const swayAmplitude = (wind: number): number => Math.min(1.1, Math.max(0.12, 0.1 + wind * 3));
/** Radians per second of the sway oscillation: storms flutter faster. */
export const swayFrequency = (wind: number): number => 1.2 + Math.max(0, wind) * 5;
/** Unit wind heading on the xz plane. */
export const WIND_DIR: readonly [number, number] = [0.8, 0.6];

/** Horizontal tip displacement (tile units) of a blade or branch `height` above its base, `weight` 0..1 = how much it moves. */
export function swayOffset(wind: number, t: number, x: number, z: number, phase: number, height: number, weight: number): [number, number] {
  const a = swayAmplitude(wind), f = swayFrequency(wind);
  const gust = Math.sin(t * f * 0.55 + (x * WIND_DIR[0] + z * WIND_DIR[1]) * 0.21);
  const flutter = Math.sin(t * f + phase * 6.2831853);
  const d = (0.55 + 0.45 * gust) * a * 0.09 * height * weight + flutter * a * 0.018 * height * weight;
  return [WIND_DIR[0] * d, WIND_DIR[1] * d];
}

// ---- cloud shadows ----

/** Where the cloud layer must sit so its shadow lands on a ground point: that point displaced along the sun ray up to the layer. */
export function cloudShadowOffset(sun: readonly [number, number, number], altitude: number): [number, number] {
  const y = Math.max(0.2, sun[1]);
  return [(sun[0] / y) * altitude, (sun[2] / y) * altitude];
}

export const CLOUD_ALTITUDE = 120;
/** World units covered by one repeat of the cloud-shadow noise texture. */
export const CLOUD_TILE = 240;

/** Drift of the cloud field after `t` seconds at a wind speed: slower than the wind (clouds are heavy) and along its heading. */
export function cloudDrift(t: number, wind: number): [number, number] {
  const speed = 0.9 + wind * 14;
  return [WIND_DIR[0] * speed * t, WIND_DIR[1] * speed * t];
}

/** Texture coordinate (in repeats) of the cloud-shadow noise for a ground position. */
export function cloudShadowUv(x: number, z: number, sun: readonly [number, number, number], t: number, wind: number): [number, number] {
  const [ox, oz] = cloudShadowOffset(sun, CLOUD_ALTITUDE);
  const [dx, dz] = cloudDrift(t, wind);
  return [(x + ox - dx) / CLOUD_TILE, (z + oz - dz) / CLOUD_TILE];
}

/** Share of a point's sun light removed by cloud, from the noise sample n (0..1) and the sky's cover (0..1). */
export function cloudShadowDensity(n: number, cover: number): number {
  const edge = 1 - clamp01(cover);
  return smoothstep(edge - 0.04, edge + 0.22, n);
}

/** Strongest darkening a cloud shadow applies: fades with the sun (no sun, no shadow) and with overcast (the whole sky is the shadow). */
export function cloudShadowStrength(sunElevation: number, overcast: number): number {
  return 0.62 * smoothstep(0.02, 0.35, sunElevation) * (1 - clamp01(overcast));
}

// ---- terrain surface ----

/** Triplanar blend weights from a unit normal: sharper than |n|^1 so the planes meet in a narrow band. Sums to 1. */
export function triplanarWeights(nx: number, ny: number, nz: number, sharpness = 4): [number, number, number] {
  const wx = Math.pow(Math.abs(nx), sharpness), wy = Math.pow(Math.abs(ny), sharpness), wz = Math.pow(Math.abs(nz), sharpness);
  const s = wx + wy + wz || 1;
  return [wx / s, wy / s, wz / s];
}

/** Rock weight from the normal's up component: none on flat ground, full on cliffs. */
export const slopeRock = (ny: number): number => 1 - smoothstep(0.62, 0.86, ny);

export interface SurfaceWeights { grass: number; rock: number; sand: number; snow: number }

/** Mix of the four ground classes. `sandiness` and `grassiness` come from the terrain's vertex colour; snow from weather cover and altitude. */
export function surfaceWeights(ny: number, sandiness: number, snowCover: number, altitude: number): SurfaceWeights {
  const rock = slopeRock(ny);
  const flat = smoothstep(0.55, 0.85, ny);
  const sand = clamp01(sandiness) * (1 - rock);
  const snow = clamp01(snowCover * flat + smoothstep(9, 13, altitude) * 0.6 * flat) * (1 - rock * 0.7);
  const grass = Math.max(0, 1 - rock - sand);
  return { grass, rock, sand, snow };
}

/** Detail fade by camera distance: 1 up close, 0 far away; `near`/`far` in world units. */
export const detailFade = (dist: number, near: number, far: number): number => 1 - smoothstep(near, far, dist);

// ---- fog ----

/**
 * Optical depth of exponential height fog along a ray: extinction `density * exp(-falloff * y)`, camera at height `camY`, ray
 * of length `dist` with vertical direction `dy`. Closed form of the integral, with the flat-ray limit handled.
 */
export function heightFogDepth(density: number, falloff: number, camY: number, dy: number, dist: number): number {
  const k = falloff * dy;
  const base = density * Math.exp(-falloff * camY);
  if (Math.abs(k) < 1e-4) return base * dist;
  return (base * (1 - Math.exp(-k * dist))) / k;
}

/** Fog opacity from an optical depth. */
export const fogOpacity = (depth: number): number => 1 - Math.exp(-Math.max(0, depth));

/** Forward-scattering lobe toward the sun (Henyey-Greenstein shaped, normalised to 1 at the sun). */
export function mieLobe(cosSun: number, g = 0.72): number {
  const c = Math.max(-1, Math.min(1, cosSun));
  const hg = (1 - g * g) / Math.pow(1 + g * g - 2 * g * c, 1.5);
  const peak = (1 - g * g) / Math.pow(1 + g * g - 2 * g, 1.5);
  return hg / peak;
}
