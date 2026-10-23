import { describe, expect, it } from 'vitest';
import { createLifecycle, type LifecycleDeps, type WriteOutcome } from './lifecycle.ts';

function make(over: Partial<LifecycleDeps> = {}) {
  let clock = 0;
  let slot = true;
  let snapshots = 0;
  const writes: { data: Uint8Array; opt: unknown }[] = [];
  const deps: LifecycleDeps = {
    now: () => clock,
    pauseSim: () => undefined,
    resumeSim: () => undefined,
    setSimSpeed: () => undefined,
    requestSnapshot: async () => { snapshots++; return new Uint8Array([snapshots]); },
    hasSlot: () => slot,
    write: async (data, _why, opt) => { writes.push({ data, opt }); return { ok: true }; },
    ...over,
  };
  const lc = createLifecycle(deps, { autosaveMs: 60_000 });
  const advance = (ms: number): void => { for (let i = 0; i < ms / 1000; i++) { clock += 1000; lc.tick(); } };
  return { lc, writes, advance, setSlot: (v: boolean) => { slot = v; }, snapshots: () => snapshots };
}

const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('single write queue', () => {
  it('skips snapshot requests for an unsaved session on autosave and hide', async () => {
    const h = make();
    h.setSlot(false);
    h.lc.cacheSnapshot(new Uint8Array([1]));
    h.advance(60_000);
    h.lc.hide();
    await flush();
    expect(h.snapshots()).toBe(0);
    expect(h.writes).toHaveLength(0);
  });

  it('still saves an unsaved session on a manual save, which may create the slot', async () => {
    const h = make();
    h.setSlot(false);
    expect(await h.lc.saveNow()).toMatchObject({ ok: true });
    expect(h.snapshots()).toBe(1);
    expect(h.writes).toHaveLength(1);
  });

  it('runs overlapping saves one at a time, in request order, and stays busy until the last finishes', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let n = 0;
    const h = make({
      requestSnapshot: async () => { order.push(`snap${++n}`); return new Uint8Array([n]); },
      write: async (d) => { order.push(`write${d[0]}`); if (d[0] === 1) await gate; return { ok: true }; },
    });
    const a = h.lc.saveNow('manual');
    const b = h.lc.saveNow('manual', 'Copy');
    await Promise.resolve();
    expect(h.lc.state.saving).toBe(true);
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(['snap1', 'write1', 'snap2', 'write2']);
    expect(h.lc.state.saving).toBe(false);
  });

  it('passes the Save as name to the writer', async () => {
    const h = make();
    await h.lc.saveNow('manual', 'Copy');
    expect(h.writes[0]!.opt).toEqual({ asName: 'Copy', create: true });
  });

  it('a successful manual save clears the error and restarts the autosave clock', async () => {
    let fail = true;
    const h = make({ write: async (): Promise<WriteOutcome> => (fail ? { ok: false, reason: 'quota' } : { ok: true }) });
    h.advance(40_000);
    expect(await h.lc.saveNow()).toMatchObject({ ok: false });
    expect(h.lc.state.lastError).toBe('quota');
    fail = false;
    await h.lc.saveNow();
    expect(h.lc.state.lastError).toBeNull();
    expect(h.lc.state.activeMs).toBe(0);
  });

  it('runs the sim at max when initialSpeed is max', () => {
    const calls: string[] = [];
    const lc = createLifecycle({
      now: () => 0, pauseSim: () => undefined, resumeSim: () => calls.push('resume'), setSimSpeed: (s) => calls.push(`speed:${s}`),
      requestSnapshot: async () => new Uint8Array(1), hasSlot: () => false, write: async () => ({ ok: true }),
    }, { initialSpeed: 'max' });
    expect(lc.state.speed).toBe('max');
    lc.hide();
    lc.show();
    lc.resume();
    expect(calls).toEqual(['speed:max', 'resume']);
  });
});
