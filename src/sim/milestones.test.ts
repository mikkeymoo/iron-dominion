import { describe, expect, it, vi } from 'vitest';
import { RenderMirror } from '../render/mirror.ts';
import { ARCH, BFLAG, CATALOG, rciId } from './catalog.ts';
import { execute, type Command, type CommandBody } from './commands.ts';
import { computeBudget, countTotals, demandTargets, landValueAt } from './economy/index.ts';
import { makeResync, restore, snapshot, stateHash, step } from './engine.ts';
import { estimate, tileReadOf } from './estimate.ts';
import { S, type World } from './layers.ts';
import { MEGA, MEGA_ARCHS, megaBit, megaStages } from './megaprojects.ts';
import { megaRequirements, milestoneStats, powerBalance, projectStatuses, waterBalance } from './milestones.ts';
import { AKIND, AST, DEPOT_START_STOCK, JOB, JOB_MAX } from './robots/constants.ts';
import { depot, flatSim, road, tickOf } from './robots/testkit.ts';
import { solveUtilities } from './utilities/index.ts';
import { DENSITY_UNLOCK, MAX_TIER, ROAD_UNLOCK, TIERS, tierOfPopulation, unlockList } from './unlocks.ts';
import type { Sim, SimEvent } from './world.ts';

vi.setConfig({ testTimeout: 240000 });

let nextId = 5000;
function cmd(sim: Sim, body: CommandBody): { ok: boolean; reason?: string; journal?: number } {
  sim.events = [];
  const ok = execute(sim, { ...body, id: nextId++, tick: 0 } as Command);
  const e = sim.events[sim.events.length - 1]!;
  return { ok, reason: e.type === 'rejected' ? e.reason : undefined, journal: e.type === 'accepted' ? e.journal : undefined };
}
const grow = (sim: Sim, arch: number, x: number, y: number, progress = 1): void => {
  expect(cmd(sim, { type: 'debugGrow', x, y, archetype: arch, progress }).ok, `debugGrow ${arch}`).toBe(true);
};

/** Steps `n` ticks, collecting every event the sim emitted. */
function stepLog(sim: Sim, n: number, log: SimEvent[] = []): SimEvent[] {
  for (let i = 0; i < n; i++) { step(sim); log.push(...sim.events); sim.events = []; }
  return log;
}

/** Sets the population scalar for exactly one tick: the economy refreshes it from real buildings every tenth tick, so never on that one. */
function stepWithPopulation(sim: Sim, pop: number, log: SimEvent[]): void {
  while ((tickOf(sim) + 1) % 10 === 0) stepLog(sim, 1, log);
  sim.world.scalars[S.population] = pop;
  stepLog(sim, 1, log);
}

/** A flat city with a road, a depot, two power plants (240 MW) and ten pumps (240 ML): every requirement but the Elevator's power is met. */
function readyCity(opt: { depot?: boolean } = {}): Sim {
  const sim = flatSim(42, true);
  road(sim, 96, 104, 140, 104);
  if (opt.depot !== false) depot(sim, 98, 102);
  grow(sim, ARCH.POWER_PLANT, 100, 96);
  grow(sim, ARCH.POWER_PLANT, 105, 96);
  for (let i = 0; i < 10; i++) grow(sim, ARCH.WATER_PUMP, 110 + i * 3, 96);
  const s = sim.world.scalars;
  s[S.tier] = MAX_TIER;
  s[S.treasury] = 5_000_000;
  s[S.population] = 100_000;
  return sim;
}

const SITE = { x: 104, y: 105 };
const start = (sim: Sim, arch: number): { ok: boolean; reason?: string; journal?: number } => cmd(sim, { type: 'placeBuilding', arch, x: SITE.x, y: SITE.y, rot: 0 });
const slotOf = (w: World, arch: number): number => w.bArch.indexOf(arch);

/** Shrinks every stage of a project so a full build fits in a test; returns the undo. */
function shrink(arch: number, material: number, work: number): () => void {
  const stages = MEGA[arch]!.stages, saved = stages.map((s) => ({ ...s }));
  stages.forEach((s) => { s.material = material; s.work = work; });
  return () => stages.forEach((s, i) => Object.assign(s, saved[i]));
}

describe('population tiers', () => {
  it('maps population to the tier at each threshold, one tier per threshold', () => {
    expect(TIERS.map((t) => t.name)).toEqual(['Outpost', 'Settlement', 'Town', 'City', 'Metropolis', 'Megalopolis']);
    expect(TIERS.map((t) => t.pop)).toEqual([0, 500, 2000, 8000, 25000, 80000]);
    for (let i = 1; i < TIERS.length; i++) {
      expect(TIERS[i]!.pop).toBeGreaterThan(TIERS[i - 1]!.pop);
      expect(TIERS[i]!.bonus).toBeGreaterThanOrEqual(TIERS[i - 1]!.bonus);
      expect(tierOfPopulation(TIERS[i]!.pop - 1)).toBe(i - 1);
      expect(tierOfPopulation(TIERS[i]!.pop)).toBe(i);
    }
    expect(tierOfPopulation(0)).toBe(0);
    expect(tierOfPopulation(1e9)).toBe(MAX_TIER);
  });

  it('lists every locked catalog entry, road class and density under exactly one tier', () => {
    const seen = new Map<string, number>();
    for (let t = 0; t <= MAX_TIER; t++) for (const u of unlockList(t)) seen.set(`${u.kind}:${u.id}`, (seen.get(`${u.kind}:${u.id}`) ?? 0) + 1);
    for (const a of CATALOG) if (a.unlock) expect(seen.get(`building:${a.id}`), a.name).toBe(1);
    ROAD_UNLOCK.forEach((t, cls) => expect(seen.get(`road:${cls}`) ?? 0, `road ${cls}`).toBe(t > 0 ? 1 : 0));
    DENSITY_UNLOCK.forEach((t, d) => expect(seen.get(`density:${d}`) ?? 0, `density ${d}`).toBe(t > 0 ? 1 : 0));
    expect(unlockList(0)).toEqual([]);
  });

  it('fires one milestone event per tier, pays its bonus once, and never repeats when the population falls and recovers', () => {
    const sim = flatSim(7);
    const log: SimEvent[] = [];
    const t0 = sim.world.scalars[S.treasury]!;
    stepWithPopulation(sim, 499, log);
    expect(log.filter((e) => e.type === 'milestone')).toEqual([]);
    expect(sim.world.scalars[S.tier]).toBe(0);

    stepWithPopulation(sim, 500, log);
    expect(log.filter((e) => e.type === 'milestone')).toEqual([{ type: 'milestone', tick: tickOf(sim), tier: 1, bonus: TIERS[1]!.bonus }]);
    expect(sim.world.scalars[S.tier]).toBe(1);
    expect(sim.world.scalars[S.treasury]).toBeGreaterThanOrEqual(t0 + TIERS[1]!.bonus - 50);

    stepWithPopulation(sim, 800, log);
    stepWithPopulation(sim, 10, log);
    stepWithPopulation(sim, 600, log);
    expect(log.filter((e) => e.type === 'milestone')).toHaveLength(1);
    expect(sim.world.scalars[S.tier]).toBe(1);
  });

  it('pays and announces every tier a jump crosses, in order, once each', () => {
    const sim = flatSim(7);
    const log: SimEvent[] = [];
    stepWithPopulation(sim, 9000, log);
    const ms = log.filter((e): e is Extract<SimEvent, { type: 'milestone' }> => e.type === 'milestone');
    expect(ms.map((e) => e.tier)).toEqual([1, 2, 3]);
    expect(ms.map((e) => e.bonus)).toEqual([TIERS[1]!.bonus, TIERS[2]!.bonus, TIERS[3]!.bonus]);
    stepLog(sim, 40, log);
    expect(log.filter((e) => e.type === 'milestone')).toHaveLength(3);
  });

  it('reaches Settlement from real buildings: three finished high-density towers cross 500 residents', () => {
    const sim = flatSim(7, true);
    for (let i = 0; i < 3; i++) grow(sim, rciId(1, 2, 3), 100 + i * 4, 100);
    const log = stepLog(sim, 30);
    expect(sim.world.scalars[S.population]).toBe(660);
    expect(log.filter((e) => e.type === 'milestone').map((e) => (e as { tier: number }).tier)).toEqual([1]);
  });
});

describe('unlock gating', () => {
  const tileBodies = (arch: number): CommandBody => ({ type: 'placeBuilding', arch, x: 104, y: 105, rot: 0 });
  const cases: { name: string; body: CommandBody; needs: number }[] = [
    { name: 'avenue', body: { type: 'placeRoad', ax: 100, ay: 100, bx: 110, by: 100, cls: 2 }, needs: ROAD_UNLOCK[2]! },
    { name: 'highway', body: { type: 'placeRoad', ax: 100, ay: 100, bx: 110, by: 100, cls: 3 }, needs: ROAD_UNLOCK[3]! },
    { name: 'high density zone', body: { type: 'zone', x0: 100, y0: 105, x1: 104, y1: 108, zone: 1, density: 2 }, needs: DENSITY_UNLOCK[2]! },
    { name: 'fusion reactor', body: tileBodies(ARCH.FUSION_REACTOR), needs: 3 },
    ...MEGA_ARCHS.map((a) => ({ name: `mega ${a}`, body: tileBodies(a), needs: CATALOG.find((c) => c.id === a)!.unlock! })),
  ];

  it('rejects each locked item with reason "locked" below its tier and not at or above it', () => {
    for (const c of cases) {
      for (let tier = 0; tier <= MAX_TIER; tier++) {
        const sim = flatSim(3);
        sim.world.scalars[S.tier] = tier;
        sim.world.scalars[S.treasury] = 5_000_000;
        const reason = cmd(sim, c.body).reason;
        if (tier < c.needs) expect(reason, `${c.name} at tier ${tier}`).toBe('locked');
        else expect(reason, `${c.name} at tier ${tier}`).not.toBe('locked');
      }
    }
  });

  it('keeps the estimate in step with the sim at every tier, for the sim and for the main-thread mirror the ghost reads', () => {
    for (const c of cases) {
      for (let tier = 0; tier <= MAX_TIER; tier++) {
        const sim = flatSim(3);
        sim.world.scalars[S.tier] = tier;
        sim.world.scalars[S.treasury] = 5_000_000;
        const mirror = new RenderMirror();
        mirror.apply(makeResync(sim.world));
        const viaWorld = estimate(sim.world, c.body, sim.world.scalars[S.treasury]);
        const viaMirror = estimate(tileReadOf(mirror.layers, mirror.scalars), c.body, mirror.scalars[S.treasury]);
        expect(viaMirror.reason, `${c.name} mirror at tier ${tier}`).toBe(viaWorld.reason);
        expect(viaMirror.cost).toBe(viaWorld.cost);
        expect(cmd(sim, c.body).reason, `${c.name} sim at tier ${tier}`).toBe(viaWorld.reason);
      }
    }
  });

  it('has a debug-only way to raise the tier, which never lowers it and pays no bonus', () => {
    const sim = flatSim(3, true);
    const t0 = sim.world.scalars[S.treasury]!;
    expect(cmd(sim, { type: 'debugTier', tier: 4 }).ok).toBe(true);
    expect(sim.world.scalars[S.tier]).toBe(4);
    expect(cmd(sim, { type: 'debugTier', tier: 1 }).ok).toBe(true);
    expect(sim.world.scalars[S.tier]).toBe(4);
    expect(cmd(sim, { type: 'debugTier', tier: 99 }).reason).toBe('invalid');
    expect(sim.world.scalars[S.treasury]).toBe(t0);
    expect(cmd(flatSim(3), { type: 'debugTier', tier: 2 }).reason).toBe('debug-only');
  });

  it('leaves everything ungated when a read has no scalars (a hand-built read)', () => {
    const sim = flatSim(3);
    const read = tileReadOf(sim.world as unknown as Record<string, ArrayLike<number>>);
    expect(estimate(read, cases[0]!.body).reason).toBeUndefined();
  });
});

describe('megaproject requirements', () => {
  it('lists, for each project, spare power and water against what the city has, measured from rated output', () => {
    const sim = readyCity();
    const w = sim.world;
    expect(powerBalance(w).supply).toBe(240);
    expect(waterBalance(w).supply).toBe(10 * 24);
    const r = megaRequirements(w, ARCH.ARCOLOGY);
    expect(r.power).toEqual({ have: 240 - powerBalance(w).demand, need: 150, ok: true });
    expect(r.met).toBe(true);
  });

  it('refuses a start below the population requirement and allows it at the requirement', () => {
    for (const arch of MEGA_ARCHS) {
      const sim = readyCity();
      const need = MEGA[arch]!.req.pop;
      if (MEGA[arch]!.req.power > 235) continue;
      sim.world.scalars[S.population] = need - 1;
      expect(start(sim, arch).reason, `arch ${arch} at ${need - 1}`).toBe('requirements');
      sim.world.scalars[S.population] = need;
      expect(start(sim, arch).ok, `arch ${arch} at ${need}`).toBe(true);
    }
  });

  it('refuses a start without spare water, and without spare power', () => {
    const noWater = readyCity();
    for (const s of noWater.world.bArch.keys()) if (noWater.world.bArch[s] === ARCH.WATER_PUMP) noWater.world.bArch[s] = 0;
    expect(waterBalance(noWater.world).supply).toBe(0);
    expect(start(noWater, ARCH.MECH_ARENA).reason).toBe('requirements');

    const lowPower = readyCity();
    const plants = [...lowPower.world.bArch.keys()].filter((s) => lowPower.world.bArch[s] === ARCH.POWER_PLANT);
    lowPower.world.bArch[plants[0]!] = 0;
    // 120 MW less the depot and plants' own draw is under the Arcology's 150 MW but over the Arena's 100 MW.
    expect(start(lowPower, ARCH.ARCOLOGY).reason).toBe('requirements');
    expect(start(lowPower, ARCH.MECH_ARENA).ok).toBe(true);
  });

  it('starts as a bare foundation under construction, charges the cost, is not undoable, and allows only one of each', () => {
    const sim = readyCity();
    const w = sim.world, before = w.scalars[S.treasury]!;
    const r = start(sim, ARCH.MECH_ARENA);
    expect(r.ok).toBe(true);
    expect(r.journal).toBeUndefined();
    const slot = slotOf(w, ARCH.MECH_ARENA);
    expect([w.bFlags[slot], w.bLevel[slot], w.bProg[slot], w.bW[slot], w.bH[slot]]).toEqual([BFLAG.CONSTRUCTING, 0, 0, 6, 6]);
    expect(w.scalars[S.treasury]).toBe(before - CATALOG.find((a) => a.id === ARCH.MECH_ARENA)!.cost);
    expect(cmd(sim, { type: 'placeBuilding', arch: ARCH.MECH_ARENA, x: 120, y: 105, rot: 0 }).reason).toBe('exists');
  });

  it('needs a road along one edge of the footprint', () => {
    const sim = readyCity();
    expect(cmd(sim, { type: 'placeBuilding', arch: ARCH.MECH_ARENA, x: 104, y: 112, rot: 0 }).reason).toBe('no-road');
    expect(cmd(sim, { type: 'placeBuilding', arch: ARCH.MECH_ARENA, x: 104, y: 105, rot: 0 }).ok).toBe(true);
  });

  it('reports each project for the panel: none, building with progress, done', () => {
    const sim = readyCity();
    const w = sim.world;
    expect(projectStatuses(w).map((p) => p.state)).toEqual(['none', 'none', 'none', 'none']);
    start(sim, ARCH.MECH_ARENA);
    const slot = slotOf(w, ARCH.MECH_ARENA);
    w.bLevel[slot] = 1; w.bProg[slot] = 128;
    const p = projectStatuses(w).find((q) => q.arch === ARCH.MECH_ARENA)!;
    expect(p).toMatchObject({ state: 'building', stage: 1, stages: 3 });
    expect(p.progress).toBeCloseTo((1 + 128 / 255) / 3, 5);
    w.bFlags[slot] = 0; w.bLevel[slot] = 3;
    expect(projectStatuses(w).find((q) => q.arch === ARCH.MECH_ARENA)).toMatchObject({ state: 'done', progress: 1 });
    expect(milestoneStats(w)).toMatchObject({ tier: MAX_TIER, nextAt: null, victory: false });
  });
});

describe('megaproject construction', () => {
  it('advances only with robots and material: no depot, no robots, and no material each stall it; with all three it finishes every stage', () => {
    const undo = shrink(ARCH.MECH_ARENA, 20, 400);
    try {
      // No depot: the job opens but no robot exists to work it.
      const bare = readyCity({ depot: false });
      expect(start(bare, ARCH.MECH_ARENA).ok).toBe(true);
      stepLog(bare, 400);
      const bs = slotOf(bare.world, ARCH.MECH_ARENA);
      expect(bare.world.aKind.some((k) => k !== 0)).toBe(false);
      expect([bare.world.jHave[bs], bare.world.jProg[bs], bare.world.bProg[bs], bare.world.bLevel[bs]]).toEqual([0, 0, 0, 0]);

      // A depot but no money for robots: the job opens and waits.
      const sim = readyCity();
      const w = sim.world;
      expect(start(sim, ARCH.MECH_ARENA).ok).toBe(true);
      const slot = slotOf(w, ARCH.MECH_ARENA);
      w.scalars[S.treasury] = 0;
      stepLog(sim, 600);
      expect(w.jKind[slot]).toBe(JOB.BUILD);
      expect(w.aKind.some((k) => k !== 0)).toBe(false);
      expect([w.jHave[slot], w.jProg[slot], w.bProg[slot], w.bLevel[slot]]).toEqual([0, 0, 0, 0]);

      // A builder but no material: it reaches the site and works, and progress stays at the zero fraction delivered.
      w.scalars[S.treasury] = 1_000_000;
      let guard = 0;
      while (!w.aKind.some((k) => k === AKIND.BUILDER) && guard++ < 200) stepLog(sim, 1);
      expect(w.aKind.some((k) => k === AKIND.BUILDER)).toBe(true);
      w.scalars[S.treasury] = 0;
      const store = w.bArch.indexOf(ARCH.DEPOT);
      for (let t = 0; t < 500; t++) { stepLog(sim, 1); w.bStock[store] = 0; w.scalars[S.treasury] = 0; }
      expect(w.aState.some((st, a) => w.aKind[a] === AKIND.BUILDER && st === AST.WORK)).toBe(true);
      expect([w.jHave[slot], w.jProg[slot], w.bProg[slot]]).toEqual([0, 0, 0]);

      // Material and robots: every stage runs, never ahead of the material delivered, and the project completes once.
      w.bStock[store] = DEPOT_START_STOCK;
      w.scalars[S.treasury] = 1_000_000;
      const log: SimEvent[] = [];
      guard = 0;
      while ((w.bFlags[slot]! & BFLAG.CONSTRUCTING) !== 0 && guard++ < 9000) {
        stepLog(sim, 1, log);
        if ((w.bFlags[slot]! & BFLAG.CONSTRUCTING) !== 0 && w.jKind[slot] === JOB.BUILD) {
          const need = w.jNeed[slot]!, have = w.jHave[slot]!;
          expect(need).toBe(20);
          expect(have).toBeLessThanOrEqual(need);
          expect(w.jProg[slot]).toBeLessThanOrEqual(have >= need ? JOB_MAX : Math.floor((have * JOB_MAX) / need));
        }
      }
      expect(w.bFlags[slot]! & BFLAG.CONSTRUCTING).toBe(0);
      expect([w.bLevel[slot], w.bProg[slot], w.jKind[slot]]).toEqual([3, 255, 0]);
      expect(log.filter((e) => e.type === 'megaStage').map((e) => (e as { stage: number }).stage)).toEqual([0, 1]);
      expect(log.filter((e) => e.type === 'megaComplete')).toHaveLength(1);
      expect(log.filter((e) => e.type === 'victory')).toHaveLength(0);
      expect(w.scalars[S.mega]).toBe(megaBit(ARCH.MECH_ARENA));
    } finally { undo(); }
  });

  it('restarts the job at each stage with that stage\'s material need', () => {
    const arch = ARCH.ARCOLOGY, stages = MEGA[arch]!.stages;
    const saved = stages.map((s) => ({ ...s }));
    stages.forEach((s, i) => { s.material = 10 + i; s.work = 300; });
    try {
      const sim = readyCity();
      const w = sim.world;
      expect(start(sim, arch).ok).toBe(true);
      const slot = slotOf(w, arch);
      stepLog(sim, 60);
      expect(w.jKind[slot]).toBe(JOB.BUILD);
      for (let k = 0; k < stages.length - 1; k++) {
        expect([w.bLevel[slot], w.jNeed[slot]]).toEqual([k, 10 + k]);
        w.jHave[slot] = w.jNeed[slot]!; w.jProg[slot] = JOB_MAX;
        const log = stepLog(sim, 1);
        expect(log.filter((e) => e.type === 'megaStage')).toHaveLength(1);
        expect([w.bLevel[slot], w.jNeed[slot], w.jHave[slot], w.jProg[slot], w.bProg[slot]]).toEqual([k + 1, 10 + k + 1, 0, 0, 0]);
      }
    } finally { stages.forEach((s, i) => Object.assign(s, saved[i])); }
  });

  it('wins the game once, when the Space Elevator is completed for the first time', () => {
    const sim = readyCity();
    const w = sim.world;
    expect(start(sim, ARCH.SPACE_ELEVATOR).reason).toBe('requirements');
    // The elevator needs 500 MW spare: two more plants.
    for (const x of [100, 106, 112]) grow(sim, ARCH.POWER_PLANT, x, 88);
    expect(start(sim, ARCH.SPACE_ELEVATOR).ok).toBe(true);
    const slot = slotOf(w, ARCH.SPACE_ELEVATOR);
    expect(megaStages(ARCH.SPACE_ELEVATOR)).toBe(5);
    let log = stepLog(sim, 80);
    expect(w.jKind[slot]).toBe(JOB.BUILD);
    w.bLevel[slot] = 4; w.jNeed[slot] = 1; w.jHave[slot] = 1; w.jProg[slot] = JOB_MAX;
    log = stepLog(sim, 2, log);
    expect(log.filter((e) => e.type === 'megaComplete')).toHaveLength(1);
    expect(log.filter((e) => e.type === 'victory')).toHaveLength(1);
    expect(milestoneStats(w).victory).toBe(true);
    expect(w.scalars[S.mega]! & megaBit(ARCH.SPACE_ELEVATOR)).not.toBe(0);
    expect(stepLog(sim, 50).filter((e) => e.type === 'victory')).toHaveLength(0);
  });
});

describe('megaproject effects', () => {
  const finished = (arch: number): Sim => {
    const sim = flatSim(11, true);
    grow(sim, arch, 100, 100);
    return sim;
  };

  it('Fusion Spire adds 2,000 MW to the power supply', () => {
    const sim = finished(ARCH.FUSION_SPIRE);
    expect(solveUtilities(sim).power.supply).toBe(2000);
    expect(powerBalance(sim.world).supply).toBe(2000);
  });

  it('Fusion Spire raises land value around it, fading to nothing at its radius', () => {
    const sim = finished(ARCH.FUSION_SPIRE);
    const w = sim.world, cx = 102, cy = 102;
    const far = landValueAt(w, cx + 30, cy);
    const aura = MEGA[ARCH.FUSION_SPIRE]!.aura;
    expect(landValueAt(w, cx + 1, cy)).toBeGreaterThan(landValueAt(w, cx + 8, cy));
    expect(landValueAt(w, cx + aura.radius, cy)).toBe(far);
    expect(landValueAt(w, cx + 7, cy) - far).toBe(Math.floor((aura.value * (aura.radius - 7)) / aura.radius));
    const bare = flatSim(11, true);
    expect(landValueAt(bare.world, cx + 1, cy)).toBe(far);
  });

  it('Arcology houses 5,000 residents and adds jobs and income', () => {
    const sim = finished(ARCH.ARCOLOGY);
    expect(countTotals(sim.world)).toMatchObject({ population: 5000, jobsC: 600 });
    expect(computeBudget(sim.world, 0).incomeC).toBe(MEGA[ARCH.ARCOLOGY]!.income);
  });

  it('Mech Arena lifts commercial demand with visitors and pays tourism income', () => {
    const sim = finished(ARCH.MECH_ARENA);
    const w = sim.world;
    const bare = flatSim(11, true);
    const t = countTotals(w);
    expect(t).toMatchObject({ population: 0, jobsC: 300, tourists: 3000 });
    expect(demandTargets(w, t)[1]).toBeGreaterThan(demandTargets(bare.world, countTotals(bare.world))[1]);
    expect(computeBudget(w, 0).incomeC).toBe(MEGA[ARCH.MECH_ARENA]!.income);
  });

  it('Space Elevator pays a massive monthly income', () => {
    const sim = finished(ARCH.SPACE_ELEVATOR);
    expect(computeBudget(sim.world, 0).incomeC).toBe(40000);
    expect(computeBudget(sim.world, 0).net).toBeGreaterThan(30000);
  });

  it('gives nothing while under construction, and nothing while the project has no power', () => {
    const sim = flatSim(11, true);
    grow(sim, ARCH.ARCOLOGY, 100, 100, 0.5);
    expect(countTotals(sim.world).population).toBe(0);
    expect(computeBudget(sim.world, 0).incomeC).toBe(0);
    expect(computeBudget(sim.world, 0).services, 'no upkeep through the build').toBe(0);
    expect(computeBudget(finished(ARCH.ARCOLOGY).world, 0).services).toBe(CATALOG.find((a) => a.id === ARCH.ARCOLOGY)!.upkeep);
    const dark = finished(ARCH.ARCOLOGY);
    dark.world.bFlags[slotOf(dark.world, ARCH.ARCOLOGY)] = BFLAG.UNPOWERED;
    expect(countTotals(dark.world).population).toBe(0);
  });
});

describe('determinism with megaprojects', () => {
  it('gives the same hash from a straight run and from a snapshot resumed mid-construction', () => {
    const undo = shrink(ARCH.MECH_ARENA, 12, 700);
    try {
      const build = (): Sim => {
        const sim = readyCity();
        expect(start(sim, ARCH.MECH_ARENA).ok).toBe(true);
        return sim;
      };
      const straight = build();
      stepLog(straight, 1400);
      const first = build();
      stepLog(first, 700);
      const slot = slotOf(first.world, ARCH.MECH_ARENA);
      expect(first.world.bLevel[slot]! > 0 || first.world.jHave[slot]! > 0 || first.world.bProg[slot]! > 0).toBe(true);
      const resumed = restore(snapshot(first));
      expect(stateHash(resumed)).toBe(stateHash(first));
      stepLog(resumed, 700);
      expect(stateHash(resumed)).toBe(stateHash(straight));
      const twin = build();
      stepLog(twin, 1400);
      expect(stateHash(twin)).toBe(stateHash(straight));
    } finally { undo(); }
  });
});
