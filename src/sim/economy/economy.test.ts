import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARCH, BFLAG, rciId } from '../catalog.ts';
import { execute, type Command, type CommandBody } from '../commands.ts';
import { createSim, restore, snapshot, stateHash } from '../engine.ts';
import { bytesOf, fnv1a, hashWorld } from '../hash.ts';
import { PROTOCOL_VERSION } from '../protocol.ts';
import { BUDGET_FIELDS, BUDGET_MONTHS, MAP, MAX_LOANS, REGISTRY, ROAD, S, TERRAIN, ZONE } from '../layers.ts';
import { setRoad, setRoads } from '../roads/testkit.ts';
import { runTicks } from '../testkit.ts';
import type { Sim } from '../world.ts';
import {
  ABANDON_AT, MONTH_TICKS, abandonedBuildings, activeLoans, budgetHistory, budgetMessage, closeMonth, econStats, computeBudget, countTotals, growthCandidates,
  landValueAt, levelUpCandidates, lotScore, pollutionPass, recomputeLandValue, updateAbandonment, zoneDemand,
} from './index.ts';

// These tests tick the whole sim thousands of times; jsdom plus a loaded machine makes 5 s too tight.
vi.setConfig({ testTimeout: 60000 });
// Yield a macrotask between tests so the runner's RPC replies are not starved by a minute of synchronous ticking.
afterEach(() => new Promise<void>((r) => { setTimeout(r, 0); }));

let nextId = 1;
function run(sim: Sim, body: CommandBody): { ok: boolean; reason?: string } {
  sim.events = [];
  const ok = execute(sim, { ...body, id: nextId++, tick: 0 } as Command);
  const e = sim.events[sim.events.length - 1]!;
  return { ok, reason: e.type === 'rejected' ? e.reason : undefined };
}

/** Debug sim on flat grass at height 160 (10 tiles), no water, no roads. */
function flatSim(): Sim {
  const sim = createSim(42, { debug: true });
  const w = sim.world;
  w.terrain.fill(TERRAIN.GRASS);
  w.height.fill(160);
  w.waterDepth.fill(0);
  return sim;
}

const grow = (sim: Sim, x: number, y: number, arch: number, progress = 1): void => {
  const r = run(sim, { type: 'debugGrow', x, y, archetype: arch, progress });
  if (!r.ok) throw new Error(`debugGrow ${arch} at ${x},${y}: ${r.reason}`);
};

const R1 = rciId(1, 0, 1), C1 = rciId(2, 0, 1), I1 = rciId(3, 0, 1);
const demand = (sim: Sim, zone: number): number => zoneDemand(sim.world, zone);

/** Residential row at y = 100 (6 residents each) and industrial row at y = 110 (6 jobs each). */
function addR(sim: Sim, n: number, from: number): void { for (let k = 0; k < n; k++) grow(sim, 20 + 2 * (from + k), 100, R1); }
function addI(sim: Sim, n: number, from: number): void { for (let k = 0; k < n; k++) grow(sim, 20 + 2 * (from + k), 110, I1); }

describe('population and jobs', () => {
  it('counts only completed, non-abandoned RCI buildings', () => {
    const sim = flatSim();
    grow(sim, 20, 100, R1);
    grow(sim, 22, 100, rciId(1, 2, 3));
    grow(sim, 20, 110, C1);
    grow(sim, 22, 110, I1);
    grow(sim, 24, 110, I1, 0.5);
    expect(countTotals(sim.world)).toEqual({ population: 6 + 220, jobsC: 4, jobsI: 6, employed: 10, labor: 113 });
    runTicks(sim, 10);
    const s = sim.world.scalars;
    expect([s[S.population], s[S.jobsC], s[S.jobsI], s[S.employed]]).toEqual([226, 4, 6, 10]);
    expect(s[S.unemployment]).toBe(Math.floor((103 * 1024) / 113) / 1024);
  });
});

describe('RCI demand', () => {
  it('falls as the residential tax rises', () => {
    const sim = flatSim();
    addR(sim, 4, 0);
    addI(sim, 4, 0);
    const seen: number[] = [];
    for (const rate of [0, 4, 9, 14, 20]) {
      run(sim, { type: 'setTax', rate, zone: ZONE.R });
      runTicks(sim, 500);
      seen.push(demand(sim, ZONE.R));
    }
    for (let k = 1; k < seen.length; k++) expect(seen[k]!, `rate step ${k}: ${seen.join(', ')}`).toBeLessThan(seen[k - 1]!);
    expect(seen[0]!).toBeGreaterThan(0.5);
    expect(seen[4]!).toBeLessThan(0);
    expect(demand(sim, ZONE.C)).toBeGreaterThan(-1);
  });

  it('rises with available jobs', () => {
    const sim = flatSim();
    addR(sim, 4, 0);
    const seen: number[] = [];
    let placed = 0;
    for (const more of [0, 2, 2, 2]) {
      addI(sim, more, placed);
      placed += more;
      runTicks(sim, 500);
      seen.push(demand(sim, ZONE.R));
    }
    for (let k = 1; k < seen.length; k++) expect(seen[k]!, seen.join(', ')).toBeGreaterThan(seen[k - 1]!);
    expect(seen[0]!).toBeLessThan(-0.5);
  });

  it('falls as unemployment grows', () => {
    const sim = flatSim();
    addR(sim, 4, 0);
    addI(sim, 2, 0);
    runTicks(sim, 500);
    const seen = [demand(sim, ZONE.R)];
    const unemployment = [sim.world.scalars[S.unemployment]!];
    for (let k = 0; k < 3; k++) {
      addR(sim, 1, 4 + k);
      runTicks(sim, 500);
      seen.push(demand(sim, ZONE.R));
      unemployment.push(sim.world.scalars[S.unemployment]!);
    }
    for (let k = 1; k < seen.length; k++) {
      expect(unemployment[k]!).toBeGreaterThan(unemployment[k - 1]!);
      expect(seen[k]!, seen.join(', ')).toBeLessThan(seen[k - 1]!);
    }
  });

  it('grows commercial demand with population and with industry', () => {
    const sim = flatSim();
    addR(sim, 4, 0);
    runTicks(sim, 500);
    const base = demand(sim, ZONE.C);
    addR(sim, 4, 4);
    runTicks(sim, 500);
    const morePeople = demand(sim, ZONE.C);
    addI(sim, 4, 0);
    runTicks(sim, 500);
    const moreIndustry = demand(sim, ZONE.C);
    expect(morePeople).toBeGreaterThan(base);
    expect(moreIndustry).toBeGreaterThan(morePeople);
  });

  it('keeps every demand in [-1, 1], on the 1/1024 grid, and settles monotonically after each shock over 5,000 ticks', () => {
    const sim = flatSim();
    addR(sim, 4, 0);
    addI(sim, 4, 0);
    const shocks: [number, number][] = [[0, 0], [20, 20], [9, 9], [20, 0], [0, 20], [12, 12], [20, 20], [0, 0], [9, 9], [20, 20]];
    const series: number[][] = [[], [], []];
    for (let seg = 0; seg < 10; seg++) {
      run(sim, { type: 'setTax', rate: shocks[seg]![0], zone: ZONE.R });
      run(sim, { type: 'setTax', rate: shocks[seg]![1], zone: ZONE.I });
      for (let t = 0; t < 500; t++) {
        runTicks(sim, 1);
        for (let z = 1; z <= 3; z++) {
          const d = demand(sim, z);
          expect(d).toBeGreaterThanOrEqual(-1);
          expect(d).toBeLessThanOrEqual(1);
          expect(d * 1024).toBe(Math.round(d * 1024));
          if (t % 10 === 9) series[z - 1]![seg * 50 + (t - 9) / 10] = d;
        }
      }
      for (let z = 0; z < 3; z++) {
        const part = series[z]!.slice(seg * 50, seg * 50 + 50);
        const diffs = part.slice(1).map((v, k) => v - part[k]!);
        const ups = diffs.filter((d) => d > 0).length, downs = diffs.filter((d) => d < 0).length;
        expect(Math.min(ups, downs), `zone ${z + 1} segment ${seg}: ${part.join(' ')}`).toBe(0);
      }
    }
  }, 60000);
});

describe('monthly budget', () => {
  function syntheticCity(): Sim {
    const sim = flatSim();
    const w = sim.world;
    setRoads(w, Array.from({ length: 10 }, (_, k) => [100 + k, 50, 1] as const));
    setRoads(w, Array.from({ length: 3 }, (_, k) => [100 + k, 52, 2] as const));
    setRoads(w, Array.from({ length: 2 }, (_, k) => [100 + k, 54, 3] as const));
    setRoad(w, 120, 56, 1, ROAD.BRIDGE);
    grow(sim, 110, 60, R1);
    grow(sim, 112, 60, C1);
    grow(sim, 114, 60, I1);
    expect(run(sim, { type: 'placeBuilding', arch: ARCH.DEPOT, x: 130, y: 60, rot: 0 }).ok).toBe(true);
    expect(run(sim, { type: 'placeBuilding', arch: ARCH.FIRE_STATION, x: 140, y: 60, rot: 0 }).ok).toBe(true);
    expect(run(sim, { type: 'setTax', rate: 10, zone: ZONE.R }).ok).toBe(true);
    expect(run(sim, { type: 'setTax', rate: 20, zone: ZONE.C }).ok).toBe(true);
    expect(run(sim, { type: 'setTax', rate: 5, zone: ZONE.I }).ok).toBe(true);
    expect(run(sim, { type: 'takeLoan', tier: 0 }).ok).toBe(true);
    expect(run(sim, { type: 'takeLoan', tier: 2 }).ok).toBe(true);
    w.landValue.fill(100);
    return sim;
  }

  it('matches the hand-computed income, maintenance, upkeep and interest', () => {
    const sim = syntheticCity();
    const w = sim.world;
    const before = w.scalars[S.treasury]!;
    const b = computeBudget(w, 0);
    // R: 6 residents, wealth 24 + (100*72>>8) = 52, floor(6*52*10/100) = 31.
    // Labour 3, jobs 4 + 6 = 10, employed 3. C: floor(4*3/10) = 1 payer, wealth 32 + 31 = 63, floor(63*20/100) = 12.
    // I: floor(6*3/10) = 1 payer, wealth 28 + 15 = 43, floor(43*5/100) = 2.
    expect([b.incomeR, b.incomeC, b.incomeI, b.income]).toEqual([31, 12, 2, 45]);
    // Roads: 10 streets * 2 + 3 avenues * 4 + 2 highways * 8 + one street bridge (2 + 6) = 56. Depot 20 + fire station 60 = 80.
    // Interest: 10000 * 50bp = 50 and 50000 * 90bp = 450.
    expect([b.roads, b.services, b.interest, b.expenses]).toEqual([56, 80, 500, 636]);
    expect([b.net, b.population, b.treasury]).toEqual([-591, 6, before - 591]);
    expect(w.scalars[S.treasury]).toBe(before);
  });

  it('closeMonth pays the treasury, stores the record, and the ring keeps the last 12 months', () => {
    const sim = syntheticCity();
    const w = sim.world;
    const before = w.scalars[S.treasury]!;
    const r = closeMonth(sim);
    expect(w.scalars[S.treasury]).toBe(before + r.net);
    expect(w.scalars[S.month]).toBe(1);
    expect(budgetHistory(w)).toEqual([r]);
    for (let k = 0; k < 13; k++) closeMonth(sim);
    const h = budgetHistory(w);
    expect(h).toHaveLength(BUDGET_MONTHS);
    expect(h.map((x) => x.month)).toEqual(Array.from({ length: BUDGET_MONTHS }, (_, k) => k + 2));
    expect(w.budget.length).toBe(BUDGET_MONTHS * BUDGET_FIELDS);
  });

  it('pays the budget into the treasury exactly at the month boundary while ticking', () => {
    const sim = syntheticCity();
    const w = sim.world;
    // Months close at midnight. A new city opens at 07:00, so its first (prorated) month closes before MONTH_TICKS have run.
    runTicks(sim, MONTH_TICKS - w.scalars[S.tickOfDay]! - 20);
    expect(w.scalars[S.month]).toBe(0);
    const before = w.scalars[S.treasury]!;
    runTicks(sim, 40);
    expect(w.scalars[S.month]).toBe(1);
    const last = budgetHistory(w)[0]!;
    expect(w.scalars[S.treasury]! - before).toBe(last.net);
    expect(last.expenses).toBeGreaterThan(0);
  }, 60000);

  it('warns after three months below zero and recovers when the treasury turns positive', () => {
    const sim = flatSim();
    const w = sim.world;
    w.scalars[S.treasury] = -1000;
    const seen = () => sim.events.filter((e) => e.type === 'bankruptcy');
    closeMonth(sim); closeMonth(sim);
    expect(seen()).toHaveLength(0);
    closeMonth(sim);
    expect(seen()).toMatchObject([{ type: 'bankruptcy', months: 3 }]);
    closeMonth(sim);
    expect(seen(), 'a longer stay in debt does not repeat the warning').toHaveLength(1);
    w.scalars[S.treasury] = 5000;
    closeMonth(sim);
    expect(w.scalars[S.lowMonths]).toBe(0);
    w.scalars[S.treasury] = -1;
    closeMonth(sim); closeMonth(sim);
    expect(seen()).toHaveLength(1);
    closeMonth(sim);
    expect(seen()).toHaveLength(2);
  });

  it('jumps the month counter when the clock is far ahead, without paying the missed months', () => {
    const sim = syntheticCity();
    const w = sim.world;
    const before = w.scalars[S.treasury]!;
    w.scalars[S.day] = 5;
    runTicks(sim, 1);
    expect(w.scalars[S.month]).toBe(5);
    expect(w.scalars[S.treasury]).toBe(before);
    expect(budgetHistory(w)).toEqual([]);
    w.scalars[S.day] = 6;
    runTicks(sim, 1);
    expect(w.scalars[S.month]).toBe(6);
    expect(budgetHistory(w)).toHaveLength(1);
  });

  it('rejects a snapshot written under the previous protocol version', () => {
    const buf = snapshot(flatSim());
    new DataView(buf.buffer).setUint16(6, PROTOCOL_VERSION - 1, true);
    new DataView(buf.buffer).setUint32(buf.length - 4, fnv1a(buf.subarray(0, buf.length - 4)), true);
    expect(() => restore(buf)).toThrow(/protocol version/);
  });
});

describe('tax and loan commands', () => {
  it('sets one zone or all three and rejects out-of-range rates', () => {
    const sim = flatSim();
    const s = sim.world.scalars;
    expect(run(sim, { type: 'setTax', rate: 14, zone: ZONE.C }).ok).toBe(true);
    expect([s[S.taxR], s[S.taxC], s[S.taxI]]).toEqual([9, 14, 9]);
    expect(run(sim, { type: 'setTax', rate: 3 }).ok).toBe(true);
    expect([s[S.taxR], s[S.taxC], s[S.taxI]]).toEqual([3, 3, 3]);
    expect(run(sim, { type: 'setTax', rate: 21 })).toEqual({ ok: false, reason: 'bounds' });
    expect(run(sim, { type: 'setTax', rate: -1 })).toEqual({ ok: false, reason: 'bounds' });
    expect(run(sim, { type: 'setTax', rate: 5, zone: 4 })).toEqual({ ok: false, reason: 'bounds' });
    expect(run(sim, { type: 'setTax', rate: 5.5 })).toEqual({ ok: false, reason: 'invalid' });
    expect([s[S.taxR], s[S.taxC], s[S.taxI]]).toEqual([3, 3, 3]);
  });

  it('limits loans to three, takes the principal at once and repays in full', () => {
    const sim = flatSim();
    const w = sim.world;
    const t0 = w.scalars[S.treasury]!;
    expect(run(sim, { type: 'takeLoan', tier: 3 })).toEqual({ ok: false, reason: 'invalid' });
    for (const tier of [0, 1, 2]) expect(run(sim, { type: 'takeLoan', tier }).ok).toBe(true);
    expect(w.scalars[S.treasury]).toBe(t0 + 10000 + 25000 + 50000);
    expect(run(sim, { type: 'takeLoan', tier: 0 })).toEqual({ ok: false, reason: 'max-loans' });
    expect(activeLoans(w)).toEqual([{ slot: 0, principal: 10000, bp: 50 }, { slot: 1, principal: 25000, bp: 70 }, { slot: 2, principal: 50000, bp: 90 }]);
    expect(computeBudget(w, 0).interest).toBe(50 + 175 + 450);

    expect(run(sim, { type: 'repayLoan', slot: 1 }).ok).toBe(true);
    expect(w.scalars[S.treasury]).toBe(t0 + 10000 + 50000);
    expect(activeLoans(w).map((l) => l.slot)).toEqual([0, 2]);
    expect(run(sim, { type: 'repayLoan', slot: 1 })).toEqual({ ok: false, reason: 'no-loan' });
    expect(run(sim, { type: 'repayLoan', slot: 7 })).toEqual({ ok: false, reason: 'invalid' });
    expect(run(sim, { type: 'takeLoan', tier: 1 }).ok).toBe(true);
    expect(activeLoans(w)[1]).toEqual({ slot: 1, principal: 25000, bp: 70 });

    w.scalars[S.treasury] = 100;
    expect(run(sim, { type: 'repayLoan', slot: 2 })).toEqual({ ok: false, reason: 'funds' });
    expect(w.scalars[S.treasury]).toBe(100);
    expect(MAX_LOANS).toBe(3);
  });
});

describe('land value and pollution', () => {
  it('is higher near water and lower near industry', () => {
    const sim = flatSim();
    const w = sim.world;
    for (let y = 100; y <= 160; y++) for (let x = 40; x <= 56; x++) w.terrain[y * MAP + x] = TERRAIN.WATER;
    grow(sim, 180, 128, rciId(3, 2, 3));
    for (let k = 0; k < 80; k++) pollutionPass(sim);
    recomputeLandValue(sim);
    const nearWater = w.landValue[128 * MAP + 58]!, farFromWater = w.landValue[128 * MAP + 120]!;
    expect(nearWater).toBeGreaterThan(farFromWater + 20);
    const nearIndustry = w.landValue[128 * MAP + 184]!, farFromIndustry = w.landValue[128 * MAP + 230]!;
    expect(w.pollution[128 * MAP + 184]!).toBeGreaterThan(0);
    expect(nearIndustry).toBeLessThan(farFromIndustry - 10);
    expect(landValueAt(w, 50, 128)).toBe(0);
  });

  it('rewards road access and the service-coverage term, and clamps to 0..255', () => {
    const sim = flatSim();
    const w = sim.world;
    const base = landValueAt(w, 100, 100);
    setRoads(w, [[101, 100, 1]]);
    expect(landValueAt(w, 100, 100)).toBe(base + 24);
    expect(landValueAt(w, 102 + 1, 100)).toBe(base + 12);
    w.covFire[100 * MAP + 100] = 255; w.covPolice[100 * MAP + 100] = 255; w.covHealth[100 * MAP + 100] = 255; w.covEdu[100 * MAP + 100] = 255;
    expect(landValueAt(w, 100, 100)).toBe(base + 24 + 31);
    w.pollution[100 * MAP + 100] = 255;
    expect(landValueAt(w, 100, 100)).toBe(base + 24 + 31 - 127);
  });

  it('spreads from an industrial building, reaches a steady field, then decays to zero after demolition', () => {
    const sim = flatSim();
    const w = sim.world;
    grow(sim, 180, 128, rciId(3, 2, 3));
    const at = (x: number): number => w.pollution[129 * MAP + x]!;
    expect(w.pollution.every((v) => v === 0)).toBe(true);
    pollutionPass(sim);
    expect(at(181)).toBeGreaterThan(0);
    expect(at(176)).toBe(0);
    let passes = 1, prevTotal = -1;
    while (w.scalars[S.pollTotal] !== prevTotal && passes < 400) { prevTotal = w.scalars[S.pollTotal]!; pollutionPass(sim); passes++; }
    expect(passes, 'a steady field within 400 passes').toBeLessThan(400);
    const steady = w.pollution.slice();
    expect(at(181)).toBeGreaterThan(at(184));
    expect(at(184)).toBeGreaterThan(at(187));
    expect(at(187)).toBeGreaterThan(0);
    expect(at(120)).toBe(0);
    pollutionPass(sim);
    expect(Array.from(w.pollution)).toEqual(Array.from(steady));
    expect(Math.max(...w.pollution)).toBeLessThanOrEqual(255);

    expect(run(sim, { type: 'bulldoze', x0: 180, y0: 128, x1: 182, y1: 130 }).ok).toBe(true);
    let left = 0;
    while (w.scalars[S.pollTotal]! > 0 && left < 400) { pollutionPass(sim); left++; }
    expect(w.scalars[S.pollTotal]).toBe(0);
    expect(w.pollution.every((v) => v === 0)).toBe(true);
    expect(left).toBeGreaterThan(5);
  });

  it('marks overlay chunks dirty when the fields change', () => {
    const sim = flatSim();
    grow(sim, 180, 128, rciId(3, 1, 1));
    sim.dirty.overlay.clear();
    pollutionPass(sim);
    expect(sim.dirty.overlay.size).toBeGreaterThan(0);
    sim.dirty.overlay.clear();
    recomputeLandValue(sim);
    expect(sim.dirty.overlay.size).toBeGreaterThan(0);
  });
});

describe('lot desirability', () => {
  function lotCity(): Sim {
    const sim = flatSim();
    const w = sim.world;
    expect(run(sim, { type: 'placeBuilding', arch: ARCH.DEPOT, x: 50, y: 50, rot: 0 }).ok).toBe(true);
    setRoads(w, Array.from({ length: 31 }, (_, k) => [40 + k, 52, 1] as const));
    setRoads(w, Array.from({ length: 11 }, (_, k) => [100 + k, 52, 1] as const));
    expect(run(sim, { type: 'zone', x0: 45, y0: 53, x1: 47, y1: 53, zone: ZONE.R, density: 0 }).ok).toBe(true);
    expect(run(sim, { type: 'zone', x0: 62, y0: 53, x1: 63, y1: 54, zone: ZONE.R, density: 1 }).ok).toBe(true);
    expect(run(sim, { type: 'zone', x0: 105, y0: 53, x1: 105, y1: 53, zone: ZONE.R, density: 0 }).ok).toBe(true);
    expect(run(sim, { type: 'zone', x0: 150, y0: 150, x1: 152, y1: 152, zone: ZONE.R, density: 0 }).ok).toBe(true);
    expect(run(sim, { type: 'zone', x0: 55, y0: 53, x1: 56, y1: 53, zone: ZONE.C, density: 0 }).ok).toBe(true);
    for (let y = 100; y <= 160; y++) for (let x = 20; x <= 36; x++) w.terrain[y * MAP + x] = TERRAIN.WATER;
    recomputeLandValue(sim);
    return sim;
  }

  it('lists only zoned, empty lots on roads reachable from a depot, best first', () => {
    const sim = lotCity();
    const lots = growthCandidates(sim, ZONE.R, 10);
    expect(lots.map((l) => `${l.x},${l.y},${l.w}`)).toEqual(['45,53,1', '46,53,1', '47,53,1', '62,53,2']);
    expect(lots.some((l) => l.x === 105)).toBe(false);
    expect(lots.some((l) => l.x === 150)).toBe(false);
    for (let k = 1; k < lots.length; k++) expect(lots[k - 1]!.score).toBeGreaterThanOrEqual(lots[k]!.score);
    expect(lots.every((l) => l.access >= 0 && (sim.world.road[l.access]! & ROAD.CLASS_MASK) !== 0)).toBe(true);
    expect(growthCandidates(sim, ZONE.R, 2)).toHaveLength(2);
    expect(growthCandidates(sim, ZONE.R, 0)).toEqual([]);
    expect(growthCandidates(sim, ZONE.C, 10).map((l) => l.x)).toEqual([55, 56]);
    expect(growthCandidates(sim, ZONE.I, 10)).toEqual([]);
  });

  it('is deterministic, drops occupied lots, and ranks by land value then tile index', () => {
    const a = lotCity(), b = lotCity();
    expect(growthCandidates(a, ZONE.R, 10)).toEqual(growthCandidates(b, ZONE.R, 10));
    a.world.landValue[53 * MAP + 47] = 200;
    const ranked = growthCandidates(a, ZONE.R, 10);
    expect(ranked[0]!.x).toBe(47);
    expect(ranked.slice(1).map((l) => l.x)).toEqual([45, 46, 62]);
    grow(a, 45, 53, R1);
    expect(growthCandidates(a, ZONE.R, 10).some((l) => l.x === 45)).toBe(false);
  });

  it('treats every bordering road as reachable once no depot exists', () => {
    const sim = lotCity();
    expect(run(sim, { type: 'bulldoze', x0: 50, y0: 50, x1: 51, y1: 51 }).ok).toBe(true);
    expect(growthCandidates(sim, ZONE.R, 10).some((l) => l.x === 105)).toBe(true);
  });

  it('reaches nothing when depots exist but none borders a road', () => {
    const sim = lotCity();
    expect(run(sim, { type: 'bulldoze', x0: 50, y0: 50, x1: 51, y1: 51 }).ok).toBe(true);
    expect(run(sim, { type: 'placeBuilding', arch: ARCH.DEPOT, x: 200, y: 200, rot: 0 }).ok).toBe(true);
    expect(growthCandidates(sim, ZONE.R, 10)).toEqual([]);
    expect(lotScore(sim, 45, 53, ZONE.R)).toBeNull();
  });

  it('scores a lot from demand, land value, pollution and access, or null without a reachable road', () => {
    const sim = lotCity();
    const w = sim.world;
    const clean = lotScore(sim, 45, 53, ZONE.R)!;
    expect(clean).not.toBeNull();
    w.pollution[53 * MAP + 45] = 100;
    expect(lotScore(sim, 45, 53, ZONE.R)!).toBe(clean - 400);
    w.pollution[53 * MAP + 45] = 0;
    w.scalars[S.demandR] = 0.5;
    expect(lotScore(sim, 45, 53, ZONE.R)!).toBe(clean + 512);
    expect(lotScore(sim, 105, 53, ZONE.R)).toBeNull();
    expect(lotScore(sim, 150, 150, ZONE.R)).toBeNull();
    expect(lotScore(sim, -1, 0, ZONE.R)).toBeNull();
    expect(lotScore(sim, 45, 53, 9)).toBeNull();
  });
});

describe('abandonment and level-up candidates', () => {
  it('flags a building after sustained low desirability with negative demand, then clears it on recovery', () => {
    const sim = flatSim();
    const w = sim.world;
    grow(sim, 100, 100, R1);
    grow(sim, 102, 100, R1);
    const slot = w.bId[100 * MAP + 100]! - 1, other = w.bId[100 * MAP + 102]! - 1;
    w.landValue[100 * MAP + 100] = 10;
    w.landValue[100 * MAP + 102] = 100;
    w.scalars[S.demandR] = -0.5;
    sim.dirty.buildings.clear();
    for (let k = 0; k < ABANDON_AT - 1; k++) updateAbandonment(sim);
    expect(abandonedBuildings(w)).toEqual([]);
    updateAbandonment(sim);
    expect(abandonedBuildings(w)).toEqual([slot]);
    expect(w.bFlags[slot]! & BFLAG.ABANDONED).toBe(BFLAG.ABANDONED);
    expect(w.bFlags[other]! & BFLAG.ABANDONED).toBe(0);
    expect(sim.dirty.buildings.has(slot)).toBe(true);
    expect(countTotals(w).population).toBe(6);

    w.scalars[S.demandR] = 0.2;
    for (let k = 0; k < 30; k++) updateAbandonment(sim);
    expect(abandonedBuildings(w)).toEqual([slot]);
    for (let k = 0; k < 5; k++) updateAbandonment(sim);
    expect(abandonedBuildings(w)).toEqual([]);
    expect(countTotals(w).population).toBe(12);
  });

  it('never flags a building while demand is not negative enough', () => {
    const sim = flatSim();
    grow(sim, 100, 100, R1);
    sim.world.landValue[100 * MAP + 100] = 0;
    sim.world.scalars[S.demandR] = -0.2;
    for (let k = 0; k < 400; k++) updateAbandonment(sim);
    expect(abandonedBuildings(sim.world)).toEqual([]);
  });

  it('lists level-up candidates by land value while demand is strong', () => {
    const sim = flatSim();
    const w = sim.world;
    grow(sim, 100, 100, R1);
    grow(sim, 102, 100, R1);
    grow(sim, 104, 100, rciId(1, 0, 3));
    grow(sim, 106, 100, R1, 0.5);
    for (const x of [100, 102, 104, 106]) w.landValue[100 * MAP + x] = 150;
    w.landValue[100 * MAP + 102] = 180;
    w.scalars[S.demandR] = 0.5;
    const list = levelUpCandidates(sim, ZONE.R, 10);
    expect(list.map((c) => c.x)).toEqual([102, 100]);
    expect(list[0]).toMatchObject({ arch: R1, nextArch: R1 + 1, level: 1 });
    expect(levelUpCandidates(sim, ZONE.R, 1)).toHaveLength(1);
    w.scalars[S.demandR] = 0.1;
    expect(levelUpCandidates(sim, ZONE.R, 10)).toEqual([]);
    w.scalars[S.demandR] = 0.5;
    w.landValue[100 * MAP + 100] = 100;
    expect(levelUpCandidates(sim, ZONE.R, 10).map((c) => c.x)).toEqual([102]);
  });

  it('skips burning and damaged buildings, which a level-up would extinguish and heal', () => {
    const sim = flatSim();
    const w = sim.world;
    grow(sim, 100, 100, R1);
    grow(sim, 102, 100, R1);
    grow(sim, 104, 100, R1);
    for (const x of [100, 102, 104]) w.landValue[100 * MAP + x] = 150;
    w.scalars[S.demandR] = 0.5;
    expect(levelUpCandidates(sim, ZONE.R, 10).map((c) => c.x)).toEqual([100, 102, 104]);
    const burning = w.bId[100 * MAP + 100]! - 1, hurt = w.bId[100 * MAP + 102]! - 1;
    w.bFlags[burning] = w.bFlags[burning]! | BFLAG.BURNING;
    expect(levelUpCandidates(sim, ZONE.R, 10).map((c) => c.x)).toEqual([102, 104]);
    w.bDmg[hurt] = 1;
    expect(levelUpCandidates(sim, ZONE.R, 10).map((c) => c.x)).toEqual([104]);
  });
});

describe('registry and persistence', () => {
  it('declares the economy layers in the registry', () => {
    const names = REGISTRY.map((l) => l.name as string);
    for (const n of ['bAband', 'loanAmt', 'loanBp', 'budget']) expect(names).toContain(n);
    const sim = flatSim();
    const base = hashWorld(sim.world);
    for (const n of ['bAband', 'loanAmt', 'loanBp', 'budget'] as const) {
      const bytes = bytesOf(sim.world[n]);
      bytes[0] = bytes[0]! ^ 1;
      expect(hashWorld(sim.world), n).not.toBe(base);
      bytes[0] = bytes[0]! ^ 1;
    }
  });

  function activeCity(): Sim {
    const sim = flatSim();
    setRoads(sim.world, Array.from({ length: 30 }, (_, k) => [100 + k, 80, 1] as const));
    addR(sim, 6, 0);
    addI(sim, 3, 0);
    grow(sim, 100, 120, C1);
    grow(sim, 110, 120, rciId(3, 2, 2));
    run(sim, { type: 'setTax', rate: 15, zone: ZONE.R });
    run(sim, { type: 'takeLoan', tier: 1 });
    return sim;
  }

  it('answers budget and stats requests without touching the world', () => {
    const sim = activeCity();
    runTicks(sim, 30);
    const before = stateHash(sim);
    const msg = budgetMessage(sim.world, 7);
    const stats = econStats(sim.world);
    expect(stateHash(sim)).toBe(before);
    expect(msg).toMatchObject({ type: 'budget', id: 7, month: 0, history: [], taxRates: [15, 9, 9] });
    expect(msg.current.month).toBe(0);
    expect(msg.loans).toEqual([{ slot: 0, principal: 25000, bp: 70 }]);
    expect(stats.rciDemand).toHaveLength(3);
    expect(stats.rciDemand.every((d) => d >= -1 && d <= 1)).toBe(true);
    expect(stats).toMatchObject({ taxRates: [15, 9, 9], month: 0, lastMonth: { month: -1, net: 0 }, debtMonths: 0 });
  });

  it('resumes from a snapshot: 100 + restore + 100 equals 200 straight, with the economy running', () => {
    const straight = activeCity();
    runTicks(straight, 200);
    const first = activeCity();
    runTicks(first, 100);
    const resumed = restore(snapshot(first));
    expect(stateHash(resumed)).toBe(stateHash(first));
    runTicks(resumed, 100);
    expect(stateHash(resumed)).toBe(stateHash(straight));
    expect(straight.world.scalars[S.population]).toBeGreaterThan(0);
    expect(straight.world.landValue.some((v) => v > 0)).toBe(true);
  });

  it('resumes across a month boundary and the treasury moves by the month net', () => {
    const straight = activeCity();
    runTicks(straight, MONTH_TICKS - straight.world.scalars[S.tickOfDay]! - 100);
    const mid = snapshot(straight);
    const treasuryBefore = straight.world.scalars[S.treasury]!;
    runTicks(straight, 200);
    const resumed = restore(mid);
    runTicks(resumed, 200);
    expect(stateHash(resumed)).toBe(stateHash(straight));
    expect(straight.world.scalars[S.month]).toBe(1);
    const last = budgetHistory(straight.world)[0]!;
    expect(straight.world.scalars[S.treasury]! - treasuryBefore).toBe(last.net);
    expect(last.population).toBeGreaterThan(0);
    // 25,000 at 70 bp is 175 a month; the first month ran from 07:00 to midnight, 3360 of 4800 ticks.
    expect(last.interest).toBe(Math.floor((175 * (MONTH_TICKS - 1440)) / MONTH_TICKS));
  }, 60000);
});
