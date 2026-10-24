import { describe, expect, it, vi } from 'vitest';
import { HAZ } from '../sim/layers.ts';
import type { CouncilRequestStat, Speed } from '../sim/protocol.ts';
import type { SimEvent } from '../sim/world.ts';
import { APPROVAL_REARM, EXPIRY_WARN_TICKS, NOTICE_MS, PacingStore, crisisOf, safeStopOf } from './pacing.ts';

function harness(opt: { speed?: Speed; enabled?: boolean } = {}) {
  const state = { speed: opt.speed ?? 'max' as Speed, enabled: opt.enabled ?? true };
  const timers: { fn: () => void; ms: number; id: number; live: boolean }[] = [];
  const deps = {
    speed: () => state.speed,
    pause: vi.fn(() => { state.speed = 0; }),
    enabled: () => state.enabled,
    safeStop: vi.fn(),
    timer: {
      set: (fn: () => void, ms: number) => { const t = { fn, ms, id: timers.length, live: true }; timers.push(t); return t.id; },
      clear: (id: unknown) => { const t = timers[id as number]; if (t) t.live = false; },
    },
  };
  const store = new PacingStore(deps);
  return { store, deps, state, timers };
}

const done = (tick = 1): SimEvent[] => [{ type: 'directiveReady', tick, index: 2 }];
const storm = (): SimEvent => ({ type: 'hazardStart', tick: 5, kind: HAZ.STORM, level: 1, prepared: false, applicable: true, coverage: 0, bonus: 0 });
const request = (over: Partial<CouncilRequestStat> = {}): CouncilRequestStat => ({
  slot: 0, id: 7, kind: 3, group: 1, state: 'accepted', text: 'More shops', x: 4, y: 5, have: 1, need: 5, progress: '1 of 5', done: false, ticksLeft: 4000, cash: 800, approval: 5, rp: 2, penalty: 3, overlay: 'none', ...over,
});

describe('safe stopping points', () => {
  it('a finished directive, megaproject stage, finished megaproject or council request shows "Good place to save" and asks for an autosave', () => {
    const events: SimEvent[][] = [
      done(),
      [{ type: 'megaStage', tick: 1, arch: 1, slot: 1, stage: 0, stages: 3, x: 1, y: 1, w: 1, h: 1 }],
      [{ type: 'megaComplete', tick: 1, arch: 1, slot: 1, x: 1, y: 1, w: 1, h: 1 }],
      [{ type: 'council', tick: 1, phase: 'completed', id: 1, kind: 1, group: 0, x: 0, y: 0, cash: 1, approval: 1, rp: 1 }],
    ];
    for (const batch of events) {
      const h = harness();
      h.store.events(batch);
      expect(h.store.notice).toMatchObject({ kind: 'safe', text: 'Good place to save' });
      expect(h.store.notice?.detail).toBeTruthy();
      expect(h.deps.safeStop).toHaveBeenCalledTimes(1);
      expect(h.deps.pause).not.toHaveBeenCalled();
    }
  });

  it('other events, and a request that is posted, declined, failed or expired, are not safe stops', () => {
    const h = harness();
    const quiet: SimEvent[] = [
      { type: 'milestone', tick: 1, tier: 1, bonus: 0 }, { type: 'directiveClaimed', tick: 1, index: 0, reward: 100 }, { type: 'weather', tick: 1, weather: 1 },
      ...(['posted', 'accepted', 'declined', 'expired', 'failed'] as const).map((phase): SimEvent => ({ type: 'council', tick: 1, phase, id: 1, kind: 1, group: 0, x: 0, y: 0, cash: 0, approval: 0, rp: 0 })),
    ];
    h.store.events(quiet);
    expect(h.store.notice).toBeNull();
    expect(h.deps.safeStop).not.toHaveBeenCalled();
    expect(quiet.map(safeStopOf).filter(Boolean)).toEqual([]);
  });

  it('the toast dismisses itself after NOTICE_MS and on demand, and a newer one replaces an older one', () => {
    const h = harness();
    h.store.events(done());
    const first = h.store.notice!.id;
    expect(h.timers.at(-1)!.ms).toBe(NOTICE_MS);
    h.store.events(done(2));
    expect(h.store.notice!.id).not.toBe(first);
    expect(h.timers[0]!.live).toBe(false);
    h.timers.at(-1)!.fn();
    expect(h.store.notice).toBeNull();
    h.store.events(done(3));
    h.store.dismiss();
    expect(h.store.notice).toBeNull();
  });

  it('notifies subscribers', () => {
    const h = harness();
    const seen: (string | undefined)[] = [];
    h.store.subscribe(() => seen.push(h.store.notice?.kind));
    h.store.events(done());
    h.store.dismiss();
    expect(seen).toEqual(['safe', undefined]);
  });
});

describe('crisis auto-pause', () => {
  it('pauses a fast game when a hazard starts, and says why', () => {
    const h = harness({ speed: 'max' });
    h.store.events([storm()]);
    expect(h.deps.pause).toHaveBeenCalledTimes(1);
    expect(h.state.speed).toBe(0);
    expect(h.store.notice).toMatchObject({ kind: 'crisis', detail: 'Storm season has begun' });
    expect(h.store.notice!.text).toMatch(/^Paused/);
    expect(h.deps.safeStop).not.toHaveBeenCalled();
  });

  it('does nothing with the setting off, even at max speed', () => {
    const h = harness({ speed: 'max', enabled: false });
    h.store.events([storm()]);
    h.store.council({ approval: 10, requests: [request({ ticksLeft: 10 })] });
    h.store.council({ approval: 5, requests: [] });
    expect(h.deps.pause).not.toHaveBeenCalled();
    expect(h.store.notice).toBeNull();
  });

  it('reads the setting at the moment of the crisis', () => {
    const h = harness({ speed: 4, enabled: false });
    h.store.events([storm()]);
    expect(h.deps.pause).not.toHaveBeenCalled();
    h.state.enabled = true;
    h.store.events([storm()]);
    expect(h.deps.pause).toHaveBeenCalledTimes(1);
  });

  it('only pauses at 4x and Max: at 1x, 2x or when already paused the player can react', () => {
    for (const speed of [0, 1, 2] as Speed[]) {
      const h = harness({ speed });
      h.store.events([storm()]);
      expect(h.deps.pause).not.toHaveBeenCalled();
      expect(h.store.notice).toBeNull();
    }
    const h4 = harness({ speed: 4 });
    h4.store.events([storm()]);
    expect(h4.deps.pause).toHaveBeenCalledTimes(1);
  });

  it('counts a fire, a quake landing and a meteor first seen, but not a meteor impact or a quake warning', () => {
    const ev = (kind: 'fire' | 'quake' | 'meteor', phase: 'start' | 'impact'): SimEvent => ({ type: 'disaster', tick: 1, kind, phase, x: 1, y: 2, radius: 3, arch: 0, impactTick: 9 });
    expect(crisisOf(ev('fire', 'start'))).toMatch(/fire/);
    expect(crisisOf(ev('fire', 'impact'))).toBeNull();
    expect(crisisOf(ev('quake', 'impact'))).toMatch(/earthquake/i);
    expect(crisisOf(ev('quake', 'start'))).toBeNull();
    expect(crisisOf(ev('meteor', 'start'))).toMatch(/meteor/i);
    expect(crisisOf(ev('meteor', 'impact'))).toBeNull();
    expect(crisisOf({ type: 'forecast', tick: 1, kind: HAZ.STORM, startTick: 99, level: 1 })).toBeNull();
  });

  it('a crisis outranks a safe stop in the same batch, but a crisis that could not pause leaves the safe stop', () => {
    const a = harness({ speed: 'max' });
    a.store.events([...done(), storm()]);
    expect(a.store.notice?.kind).toBe('crisis');
    expect(a.deps.safeStop).not.toHaveBeenCalled();
    const b = harness({ speed: 1 });
    b.store.events([...done(), storm()]);
    expect(b.store.notice?.kind).toBe('safe');
    expect(b.deps.safeStop).toHaveBeenCalledTimes(1);
  });

  it('pauses once for a council request about to expire, not again for the same request', () => {
    const h = harness({ speed: 'max' });
    h.store.council({ approval: 50, requests: [request({ ticksLeft: EXPIRY_WARN_TICKS + 1 })] });
    expect(h.deps.pause).not.toHaveBeenCalled();
    h.store.council({ approval: 50, requests: [request({ ticksLeft: EXPIRY_WARN_TICKS })] });
    expect(h.deps.pause).toHaveBeenCalledTimes(1);
    expect(h.store.notice?.detail).toMatch(/Merchants' request is about to expire/);
    h.state.speed = 'max';
    h.store.council({ approval: 50, requests: [request({ ticksLeft: 100 })] });
    expect(h.deps.pause).toHaveBeenCalledTimes(1);
    h.store.council({ approval: 50, requests: [request({ id: 8, ticksLeft: 100 })] });
    expect(h.deps.pause).toHaveBeenCalledTimes(2);
  });

  it('ignores a request that is already met or already out of time', () => {
    const h = harness({ speed: 'max' });
    h.store.council({ approval: 50, requests: [request({ done: true, ticksLeft: 50 }), request({ id: 9, ticksLeft: 0 })] });
    expect(h.deps.pause).not.toHaveBeenCalled();
  });

  it('pauses when approval falls under 15, once, and again only after it recovers to the re-arm level', () => {
    const h = harness({ speed: 'max' });
    h.store.council({ approval: 40, requests: [] });
    h.store.council({ approval: 16, requests: [] });
    expect(h.deps.pause).not.toHaveBeenCalled();
    h.store.council({ approval: 14, requests: [] });
    expect(h.deps.pause).toHaveBeenCalledTimes(1);
    expect(h.store.notice?.detail).toBe('Approval fell to 14%');
    h.state.speed = 'max';
    h.store.council({ approval: 12, requests: [] });
    h.store.council({ approval: APPROVAL_REARM - 1, requests: [] });
    h.store.council({ approval: 13, requests: [] });
    expect(h.deps.pause).toHaveBeenCalledTimes(1);
    h.store.council({ approval: APPROVAL_REARM, requests: [] });
    h.store.council({ approval: 9, requests: [] });
    expect(h.deps.pause).toHaveBeenCalledTimes(2);
  });

  it('does not pause for a city that loads already under 15', () => {
    const h = harness({ speed: 'max' });
    h.store.council({ approval: 8, requests: [] });
    h.store.council({ approval: 7, requests: [] });
    expect(h.deps.pause).not.toHaveBeenCalled();
  });

  it('ignores a missing council block', () => {
    const h = harness();
    h.store.council(undefined);
    expect(h.store.notice).toBeNull();
  });

  it('dispose clears the timer and the listeners', () => {
    const h = harness();
    const fn = vi.fn();
    h.store.subscribe(fn);
    h.store.events(done());
    fn.mockClear();
    h.store.dispose();
    expect(h.timers.at(-1)!.live).toBe(false);
    h.store.dismiss();
    expect(fn).not.toHaveBeenCalled();
  });
});
