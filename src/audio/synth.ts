// Web Audio building blocks. Everything audible is generated here from oscillators and noise; there are no asset files.
import { mulberry32 } from './music.ts';

export type NoiseKind = 'white' | 'pink' | 'brown';

export interface FilterSpec { type: BiquadFilterType; freq: number; freqEnd?: number; q?: number }

/** Seeded noise so a rebuilt buffer sounds the same. Pink uses Paul Kellet's filter, brown a leaky integrator. */
export function noiseBuffer(c: BaseAudioContext, seconds: number, kind: NoiseKind, seed = 1): AudioBuffer {
  const n = Math.max(1, Math.floor(seconds * c.sampleRate));
  const buf = c.createBuffer(1, n, c.sampleRate);
  const d = buf.getChannelData(0);
  const rng = mulberry32(seed);
  let b0 = 0, b1 = 0, b2 = 0, last = 0;
  for (let i = 0; i < n; i++) {
    const w = rng() * 2 - 1;
    if (kind === 'white') d[i] = w;
    else if (kind === 'pink') {
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.25;
    } else {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
  }
  return buf;
}

/** Stereo reverb impulse: decaying noise, a little darker toward the tail. */
export function impulseResponse(c: BaseAudioContext, seconds: number, decay: number, seed = 7): AudioBuffer {
  const n = Math.max(1, Math.floor(seconds * c.sampleRate));
  const buf = c.createBuffer(2, n, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const rng = mulberry32(seed + ch * 101);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const k = 0.15 + 0.7 * (1 - t);
      lp += k * ((rng() * 2 - 1) - lp);
      d[i] = lp * (1 - t) ** decay;
    }
  }
  return buf;
}

const applyFilter = (c: BaseAudioContext, f: FilterSpec, t: number, dur: number): BiquadFilterNode => {
  const node = c.createBiquadFilter();
  node.type = f.type;
  node.frequency.setValueAtTime(f.freq, t);
  if (f.freqEnd !== undefined) node.frequency.exponentialRampToValueAtTime(Math.max(20, f.freqEnd), t + dur);
  if (f.q !== undefined) node.Q.value = f.q;
  return node;
};

export interface ToneSpec {
  type?: OscillatorType;
  freq: number;
  freqEnd?: number;
  t: number;
  dur: number;
  gain: number;
  attack?: number;
  detune?: number;
  filter?: FilterSpec;
}

/** One enveloped oscillator: linear attack, exponential decay to silence at t + dur. */
export function tone(c: BaseAudioContext, out: AudioNode, o: ToneSpec): void {
  const osc = c.createOscillator();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(o.freq, o.t);
  if (o.freqEnd !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.freqEnd), o.t + o.dur);
  if (o.detune) osc.detune.value = o.detune;
  const g = c.createGain();
  const attack = Math.min(o.attack ?? 0.008, o.dur * 0.5);
  g.gain.setValueAtTime(0.0001, o.t);
  g.gain.linearRampToValueAtTime(o.gain, o.t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, o.t + o.dur);
  osc.connect(g);
  let tail: AudioNode = g;
  if (o.filter) { const f = applyFilter(c, o.filter, o.t, o.dur); g.connect(f); tail = f; }
  tail.connect(out);
  osc.start(o.t);
  osc.stop(o.t + o.dur + 0.05);
}

export interface HitSpec { t: number; dur: number; gain: number; attack?: number; filter: FilterSpec; offset?: number }

/** A burst of noise through one filter with an exponential tail. */
export function noiseHit(c: BaseAudioContext, out: AudioNode, noise: AudioBuffer, o: HitSpec): void {
  const src = c.createBufferSource();
  src.buffer = noise;
  const f = applyFilter(c, o.filter, o.t, o.dur);
  const g = c.createGain();
  const attack = Math.min(o.attack ?? 0.005, o.dur * 0.5);
  g.gain.setValueAtTime(0.0001, o.t);
  g.gain.linearRampToValueAtTime(o.gain, o.t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, o.t + o.dur);
  src.connect(f);
  f.connect(g);
  g.connect(out);
  const room = Math.max(0, noise.duration - o.dur - 0.01);
  src.start(o.t, (o.offset ?? 0) * room);
  src.stop(o.t + o.dur + 0.05);
}

export interface Loop { gain: GainNode; stop(): void }

/** A looping noise source through a filter into its own gain node; `gain` starts at 0. */
export function noiseLoop(c: BaseAudioContext, out: AudioNode, noise: AudioBuffer, filter: FilterSpec, lfo?: { rate: number; depth: number }): Loop {
  const src = c.createBufferSource();
  src.buffer = noise;
  src.loop = true;
  const f = applyFilter(c, filter, c.currentTime, 1);
  const g = c.createGain();
  g.gain.value = 0;
  src.connect(f);
  f.connect(g);
  g.connect(out);
  const stops: (() => void)[] = [() => src.stop()];
  if (lfo) {
    const o = c.createOscillator();
    o.frequency.value = lfo.rate;
    const d = c.createGain();
    d.gain.value = lfo.depth;
    o.connect(d);
    d.connect(f.frequency);
    o.start();
    stops.push(() => o.stop());
  }
  src.start();
  return { gain: g, stop: () => { for (const s of stops) { try { s(); } catch { /* already stopped */ } } g.disconnect(); } };
}

/** A looping oscillator pair (optionally amplitude-modulated) into its own gain node; `gain` starts at 0. */
export function oscLoop(c: BaseAudioContext, out: AudioNode, o: { type: OscillatorType; freqs: number[]; filter: FilterSpec; am?: { rate: number; depth: number } }): Loop {
  const g = c.createGain();
  g.gain.value = 0;
  const amp = c.createGain();
  amp.gain.value = o.am ? 1 - o.am.depth : 1;
  const f = applyFilter(c, o.filter, c.currentTime, 1);
  const stops: (() => void)[] = [];
  for (const freq of o.freqs) {
    const osc = c.createOscillator();
    osc.type = o.type;
    osc.frequency.value = freq;
    osc.connect(f);
    osc.start();
    stops.push(() => osc.stop());
  }
  f.connect(amp);
  amp.connect(g);
  g.connect(out);
  if (o.am) {
    const lfo = c.createOscillator();
    lfo.frequency.value = o.am.rate;
    const d = c.createGain();
    d.gain.value = o.am.depth;
    lfo.connect(d);
    d.connect(amp.gain);
    lfo.start();
    stops.push(() => lfo.stop());
  }
  return { gain: g, stop: () => { for (const s of stops) { try { s(); } catch { /* already stopped */ } } g.disconnect(); } };
}
