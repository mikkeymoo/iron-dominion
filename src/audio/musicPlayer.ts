// Plays the notes a MusicScheduler produces. A 1 s timer queues the next few seconds, so the audio thread does the timing.
import type { AudioEngine } from './engine.ts';
import { MusicScheduler, type MusicParams, type Note } from './music.ts';
import { tone } from './synth.ts';

const HORIZON_S = 3;

export function playNote(c: AudioContext, out: AudioNode, n: Note): void {
  switch (n.voice) {
    case 'pad':
      for (const d of [-7, 7]) {
        tone(c, out, { type: 'triangle', freq: n.freq, t: n.t, dur: n.dur, gain: 0.07 * n.vel, attack: Math.min(1.6, n.dur * 0.4), detune: d, filter: { type: 'lowpass', freq: 1100 } });
      }
      break;
    case 'bass':
      tone(c, out, { type: 'sine', freq: n.freq, t: n.t, dur: n.dur, gain: 0.2 * n.vel, attack: 0.05 });
      break;
    case 'arp':
      tone(c, out, { type: 'triangle', freq: n.freq, t: n.t, dur: n.dur, gain: 0.1 * n.vel, attack: 0.012, filter: { type: 'lowpass', freq: 2600 } });
      tone(c, out, { type: 'sine', freq: n.freq * 2, t: n.t, dur: n.dur * 0.6, gain: 0.03 * n.vel, attack: 0.008 });
      break;
  }
}

export class MusicPlayer {
  private readonly scheduler: MusicScheduler;
  private out: GainNode | null = null;
  private built: AudioContext | null = null;
  private notesPlayed = 0;

  constructor(private readonly engine: AudioEngine, seed: number) {
    this.scheduler = new MusicScheduler(seed);
  }

  get played(): number { return this.notesPlayed; }

  /** Queue upcoming notes. Does nothing while the music is off, the context is suspended or not yet unlocked. */
  tick(p: MusicParams): void {
    const c = this.engine.context, buses = this.engine.buses;
    if (!c || !buses || !this.engine.live || this.engine.busLevels.music <= 0) return;
    if (this.built !== c) {
      this.out = c.createGain();
      this.out.connect(buses.music);
      this.built = c;
      this.engine.registerLoop('music', 'music', () => (this.engine.busLevels.music > 0 ? 1 : 0));
    }
    for (const n of this.scheduler.generate(c.currentTime + 0.05, HORIZON_S, p)) {
      playNote(c, this.out!, n);
      this.notesPlayed++;
    }
  }

  dispose(): void { this.engine.unregisterLoop('music'); this.out = null; this.built = null; }
}
