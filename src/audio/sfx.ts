// UI sound effects, each a few oscillators or a noise burst. A builder returns its length in seconds.
import type { AudioEngine } from './engine.ts';
import { noiseHit, tone } from './synth.ts';
import type { NoiseKind } from './synth.ts';

export const SFX_NAMES = ['toolSelect', 'place', 'invalid', 'bulldoze', 'money', 'milestone', 'toast'] as const;
export type SfxName = (typeof SFX_NAMES)[number];

type Builder = (c: AudioContext, out: AudioNode, t: number, noise: (k: NoiseKind) => AudioBuffer) => number;

/** A minor-pentatonic run in D: the milestone fanfare. */
export const FANFARE_HZ = [293.66, 349.23, 440, 587.33, 698.46, 880] as const;

const BUILDERS: Record<SfxName, Builder> = {
  toolSelect: (c, out, t) => {
    tone(c, out, { type: 'triangle', freq: 1500, freqEnd: 1100, t, dur: 0.05, gain: 0.35, attack: 0.002 });
    tone(c, out, { type: 'sine', freq: 3000, t, dur: 0.025, gain: 0.12, attack: 0.001 });
    return 0.06;
  },
  place: (c, out, t, noise) => {
    tone(c, out, { type: 'sine', freq: 150, freqEnd: 55, t, dur: 0.16, gain: 0.8, attack: 0.002 });
    noiseHit(c, out, noise('brown'), { t, dur: 0.07, gain: 0.5, filter: { type: 'lowpass', freq: 900, freqEnd: 250 } });
    return 0.2;
  },
  invalid: (c, out, t) => {
    tone(c, out, { type: 'sawtooth', freq: 110, freqEnd: 90, t, dur: 0.17, gain: 0.22, attack: 0.01, filter: { type: 'lowpass', freq: 500 } });
    tone(c, out, { type: 'square', freq: 116, freqEnd: 94, t, dur: 0.17, gain: 0.08, attack: 0.01, filter: { type: 'lowpass', freq: 400 } });
    return 0.2;
  },
  bulldoze: (c, out, t, noise) => {
    noiseHit(c, out, noise('white'), { t, dur: 0.28, gain: 0.55, filter: { type: 'bandpass', freq: 1800, freqEnd: 300, q: 0.9 }, offset: 0.3 });
    noiseHit(c, out, noise('brown'), { t, dur: 0.34, gain: 0.9, filter: { type: 'lowpass', freq: 600, freqEnd: 120 }, offset: 0.7 });
    tone(c, out, { type: 'sine', freq: 90, freqEnd: 40, t, dur: 0.3, gain: 0.6, attack: 0.004 });
    return 0.4;
  },
  money: (c, out, t) => {
    tone(c, out, { type: 'sine', freq: 1318.5, t, dur: 0.5, gain: 0.3, attack: 0.002 });
    tone(c, out, { type: 'sine', freq: 2637, t, dur: 0.3, gain: 0.1, attack: 0.002 });
    tone(c, out, { type: 'sine', freq: 1760, t: t + 0.09, dur: 0.7, gain: 0.3, attack: 0.002 });
    tone(c, out, { type: 'sine', freq: 3520, t: t + 0.09, dur: 0.4, gain: 0.1, attack: 0.002 });
    return 0.8;
  },
  milestone: (c, out, t) => {
    FANFARE_HZ.forEach((f, i) => {
      const at = t + i * 0.11;
      tone(c, out, { type: 'triangle', freq: f, t: at, dur: i === FANFARE_HZ.length - 1 ? 1.4 : 0.5, gain: 0.3, attack: 0.01 });
      tone(c, out, { type: 'sine', freq: f * 2, t: at, dur: 0.4, gain: 0.08, attack: 0.01 });
    });
    const end = t + FANFARE_HZ.length * 0.11;
    for (const f of [146.83, 220, 293.66]) tone(c, out, { type: 'sine', freq: f, t: end - 0.1, dur: 1.5, gain: 0.18, attack: 0.05 });
    return 2;
  },
  toast: (c, out, t) => {
    tone(c, out, { type: 'sine', freq: 880, t, dur: 0.09, gain: 0.25, attack: 0.003 });
    tone(c, out, { type: 'sine', freq: 1175, t: t + 0.07, dur: 0.12, gain: 0.22, attack: 0.003 });
    return 0.2;
  },
};

export class Sfx {
  constructor(private readonly engine: AudioEngine) {}

  /** Returns whether the sound started (false while muted-out, not unlocked, throttled or over the voice cap). */
  play(name: SfxName): boolean {
    return this.engine.shot(name, 'sfx', BUILDERS[name], { minGapMs: name === 'toolSelect' ? 25 : 60 });
  }
}
