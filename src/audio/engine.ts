// The audio engine: one AudioContext, created on the first user gesture (autoplay policy), and the bus graph
//   music/ambience/sfx -> master -> compressor -> destination, with each bus also feeding one shared convolution reverb.
import { busGains, type BusGains, type MixSettings } from './mix.ts';
import { impulseResponse, noiseBuffer, type NoiseKind } from './synth.ts';

export type BusName = 'music' | 'ambience' | 'sfx';
export type EngineState = 'idle' | 'running' | 'suspended' | 'unsupported';

export interface Buses { master: GainNode; music: GainNode; ambience: GainNode; sfx: GainNode; reverb: ConvolverNode }

export interface PlayingEntry { name: string; bus: BusName; kind: 'loop' | 'shot'; level: number }

export const DEFAULT_MIX: MixSettings = { muted: false, volume: 0.7, music: 0.6, ambience: 0.8, sfx: 0.9, musicOn: true };

const REVERB_SEND: Record<BusName, number> = { music: 0.4, ambience: 0.18, sfx: 0.12 };
const GESTURES = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'] as const;
const MAX_SHOTS = 28;
const RAMP_S = 0.06;

interface Shot { name: string; bus: BusName; until: number }

export interface EngineOptions {
  create?: () => AudioContext | null;
}

const defaultCreate = (): AudioContext | null => {
  const g = globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  return Ctor ? new Ctor({ latencyHint: 'playback' }) : null;
};

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private graph: Buses | null = null;
  private mix: MixSettings = { ...DEFAULT_MIX };
  private paused = false;
  private wantSuspended = false;
  private unsupported = false;
  private levels: BusGains = busGains(DEFAULT_MIX);
  private readonly shots: Shot[] = [];
  private readonly loops = new Map<string, { bus: BusName; level: () => number }>();
  private readonly noises = new Map<NoiseKind, AudioBuffer>();
  private readonly lastFired = new Map<string, number>();
  private readonly create: () => AudioContext | null;

  constructor(opt: EngineOptions = {}) {
    this.create = opt.create ?? defaultCreate;
  }

  get context(): AudioContext | null { return this.ctx; }
  get buses(): Buses | null { return this.graph; }
  get settings(): Readonly<MixSettings> { return this.mix; }
  /** Target gain of each bus after mute, volumes and the pause duck. */
  get busLevels(): Readonly<BusGains> { return this.levels; }

  get state(): EngineState {
    if (this.unsupported) return 'unsupported';
    if (!this.ctx) return 'idle';
    return this.ctx.state === 'running' && !this.wantSuspended ? 'running' : 'suspended';
  }

  /** True when a sound started now would actually be heard. */
  get live(): boolean { return this.state === 'running'; }

  get now(): number { return this.ctx?.currentTime ?? 0; }

  /** Create the context and bus graph if needed and resume it unless the page is hidden. Safe to call from any gesture, never throws. */
  async unlock(): Promise<void> {
    if (this.unsupported) return;
    try {
      if (!this.ctx) {
        const ctx = this.create();
        if (!ctx) { this.unsupported = true; return; }
        this.ctx = ctx;
        this.graph = this.build(ctx);
        this.applyLevels(true);
        if (this.wantSuspended) await ctx.suspend();
      }
      if (!this.wantSuspended && this.ctx.state !== 'running') await this.ctx.resume();
    } catch {
      /* the browser refused to start audio; the next gesture tries again */
    }
  }

  /** Listen for the first user gesture; the listeners stay until the context is running. Returns the disposer. */
  bindGestures(target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>): () => void {
    const on = (): void => {
      void this.unlock().then(() => { if (this.ctx?.state === 'running') off(); });
    };
    const off = (): void => { for (const g of GESTURES) target.removeEventListener(g, on, true); };
    for (const g of GESTURES) target.addEventListener(g, on, true);
    return off;
  }

  private build(ctx: AudioContext): Buses {
    const master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 18;
    comp.ratio.value = 4;
    comp.attack.value = 0.01;
    comp.release.value = 0.25;
    master.connect(comp);
    comp.connect(ctx.destination);
    const reverb = ctx.createConvolver();
    reverb.buffer = impulseResponse(ctx, 2.4, 2.6);
    const wet = ctx.createGain();
    wet.gain.value = 0.55;
    reverb.connect(wet);
    wet.connect(master);
    const bus = (name: BusName): GainNode => {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(master);
      const send = ctx.createGain();
      send.gain.value = REVERB_SEND[name];
      g.connect(send);
      send.connect(reverb);
      return g;
    };
    master.gain.value = 0;
    return { master, music: bus('music'), ambience: bus('ambience'), sfx: bus('sfx'), reverb };
  }

  applySettings(s: MixSettings): void {
    this.mix = { ...s };
    this.applyLevels();
  }

  /** Game paused or waiting behind the Resume overlay: music and ambience duck, UI sounds stay. */
  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.applyLevels();
  }

  private applyLevels(immediate = false): void {
    this.levels = busGains(this.mix, this.paused);
    const g = this.graph, c = this.ctx;
    if (!g || !c) return;
    const set = (p: AudioParam, v: number): void => {
      if (immediate) p.setValueAtTime(v, c.currentTime);
      else p.setTargetAtTime(v, c.currentTime, RAMP_S);
    };
    set(g.master.gain, this.levels.master);
    set(g.music.gain, this.levels.music);
    set(g.ambience.gain, this.levels.ambience);
    set(g.sfx.gain, this.levels.sfx);
  }

  /** Suspend the context while the page is hidden or the sim waits for Resume; the clock stops, so nothing queued bursts out later. */
  async setSuspended(suspended: boolean): Promise<void> {
    this.wantSuspended = suspended;
    const c = this.ctx;
    if (!c) return;
    try {
      if (suspended && c.state === 'running') await c.suspend();
      else if (!suspended && c.state === 'suspended') await c.resume();
    } catch {
      /* resume needs a gesture again; bindGestures covers it */
    }
  }

  noise(kind: NoiseKind): AudioBuffer | null {
    const c = this.ctx;
    if (!c) return null;
    let b = this.noises.get(kind);
    if (!b) { b = noiseBuffer(c, 3, kind, kind === 'white' ? 11 : kind === 'pink' ? 23 : 37); this.noises.set(kind, b); }
    return b;
  }

  private prune(): void {
    const t = this.now;
    for (let i = this.shots.length - 1; i >= 0; i--) if (this.shots[i]!.until <= t) this.shots.splice(i, 1);
  }

  /**
   * Play one short sound. `build` gets the context, an output node feeding the bus and the start time, and returns its length in seconds.
   * Dropped (returns false) while not live, past the voice cap, or when the same sound fired within `minGapMs`.
   */
  shot(name: string, bus: BusName, build: (c: AudioContext, out: AudioNode, t: number, noise: (k: NoiseKind) => AudioBuffer) => number, opt: { delay?: number; minGapMs?: number } = {}): boolean {
    const c = this.ctx, g = this.graph;
    if (!c || !g || !this.live) return false;
    const wall = typeof performance !== 'undefined' ? performance.now() : 0;
    const gap = opt.minGapMs ?? 40;
    if (wall - (this.lastFired.get(name) ?? -1e9) < gap) return false;
    this.prune();
    if (this.shots.length >= MAX_SHOTS) return false;
    this.lastFired.set(name, wall);
    const out = c.createGain();
    out.connect(g[bus]);
    const t = c.currentTime + 0.01 + (opt.delay ?? 0);
    let len = 0;
    try { len = build(c, out, t, (k) => this.noise(k)!); } catch { out.disconnect(); return false; }
    this.shots.push({ name, bus, until: t + len + 0.1 });
    setTimeout(() => { try { out.disconnect(); } catch { /* gone */ } }, (len + (opt.delay ?? 0) + 0.3) * 1000);
    return true;
  }

  registerLoop(name: string, bus: BusName, level: () => number): void { this.loops.set(name, { bus, level }); }
  unregisterLoop(name: string): void { this.loops.delete(name); }

  get playing(): PlayingEntry[] {
    this.prune();
    const out: PlayingEntry[] = [];
    const t = this.now;
    for (const [name, l] of this.loops) { const level = l.level(); if (level > 0.02 && this.live) out.push({ name, bus: l.bus, kind: 'loop', level: Math.round(level * 100) / 100 }); }
    for (const s of this.shots) if (this.live) out.push({ name: s.name, bus: s.bus, kind: 'shot', level: s.until > t ? 1 : 0 });
    return out;
  }

  dispose(): void {
    const c = this.ctx;
    this.ctx = null;
    this.graph = null;
    this.shots.length = 0;
    this.loops.clear();
    if (c) void c.close().catch(() => undefined);
  }
}
