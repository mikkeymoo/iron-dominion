import { afterEach, describe, expect, it, vi } from 'vitest';
import { BFLAG } from '../catalog.ts';
import { createSim, step } from '../engine.ts';
import { S } from '../layers.ts';
import { runTicks } from '../testkit.ts';
import { AKIND, BUILDER_COST, BUILDERS_PER_DEPOT, HAULER_COST, HAULERS_PER_DEPOT } from './index.ts';
import { agents, depot, finished, flatSim, grown, road, runUntil, tickOf, town, zone } from './testkit.ts';

vi.setConfig({ testTimeout: 120000 });
afterEach(() => new Promise<void>((r) => { setTimeout(r, 0); }));

describe('growth by robots', () => {
  it('starts a new city at 07:00', () => {
    const sim = createSim(1);
    expect(sim.world.scalars[S.dayFrac]).toBe(0.3);
    expect(sim.world.scalars[S.tickOfDay]).toBe(1440);
  });

  it('builds a zoned, road-connected lot from a foundation to a finished building', () => {
    const sim = town();
    const flags = new Set<number>();
    const progress: number[] = [];
    let slot = -1;
    for (let t = 0; t < 6000 && finished(sim).length === 0; t++) {
      step(sim);
      for (const s of grown(sim)) {
        if (slot < 0) slot = s;
        if (s !== slot) continue;
        flags.add(sim.world.bFlags[s]!);
        if ((sim.world.bFlags[s]! & BFLAG.CONSTRUCTING) !== 0) progress.push(sim.world.bProg[s]!);
      }
    }
    expect(finished(sim).length).toBeGreaterThan(0);
    expect(flags.has(BFLAG.CONSTRUCTING)).toBe(true);
    expect(progress.length).toBeGreaterThan(20);
    expect(progress[0]).toBeLessThan(10);
    for (let k = 1; k < progress.length; k++) expect(progress[k]!).toBeGreaterThanOrEqual(progress[k - 1]!);
    expect(sim.world.bProg[finished(sim)[0]!]).toBe(255);
    expect(agents(sim, AKIND.BUILDER).length).toBeGreaterThan(0);
    expect(agents(sim, AKIND.HAULER).length).toBeGreaterThan(0);
    console.log(`robots: first building finished at tick ${tickOf(sim)} (${(tickOf(sim) / 10).toFixed(0)} s at 1x)`);
  });

  it('never grows without a depot, even with a road, a zone and demand', () => {
    const sim = flatSim();
    road(sim, 96, 104, 130, 104);
    zone(sim, 100, 105, 120, 108);
    runTicks(sim, 1500);
    expect(grown(sim)).toHaveLength(0);
    expect(agents(sim)).toHaveLength(0);
  });

  it('never builds a lot whose road is not connected to a depot', () => {
    const sim = flatSim();
    road(sim, 96, 104, 110, 104);
    depot(sim, 98, 102);
    road(sim, 96, 150, 130, 150);
    zone(sim, 100, 151, 120, 154);
    runTicks(sim, 3000);
    expect(grown(sim)).toHaveLength(0);
    expect(agents(sim).length).toBeGreaterThan(0);
  });

  it('spawns at most the per-depot robot counts and charges the treasury', () => {
    const sim = town();
    const before = sim.world.scalars[S.treasury]!;
    runTicks(sim, 400);
    expect(agents(sim, AKIND.BUILDER)).toHaveLength(BUILDERS_PER_DEPOT);
    expect(agents(sim, AKIND.HAULER)).toHaveLength(HAULERS_PER_DEPOT);
    // Robot costs accrue and are paid with the month's budget, so the treasury itself has not moved yet.
    expect(sim.world.scalars[S.treasury]!).toBe(before);
    expect(sim.world.spend[2]).toBe(BUILDERS_PER_DEPOT * BUILDER_COST + HAULERS_PER_DEPOT * HAULER_COST);
  });

  it('completes several buildings and keeps starting new ones while demand holds', () => {
    const sim = town();
    expect(runUntil(sim, () => finished(sim).length >= 4, 12000)).toBe(true);
  });
});
