import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARCH, BFLAG } from '../catalog.ts';
import { step } from '../engine.ts';
import { deriveIssues } from '../issues.ts';
import { MAP, RMAX, S } from '../layers.ts';
import { MEGA } from '../megaprojects.ts';
import { AKIND, AST, CH, FACTORY_IN, IMPORT_PRICE, JOB, OUTPUT_CAP, PRODUCTION_CAP, RES, SMELT_IN } from './constants.ts';
import { SPEND } from './pool.ts';
import { productionStats, totalsByResource } from './index.ts';
import { depot, flatSim, road, run } from './testkit.ts';
import type { Sim } from '../world.ts';

vi.setConfig({ testTimeout: 120000 });
afterEach(() => new Promise<void>((r) => { setTimeout(r, 0); }));

const grow = (sim: Sim, arch: number, x: number, y: number, progress = 1): number => {
  expect(run(sim, { type: 'debugGrow', x, y, archetype: arch, progress })).toBe(true);
  return sim.world.bId[y * MAP + x]! - 1;
};

describe('production overlay list', () => {
  function chainTown(): Sim {
    const sim = flatSim(42, true);
    sim.world.scalars[S.treasury] = 5e6;
    sim.world.scalars[S.tier] = 5;
    return sim;
  }

  it('reports filling, starved and full per finished chain building, starved first', () => {
    const sim = chainTown(), w = sim.world;
    const mine = grow(sim, ARCH.MINE, 100, 100), smelter = grow(sim, ARCH.SMELTER, 110, 100), factory = grow(sim, ARCH.FACTORY, 120, 100);
    grow(sim, ARCH.SMELTER, 130, 100, 0.5);
    grow(sim, ARCH.CLINIC, 140, 100);
    const states = (): Record<number, string> => Object.fromEntries(productionStats(w).list.map((p) => [p.slot, p.state]));

    expect(states()).toEqual({ [mine]: 'filling', [smelter]: 'starved', [factory]: 'starved' });
    expect(productionStats(w).total).toBe(3);

    w.bStock[mine] = OUTPUT_CAP;
    w.bIn[smelter * 3 + RES.ORE] = SMELT_IN;
    w.bIn[factory * 3 + RES.ALLOY] = FACTORY_IN - 1;
    expect(states()).toEqual({ [mine]: 'full', [smelter]: 'filling', [factory]: 'starved' });

    w.bIn[factory * 3 + RES.ALLOY] = FACTORY_IN;
    w.bFlags[smelter] = BFLAG.UNPOWERED;
    expect(states()).toEqual({ [mine]: 'full', [smelter]: 'starved', [factory]: 'filling' });
    expect(productionStats(w).list.map((p) => p.slot)).toEqual([smelter, mine, factory]);
    expect(productionStats(w).list[0]).toMatchObject({ arch: ARCH.SMELTER, x: 110, y: 100 });
  });

  it('lists at most PRODUCTION_CAP buildings with the starved ones first, and counts them all', () => {
    const sim = chainTown(), w = sim.world;
    const slots: number[] = [];
    for (let i = 0; i < PRODUCTION_CAP + 6; i++) slots.push(grow(sim, ARCH.SMELTER, 4 + (i % 20) * 4, 4 + ((i / 20) | 0) * 4));
    const lone = slots[slots.length - 1]!;
    for (const s of slots) w.bIn[s * 3 + RES.ORE] = SMELT_IN;
    w.bIn[lone * 3 + RES.ORE] = 0;
    const stats = productionStats(w);
    expect(stats.total).toBe(PRODUCTION_CAP + 6);
    expect(stats.list).toHaveLength(PRODUCTION_CAP);
    expect(stats.list[0]).toMatchObject({ slot: lone, state: 'starved' });
    expect(stats.list.slice(1).every((p) => p.state === 'filling')).toBe(true);
  });
});

describe('megaproject Components', () => {
  function megaCity(): { sim: Sim; slot: number; undo: () => void } {
    const arch = ARCH.MECH_ARENA, stages = MEGA[arch]!.stages, saved = stages.map((s) => ({ ...s }));
    stages.forEach((s) => { s.material = 18; s.work = 400; });
    const sim = flatSim(42, true);
    sim.world.scalars[S.treasury] = 5e6;
    road(sim, 96, 104, 140, 104);
    depot(sim, 98, 102);
    const slot = grow(sim, arch, 104, 105, 0);
    return { sim, slot, undo: () => stages.forEach((s, i) => Object.assign(s, saved[i])) };
  }

  it('asks for a quarter of each stage\'s material in Components, rounded up, and tells the player when it waits', () => {
    const { sim, slot, undo } = megaCity();
    try {
      const w = sim.world;
      for (let t = 0; t < 60; t++) step(sim);
      expect(w.jKind[slot]).toBe(JOB.BUILD);
      expect([w.jRes[slot], w.jNeed[slot]]).toEqual([RES.PARTS, 5]);
      const issue = deriveIssues(sim).find((i) => i.id === `resource-mega-${ARCH.MECH_ARENA}`);
      expect(issue).toMatchObject({ kind: 'resource', category: 'robots' });
      expect(issue!.text).toContain('Components');
      expect(issue!.text).toContain(`$${IMPORT_PRICE[RES.PARTS]}`);
      expect(deriveIssues(sim).some((i) => i.id === `resource-${RES.PARTS}`)).toBe(false);
    } finally { undo(); }
  });

  it('completes in a city with only depots through the import fallback, paying exactly the price of the Components used', () => {
    const { sim, slot, undo } = megaCity();
    try {
      const w = sim.world;
      let done = false;
      for (let t = 0; t < 4000 && !done; t++) {
        step(sim);
        done = sim.events.some((e) => e.type === 'megaComplete');
        sim.events = [];
        if (t % 25 === 0) {
          const held = totalsByResource(w);
          const carried = [0, 0, 0];
          for (let a = 0; a < RMAX; a++) {
            const st = w.aState[a];
            if (w.aKind[a] === AKIND.HAULER && w.aCarry[a]! > 0 && (st === AST.TO_PICKUP || st === AST.HAUL)) carried[w.aRes[a]! & 3]! += w.aCarry[a]!;
          }
          for (const r of [0, 1, 2]) expect(w.chain[CH.MADE + r]! - w.chain[CH.USED + r]! - held[r]! - carried[r]!, `resource ${r} at tick ${t}`).toBe(0);
        }
      }
      expect(done).toBe(true);
      expect(w.bFlags[slot]! & BFLAG.CONSTRUCTING).toBe(0);
      const units = 3 * Math.ceil(18 / 4);
      expect(w.chain[CH.MADE + RES.PARTS]).toBe(units);
      expect(w.chain[CH.USED + RES.PARTS]).toBe(units);
      expect(w.spend[SPEND.IMPORTS]).toBe(units * IMPORT_PRICE[RES.PARTS]);
      expect(deriveIssues(sim).some((i) => i.id.startsWith('resource-mega'))).toBe(false);
    } finally { undo(); }
  });

  it('does not import Components for a stage when the treasury cannot pay, and finishes once it can', () => {
    const { sim, slot, undo } = megaCity();
    try {
      const w = sim.world;
      for (let t = 0; t < 200; t++) step(sim);
      w.scalars[S.treasury] = 0;
      const before = w.chain[CH.MADE + RES.PARTS]!;
      for (let t = 0; t < 600; t++) step(sim);
      expect(w.chain[CH.MADE + RES.PARTS]).toBe(before);
      w.scalars[S.treasury] = 5e6;
      for (let t = 0; t < 4000 && (w.bFlags[slot]! & BFLAG.CONSTRUCTING) !== 0; t++) step(sim);
      expect(w.bFlags[slot]! & BFLAG.CONSTRUCTING).toBe(0);
    } finally { undo(); }
  });
});
