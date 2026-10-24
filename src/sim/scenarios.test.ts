import { describe, expect, it, vi } from 'vitest';
import { ARCH, BFLAG, rciId } from './catalog.ts';
import { execute, type CommandBody } from './commands.ts';
import { D, F, MAP, S, SC, TERRAIN, WEATHER, ZONE, type World } from './layers.ts';
import { estimate } from './estimate.ts';
import { createSim, restore, simFromWorld, snapshot, stateHash } from './engine.ts';
import { setupScenario } from './scenarioTown.ts';
import { NODE, computeMods, mods } from './firmware.ts';
import { hashWorld } from './hash.ts';
import { LOAN_TIERS } from './economy/tables.ts';
import { megaBit } from './megaprojects.ts';
import { megaRequirements } from './milestones.ts';
import { evaluateScenario, goalValue, scenarioStats, scenarioSystem } from './scenarioRun.ts';
import {
  CHALLENGE_POOL, GOAL, GOALS, MOD, MOD_INFO, MOD_MASK, NO_VALUE, SCENARIOS, SCENARIO_COUNT, SCENARIO_ID, TABS, challengeId, challengeSpec, dailyKey, keyLabel, keyOf, nextScenario,
  scenarioById, scoreOf, specFor, starsFor, weeklyKey, type ScenarioDef, type ScenarioSpec,
} from './scenarios.ts';
import { generateTerrain } from './terrain.ts';
import { runTicks } from './testkit.ts';
import { PUMP_INLAND_ML, PUMP_NEAR_ML } from './utilities/tables.ts';
import { pumpOutput } from './utilities/solve.ts';
import { allocWorld, type Sim } from './world.ts';

const slug = (s: string): ScenarioDef => SCENARIOS.find((d) => d.slug === s)!;
const open = (s: string, opt: { debug?: boolean; disasters?: number } = {}): Sim => createSim(1, { ...opt, scenario: slug(s) });
const withMods = (mask: number, extra: Partial<ScenarioSpec> = {}): ScenarioSpec => ({ ...slug('first-light'), mods: mask, ...extra });
const run = (sim: Sim, body: CommandBody): { ok: boolean; reason?: string } => {
  sim.events = [];
  const ok = execute(sim, { ...body, id: 1, tick: 0 } as never);
  const rej = sim.events.find((e) => e.type === 'rejected');
  return { ok, reason: rej && rej.type === 'rejected' ? rej.reason : undefined };
};
const events = (sim: Sim, type: string) => sim.events.filter((e) => e.type === type);

/** Put a scenario back to "playing, nothing earned" so one sim serves many synthetic states. */
function reset(w: World): void {
  const sc = w.scenario;
  sc[SC.STATE] = 0; sc[SC.STARS] = 0; sc[SC.DONE_AT] = 0; sc[SC.VALUE] = 0; sc[SC.SCORE] = 0; sc[SC.LAST_MONTH] = 0; sc[SC.OVERRIDE] = 0;
  w.scalars[S.mega] = 0; w.scalars[S.month] = 0;
}

/** Stars the goal awards for a synthetic state: `set` mutates the world, the goal is then evaluated once. */
function starsAfter(sim: Sim, set: (w: World) => void): number {
  reset(sim.world);
  set(sim.world);
  evaluateScenario(sim);
  return sim.world.scenario[SC.STARS]!;
}

describe('scenario table', () => {
  it('has nine scenarios, three per tab, with unique ids, slugs and seeds', () => {
    expect(SCENARIOS).toHaveLength(9);
    expect(SCENARIO_COUNT).toBe(9);
    for (const tab of TABS) expect(SCENARIOS.filter((s) => s.tab === tab), tab).toHaveLength(3);
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(9);
    expect(new Set(SCENARIOS.map((s) => s.slug)).size).toBe(9);
    expect(new Set(SCENARIOS.map((s) => s.seed)).size).toBe(9);
    expect(SCENARIOS.map((s) => s.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('gives every scenario a known goal, monotone thresholds, a clock, named modifiers and a blurb', () => {
    const known = new Set(MOD_INFO.map((m) => m.bit));
    for (const s of SCENARIOS) {
      const g = GOALS[s.goal]!;
      expect(g, s.slug).toBeDefined();
      const [a, b, c] = s.t;
      if (g.better === 'high') expect(a < b && b < c, `${s.slug} thresholds rise`).toBe(true);
      else expect(a > b && b > c, `${s.slug} thresholds fall`).toBe(true);
      expect(s.months).toBeGreaterThan(0);
      expect(s.mods & ~MOD_MASK).toBe(0);
      for (let bit = 1; bit <= MOD_MASK; bit <<= 1) if (s.mods & bit) expect(known.has(bit), `${s.slug} mod ${bit}`).toBe(true);
      expect(s.blurb.length).toBeGreaterThan(20);
      expect(scenarioById(s.id)).toBe(s);
      expect(specFor(s.id)).toBe(s);
    }
  });

  it('covers every goal kind and every modifier bit at least once between scenarios and the challenge pool', () => {
    for (const kind of Object.values(GOAL)) expect(SCENARIOS.some((s) => s.goal === kind), `goal ${kind}`).toBe(true);
    const used = SCENARIOS.reduce((m, s) => m | s.mods, 0) | CHALLENGE_POOL.reduce((m, v) => m | v, 0);
    for (const m of MOD_INFO) expect(used & m.bit, m.name).toBe(m.bit);
    expect(MOD_INFO.map((m) => m.bit).reduce((a, b) => a | b, 0)).toBe(MOD_MASK);
  });

  it('chains Next through the table and ends after the last', () => {
    expect(nextScenario(1)?.id).toBe(2);
    expect(nextScenario(8)?.id).toBe(9);
    expect(nextScenario(9)).toBeUndefined();
  });

  it('registers the scenario layer: it is hashed and saved', () => {
    const sim = createSim(1);
    const before = hashWorld(sim.world);
    sim.world.scenario[SC.STARS] = 2;
    expect(hashWorld(sim.world)).not.toBe(before);
    const back = restore(snapshot(sim));
    expect(back.world.scenario[SC.STARS]).toBe(2);
  });
});

describe('opening state', () => {
  it('leaves the sandbox untouched: no scenario, base mods, an empty layer', () => {
    const sim = createSim(7, { starter: true });
    expect(Array.from(sim.world.scenario).every((v) => v === 0)).toBe(true);
    expect(scenarioStats(sim.world)).toBeNull();
    expect(mods(sim.world)).toEqual(computeMods(0, 0));
    const a = allocWorld(), b = allocWorld();
    generateTerrain(a, 5);
    generateTerrain(b, 5, {});
    expect(hashWorld(a)).toBe(hashWorld(b));
  });

  it('opens each scenario with its own seed, cash, tier, research and kit', () => {
    for (const s of SCENARIOS) {
      const sim = createSim(999, { scenario: s });
      const w = sim.world;
      expect(w.scalars[S.seed], s.slug).toBe(s.seed);
      expect(w.scalars[S.treasury], s.slug).toBe(s.cash);
      expect(w.scalars[S.tier], s.slug).toBe(s.tier);
      expect(w.firmware[F.RP], s.slug).toBe(s.rp);
      expect(w.scenario[SC.ID]).toBe(s.id);
      expect(w.scenario[SC.MODS]).toBe(s.mods);
      expect(w.scenario[SC.KIND]).toBe(s.goal);
      expect([w.scenario[SC.T1], w.scenario[SC.T2], w.scenario[SC.T3]]).toEqual([...s.t]);
      expect(w.scenario[SC.LIMIT]).toBe(s.months);
      expect(w.bArch.filter((a) => a === ARCH.DEPOT), `${s.slug} depot`).toHaveLength(1);
      expect(w.aKind.filter((k) => k === 1).length, `${s.slug} builders`).toBeGreaterThan(0);
    }
  }, 60000);

  it('builds the towns: Gridlock, Meteor Season, Bankrupt Burg and Space Race start with finished buildings, the rest with only a depot', () => {
    const count = (s: string): number => open(s).world.bArch.filter((a) => a !== 0).length;
    expect(count('gridlock')).toBeGreaterThanOrEqual(24);
    expect(count('meteor-season')).toBeGreaterThanOrEqual(12);
    expect(count('bankrupt-burg')).toBeGreaterThanOrEqual(12);
    expect(count('space-race')).toBeGreaterThanOrEqual(20);
    for (const s of ['first-light', 'dry-spell', 'flood-valley', 'fusion-rush', 'robot-strike']) expect(count(s), s).toBe(1);
    const jam = open('gridlock').world;
    expect(jam.bArch.filter((a) => a === rciId(ZONE.R, 2, 3)).length).toBeGreaterThan(0);
  }, 60000);

  it('places the starter kit or town for every scenario and for a spread of daily and weekly challenges, without logging a placement failure', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const specs: ScenarioSpec[] = [...SCENARIOS];
      for (let d = 1; d <= 16; d++) specs.push(challengeSpec('daily', dailyKey(new Date(Date.UTC(2026, 9, d, 12)))));
      for (let k = 1; k <= 6; k++) specs.push(challengeSpec('weekly', 202640 + k));
      for (const spec of specs) {
        const w = createSim(1, { scenario: spec }).world;
        const label = `${spec.id}:${spec.key}:${spec.seed}`;
        expect(w.bArch.filter((a) => a === ARCH.DEPOT).length, `${label} depot`).toBeGreaterThanOrEqual(1);
        expect(w.aKind.some((k) => k !== 0), `${label} crew`).toBe(true);
        if (spec.town) expect(w.bArch.filter((a) => a !== 0).length, `${label} town`).toBeGreaterThan(5);
      }
      expect(warn.mock.calls, 'a placement failure is logged').toEqual([]);
    } finally { warn.mockRestore(); }
  }, 180000);

  it('logs, rather than silently skipping, a scenario whose map has no flat dry site', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const sea = simFromWorld(allocWorld());
      setupScenario(sea, slug('first-light'));
      expect(sea.world.bArch.filter((a) => a === ARCH.DEPOT)).toHaveLength(0);
      setupScenario(simFromWorld(allocWorld()), slug('gridlock'));
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[0]![0])).toMatch(/no flat dry site for the starter kit/);
      expect(String(warn.mock.calls[1]![0])).toMatch(/no flat dry site for the jam town/);
    } finally { warn.mockRestore(); }
  });

  it('hands Bankrupt Burg its loan and an empty treasury, and Dry Spell a map with no river', () => {
    const burg = open('bankrupt-burg').world;
    expect(burg.loanAmt[0]).toBe(LOAN_TIERS[1]);
    expect(burg.scalars[S.treasury]).toBeLessThan(0);
    const dry = open('dry-spell').world;
    expect(dry.terrain.filter((t) => t === TERRAIN.RIVER).length).toBe(0);
    const wet = open('flood-valley').world;
    expect(wet.terrain.filter((t) => t === TERRAIN.WATER || t === TERRAIN.RIVER).length / (MAP * MAP)).toBeGreaterThan(0.33);
  }, 30000);

  it('opens the same scenario identically every time', () => {
    const a = open('meteor-season'), b = open('meteor-season');
    expect(stateHash(a)).toBe(stateHash(b));
  }, 30000);
});

describe('goal evaluation on synthetic states', () => {
  const pop = (n: number) => (w: World) => { w.scalars[S.population] = n; };

  it.each([
    ['first-light', [999, 1000, 1499, 1500, 2499, 2500], [0, 1, 1, 2, 2, 3]],
    ['dry-spell', [1499, 1500, 2499, 2500, 3999, 4000], [0, 1, 1, 2, 2, 3]],
    ['flood-valley', [4999, 5000, 7499, 7500, 9999, 10000], [0, 1, 1, 2, 2, 3]],
  ] as const)('%s awards stars by population', (name, values, stars) => {
    const sim = open(name);
    values.forEach((v, i) => expect(starsAfter(sim, pop(v)), `${name} at ${v}`).toBe(stars[i]));
  }, 30000);

  it('Bankrupt Burg counts net worth: the treasury less every loan', () => {
    const sim = open('bankrupt-burg');
    const owed = LOAN_TIERS[1];
    const worth = (t: number) => (w: World) => { w.scalars[S.treasury] = t; };
    expect(starsAfter(sim, worth(owed + 49999))).toBe(0);
    expect(starsAfter(sim, worth(owed + 50000))).toBe(1);
    expect(starsAfter(sim, worth(owed + 80000))).toBe(2);
    expect(starsAfter(sim, worth(owed + 120000))).toBe(3);
    reset(sim.world);
    sim.world.scalars[S.treasury] = 200000;
    sim.world.loanAmt[0] = 0;
    expect(goalValue(sim.world)).toBe(200000);
  }, 30000);

  it('Gridlock reads the failed-commute share and needs enough samples before it means anything', () => {
    const sim = open('gridlock');
    const commutes = (ok: number, bad: number) => (w: World) => { w.scalars[S.commuteOk] = ok; w.scalars[S.commuteFailed] = bad; };
    expect(starsAfter(sim, commutes(0, 0))).toBe(0);
    expect(starsAfter(sim, commutes(10, 0))).toBe(0);
    expect(goalValue(sim.world)).toBe(NO_VALUE);
    expect(starsAfter(sim, commutes(90, 10))).toBe(0);
    expect(starsAfter(sim, commutes(95, 5))).toBe(1);
    expect(starsAfter(sim, commutes(97, 3))).toBe(2);
    expect(starsAfter(sim, commutes(985, 15))).toBe(3);
  }, 30000);

  it('Meteor Season counts strikes only while 90 percent of the buildings stand', () => {
    const sim = open('meteor-season');
    const city = (strikes: number, ruins: number) => (w: World) => {
      w.bArch.fill(0); w.bFlags.fill(0);
      for (let i = 0; i < 100; i++) w.bArch[i] = rciId(ZONE.R, 0, 1);
      for (let i = 0; i < ruins; i++) w.bFlags[i] = BFLAG.RUBBLE;
      w.scenario[SC.PEAK] = 100;
      w.scenario[SC.STRIKES] = strikes;
    };
    expect(starsAfter(sim, city(2, 0))).toBe(0);
    expect(starsAfter(sim, city(3, 0))).toBe(1);
    expect(starsAfter(sim, city(3, 10))).toBe(1);
    expect(starsAfter(sim, city(3, 11))).toBe(0);
    expect(starsAfter(sim, city(5, 5))).toBe(2);
    expect(starsAfter(sim, city(7, 0))).toBe(3);
  }, 30000);

  it('Fusion Rush and Space Race score the month the project was finished in', () => {
    const done = (arch: number, month: number) => (w: World) => { w.scalars[S.mega] = megaBit(arch); w.scalars[S.month] = month; };
    const fusion = open('fusion-rush');
    expect(starsAfter(fusion, (w) => { w.scalars[S.month] = 10; })).toBe(0);
    expect(starsAfter(fusion, done(ARCH.FUSION_SPIRE, 24))).toBe(1);
    expect(starsAfter(fusion, done(ARCH.FUSION_SPIRE, 20))).toBe(2);
    expect(starsAfter(fusion, done(ARCH.FUSION_SPIRE, 16))).toBe(3);
    expect(starsAfter(fusion, done(ARCH.FUSION_SPIRE, 25))).toBe(0);
    expect(starsAfter(fusion, done(ARCH.SPACE_ELEVATOR, 3))).toBe(0);
    const space = open('space-race');
    expect(starsAfter(space, done(ARCH.SPACE_ELEVATOR, 60))).toBe(1);
    expect(starsAfter(space, done(ARCH.SPACE_ELEVATOR, 50))).toBe(2);
    expect(starsAfter(space, done(ARCH.SPACE_ELEVATOR, 40))).toBe(3);
    expect(starsAfter(space, done(ARCH.FUSION_SPIRE, 3))).toBe(0);
  }, 30000);

  it('keeps the month a project finished in even when the monthly check comes later', () => {
    const sim = open('fusion-rush');
    reset(sim.world);
    sim.world.scalars[S.mega] = megaBit(ARCH.FUSION_SPIRE);
    sim.world.scalars[S.month] = 14;
    evaluateScenario(sim);
    expect(sim.world.scenario[SC.DONE_AT]).toBe(15);
    sim.world.scalars[S.month] = 22;
    expect(goalValue(sim.world)).toBe(14);
  }, 30000);

  it('Robot Strike counts researched Construction nodes only', () => {
    const sim = open('robot-strike');
    const nodes = (...ids: number[]) => (w: World) => { w.firmware[F.RESEARCH] = ids.reduce((m, n) => m | (1 << n), 0); };
    expect(starsAfter(sim, nodes(NODE.HEAVY_LIFTERS, NODE.ROTOR_UPGRADE, NODE.DEPOT_FAB, NODE.LONG_RANGE))).toBe(0);
    expect(starsAfter(sim, nodes(NODE.QUICK_SET, NODE.CREW_COORD))).toBe(1);
    expect(starsAfter(sim, nodes(NODE.QUICK_SET, NODE.CREW_COORD, NODE.PARALLEL_FAB))).toBe(2);
    expect(starsAfter(sim, nodes(NODE.QUICK_SET, NODE.CREW_COORD, NODE.PARALLEL_FAB, NODE.REBUILD, NODE.FLEET_SHARE))).toBe(3);
  }, 30000);

  it('starsFor handles both directions and exact thresholds', () => {
    expect(starsFor(GOAL.POP, 1000, [1000, 1500, 2500])).toBe(1);
    expect(starsFor(GOAL.POP, 999.9, [1000, 1500, 2500])).toBe(0);
    expect(starsFor(GOAL.COMMUTE, 5, [5, 3, 1.5])).toBe(1);
    expect(starsFor(GOAL.COMMUTE, 5.1, [5, 3, 1.5])).toBe(0);
    expect(starsFor(GOAL.COMMUTE, 1.5, [5, 3, 1.5])).toBe(3);
    expect(starsFor(GOAL.FUSION, NO_VALUE, [24, 20, 16])).toBe(0);
    expect(starsFor(999, 1, [1, 2, 3])).toBe(0);
  });

  it('pays a score of stars first, then months left', () => {
    expect(scoreOf(0, 10)).toBe(0);
    expect(scoreOf(1, 0)).toBe(1000);
    expect(scoreOf(3, 7)).toBe(3070);
    expect(scoreOf(2, 20)).toBeLessThan(scoreOf(3, 0));
    expect(scoreOf(1, -4)).toBe(1000);
  });
});

describe('stars, winning and the clock', () => {
  /** Run the scenario system for a month boundary reached at `month` with `population` residents. */
  const arrive = (sim: Sim, month: number, population: number): void => {
    sim.events = [];
    sim.world.scalars[S.month] = month;
    sim.world.scalars[S.population] = population;
    scenarioSystem(sim);
  };

  it('fires one star event per level and keeps playing while the clock runs', () => {
    const sim = open('first-light');
    arrive(sim, 2, 1000);
    expect(events(sim, 'scenarioStar')).toEqual([{ type: 'scenarioStar', tick: 0, stars: 1 }]);
    expect(sim.world.scenario[SC.STATE]).toBe(0);
    arrive(sim, 3, 1100);
    expect(events(sim, 'scenarioStar')).toHaveLength(0);
    arrive(sim, 4, 1600);
    expect(events(sim, 'scenarioStar')).toEqual([{ type: 'scenarioStar', tick: 0, stars: 2 }]);
    expect(scenarioStats(sim.world)).toMatchObject({ state: 0, stars: 2, monthsLeft: 8, limit: 12, month: 4 });
  });

  it('keeps a star once earned, even if the city shrinks', () => {
    const sim = open('first-light');
    arrive(sim, 1, 1200);
    arrive(sim, 2, 100);
    expect(sim.world.scenario[SC.STARS]).toBe(1);
  });

  it('ends won on the spot at three stars, scoring the months left', () => {
    const sim = open('first-light');
    arrive(sim, 5, 2600);
    expect(sim.world.scenario[SC.STATE]).toBe(1);
    expect(events(sim, 'scenarioEnd')).toEqual([{ type: 'scenarioEnd', tick: 0, won: true, stars: 3, score: scoreOf(3, 7) }]);
    expect(scenarioStats(sim.world)).toMatchObject({ state: 1, stars: 3, score: 3070, endedAt: 5 });
  });

  it('fails on time out with no star', () => {
    const sim = open('first-light');
    arrive(sim, 11, 400);
    expect(sim.world.scenario[SC.STATE]).toBe(0);
    arrive(sim, 12, 400);
    expect(sim.world.scenario[SC.STATE]).toBe(2);
    expect(events(sim, 'scenarioEnd')).toEqual([{ type: 'scenarioEnd', tick: 0, won: false, stars: 0, score: 0 }]);
    expect(scenarioStats(sim.world)).toMatchObject({ state: 2, stars: 0, score: 0, monthsLeft: 0 });
  });

  it('wins on time out with one or two stars', () => {
    const sim = open('first-light');
    arrive(sim, 12, 1200);
    expect(sim.world.scenario[SC.STATE]).toBe(1);
    expect(sim.world.scenario[SC.STARS]).toBe(1);
    expect(sim.world.scenario[SC.SCORE]).toBe(1000);
  });

  it('counts a project finished in the last month before the clock stops it', () => {
    const sim = open('fusion-rush');
    sim.world.scalars[S.mega] = megaBit(ARCH.FUSION_SPIRE);
    arrive(sim, 24, 0);
    expect(sim.world.scenario[SC.STATE]).toBe(1);
    expect(sim.world.scenario[SC.STARS]).toBe(1);
    const late = open('fusion-rush');
    arrive(late, 24, 0);
    expect(late.world.scenario[SC.STATE]).toBe(2);
  });

  it('does nothing once it has ended, and nothing at all in the sandbox', () => {
    const sim = open('first-light');
    arrive(sim, 5, 2600);
    arrive(sim, 6, 0);
    expect(events(sim, 'scenarioEnd')).toHaveLength(0);
    expect(sim.world.scenario[SC.STARS]).toBe(3);
    const sandbox = createSim(1);
    arrive(sandbox, 40, 0);
    expect(events(sandbox, 'scenarioEnd')).toHaveLength(0);
    expect(sandbox.world.scenario[SC.STATE]).toBe(0);
  });

  it('counts meteors that land through the disasters events', () => {
    const sim = open('meteor-season');
    sim.world.scalars[S.tick] = 77;
    sim.events.push({ type: 'disaster', tick: 77, kind: 'meteor', phase: 'impact', x: 1, y: 1, radius: 5, arch: 0, impactTick: 77 });
    sim.events.push({ type: 'disaster', tick: 77, kind: 'meteor', phase: 'start', x: 1, y: 1, radius: 5, arch: 0, impactTick: 77 });
    sim.events.push({ type: 'disaster', tick: 70, kind: 'meteor', phase: 'impact', x: 1, y: 1, radius: 5, arch: 0, impactTick: 70 });
    sim.events.push({ type: 'disaster', tick: 77, kind: 'quake', phase: 'impact', x: 1, y: 1, radius: 5, arch: 0, impactTick: 77 });
    scenarioSystem(sim);
    expect(sim.world.scenario[SC.STRIKES]).toBe(1);
  });

  it('counts a meteor a Shield Dome stopped as a strike survived, but not a rod catching lightning', () => {
    const sim = open('meteor-season');
    sim.world.scalars[S.tick] = 90;
    sim.events.push({ type: 'hazardBlocked', tick: 90, by: 'dome', x: 4, y: 4 });
    sim.events.push({ type: 'hazardBlocked', tick: 90, by: 'rod', x: 4, y: 4 });
    sim.events.push({ type: 'hazardBlocked', tick: 80, by: 'dome', x: 4, y: 4 });
    scenarioSystem(sim);
    expect(sim.world.scenario[SC.STRIKES]).toBe(1);
  });

  it('finishScenario banks the stars so far, and refuses with none', () => {
    const sim = open('first-light');
    expect(run(sim, { type: 'finishScenario' })).toEqual({ ok: false, reason: 'not-ready' });
    arrive(sim, 3, 1200);
    expect(run(sim, { type: 'finishScenario' }).ok).toBe(true);
    expect(sim.world.scenario[SC.STATE]).toBe(1);
    expect(sim.world.scenario[SC.SCORE]).toBe(scoreOf(1, 9));
    expect(run(sim, { type: 'finishScenario' })).toEqual({ ok: false, reason: 'ended' });
    expect(run(createSim(1), { type: 'finishScenario' })).toEqual({ ok: false, reason: 'no-scenario' });
  });

  it('debugScenario runs the real star logic from a chosen metric, in debug sessions only', () => {
    const plain = open('first-light');
    expect(run(plain, { type: 'debugScenario', value: 3000 })).toEqual({ ok: false, reason: 'debug-only' });
    const sim = open('first-light', { debug: true });
    expect(run(sim, { type: 'debugScenario', value: 1000 }).ok).toBe(true);
    expect(sim.world.scenario[SC.STARS]).toBe(1);
    expect(run(sim, { type: 'debugScenario', value: 3000 }).ok).toBe(true);
    expect(sim.world.scenario[SC.STATE]).toBe(1);
    expect(sim.world.scenario[SC.STARS]).toBe(3);
    expect(run(sim, { type: 'debugScenario', value: -1 })).toEqual({ ok: false, reason: 'invalid' });
    expect(run(createSim(1, { debug: true }), { type: 'debugScenario', value: 5 })).toEqual({ ok: false, reason: 'no-scenario' });
  });
});

describe('modifiers apply through mods()', () => {
  it('derives mods(world) from the stored mask for every scenario', () => {
    for (const s of SCENARIOS) expect(mods(createSim(1, { scenario: s }).world), s.slug).toEqual(computeMods(0, 0, s.mods));
  }, 60000);

  it('keeps every sandbox value when the mask is empty', () => {
    expect(computeMods(0, 0, 0)).toEqual(computeMods(0, 0));
    expect(computeMods(0, 0).taxCap).toBe(20);
    expect(computeMods(0, 0).megaReq).toBe(1);
    expect(computeMods(0, 0).disasterFloor).toBe(0);
  });

  it('halves hauler speed and stacks with research', () => {
    expect(computeMods(0, 0, MOD.HAULER_SLOW).haulerSpeed).toBe(0.5);
    expect(computeMods(1 << NODE.ROTOR_UPGRADE, 0, MOD.HAULER_SLOW).haulerSpeed).toBeCloseTo(0.6);
    expect(computeMods(0, 0, MOD.HAULER_SLOW).haulCap).toBe(computeMods(0, 0).haulCap);
  });

  it('halves the robots a depot keeps, and the starter crew with them', () => {
    const half = computeMods(0, 0, MOD.HALF_ROBOTS), full = computeMods(0, 0);
    expect(half.buildersPerDepot).toBe(full.buildersPerDepot / 2);
    expect(half.haulersPerDepot).toBe(full.haulersPerDepot / 2);
    const w = open('robot-strike').world;
    expect(w.aKind.filter((k) => k === 1)).toHaveLength(1);
    expect(w.aKind.filter((k) => k === 2)).toHaveLength(1);
    const normal = open('first-light').world;
    expect(normal.aKind.filter((k) => k === 1)).toHaveLength(2);
    expect(normal.aKind.filter((k) => k === 2)).toHaveLength(2);
  }, 30000);

  it('bans roads across water only when No bridges is on', () => {
    const cross: CommandBody = { type: 'placeRoad', ax: 40, ay: 40, bx: 46, by: 40, cls: 1 };
    const strip = (sim: Sim) => { for (let x = 42; x <= 44; x++) { sim.world.terrain[40 * MAP + x] = TERRAIN.WATER; sim.world.waterDepth[40 * MAP + x] = 20; } };
    const flood = open('flood-valley');
    strip(flood);
    expect(estimate(flood.world, cross, 1e9).reason).toBe('no-bridges');
    expect(run(flood, cross)).toEqual({ ok: false, reason: 'no-bridges' });
    const free = open('first-light');
    strip(free);
    expect(estimate(free.world, cross, 1e9).reason).toBeUndefined();
    expect(estimate(free.world, cross, 1e9).cost).toBeGreaterThan(0);
  }, 30000);

  it('lets the ghost estimate read the ban from the mirrored scenario layer alone', () => {
    const layers = { terrain: new Uint8Array(MAP * MAP).fill(TERRAIN.GRASS), height: new Int16Array(MAP * MAP), waterDepth: new Uint8Array(MAP * MAP), road: new Uint16Array(MAP * MAP), zone: new Uint8Array(MAP * MAP), bId: new Uint16Array(MAP * MAP) };
    layers.terrain[10 * MAP + 12] = TERRAIN.WATER;
    const cross: CommandBody = { type: 'placeRoad', ax: 10, ay: 10, bx: 14, by: 10, cls: 1 };
    expect(estimate(layers, cross).reason).toBeUndefined();
    const scenario = new Float64Array(24);
    scenario[SC.MODS] = MOD.NO_BRIDGES;
    expect(estimate({ ...layers, scenario }, cross).reason).toBe('no-bridges');
  });

  it('locks the burner power plant but not solar', () => {
    const sim = createSim(1, { scenario: withMods(MOD.NO_POWER_PLANT, { cash: 1e9 }) });
    const at = (arch: number): CommandBody => ({ type: 'placeBuilding', arch, x: 120, y: 120, rot: 0 });
    for (let y = 118; y < 128; y++) for (let x = 118; x < 130; x++) { sim.world.terrain[y * MAP + x] = TERRAIN.GRASS; sim.world.waterDepth[y * MAP + x] = 0; sim.world.bId[y * MAP + x] = 0; sim.world.road[y * MAP + x] = 0; }
    expect(run(sim, at(ARCH.POWER_PLANT))).toEqual({ ok: false, reason: 'scenario-locked' });
    expect(run(sim, at(ARCH.SOLAR_FARM)).ok).toBe(true);
    const sandbox = createSim(1);
    expect(estimate(sandbox.world, at(ARCH.POWER_PLANT), 1e9).reason).not.toBe('scenario-locked');
  });

  it('caps taxes in the Tax cap scenario', () => {
    const sim = createSim(1, { scenario: withMods(MOD.TAX_CAP) });
    expect(run(sim, { type: 'setTax', rate: 13 })).toEqual({ ok: false, reason: 'tax-cap' });
    expect(run(sim, { type: 'setTax', rate: 12 }).ok).toBe(true);
    expect(run(sim, { type: 'setTax', rate: 21 })).toEqual({ ok: false, reason: 'bounds' });
    expect(run(createSim(1), { type: 'setTax', rate: 20 }).ok).toBe(true);
  });

  it('gives pumps only their inland output on Dry Spell', () => {
    const near = (sim: Sim): number => {
      const w = sim.world;
      for (let y = 60; y < 70; y++) for (let x = 60; x < 70; x++) { w.terrain[y * MAP + x] = x < 63 ? TERRAIN.WATER : TERRAIN.GRASS; w.waterDepth[y * MAP + x] = x < 63 ? 20 : 0; }
      w.bArch[0] = ARCH.WATER_PUMP; w.bX[0] = 64; w.bY[0] = 64; w.bW[0] = 2; w.bH[0] = 2;
      return pumpOutput(w, 0);
    };
    expect(near(createSim(1))).toBe(PUMP_NEAR_ML);
    expect(near(open('dry-spell'))).toBe(PUMP_INLAND_ML);
  }, 30000);

  it('eases megaproject requirements to 15 percent in the fast-track scenarios', () => {
    const sandbox = megaRequirements(createSim(1).world, ARCH.FUSION_SPIRE);
    expect([sandbox.pop.need, sandbox.water.need]).toEqual([25000, 80]);
    const eased = megaRequirements(open('fusion-rush').world, ARCH.FUSION_SPIRE);
    expect([eased.pop.need, eased.water.need]).toEqual([3750, 12]);
    expect(megaRequirements(open('space-race').world, ARCH.SPACE_ELEVATOR).pop.need).toBe(12000);
  }, 30000);

  it('pins the disasters setting at or above the scenario floor', () => {
    const storms = createSim(1, { disasters: 0, scenario: withMods(MOD.STORMS_MONTHLY) });
    expect(storms.world.disaster[D.MODE]).toBe(1);
    expect(run(storms, { type: 'setDisasters', mode: 0 }).ok).toBe(true);
    expect(storms.world.disaster[D.MODE]).toBe(1);
    expect(run(storms, { type: 'setDisasters', mode: 2 }).ok).toBe(true);
    expect(storms.world.disaster[D.MODE]).toBe(2);
    const prone = createSim(1, { disasters: 0, scenario: withMods(MOD.DISASTERS_UP) });
    run(prone, { type: 'setDisasters', mode: 1 });
    expect(prone.world.disaster[D.MODE]).toBe(2);
    const sandbox = createSim(1, { disasters: 0 });
    run(sandbox, { type: 'setDisasters', mode: 0 });
    expect(sandbox.world.disaster[D.MODE]).toBe(0);
  });

  /** A world one tick short of closing month `month`, so stepping crosses the boundary through the real economy and scenario systems. */
  const nearMonth = (sim: Sim, month: number): void => {
    const s = sim.world.scalars;
    s[S.month] = month - 1; s[S.day] = month - 1; s[S.tickOfDay] = 4800 - 5; s[S.tick] = (month - 1) * 4800 + 4795;
  };

  it('breaks a storm every month under Monthly storms', () => {
    const sim = createSim(1, { scenario: withMods(MOD.STORMS_MONTHLY) });
    sim.world.scalars[S.weather] = WEATHER.CLEAR;
    nearMonth(sim, 2);
    runTicks(sim, 10);
    expect(sim.world.scalars[S.month]).toBe(2);
    expect(sim.world.scalars[S.weather]).toBe(WEATHER.STORM);
    expect(sim.events.some((e) => e.type === 'weather' && e.weather === WEATHER.STORM)).toBe(true);
  });

  it('aims a meteor at the city every third month under Meteor season, and not in between', () => {
    const early = open('meteor-season');
    nearMonth(early, 2);
    runTicks(early, 10);
    expect(early.world.disaster[D.METEOR_AT]).toBe(0);
    const sim = open('meteor-season');
    nearMonth(sim, 3);
    runTicks(sim, 10);
    expect(sim.world.scalars[S.month]).toBe(3);
    expect(sim.world.disaster[D.METEOR_AT]).not.toBe(0);
    expect(sim.events.some((e) => e.type === 'disaster' && e.kind === 'meteor' && e.phase === 'start')).toBe(true);
  }, 60000);
});

describe('determinism and resume', () => {
  it('replays a scenario across a month boundary identically, and resumes the same from a snapshot', () => {
    const cross = (): Sim => {
      const sim = open('meteor-season');
      sim.world.scalars[S.month] = 2; sim.world.scalars[S.day] = 2; sim.world.scalars[S.tickOfDay] = 4790; sim.world.scalars[S.tick] = 4790;
      return sim;
    };
    const straight = cross();
    runTicks(straight, 200);
    const again = cross();
    runTicks(again, 200);
    expect(stateHash(again)).toBe(stateHash(straight));
    expect(straight.world.scalars[S.month]).toBe(3);
    expect(straight.world.disaster[D.METEOR_AT]! + straight.world.scenario[SC.STRIKES]!).toBeGreaterThan(0);

    const first = cross();
    runTicks(first, 12);
    const resumed = restore(snapshot(first));
    expect(stateHash(resumed)).toBe(stateHash(first));
    runTicks(resumed, 188);
    expect(stateHash(resumed)).toBe(stateHash(straight));
    expect(scenarioStats(resumed.world)).toEqual(scenarioStats(straight.world));
  }, 120000);

  it('keeps an ended scenario ended after a save and load', () => {
    const sim = open('first-light');
    sim.world.scalars[S.month] = 12;
    scenarioSystem(sim);
    const back = restore(snapshot(sim));
    expect(scenarioStats(back.world)).toMatchObject({ state: 2, stars: 0, id: 1 });
    expect(stateHash(back)).toBe(stateHash(sim));
  }, 30000);
});

describe('daily and weekly challenges', () => {
  const day = (y: number, m: number, d: number, h = 12): Date => new Date(Date.UTC(y, m - 1, d, h));

  it('keys the UTC calendar day', () => {
    expect(dailyKey(day(2026, 10, 24))).toBe(20261024);
    expect(dailyKey(new Date('2026-10-24T23:59:59Z'))).toBe(20261024);
    expect(dailyKey(new Date('2026-10-25T00:00:00Z'))).toBe(20261025);
    expect(keyLabel('daily', 20261024)).toBe('2026-10-24');
  });

  it('keys the ISO week: Monday start, week 1 holds the first Thursday', () => {
    expect(weeklyKey(day(2026, 10, 24))).toBe(202643);
    for (let d = 19; d <= 25; d++) expect(weeklyKey(day(2026, 10, d)), `Oct ${d}`).toBe(202643);
    expect(weeklyKey(day(2026, 10, 26))).toBe(202644);
    expect(weeklyKey(day(2026, 1, 1))).toBe(202601);
    expect(weeklyKey(day(2021, 1, 3))).toBe(202053);
    expect(weeklyKey(day(2024, 12, 30))).toBe(202501);
    expect(keyLabel('weekly', 202643)).toBe('2026-W43');
    expect(keyOf('daily', day(2026, 10, 24))).toBe(20261024);
    expect(keyOf('weekly', day(2026, 10, 24))).toBe(202643);
  });

  it('makes the same challenge for the same date, every time', () => {
    const a = challengeSpec('daily', 20261024), b = challengeSpec('daily', 20261024);
    expect(a).toEqual(b);
    expect(a.seed).toBe(b.seed);
    const sim1 = createSim(1, { scenario: a }), sim2 = createSim(99, { scenario: b });
    expect(stateHash(sim1)).toBe(stateHash(sim2));
    expect(specFor(SCENARIO_ID.DAILY, 20261024)).toEqual(a);
    expect(specFor(SCENARIO_ID.WEEKLY, 202643)).toEqual(challengeSpec('weekly', 202643));
    expect(specFor(SCENARIO_ID.DAILY)).toBeUndefined();
    expect(specFor(55)).toBeUndefined();
  }, 30000);

  it('differs across dates and between a daily and a weekly', () => {
    const seeds = new Set<number>(), shapes = new Set<string>();
    for (let d = 1; d <= 28; d++) {
      const spec = challengeSpec('daily', dailyKey(day(2026, 10, d)));
      seeds.add(spec.seed);
      shapes.add(`${spec.mods}:${spec.goal}:${spec.t.join(',')}`);
    }
    expect(seeds.size).toBe(28);
    expect(shapes.size).toBeGreaterThan(10);
    expect(challengeSpec('daily', 20261024).seed).not.toBe(challengeSpec('daily', 20261025).seed);
    expect(challengeSpec('daily', 202643).seed).not.toBe(challengeSpec('weekly', 202643).seed);
  });

  it('draws two or three modifiers from the pool, a short goal and a map', () => {
    const pool = CHALLENGE_POOL.reduce((m, v) => m | v, 0);
    const counts = new Set<number>();
    for (let d = 1; d <= 60; d++) {
      const spec = challengeSpec(d % 2 ? 'daily' : 'weekly', 20260100 + d);
      const bits = MOD_INFO.filter((m) => spec.mods & m.bit).length;
      counts.add(bits);
      expect(bits === 2 || bits === 3, `mods ${spec.mods}`).toBe(true);
      expect(spec.mods & ~pool).toBe(0);
      expect([GOAL.POP, GOAL.TREASURY]).toContain(spec.goal);
      expect(GOALS[spec.goal]!.better).toBe('high');
      expect(spec.t[0] < spec.t[1] && spec.t[1] < spec.t[2]).toBe(true);
      expect(spec.months).toBe(d % 2 ? 8 : 14);
      expect(spec.terrain!.sea).toBeGreaterThanOrEqual(0.18);
      expect(spec.terrain!.sea).toBeLessThanOrEqual(0.36);
      expect(spec.start).toBe('starter');
    }
    expect(counts).toEqual(new Set([2, 3]));
  });

  it('plays a challenge through the same star logic and names it by date', () => {
    const spec = challengeSpec('daily', 20261024);
    const sim = createSim(1, { scenario: spec });
    expect(scenarioStats(sim.world)).toMatchObject({ id: SCENARIO_ID.DAILY, key: 20261024, kind: spec.goal, mods: spec.mods });
    expect(challengeId('daily', 20261024)).toBe('daily-20261024');
    sim.world.scalars[S.population] = spec.t[0];
    sim.world.scalars[S.treasury] = spec.goal === GOAL.TREASURY ? spec.t[0] + 1 : 0;
    sim.world.scalars[S.month] = 1;
    scenarioSystem(sim);
    expect(sim.world.scenario[SC.STARS]).toBeGreaterThanOrEqual(1);
  }, 30000);
});
