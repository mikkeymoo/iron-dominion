// Ambience: continuous loops plus randomly timed events, all scaled by the weights from mix.ts.
import type { AudioEngine } from './engine.ts';
import { AMBIENCE_LAYERS, ambienceWeights, thunderDelay, thunderLevel, thunderTone, type AmbienceInput, type AmbienceLayer, type AmbienceWeights } from './mix.ts';
import { mulberry32 } from './music.ts';
import { noiseHit, noiseLoop, oscLoop, tone, type Loop } from './synth.ts';

/** Events per second at full weight for the layers that make discrete sounds. */
const EVENT_RATE: Partial<Record<AmbienceLayer, number>> = { birds: 0.45, servo: 0.9, construction: 1.1, traffic: 0.12 };
/** How fast a layer's weight follows its target, per second. */
const FOLLOW = 1.2;
const OFF_BELOW = 0.015;

export class Ambience {
  private loops: Partial<Record<AmbienceLayer, Loop>> = {};
  private outs: Partial<Record<AmbienceLayer, GainNode>> = {};
  private built: AudioContext | null = null;
  private readonly level: Record<AmbienceLayer, number>;
  private readonly rng: () => number;
  private lastWeights: AmbienceWeights;
  private lastStrike = -Infinity;

  constructor(private readonly engine: AudioEngine, seed = 1) {
    this.rng = mulberry32(seed);
    this.level = Object.fromEntries(AMBIENCE_LAYERS.map((l) => [l, 0])) as Record<AmbienceLayer, number>;
    this.lastWeights = { ...this.level };
  }

  /** Smoothed layer weights, as heard. */
  get weights(): Readonly<AmbienceWeights> { return this.level; }

  private build(c: AudioContext): void {
    const bus = this.engine.buses!.ambience;
    const noise = (k: 'white' | 'pink' | 'brown') => this.engine.noise(k)!;
    const make = (layer: AmbienceLayer, loop: Loop | null): void => {
      if (loop) { this.loops[layer] = loop; this.outs[layer] = loop.gain; }
      else { const g = c.createGain(); g.gain.value = 0; g.connect(bus); this.outs[layer] = g; }
      this.engine.registerLoop(layer, 'ambience', () => this.level[layer]);
    };
    make('wind', noiseLoop(c, bus, noise('brown'), { type: 'bandpass', freq: 380, q: 0.7 }, { rate: 0.07, depth: 220 }));
    make('cityHum', oscLoop(c, bus, { type: 'sawtooth', freqs: [55, 55.45, 82.6], filter: { type: 'lowpass', freq: 170 }, am: { rate: 0.2, depth: 0.15 } }));
    make('traffic', noiseLoop(c, bus, noise('brown'), { type: 'bandpass', freq: 240, q: 0.5 }, { rate: 0.11, depth: 90 }));
    make('rain', noiseLoop(c, bus, noise('white'), { type: 'highpass', freq: 1100, q: 0.4 }));
    make('drone', oscLoop(c, bus, { type: 'sawtooth', freqs: [96, 97.3], filter: { type: 'bandpass', freq: 210, q: 2.5 }, am: { rate: 41, depth: 0.45 } }));
    make('crickets', oscLoop(c, bus, { type: 'sine', freqs: [4300, 4390], filter: { type: 'bandpass', freq: 4300, q: 6 }, am: { rate: 29, depth: 0.5 } }));
    make('birds', null);
    make('servo', null);
    make('construction', noiseLoop(c, bus, noise('white'), { type: 'highpass', freq: 5200, q: 0.7 }, { rate: 13, depth: 900 }));
    this.built = c;
  }

  /** Advance one control step: ease the layer gains toward the weights for `input` and fire the discrete sounds that fall due. */
  update(input: AmbienceInput, dt: number): void {
    const c = this.engine.context;
    if (!c || !this.engine.buses || !this.engine.live) return;
    if (this.built !== c) this.build(c);
    const target = ambienceWeights(input);
    this.lastWeights = target;
    const k = 1 - Math.exp(-FOLLOW * dt);
    for (const layer of AMBIENCE_LAYERS) {
      this.level[layer] += (target[layer] - this.level[layer]) * k;
      const v = this.level[layer] < OFF_BELOW ? 0 : this.level[layer];
      const out = this.outs[layer];
      if (out) out.gain.setTargetAtTime(v * LAYER_TRIM[layer], c.currentTime, 0.25);
      const rate = EVENT_RATE[layer];
      if (rate && v > 0 && this.rng() < rate * v * dt) this.fire(layer);
    }
  }

  private fire(layer: AmbienceLayer): void {
    const r = this.rng;
    const out = this.outs[layer];
    if (!out) return;
    const rand = r(), rand2 = r(), rand3 = r();
    this.engine.shot(`ambience:${layer}`, 'ambience', (ctx, _o, t, noise) => {
      const dest = out;
      switch (layer) {
        case 'birds': {
          const base = 2400 + rand * 1800;
          const n = 2 + Math.floor(rand2 * 3);
          for (let i = 0; i < n; i++) {
            tone(ctx, dest, { type: 'sine', freq: base, freqEnd: base * (1.15 + rand3 * 0.5), t: t + i * 0.11, dur: 0.07, gain: 0.5, attack: 0.008 });
          }
          return n * 0.11 + 0.1;
        }
        case 'servo': {
          const f = 240 + rand * 160;
          tone(ctx, dest, { type: 'sawtooth', freq: f, freqEnd: f * (1.5 + rand2), t, dur: 0.3 + rand3 * 0.25, gain: 0.5, attack: 0.04, filter: { type: 'bandpass', freq: 1100, q: 2 } });
          return 0.6;
        }
        case 'construction': {
          const f = 1500 + rand * 2200;
          noiseHit(ctx, dest, noise('white'), { t, dur: 0.14, gain: 0.7, filter: { type: 'bandpass', freq: f, q: 6 }, offset: rand2 });
          tone(ctx, dest, { type: 'sine', freq: f * 0.5, t, dur: 0.35, gain: 0.35, attack: 0.001 });
          tone(ctx, dest, { type: 'sine', freq: f * 0.5 * 2.76, t, dur: 0.2, gain: 0.2, attack: 0.001 });
          return 0.4;
        }
        case 'traffic': {
          noiseHit(ctx, dest, noise('brown'), { t, dur: 3.2, gain: 1, attack: 1.4, filter: { type: 'bandpass', freq: 260, freqEnd: 520, q: 0.8 }, offset: rand });
          return 3.3;
        }
        default: return 0;
      }
    }, { minGapMs: 80 });
  }

  /**
   * A strike `tiles` from the camera: the flash is the renderer's; the thunder arrives after the sound-travel delay,
   * lower and quieter the farther it was.
   */
  thunder(tiles: number): boolean {
    const c = this.engine.context;
    if (!c || !this.engine.live) return false;
    const now = c.currentTime;
    if (now - this.lastStrike < 0.25) return false;
    this.lastStrike = now;
    const level = thunderLevel(tiles), tone0 = thunderTone(tiles), delay = thunderDelay(tiles);
    const rng = this.rng, jitter = rng(), o1 = rng(), o2 = rng();
    return this.engine.shot('thunder', 'ambience', (ctx, out, t, noise) => {
      const crack = tiles < 40 ? 1 - tiles / 40 : 0;
      if (crack > 0.05) noiseHit(ctx, out, noise('white'), { t, dur: 0.18, gain: 0.8 * crack * level, filter: { type: 'highpass', freq: 1200, q: 0.5 }, offset: o1 });
      const len = 2.2 + 2.2 * (1 - level) + jitter;
      noiseHit(ctx, out, noise('brown'), { t, dur: len, gain: 1.4 * level, attack: 0.05 + 0.25 * (1 - crack), filter: { type: 'lowpass', freq: tone0, freqEnd: Math.max(60, tone0 * 0.12), q: 0.7 }, offset: o2 });
      tone(ctx, out, { type: 'sine', freq: 55, freqEnd: 32, t, dur: len * 0.8, gain: 0.5 * level, attack: 0.08 });
      return len;
    }, { delay, minGapMs: 0 });
  }

  /** Targets of the most recent update, for the debug readout. */
  get targets(): Readonly<AmbienceWeights> { return this.lastWeights; }

  dispose(): void {
    for (const l of Object.values(this.loops)) l?.stop();
    for (const layer of AMBIENCE_LAYERS) this.engine.unregisterLoop(layer);
    this.loops = {};
    this.outs = {};
    this.built = null;
  }
}

/** Per-layer trim so the weights, each 0..1, sit at sensible relative loudness. */
const LAYER_TRIM: Record<AmbienceLayer, number> = {
  wind: 0.55, birds: 0.35, cityHum: 0.32, traffic: 0.5, servo: 0.3, drone: 0.12, construction: 0.18, rain: 0.35, crickets: 0.05,
};
