import { describe, expect, it } from 'vitest';
import type { Speed } from '../sim/protocol.ts';
import { createLifecycle, type LifecycleDeps, type WriteOutcome, type WriteWhy } from './lifecycle.ts';

function harness(opt: { writeResult?: () => WriteOutcome } = {}) {
  let clock = 0;
  const log: string[] = [];
  const writes: { data: Uint8Array; why: WriteWhy }[] = [];
  let fresh: Uint8Array = new Uint8Array([9]);
  const deps: LifecycleDeps = {
    now: () => clock,
    pauseSim: () => log.push('pause'),
    resumeSim: () => log.push('resume'),
    setSimSpeed: (s: Speed) => log.push(`speed:${s}`),
    requestSnapshot: async () => fresh,
    write: async (data, why) => { writes.push({ data, why }); return opt.writeResult?.() ?? { ok: true }; },
  };
  const lc = createLifecycle(deps, { autosaveMs: 60_000 });
  const advance = (ms: number): void => { for (let i = 0; i < ms / 1000; i++) { clock += 1000; lc.tick(); } };
  const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  const jump = (ms: number): void => { clock += ms; lc.tick(); };
  return { lc, log, writes, advance, jump, flush, setFresh: (b: Uint8Array) => { fresh = b; } };
}

describe('hide and resume', () => {
  it('pauses and writes the cached snapshot immediately, then the fresh one', async () => {
    const h = harness();
    const cached = new Uint8Array([1, 2, 3]);
    h.lc.cacheSnapshot(cached);
    h.lc.hide();
    expect(h.log).toEqual(['pause']);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toMatchObject({ why: 'hide' });
    expect(h.writes[0]!.data).toBe(cached);
    await h.flush();
    expect(h.writes).toHaveLength(2);
    expect(Array.from(h.writes[1]!.data)).toEqual([9]);
  });

  it('skips the cached write when nothing is cached and still requests a fresh one', async () => {
    const h = harness();
    h.lc.hide();
    await h.flush();
    expect(h.writes.map((w) => Array.from(w.data))).toEqual([[9]]);
  });

  it('stays paused on return until Resume, and resumes at the chosen speed', () => {
    const h = harness();
    h.lc.setSpeed(4);
    h.log.length = 0;
    h.lc.hide();
    h.lc.show();
    expect(h.lc.state.awaitingResume).toBe(true);
    expect(h.log).toEqual(['pause']);
    h.lc.resume();
    expect(h.lc.state.awaitingResume).toBe(false);
    expect(h.log).toEqual(['pause', 'speed:4', 'resume']);
  });

  it('keeps a user pause after Resume', () => {
    const h = harness();
    h.lc.setSpeed(0);
    h.lc.hide();
    h.lc.show();
    h.log.length = 0;
    h.lc.resume();
    expect(h.log).toEqual(['pause']);
  });

  it('ignores a pagehide that follows a hidden visibilitychange', async () => {
    const h = harness();
    h.lc.cacheSnapshot(new Uint8Array([1]));
    h.lc.hide();
    h.lc.hide();
    await h.flush();
    expect(h.writes).toHaveLength(2);
  });

  it('a speed change while the overlay is up does not run the sim', () => {
    const h = harness();
    h.lc.hide();
    h.lc.show();
    h.log.length = 0;
    h.lc.setSpeed(2);
    expect(h.log).toEqual([]);
    h.lc.resume();
    expect(h.log).toEqual(['speed:2', 'resume']);
  });
});

describe('autosave cadence', () => {
  it('saves after 60 s of active play', async () => {
    const h = harness();
    h.advance(59_000);
    await h.flush();
    expect(h.writes).toHaveLength(0);
    h.advance(1000);
    await h.flush();
    expect(h.writes.map((w) => w.why)).toEqual(['autosave']);
  });

  it('does not count paused, hidden or overlay time', async () => {
    const h = harness();
    h.lc.setSpeed(0);
    h.advance(120_000);
    h.lc.setSpeed(1);
    h.advance(30_000);
    h.lc.hide();
    h.advance(120_000);
    h.lc.show();
    h.advance(120_000);
    await h.flush();
    expect(h.writes.filter((w) => w.why === 'autosave')).toHaveLength(0);
    h.lc.resume();
    h.advance(59_000);
    await h.flush();
    expect(h.writes.filter((w) => w.why === 'autosave')).toHaveLength(0);
    h.advance(1000);
    await h.flush();
    expect(h.writes.filter((w) => w.why === 'autosave')).toHaveLength(1);
  });

  it('credits at most a few seconds for one late tick', async () => {
    const h = harness();
    h.jump(100_000);
    await h.flush();
    expect(h.writes).toHaveLength(0);
    expect(h.lc.state.activeMs).toBe(5000);
  });

  it('caches each autosave snapshot for the hide path', async () => {
    const h = harness();
    h.setFresh(new Uint8Array([7, 7]));
    h.advance(60_000);
    await h.flush();
    h.lc.hide();
    expect(Array.from(h.writes[1]!.data)).toEqual([7, 7]);
  });
});

describe('storage failure', () => {
  it('records the reason, keeps ticking and retries on the next interval', async () => {
    let fail = true;
    const h = harness({ writeResult: () => (fail ? { ok: false, reason: 'quota' } : { ok: true }) });
    h.advance(60_000);
    await h.flush();
    expect(h.lc.state.lastError).toBe('quota');
    expect(h.lc.state.saving).toBe(false);
    h.log.length = 0;
    h.lc.setSpeed(2);
    expect(h.log).toEqual(['speed:2', 'resume']);
    fail = false;
    h.advance(60_000);
    await h.flush();
    expect(h.lc.state.lastError).toBeNull();
    expect(h.writes).toHaveLength(2);
  });

  it('survives a write that throws and a snapshot request that rejects', async () => {
    let clock = 0;
    const lc = createLifecycle({
      now: () => clock, pauseSim: () => undefined, resumeSim: () => undefined, setSimSpeed: () => undefined,
      requestSnapshot: async () => { throw new Error('worker gone'); },
      write: async () => { throw new Error('boom'); },
    }, { autosaveMs: 2000 });
    clock += 1000; lc.tick(); clock += 1000; lc.tick();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(lc.state.lastError).toBe('unavailable');
    lc.cacheSnapshot(new Uint8Array([1]));
    lc.hide();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(lc.state.awaitingResume).toBe(true);
    expect(lc.state.lastError).toBe('unavailable');
  });

  it('saveNow returns the failure to the caller', async () => {
    const h = harness({ writeResult: () => ({ ok: false, reason: 'quota' }) });
    expect(await h.lc.saveNow()).toEqual({ ok: false, reason: 'quota' });
  });
});
