import { describe, expect, it } from 'vitest';
import { ARCH, BFLAG, rciId } from '../catalog.ts';
import { execute, type Command, type CommandBody } from '../commands.ts';
import { demandTargets, countTotals, computeBudget, refreshTotals } from '../economy/index.ts';
import { restore, snapshot, stateHash, step } from '../engine.ts';
import { buildSpeed, EDICT } from '../firmware.ts';
import { deriveIssues } from '../issues.ts';
import { C, F, MAP, MAX_REQUESTS, REGISTRY, S, SPEC } from '../layers.ts';
import { flatSim, road, depot } from '../robots/testkit.ts';
import { runTicks } from '../testkit.ts';
import type { Sim, SimEvent } from '../world.ts';
import {
  FESTIVAL, FESTIVALS, FESTIVAL_COUNT, FESTIVAL_MIN, GROUP_NAMES, KIND, KIND_COUNT, MONTH_TICKS, REQ, REQ_STATE, approvalDemand, approvalFactors, approvalIncome, approvalOf,
  approvalTarget, checkRequests, councilStats, festivalBlock, kindDef, monthlyApproval, openRequests, postNext, progressOf, requestText,
} from './index.ts';

let nextId = 1;
/** Run a command through the real executor; 'ok' or the rejection reason. */
function cmd(sim: Sim, body: CommandBody): string {
  const before = sim.events.length;
  execute(sim, { ...body, id: nextId++, tick: 0 } as Command);
  const e = sim.events[before]!;
  return e.type === 'rejected' ? e.reason : 'ok';
}
const events = <T extends SimEvent['type']>(sim: Sim, type: T): Extract<SimEvent, { type: T }>[] => sim.events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);
const set = (sim: Sim, approval: number): void => { sim.world.council[C.APPROVAL] = approval - 50; };

/** A depot, a street and `homes` finished houses on flat land, with a fat treasury. Debug on, so debugGrow and debugCouncil run. */
function homesCity(homes = 6, seed = 42): Sim {
  const sim = flatSim(seed, true);
  road(sim, 96, 104, 150, 104);
  depot(sim, 98, 100);
  for (let i = 0; i < homes; i++) expect(cmd(sim, { type: 'debugGrow', x: 100 + i * 4, y: 108, archetype: rciId(1, 1, 1), progress: 1 })).toBe('ok');
  sim.world.scalars[S.treasury] = 100000;
  refreshTotals(sim.world);
  return sim;
}

/** Move the budget month and the clock on by a month (landing a request check on the next step) and let the council notice. */
function nextMonth(sim: Sim): void {
  const sc = sim.world.scalars;
  sc[S.month]!++;
  sc[S.tick] = Math.ceil((sc[S.tick]! + MONTH_TICKS) / 20) * 20 - 1;
  step(sim);
}

describe('registry completeness', () => {
  it('declares the council layer, with room for every index and no two indices sharing a slot', () => {
    expect(REGISTRY.some((l) => l.name === 'council')).toBe(true);
    const len = SPEC.council.length;
    const used: number[] = [C.APPROVAL, C.MONTH, C.LOW_MONTHS, C.WARNED, C.NEXT_REQUEST, C.SEQ, C.DISASTER_MEM, C.OUTCOME_MEM, C.COMPLETED, C.FAILED, C.DECLINED, C.BUILT,
      C.FEST_KIND, C.FEST_START, C.FEST_END, C.FEST_X, C.FEST_Y, C.FEST_BOOST_END, C.FEST_BOOST, C.HELD, C.LAST_KIND];
    for (let k = 0; k < FESTIVAL_COUNT; k++) used.push(C.FEST_CD + k);
    expect(new Set(used).size).toBe(used.length);
    expect(Math.max(...used)).toBeLessThan(C.REQ0);
    expect(C.REQ0 + MAX_REQUESTS * C.REQ_STRIDE).toBeLessThanOrEqual(len);
    expect(Math.max(...Object.values(REQ)) + 1).toBeLessThanOrEqual(C.REQ_STRIDE);
  });

  it('has a definition, a group name and wording for every request kind, and a sane festival table', () => {
    expect(KIND_COUNT).toBe(7);
    expect(new Set(Object.values(KIND)).size).toBe(KIND_COUNT);
    for (let k = 0; k < KIND_COUNT; k++) {
      const d = kindDef(k);
      expect(d.id).toBe(k);
      expect(GROUP_NAMES[d.group], `group of kind ${k}`).toBeTruthy();
      expect(d.cash).toBeGreaterThan(0);
      expect(d.approval).toBeGreaterThan(0);
      expect(d.penalty).toBeGreaterThan(0);
      expect(requestText({ kind: k, x: 40, y: 200, target: 20, base: 0 }).length).toBeGreaterThan(10);
    }
    expect(GROUP_NAMES).toEqual(['Residents', 'Merchants', 'Industrialists', 'Engineers']);
    expect(FESTIVALS.map((f) => f.name)).toEqual(['Block Party', 'Robot Parade', 'Fireworks Night']);
    FESTIVALS.forEach((f, i) => { expect(f.id).toBe(i); expect(f.cost).toBeGreaterThan(0); expect(f.cooldownTicks).toBeGreaterThan(f.showTicks); });
    expect(FESTIVALS[0]!.cost).toBeLessThan(FESTIVALS[1]!.cost);
    expect(FESTIVALS[1]!.cost).toBeLessThan(FESTIVALS[2]!.cost);
    expect(FESTIVALS.map((f) => f.nightOnly)).toEqual([false, false, true]);
  });

  it('reads a zeroed layer (a new city, a save from before the council) as approval 50 with nothing open', () => {
    const sim = flatSim(1);
    expect(approvalOf(sim.world)).toBe(50);
    expect(openRequests(sim.world)).toEqual([]);
    expect(councilStats(sim.world).level).toBe('good');
  });
});

describe('approval', () => {
  it('stays inside 0..100 under the worst and the best city', () => {
    const sim = homesCity();
    const w = sim.world;
    w.pollution.fill(255); w.crime.fill(255); w.scalars[S.unemployment] = 1;
    w.scalars[S.taxR] = 20; w.scalars[S.taxC] = 20; w.scalars[S.taxI] = 20;
    w.scalars[S.commuteFailed] = 100; w.scalars[S.commuteOk] = 0;
    w.council[C.DISASTER_MEM] = 4; w.council[C.OUTCOME_MEM] = -50;
    for (let s = 0; s < w.bArch.length; s++) if (w.bArch[s] !== 0) w.bFlags[s] = w.bFlags[s]! | BFLAG.UNPOWERED;
    expect(approvalTarget(w)).toBe(0);
    set(sim, 0);
    for (let m = 0; m < 6; m++) { monthlyApproval(sim); expect(approvalOf(w)).toBeGreaterThanOrEqual(0); }
    w.pollution.fill(0); w.crime.fill(0); w.scalars[S.unemployment] = 0;
    w.scalars[S.taxR] = 0; w.scalars[S.taxC] = 0; w.scalars[S.taxI] = 0;
    w.scalars[S.commuteFailed] = 0; w.council[C.DISASTER_MEM] = 0; w.council[C.OUTCOME_MEM] = 50;
    for (const l of [w.covFire, w.covPolice, w.covHealth, w.covEdu, w.covPark]) l.fill(255);
    for (let s = 0; s < w.bArch.length; s++) w.bFlags[s] = w.bFlags[s]! & ~BFLAG.UNPOWERED;
    expect(approvalTarget(w)).toBeLessThanOrEqual(100);
    set(sim, 100);
    for (let m = 0; m < 6; m++) { monthlyApproval(sim); expect(approvalOf(w)).toBeLessThanOrEqual(100); }
    expect(approvalOf(w)).toBeGreaterThan(70);
  });

  /** Sweep one input over ordered values (worse to better when `rising`) and require the target never to move the wrong way, and to move overall. */
  function monotonic(label: string, apply: (sim: Sim, v: number) => void, values: number[], rising: boolean): void {
    it(`${label}: the target ${rising ? 'rises' : 'falls'} as the input grows`, () => {
      const sim = homesCity();
      const targets = values.map((v) => { apply(sim, v); return approvalTarget(sim.world); });
      for (let i = 1; i < targets.length; i++) {
        if (rising) expect(targets[i]!, `${label} ${values[i]}`).toBeGreaterThanOrEqual(targets[i - 1]!);
        else expect(targets[i]!, `${label} ${values[i]}`).toBeLessThanOrEqual(targets[i - 1]!);
      }
      const first = targets[0]!, last = targets[targets.length - 1]!;
      expect(rising ? last > first : last < first, `${label}: ${targets.join(', ')}`).toBe(true);
    });
  }

  monotonic('service coverage', (sim, v) => { for (const l of [sim.world.covFire, sim.world.covPolice, sim.world.covHealth, sim.world.covEdu, sim.world.covPark]) l.fill(v); }, [0, 100, 255], true);
  monotonic('fire cover alone', (sim, v) => { sim.world.covFire.fill(v); }, [0, 255], true);
  monotonic('unemployment', (sim, v) => { sim.world.scalars[S.unemployment] = v; }, [0, 0.1, 0.25, 0.5, 1], false);
  monotonic('pollution', (sim, v) => { sim.world.pollution.fill(v); }, [0, 60, 150, 255], false);
  monotonic('crime', (sim, v) => { sim.world.crime.fill(v); }, [0, 60, 150, 255], false);
  monotonic('failed commutes', (sim, v) => { sim.world.scalars[S.commuteOk] = 20; sim.world.scalars[S.commuteFailed] = v; }, [0, 5, 20, 80], false);
  monotonic('taxes', (sim, v) => { sim.world.scalars[S.taxR] = v; sim.world.scalars[S.taxC] = v; sim.world.scalars[S.taxI] = v; }, [0, 5, 9, 14, 20], false);
  monotonic('recent disasters', (sim, v) => { sim.world.council[C.DISASTER_MEM] = v; }, [0, 1, 2, 4], false);
  monotonic('request outcomes', (sim, v) => { sim.world.council[C.OUTCOME_MEM] = v; }, [-12, -4, 0, 4, 12], true);
  monotonic('outages', (sim, v) => {
    let n = 0;
    for (let s = 0; s < sim.world.bArch.length; s++) {
      if (sim.world.bArch[s] === 0) continue;
      sim.world.bFlags[s] = n < v ? sim.world.bFlags[s]! | BFLAG.UNPOWERED : sim.world.bFlags[s]! & ~BFLAG.UNPOWERED;
      n++;
    }
  }, [0, 2, 4, 6], false);

  it('reads the edicts: Curfew costs approval and Free Robo-Taxis adds it', () => {
    const sim = homesCity();
    const base = approvalTarget(sim.world);
    sim.world.firmware[F.EDICTS] = 1 << EDICT.CURFEW;
    expect(approvalTarget(sim.world)).toBe(base - 6);
    sim.world.firmware[F.EDICTS] = 1 << EDICT.ROBO_TAXIS;
    expect(approvalTarget(sim.world)).toBe(base + 5);
    sim.world.firmware[F.EDICTS] = (1 << EDICT.ROBO_TAXIS) | (1 << EDICT.CURFEW);
    expect(approvalTarget(sim.world)).toBe(base - 1);
  });

  it('names every factor and sums them with the base to the target', () => {
    const sim = homesCity();
    const f = approvalFactors(sim.world);
    expect(f.map((x) => x.key)).toEqual(['services', 'jobs', 'pollution', 'crime', 'commutes', 'outages', 'taxes', 'edicts', 'disasters', 'requests']);
    expect(approvalTarget(sim.world)).toBeCloseTo(58 + f.reduce((a, x) => a + x.value, 0), 6);
    expect(councilStats(sim.world).factors).toEqual(f);
  });

  it('closes a share of the gap to the target each month, from either side', () => {
    const sim = homesCity();
    const w = sim.world, t = approvalTarget(w);
    set(sim, 10);
    monthlyApproval(sim);
    const up = approvalOf(w);
    expect(up).toBeGreaterThan(10);
    expect(up).toBeLessThan(t);
    set(sim, 95);
    monthlyApproval(sim);
    expect(approvalOf(w)).toBeLessThan(95);
    expect(approvalOf(w)).toBeGreaterThan(t);
  });

  it('is run once per budget month by the council system, and not before', () => {
    const sim = homesCity();
    set(sim, 10);
    runTicks(sim, 40);
    expect(approvalOf(sim.world)).toBe(10);
    nextMonth(sim);
    const after = approvalOf(sim.world);
    expect(after).toBeGreaterThan(10);
    runTicks(sim, 40);
    expect(approvalOf(sim.world)).toBe(after);
  });
});

describe('what approval does', () => {
  it('does nothing at neutral approval', () => {
    const sim = homesCity();
    const w = sim.world, t = countTotals(w);
    const base = demandTargets(w, t), income = computeBudget(w, 0).income, speed = buildSpeed(w, 0);
    expect(approvalDemand(w)).toEqual([0, 0, 0]);
    expect(approvalIncome(w)).toBe(1);
    for (const a of [35, 50, 70]) {
      set(sim, a);
      expect(approvalDemand(w), `approval ${a}`).toEqual([0, 0, 0]);
      expect(demandTargets(w, t)).toEqual(base);
      expect(computeBudget(w, 0).income).toBe(income);
      expect(buildSpeed(w, 0)).toBe(speed);
    }
  });

  it('adds residential and commercial demand above 70', () => {
    const sim = homesCity();
    const w = sim.world, t = countTotals(w);
    set(sim, 50);
    const base = demandTargets(w, t);
    set(sim, 90);
    const high = demandTargets(w, t);
    expect(high[0] - base[0]).toBe(120);
    expect(high[1] - base[1]).toBe(120);
    expect(high[2]).toBe(base[2]);
    set(sim, 80);
    expect(demandTargets(w, t)[0]).toBeLessThan(high[0]);
  });

  it('drags every zone down, cuts the tax income and slows the robots below 35', () => {
    const sim = homesCity();
    const w = sim.world, t = countTotals(w);
    set(sim, 50);
    const base = demandTargets(w, t), income = computeBudget(w, 0).income, speed = buildSpeed(w, 0);
    expect(income).toBeGreaterThan(0);
    set(sim, 20);
    const low = demandTargets(w, t);
    for (let z = 0; z < 3; z++) expect(low[z]!, `zone ${z}`).toBeLessThan(base[z]!);
    expect(computeBudget(w, 0).income).toBeLessThan(income);
    expect(buildSpeed(w, 0)).toBeCloseTo(speed * 0.95, 9);
    set(sim, 0);
    expect(approvalIncome(w)).toBeCloseTo(1 - 35 * 0.004, 9);
    set(sim, 34);
    const a = computeBudget(w, 0).income;
    set(sim, 10);
    expect(computeBudget(w, 0).income).toBeLessThan(a);
  });

  it('warns once after 3 months under 15 and never ends the game', () => {
    const sim = homesCity();
    const w = sim.world;
    w.pollution.fill(255); w.crime.fill(255); w.scalars[S.unemployment] = 1; w.scalars[S.commuteFailed] = 50;
    set(sim, 5);
    for (let m = 0; m < 2; m++) { monthlyApproval(sim); expect(events(sim, 'approvalWarning')).toHaveLength(0); }
    monthlyApproval(sim);
    expect(events(sim, 'approvalWarning')).toHaveLength(1);
    expect(events(sim, 'approvalWarning')[0]!.months).toBe(3);
    monthlyApproval(sim); monthlyApproval(sim);
    expect(events(sim, 'approvalWarning')).toHaveLength(1);
    runTicks(sim, 50);
    expect(sim.world.scalars[S.tick]).toBeGreaterThan(0);
    set(sim, 40);
    w.pollution.fill(0); w.crime.fill(0); w.scalars[S.unemployment] = 0; w.scalars[S.commuteFailed] = 0;
    monthlyApproval(sim);
    expect(w.council[C.LOW_MONTHS]).toBe(0);
    expect(w.council[C.WARNED]).toBe(0);
  });
});

describe('council requests', () => {
  /** A city where exactly one request kind is fair. */
  const onlyPark = (): Sim => homesCity();

  it('posts nothing in an empty city and nothing while both slots are taken', () => {
    const empty = flatSim(3, true);
    expect(postNext(empty)).toBe(-1);
    const sim = onlyPark();
    expect(postNext(sim)).toBeGreaterThanOrEqual(0);
    expect(cmd(sim, { type: 'debugCouncil', kind: KIND.TRAFFIC })).toBe('ok');
    expect(postNext(sim)).toBe(-1);
    expect(cmd(sim, { type: 'debugCouncil', kind: KIND.BUILD_JOBS })).toBe('full');
  });

  it('proposes the same request for the same seed and world', () => {
    const a = onlyPark(), b = restore(snapshot(a));
    b.debug = true;
    const sa = postNext(a), sb = postNext(b);
    expect(sa).toBe(sb);
    expect(Array.from(a.world.council)).toEqual(Array.from(b.world.council));
    expect(stateHash(a)).toBe(stateHash(b));
    const c = homesCity(6, 7);
    postNext(c);
    expect(openRequests(c.world)[0]!.kind).toBe(openRequests(a.world)[0]!.kind);
  });

  it('only proposes goals the city can meet: a park needs a free site, no park nearby and the money', () => {
    const sim = onlyPark();
    const w = sim.world;
    expect(postNext(sim)).toBe(0);
    const r = openRequests(w)[0]!;
    expect(r.kind).toBe(KIND.PARK);
    expect(r.state).toBe(REQ_STATE.PENDING);
    expect(progressOf(w, r).done).toBe(false);
    const found: string[] = [];
    for (let y = r.y - 11; y <= r.y + 11 && found.length === 0; y++) for (let x = r.x - 11; x <= r.x + 11; x++) {
      const probe = restore(snapshot(sim));
      probe.debug = true;
      if (cmd(probe, { type: 'placeBuilding', arch: ARCH.PARK_SMALL, x, y, rot: 0 }) === 'ok') { found.push(`${x},${y}`); break; }
    }
    expect(found.length, 'a park can really be placed within 12 tiles').toBe(1);

    const poor = onlyPark();
    poor.world.scalars[S.treasury] = 100;
    expect(postNext(poor)).toBe(-1);

    const parked = onlyPark();
    expect(cmd(parked, { type: 'debugGrow', x: 112, y: 112, archetype: ARCH.PARK_SMALL, progress: 1 })).toBe('ok');
    expect(postNext(parked)).toBe(-1);
  });

  it('only proposes power, pollution, jobs and jam goals the world supports', () => {
    const sim = homesCity();
    const w = sim.world;
    // No power grid modelled, no smog, no demand, no jam: nothing but the park is fair.
    cmd(sim, { type: 'debugGrow', x: 112, y: 112, archetype: ARCH.PARK_SMALL, progress: 1 });
    expect(postNext(sim)).toBe(-1);

    w.scalars[S.grid] = 1;
    for (let s = 0, n = 0; s < w.bArch.length && n < 4; s++) if (w.bArch[s] === rciId(1, 1, 1)) { w.bFlags[s] = BFLAG.UNPOWERED; n++; }
    expect(postNext(sim)).toBe(0);
    let r = openRequests(w)[0]!;
    expect(r.kind).toBe(KIND.POWER);
    expect(r.target).toBeGreaterThan(r.base);
    expect(progressOf(w, r).done).toBe(false);
    w.council.fill(0, C.REQ0, C.REQ0 + C.REQ_STRIDE * MAX_REQUESTS);
    for (let s = 0; s < w.bArch.length; s++) w.bFlags[s] = w.bFlags[s]! & ~BFLAG.UNPOWERED;

    w.traffic[104 * MAP + 120] = 220;
    expect(postNext(sim)).toBe(0);
    r = openRequests(w)[0]!;
    expect(r.kind).toBe(KIND.TRAFFIC);
    expect([r.x, r.y]).toEqual([120, 104]);
    w.council.fill(0, C.REQ0, C.REQ0 + C.REQ_STRIDE * MAX_REQUESTS);
    w.council[C.LAST_KIND] = 0;
    w.traffic.fill(0);

    w.scalars[S.demandC] = 0.5;
    expect(postNext(sim)).toBe(-1);
    for (let y = 110; y < 114; y++) for (let x = 130; x < 144; x++) w.zone[y * MAP + x] = 2;
    expect(postNext(sim)).toBe(0);
    r = openRequests(w)[0]!;
    expect(r.kind).toBe(KIND.COMMERCIAL_JOBS);
    expect(r.target - r.base).toBe(20);
    w.council.fill(0, C.REQ0, C.REQ0 + C.REQ_STRIDE * MAX_REQUESTS);
    w.council[C.LAST_KIND] = 0;
    w.scalars[S.demandC] = 0;

    // Smog next to the homes and something that makes it.
    for (let y = 100; y < 130; y++) for (let x = 90; x < 130; x++) w.pollution[y * MAP + x] = 120;
    expect(postNext(sim)).toBe(-1);
    expect(cmd(sim, { type: 'debugGrow', x: 126, y: 112, archetype: rciId(3, 1, 1), progress: 1 })).toBe('ok');
    expect(postNext(sim)).toBe(0);
    r = openRequests(w)[0]!;
    expect(r.kind).toBe(KIND.POLLUTION);
    expect(r.target).toBeLessThan(progressOf(w, r).have);
  });

  it('every request has a deadline of 2 to 4 months and rewards from its kind, scaled by the tier', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const sim = homesCity(6, seed);
      sim.world.scalars[S.tier] = 2;
      sim.world.scalars[S.tick] = 1000 + seed * 37;
      postNext(sim);
      const r = openRequests(sim.world)[0]!;
      const months = (r.deadline - r.posted) / MONTH_TICKS;
      expect([2, 3, 4], `seed ${seed}`).toContain(months);
      expect(r.cash).toBe(kindDef(r.kind).cash * 3);
      expect(r.approval).toBe(kindDef(r.kind).approval);
      expect(r.group).toBe(kindDef(r.kind).group);
    }
  });

  it('posts on the request clock: the first after 2 to 4 months, then every 2 to 4, never more than 2 open', () => {
    const sim = homesCity();
    const posted: number[] = [];
    for (let m = 1; m <= 14; m++) {
      sim.events = [];
      nextMonth(sim);
      for (const e of events(sim, 'council')) if (e.phase === 'posted') posted.push(m);
      expect(openRequests(sim.world).length).toBeLessThanOrEqual(2);
    }
    expect(posted.length).toBeGreaterThanOrEqual(2);
    expect(posted[0]!).toBeGreaterThanOrEqual(3);
    expect(posted[0]!).toBeLessThanOrEqual(5);
    for (let i = 1; i < posted.length; i++) expect(posted[i]! - posted[i - 1]!).toBeGreaterThanOrEqual(2);
  });

  describe('outcomes', () => {
    /** An accepted commercial-jobs request on a city that can grow shops at will. */
    function accepted(kind: number = KIND.COMMERCIAL_JOBS): Sim {
      const sim = homesCity();
      expect(cmd(sim, { type: 'debugCouncil', kind, accept: true })).toBe('ok');
      sim.events = [];
      return sim;
    }
    const satisfy = (sim: Sim): void => {
      expect(cmd(sim, { type: 'debugGrow', x: 130, y: 108, archetype: rciId(2, 2, 3), progress: 1 })).toBe('ok');
      runTicks(sim, 40);
    };

    it('detects completion, pays cash, approval and research points once, and clears the slot', () => {
      const sim = accepted();
      const w = sim.world, r = openRequests(w)[0]!;
      expect(r.state).toBe(REQ_STATE.ACCEPTED);
      const treasury = w.scalars[S.treasury]!, approval = approvalOf(w), rp = w.firmware[F.RP]!;
      runTicks(sim, 40);
      expect(openRequests(w)).toHaveLength(1);
      expect(w.scalars[S.treasury]).toBe(treasury);
      satisfy(sim);
      expect(openRequests(w)).toHaveLength(0);
      expect(w.scalars[S.treasury]).toBe(treasury + r.cash);
      expect(approvalOf(w)).toBeCloseTo(approval + r.approval, 6);
      expect(w.firmware[F.RP]).toBe(rp + r.rp);
      expect(w.firmware[F.EARNED]).toBeGreaterThanOrEqual(r.rp);
      expect(w.council[C.COMPLETED]).toBe(1);
      expect(events(sim, 'council').filter((e) => e.phase === 'completed')).toHaveLength(1);
      const after = w.scalars[S.treasury]!;
      runTicks(sim, 100);
      expect(w.scalars[S.treasury]).toBeGreaterThanOrEqual(after);
      expect(w.council[C.COMPLETED]).toBe(1);
      expect(events(sim, 'council').filter((e) => e.phase === 'completed')).toHaveLength(1);
    });

    it('does not pay a request that is still waiting for an answer', () => {
      const sim = homesCity();
      expect(cmd(sim, { type: 'debugCouncil', kind: KIND.COMMERCIAL_JOBS })).toBe('ok');
      const treasury = sim.world.scalars[S.treasury]!;
      satisfy(sim);
      expect(openRequests(sim.world)).toHaveLength(1);
      expect(sim.world.scalars[S.treasury]).toBeGreaterThanOrEqual(treasury);
      expect(sim.world.council[C.COMPLETED]).toBe(0);
      expect(cmd(sim, { type: 'councilRespond', slot: 0, accept: true })).toBe('ok');
      runTicks(sim, 40);
      expect(sim.world.council[C.COMPLETED]).toBe(1);
    });

    it('fails a late request: approval drops by its penalty, no cash, the slot frees, the event says so', () => {
      const sim = accepted();
      const w = sim.world, r = openRequests(w)[0]!;
      const treasury = w.scalars[S.treasury]!, approval = approvalOf(w);
      w.scalars[S.tick] = r.deadline - 1;
      runTicks(sim, 25);
      expect(openRequests(w)).toHaveLength(0);
      expect(w.scalars[S.treasury]).toBe(treasury);
      expect(approvalOf(w)).toBeCloseTo(approval - r.penalty, 6);
      expect(w.council[C.FAILED]).toBe(1);
      const failed = events(sim, 'council').filter((e) => e.phase === 'failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]!.approval).toBe(-r.penalty);
      runTicks(sim, 100);
      expect(w.council[C.FAILED]).toBe(1);
    });

    it('lets an unanswered request lapse as a decline', () => {
      const sim = homesCity();
      cmd(sim, { type: 'debugCouncil', kind: KIND.COMMERCIAL_JOBS });
      sim.events = [];
      const r = openRequests(sim.world)[0]!;
      const approval = approvalOf(sim.world);
      sim.world.scalars[S.tick] = r.deadline;
      checkRequests(sim);
      expect(openRequests(sim.world)).toHaveLength(0);
      expect(approvalOf(sim.world)).toBeCloseTo(approval - 1, 6);
      expect(events(sim, 'council').map((e) => e.phase)).toEqual(['expired']);
    });

    it('accepts and declines through the command, declining costs a point, and bad slots are refused', () => {
      const sim = homesCity();
      cmd(sim, { type: 'debugCouncil', kind: KIND.COMMERCIAL_JOBS });
      const approval = approvalOf(sim.world);
      expect(cmd(sim, { type: 'councilRespond', slot: 1, accept: true })).toBe('no-request');
      expect(cmd(sim, { type: 'councilRespond', slot: 5, accept: true })).toBe('invalid');
      expect(cmd(sim, { type: 'councilRespond', slot: 0, accept: false })).toBe('ok');
      expect(openRequests(sim.world)).toHaveLength(0);
      expect(approvalOf(sim.world)).toBeCloseTo(approval - 1, 6);
      expect(sim.world.council[C.DECLINED]).toBe(1);
      cmd(sim, { type: 'debugCouncil', kind: KIND.COMMERCIAL_JOBS, accept: true });
      expect(cmd(sim, { type: 'councilRespond', slot: 0, accept: true })).toBe('no-request');
      expect(cmd(sim, { type: 'councilRespond', slot: 0, accept: false })).toBe('no-request');
    });

    it('refuses an answer meant for an earlier request when the slot now holds another', () => {
      const sim = homesCity();
      cmd(sim, { type: 'debugCouncil', kind: KIND.COMMERCIAL_JOBS });
      const first = openRequests(sim.world)[0]!;
      sim.world.scalars[S.tick] = first.deadline;
      checkRequests(sim);
      cmd(sim, { type: 'debugCouncil', kind: KIND.COMMERCIAL_JOBS });
      const second = openRequests(sim.world)[0]!;
      expect(second.slot).toBe(first.slot);
      expect(second.id).not.toBe(first.id);
      const approval = approvalOf(sim.world);
      expect(cmd(sim, { type: 'councilRespond', slot: first.slot, accept: false, request: first.id })).toBe('no-request');
      expect(openRequests(sim.world)).toHaveLength(1);
      expect(approvalOf(sim.world)).toBe(approval);
      expect(cmd(sim, { type: 'councilRespond', slot: first.slot, accept: true, request: second.id })).toBe('ok');
      expect(openRequests(sim.world)[0]!.state).toBe(REQ_STATE.ACCEPTED);
      expect(cmd(sim, { type: 'councilRespond', slot: 0, accept: true, request: 1.5 })).toBe('invalid');
    });

    it('keeps the debug command out of normal play', () => {
      const sim = homesCity();
      sim.debug = false;
      expect(cmd(sim, { type: 'debugCouncil', kind: KIND.PARK })).toBe('debug-only');
      expect(openRequests(sim.world)).toHaveLength(0);
      sim.debug = true;
      expect(cmd(sim, { type: 'debugCouncil', kind: 99 })).toBe('invalid');
    });

    it('detects each kind of goal from the world', () => {
      const sim = homesCity();
      const w = sim.world;
      const post = (kind: number): ReturnType<typeof openRequests>[number] => {
        w.council.fill(0, C.REQ0, C.REQ0 + C.REQ_STRIDE * MAX_REQUESTS);
        expect(cmd(sim, { type: 'debugCouncil', kind, accept: true })).toBe('ok');
        return openRequests(w)[0]!;
      };
      let r = post(KIND.PARK);
      expect(progressOf(w, r).done).toBe(false);
      expect(cmd(sim, { type: 'debugGrow', x: r.x + 3, y: r.y + 8, archetype: ARCH.PARK_SMALL, progress: 1 })).toBe('ok');
      expect(progressOf(w, r).done).toBe(true);

      w.scalars[S.grid] = 1;
      for (let s = 0, n = 0; s < w.bArch.length && n < 3; s++) if (w.bArch[s] === rciId(1, 1, 1)) { w.bFlags[s] = BFLAG.UNPOWERED; n++; }
      r = post(KIND.POWER);
      expect(progressOf(w, r).done).toBe(false);
      for (let s = 0; s < w.bArch.length; s++) w.bFlags[s] = w.bFlags[s]! & ~BFLAG.UNPOWERED;
      expect(progressOf(w, r).done).toBe(true);

      w.pollution.fill(150);
      r = post(KIND.POLLUTION);
      expect(progressOf(w, r).done).toBe(false);
      w.pollution.fill(5);
      expect(progressOf(w, r).done).toBe(true);

      r = post(KIND.BUILD_JOBS);
      expect(progressOf(w, r).done).toBe(false);
      w.council[C.BUILT] = w.council[C.BUILT]! + 2;
      expect(progressOf(w, r).done).toBe(false);
      w.council[C.BUILT] = w.council[C.BUILT]! + 1;
      expect(progressOf(w, r).done).toBe(true);

      w.traffic[104 * MAP + 110] = 230;
      r = post(KIND.TRAFFIC);
      expect([r.x, r.y]).toEqual([110, 104]);
      expect(progressOf(w, r).done).toBe(false);
      w.traffic.fill(10);
      expect(progressOf(w, r).done).toBe(true);
      w.road[104 * MAP + 110] = 0;
      expect(progressOf(w, r).done).toBe(false);
    });
  });
});

describe('festivals', () => {
  const NOON = 0.5 * 4800, MIDNIGHT = 0;
  function party(approval = 80): Sim {
    const sim = homesCity();
    set(sim, approval);
    sim.world.scalars[S.tickOfDay] = NOON;
    sim.world.scalars[S.tick] = 1000;
    return sim;
  }
  const hold = (sim: Sim, f: number): string => cmd(sim, { type: 'holdFestival', festival: f });

  it('needs approval strictly above 70', () => {
    const sim = party(FESTIVAL_MIN);
    expect(hold(sim, FESTIVAL.BLOCK_PARTY)).toBe('approval');
    set(sim, 70.5);
    expect(hold(sim, FESTIVAL.BLOCK_PARTY)).toBe('ok');
    const low = party(30);
    expect(festivalBlock(low.world, FESTIVAL.ROBOT_PARADE)).toBe('approval');
    expect(councilStats(low.world).festivals.every((f) => f.blocked === 'approval')).toBe(true);
  });

  it('charges the cost, lifts approval, starts a show and an end event', () => {
    const sim = party();
    const w = sim.world, t0 = w.scalars[S.treasury]!, a0 = approvalOf(w);
    expect(hold(sim, FESTIVAL.ROBOT_PARADE)).toBe('ok');
    expect(w.scalars[S.treasury]).toBe(t0 - FESTIVALS[1]!.cost);
    expect(approvalOf(w)).toBeCloseTo(a0 + FESTIVALS[1]!.approval, 6);
    expect(w.council[C.HELD]).toBe(1);
    const start = events(sim, 'festival');
    expect(start).toHaveLength(1);
    expect(start[0]).toMatchObject({ phase: 'start', festival: 1, ticks: FESTIVALS[1]!.showTicks });
    expect(councilStats(w).running?.festival).toBe(1);
    sim.events = [];
    w.scalars[S.tick] = w.council[C.FEST_END]!;
    step(sim);
    expect(events(sim, 'festival').map((e) => e.phase)).toEqual(['end']);
    expect(councilStats(w).running).toBeNull();
  });

  it('keeps each festival on its own cooldown, runs one at a time and asks for the money', () => {
    const sim = party(95);
    const w = sim.world;
    expect(hold(sim, FESTIVAL.BLOCK_PARTY)).toBe('ok');
    expect(hold(sim, FESTIVAL.ROBOT_PARADE)).toBe('busy');
    w.scalars[S.tick] = w.council[C.FEST_END]!;
    step(sim);
    expect(hold(sim, FESTIVAL.BLOCK_PARTY)).toBe('cooldown');
    const stat = councilStats(w).festivals[0]!;
    expect(stat.cooldown).toBeGreaterThan(0);
    expect(stat.blocked).toBe('cooldown');
    expect(hold(sim, FESTIVAL.ROBOT_PARADE)).toBe('ok');
    w.scalars[S.tick] = w.council[C.FEST_END]!;
    step(sim);
    expect(festivalBlock(w, FESTIVAL.BLOCK_PARTY)).toBe('cooldown');
    w.scalars[S.tick] = w.council[C.FEST_CD + FESTIVAL.BLOCK_PARTY]!;
    set(sim, 95);
    expect(festivalBlock(w, FESTIVAL.BLOCK_PARTY)).toBeUndefined();
    expect(festivalBlock(w, FESTIVAL.ROBOT_PARADE)).toBe('cooldown');
    w.scalars[S.treasury] = 10;
    expect(hold(sim, FESTIVAL.BLOCK_PARTY)).toBe('funds');
    expect(hold(sim, 7)).toBe('invalid');
    expect(hold(sim, -1)).toBe('invalid');
  });

  it('holds Fireworks Night only after dark', () => {
    const sim = party(90);
    expect(hold(sim, FESTIVAL.FIREWORKS)).toBe('night');
    sim.world.scalars[S.tickOfDay] = MIDNIGHT + 100;
    expect(hold(sim, FESTIVAL.FIREWORKS)).toBe('ok');
  });

  it('refuses in a city with no buildings to celebrate', () => {
    const sim = flatSim(2, true);
    set(sim, 90);
    sim.world.scalars[S.treasury] = 100000;
    expect(hold(sim, FESTIVAL.BLOCK_PARTY)).toBe('no-city');
  });

  it('adds commercial demand while the boost lasts, then stops', () => {
    const sim = party();
    const w = sim.world, t = countTotals(w);
    const before = demandTargets(w, t)[1];
    hold(sim, FESTIVAL.BLOCK_PARTY);
    const during = demandTargets(w, t);
    expect(during[1] - before).toBeGreaterThanOrEqual(FESTIVALS[0]!.demand - 1);
    w.scalars[S.tick] = w.council[C.FEST_BOOST_END]!;
    expect(demandTargets(w, t)[1]).toBeLessThan(during[1]);
  });
});

describe('advisor', () => {
  it('raises an issue for an accepted request near its deadline and for a request waiting for an answer', () => {
    const sim = homesCity();
    const w = sim.world;
    cmd(sim, { type: 'debugCouncil', kind: KIND.COMMERCIAL_JOBS });
    expect(deriveIssues(sim).filter((i) => i.kind === 'request')).toHaveLength(1);
    expect(deriveIssues(sim).find((i) => i.kind === 'request')!.severity).toBeLessThan(40);
    cmd(sim, { type: 'councilRespond', slot: 0, accept: true });
    expect(deriveIssues(sim).filter((i) => i.kind === 'request')).toHaveLength(0);
    const r = openRequests(w)[0]!;
    w.scalars[S.tick] = r.deadline - MONTH_TICKS / 4;
    const issue = deriveIssues(sim).find((i) => i.kind === 'request')!;
    expect(issue).toBeDefined();
    expect(issue.severity).toBeGreaterThan(60);
    expect(issue.text).toContain('Merchants');
    expect([issue.x, issue.y]).toEqual([r.x, r.y]);
  });

  it('warns about low and very low approval', () => {
    const sim = homesCity();
    expect(deriveIssues(sim).some((i) => i.kind === 'approval')).toBe(false);
    set(sim, 30);
    const low = deriveIssues(sim).find((i) => i.kind === 'approval')!;
    expect(low.text).toMatch(/Approval is 30%/);
    set(sim, 8);
    const vlow = deriveIssues(sim).find((i) => i.kind === 'approval')!;
    expect(vlow.severity).toBeGreaterThan(low.severity);
    expect(vlow.text).toMatch(/furious/);
  });
});

describe('determinism', () => {
  /** A city that goes through months, a request, a festival and an outcome. */
  function scripted(sim: Sim, upTo: number): void {
    const w = sim.world;
    const steps: [number, () => void][] = [
      [10, () => { cmd(sim, { type: 'debugCouncil', kind: KIND.COMMERCIAL_JOBS, accept: true }); }],
      [60, () => { cmd(sim, { type: 'debugGrow', x: 130, y: 108, archetype: rciId(2, 2, 3), progress: 1 }); }],
      [200, () => { set(sim, 85); }],
      [210, () => { cmd(sim, { type: 'holdFestival', festival: FESTIVAL.BLOCK_PARTY }); }],
      [300, () => { w.scalars[S.month]!++; }],
      [400, () => { w.scalars[S.month]!++; }],
      [500, () => { w.scalars[S.month]!++; }],
      [600, () => { w.scalars[S.month]!++; }],
    ];
    for (let t = 0; t < upTo; t++) {
      for (const [at, fn] of steps) if (at === t) fn();
      step(sim);
    }
  }

  it('two runs from the same seed give the same hash', () => {
    const a = homesCity(), b = homesCity();
    scripted(a, 700); scripted(b, 700);
    expect(a.world.council[C.COMPLETED]).toBe(1);
    expect(a.world.council[C.HELD]).toBe(1);
    expect(stateHash(a)).toBe(stateHash(b));
  }, 60000);

  it('resumes from a snapshot: run, save, restore, run on equals running straight through', () => {
    const straight = homesCity();
    scripted(straight, 700);

    const first = homesCity();
    scripted(first, 350);
    const resumed = restore(snapshot(first));
    resumed.debug = true;
    expect(stateHash(resumed)).toBe(stateHash(first));
    const w = resumed.world;
    for (let t = 350; t < 700; t++) {
      if (t === 400 || t === 500 || t === 600) w.scalars[S.month]!++;
      step(resumed);
    }
    expect(stateHash(resumed)).toBe(stateHash(straight));
    expect(Array.from(resumed.world.council)).toEqual(Array.from(straight.world.council));
  }, 60000);
});
