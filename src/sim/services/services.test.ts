import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARCH, BFLAG, CATALOG, SVC, rciId } from '../catalog.ts';
import { execute, type Command, type CommandBody } from '../commands.ts';
import { landValueAt, levelUpCandidates, lotScore, updateAbandonment } from '../economy/index.ts';
import { createSim, restore, snapshot, stateHash } from '../engine.ts';
import { MAP, REGISTRY, S, TERRAIN } from '../layers.ts';
import { setRoads } from '../roads/testkit.ts';
import { runTicks } from '../testkit.ts';
import { solveUtilities } from '../utilities/index.ts';
import type { Sim } from '../world.ts';
import {
  COVERED_MIN, SERVICE_PERIOD, crimeOf, fireRiskOf, recomputeServices, serviceCapacity, serviceKind, serviceRadius, serviceStats,
} from './index.ts';

vi.setConfig({ testTimeout: 60000 });
afterEach(() => new Promise<void>((r) => { setTimeout(r, 0); }));

let nextId = 1;
function run(sim: Sim, body: CommandBody): { ok: boolean; reason?: string } {
  sim.events = [];
  const ok = execute(sim, { ...body, id: nextId++, tick: 0 } as Command);
  const e = sim.events[sim.events.length - 1]!;
  return { ok, reason: e.type === 'rejected' ? e.reason : undefined };
}

function flatSim(): Sim {
  const sim = createSim(42, { debug: true });
  const w = sim.world;
  w.terrain.fill(TERRAIN.GRASS);
  w.height.fill(160);
  w.waterDepth.fill(0);
  return sim;
}

const must = (r: { ok: boolean; reason?: string }, what: string): void => { if (!r.ok) throw new Error(`${what}: ${r.reason}`); };
const grow = (sim: Sim, x: number, y: number, arch: number): void => must(run(sim, { type: 'debugGrow', x, y, archetype: arch, progress: 1 }), `grow ${arch} at ${x},${y}`);
const place = (sim: Sim, arch: number, x: number, y: number): void => must(run(sim, { type: 'placeBuilding', arch, x, y, rot: 0 }), `place ${arch} at ${x},${y}`);
const at = (x: number, y: number): number => y * MAP + x;
const slotAt = (sim: Sim, x: number, y: number): number => sim.world.bId[at(x, y)]! - 1;
const line = (x0: number, y0: number, x1: number, y1: number): [number, number][] => {
  const out: [number, number][] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push([x, y]);
  return out;
};

const R1 = rciId(1, 0, 1), R_BIG = rciId(1, 2, 3);

/**
 * A fire station at (97,100) on arm one of a U-shaped road (x = 100, y 100..130; across at y = 130; x = 105 back up). The
 * house at (104,100) borders arm two: 5 tiles from the station in a straight line, 65 road tiles away.
 */
function uCity(link: boolean): Sim {
  const sim = flatSim();
  setRoads(sim.world, [...line(100, 100, 100, 130), ...line(100, 130, 105, 130), ...line(105, 100, 105, 130), ...(link ? line(100, 99, 105, 99) : [])]);
  place(sim, ARCH.FIRE_STATION, 97, 100);
  grow(sim, 104, 100, R1);
  return sim;
}

describe('catalog and tables', () => {
  it('declares every service with a kind, a reach and (for the road kinds) a capacity', () => {
    const services = CATALOG.filter((a) => a.service);
    expect(services.map((a) => a.id).sort((a, b) => a - b)).toEqual([4, 8, 9, 10, 11, 12, 13, 14, 15]);
    for (const a of services) {
      expect(serviceKind(a.id), a.name).toBe(a.service!.kind);
      expect(serviceRadius(a.id), a.name).toBeGreaterThan(0);
      expect(a.placeable && a.cost > 0 && (a.upkeep ?? 0) > 0, a.name).toBe(true);
      if (a.service!.kind <= SVC.EDU) expect(serviceCapacity(a.id), a.name).toBeGreaterThan(0);
    }
    expect(new Set(CATALOG.map((a) => a.id)).size).toBe(CATALOG.length);
  });

  it('registers the new layers: coverage and crime are mirrored overlay layers, the repair field is sim-only', () => {
    const info = (n: string) => REGISTRY.find((l) => l.name === n)!;
    for (const n of ['covFire', 'covPolice', 'covHealth', 'covEdu', 'covPark', 'crime']) expect([n, info(n).render, info(n).dirty]).toEqual([n, true, 'overlay']);
    expect([info('covRepair').render, info('covRepair').dirty]).toEqual([false, 'none']);
  });
});

describe('road coverage', () => {
  it('follows the road network: a house 5 tiles away in a straight line but 65 by road is not covered', () => {
    const far = uCity(false);
    recomputeServices(far);
    const w = far.world;
    expect(w.covFire[at(100, 100)]).toBe(255);
    expect(w.covFire[at(104, 100)], 'beside arm two, unreachable').toBe(0);
    expect(footprintCov(far, 104, 100)).toBe(0);
    expect(fireRiskOf(w, slotAt(far, 104, 100))).toBeGreaterThan(100);
    expect(serviceStats(far).services.fire.pct).toBe(0);

    const near = uCity(true);
    recomputeServices(near);
    expect(near.world.covFire[at(104, 100)]).toBeGreaterThanOrEqual(COVERED_MIN);
    expect(near.world.covFire[at(104, 100)]).toBeLessThan(255);
    expect(fireRiskOf(near.world, slotAt(near, 104, 100))).toBeLessThan(fireRiskOf(w, slotAt(far, 104, 100)));
    expect(serviceStats(near).services.fire.pct).toBe(100);
  });

  it('stops at the radius: coverage fades with road distance and ends at the reach of the building', () => {
    const sim = flatSim();
    setRoads(sim.world, line(100, 100, 160, 100));
    place(sim, ARCH.FIRE_STATION, 97, 99);
    recomputeServices(sim);
    const radius = serviceRadius(ARCH.FIRE_STATION);
    const w = sim.world;
    expect(w.covFire[at(100, 100)]).toBe(255);
    const v = [105, 110, 120, 100 + radius].map((x) => w.covFire[at(x, 100)]!);
    for (let i = 1; i < v.length; i++) expect(v[i]!, `step ${i}`).toBeLessThan(v[i - 1]!);
    expect(v[v.length - 1]).toBeGreaterThan(0);
    expect(w.covFire[at(100 + radius + 3, 100)]).toBe(0);
  });

  it('limits a service by its capacity: the clinic covers a share, and a second one lifts it', () => {
    const sim = flatSim();
    setRoads(sim.world, line(79, 100, 120, 100));
    place(sim, ARCH.CLINIC, 77, 100);
    for (let k = 0; k < 5; k++) { grow(sim, 81 + 3 * k, 97, R_BIG); grow(sim, 81 + 3 * k, 101, R_BIG); }
    recomputeServices(sim);
    let h = serviceStats(sim).services.health;
    expect(h).toMatchObject({ buildings: 1, working: 1, capacity: 1500, population: 2200, served: 1500, pct: 68 });
    const alone = sim.world.covHealth[at(81, 100)]!;
    expect(alone, 'a full-strength clinic road tile is scaled by capacity / load').toBeLessThan(255);
    expect(alone).toBeGreaterThan(0);

    place(sim, ARCH.CLINIC, 97, 101);
    recomputeServices(sim);
    h = serviceStats(sim).services.health;
    expect(h).toMatchObject({ buildings: 2, capacity: 3000 });
    // Shares are floored per building, so up to one person per building and service is lost to rounding.
    expect(h.served).toBeGreaterThan(2200 - 20);
    expect(h.served).toBeLessThanOrEqual(2200);
    expect(h.pct).toBeGreaterThanOrEqual(99);
    expect(sim.world.covHealth[at(81, 100)]!).toBeGreaterThan(alone);
  });

  it('allocates a building between two services in proportion to their coverage, deterministically', () => {
    const build = (): Sim => {
      const sim = flatSim();
      setRoads(sim.world, line(59, 100, 140, 100));
      place(sim, ARCH.FIRE_STATION, 56, 99);
      place(sim, ARCH.FIRE_STATION, 141, 99);
      for (let k = 0; k < 8; k++) grow(sim, 70 + 7 * k, 97, R_BIG);
      return sim;
    };
    const a = build(), b = build();
    recomputeServices(a); recomputeServices(b);
    expect(serviceStats(a).services.fire).toEqual(serviceStats(b).services.fire);
    expect(Array.from(a.world.covFire)).toEqual(Array.from(b.world.covFire));
    expect(serviceStats(a).services.fire.served).toBeLessThanOrEqual(serviceStats(a).services.fire.population);
  });
});

const footprintCov = (sim: Sim, x: number, y: number): number => {
  const s = slotAt(sim, x, y);
  let m = 0;
  for (let yy = sim.world.bY[s]!; yy < sim.world.bY[s]! + sim.world.bH[s]!; yy++) for (let xx = sim.world.bX[s]!; xx < sim.world.bX[s]! + sim.world.bW[s]!; xx++) m = Math.max(m, sim.world.covFire[at(xx, yy)]!);
  return m;
};

describe('working services', () => {
  it('gives no coverage while the service is unpowered, and coverage once a plant powers it', () => {
    const dark = uCity(true);
    place(dark, ARCH.POWER_PLANT, 200, 200);
    solveUtilities(dark);
    expect(dark.world.bFlags[slotAt(dark, 97, 100)]! & BFLAG.UNPOWERED).toBe(BFLAG.UNPOWERED);
    recomputeServices(dark);
    expect(dark.world.covFire[at(100, 100)]).toBe(0);
    expect(serviceStats(dark).services.fire).toMatchObject({ buildings: 1, working: 0, capacity: 0, pct: 0 });

    const lit = uCity(true);
    place(lit, ARCH.POWER_PLANT, 93, 100);
    solveUtilities(lit);
    expect(lit.world.bFlags[slotAt(lit, 97, 100)]! & BFLAG.UNPOWERED).toBe(0);
    recomputeServices(lit);
    expect(lit.world.covFire[at(100, 100)]).toBe(255);
    expect(serviceStats(lit).services.fire.working).toBe(1);
  });

  it('gives no coverage while the service is unwatered or still being built', () => {
    const sim = uCity(true);
    const s = slotAt(sim, 97, 100);
    sim.world.bFlags[s] = sim.world.bFlags[s]! | BFLAG.UNWATERED;
    recomputeServices(sim);
    expect(sim.world.covFire[at(100, 100)]).toBe(0);
    sim.world.bFlags[s] = BFLAG.CONSTRUCTING;
    recomputeServices(sim);
    expect(sim.world.covFire[at(100, 100)]).toBe(0);
    sim.world.bFlags[s] = 0;
    recomputeServices(sim);
    expect(sim.world.covFire[at(100, 100)]).toBe(255);
  });

  it('covers a disc with parks and robot repair bays, with no roads needed', () => {
    const sim = flatSim();
    place(sim, ARCH.PARK_SMALL, 100, 100);
    place(sim, ARCH.REPAIR_BAY, 150, 150);
    recomputeServices(sim);
    const w = sim.world;
    expect(w.covPark[at(100, 100)]).toBe(255);
    expect(w.covPark[at(104, 100)]).toBeGreaterThan(0);
    expect(w.covPark[at(104, 100)]).toBeLessThan(w.covPark[at(102, 100)]!);
    expect(w.covPark[at(100 + 1 + serviceRadius(ARCH.PARK_SMALL) + 1, 100)]).toBe(0);
    expect(w.covRepair[at(155, 150)]).toBeGreaterThan(0);
    expect(w.covRepair[at(100, 100)]).toBe(0);
    expect(serviceStats(sim).services).toMatchObject({ parks: 1, repairBays: 1 });
  });
});

describe('effects on the city', () => {
  it('raises land value where a service covers, parks included', () => {
    const sim = uCity(true);
    const before = landValueAt(sim.world, 104, 100);
    recomputeServices(sim);
    const covered = landValueAt(sim.world, 104, 100);
    expect(covered).toBeGreaterThan(before);

    const park = flatSim();
    const base = landValueAt(park.world, 120, 120);
    place(park, ARCH.PARK_LARGE, 121, 119);
    recomputeServices(park);
    expect(landValueAt(park.world, 120, 120)).toBeGreaterThanOrEqual(base + 20);
  });

  it('makes a covered lot a better place to grow for houses and shops', () => {
    const sim = flatSim();
    setRoads(sim.world, line(100, 100, 100, 130));
    place(sim, ARCH.FIRE_STATION, 97, 100);
    sim.world.scalars[S.demandR] = 0.5; sim.world.scalars[S.demandC] = 0.5;
    const r0 = lotScore(sim, 101, 112, 1, 1, 1, null)!, c0 = lotScore(sim, 101, 112, 2, 1, 1, null)!;
    recomputeServices(sim);
    expect(lotScore(sim, 101, 112, 1, 1, 1, null)!).toBeGreaterThan(r0);
    expect(lotScore(sim, 101, 112, 2, 1, 1, null)!).toBeGreaterThan(c0);
  });

  it('breeds more crime without police, and abandoned buildings add to it', () => {
    const build = (police: boolean): Sim => {
      const sim = flatSim();
      setRoads(sim.world, line(100, 100, 130, 100));
      if (police) place(sim, ARCH.POLICE, 97, 100);
      for (let k = 0; k < 6; k++) grow(sim, 104 + 4 * k, 98, rciId(1, 1, 1));
      recomputeServices(sim);
      return sim;
    };
    const without = build(false), withPolice = build(true);
    const s0 = slotAt(without, 104, 98), s1 = slotAt(withPolice, 104, 98);
    expect(crimeOf(without.world, s0)).toBeGreaterThan(crimeOf(withPolice.world, s1) + 40);
    expect(without.world.crime[at(104, 98)]).toBe(crimeOf(without.world, s0));
    expect(serviceStats(without).services.crimeIndex).toBeGreaterThan(serviceStats(withPolice).services.crimeIndex);
    const before = crimeOf(without.world, s0);
    without.world.bFlags[s0] = without.world.bFlags[s0]! | BFLAG.ABANDONED;
    expect(crimeOf(without.world, s0)).toBeGreaterThan(before);
  });

  it('favours educated and healthy districts when choosing which buildings level up', () => {
    const sim = flatSim();
    grow(sim, 100, 100, R1);
    grow(sim, 140, 100, R1);
    const w = sim.world;
    w.scalars[S.demandR] = 0.5;
    w.landValue[at(100, 100)] = 110; w.landValue[at(140, 100)] = 110;
    expect(levelUpCandidates(sim, 1, 5)).toEqual([]);
    w.covEdu[at(100, 100)] = 255;
    let list = levelUpCandidates(sim, 1, 5);
    expect(list.map((l) => l.x), 'an educated lot qualifies on a land value that the other lacks').toEqual([100]);
    w.landValue[at(140, 100)] = 130; w.landValue[at(100, 100)] = 130;
    w.covHealth[at(140, 100)] = 120;
    list = levelUpCandidates(sim, 1, 5);
    expect(list.map((l) => l.x)).toEqual([100, 140]);
    expect(list[0]!.score).toBeGreaterThan(list[1]!.score);
  });

  it('puts crime pressure on abandonment', () => {
    const sim = flatSim();
    grow(sim, 100, 100, R1);
    const w = sim.world, s = slotAt(sim, 100, 100);
    w.scalars[S.demandR] = -1;
    w.landValue[at(100, 100)] = 60;
    const strikes = (crime: number): number => {
      w.crime[at(100, 100)] = crime;
      w.bAband[s] = 0;
      updateAbandonment(sim);
      return w.bAband[s]!;
    };
    expect(strikes(0)).toBe(0);
    expect(strikes(255)).toBeGreaterThan(0);
  });
});


describe('determinism with services', () => {
  const build = (): Sim => {
    const sim = flatSim();
    setRoads(sim.world, [...line(95, 100, 150, 100), ...line(125, 100, 125, 140)]);
    place(sim, ARCH.FIRE_STATION, 97, 101);
    place(sim, ARCH.POLICE, 127, 101);
    place(sim, ARCH.SCHOOL, 126, 105);
    place(sim, ARCH.HOSPITAL, 126, 110);
    place(sim, ARCH.PARK_LARGE, 128, 120);
    place(sim, ARCH.REPAIR_BAY, 121, 120);
    for (let k = 0; k < 8; k++) { grow(sim, 102 + 3 * k, 98, rciId(1, 1, 2)); grow(sim, 102 + 3 * k, 101, rciId(2, 0, 1)); }
    return sim;
  };

  it('gives identical hashes for two independent runs', () => {
    const a = build(), b = build();
    runTicks(a, 3 * SERVICE_PERIOD + 7);
    runTicks(b, 3 * SERVICE_PERIOD + 7);
    expect(a.world.covFire.some((v) => v > 0)).toBe(true);
    expect(a.world.crime.some((v) => v > 0)).toBe(true);
    expect(stateHash(a)).toBe(stateHash(b));
  });

  it('resumes from a snapshot taken mid-period to the same hash as an uninterrupted run', () => {
    const straight = build();
    runTicks(straight, 400);
    const first = build();
    runTicks(first, 211);
    const resumed = restore(snapshot(first));
    expect(stateHash(resumed)).toBe(stateHash(first));
    runTicks(resumed, 189);
    expect(stateHash(resumed)).toBe(stateHash(straight));
    expect(serviceStats(resumed).services.health.working).toBe(1);
  });

  it('runs one coverage pass per tick at most, staggered over the period', () => {
    const sim = build();
    const changed: number[] = [];
    for (let i = 0; i < SERVICE_PERIOD; i++) {
      const before = [sim.world.covFire, sim.world.covPolice, sim.world.covHealth, sim.world.covEdu, sim.world.covPark, sim.world.crime].map((l) => l.slice());
      runTicks(sim, 1);
      const now = [sim.world.covFire, sim.world.covPolice, sim.world.covHealth, sim.world.covEdu, sim.world.covPark, sim.world.crime];
      changed.push(now.filter((l, k) => l.some((v, j) => v !== before[k]![j]!)).length);
    }
    expect(Math.max(...changed)).toBeLessThanOrEqual(1);
    expect(changed.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(5);
  });
});
