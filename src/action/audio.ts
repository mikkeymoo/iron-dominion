import type { Fx } from './sim';

/** Synthesized sound effects. No audio files ship with the game. */
export class ArenaAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private last: Record<string, number> = {};
  muted = false;

  /** Must run inside a user gesture so browsers allow playback. */
  unlock() {
    if (this.ctx) { void this.ctx.resume(); return; }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    try {
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.55;
      const comp = this.ctx.createDynamicsCompressor();
      this.master.connect(comp).connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    } catch {
      this.ctx = null;
    }
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(muted ? 0 : 0.55, this.ctx.currentTime, 0.02);
  }

  suspend() { void this.ctx?.suspend(); }
  resume() { void this.ctx?.resume(); }
  dispose() { void this.ctx?.close(); this.ctx = null; }

  private gate(name: string, gap: number) {
    const now = performance.now();
    if (now - (this.last[name] ?? 0) < gap) return false;
    this.last[name] = now;
    return true;
  }

  private tone(type: OscillatorType, from: number, to: number, dur: number, vol: number, delay = 0) {
    const c = this.ctx!, t = c.currentTime + delay;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private burst(dur: number, vol: number, filter: BiquadFilterType, from: number, to: number) {
    const c = this.ctx!, t = c.currentTime;
    const src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    src.buffer = this.noise;
    f.type = filter;
    f.frequency.setValueAtTime(from, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master!);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }

  play(fx: Fx[], mechX: number, mechZ: number) {
    if (!this.ctx || this.muted || this.ctx.state !== 'running') return;
    let booms = 0;
    for (const f of fx) {
      if (f.type === 'muzzle') {
        if (f.byMech) { if (this.gate('pew', 45)) this.tone('square', 880, 180, 0.07, 0.05); }
        else if (Math.hypot(f.x - mechX, f.z - mechZ) < 45 && this.gate('epew', 70)) this.tone('sawtooth', 520, 140, 0.08, 0.02);
      } else if (f.type === 'boom' && booms < 3) {
        const d = Math.hypot(f.x - mechX, f.z - mechZ);
        if (d > 90) continue;
        booms++;
        const vol = Math.min(0.9, 0.25 + f.size * 0.2) * (1 - d / 100);
        this.burst(0.35 + f.size * 0.25, vol, 'lowpass', 1800, 60);
        this.tone('sine', 110, 30, 0.4 + f.size * 0.15, vol * 0.8);
      } else if (f.type === 'hit' && this.gate('hit', 50)) {
        this.tone('triangle', f.shield ? 1600 : 300, f.shield ? 900 : 120, 0.05, 0.03);
      } else if (f.type === 'missile') {
        this.burst(0.6, 0.25, 'bandpass', 600, 3000);
      } else if (f.type === 'dash') {
        this.burst(0.25, 0.2, 'highpass', 800, 4000);
      } else if (f.type === 'hurt' && this.gate('hurt', 120)) {
        this.tone('sawtooth', 160, 60, 0.15, 0.12);
      } else if (f.type === 'capture') {
        const good = f.team === 'player';
        [0, 0.08, 0.16].forEach((d, i) => this.tone('triangle', good ? 440 * (1 + i * 0.25) : 330 / (1 + i * 0.2), good ? 660 * (1 + i * 0.25) : 200, 0.18, 0.08, d));
      } else if (f.type === 'pickup') {
        this.tone('sine', 900, 1800, 0.15, 0.1);
      } else if (f.type === 'announce' && f.tone === 'warn') {
        for (let i = 0; i < 3; i++) this.tone('square', 520, 380, 0.25, 0.08, i * 0.32);
      } else if (f.type === 'announce' && f.tone === 'epic') {
        this.tone('sawtooth', 220, 440, 0.3, 0.08);
      }
    }
  }
}
