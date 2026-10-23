import { describe, expect, it } from 'vitest';
import { archetype, BFLAG, CATALOG, isRci, RCI_COUNT, rciFootprint, rciId } from './catalog.ts';
import { execute } from './commands.ts';
import { createSim, stateHash } from './engine.ts';
import { TERRAIN } from './layers.ts';
import { findLandWindow, runTicks } from './testkit.ts';
import type { Command, CommandBody } from './commands.ts';
import type { Sim } from './world.ts';

const cmd = (b: CommandBody, id = 1): Command => ({ ...b, id, tick: 0 }) as Command;
const lastEvent = (sim: Sim) => sim.events[sim.events.length - 1]!;

describe('RCI archetypes', () => {
  it('has 27 stable ids from 16 to 42 with footprints 1-3 and none placeable', () => {
    const rci = CATALOG.filter((a) => isRci(a.id));
    expect(rci).toHaveLength(RCI_COUNT);
    expect(rciId(1, 0, 1)).toBe(16);
    expect(rciId(3, 2, 3)).toBe(42);
    expect(new Set(rci.map((a) => a.id)).size).toBe(27);
    for (const a of rci) {
      expect(a.placeable).toBe(false);
      expect(a.w).toBe(rciFootprint(a.density!, a.level!));
      expect(a.w).toBeGreaterThanOrEqual(1);
      expect(a.w).toBeLessThanOrEqual(3);
    }
    expect(CATALOG.filter((a) => !isRci(a.id)).every((a) => a.placeable)).toBe(true);
  });

  it('rejects placeBuilding for an RCI archetype', () => {
    const sim = createSim(42, { debug: true });
    const { x, y } = findLandWindow(sim.world, 8);
    expect(execute(sim, cmd({ type: 'placeBuilding', arch: rciId(1, 0, 1), x, y, rot: 0 }))).toBe(false);
    expect(lastEvent(sim)).toMatchObject({ type: 'rejected', reason: 'not-placeable' });
  });
});

describe('debugLevel', () => {
  it('is rejected without the debug flag and levels land when it is set', () => {
    const off = createSim(42);
    const { x, y } = findLandWindow(off.world, 8);
    const before = stateHash(off);
    expect(execute(off, cmd({ type: 'debugLevel', x0: x, y0: y, x1: x + 7, y1: y + 7, margin: 4 }))).toBe(false);
    expect(lastEvent(off)).toMatchObject({ reason: 'debug-only' });
    expect(stateHash(off)).toBe(before);

    const on = createSim(42, { debug: true });
    expect(execute(on, cmd({ type: 'debugLevel', x0: x, y0: y, x1: x + 7, y1: y + 7, margin: 4 }))).toBe(true);
    const h = on.world.height[y * 256 + x]!;
    for (let yy = y; yy < y + 8; yy++) for (let xx = x; xx < x + 8; xx++) expect(on.world.height[yy * 256 + xx]).toBe(h);
    expect(on.dirty.geometry.size).toBeGreaterThan(0);
    expect(stateHash(on)).not.toBe(before);
  });
});

describe('debugGrow', () => {
  const grow = (sim: Sim, x: number, y: number, a: number, progress: number, id = 1) =>
    execute(sim, cmd({ type: 'debugGrow', x, y, archetype: a, progress }, id));

  it('is rejected without the debug flag and leaves the world hash unchanged', () => {
    const sim = createSim(42);
    const { x, y } = findLandWindow(sim.world, 8);
    const before = stateHash(sim);
    expect(grow(sim, x, y, rciId(2, 1, 2), 0.5)).toBe(false);
    expect(lastEvent(sim)).toMatchObject({ type: 'rejected', reason: 'debug-only' });
    expect(stateHash(sim)).toBe(before);
    expect(sim.world.bArch.every((v) => v === 0)).toBe(true);
  });

  it('places a building at the requested progress when the flag is set', () => {
    const sim = createSim(42, { debug: true });
    const { x, y } = findLandWindow(sim.world, 8);
    const a = archetype(rciId(2, 1, 2))!;
    expect(grow(sim, x, y, a.id, 0.5)).toBe(true);
    const slot = sim.world.bId[y * 256 + x]! - 1;
    expect(sim.world.bArch[slot]).toBe(a.id);
    expect(sim.world.bW[slot]).toBe(a.w);
    expect(sim.world.bLevel[slot]).toBe(2);
    expect(sim.world.bProg[slot]).toBe(128);
    expect(sim.world.bFlags[slot]! & BFLAG.CONSTRUCTING).toBe(BFLAG.CONSTRUCTING);
    expect(sim.dirty.buildings.has(slot)).toBe(true);

    expect(grow(sim, x + 4, y, a.id, 1, 2)).toBe(true);
    const done = sim.world.bId[y * 256 + x + 4]! - 1;
    expect(sim.world.bProg[done]).toBe(255);
    expect(sim.world.bFlags[done]).toBe(0);
  });

  it('rejects overlap, water, bad progress and out-of-bounds even with the flag', () => {
    const sim = createSim(42, { debug: true });
    const { x, y } = findLandWindow(sim.world, 8);
    const a = rciId(3, 2, 3);
    expect(grow(sim, x, y, a, 1)).toBe(true);
    expect(grow(sim, x + 1, y + 1, a, 1, 2)).toBe(false);
    expect(lastEvent(sim)).toMatchObject({ reason: 'blocked' });
    expect(grow(sim, x + 5, y, a, 1.5, 3)).toBe(false);
    expect(lastEvent(sim)).toMatchObject({ reason: 'invalid' });
    expect(grow(sim, 255, 255, a, 1, 4)).toBe(false);
    expect(lastEvent(sim)).toMatchObject({ reason: 'bounds' });
    expect(grow(sim, x, y, 99, 1, 5)).toBe(false);
    expect(lastEvent(sim)).toMatchObject({ reason: 'unknown-archetype' });
    const water = sim.world.terrain.findIndex((t) => t === TERRAIN.WATER);
    expect(grow(sim, water % 256, (water / 256) | 0, a, 1, 6)).toBe(false);
  });

  it('stays deterministic through the tick queue', () => {
    const run = (): number => {
      const sim = createSim(42, { debug: true });
      const { x, y } = findLandWindow(sim.world, 8);
      sim.queue.push(cmd({ type: 'debugGrow', x, y, archetype: rciId(1, 2, 3), progress: 0.3 }));
      runTicks(sim, 50);
      return stateHash(sim);
    };
    expect(run()).toBe(run());
  });
});

describe('debugLevel and roads', () => {
  it('recomputes road slope flags and dirties buildings after levelling', () => {
    const sim = createSim(42, { debug: true });
    const { x, y } = findLandWindow(sim.world, 16);
    execute(sim, cmd({ type: 'placeRoad', ax: x, ay: y + 4, bx: x + 12, by: y + 4, cls: 1 }, 1));
    execute(sim, cmd({ type: 'debugGrow', x: x + 2, y: y + 6, archetype: rciId(1, 0, 1), progress: 1 }, 2));
    const i = (y + 4) * 256 + x + 6;
    sim.world.height[i] = sim.world.height[i]! + 64;
    sim.dirty.buildings.clear();
    expect(execute(sim, cmd({ type: 'debugLevel', x0: x, y0: y, x1: x + 12, y1: y + 12, margin: 2 }, 3))).toBe(true);
    expect(sim.world.road[i]! & 0x100).toBe(0);
    expect(sim.dirty.buildings.size).toBe(1);
  });
});
