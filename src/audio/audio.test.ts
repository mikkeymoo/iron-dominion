import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { createPlatformDb, openIdbAdapter } from '../platform/db.ts';
import { DEFAULT_SETTINGS, loadSettings, saveSetting } from '../platform/settings.ts';
import { Ambience } from './ambience.ts';
import { AudioEngine, DEFAULT_MIX } from './engine.ts';
import { AudioDirector, mixOf } from './index.ts';
import { asContext, FakeAudioContext, type FakeNode } from './fakeAudio.ts';
import { AMBIENCE_LAYERS, W, ambienceWeights, busGains, nightness, populationLevel, thunderDelay, thunderLevel, type AmbienceInput } from './mix.ts';
import { BEATS_PER_BAR, MusicScheduler, bpmOf } from './music.ts';
import { SFX_NAMES } from './sfx.ts';

const input = (o: Partial<AmbienceInput> = {}): AmbienceInput => ({
  camDist: 120, population: 0, weather: W.CLEAR, weatherIntensity: 0, dayFrac: 0.5, nearBuildings: 0, nearSites: 0, nearRobots: 0, nearDrones: 0, ...o,
});

function engineWith(ctx = new FakeAudioContext()) {
  const engine = new AudioEngine({ create: () => asContext(ctx) });
  return { engine, ctx };
}

describe('bus graph', () => {
  it('wires music, ambience and sfx through master and a compressor to the destination, each with a reverb send', async () => {
    const { engine, ctx } = engineWith();
    await engine.unlock();
    const b = engine.buses!;
    const comp = ctx.ofKind('compressor')[0]!;
    for (const bus of [b.music, b.ambience, b.sfx]) expect((bus as unknown as FakeNode).out).toContain(b.master);
    expect((b.master as unknown as FakeNode).out).toEqual([comp]);
    expect(comp.out).toEqual([ctx.destination]);
    const sends = (b.music as unknown as FakeNode).out.filter((n) => n !== (b.master as unknown as FakeNode));
    expect(sends).toHaveLength(1);
    expect(sends[0]!.out).toContain(b.reverb);
    expect((b.reverb as unknown as { buffer: unknown }).buffer).toBeTruthy();
  });

  it('creates nothing before the first gesture and is running after it', async () => {
    const created = vi.fn(() => asContext(new FakeAudioContext()));
    const engine = new AudioEngine({ create: created });
    expect(engine.state).toBe('idle');
    expect(created).not.toHaveBeenCalled();
    expect(engine.shot('place', 'sfx', () => 0.1)).toBe(false);
    await engine.unlock();
    expect(created).toHaveBeenCalledTimes(1);
    expect(engine.state).toBe('running');
    await engine.unlock();
    expect(created).toHaveBeenCalledTimes(1);
  });

  it('unlocks on a gesture event and stops listening once running', async () => {
    const { engine } = engineWith();
    const target = new EventTarget();
    engine.bindGestures(target);
    target.dispatchEvent(new Event('pointerdown'));
    await vi.waitFor(() => expect(engine.state).toBe('running'));
    await new Promise((r) => setTimeout(r, 0));
    const spy = vi.spyOn(engine, 'unlock');
    target.dispatchEvent(new Event('pointerdown'));
    expect(spy).not.toHaveBeenCalled();
  });

  it('survives a refused resume and an unsupported browser without throwing', async () => {
    const ctx = new FakeAudioContext();
    ctx.rejectResume = true;
    const { engine } = engineWith(ctx);
    await expect(engine.unlock()).resolves.toBeUndefined();
    expect(engine.state).toBe('suspended');
    const none = new AudioEngine({ create: () => null });
    await expect(none.unlock()).resolves.toBeUndefined();
    expect(none.state).toBe('unsupported');
  });

  it('applies mute, volumes and the pause duck to the bus gains', async () => {
    const { engine } = engineWith();
    await engine.unlock();
    const b = engine.buses!;
    const g = (n: unknown) => (n as { gain: { value: number } }).gain.value;
    engine.applySettings({ ...DEFAULT_MIX, volume: 0.5, music: 0.4, ambience: 0.6, sfx: 1 });
    expect([g(b.master), g(b.music), g(b.ambience), g(b.sfx)]).toEqual([0.5, 0.4, 0.6, 1]);
    engine.applySettings({ ...DEFAULT_MIX, muted: true });
    expect(g(b.master)).toBe(0);
    engine.applySettings({ ...DEFAULT_MIX, musicOn: false });
    expect(g(b.music)).toBe(0);
    expect(g(b.sfx)).toBe(DEFAULT_MIX.sfx);
    engine.setPaused(true);
    expect(engine.busLevels.ambience).toBeCloseTo(DEFAULT_MIX.ambience * 0.3);
    expect(engine.busLevels.sfx).toBe(DEFAULT_MIX.sfx);
  });

  it('suspends and resumes the context with the lifecycle and drops sounds while suspended', async () => {
    const { engine, ctx } = engineWith();
    await engine.unlock();
    await engine.setSuspended(true);
    expect(ctx.state).toBe('suspended');
    expect(engine.state).toBe('suspended');
    expect(engine.shot('toast', 'sfx', () => 0.1)).toBe(false);
    await engine.setSuspended(false);
    expect(engine.state).toBe('running');
    expect(engine.shot('toast', 'sfx', () => 0.1)).toBe(true);
  });

  it('lists live one-shots and loops in playing and caps concurrent voices', async () => {
    const { engine } = engineWith();
    await engine.unlock();
    engine.shot('place', 'sfx', () => 0.5);
    engine.registerLoop('wind', 'ambience', () => 0.6);
    engine.registerLoop('rain', 'ambience', () => 0);
    expect(engine.playing.map((p) => `${p.kind}:${p.name}`).sort()).toEqual(['loop:wind', 'shot:place']);
    let started = 0;
    for (let i = 0; i < 100; i++) if (engine.shot(`v${i}`, 'sfx', () => 5, { minGapMs: 0 })) started++;
    expect(started).toBeLessThan(100);
    expect(started).toBeGreaterThan(10);
  });
});

describe('director', () => {
  it('exposes the debug shape and plays every sfx once unlocked', async () => {
    const { engine } = engineWith();
    const d = new AudioDirector(engine, 1);
    expect(d.debug.state).toBe('idle');
    expect(d.debug.play('place')).toBe(false);
    await engine.unlock();
    const dbg = d.debug;
    expect(dbg.state).toBe('running');
    expect(Object.keys(dbg.buses).sort()).toEqual(['ambience', 'master', 'music', 'sfx']);
    for (const name of SFX_NAMES) expect(dbg.play(name)).toBe(true);
    expect(dbg.playing.map((p) => p.name).sort()).toEqual([...SFX_NAMES].sort());
    d.dispose();
  });

  it('feeds ambience, thunder and music through the engine', async () => {
    const { engine, ctx } = engineWith();
    await engine.unlock();
    const amb = new Ambience(engine, 3);
    for (let i = 0; i < 20; i++) amb.update(input({ weather: W.STORM, weatherIntensity: 1, population: 5000, camDist: 20, nearBuildings: 60, nearSites: 3, nearRobots: 6 }), 0.25);
    expect(amb.weights.rain).toBeGreaterThan(0.5);
    expect(ctx.ofKind('source').length).toBeGreaterThan(0);
    expect(engine.playing.some((p) => p.name === 'rain')).toBe(true);
    expect(amb.thunder(30)).toBe(true);
    expect(engine.playing.some((p) => p.name === 'thunder')).toBe(true);
    amb.dispose();
  });

  it('maps settings to the engine mix', () => {
    expect(mixOf(DEFAULT_SETTINGS)).toEqual({ muted: false, volume: 0.7, music: 0.6, ambience: 0.8, sfx: 0.9, musicOn: true });
  });
});

describe('sound settings persistence', () => {
  it('saves and reloads the master, per-bus levels and mutes', async () => {
    const db = createPlatformDb(await openIdbAdapter(new IDBFactory()));
    expect(await saveSetting(db, undefined, 'audio', { muted: true, volume: 0.25 })).toBe(true);
    expect(await saveSetting(db, undefined, 'soundMix', { music: 0.1, ambience: 0.2, sfx: 0.3, musicOn: false })).toBe(true);
    const s = await loadSettings(db, undefined);
    expect(s.audio).toEqual({ muted: true, volume: 0.25 });
    expect(s.soundMix).toEqual({ music: 0.1, ambience: 0.2, sfx: 0.3, musicOn: false });
  });

  it('defaults and clamps bad stored values', async () => {
    const db = createPlatformDb(await openIdbAdapter(new IDBFactory()));
    expect((await loadSettings(db, undefined)).soundMix).toEqual(DEFAULT_SETTINGS.soundMix);
    await db.setSetting('soundMix', { music: 7, ambience: 'loud', sfx: -2, musicOn: 'yes' });
    expect((await loadSettings(db, undefined)).soundMix).toEqual({ music: 1, ambience: DEFAULT_SETTINGS.soundMix.ambience, sfx: 0, musicOn: true });
  });

  it('computes bus gains from settings', () => {
    expect(busGains({ ...DEFAULT_MIX, muted: true }).master).toBe(0);
    expect(busGains({ ...DEFAULT_MIX, musicOn: false }).music).toBe(0);
  });
});

describe('ambience mix weights', () => {
  const w = (o: Partial<AmbienceInput>) => ambienceWeights(input(o));

  it('keeps every weight within 0..1', () => {
    for (const camDist of [3, 30, 120, 300]) for (const population of [0, 500, 50000]) for (const weather of [0, 1, 2, 3]) for (const dayFrac of [0, 0.3, 0.5, 0.8]) {
      const r = w({ camDist, population, weather, weatherIntensity: 1, dayFrac, nearBuildings: 30, nearSites: 9, nearRobots: 20, nearDrones: 9 });
      for (const l of AMBIENCE_LAYERS) { expect(r[l]).toBeGreaterThanOrEqual(0); expect(r[l]).toBeLessThanOrEqual(1); }
    }
  });

  it('brings wind up with camera height and street detail up as the camera comes down', () => {
    expect(w({ camDist: 250 }).wind).toBeGreaterThan(w({ camDist: 10 }).wind);
    const near = { nearRobots: 8, nearDrones: 6, nearSites: 4 };
    const low = w({ camDist: 6, ...near }), high = w({ camDist: 200, ...near });
    for (const l of ['servo', 'drone', 'construction'] as const) { expect(low[l]).toBeGreaterThan(0.5); expect(high[l]).toBe(0); }
    expect(w({ camDist: 6 }).servo).toBe(0);
  });

  it('grows city hum and traffic with population and fades them with altitude', () => {
    expect(w({ population: 0 }).cityHum).toBe(0);
    expect(w({ population: 20000, nearBuildings: 80 }).cityHum).toBeGreaterThan(w({ population: 200, nearBuildings: 80 }).cityHum);
    expect(w({ population: 20000, camDist: 40 }).traffic).toBeGreaterThan(w({ population: 100, camDist: 40 }).traffic);
    expect(w({ population: 20000, camDist: 280, nearBuildings: 80 }).cityHum).toBeLessThan(w({ population: 20000, camDist: 40, nearBuildings: 80 }).cityHum);
    expect(populationLevel(0)).toBe(0);
    expect(populationLevel(10000)).toBeCloseTo(1, 1);
  });

  it('favours birds in daytime nature and crickets at night', () => {
    expect(w({ dayFrac: 0.5, nearBuildings: 0 }).birds).toBeGreaterThan(w({ dayFrac: 0.5, nearBuildings: 120, population: 9000 }).birds);
    expect(w({ dayFrac: 0.0 }).birds).toBe(0);
    expect(w({ dayFrac: 0.0 }).crickets).toBeGreaterThan(0.2);
    expect(w({ dayFrac: 0.5 }).crickets).toBe(0);
    expect(nightness(0)).toBe(1);
    expect(nightness(0.5)).toBe(0);
  });

  it('plays rain only in rain or storm, scaled by intensity, and mutes birds in it', () => {
    expect(w({ weather: W.CLEAR, weatherIntensity: 1 }).rain).toBe(0);
    expect(w({ weather: W.SNOW, weatherIntensity: 1 }).rain).toBe(0);
    expect(w({ weather: W.RAIN, weatherIntensity: 0.3 }).rain).toBeLessThan(w({ weather: W.RAIN, weatherIntensity: 1 }).rain);
    expect(w({ weather: W.STORM, weatherIntensity: 1 }).rain).toBeGreaterThan(w({ weather: W.RAIN, weatherIntensity: 1 }).rain);
    expect(w({ weather: W.RAIN, weatherIntensity: 1 }).birds).toBeLessThan(w({ weather: W.CLEAR }).birds);
  });
});

describe('thunder timing', () => {
  it('delays thunder with distance, from near-instant to a capped maximum', () => {
    expect(thunderDelay(0)).toBeLessThan(0.2);
    expect(thunderDelay(50)).toBeGreaterThan(thunderDelay(10));
    expect(thunderDelay(100)).toBeCloseTo(0.12 + (100 * 12) / 343, 5);
    expect(thunderDelay(1e6)).toBe(8);
    expect(thunderLevel(5)).toBeGreaterThan(thunderLevel(150));
  });

  it('starts the thunder voice after the delay on the audio clock', async () => {
    const { engine, ctx } = engineWith();
    await engine.unlock();
    const amb = new Ambience(engine, 5);
    ctx.currentTime = 10;
    amb.thunder(100);
    const starts = ctx.ofKind('source').flatMap((n) => (n as unknown as { started: number[] }).started);
    expect(starts.length).toBeGreaterThan(0);
    for (const t of starts) expect(t).toBeGreaterThanOrEqual(10 + thunderDelay(100));
  });
});

describe('music scheduler', () => {
  const run = (seed: number, p = { size: 0.5, night: 0 }) => {
    const s = new MusicScheduler(seed);
    const notes = [];
    for (let now = 0; now < 40; now += 1) notes.push(...s.generate(now, 3, p));
    return notes;
  };

  it('produces the same notes for the same seed', () => {
    const a = run(42);
    expect(a.length).toBeGreaterThan(30);
    expect(run(42)).toEqual(a);
  });

  it('produces different music for different seeds', () => {
    expect(run(1)).not.toEqual(run(2));
  });

  it('emits notes in time order within bars, with finite positive frequencies and durations', () => {
    const notes = run(7);
    for (const n of notes) {
      expect(Number.isFinite(n.freq)).toBe(true);
      expect(n.freq).toBeGreaterThan(30);
      expect(n.freq).toBeLessThan(4000);
      expect(n.dur).toBeGreaterThan(0);
      expect(n.vel).toBeGreaterThan(0);
    }
    const pads = notes.filter((n) => n.voice === 'pad');
    expect(pads.length % 3).toBe(0);
    expect(pads[3]!.t).toBeGreaterThan(pads[0]!.t);
  });

  it('plays a denser, faster piece for a big city than a village, and calmer at night', () => {
    const big = run(9, { size: 1, night: 0 }), small = run(9, { size: 0, night: 0 });
    expect(big.filter((n) => n.voice === 'arp').length / big.length).toBeGreaterThan(small.filter((n) => n.voice === 'arp').length / small.length - 0.05);
    expect(bpmOf({ size: 1, night: 0 })).toBeGreaterThan(bpmOf({ size: 0, night: 0 }));
    expect(bpmOf({ size: 1, night: 1 })).toBeLessThan(bpmOf({ size: 1, night: 0 }));
    expect(big.filter((n) => n.voice === 'arp').length).toBeGreaterThan(small.filter((n) => n.voice === 'arp').length);
  });

  it('skips ahead after a long gap instead of replaying the backlog', () => {
    const s = new MusicScheduler(3);
    s.generate(0, 3, { size: 0.5, night: 0 });
    const late = s.generate(500, 3, { size: 0.5, night: 0 });
    expect(late.length).toBeGreaterThan(0);
    expect(Math.min(...late.map((n) => n.t))).toBeGreaterThanOrEqual(500);
    expect(late.length).toBeLessThan(80);
  });

  it('keeps arpeggio notes inside the key', () => {
    const notes = run(11).filter((n) => n.voice === 'arp');
    const semis = notes.map((n) => Math.round(12 * Math.log2(n.freq / 440) + 69) % 12);
    expect(new Set(semis).size).toBeLessThanOrEqual(7);
    expect(BEATS_PER_BAR).toBe(4);
  });
});
