import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARCH, BFLAG, archetype, rciId } from './catalog.ts';
import { execute, type Command, type CommandBody } from './commands.ts';
import { approvalTarget } from './council/index.ts';
import { destroyBuilding } from './disasters/index.ts';
import { closeMonth, computeBudget, countTotals, demandTargets, emissionOf, landValueAt } from './economy/index.ts';
import { createSim, restore, snapshot, stateHash, step } from './engine.ts';
import {
  BAY_BUILDERS, BRANCH, DEPOT_SLOTS, EDICT, EDICTS, EDICT_COUNT, EDICT_NUMBERS, LAB_MAX, LAB_RP, MAX_EDICTS, MODULE, MODULES, NODE, NODE_COUNT, PAD_HAULERS,
  RESEARCH_NODES, WORKSHOP_RADIUS, buildSpeed, computeMods, depotCaps, edictUpkeep, firmwareStats, isNight, mods, moduleAt, poweredLabs, populationRp,
  rpPerMonth, workshopBonus, type Mods,
} from './firmware.ts';
import { BMAX, F, MAP, REGISTRY, S, type World } from './layers.ts';
import { PURPOSE, isTaxi, recordTrip } from './traffic/index.ts';
import { crimeOf, discPass } from './services/index.ts';
import { MAX_TIER } from './unlocks.ts';
import { roadsOf } from './roads/index.ts';
import { AKIND, AST, BUILDER_SPEED, DEPOT_START_STOCK, FIREFIGHTER_SPEED, HAULER_SPEED, JOB_MAX, materialFor } from './robots/constants.ts';
import { growthDirector, materialSystem } from './robots/index.ts';
import { refOf, spawnAgent } from './robots/pool.ts';
import { startTrip, stepAgent } from './robots/move.ts';
import { agents, depot, depots, flatSim, grown, road, run, zone } from './robots/testkit.ts';
import { runScripted, runTicks, scriptedCity } from './testkit.ts';
import type { Sim } from './world.ts';

vi.setConfig({ testTimeout: 120000 });
afterEach(() => new Promise<void>((r) => { setTimeout(r, 0); }));

const BASE = computeMods(0, 0);
const bit = (...n: number[]): number => n.reduce((m, k) => m | (1 << k), 0);

/** Run a command through the real executor; 'ok' or the rejection reason. */
let nextId = 5000;
function tryCmd(sim: Sim, body: CommandBody): string {
  const before = sim.events.length;
  execute(sim, { ...body, id: nextId++, tick: 0 } as Command);
  const e = sim.events[before]!;
  return e.type === 'rejected' ? e.reason : 'ok';
}

describe('registry completeness', () => {
  it('has 3 branches of 4 nodes, each a chain with a positive cost', () => {
    expect(NODE_COUNT).toBe(12);
    RESEARCH_NODES.forEach((n, i) => {
      expect(n.id).toBe(i);
      expect(n.cost).toBeGreaterThan(0);
      expect(n.effect.length).toBeGreaterThan(5);
      expect(n.branch).toBe(Math.floor(i / 4));
      expect(n.prereq).toBe(i % 4 === 0 ? -1 : i - 1);
    });
    expect([BRANCH.LOGISTICS, BRANCH.CONSTRUCTION, BRANCH.CIVIC]).toEqual([0, 1, 2]);
    expect(new Set(Object.values(NODE)).size).toBe(12);
    expect(Math.max(...Object.values(NODE))).toBe(11);
  });

  it('has 8 edicts with tiers the city can reach, an effect list and unique names', () => {
    expect(EDICT_COUNT).toBe(8);
    EDICTS.forEach((e, i) => {
      expect(e.id).toBe(i);
      expect(e.tier).toBeGreaterThanOrEqual(1);
      expect(e.tier).toBeLessThanOrEqual(MAX_TIER);
      expect(e.effects.length).toBeGreaterThan(0);
      expect(e.effects.some((x) => x.good)).toBe(true);
    });
    expect(new Set(EDICTS.map((e) => e.name)).size).toBe(8);
    expect(new Set(Object.values(EDICT)).size).toBe(8);
    expect(MAX_EDICTS).toBe(4);
  });

  it('has the four depot modules with a price, and two slots per depot', () => {
    expect(MODULES.map((m) => m.name)).toEqual(['Empty', 'Builder Bay', 'Hauler Pad', 'Drone Nest', 'Workshop']);
    for (const m of MODULES.slice(1)) expect(m.cost).toBeGreaterThan(0);
    expect(DEPOT_SLOTS).toBe(2);
  });

  it('keeps firmware state in registry layers (so it is hashed, saved and mirrored by the same rules)', () => {
    const names = REGISTRY.map((l) => l.name);
    expect(names).toContain('firmware');
    expect(names).toContain('bMod');
  });

  it('puts the Robotics Lab in the catalog, placeable at Settlement', () => {
    const lab = archetype(ARCH.ROBOTICS_LAB)!;
    expect(lab.placeable).toBe(true);
    expect(lab.unlock).toBe(1);
    expect(lab.cost).toBeGreaterThan(0);
  });
});

describe('mods(): each node and each edict changes exactly its documented constants', () => {
  const NODE_EFFECT: Record<number, Partial<Mods>> = {
    [NODE.HEAVY_LIFTERS]: { haulCap: 6 },
    [NODE.ROTOR_UPGRADE]: { haulerSpeed: 1.2 },
    [NODE.DEPOT_FAB]: { haulersPerDepot: 5 },
    [NODE.LONG_RANGE]: { workRadius: 60 },
    [NODE.QUICK_SET]: { buildRate: 1.25 },
    [NODE.CREW_COORD]: { buildersPerJob: 4 },
    [NODE.PARALLEL_FAB]: { extraJobsPerDepot: 1 },
    [NODE.REBUILD]: { autoRebuild: true },
    [NODE.FLEET_SHARE]: { taxiShare: 51 },
    [NODE.RAPID_DRONES]: { ffSpeed: 1.3 },
    [NODE.EXTENDED_BAYS]: { repairRadius: 1.5 },
    [NODE.PRIORITY_LANES]: { jamSlow: 0 },
  };
  const EDICT_EFFECT: Record<number, Partial<Mods>> = {
    [EDICT.NIGHT_SHIFT]: { nightBuild: 1.4, depotPollution: 60, approval: -3 },
    [EDICT.OVERCLOCK]: { haulerSpeed: 1.3, breakdown: 262, breakdownTicks: 30, edictCost: 100 },
    [EDICT.ROBO_TAXIS]: { taxiShare: 85, commuteRescue: 0.4, edictCost: 400, approval: 5 },
    [EDICT.SMOG_PERMIT]: { industryOutput: 1.5, industryPollution: 1.5, demandI: 154, approval: -5 },
    [EDICT.CURFEW]: { crime: 0.75, incomeC: 0.9, edictCost: 150, approval: -6 },
    [EDICT.GREEN_ROOFS]: { landValue: 5, greenUpkeep: 2, approval: 3 },
    [EDICT.TAX_HOLIDAY]: { demandR: 205, incomeR: 0.7, approval: 4 },
    [EDICT.RECYCLING]: { recycle: 0.5, edictCost: 150 },
  };

  function expectOnly(got: Mods, want: Partial<Mods>): void {
    for (const key of Object.keys(BASE) as (keyof Mods)[]) {
      const expected = key in want ? want[key] : BASE[key];
      if (typeof expected === 'number') expect(got[key] as number, key).toBeCloseTo(expected, 9);
      else expect(got[key], key).toBe(expected);
    }
  }

  it('the base city has every modifier at its neutral value', () => {
    expect(BASE.haulCap).toBe(4);
    expect(BASE.haulersPerDepot).toBe(4);
    expect(BASE.buildersPerDepot).toBe(4);
    expect(BASE.buildersPerJob).toBe(3);
    expect(BASE.workRadius).toBe(40);
    expect(BASE.taxiShare).toBe(34);
    expect(BASE.buildRate).toBe(1);
    expect(BASE.haulerSpeed).toBe(1);
    expect(BASE.autoRebuild).toBe(false);
    expect(BASE.edictCost).toBe(0);
  });

  for (const n of RESEARCH_NODES) {
    it(`node ${n.id} (${n.name}) changes ${Object.keys(NODE_EFFECT[n.id]!).join(', ')} and nothing else`, () => {
      expectOnly(computeMods(bit(n.id), 0), NODE_EFFECT[n.id]!);
    });
  }

  for (const e of EDICTS) {
    it(`edict ${e.id} (${e.name}) changes ${Object.keys(EDICT_EFFECT[e.id]!).join(', ')} and nothing else`, () => {
      expectOnly(computeMods(0, bit(e.id)), EDICT_EFFECT[e.id]!);
    });
  }

  it('reads through the world: mods(world) follows the two masks and is cached per pair', () => {
    const sim = createSim(1, { debug: true });
    expect(mods(sim.world)).toBe(mods(sim.world));
    expect(mods(sim.world).haulCap).toBe(4);
    sim.world.firmware[F.RESEARCH] = bit(NODE.HEAVY_LIFTERS);
    expect(mods(sim.world).haulCap).toBe(6);
    sim.world.firmware[F.EDICTS] = bit(EDICT.OVERCLOCK);
    expect(mods(sim.world).haulerSpeed).toBeCloseTo(1.3, 9);
    expect(mods(sim.world)).toBe(mods(sim.world));
  });

  it('combines a node and an edict that touch the same constant by multiplying them', () => {
    expect(computeMods(bit(NODE.ROTOR_UPGRADE), bit(EDICT.OVERCLOCK)).haulerSpeed).toBeCloseTo(1.2 * 1.3, 9);
    expect(computeMods(bit(NODE.FLEET_SHARE), bit(EDICT.ROBO_TAXIS)).taxiShare).toBe(Math.round(34 * 1.5 * 2.5));
  });
});

describe('research points', () => {
  it('the population curve is flat at zero, rises, never falls and tops out', () => {
    expect(populationRp(0)).toBe(0);
    let prev = 0;
    for (let p = 0; p <= 120000; p += 250) { const v = populationRp(p); expect(v).toBeGreaterThanOrEqual(prev); prev = v; }
    expect(populationRp(500)).toBeLessThan(populationRp(5000));
    expect(populationRp(80000)).toBe(populationRp(500000));
  });

  it('a closed month pays population, claimed directives and powered labs, and the stat shows the breakdown', () => {
    const sim = flatSim(3, true);
    const w = sim.world;
    w.scalars[S.population] = 3000;
    w.scalars[S.directiveClaimed] = 0b111111;
    expect(run0(sim, { type: 'debugGrow', x: 60, y: 60, archetype: ARCH.ROBOTICS_LAB, progress: 1 })).toBe('ok');
    const want = populationRp(3000) + 3 + LAB_RP;
    expect(rpPerMonth(w)).toEqual({ population: populationRp(3000), directives: 3, labs: LAB_RP, total: want });
    closeMonth(sim);
    expect(w.firmware[F.RP]).toBe(want);
    expect(w.firmware[F.EARNED]).toBe(want);
    closeMonth(sim);
    expect(w.firmware[F.RP]).toBe(2 * want);
    const st = firmwareStats(w);
    expect(st.rp).toBe(2 * want);
    expect(st.rpPerMonth.total).toBe(want);
    expect(st.labs).toBe(1);
  });

  it('a lab that is dark, under construction or burning pays nothing, and only LAB_MAX labs count', () => {
    const sim = flatSim(3, true);
    const w = sim.world;
    for (let i = 0; i < 6; i++) expect(run0(sim, { type: 'debugGrow', x: 20 + i * 5, y: 60, archetype: ARCH.ROBOTICS_LAB, progress: 1 })).toBe('ok');
    expect(poweredLabs(w)).toBe(LAB_MAX);
    const slots: number[] = [];
    for (let s = 0; s < BMAX; s++) if (w.bArch[s] === ARCH.ROBOTICS_LAB) slots.push(s);
    w.bFlags[slots[0]!] = BFLAG.UNPOWERED;
    w.bFlags[slots[1]!] = BFLAG.CONSTRUCTING;
    w.bFlags[slots[2]!] = BFLAG.BURNING;
    expect(poweredLabs(w)).toBe(3);
    for (const s of slots) w.bFlags[s] = BFLAG.UNPOWERED;
    expect(rpPerMonth(w).labs).toBe(0);
  });
});

function run0(sim: Sim, body: CommandBody): string { return tryCmd(sim, body); }

describe('research command', () => {
  function rich(rp: number): Sim {
    const sim = createSim(5, { debug: true });
    expect(tryCmd(sim, { type: 'debugRp', amount: rp })).toBe('ok');
    return sim;
  }

  it('validates the node, the points and the prerequisite, and refuses a second purchase', () => {
    const sim = rich(0);
    const w = sim.world;
    for (const bad of [-1, 12, 1.5, NaN]) expect(tryCmd(sim, { type: 'research', node: bad })).toBe('invalid');
    expect(tryCmd(sim, { type: 'research', node: NODE.HEAVY_LIFTERS })).toBe('rp');
    tryCmd(sim, { type: 'debugRp', amount: 29 });
    expect(tryCmd(sim, { type: 'research', node: NODE.HEAVY_LIFTERS })).toBe('rp');
    tryCmd(sim, { type: 'debugRp', amount: 1000 });
    expect(tryCmd(sim, { type: 'research', node: NODE.ROTOR_UPGRADE })).toBe('prereq');
    expect(w.firmware[F.RP]).toBe(1029);
    expect(tryCmd(sim, { type: 'research', node: NODE.HEAVY_LIFTERS })).toBe('ok');
    expect(w.firmware[F.RP]).toBe(1029 - RESEARCH_NODES[NODE.HEAVY_LIFTERS]!.cost);
    expect(w.firmware[F.RESEARCH]).toBe(bit(NODE.HEAVY_LIFTERS));
    expect(tryCmd(sim, { type: 'research', node: NODE.HEAVY_LIFTERS })).toBe('owned');
    expect(w.firmware[F.RP]).toBe(1029 - RESEARCH_NODES[NODE.HEAVY_LIFTERS]!.cost);
    expect(tryCmd(sim, { type: 'research', node: NODE.ROTOR_UPGRADE })).toBe('ok');
    expect(mods(w).haulCap).toBe(6);
    expect(mods(w).haulerSpeed).toBeCloseTo(1.2, 9);
  });

  it('can buy every node in order with enough points and ends with the sum of the costs spent', () => {
    const total = RESEARCH_NODES.reduce((s, n) => s + n.cost, 0);
    const sim = rich(total + 7);
    for (const n of RESEARCH_NODES) expect(tryCmd(sim, { type: 'research', node: n.id }), n.name).toBe('ok');
    expect(sim.world.firmware[F.RP]).toBe(7);
    expect(firmwareStats(sim.world).researchCount).toBe(12);
  });

  it('debugRp is debug-only and bounded', () => {
    const plain = createSim(5);
    expect(tryCmd(plain, { type: 'debugRp', amount: 50 })).toBe('debug-only');
    const dbg = createSim(5, { debug: true });
    expect(tryCmd(dbg, { type: 'debugRp', amount: -1 })).toBe('invalid');
    expect(tryCmd(dbg, { type: 'debugRp', amount: 1e9 })).toBe('invalid');
  });
});

// ---- scenario helpers -------------------------------------------------------------------------------------------------------------

function owned(sim: Sim, ...nodes: number[]): void {
  sim.world.firmware[F.RESEARCH] = nodes.reduce((m, n) => m | (1 << n), 0);
}
function enacted(sim: Sim, ...ids: number[]): void {
  sim.world.firmware[F.EDICTS] = ids.reduce((m, n) => m | (1 << n), 0);
}

/**
 * Progress a single house gains per builder-tick: a street, a depot and a half built house whose material is all delivered. The
 * `before` hook runs ahead of every step (it can pin the clock), and the average is taken over every builder that was working.
 */
function buildPerBuilderTick(setup: (sim: Sim) => void, before: (sim: Sim) => void = () => {}, ticks = 400): number {
  const sim = flatSim(42, true);
  road(sim, 96, 104, 130, 104);
  depot(sim, 98, 102);
  setup(sim);
  const w = sim.world;
  expect(run(sim, { type: 'debugGrow', x: 100, y: 105, archetype: rciId(1, 0, 1), progress: 0.2 })).toBe(true);
  let progress = 0, builderTicks = 0;
  for (let t = 0; t < ticks; t++) {
    const j = w.bId[105 * MAP + 100]! - 1;
    let working = 0;
    if (j >= 0 && w.jKind[j] !== 0) {
      w.jHave[j] = w.jNeed[j]!;
      for (const a of agents(sim, AKIND.BUILDER)) if (w.aState[a] === AST.WORK && w.aFrac[a]! >= 1 && w.aTarget[a] === refOf(w, j)) working++;
    }
    const p0 = j >= 0 ? w.jProg[j]! : 0;
    before(sim);
    step(sim);
    if (j >= 0 && working > 0 && w.jKind[j] !== 0 && w.jProg[j]! < JOB_MAX - 2000) { progress += w.jProg[j]! - p0; builderTicks += working; }
    if (builderTicks > 400) break;
  }
  expect(builderTicks, 'builders worked').toBeGreaterThan(100);
  return progress / builderTicks;
}

const DAY = 2400, NIGHT = 200;
const pinClock = (tickOfDay: number) => (sim: Sim): void => { sim.world.scalars[S.tickOfDay] = tickOfDay; };

describe('research nodes act on the sim', () => {
  it('Heavy lifters: haulers carry 6 instead of 4 per trip', () => {
    const maxCarry = (nodes: number[]): number => {
      const sim = flatSim(42, true);
      road(sim, 96, 104, 130, 104);
      depot(sim, 98, 102);
      owned(sim, ...nodes);
      expect(run(sim, { type: 'debugGrow', x: 100, y: 105, archetype: rciId(1, 0, 1), progress: 0.05 })).toBe(true);
      let max = 0;
      for (let t = 0; t < 700; t++) { step(sim); for (const a of agents(sim, AKIND.HAULER)) max = Math.max(max, sim.world.aCarry[a]!); }
      return max;
    };
    expect(maxCarry([])).toBe(4);
    expect(maxCarry([NODE.HEAVY_LIFTERS])).toBe(6);
  });

  it('Depot fabrication: each depot keeps 5 haulers', () => {
    const count = (nodes: number[]): number => {
      const sim = flatSim(42, true);
      road(sim, 96, 104, 130, 104);
      depot(sim, 98, 102);
      owned(sim, ...nodes);
      for (let t = 0; t < 600; t++) step(sim);
      return agents(sim, AKIND.HAULER).length;
    };
    expect(count([])).toBe(4);
    expect(count([NODE.DEPOT_FAB])).toBe(5);
  });

  it('Quick-set foundations: builders gain 25% more progress per tick', () => {
    const base = buildPerBuilderTick(() => {}, pinClock(DAY));
    const fast = buildPerBuilderTick((s) => owned(s, NODE.QUICK_SET), pinClock(DAY));
    expect(fast / base).toBeGreaterThan(1.25 * 0.85);
    expect(fast / base).toBeLessThan(1.25 * 1.15);
  });

  it('Crew coordination: a fourth builder works the same site', () => {
    const crew = (nodes: number[]): number => {
      const sim = flatSim(42, true);
      road(sim, 96, 104, 130, 104);
      depot(sim, 98, 102);
      owned(sim, ...nodes);
      expect(run(sim, { type: 'debugGrow', x: 100, y: 105, archetype: rciId(1, 0, 1), progress: 0.2 })).toBe(true);
      const w = sim.world;
      let max = 0;
      for (let t = 0; t < 500; t++) {
        const j = w.bId[105 * MAP + 100]! - 1;
        if (j >= 0 && w.jKind[j] !== 0) w.jHave[j] = w.jNeed[j]!;
        step(sim);
        if (j >= 0 && w.jKind[j] !== 0) {
          let n = 0;
          for (const a of agents(sim, AKIND.BUILDER)) if ((w.aState[a] === AST.WORK || w.aState[a] === AST.TO_SITE) && w.aTarget[a] === refOf(w, j)) n++;
          max = Math.max(max, n);
        }
      }
      return max;
    };
    expect(crew([])).toBe(3);
    expect(crew([NODE.CREW_COORD])).toBe(4);
  });

  it('Parallel fabrication: the city runs one more job per depot than it has builders', () => {
    const started = (nodes: number[]): number => {
      const sim = flatSim(42, true);
      road(sim, 96, 104, 130, 104);
      depot(sim, 98, 102);
      zone(sim, 100, 105, 120, 108);
      owned(sim, ...nodes);
      const w = sim.world;
      for (let i = 0; i < 12; i++) {
        w.scalars[S.demandR] = 0.9;
        w.landValue.fill(200);
        growthDirector(sim, 2);
      }
      let jobs = 0;
      for (let s = 0; s < BMAX; s++) if (w.jKind[s] !== 0) jobs++;
      return jobs;
    };
    expect(started([])).toBe(2);
    expect(started([NODE.PARALLEL_FAB])).toBe(3);
  });

  it('Rebuild protocol: a ruin is cleared and a new building starts on its lot with no demand to pull it', () => {
    const lot = (nodes: number[]): { bId: number; arch: number } => {
      const sim = flatSim(42, true);
      road(sim, 96, 104, 130, 104);
      depot(sim, 98, 102);
      expect(run(sim, { type: 'debugGrow', x: 100, y: 105, archetype: rciId(1, 0, 1), progress: 1 })).toBe(true);
      owned(sim, ...nodes);
      const w = sim.world;
      destroyBuilding(sim, w.bId[105 * MAP + 100]! - 1);
      for (let t = 0; t < 900; t++) { w.scalars[S.demandR] = 0; step(sim); }
      const id = w.bId[105 * MAP + 100]!;
      return { bId: id, arch: id > 0 ? w.bArch[id - 1]! : 0 };
    };
    expect(lot([]).bId).toBe(0);
    const rebuilt = lot([NODE.REBUILD]);
    expect(rebuilt.bId).toBeGreaterThan(0);
    expect(rebuilt.arch).toBe(rciId(1, 0, 1));
  });

  it('Long-range cells: a depot 50 tiles from a site helps only once the work radius reaches 60 (a nearer depot has it first)', () => {
    const homesServing = (nodes: number[]): number => {
      const sim = flatSim(42, true);
      road(sim, 80, 104, 190, 104);
      depot(sim, 100, 102);
      depot(sim, 140, 102);
      owned(sim, ...nodes);
      const w = sim.world;
      for (let t = 0; t < 500; t++) step(sim);
      // A tall tower site needs far more material than the nearer depot's four haulers carry in one round.
      expect(run(sim, { type: 'debugGrow', x: 150, y: 105, archetype: rciId(1, 2, 3), progress: 0.05 })).toBe(true);
      const site = w.bId[105 * MAP + 150]! - 1;
      const homes = new Set<number>();
      for (let t = 0; t < 40; t++) {
        step(sim);
        for (const h of agents(sim, AKIND.HAULER)) if (w.aTarget[h] === refOf(w, site) && w.aState[h] !== AST.IDLE) homes.add(w.aHome[h]!);
      }
      return homes.size;
    };
    expect(homesServing([])).toBe(1);
    expect(homesServing([NODE.LONG_RANGE])).toBe(2);
  });
});

/** Tiles a robot of `kind` covers on a long street, and how often it moved, stalled and for how long. */
function shuttle(kind: number, ticks: number, setup: (sim: Sim) => void = () => {}): { dist: number; moving: number; stalls: number; stallLen: number } {
  const sim = flatSim(7, true);
  road(sim, 20, 120, 220, 120);
  setup(sim);
  const w = sim.world, net = roadsOf(sim);
  const A = 120 * MAP + 20, B = 120 * MAP + 220;
  const a = spawnAgent(w, kind, 0, 20.5, 120.5);
  w.aState[a] = AST.HAUL;
  let from = A, to = B;
  expect(startTrip(net, w, a, from, to)).toBe(true);
  let dist = 0, moving = 0, stalls = 0, stallTicks = 0, inStall = false;
  for (let t = 0; t < ticks; t++) {
    w.scalars[S.tick]!++;
    const x0 = w.aX[a]!;
    const r = stepAgent(net, w, a);
    const justStalled = r === 'blocked' && w.aWait[a] === mods(w).breakdownTicks && mods(w).breakdown > 0 && !inStall;
    if (justStalled) { stalls++; inStall = true; }
    if (r === 'blocked' && inStall) stallTicks++;
    else if (r !== 'blocked') inStall = false;
    if (r === 'moving' || r === 'arrived') { dist += Math.abs(w.aX[a]! - x0); if (r === 'moving') moving++; }
    if (r === 'arrived') { [from, to] = [to, from]; startTrip(net, w, a, from, to); }
  }
  return { dist, moving, stalls, stallLen: stalls > 0 ? stallTicks / stalls : 0 };
}

describe('robot speed', () => {
  it('Rotor upgrade: haulers fly 20% faster; builders and firefighters are untouched', () => {
    const base = shuttle(AKIND.HAULER, 2000);
    const fast = shuttle(AKIND.HAULER, 2000, (s) => owned(s, NODE.ROTOR_UPGRADE));
    expect(fast.dist / base.dist).toBeGreaterThan(1.2 * 0.95);
    expect(fast.dist / base.dist).toBeLessThan(1.2 * 1.05);
    expect(base.dist / 2000).toBeCloseTo(HAULER_SPEED[1]!, 2);
    const b0 = shuttle(AKIND.BUILDER, 1000), b1 = shuttle(AKIND.BUILDER, 1000, (s) => owned(s, NODE.ROTOR_UPGRADE, NODE.RAPID_DRONES));
    expect(b1.dist).toBeCloseTo(b0.dist, 6);
    expect(b0.dist / 1000).toBeCloseTo(BUILDER_SPEED[1]!, 2);
  });

  it('Rapid-response drones: firefighters drive 30% faster', () => {
    const base = shuttle(AKIND.FIREFIGHTER, 1500);
    const fast = shuttle(AKIND.FIREFIGHTER, 1500, (s) => owned(s, NODE.RAPID_DRONES));
    expect(base.dist / 1500).toBeCloseTo(FIREFIGHTER_SPEED[1]!, 2);
    expect(fast.dist / base.dist).toBeGreaterThan(1.3 * 0.95);
    expect(fast.dist / base.dist).toBeLessThan(1.3 * 1.05);
  });

  it('Priority lanes: a jammed street slows robots by up to 40% until the node is owned', () => {
    const jam = (nodes: number[]): number => shuttle(AKIND.HAULER, 1500, (s) => {
      owned(s, ...nodes);
      for (let x = 20; x <= 220; x++) s.world.traffic[120 * MAP + x] = 255;
    }).dist;
    const clear = shuttle(AKIND.HAULER, 1500).dist;
    expect(jam([]) / clear).toBeCloseTo(0.6, 2);
    expect(jam([NODE.PRIORITY_LANES]) / clear).toBeCloseTo(1, 6);
  });
});

describe('civic nodes', () => {
  it('Fleet share: more of the cars are robo-taxis', () => {
    const share = (s: number): number => { let n = 0; for (let k = 0; k < 20000; k++) if (isTaxi(42, k, k * 7, s)) n++; return n / 20000; };
    const base = share(BASE.taxiShare), more = share(computeMods(bit(NODE.FLEET_SHARE), 0).taxiShare);
    expect(base).toBeCloseTo(34 / 256, 1);
    expect(more / base).toBeGreaterThan(1.5 * 0.9);
    expect(more / base).toBeLessThan(1.5 * 1.1);
  });

  it('Extended bays: a repair bay covers a disc 50% wider', () => {
    const reach = (nodes: number[]): number => {
      const sim = flatSim(42, true);
      owned(sim, ...nodes);
      expect(run(sim, { type: 'debugGrow', x: 120, y: 120, archetype: ARCH.REPAIR_BAY, progress: 1 })).toBe(true);
      discPass(sim);
      let far = 0;
      for (let x = 0; x < MAP; x++) if (sim.world.covRepair[121 * MAP + x]! > 0) far = Math.max(far, Math.abs(x - 121));
      return far;
    };
    const base = reach([]), wide = reach([NODE.EXTENDED_BAYS]);
    expect(base).toBeGreaterThanOrEqual(12);
    expect(wide / base).toBeGreaterThan(1.5 * 0.9);
    expect(wide / base).toBeLessThan(1.5 * 1.1);
  });
});

describe('depot modules', () => {
  function depotCity(): { sim: Sim; slot: number } {
    const sim = flatSim(42, true);
    road(sim, 96, 104, 130, 104);
    depot(sim, 98, 102);
    return { sim, slot: depots(sim)[0]! };
  }
  const settle = (sim: Sim, ticks = 500): void => { for (let t = 0; t < ticks; t++) step(sim); };

  it('validates the slot, the depot, the module and the price; refunds half of a replaced module', () => {
    const { sim, slot } = depotCity();
    const w = sim.world;
    expect(tryCmd(sim, { type: 'setDepotModule', slot, index: 2, module: 1 })).toBe('invalid');
    expect(tryCmd(sim, { type: 'setDepotModule', slot, index: 0, module: 9 })).toBe('invalid');
    expect(tryCmd(sim, { type: 'setDepotModule', slot: 3000, index: 0, module: 1 })).toBe('not-depot');
    expect(tryCmd(sim, { type: 'setDepotModule', slot, index: 0, module: 0 })).toBe('noop');
    const before = w.scalars[S.treasury]!;
    expect(tryCmd(sim, { type: 'setDepotModule', slot, index: 0, module: MODULE.BUILDER_BAY })).toBe('ok');
    expect(w.scalars[S.treasury]).toBe(before - MODULES[MODULE.BUILDER_BAY]!.cost);
    expect(moduleAt(w, slot, 0)).toBe(MODULE.BUILDER_BAY);
    expect(moduleAt(w, slot, 1)).toBe(MODULE.NONE);
    expect(tryCmd(sim, { type: 'setDepotModule', slot, index: 0, module: MODULE.BUILDER_BAY })).toBe('noop');
    const mid = w.scalars[S.treasury]!;
    expect(tryCmd(sim, { type: 'setDepotModule', slot, index: 0, module: MODULE.WORKSHOP })).toBe('ok');
    expect(w.scalars[S.treasury]).toBe(mid - (MODULES[MODULE.WORKSHOP]!.cost - Math.floor(MODULES[MODULE.BUILDER_BAY]!.cost / 2)));
    const after = w.scalars[S.treasury]!;
    expect(tryCmd(sim, { type: 'setDepotModule', slot, index: 0, module: MODULE.NONE })).toBe('ok');
    expect(w.scalars[S.treasury]).toBe(after + Math.floor(MODULES[MODULE.WORKSHOP]!.cost / 2));
    w.scalars[S.treasury] = 100;
    expect(tryCmd(sim, { type: 'setDepotModule', slot, index: 1, module: MODULE.DRONE_NEST })).toBe('funds');
    expect(moduleAt(w, slot, 1)).toBe(MODULE.NONE);
  });

  it('refuses a depot that is still being built, and the module goes when the depot does', () => {
    const { sim, slot } = depotCity();
    const w = sim.world;
    expect(run(sim, { type: 'debugGrow', x: 110, y: 100, archetype: ARCH.DEPOT, progress: 0.5 })).toBe(true);
    const site = w.bId[100 * MAP + 110]! - 1;
    expect(tryCmd(sim, { type: 'setDepotModule', slot: site, index: 0, module: 1 })).toBe('not-ready');
    expect(tryCmd(sim, { type: 'setDepotModule', slot, index: 0, module: MODULE.HAULER_PAD })).toBe('ok');
    expect(run(sim, { type: 'bulldoze', x0: 98, y0: 102, x1: 99, y1: 103 })).toBe(true);
    expect(w.bMod[slot]).toBe(0);
  });

  it('Builder Bay and Hauler Pad: the depot keeps two more builders and two more haulers, and gives them up when cleared', () => {
    const { sim, slot } = depotCity();
    const w = sim.world;
    settle(sim);
    expect(agents(sim, AKIND.BUILDER)).toHaveLength(4);
    expect(agents(sim, AKIND.HAULER)).toHaveLength(4);
    expect(tryCmd(sim, { type: 'setDepotModule', slot, index: 0, module: MODULE.BUILDER_BAY })).toBe('ok');
    expect(tryCmd(sim, { type: 'setDepotModule', slot, index: 1, module: MODULE.HAULER_PAD })).toBe('ok');
    expect(depotCaps(w, slot)).toEqual({ builders: 4 + BAY_BUILDERS, haulers: 4 + PAD_HAULERS, drones: 0 });
    settle(sim);
    expect(agents(sim, AKIND.BUILDER)).toHaveLength(6);
    expect(agents(sim, AKIND.HAULER)).toHaveLength(6);
    expect(firmwareStats(w).modules).toEqual([1, 1, 0, 0]);
    expect(tryCmd(sim, { type: 'setDepotModule', slot, index: 0, module: MODULE.NONE })).toBe('ok');
    expect(tryCmd(sim, { type: 'setDepotModule', slot, index: 1, module: MODULE.NONE })).toBe('ok');
    settle(sim, 400);
    expect(agents(sim, AKIND.BUILDER)).toHaveLength(4);
    expect(agents(sim, AKIND.HAULER)).toHaveLength(4);
  });

  it('two Builder Bays stack, and Depot fabrication adds to the Hauler Pad', () => {
    const { sim, slot } = depotCity();
    owned(sim, NODE.HEAVY_LIFTERS, NODE.ROTOR_UPGRADE, NODE.DEPOT_FAB);
    tryCmd(sim, { type: 'setDepotModule', slot, index: 0, module: MODULE.BUILDER_BAY });
    tryCmd(sim, { type: 'setDepotModule', slot, index: 1, module: MODULE.BUILDER_BAY });
    expect(depotCaps(sim.world, slot).builders).toBe(8);
    expect(depotCaps(sim.world, slot).haulers).toBe(5);
    tryCmd(sim, { type: 'setDepotModule', slot, index: 1, module: MODULE.HAULER_PAD });
    expect(depotCaps(sim.world, slot)).toEqual({ builders: 6, haulers: 7, drones: 0 });
  });

  it('Drone Nest: the depot houses one firefighter drone, and it leaves with the nest', () => {
    const { sim, slot } = depotCity();
    const w = sim.world;
    settle(sim, 200);
    expect(agents(sim, AKIND.FIREFIGHTER)).toHaveLength(0);
    expect(tryCmd(sim, { type: 'setDepotModule', slot, index: 0, module: MODULE.DRONE_NEST })).toBe('ok');
    settle(sim, 200);
    const drones = agents(sim, AKIND.FIREFIGHTER);
    expect(drones).toHaveLength(1);
    expect(w.aHome[drones[0]!]).toBe(refOf(w, slot));
    expect(tryCmd(sim, { type: 'setDepotModule', slot, index: 0, module: MODULE.NONE })).toBe('ok');
    settle(sim, 100);
    expect(agents(sim, AKIND.FIREFIGHTER)).toHaveLength(0);
  });

  it('Workshop: +10% build speed for jobs within its radius, nothing beyond it, and the bonus caps', () => {
    const { sim, slot } = depotCity();
    const w = sim.world;
    expect(run(sim, { type: 'debugGrow', x: 100, y: 105, archetype: rciId(1, 0, 1), progress: 0.5 })).toBe(true);
    expect(run(sim, { type: 'debugGrow', x: 100 + WORKSHOP_RADIUS + 8, y: 105, archetype: rciId(1, 0, 1), progress: 0.5 })).toBe(true);
    const near = w.bId[105 * MAP + 100]! - 1, far = w.bId[105 * MAP + 100 + WORKSHOP_RADIUS + 8]! - 1;
    expect(workshopBonus(w, near)).toBe(0);
    tryCmd(sim, { type: 'setDepotModule', slot, index: 0, module: MODULE.WORKSHOP });
    expect(workshopBonus(w, near)).toBeCloseTo(0.1, 9);
    expect(workshopBonus(w, far)).toBe(0);
    tryCmd(sim, { type: 'setDepotModule', slot, index: 1, module: MODULE.WORKSHOP });
    expect(workshopBonus(w, near)).toBeCloseTo(0.2, 9);
    expect(buildSpeed(w, near)).toBeCloseTo(1.2 * (isNight(w) ? 1 : 1), 9);
    tryCmd(sim, { type: 'setDepotModule', slot, index: 1, module: MODULE.NONE });
    expect(workshopBonus(w, near)).toBeCloseTo(0.1, 9);
  });

  it('Workshop: measured progress per builder-tick follows the displayed 10%', () => {
    const base = buildPerBuilderTick(() => {}, pinClock(DAY));
    const shop = buildPerBuilderTick((s) => { tryCmd(s, { type: 'setDepotModule', slot: depots(s)[0]!, index: 0, module: MODULE.WORKSHOP }); }, pinClock(DAY));
    expect(shop / base - 1).toBeGreaterThan(0.1 * 0.85);
    expect(shop / base - 1).toBeLessThan(0.1 * 1.15);
  });

  it('survives a snapshot: modules and the robots they bring come back identical', () => {
    const { sim, slot } = depotCity();
    tryCmd(sim, { type: 'setDepotModule', slot, index: 0, module: MODULE.BUILDER_BAY });
    tryCmd(sim, { type: 'setDepotModule', slot, index: 1, module: MODULE.WORKSHOP });
    settle(sim, 300);
    const back = restore(snapshot(sim));
    expect(stateHash(back)).toBe(stateHash(sim));
    expect(moduleAt(back.world, slot, 0)).toBe(MODULE.BUILDER_BAY);
    expect(moduleAt(back.world, slot, 1)).toBe(MODULE.WORKSHOP);
  });
});

describe('edict command', () => {
  it('needs the tier, takes at most 4, and a repeal is always allowed', () => {
    const sim = createSim(9, { debug: true });
    const w = sim.world;
    expect(tryCmd(sim, { type: 'toggleEdict', edict: -1 })).toBe('invalid');
    expect(tryCmd(sim, { type: 'toggleEdict', edict: 8 })).toBe('invalid');
    expect(tryCmd(sim, { type: 'toggleEdict', edict: 1.5 })).toBe('invalid');
    expect(tryCmd(sim, { type: 'toggleEdict', edict: EDICT.TAX_HOLIDAY })).toBe('locked');
    tryCmd(sim, { type: 'debugTier', tier: 1 });
    expect(tryCmd(sim, { type: 'toggleEdict', edict: EDICT.TAX_HOLIDAY })).toBe('ok');
    expect(tryCmd(sim, { type: 'toggleEdict', edict: EDICT.GREEN_ROOFS })).toBe('locked');
    tryCmd(sim, { type: 'debugTier', tier: MAX_TIER });
    for (const id of [EDICT.NIGHT_SHIFT, EDICT.OVERCLOCK, EDICT.CURFEW]) expect(tryCmd(sim, { type: 'toggleEdict', edict: id })).toBe('ok');
    expect(firmwareStats(w).edictsActive).toBe(4);
    for (const id of [EDICT.GREEN_ROOFS, EDICT.SMOG_PERMIT, EDICT.RECYCLING, EDICT.ROBO_TAXIS]) expect(tryCmd(sim, { type: 'toggleEdict', edict: id })).toBe('max-edicts');
    expect(firmwareStats(w).edictsActive).toBe(4);
    expect(tryCmd(sim, { type: 'toggleEdict', edict: EDICT.CURFEW })).toBe('ok');
    expect(firmwareStats(w).edictsActive).toBe(3);
    expect(tryCmd(sim, { type: 'toggleEdict', edict: EDICT.RECYCLING })).toBe('ok');
    expect(w.firmware[F.EDICTS]).toBe(bit(EDICT.TAX_HOLIDAY, EDICT.NIGHT_SHIFT, EDICT.OVERCLOCK, EDICT.RECYCLING));
  });
});

// ---- Edict effects: measured in the sim over many ticks, compared with the number the card shows -----------------------------------

/** A small finished city: tall residential, commercial and industrial buildings, no roads (the budget and the coverage need none). */
function economyCity(): Sim {
  const sim = flatSim(11, true);
  const w = sim.world;
  const at = (x: number, y: number, z: number, d: number, l: number): void => { expect(run(sim, { type: 'debugGrow', x, y, archetype: rciId(z, d, l), progress: 1 })).toBe(true); };
  for (let i = 0; i < 3; i++) { at(60 + i * 4, 60, 1, 2, 3); at(60 + i * 4, 70, 2, 2, 3); at(60 + i * 4, 80, 3, 1, 2); }
  w.landValue.fill(120);
  return sim;
}

const withinTolerance = (measured: number, shown: number): boolean => Math.abs(measured - shown) <= Math.abs(shown) * 0.15;

describe('edict effects match the numbers on their cards (within 15%)', () => {
  const N = EDICT_NUMBERS;
  const pct = (on: number, off: number): number => (on / off - 1) * 100;
  /** Points the monthly approval target moves when the edict is enacted in the same finished city. */
  const approvalShift = (id: number): number => {
    const sim = economyCity();
    const off = approvalTarget(sim.world);
    enacted(sim, id);
    return approvalTarget(sim.world) - off;
  };

  /** Measure every effect of one edict; the key is the one in EDICTS[...].effects. */
  const MEASURE: Record<number, Record<string, () => number>> = {
    [EDICT.NIGHT_SHIFT]: {
      approval: () => approvalShift(EDICT.NIGHT_SHIFT),
      nightBuild: () => {
        const off = buildPerBuilderTick(() => {}, pinClock(NIGHT));
        const on = buildPerBuilderTick((s) => enacted(s, EDICT.NIGHT_SHIFT), pinClock(NIGHT));
        const dayOn = buildPerBuilderTick((s) => enacted(s, EDICT.NIGHT_SHIFT), pinClock(DAY));
        const dayOff = buildPerBuilderTick(() => {}, pinClock(DAY));
        expect(dayOn).toBeCloseTo(dayOff, 6);
        return pct(on, off);
      },
      depotPollution: () => {
        const sim = flatSim(42, true);
        road(sim, 96, 104, 130, 104);
        depot(sim, 98, 102);
        const slot = depots(sim)[0]!;
        const off = emissionOf(sim.world, slot);
        enacted(sim, EDICT.NIGHT_SHIFT);
        return emissionOf(sim.world, slot) - off;
      },
    },
    [EDICT.OVERCLOCK]: {
      haulerSpeed: () => {
        const off = shuttle(AKIND.HAULER, 6000), on = shuttle(AKIND.HAULER, 6000, (s) => enacted(s, EDICT.OVERCLOCK));
        return pct(on.dist / on.moving, off.dist / off.moving);
      },
      breakdown: () => {
        const on = shuttle(AKIND.HAULER, 120000, (s) => enacted(s, EDICT.OVERCLOCK));
        return (100 * on.stalls) / (on.moving + on.stalls);
      },
      breakdownTicks: () => {
        const on = shuttle(AKIND.HAULER, 60000, (s) => enacted(s, EDICT.OVERCLOCK));
        return on.stallLen / 10;
      },
    },
    [EDICT.ROBO_TAXIS]: {
      approval: () => approvalShift(EDICT.ROBO_TAXIS),
      taxiShare: () => {
        const share = (s: number): number => { let n = 0; for (let k = 0; k < 30000; k++) if (isTaxi(42, k, k * 13 + 1, s)) n++; return n / 30000; };
        return pct(share(computeMods(0, bit(EDICT.ROBO_TAXIS)).taxiShare), share(BASE.taxiShare));
      },
      commuteRescue: () => {
        const sim = createSim(21, { debug: true });
        enacted(sim, EDICT.ROBO_TAXIS);
        for (let k = 0; k < 8000; k++) { sim.world.scalars[S.tick] = k; recordTrip(sim.world, PURPOSE.OUT, false, 0, 0); }
        return (100 * sim.world.scalars[S.tripsDone]!) / 8000;
      },
    },
    [EDICT.SMOG_PERMIT]: {
      approval: () => approvalShift(EDICT.SMOG_PERMIT),
      industryOutput: () => {
        const produced = (on: boolean): number => {
          const sim = flatSim(42, true);
          expect(run(sim, { type: 'debugGrow', x: 80, y: 80, archetype: rciId(3, 0, 1), progress: 1 })).toBe(true);
          if (on) enacted(sim, EDICT.SMOG_PERMIT);
          const slot = sim.world.bId[80 * MAP + 80]! - 1;
          let sum = 0;
          for (let n = 1; n <= 80; n++) {
            sim.world.bStock[slot] = 0;
            sim.world.scalars[S.tick] = n * 40;
            materialSystem(sim);
            sum += sim.world.bStock[slot]!;
          }
          return sum;
        };
        return pct(produced(true), produced(false));
      },
      industryDemand: () => {
        const sim = economyCity();
        const off = demandTargets(sim.world, countTotals(sim.world))[2];
        enacted(sim, EDICT.SMOG_PERMIT);
        return ((demandTargets(sim.world, countTotals(sim.world))[2] - off) * 100) / 1024;
      },
      industryPollution: () => {
        const sim = economyCity();
        const slot = sim.world.bId[80 * MAP + 60]! - 1;
        const off = emissionOf(sim.world, slot);
        enacted(sim, EDICT.SMOG_PERMIT);
        return pct(emissionOf(sim.world, slot), off);
      },
    },
    [EDICT.CURFEW]: {
      approval: () => approvalShift(EDICT.CURFEW),
      crime: () => {
        const sim = economyCity();
        const slot = sim.world.bId[60 * MAP + 60]! - 1;
        sim.world.landValue.fill(0);
        const off = crimeOf(sim.world, slot);
        enacted(sim, EDICT.CURFEW);
        return pct(crimeOf(sim.world, slot), off);
      },
      commercialIncome: () => {
        const sim = economyCity();
        const off = computeBudget(sim.world, 0).incomeC;
        enacted(sim, EDICT.CURFEW);
        expect(off).toBeGreaterThan(100);
        return pct(computeBudget(sim.world, 0).incomeC, off);
      },
    },
    [EDICT.GREEN_ROOFS]: {
      approval: () => approvalShift(EDICT.GREEN_ROOFS),
      landValue: () => {
        const sim = economyCity();
        const off = landValueAt(sim.world, 100, 100);
        enacted(sim, EDICT.GREEN_ROOFS);
        return landValueAt(sim.world, 100, 100) - off;
      },
      greenUpkeep: () => {
        const sim = economyCity();
        const off = computeBudget(sim.world, 0).services;
        enacted(sim, EDICT.GREEN_ROOFS);
        return (computeBudget(sim.world, 0).services - off) / grown(sim).length;
      },
    },
    [EDICT.TAX_HOLIDAY]: {
      approval: () => approvalShift(EDICT.TAX_HOLIDAY),
      demandR: () => {
        const sim = economyCity();
        const off = demandTargets(sim.world, countTotals(sim.world))[0];
        enacted(sim, EDICT.TAX_HOLIDAY);
        return ((demandTargets(sim.world, countTotals(sim.world))[0] - off) * 100) / 1024;
      },
      residentialIncome: () => {
        const sim = economyCity();
        const off = computeBudget(sim.world, 0).incomeR;
        enacted(sim, EDICT.TAX_HOLIDAY);
        expect(off).toBeGreaterThan(100);
        return pct(computeBudget(sim.world, 0).incomeR, off);
      },
    },
    [EDICT.RECYCLING]: {
      recycle: () => {
        const returned = (on: boolean): number => {
          const sim = flatSim(42, true);
          road(sim, 96, 104, 130, 104);
          depot(sim, 98, 102);
          expect(run(sim, { type: 'debugGrow', x: 100, y: 105, archetype: rciId(1, 2, 2), progress: 1 })).toBe(true);
          const w = sim.world, d = depots(sim)[0]!;
          const house = w.bId[105 * MAP + 100]! - 1;
          const area = w.bW[house]! * w.bH[house]!;
          w.bFlags[house] = BFLAG.ABANDONED;
          if (on) enacted(sim, EDICT.RECYCLING);
          w.bAux[d] = 1;
          w.bStock[d] = 30;
          for (let t = 0; t < 900 && w.bArch[house] !== 0; t++) { w.scalars[S.demandR] = -1; step(sim); }
          expect(w.bArch[house]).toBe(0);
          return (100 * (w.bStock[d]! - 30)) / materialFor(area, 2);
        };
        expect(returned(false)).toBe(0);
        return returned(true);
      },
    },
  };

  for (const e of EDICTS) {
    for (const eff of e.effects) {
      it(`${e.name}: ${eff.label} shows ${eff.value} ${eff.unit} and measures within 15% of it`, () => {
        const measure = MEASURE[e.id]?.[eff.key];
        expect(measure, `a measurement for ${e.name} / ${eff.key}`).toBeDefined();
        const got = measure!();
        expect(withinTolerance(got, eff.value), `${e.name} ${eff.key}: card ${eff.value}, measured ${got}`).toBe(true);
      });
    }
    it(`${e.name}: the monthly cost on the card is what the budget charges`, () => {
      const sim = economyCity();
      const off = computeBudget(sim.world, 0).services;
      enacted(sim, e.id);
      const green = e.id === EDICT.GREEN_ROOFS ? EDICT_NUMBERS.greenUpkeepPerBuilding * grown(sim).length : 0;
      expect(computeBudget(sim.world, 0).services - off).toBe(e.cost + green);
      expect(edictUpkeep(sim.world)).toBe(e.cost + green);
    });
  }

  it('every effect the cards list is measured above', () => {
    for (const e of EDICTS) for (const eff of e.effects) expect(MEASURE[e.id]?.[eff.key], `${e.name} ${eff.key}`).toBeDefined();
    expect(N.nightBuildPct).toBe(40);
  });
});

describe('determinism with firmware', () => {
  function firmwareCity(): { sim: Sim; cmds: Command[] } {
    const sim = createSim(42, { debug: true });
    const w = sim.world;
    const extra: [number, CommandBody][] = [
      [3, { type: 'debugTier', tier: 3 }],
      [4, { type: 'debugRp', amount: 400 }],
      [5, { type: 'research', node: NODE.HEAVY_LIFTERS }],
      [6, { type: 'research', node: NODE.ROTOR_UPGRADE }],
      [7, { type: 'research', node: NODE.QUICK_SET }],
      [8, { type: 'research', node: NODE.FLEET_SHARE }],
      [9, { type: 'toggleEdict', edict: EDICT.NIGHT_SHIFT }],
      [9, { type: 'toggleEdict', edict: EDICT.OVERCLOCK }],
      [9, { type: 'toggleEdict', edict: EDICT.CURFEW }],
      [9, { type: 'toggleEdict', edict: EDICT.RECYCLING }],
      [60, { type: 'setDepotModule', slot: 0, index: 0, module: MODULE.BUILDER_BAY }],
      [61, { type: 'setDepotModule', slot: 0, index: 1, module: MODULE.WORKSHOP }],
    ];
    const cmds = [...scriptedCity(w), ...extra.map(([tick, b], i) => ({ ...b, id: 200 + i, tick }) as Command)];
    return { sim, cmds };
  }

  it('1900 ticks + snapshot + 2100 ticks equals 4000 straight, across a month close with research and edicts active', () => {
    const a = firmwareCity();
    a.sim.world.scalars[S.directiveClaimed] = 0b1111;
    runScripted(a.sim, a.cmds, 4000);
    expect(a.sim.world.firmware[F.RESEARCH]).toBe(bit(NODE.HEAVY_LIFTERS, NODE.ROTOR_UPGRADE, NODE.QUICK_SET, NODE.FLEET_SHARE));
    expect(a.sim.world.firmware[F.EDICTS]).toBe(bit(EDICT.NIGHT_SHIFT, EDICT.OVERCLOCK, EDICT.CURFEW, EDICT.RECYCLING));
    expect(moduleAt(a.sim.world, 0, 0)).toBe(MODULE.BUILDER_BAY);
    expect(a.sim.world.scalars[S.month]).toBeGreaterThanOrEqual(1);
    expect(a.sim.world.firmware[F.EARNED]).toBeGreaterThan(0);

    const b = firmwareCity();
    b.sim.world.scalars[S.directiveClaimed] = 0b1111;
    runScripted(b.sim, b.cmds, 1900);
    expect(b.sim.world.scalars[S.month]).toBe(0);
    const resumed = restore(snapshot(b.sim));
    expect(stateHash(resumed)).toBe(stateHash(b.sim));
    runTicks(resumed, 2100);
    expect(stateHash(resumed)).toBe(stateHash(a.sim));
    expect(resumed.world.firmware[F.RP]).toBe(a.sim.world.firmware[F.RP]);
  }, 120000);

  it('two independent runs agree', () => {
    const hashOf = (): number => {
      const c = firmwareCity();
      runScripted(c.sim, c.cmds, 700);
      return stateHash(c.sim);
    };
    expect(hashOf()).toBe(hashOf());
  }, 60000);

  it('a world with no firmware has every modifier neutral', () => {
    const w: World = createSim(1).world;
    expect(mods(w)).toBe(mods(createSim(2).world));
    expect(mods(w)).toEqual(BASE);
    expect(w.firmware.every((v) => v === 0)).toBe(true);
  });
});
