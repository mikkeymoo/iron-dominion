import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARCH, BFLAG, rciId } from '../catalog.ts';
import { step } from '../engine.ts';
import { MODULE, MODULES, MODULE_REFUND } from '../firmware.ts';
import { MAP, S, TERRAIN } from '../layers.ts';
import { AKIND, AST } from '../robots/constants.ts';
import { agents, depot, flatSim, road, run } from '../robots/testkit.ts';
import type { Sim } from '../world.ts';
import { DMODE, REBUILD_DISCOUNT_PCT, destroyBuilding, discounted, rebuildPrice, rebuildQuote, withFloor } from './index.ts';

vi.setConfig({ testTimeout: 180000 });
afterEach(() => new Promise<void>((r) => { setTimeout(r, 0); }));

const R1 = rciId(1, 0, 1);
const slotAt = (sim: Sim, x: number, y: number): number => sim.world.bId[y * MAP + x]! - 1;

/** A street with a depot and three houses and a fire station on the south side, then all four destroyed (plus a fourth house). */
function ruinedTown(): { sim: Sim; houses: number[]; station: number } {
  const sim = flatSim(42, true);
  road(sim, 96, 104, 130, 104);
  depot(sim, 98, 102);
  const houses = [[102, 105], [105, 105], [108, 105], [111, 105]].map(([x, y]) => {
    expect(run(sim, { type: 'debugGrow', x: x!, y: y!, archetype: R1, progress: 1 })).toBe(true);
    return slotAt(sim, x!, y!);
  });
  expect(run(sim, { type: 'debugGrow', x: 114, y: 105, archetype: ARCH.FIRE_STATION, progress: 1 })).toBe(true);
  const station = slotAt(sim, 114, 105);
  for (const s of [...houses, station]) destroyBuilding(sim, s);
  return { sim, houses, station };
}

describe('Rebuild all', () => {
  it('prices a ruin at 75% of the full price', () => {
    expect(REBUILD_DISCOUNT_PCT).toBe(25);
    expect(rebuildPrice(R1)).toBe(150);
    expect(discounted(150)).toBe(113);
    expect(rebuildPrice(ARCH.FIRE_STATION)).toBe(1200);
    expect(discounted(1200)).toBe(900);
  });

  it('queues every ruin and charges the discounted total once', () => {
    const { sim, houses, station } = ruinedTown();
    const w = sim.world;
    const q = rebuildQuote(w);
    expect(q).toEqual({ ruins: 5, queued: 0, cost: 4 * 113 + 900 });
    const before = w.scalars[S.treasury]!;
    sim.events = [];
    expect(run(sim, { type: 'rebuildAll' })).toBe(true);
    expect(before - w.scalars[S.treasury]!).toBe(q.cost);
    expect(sim.events.find((e) => e.type === 'rebuildAll')).toMatchObject({ count: 5, cost: q.cost });
    for (const s of [...houses, station]) expect(w.bFlags[s]! & BFLAG.REBUILD).toBe(BFLAG.REBUILD);
    expect(rebuildQuote(w)).toEqual({ ruins: 0, queued: 5, cost: 0 });
    expect(run(sim, { type: 'rebuildAll' }), 'nothing new to queue').toBe(false);
    expect(w.scalars[S.treasury]).toBe(before - q.cost);
  });

  it('refuses when the treasury cannot pay, and changes nothing', () => {
    const { sim, houses } = ruinedTown();
    const w = sim.world;
    w.scalars[S.treasury] = 100;
    sim.events = [];
    expect(run(sim, { type: 'rebuildAll' })).toBe(false);
    expect(sim.events.some((e) => e.type === 'rejected' && e.reason === 'funds')).toBe(true);
    expect(w.scalars[S.treasury]).toBe(100);
    expect(w.bFlags[houses[0]!]! & BFLAG.REBUILD).toBe(0);
  });

  it('refuses when there are no ruins', () => {
    const sim = flatSim(42, true);
    sim.events = [];
    expect(run(sim, { type: 'rebuildAll' })).toBe(false);
    expect(sim.events.some((e) => e.type === 'rejected' && e.reason === 'noop')).toBe(true);
  });

  it('has the robots clear each ruin in the open and raise the building again; an unordered ruin is cleared and left empty', () => {
    const { sim, houses, station } = ruinedTown();
    const w = sim.world;
    // The fifth ruin is the last house, left out of the order by queueing before it was destroyed.
    expect(run(sim, { type: 'rebuildAll' })).toBe(true);
    expect(run(sim, { type: 'debugGrow', x: 118, y: 105, archetype: R1, progress: 1 })).toBe(true);
    const extra = slotAt(sim, 118, 105);
    destroyBuilding(sim, extra);
    let busy = 0;
    const done = (): boolean => houses.every((s) => w.bArch[s] === R1 && (w.bFlags[s]! & (BFLAG.RUBBLE | BFLAG.CONSTRUCTING)) === 0)
      && w.bArch[station] === ARCH.FIRE_STATION && (w.bFlags[station]! & (BFLAG.RUBBLE | BFLAG.CONSTRUCTING)) === 0 && w.bArch[extra] === 0;
    for (let t = 0; t < 14000 && !done(); t++) {
      step(sim);
      if (t % 20 === 0 && agents(sim, AKIND.BUILDER).some((a) => w.aState[a] === AST.WORK || w.aState[a] === AST.TO_SITE)) busy++;
    }
    expect(busy, 'builder bots were seen at work').toBeGreaterThan(5);
    expect(done()).toBe(true);
    expect(w.bLevel[station], 'a service has no levels').toBe(0);
    for (const s of [...houses, station]) expect(w.bFlags[s]! & BFLAG.REBUILD).toBe(0);
    expect(slotAt(sim, 118, 105)).toBe(-1);
  });
});

describe('Rebuild all pays only for what gets rebuilt', () => {
  it('pays a queued ruin back when it is bulldozed before the robots reach it', () => {
    const net = (order: boolean): number => {
      const { sim, houses } = ruinedTown();
      const w = sim.world;
      if (order) expect(run(sim, { type: 'rebuildAll' })).toBe(true);
      const before = w.scalars[S.treasury]!, x = w.bX[houses[0]!]!, y = w.bY[houses[0]!]!;
      expect(run(sim, { type: 'bulldoze', x0: x, y0: y, x1: x, y1: y })).toBe(true);
      expect(w.bArch[houses[0]!]).toBe(0);
      return w.scalars[S.treasury]! - before;
    };
    expect(net(true) - net(false)).toBe(discounted(rebuildPrice(R1)));
  });

  it('pays a queued ruin back when its lot will not take the building once the robots have cleared it', () => {
    const { sim, houses } = ruinedTown();
    const w = sim.world;
    expect(run(sim, { type: 'rebuildAll' })).toBe(true);
    const s = houses[0]!, x = w.bX[s]!, y = w.bY[s]!;
    w.terrain[y * MAP + x] = TERRAIN.WATER;
    w.waterDepth[y * MAP + x] = 40;
    let gained = 0;
    for (let t = 0; t < 14000 && w.bArch[s] !== 0; t++) {
      const before = w.scalars[S.treasury]!, month = w.scalars[S.month]!;
      step(sim);
      if (w.bArch[s] === 0 && w.scalars[S.month] === month) gained = w.scalars[S.treasury]! - before;
    }
    expect(w.bArch[s]).toBe(0);
    expect(gained).toBe(discounted(rebuildPrice(R1)));
  });

  it('refunds half the price of the modules in a depot destroyed by a disaster', () => {
    const sim = flatSim(42, true);
    road(sim, 96, 104, 130, 104);
    depot(sim, 98, 102);
    const d = slotAt(sim, 98, 102);
    sim.world.scalars[S.treasury] = 1e6;
    expect(run(sim, { type: 'setDepotModule', slot: d, index: 0, module: MODULE.BUILDER_BAY })).toBe(true);
    expect(run(sim, { type: 'setDepotModule', slot: d, index: 1, module: MODULE.WORKSHOP })).toBe(true);
    const before = sim.world.scalars[S.treasury]!;
    destroyBuilding(sim, d);
    expect(sim.world.bArch[d]).toBe(0);
    expect(sim.world.scalars[S.treasury]! - before).toBe(Math.floor(MODULES[MODULE.BUILDER_BAY]!.cost * MODULE_REFUND) + Math.floor(MODULES[MODULE.WORKSHOP]!.cost * MODULE_REFUND));
  });
});

describe('scenario floors and the new modes', () => {
  it('lifts Off and Gentle to the floor and never lowers Hard', () => {
    expect(withFloor(DMODE.OFF, 1)).toBe(DMODE.RARE);
    expect(withFloor(DMODE.GENTLE, 1)).toBe(DMODE.RARE);
    expect(withFloor(DMODE.GENTLE, 2)).toBe(DMODE.NORMAL);
    expect(withFloor(DMODE.RARE, 2)).toBe(DMODE.NORMAL);
    expect(withFloor(DMODE.NORMAL, 1)).toBe(DMODE.NORMAL);
    expect(withFloor(DMODE.HARD, 2)).toBe(DMODE.HARD);
    expect(withFloor(DMODE.GENTLE, 0)).toBe(DMODE.GENTLE);
  });
});
