// Generative music: a seeded scheduler that turns city size and time of day into pad chords, a bass note and soft arpeggios.
// Pure (no Web Audio): the same seed and the same sequence of generate() calls always yield the same notes.

export type MusicVoice = 'pad' | 'arp' | 'bass';
export interface Note { t: number; freq: number; dur: number; vel: number; voice: MusicVoice }
export interface MusicParams {
  /** 0..1 city size (see populationLevel). */
  size: number;
  /** 0..1, 1 = deep night. */
  night: number;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DORIAN = [0, 2, 3, 5, 7, 9, 10] as const;
const AEOLIAN = [0, 2, 3, 5, 7, 8, 10] as const;
/** Scale-degree roots of each four-bar progression (0 = tonic). */
const PROGRESSIONS: readonly (readonly number[])[] = [
  [0, 3, 0, 4],
  [0, 6, 3, 0],
  [0, 5, 3, 6],
  [0, 2, 3, 4],
];
const ROOT_MIDI = [50, 52, 45, 47] as const;
const midiHz = (m: number): number => 440 * 2 ** ((m - 69) / 12);

export const BEATS_PER_BAR = 4;
const STEPS_PER_BAR = 8;
const MAX_LAG_S = 2;

export const intensityOf = (p: MusicParams): number => Math.min(1, Math.max(0, 0.2 + 0.8 * p.size * (1 - 0.45 * p.night)));
export const bpmOf = (p: MusicParams): number => 50 + 30 * intensityOf(p);

export class MusicScheduler {
  private readonly rng: () => number;
  private readonly scale: readonly number[];
  private readonly root: number;
  private progression: readonly number[];
  private barStart: number;
  private bar = 0;

  constructor(seed: number, startTime = 0) {
    this.rng = mulberry32(seed);
    this.root = ROOT_MIDI[Math.floor(this.rng() * ROOT_MIDI.length)]!;
    this.scale = this.rng() < 0.5 ? DORIAN : AEOLIAN;
    this.progression = PROGRESSIONS[Math.floor(this.rng() * PROGRESSIONS.length)]!;
    this.barStart = startTime;
  }

  /** Semitone offset of scale degree `d` (any integer; octaves wrap). */
  private degree(d: number): number {
    const n = this.scale.length;
    const oct = Math.floor(d / n);
    return this.scale[((d % n) + n) % n]! + 12 * oct;
  }

  /** Notes that start before `now + horizon`, bar by bar. A scheduler that fell behind (suspended tab) skips ahead instead of bursting. */
  generate(now: number, horizon: number, p: MusicParams): Note[] {
    const out: Note[] = [];
    if (this.barStart < now - MAX_LAG_S) this.barStart = now;
    while (this.barStart < now + horizon) this.genBar(p, out);
    return out;
  }

  private genBar(p: MusicParams, out: Note[]): void {
    const rng = this.rng;
    if (this.bar > 0 && this.bar % 4 === 0) this.progression = PROGRESSIONS[Math.floor(rng() * PROGRESSIONS.length)]!;
    const chordRoot = this.progression[this.bar % 4]!;
    const intensity = intensityOf(p);
    const beat = 60 / bpmOf(p);
    const barLen = beat * BEATS_PER_BAR;
    const t0 = this.barStart;
    const base = this.root;
    const chord = [0, 2, 4].map((k) => base + this.degree(chordRoot + k));
    const padVel = 0.5 - 0.15 * p.night;
    for (const m of chord) out.push({ t: t0, freq: midiHz(m), dur: barLen * 1.15, vel: padVel, voice: 'pad' });
    const bassRoll = rng();
    if (intensity > 0.45 && bassRoll < 0.5 + 0.4 * intensity) {
      out.push({ t: t0, freq: midiHz(chord[0]! - 12), dur: beat * 2, vel: 0.5, voice: 'bass' });
    }
    const density = 0.3 + 0.5 * intensity - 0.2 * p.night;
    const step = barLen / STEPS_PER_BAR;
    let walk = 0;
    for (let s = 0; s < STEPS_PER_BAR; s++) {
      const roll = rng();
      const pick = Math.floor(rng() * 5);
      const lift = rng() < 0.25 ? 12 : 0;
      if (roll > density) continue;
      walk = (walk + pick) % 5;
      const m = base + 12 + this.degree(chordRoot + [0, 2, 4, 6, 7][walk]!) + lift;
      out.push({ t: t0 + s * step, freq: midiHz(m), dur: step * 1.6, vel: (0.3 + 0.25 * intensity) * (s % 2 === 0 ? 1 : 0.75), voice: 'arp' });
    }
    this.barStart += barLen;
    this.bar++;
  }
}
