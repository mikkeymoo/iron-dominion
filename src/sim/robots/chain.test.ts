import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARCH, BFLAG, rciId } from '../catalog.ts';
import { closeMonth, computeBudget, lastMonth, levelUpCandidates, needsOf, shopCentres } from '../economy/index.ts';
import { restore, snapshot, stateHash, step } from '../engine.ts';
import { answerInfo } from '../info.ts';
import { deriveIssues } from '../issues.ts';
import { BMAX, MAP, RMAX, S, TERRAIN, ZONE, type World } from '../layers.ts';
import { runTicks } from '../testkit.ts';
import type { Sim } from '../world.ts';
import {
  AKIND, AST, CH, JOB, RES, TRANSFER_BIT, materialFor, resUnits, startLevelUp, totalsByResource,
} from './index.ts';
import { agents, depot, flatSim, road, run, runUntil, zone } from './testkit.ts';

vi.setConfig({ testTimeout: 120000 });
afterEach(() => new Promise<void>((r) => { setTimeout(r, 0); }));

const MINE = { x: 106, y: 105 }, SMELTER = { x: 112, y: 105 }, FACTORY = { x: 118, y: 105 };

function place(sim: Sim, arch: number, x: number, y: number): number {
  expect(run(sim, { type: 'placeBuilding', arch, x, y, rot: 0 })).toBe(true);
  return sim.world.bId[y * MAP + x]! - 1;
}

/** A street along y = 104, a depot at its west end and a Mine on ore, a Smelter and a Factory beside it. */
function chainCity(withDepot = true): { sim: Sim; mine: number; smelter: number; factory: number } {
  const sim = flatSim(42, true);
  const w = sim.world;
  w.scalars[S.treasury] = 5e6;
  w.scalars[S.tier] = 5;
  road(sim, 96, 104, 140, 104);
  if (withDepot) { depot(sim, 98, 102); depot(sim, 114, 102); }
  for (let y = MINE.y; y < MINE.y + 3; y++) for (let x = MINE.x; x < MINE.x + 3; x++) w.terrain[y * MAP + x] = TERRAIN.ORE;
  return {
    sim, mine: place(sim, ARCH.MINE, MINE.x, MINE.y), smelter: place(sim, ARCH.SMELTER, SMELTER.x, SMELTER.y), factory: place(sim, ARCH.FACTORY, FACTORY.x, FACTORY.y),
  };
}

/** created - consumed - held - carried, per resource: zero at every tick if no unit is ever invented or lost. */
function drift(w: World): number[] {
  const held = totalsByResource(w), carried = [0, 0, 0];
  for (let a = 0; a < RMAX; a++) {
    const st = w.aState[a];
    if (w.aKind[a] === AKIND.HAULER && w.aCarry[a]! > 0 && (st === AST.TO_PICKUP || st === AST.HAUL)) carried[w.aRes[a]! & 3]! += w.aCarry[a]!;
  }
  return [0, 1, 2].map((r) => w.chain[CH.MADE + r]! - w.chain[CH.USED + r]! - held[r]! - carried[r]!);
}

describe('placing chain buildings', () => {
  it('a Mine needs ore under at least half of its footprint', () => {
    const sim = flatSim(42);
    sim.world.scalars[S.treasury] = 1e6; sim.world.scalars[S.tier] = 5;
    expect(run(sim, { type: 'placeBuilding', arch: ARCH.MINE, x: 50, y: 50, rot: 0 })).toBe(false);
    expect(sim.events.some((e) => e.type === 'rejected' && e.reason === 'noOre')).toBe(true);
    for (const [x, y] of [[50, 50], [51, 50], [52, 50], [50, 51]] as const) sim.world.terrain[y * MAP + x] = TERRAIN.ORE;
    expect(run(sim, { type: 'placeBuilding', arch: ARCH.MINE, x: 50, y: 50, rot: 0 }), '4 of 9 tiles is under half').toBe(false);
    sim.world.terrain[51 * MAP + 51] = TERRAIN.ORE;
    expect(run(sim, { type: 'placeBuilding', arch: ARCH.MINE, x: 50, y: 50, rot: 0 }), '5 of 9 tiles is over half').toBe(true);
  });

  it('is locked until its tier', () => {
    const sim = flatSim(42);
    sim.world.scalars[S.treasury] = 1e6;
    expect(run(sim, { type: 'placeBuilding', arch: ARCH.FACTORY, x: 50, y: 50, rot: 0 })).toBe(false);
    expect(sim.events.some((e) => e.type === 'rejected' && e.reason === 'locked')).toBe(true);
  });
});

describe('production', () => {
  it('a Mine fills to its cap and sells the overflow into industrial income', () => {
    const { sim, mine } = chainCity(false);
    const w = sim.world;
    runTicks(sim, 400);
    expect(w.bStock[mine]).toBe(40);
    expect(w.chain[CH.EXPORT]).toBe(40);
    expect(computeBudget(w, 0).incomeI).toBe(40);
    const before = w.scalars[S.treasury]!;
    const rec = closeMonth(sim);
    expect(rec.incomeI).toBe(40);
    expect(lastMonth(w).incomeI).toBe(40);
    expect(w.chain[CH.EXPORT]).toBe(0);
    expect(w.scalars[S.treasury]).toBe(before + rec.net);
  });

  it('an unpowered Mine stays idle', () => {
    const { sim, mine } = chainCity(false);
    sim.world.bFlags[mine] = BFLAG.UNPOWERED;
    runTicks(sim, 200);
    expect(sim.world.bStock[mine]).toBe(0);
  });

  it('a Smelter turns 4 Ore into 2 Alloy and idles below 4; a Factory turns 2 Alloy into 1 Component', () => {
    const { sim, smelter, factory } = chainCity(false);
    const w = sim.world;
    w.bIn[smelter * 3] = 3; w.bIn[factory * 3 + 1] = 1;
    runTicks(sim, 40);
    expect(w.bAlloy[smelter]).toBe(0); expect(w.bIn[smelter * 3]).toBe(3);
    expect(w.bParts[factory]).toBe(0); expect(w.bIn[factory * 3 + 1]).toBe(1);
    w.bIn[smelter * 3] = 4; w.bIn[factory * 3 + 1] = 2;
    w.chain[CH.MADE] += 4; w.chain[CH.MADE + 1] += 2;
    runTicks(sim, 40);
    expect(w.bAlloy[smelter]).toBe(2); expect(w.bIn[smelter * 3]).toBe(0);
    expect(w.bParts[factory]).toBe(1); expect(w.bIn[factory * 3 + 1]).toBe(0);
    expect(drift(w)).toEqual([0, 0, 0]);
  });

  it('never wraps a Uint16: a full output sells the overflow and an empty buffer is not drawn down', () => {
    const { sim, smelter, factory } = chainCity(false);
    const w = sim.world;
    w.bAlloy[smelter] = 65535; w.bIn[smelter * 3] = 4; w.chain[CH.MADE] += 4;
    w.bParts[factory] = 65535; w.bIn[factory * 3 + 1] = 2; w.chain[CH.MADE + 1] += 2;
    w.chain[CH.MADE + 1] += 65535; w.chain[CH.MADE + 2] += 65535;
    runTicks(sim, 40);
    expect(w.bAlloy[smelter]).toBe(65535);
    expect(w.bParts[factory]).toBe(65535);
    expect(w.bIn[smelter * 3]).toBe(0);
    runTicks(sim, 400);
    expect(w.bIn[smelter * 3]).toBe(0);
    expect(w.bIn[factory * 3 + 1]).toBe(0);
    expect(w.bAlloy[smelter]).toBe(65535);
    expect(drift(w)).toEqual([0, 0, 0]);
  });
});

describe('hauling the chain', () => {
  it('moves Ore to the Smelter, Alloy to the Factory and Components on, with every unit accounted for at every tick', () => {
    const { sim, smelter, factory } = chainCity();
    const w = sim.world;
    const seen = new Set<string>();
    let worst = 0;
    for (let t = 0; t < 3000; t++) {
      step(sim);
      const d = drift(w);
      worst = Math.max(worst, ...d.map(Math.abs));
      if (worst !== 0) throw new Error(`tick ${t}: drift ${JSON.stringify(d)}`);
      for (const a of agents(sim, AKIND.HAULER)) {
        if (w.aCarry[a]! > 0 && w.aState[a] === AST.HAUL) seen.add(`${w.aRes[a]! & 3}${(w.aRes[a]! & TRANSFER_BIT) !== 0 ? 't' : 'j'}`);
      }
    }
    expect(w.chain[CH.MADE + RES.ALLOY]).toBeGreaterThan(0);
    expect(w.chain[CH.MADE + RES.PARTS]).toBeGreaterThan(0);
    expect(w.bAlloy[smelter]! + w.bIn[factory * 3 + 1]! + w.bParts[factory]! + w.chain[CH.USED + RES.ALLOY]!).toBeGreaterThan(0);
    expect([...seen]).toEqual(expect.arrayContaining(['0t', '1t', '2t']));
    for (let s = 0; s < BMAX; s++) if (w.bArch[s] !== 0) expect(w.bIn[s * 3]! <= 16 && w.bIn[s * 3 + 1]! <= 8).toBe(true);
  });

  it('keeps depots stocked with the products and leaves no reservation behind', () => {
    const { sim } = chainCity();
    const w = sim.world;
    runTicks(sim, 4000);
    expect(drift(w)).toEqual([0, 0, 0]);
    const d = [...Array(BMAX).keys()].find((s) => w.bArch[s] === ARCH.DEPOT)!;
    expect(w.bAlloy[d]! + w.bParts[d]!).toBeGreaterThan(0);
    expect(w.jInbound.every((v) => v === 0)).toBe(true);
  });

  it('survives its target or its source being bulldozed mid-haul', () => {
    for (const victim of ['smelter', 'mine'] as const) {
      const city = chainCity();
      const { sim } = city, w = sim.world;
      const slot = city[victim];
      // The target is torn down while haulers carry stock to it, or the source while a hauler is on its way to collect.
      const caught = (a: number): boolean => (w.aRes[a]! & TRANSFER_BIT) !== 0 && w.aCarry[a]! > 0
        && (victim === 'smelter' ? (w.aState[a] === AST.HAUL || w.aState[a] === AST.TO_PICKUP) && (w.aTarget[a]! & 0xffff) - 1 === slot
          : w.aState[a] === AST.TO_PICKUP && (w.aSrc[a]! & 0xffff) - 1 === slot);
      let hit = false;
      for (let t = 0; t < 3000 && !hit; t++) {
        step(sim);
        hit = agents(sim, AKIND.HAULER).some(caught);
      }
      expect(hit, `a hauler heading for the ${victim}`).toBe(true);
      const x = w.bX[slot]!, y = w.bY[slot]!;
      expect(run(sim, { type: 'bulldoze', x0: x, y0: y, x1: x + 2, y1: y + 2 })).toBe(true);
      expect(w.bArch[slot]).toBe(0);
      for (let t = 0; t < 800; t++) {
        step(sim);
        const d = drift(w);
        if (d.some((v) => v !== 0)) throw new Error(`${victim}, tick ${t}: drift ${JSON.stringify(d)}`);
      }
      for (const a of agents(sim, AKIND.HAULER)) {
        const st = w.aState[a];
        if (st === AST.IDLE) expect(w.aCarry[a]).toBe(0);
      }
    }
  });
});

describe('job resources', () => {
  /** A finished level-1 house with a free street frontage, placed with the debug command. */
  function house(sim: Sim, level = 1): number {
    expect(run(sim, { type: 'debugGrow', x: 100, y: 105, archetype: rciId(ZONE.R, 0, level), progress: 1 })).toBe(true);
    return sim.world.bId[105 * MAP + 100]! - 1;
  }
  const accessFor = (): number => 104 * MAP + 100;

  it('a level-up to 2 asks for Alloy and to 3 for Components, halved and quartered', () => {
    const sim = flatSim(42, true);
    sim.world.scalars[S.treasury] = 1e6;
    road(sim, 96, 104, 140, 104);
    depot(sim, 98, 102);
    const s = house(sim);
    expect(startLevelUp(sim, s, rciId(ZONE.R, 0, 2), accessFor())).toBe(true);
    const w = sim.world;
    expect(w.jKind[s]).toBe(JOB.LEVEL);
    expect(w.jRes[s]).toBe(RES.ALLOY);
    expect(w.jNeed[s]).toBe(resUnits(materialFor(w.bW[s]! * w.bH[s]!, 2), 1));
    expect(w.jNeed[s]).toBe(Math.ceil(materialFor(w.bW[s]! * w.bH[s]!, 2) / 2));
  });

  it('an L3 level-up asks for Components', () => {
    const sim = flatSim(42, true);
    sim.world.scalars[S.treasury] = 1e6;
    road(sim, 96, 104, 140, 104);
    depot(sim, 98, 102);
    zone(sim, 100, 105, 101, 106);
    const s = house(sim, 2);
    expect(startLevelUp(sim, s, rciId(ZONE.R, 0, 3), accessFor())).toBe(true);
    const w = sim.world;
    expect(w.jRes[s]).toBe(RES.PARTS);
    expect(w.jNeed[s]).toBe(Math.ceil(materialFor(w.bW[s]! * w.bH[s]!, 3) / 4));
  });

  it('a depot-only city finishes a level-up by importing Alloy, paying exactly the import price', () => {
    const sim = flatSim(42, true);
    const w = sim.world;
    w.scalars[S.treasury] = 1e6;
    road(sim, 96, 104, 140, 104);
    depot(sim, 98, 102);
    const s = house(sim);
    expect(startLevelUp(sim, s, rciId(ZONE.R, 0, 2), accessFor())).toBe(true);
    const need = w.jNeed[s]!;
    let transfers = 0;
    const done = runUntil(sim, () => {
      for (const a of agents(sim, AKIND.HAULER)) if ((w.aRes[a]! & TRANSFER_BIT) !== 0) transfers++;
      return w.bLevel[s] === 2 && (w.bFlags[s]! & BFLAG.CONSTRUCTING) === 0;
    }, 12000);
    expect(done).toBe(true);
    expect(w.scalars[S.month], 'the month has not closed, so spend still holds every import').toBe(0);
    expect(transfers).toBe(0);
    const imported = w.chain[CH.MADE + RES.ALLOY]!;
    expect(w.chain[CH.USED + RES.ALLOY]).toBe(need);
    expect(imported).toBeGreaterThanOrEqual(need);
    expect(w.spend[1]).toBe(imported * 10);
    expect(drift(w)).toEqual([0, 0, 0]);
  });

  it('an old in-flight job (jRes 0, Ore units) completes with Ore alone', () => {
    const sim = flatSim(42, true);
    const w = sim.world;
    w.scalars[S.treasury] = 1e6;
    road(sim, 96, 104, 140, 104);
    depot(sim, 98, 102);
    const s = house(sim);
    expect(startLevelUp(sim, s, rciId(ZONE.R, 0, 2), accessFor())).toBe(true);
    w.jRes[s] = RES.ORE; w.jNeed[s] = materialFor(w.bW[s]! * w.bH[s]!, 2);
    expect(runUntil(sim, () => w.bLevel[s] === 2 && (w.bFlags[s]! & BFLAG.CONSTRUCTING) === 0, 12000)).toBe(true);
    expect(w.chain[CH.MADE + RES.ALLOY]).toBe(0);
    expect(w.chain[CH.USED + RES.ORE]).toBe(materialFor(w.bW[s]! * w.bH[s]!, 2));
  });
});

describe('zone needs', () => {
  const setup = (): Sim => {
    const sim = flatSim(42, true);
    const w = sim.world;
    w.scalars[S.demandR] = 0.9; w.scalars[S.demandC] = 0.9; w.scalars[S.demandI] = 0.9;
    w.landValue.fill(150);
    return sim;
  };
  const grow = (sim: Sim, zone: number, level: number, x: number, y: number): number => {
    expect(run(sim, { type: 'debugGrow', x, y, archetype: rciId(zone, 0, level), progress: 1 })).toBe(true);
    return sim.world.bId[y * MAP + x]! - 1;
  };
  const candidateSlots = (sim: Sim, zone: number): number[] => levelUpCandidates(sim, zone, 50).map((c) => c.slot).sort((a, b) => a - b);

  it('homes need a working shop within 20 tiles to reach level 2', () => {
    const sim = setup();
    const h = grow(sim, ZONE.R, 1, 100, 105);
    expect(candidateSlots(sim, ZONE.R)).toEqual([]);
    expect(needsOf(sim.world, h).find((n) => n.id === 'shop')?.ok).toBe(false);
    const far = grow(sim, ZONE.C, 1, 100 + 22, 105);
    expect(far).toBeGreaterThanOrEqual(0);
    expect(candidateSlots(sim, ZONE.R)).toEqual([]);
    grow(sim, ZONE.C, 1, 100 + 10, 105);
    expect(candidateSlots(sim, ZONE.R)).toEqual([h]);
    expect(needsOf(sim.world, h).every((n) => n.ok)).toBe(true);
  });

  it('level 2 homes also need clinic and school cover; shops need local goods, then components; industry needs only power and water', () => {
    const sim = setup();
    const w = sim.world;
    const h = grow(sim, ZONE.R, 2, 100, 105);
    const c = grow(sim, ZONE.C, 1, 110, 105);
    const i = grow(sim, ZONE.I, 1, 145, 105);
    expect(candidateSlots(sim, ZONE.R)).toEqual([]);
    expect(needsOf(w, h).filter((n) => !n.ok).map((n) => n.id)).toEqual(['health', 'school']);
    w.covHealth.fill(200); w.covEdu.fill(200);
    expect(candidateSlots(sim, ZONE.R)).toEqual([h]);
    expect(candidateSlots(sim, ZONE.C)).toEqual([]);
    expect(needsOf(w, c).find((n) => n.id === 'goods')?.ok).toBe(false);
    expect(needsOf(w, c).map((n) => n.id)).toEqual(['power', 'water', 'goods']);
    const near = grow(sim, ZONE.I, 1, 135, 105);
    expect(needsOf(w, c).find((n) => n.id === 'goods')?.ok).toBe(true);
    expect(candidateSlots(sim, ZONE.C)).toEqual([c]);
    const c2 = grow(sim, ZONE.C, 2, 114, 105);
    expect(needsOf(w, c2).map((n) => n.id)).toEqual(['power', 'water', 'components']);
    expect(needsOf(w, c2).find((n) => n.id === 'components')?.ok).toBe(false);
    expect(candidateSlots(sim, ZONE.C)).toEqual([c]);
    w.bAux[c2] = 2;
    expect(candidateSlots(sim, ZONE.C)).toEqual([c, c2].sort((a, b) => a - b));
    expect(candidateSlots(sim, ZONE.I)).toEqual([i, near].sort((a, b) => a - b));
    expect(needsOf(w, i).map((n) => n.id)).toEqual(['power', 'water']);
  });

  it('local goods reach 30 tiles: an operating industrial building or a running Smelter counts, an unpowered or distant one does not', () => {
    const sim = setup();
    const w = sim.world;
    const c = grow(sim, ZONE.C, 1, 100, 105);
    const goods = (): boolean | undefined => needsOf(w, c).find((n) => n.id === 'goods')?.ok;
    expect(goods()).toBe(false);
    const far = grow(sim, ZONE.I, 1, 100 + 32, 105);
    expect(goods()).toBe(false);
    w.bFlags[far] = w.bFlags[far]! | BFLAG.UNPOWERED;
    const close = grow(sim, ZONE.I, 1, 100 + 24, 105);
    w.bFlags[close] = w.bFlags[close]! | BFLAG.UNPOWERED;
    expect(goods()).toBe(false);
    w.bFlags[close] = w.bFlags[close]! & ~BFLAG.UNPOWERED;
    expect(goods()).toBe(true);
    w.bFlags[close] = w.bFlags[close]! | BFLAG.UNPOWERED;
    expect(run(sim, { type: 'debugGrow', x: 100, y: 120, archetype: ARCH.SMELTER, progress: 1 })).toBe(true);
    expect(goods()).toBe(true);
  });

  it('a tier-1 city with industrial zones gets commercial level-2 buildings, with no Smelter or Factory built', () => {
    const sim = setup();
    const w = sim.world;
    expect(w.scalars[S.tier]).toBe(0);
    const c = grow(sim, ZONE.C, 1, 100, 105);
    expect(candidateSlots(sim, ZONE.C)).toEqual([]);
    const i = grow(sim, ZONE.I, 1, 112, 105);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(candidateSlots(sim, ZONE.C)).toEqual([c]);
    for (let s = 0; s < BMAX; s++) expect(w.bArch[s] === ARCH.SMELTER || w.bArch[s] === ARCH.FACTORY).toBe(false);
    expect(levelUpCandidates(sim, ZONE.C, 4).map((u) => u.nextArch)).toEqual([rciId(ZONE.C, 0, 2)]);
  });

  it('end to end: robots raise a shop to level 2 beside industry in a depot-only city', () => {
    const sim = setup();
    const w = sim.world;
    w.scalars[S.treasury] = 1e6;
    road(sim, 96, 104, 140, 104);
    depot(sim, 98, 102);
    const c = grow(sim, ZONE.C, 1, 104, 105);
    grow(sim, ZONE.I, 1, 112, 105);
    expect(w.scalars[S.tier]).toBeLessThan(3);
    const done = runUntil(sim, () => {
      // The economy recomputes demand and land value from this near-empty city; hold them strong so only the needs decide.
      w.scalars[S.demandC] = 0.9; w.landValue.fill(150);
      return w.bLevel[c] === 2 && (w.bFlags[c]! & BFLAG.CONSTRUCTING) === 0;
    }, 20000);
    expect(done).toBe(true);
    expect(w.bArch[c]).toBe(rciId(ZONE.C, 0, 2));
    for (let s = 0; s < BMAX; s++) expect(w.bArch[s] === ARCH.SMELTER || w.bArch[s] === ARCH.FACTORY).toBe(false);
  });

  it('needsOf agrees with levelUpCandidates for every grown building', () => {
    const sim = setup();
    const w = sim.world;
    grow(sim, ZONE.R, 1, 100, 105); grow(sim, ZONE.R, 2, 104, 105); grow(sim, ZONE.R, 1, 150, 105);
    grow(sim, ZONE.C, 1, 110, 105); grow(sim, ZONE.C, 2, 114, 105); grow(sim, ZONE.I, 1, 130, 105);
    w.bAux[[...Array(BMAX).keys()].find((s) => w.bArch[s] === rciId(ZONE.C, 0, 2))!] = 2;
    w.covHealth.fill(200); w.covEdu.fill(0);
    for (const z of [ZONE.R, ZONE.C, ZONE.I]) {
      const want: number[] = [];
      const shops = shopCentres(w);
      for (let s = 0; s < BMAX; s++) {
        const arch = w.bArch[s]!;
        if (arch === 0 || arch < 16 || arch > 42 || Math.floor((arch - 16) / 9) + 1 !== z || w.bLevel[s]! >= 3) continue;
        if (needsOf(w, s, shops).every((n) => n.ok)) want.push(s);
      }
      expect(candidateSlots(sim, z)).toEqual(want.sort((a, b) => a - b));
    }
  });

  it('goods: a Factory with components in reach supplies shops, and a level 2 shop eats one per pass', () => {
    const { sim, factory } = chainCity(false);
    const w = sim.world;
    const shop = (() => { expect(run(sim, { type: 'debugGrow', x: 124, y: 105, archetype: rciId(ZONE.C, 0, 2), progress: 1 })).toBe(true); return w.bId[105 * MAP + 124]! - 1; })();
    w.bParts[factory] = 3; w.chain[CH.MADE + RES.PARTS] += 3;
    runTicks(sim, 600);
    expect(w.bAux[shop]).toBe(2);
    expect(w.bParts[factory]).toBe(2);
    expect(drift(w)).toEqual([0, 0, 0]);
    w.bParts[factory] = 0;
    runTicks(sim, 600);
    expect(w.bAux[shop]).toBe(1);
    runTicks(sim, 600);
    expect(w.bAux[shop]).toBe(0);
  });
});

describe('info, advisor and snapshot', () => {
  it('a Smelter card carries stock gauges and a needs checklist', () => {
    const { sim, smelter } = chainCity(false);
    sim.world.bIn[smelter * 3] = 2;
    const m = answerInfo(sim, { type: 'requestInfo', id: 1, kind: 'building', ref: smelter });
    expect(m.ok).toBe(true);
    const info = m.info as import('../protocol.ts').BuildingInfo;
    expect(info.stocks?.map((b) => [b.res, b.role, b.have, b.cap])).toEqual([[RES.ORE, 'in', 2, 16], [RES.ALLOY, 'out', 0, 40]]);
    expect(info.needs?.map((n) => [n.text, n.ok])).toEqual([['Power', true], ['Ore: 2 of 4 for a batch', false], ['Room for Alloy', true]]);
    expect(info.thoughts.some((t) => /Starved/.test(t.text))).toBe(true);
  });

  it('the advisor names the scarce resource and the count of blocked upgrades', () => {
    const sim = flatSim(42, true);
    const w = sim.world;
    road(sim, 96, 104, 140, 104);
    depot(sim, 98, 102);
    for (const x of [100, 103, 106]) {
      expect(run(sim, { type: 'debugGrow', x, y: 105, archetype: rciId(ZONE.R, 0, 1), progress: 1 })).toBe(true);
      const s = w.bId[105 * MAP + x]! - 1;
      expect(startLevelUp(sim, s, rciId(ZONE.R, 0, 2), 104 * MAP + x)).toBe(true);
    }
    const issue = deriveIssues(sim).find((i) => i.kind === 'resource');
    expect(issue?.text).toMatch(/^Alloy shortage blocks 3 upgrades/);
  });

  it('resumes from a snapshot mid-chain: 700 + restore + 700 equals 1400 straight', () => {
    const a = chainCity().sim;
    runTicks(a, 1400);
    const b = chainCity().sim;
    runTicks(b, 700);
    const resumed = restore(snapshot(b));
    runTicks(resumed, 700);
    expect(stateHash(resumed)).toBe(stateHash(a));
    expect(drift(resumed.world)).toEqual([0, 0, 0]);
  });
});
