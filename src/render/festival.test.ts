import { describe, expect, it } from 'vitest';
import { MAP, ROAD } from '../sim/layers.ts';
import { celebrate, type CelebrateDeps } from './celebrate.ts';
import { FESTIVAL_IDS, FestivalFx, PARADE_BOTS, SHOW_SECONDS, alongPath, hash01, nearestRoadTile, paradePath, type ParadePose } from './festival.ts';
import type { CelebrationEvent } from './mirror.ts';

/** A road layer with an east-west street along y = 20 from x = 10 to x = 50. */
function street(): Uint16Array {
  const road = new Uint16Array(MAP * MAP);
  for (let x = 10; x <= 50; x++) road[20 * MAP + x] = 1 | (x > 10 ? ROAD.W : 0) | (x < 50 ? ROAD.E : 0);
  return road;
}

interface Emit { kind: string; x: number; y: number; z: number; count: number }
function deps(road: ArrayLike<number> = street()) {
  const emits: Emit[] = [];
  return { emits, d: { emit: (kind: string, x: number, y: number, z: number, count: number) => { emits.push({ kind, x, y, z, count }); }, ground: () => 1, road: () => road } };
}

describe('parade path', () => {
  it('finds the nearest road tile and walks the street', () => {
    const road = street();
    expect(nearestRoadTile(road, 30, 24)).toBe(20 * MAP + 30);
    expect(nearestRoadTile(new Uint16Array(MAP * MAP), 30, 24)).toBe(-1);
    const path = paradePath(road, 30, 22);
    expect(path.length / 2).toBeGreaterThanOrEqual(20);
    for (let i = 0; i < path.length; i += 2) expect(path[i + 1]).toBe(20.5);
    expect(new Set(path.filter((_, i) => i % 2 === 0)).size).toBe(path.length / 2);
    expect(paradePath(new Uint16Array(MAP * MAP), 30, 22)).toEqual([]);
  });

  it('walks to the end of the path and back, facing the way it goes', () => {
    const path = [0.5, 0.5, 1.5, 0.5, 2.5, 0.5];
    const o = { x: 0, z: 0, yaw: 0 };
    alongPath(path, 0, o); expect(o.x).toBeCloseTo(0.5);
    alongPath(path, 1.5, o); expect(o.x).toBeCloseTo(2);
    expect(o.yaw).toBeCloseTo(Math.PI / 2);
    alongPath(path, 2, o); expect(o.x).toBeCloseTo(2.5);
    alongPath(path, 3, o); expect(o.x).toBeCloseTo(1.5);
    alongPath(path, 3.5, o); expect(o.x).toBeCloseTo(1);
    expect(o.yaw).toBeCloseTo(-Math.PI / 2);
    alongPath(path, 4, o); expect(o.x).toBeCloseTo(0.5);
    alongPath(path, -1, o); expect(o.x).toBeCloseTo(1.5);
  });

  it('has a hash that is stable and spread over 0..1', () => {
    expect(hash01(3, 4)).toBe(hash01(3, 4));
    const v = Array.from({ length: 50 }, (_, i) => hash01(i, 1));
    expect(Math.min(...v)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...v)).toBeLessThan(1);
    expect(new Set(v).size).toBeGreaterThan(40);
  });
});

describe('festival show', () => {
  it('marches PARADE_BOTS robots along the road while the parade runs, and none otherwise', () => {
    const { d } = deps();
    const fx = new FestivalFx(d);
    const out: ParadePose[] = [];
    expect(fx.parade(out)).toBe(0);
    fx.start({ festival: FESTIVAL_IDS.ROBOT_PARADE, x: 30, y: 22, ticks: 1800 });
    fx.step(0.1);
    expect(fx.parade(out)).toBe(PARADE_BOTS);
    for (const p of out.slice(0, PARADE_BOTS)) { expect(p.z).toBeCloseTo(20.5); expect(p.x).toBeGreaterThanOrEqual(10); expect(p.x).toBeLessThanOrEqual(51); }
    const x0 = out[0]!.x;
    for (let i = 0; i < 10; i++) fx.step(0.1);
    fx.parade(out);
    expect(out[0]!.x).not.toBe(x0);
    expect(out.slice(0, PARADE_BOTS).some((p) => p.hauler)).toBe(true);
    fx.stop();
    expect(fx.parade(out)).toBe(0);

    fx.start({ festival: FESTIVAL_IDS.BLOCK_PARTY, x: 30, y: 22, ticks: 1200 });
    expect(fx.parade(out)).toBe(0);
  });

  it('sends up fireworks on a schedule: sparks high above the shops, same shells every time', () => {
    const run = (): Emit[] => {
      const { d, emits } = deps();
      const fx = new FestivalFx(d);
      fx.start({ festival: FESTIVAL_IDS.FIREWORKS, x: 30, y: 20, ticks: 1500 });
      for (let i = 0; i < 40; i++) fx.step(0.1);
      return emits;
    };
    const a = run(), b = run();
    expect(a).toEqual(b);
    const sparks = a.filter((e) => e.kind === 'spark');
    expect(sparks.length).toBeGreaterThanOrEqual(5);
    for (const s of sparks) { expect(s.y).toBeGreaterThan(7); expect(Math.hypot(s.x - 30.5, s.z - 20.5)).toBeLessThanOrEqual(13); }
  });

  it('rains confetti at a block party and stops by itself after the show length', () => {
    const { d, emits } = deps();
    const fx = new FestivalFx(d);
    fx.start({ festival: FESTIVAL_IDS.BLOCK_PARTY, x: 30, y: 20, ticks: 1200 });
    for (let i = 0; i < 20; i++) fx.step(0.1);
    expect(emits.length).toBeGreaterThan(5);
    expect(emits.every((e) => e.kind === 'confetti')).toBe(true);
    expect(fx.active).toBe(true);
    for (let i = 0; i < SHOW_SECONDS * 10 + 30; i++) fx.step(0.1);
    expect(fx.active).toBe(false);
  });
});

describe('festival events', () => {
  const ev = (e: Record<string, unknown>): CelebrationEvent => ({ tick: 1, ...e }) as unknown as CelebrationEvent;

  it('a start event throws confetti and starts the show; the end event stops it', () => {
    const emits: Emit[] = [], shows: unknown[] = [];
    let stopped = 0;
    const d: CelebrateDeps = {
      emit: (kind, x, y, z, count) => { emits.push({ kind, x, y, z, count }); }, ground: () => 2, focus: () => ({ x: 0, z: 0, dist: 40 }), finishedHeight: () => 1, startCinematic: () => {},
      festival: { start: (s) => { shows.push(s); }, stop: () => { stopped++; } },
    };
    celebrate([ev({ type: 'festival', phase: 'start', festival: 2, x: 60, y: 70, ticks: 1500 })], d);
    expect(shows).toEqual([{ festival: 2, x: 60, y: 70, ticks: 1500 }]);
    expect(emits.some((e) => e.kind === 'confetti')).toBe(true);
    expect(emits.reduce((n, e) => n + e.count, 0)).toBeLessThanOrEqual(300);
    celebrate([ev({ type: 'festival', phase: 'end', festival: 2, x: 60, y: 70, ticks: 0 })], d);
    expect(stopped).toBe(1);
  });

  it('is harmless without a show handler', () => {
    const d: CelebrateDeps = { emit: () => {}, ground: () => 0, focus: () => ({ x: 0, z: 0, dist: 40 }), finishedHeight: () => 1, startCinematic: () => {} };
    expect(() => celebrate([ev({ type: 'festival', phase: 'start', festival: 0, x: 1, y: 1, ticks: 1 })], d)).not.toThrow();
  });
});
