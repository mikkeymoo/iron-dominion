import { describe, expect, it } from 'vitest';
import { ARCH, BFLAG } from './catalog.ts';
import { createSim, restore, snapshot, stateHash } from './engine.ts';
import { deriveIssues, ISSUE_PERIOD, issuesOf, invalidateIssues, MAX_ISSUES } from './issues.ts';
import { BMAX, MAP, RMAX, S } from './layers.ts';
import type { Issue } from './protocol.ts';
import { AKIND, AST, JOB } from './robots/constants.ts';
import { spawnAgent } from './robots/pool.ts';
import { flatSim, road, run, runUntil, depot, zone } from './robots/testkit.ts';
import { recomputeServices } from './services/index.ts';
import { runTicks } from './testkit.ts';
import type { Sim } from './world.ts';

const grow = (sim: Sim, x: number, y: number, archetype = 16): void => {
  expect(run(sim, { type: 'debugGrow', x, y, archetype, progress: 1 })).toBe(true);
};
const byKind = (list: Issue[], kind: string): Issue | undefined => list.find((i) => i.kind === kind);
const slotAt = (sim: Sim, x: number, y: number): number => sim.world.bId[y * MAP + x]! - 1;

/** A plant at (100,100) with a house touching it and three houses with no line to the grid. */
function darkBlock(): Sim {
  const sim = flatSim(42, true);
  expect(run(sim, { type: 'placeBuilding', arch: ARCH.POWER_PLANT, x: 100, y: 100, rot: 0 })).toBe(true);
  grow(sim, 104, 100);
  for (const x of [110, 114, 118]) grow(sim, x, 100);
  runTicks(sim, 10);
  return sim;
}

/**
 * A small town that owes nobody anything: a depot with a road at its door, a plant with houses, a fire station and a police station
 * touching it in a row, a pipe under all of it from a pump, and no demand for land.
 */
function healthyTown(): Sim {
  const sim = flatSim(42, true);
  road(sim, 96, 99, 120, 99);
  depot(sim, 98, 100);
  expect(run(sim, { type: 'placeBuilding', arch: ARCH.POWER_PLANT, x: 100, y: 100, rot: 0 })).toBe(true);
  for (const x of [104, 105, 106, 113, 114]) grow(sim, x, 100);
  expect(run(sim, { type: 'placeBuilding', arch: ARCH.FIRE_STATION, x: 107, y: 100, rot: 0 })).toBe(true);
  expect(run(sim, { type: 'placeBuilding', arch: ARCH.POLICE, x: 110, y: 100, rot: 0 })).toBe(true);
  expect(run(sim, { type: 'placeBuilding', arch: ARCH.WATER_PUMP, x: 104, y: 104, rot: 0 })).toBe(true);
  expect(run(sim, { type: 'placeLine', kind: 'water', ax: 98, ay: 103, bx: 115, by: 103 })).toBe(true);
  runTicks(sim, 60);
  recomputeServices(sim);
  sim.world.scalars[S.demandR] = 0; sim.world.scalars[S.demandC] = 0; sim.world.scalars[S.demandI] = 0;
  return sim;
}

describe('issue derivation', () => {
  it('names the nearest unpowered building and the gap to the grid', () => {
    const sim = darkBlock();
    const list = deriveIssues(sim);
    const p = byKind(list, 'power');
    expect(p, JSON.stringify(list)).toBeDefined();
    expect(p!.count).toBe(3);
    expect(p!.overlay).toBe('power');
    expect(p!.category).toBe('utilities');
    expect({ x: p!.x, y: p!.y }).toEqual({ x: 110, y: 100 });
    expect(p!.text).toMatch(/3 buildings have no power/);
    expect(p!.text).toMatch(/nearest gap is 5 tiles/);
    expect(list[0]!.kind).toBe('power');
  });

  it('reports an overloaded grid instead of a gap when the dark building touches a browned-out network', () => {
    const sim = flatSim(42, true);
    expect(run(sim, { type: 'placeBuilding', arch: ARCH.POWER_PLANT, x: 100, y: 100, rot: 0 })).toBe(true);
    // 120 MW against 160 MW of towers in a row touching the plant: the last by slot goes dark while it touches live tiles.
    for (let i = 0; i < 4; i++) grow(sim, 104 + i * 3, 100, 24);
    runTicks(sim, 10);
    const p = byKind(deriveIssues(sim), 'power');
    expect(p).toBeDefined();
    expect(p!.text).toMatch(/overloaded/);
  });

  it('names an unwatered building and how far the water is', () => {
    const sim = flatSim(42, true);
    expect(run(sim, { type: 'placeBuilding', arch: ARCH.WATER_PUMP, x: 100, y: 100, rot: 0 })).toBe(true);
    grow(sim, 101, 103);
    grow(sim, 120, 100);
    runTicks(sim, 10);
    const w = byKind(deriveIssues(sim), 'water');
    expect(w, JSON.stringify(deriveIssues(sim))).toBeDefined();
    expect(w!.count).toBe(1);
    expect({ x: w!.x, y: w!.y }).toEqual({ x: 120, y: 100 });
    expect(w!.overlay).toBe('water');
  });

  it('says a stuck hauler on a cut route is blocked, and a stranded one has no road', () => {
    const sim = flatSim(42, true);
    road(sim, 96, 104, 130, 104);
    road(sim, 100, 120, 110, 120);
    depot(sim, 98, 102);
    runTicks(sim, 200);
    const haulers: number[] = [];
    for (let a = 0; a < RMAX; a++) if (sim.world.aKind[a] === AKIND.HAULER) haulers.push(a);
    expect(haulers.length).toBeGreaterThan(0);
    const w = sim.world, a = haulers[0]!;
    w.aState[a] = AST.HAUL; w.aTarget[a] = 0; w.aX[a] = 110.5; w.aY[a] = 104.5; w.aPlan[a] = 104 * MAP + 110; w.aGoal[a] = 120 * MAP + 105; w.aTry[a] = 3;
    const stuck = byKind(deriveIssues(sim), 'stuck');
    expect(stuck).toBeDefined();
    expect(stuck!.text).toMatch(/blocked or cut/);
    expect({ x: stuck!.x, y: stuck!.y }).toEqual({ x: 110, y: 104 });

    w.aX[a] = 60.5; w.aY[a] = 60.5; w.aPlan[a] = 0;
    const stranded = byKind(deriveIssues(sim), 'stuck');
    expect(stranded!.text).toMatch(/stranded off the road network/);
  });

  it('flags construction sites that wait for material, with the site named by location', () => {
    const sim = flatSim(42, true);
    road(sim, 96, 104, 130, 104);
    depot(sim, 98, 102);
    zone(sim, 100, 105, 110, 108);
    const hasJob = (): boolean => sim.world.jKind.some((k) => k !== 0);
    expect(runUntil(sim, hasJob, 600)).toBe(true);
    runTicks(sim, 5);
    let site = -1;
    for (let s = 0; s < BMAX; s++) if (sim.world.jKind[s] !== 0) { site = s; break; }
    expect(site, 'a build job exists').toBeGreaterThanOrEqual(0);
    for (let s = 0; s < BMAX; s++) if (sim.world.bArch[s] === ARCH.DEPOT) sim.world.bStock[s] = 0;
    sim.world.jHave[site] = 0; sim.world.jInbound[site] = 0;
    sim.world.jNeed[site] = Math.max(8, sim.world.jNeed[site]!);
    const j = byKind(deriveIssues(sim), 'jobs');
    expect(j, JSON.stringify(deriveIssues(sim))).toBeDefined();
    expect(j!.text).toMatch(/waiting for material/);
    expect(j!.x).toBeGreaterThanOrEqual(100);
    expect(sim.world.jKind[slotAt(sim, j!.x, j!.y)]).not.toBe(JOB.NONE);
  });

  it('asks for a depot when land is zoned and none exists, and for a road when the depot has none', () => {
    const sim = flatSim(42, true);
    road(sim, 96, 104, 130, 104);
    zone(sim, 100, 105, 110, 108);
    const d = byKind(deriveIssues(sim), 'depot');
    expect(d!.text).toMatch(/robots need a depot/);
    expect({ x: d!.x, y: d!.y }).toEqual({ x: 100, y: 105 });
    depot(sim, 98, 90);
    const d2 = byKind(deriveIssues(sim), 'depot');
    expect(d2!.text).toMatch(/no road at its door/);
  });

  it('warns when demand outruns the zoned land', () => {
    const sim = flatSim(42, true);
    road(sim, 96, 104, 130, 104);
    depot(sim, 98, 102);
    sim.world.scalars[S.demandR] = 0.8;
    const n = byKind(deriveIssues(sim), 'noLand');
    expect(n).toBeDefined();
    expect(n!.text).toMatch(/Demand for homes is 80% but no residential land is zoned/);
    zone(sim, 100, 105, 106, 108);
    expect(byKind(deriveIssues(sim), 'noLand')).toBeUndefined();
  });

  it('reports fires, abandoned buildings and debt, each with a tile', () => {
    const sim = darkBlock();
    const s = slotAt(sim, 104, 100);
    sim.world.bFlags[s] = sim.world.bFlags[s]! | BFLAG.BURNING;
    sim.world.bHeat[s] = 90;
    const t = slotAt(sim, 114, 100);
    sim.world.bFlags[t] = sim.world.bFlags[t]! | BFLAG.ABANDONED;
    sim.world.scalars[S.treasury] = -500;
    sim.world.scalars[S.lowMonths] = 1;
    const list = deriveIssues(sim);
    expect(list[0]!.kind, 'a fire outranks everything').toBe('fire');
    expect({ x: list[0]!.x, y: list[0]!.y }).toEqual({ x: 104, y: 100 });
    const b = byKind(list, 'budget');
    expect(b!.text).toMatch(/in debt/);
    expect(b!.text).toMatch(/2 months until services fail/);
    expect(byKind(list, 'abandoned')!.count).toBe(1);
  });

  it('finds nothing wrong in a healthy city', () => {
    const sim = healthyTown();
    expect(deriveIssues(sim), JSON.stringify(deriveIssues(sim))).toEqual([]);
    expect(deriveIssues(createSim(7))).toEqual([]);
  });

  it('ranks by severity, breaks ties by kind and tile, and keeps at most eight', () => {
    const sim = darkBlock();
    const w = sim.world;
    for (let i = 0; i < 6; i++) grow(sim, 130 + i * 2, 100, 16 + 18);
    road(sim, 96, 104, 140, 104);
    depot(sim, 98, 102);
    const s = slotAt(sim, 104, 100);
    w.bFlags[s] = w.bFlags[s]! | BFLAG.BURNING; w.bHeat[s] = 50;
    w.bFlags[slotAt(sim, 114, 100)] = w.bFlags[slotAt(sim, 114, 100)]! | BFLAG.ABANDONED;
    for (const x of [110, 114, 118]) { w.bFlags[slotAt(sim, x, 100)] = w.bFlags[slotAt(sim, x, 100)]! | BFLAG.UNWATERED; }
    for (let i = 0; i < 3; i++) { const k = spawnAgent(w, AKIND.BUILDER, 0, 70.5, 70.5); w.aState[k] = AST.TO_SITE; w.aTry[k] = 3; }
    w.scalars[S.demandR] = 0.9; w.scalars[S.demandC] = 0.9; w.scalars[S.demandI] = 0.9;
    w.scalars[S.treasury] = -1;
    const list = deriveIssues(sim);
    expect(list.length, JSON.stringify(list.map((i) => i.id))).toBe(MAX_ISSUES);
    for (let i = 1; i < list.length; i++) expect(list[i - 1]!.severity).toBeGreaterThanOrEqual(list[i]!.severity);
    expect(new Set(list.map((i) => i.id)).size).toBe(list.length);
    expect(deriveIssues(sim)).toEqual(list);
    expect(deriveIssues(restore(snapshot(sim)))).toEqual(list);
  });

  it('is read-only: deriving issues never changes the world hash', () => {
    const sim = darkBlock();
    const before = stateHash(sim);
    deriveIssues(sim);
    expect(stateHash(sim)).toBe(before);
  });

  it('caches for ISSUE_PERIOD ticks and refreshes after, or when invalidated', () => {
    const sim = darkBlock();
    const first = issuesOf(sim);
    expect(issuesOf(sim)).toBe(first);
    runTicks(sim, ISSUE_PERIOD - 1);
    expect(issuesOf(sim)).toBe(first);
    runTicks(sim, 1);
    expect(issuesOf(sim)).not.toBe(first);
    const again = issuesOf(sim);
    invalidateIssues(sim);
    expect(issuesOf(sim)).not.toBe(again);
  });
});
