import { describe, expect, it } from 'vitest';
import type { RigState } from './camera.ts';
import { celebrate, type CelebrateDeps } from './celebrate.ts';
import { CinematicPlayer, SWOOP_SECONDS, swoop, type MegaTarget } from './cinematic.ts';
import { RenderMirror, type CelebrationEvent } from './mirror.ts';
import { startCameraFor, START_DIST } from './startCamera.ts';
import { AgentStore } from './agentStore.ts';
import { tileReadOf } from '../sim/estimate.ts';
import { createSim } from '../sim/engine.ts';

interface Emit { kind: string; x: number; z: number; count: number }
function deps(withSwoop = true): { d: CelebrateDeps; emits: Emit[]; swoops: MegaTarget[] } {
  const emits: Emit[] = [], swoops: MegaTarget[] = [];
  const d: CelebrateDeps = {
    emit: (kind, x, _y, z, count) => { emits.push({ kind, x, z, count }); },
    ground: () => 2,
    focus: () => ({ x: 128, z: 128, dist: 50 }),
    finishedHeight: () => 6,
    startCinematic: () => {},
  };
  if (withSwoop) d.swoop = (t) => { swoops.push(t); };
  return { d, emits, swoops };
}
const ev = (e: Record<string, unknown>): CelebrationEvent => ({ tick: 1, ...e }) as unknown as CelebrationEvent;
const total = (l: Emit[]): number => l.reduce((n, e) => n + e.count, 0);

describe('directive and first-building celebrations', () => {
  it('a met directive throws a small confetti burst, a paid one a few sparks, and neither moves the camera', () => {
    const ready = deps(), paid = deps();
    celebrate([ev({ type: 'directiveReady', index: 0 })], ready.d);
    celebrate([ev({ type: 'directiveClaimed', index: 0, reward: 300 })], paid.d);
    expect(ready.emits.every((e) => e.kind === 'confetti')).toBe(true);
    expect(paid.emits.every((e) => e.kind === 'spark')).toBe(true);
    expect(total(ready.emits)).toBeGreaterThan(0);
    expect(total(ready.emits)).toBeLessThanOrEqual(120);
    expect(total(paid.emits)).toBeLessThanOrEqual(60);
    expect(ready.swoops).toEqual([]);
    expect(paid.swoops).toEqual([]);
  });

  it('the first finished building bursts at its footprint and asks for one swoop to its centre', () => {
    const { d, emits, swoops } = deps();
    celebrate([ev({ type: 'firstBuilding', x: 100, y: 60, w: 2, h: 2 })], d);
    expect(swoops).toEqual([{ x: 101, z: 61, ground: 2, height: 2, size: 2 }]);
    expect(emits.some((e) => e.kind === 'confetti' && e.x === 101 && e.z === 61)).toBe(true);
    expect(emits.some((e) => e.kind === 'spark')).toBe(true);
  });

  it('the swoop is optional: a view without one still gets the burst', () => {
    const { d, emits } = deps(false);
    celebrate([ev({ type: 'firstBuilding', x: 100, y: 60, w: 1, h: 1 })], d);
    expect(total(emits)).toBeGreaterThan(0);
  });

  it('keeps the whole burst cheap', () => {
    const { d, emits } = deps();
    celebrate([ev({ type: 'firstBuilding', x: 100, y: 60, w: 3, h: 3 })], d);
    expect(total(emits)).toBeLessThan(400);
  });

  it('queues the new sim events in the mirror for the renderer, once each, in order', () => {
    const m = new RenderMirror();
    m.apply({ type: 'events', tick: 5, events: [
      { type: 'directiveReady', tick: 5, index: 2 }, { type: 'accepted', cmd: 1, tick: 5 },
      { type: 'directiveClaimed', tick: 5, index: 2, reward: 500 }, { type: 'firstBuilding', tick: 5, x: 1, y: 2, w: 1, h: 1 },
    ] });
    expect(m.takeCelebrations().map((e) => e.type)).toEqual(['directiveReady', 'directiveClaimed', 'firstBuilding']);
    expect(m.takeCelebrations()).toEqual([]);
  });
});

describe('swoop camera', () => {
  const from: RigState = { x: 120, z: 120, yaw: 0.6, pitch: 0.9, dist: 52, ty: 3 };
  const target: MegaTarget = { x: 130, z: 125, ground: 3, height: 2, size: 2 };

  it('leaves from the camera, ends back on it, and takes a few seconds', () => {
    const p = swoop(from, target);
    expect(p.duration).toBeCloseTo(SWOOP_SECONDS, 5);
    expect(p.at(0)).toEqual(from);
    const end = p.at(p.duration);
    for (const k of ['x', 'z', 'pitch', 'dist', 'ty'] as const) expect(end[k], k).toBeCloseTo(from[k], 6);
  });

  it('gets close to the footprint in the middle and stays finite throughout', () => {
    const p = swoop(from, target);
    const mid = p.at(1.4);
    expect(Math.hypot(mid.x - target.x, mid.z - target.z)).toBeLessThan(1e-6);
    expect(mid.dist).toBeLessThan(from.dist / 2);
    for (let t = 0; t <= p.duration; t += 0.1) for (const v of Object.values(p.at(t))) expect(Number.isFinite(v)).toBe(true);
  });

  it('can be skipped, which ends it where it is', () => {
    const player = new CinematicPlayer();
    let ended: boolean | null = null;
    player.play(swoop(from, target), (c) => { ended = c; });
    player.step(0.5);
    player.skip();
    expect(ended).toBe(false);
    expect(player.active).toBe(false);
  });
});

describe('start camera and the idle crew', () => {
  it('frames the starter depot when there is one, and the flat site otherwise', () => {
    const sim = createSim(42, { starter: true });
    const read = tileReadOf(sim.world as unknown as Record<string, ArrayLike<number>>);
    const s = sim.world.bArch.indexOf(1);
    const depot = { x: sim.world.bX[s]! + 1, y: sim.world.bY[s]! + 1 };
    expect(startCameraFor(read, depot)).toMatchObject({ x: depot.x, z: depot.y, dist: START_DIST });
    expect(startCameraFor(read, null)).toEqual(startCameraFor(read));
  });

  it('does not offer an idle robot to "follow a robot"', () => {
    const store = new AgentStore();
    const pos = new Float32Array([1, 1, 0, 2, 2, 0]);
    const ids = new Uint32Array([1, 1 | (0 << 8), 2, 2 | (1 << 8)]);
    store.ingest({ tick: 1, count: 2, pos, ids }, 0);
    expect(store.activeKeys()).toEqual([2]);
  });
});
