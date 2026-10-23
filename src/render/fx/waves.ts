// Gerstner wave set for the water surface. Pure data: water.ts unrolls these constants into the vertex and fragment nodes.

export interface GerstnerWave {
  /** Unit travel direction on the xz plane. */
  dx: number;
  dz: number;
  /** Wavenumber 2 pi / wavelength (1 / tiles). */
  k: number;
  /** Vertical amplitude (tiles). */
  amp: number;
  /** Angular speed (rad / s). */
  omega: number;
  /** Horizontal steepness Q in [0, 1]; the sum of Q k A over all waves stays below MAX_STEEPNESS so crests never loop. */
  steep: number;
}

export const MAX_STEEPNESS = 0.8;
export const MAX_AMPLITUDE = 0.12;
/** Effective gravity in tile units: tuned for a lazy harbour swell, not for physical units. */
const G = 2.2;

const BASE: { wavelength: number; angle: number; amp: number }[] = [
  { wavelength: 17, angle: 0.35, amp: 0.085 },
  { wavelength: 9.5, angle: 1.05, amp: 0.045 },
  { wavelength: 5.4, angle: -0.6, amp: 0.026 },
  { wavelength: 3.3, angle: 2.3, amp: 0.014 },
];

export function gerstnerWaves(count: number): GerstnerWave[] {
  const n = Math.max(0, Math.min(BASE.length, Math.floor(count)));
  const waves = BASE.slice(0, n).map((w) => {
    const k = (Math.PI * 2) / w.wavelength;
    return { dx: Math.cos(w.angle), dz: Math.sin(w.angle), k, amp: Math.min(MAX_AMPLITUDE, w.amp), omega: Math.sqrt(G * k), steep: 1 };
  });
  const sum = waves.reduce((a, w) => a + w.k * w.amp, 0);
  const q = sum > 0 ? Math.min(1, MAX_STEEPNESS / sum) : 0;
  return waves.map((w) => ({ ...w, steep: q }));
}

/** Surface height and gradient at (x, z, t), the same math the shader unrolls. Used by tests. */
export function sampleWaves(waves: GerstnerWave[], x: number, z: number, t: number): { h: number; gx: number; gz: number } {
  let h = 0, gx = 0, gz = 0;
  for (const w of waves) {
    const th = w.k * (w.dx * x + w.dz * z) - w.omega * t;
    h += w.amp * Math.sin(th);
    const c = w.amp * w.k * Math.cos(th);
    gx += w.dx * c;
    gz += w.dz * c;
  }
  return { h, gx, gz };
}
