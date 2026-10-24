import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARCH, BFLAG, rciId } from '../catalog.ts';
import { execute } from '../commands.ts';
import { budgetHistory } from '../economy/index.ts';
import { step } from '../engine.ts';
import { MAP, S } from '../layers.ts';
import { PROTOCOL_VERSION } from '../protocol.ts';
import { roadsOf } from '../roads/index.ts';
import { runTicks } from '../testkit.ts';
import {
  AKIND, AST, DEPOT_START_STOCK, JOB, JOB_STUCK_TICKS, depotAccess, scanStats, startTrip,
} from './index.ts';
import {
  active, agents, constructing, depot, depots, finished, flatSim, grown, road, run, runUntil, town, zone,
} from './testkit.ts';

vi.setConfig({ testTimeout: 120000 });
afterEach(() => new Promise<void>((r) => { setTimeout(r, 0); }));

const holdDemand = (sim: ReturnType<typeof flatSim>, demandR: number, landValue: number): void => {
  sim.world.scalars[S.demandR] = demandR;
  sim.world.landValue.fill(landValue);
};

describe('hauler give-up and material accounting', () => {
  it('releases the reservation of carried material and returns the units, so the job still completes', () => {
    const sim = town();
    const w = sim.world;
    let gaveUp = 0;
    for (let t = 0; t < 4000 && finished(sim).length === 0; t++) {
      step(sim);
      if (t % 40 === 0) {
        const h = agents(sim, AKIND.HAULER).find((a) => w.aState[a] === AST.HAUL && w.aCarry[a]! > 0);
        if (h !== undefined) { w.aTry[h] = 6; gaveUp++; }
      }
      // Every unit in flight is exactly what the haulers on the way carry.
      for (let s = 0; s < w.jKind.length; s++) {
        if (w.jKind[s] === 0) continue;
        const ref = (s + 1) | (w.bGen[s]! << 16);
        let carried = 0;
        for (const a of agents(sim, AKIND.HAULER)) if (w.aTarget[a] === ref && (w.aState[a] === AST.HAUL || w.aState[a] === AST.TO_PICKUP)) carried += w.aCarry[a]!;
        expect(w.jInbound[s], `job ${s} at tick ${t}`).toBe(carried);
      }
    }
    expect(gaveUp).toBeGreaterThan(0);
    expect(finished(sim).length).toBeGreaterThan(0);
  });

  it('a hauler giving up puts its units back into the source stock', () => {
    const sim = town();
    const w = sim.world;
    expect(runUntil(sim, () => agents(sim, AKIND.HAULER).some((a) => w.aState[a] === AST.HAUL), 2000)).toBe(true);
    const h = agents(sim, AKIND.HAULER).find((a) => w.aState[a] === AST.HAUL)!;
    // Dispatch, production and imports run on ticks divisible by 5; give up on a tick where none of them touch stock.
    while ((w.scalars[S.tick]! + 1) % 5 === 0 && w.aState[h] === AST.HAUL) step(sim);
    expect(w.aState[h]).toBe(AST.HAUL);
    const src = (w.aSrc[h]! & 0xffff) - 1, c = w.aCarry[h]!;
    const before = w.bStock[src]!;
    w.aTry[h] = 6;
    step(sim);
    expect(c).toBeGreaterThan(0);
    expect(w.aCarry[h]).toBe(0);
    expect(w.bStock[src]).toBe(before + c);
  });
});

describe('robots that cannot get home', () => {
  it('a RETURN trip that gives up leaves the depot quota and becomes homeless, then leaves', () => {
    const sim = flatSim();
    road(sim, 96, 104, 110, 104);
    road(sim, 96, 120, 110, 120);
    depot(sim, 98, 102);
    runTicks(sim, 80);
    const w = sim.world, net = roadsOf(sim);
    const b = agents(sim, AKIND.BUILDER)[0]!;
    w.aX[b] = 100.5; w.aY[b] = 120.5;
    w.aState[b] = AST.RETURN;
    expect(startTrip(net, w, b, 120 * MAP + 100, depotAccess(net, w, depots(sim)[0]!))).toBe(false);
    w.aTry[b] = 6;
    step(sim);
    expect(w.aHome[b]).toBe(0);
    expect(w.aState[b]).toBe(AST.IDLE);
    // It no longer counts against the depot, so the depot builds a replacement builder.
    runTicks(sim, 100);
    expect(agents(sim, AKIND.BUILDER).filter((a) => a !== b && w.aHome[a] !== 0).length).toBeGreaterThanOrEqual(1);
    runTicks(sim, 700);
    expect(w.aKind[b] === 0 || w.aHome[b] !== 0).toBe(true);
  });
});

describe('jobs that lose their road', () => {
  it('cancels a new building cut off from every depot, restores its zone and frees the robots', () => {
    const sim = town();
    const w = sim.world;
    expect(runUntil(sim, () => constructing(sim).length > 0, 600)).toBe(true);
    // The street is cut between the depot door (98,104) and every lot.
    expect(run(sim, { type: 'bulldoze', x0: 99, y0: 104, x1: 99, y1: 104 })).toBe(true);
    const sites = constructing(sim);
    runTicks(sim, JOB_STUCK_TICKS + 100);
    for (const s of sites) expect(w.jKind[s] === JOB.BUILD && w.bArch[s] !== 0 && (w.bFlags[s]! & BFLAG.CONSTRUCTING) !== 0).toBe(false);
    expect(constructing(sim)).toHaveLength(0);
    const x = w.bX[sites[0]!]!;
    // The abandoned lots are zoned again (the slot may even be reused by nothing: no new jobs start while unreachable).
    expect(grown(sim).filter((s) => w.bX[s] === x)).toHaveLength(0);
    expect(w.zone[105 * MAP + 100]! & 3).toBe(1);
    expect(active(sim).filter((a) => w.aState[a] === AST.WORK)).toHaveLength(0);
  });

  it('keeps stalled jobs when there is no depot at all (they wait for one)', () => {
    const sim = town();
    expect(runUntil(sim, () => constructing(sim).length > 0, 600)).toBe(true);
    const d = depots(sim)[0]!;
    expect(run(sim, { type: 'bulldoze', x0: sim.world.bX[d]!, y0: sim.world.bY[d]!, x1: sim.world.bX[d]! + 1, y1: sim.world.bY[d]! + 1 })).toBe(true);
    runTicks(sim, JOB_STUCK_TICKS * 2);
    expect(constructing(sim).length).toBeGreaterThan(0);
  });
});

describe('orphan sites', () => {
  it('adopts a construction site that has no job and the robots finish it', () => {
    const sim = flatSim(42, true);
    road(sim, 96, 104, 130, 104);
    depot(sim, 98, 102);
    expect(run(sim, { type: 'debugGrow', x: 100, y: 105, archetype: rciId(1, 0, 1), progress: 0.5 })).toBe(true);
    const slot = sim.world.bId[105 * MAP + 100]! - 1;
    expect(sim.world.jKind[slot]).toBe(0);
    expect(runUntil(sim, () => sim.world.jKind[slot] === JOB.BUILD, 200)).toBe(true);
    expect(sim.world.jProg[slot]! >> 8).toBeGreaterThanOrEqual(120);
    expect(runUntil(sim, () => (sim.world.bFlags[slot]! & BFLAG.CONSTRUCTING) === 0, 4000)).toBe(true);
    expect(sim.world.bProg[slot]).toBe(255);
  });

  it('is on protocol version 7 (U7 raised it to 3, utilities to 4, traffic to 5, services to 6, milestones to 7, disasters to 8)', () => { expect(PROTOCOL_VERSION).toBe(8); });
});

describe('the robot budget', () => {
  it('accrues robot costs during the month and pays them with it: net explains the treasury, and the first month is prorated', () => {
    const sim = town();
    const w = sim.world;
    const start = w.scalars[S.treasury]!;
    while (w.scalars[S.month] === 0) {
      expect(w.scalars[S.treasury]).toBe(start);
      step(sim);
    }
    const first = budgetHistory(w)[0]!;
    expect(first.robotPurchases).toBe(BUILDERS_PER_DEPOT_COST());
    expect(first.robotUpkeep).toBeGreaterThan(0);
    expect(first.expenses).toBe(first.roads + first.services + first.interest + first.robotUpkeep + first.imports + first.robotPurchases);
    expect(w.scalars[S.treasury]! - start).toBe(first.net);
    expect(first.treasury).toBe(w.scalars[S.treasury]);
    // 35 street tiles at 2 a month, 3360 of the 4800 ticks of a day lived before the first midnight.
    expect(first.roads).toBe(Math.floor((70 * 3360) / 4800));
    expect(w.spend[0]! + w.spend[1]! + w.spend[2]!).toBe(0);
    const t1 = w.scalars[S.treasury]!;
    while (w.scalars[S.month] === 1) step(sim);
    const second = budgetHistory(w)[1]!;
    expect(second.roads).toBe(70);
    expect(w.scalars[S.treasury]! - t1).toBe(second.net);
  });

  it('never spends robot money it does not have', () => {
    const sim = town();
    sim.world.scalars[S.treasury] = 100;
    runTicks(sim, 400);
    expect(agents(sim)).toHaveLength(0);
    expect(sim.world.spend[2]).toBe(0);
  });
});

const BUILDERS_PER_DEPOT_COST = (): number => 4 * 60 + 4 * 40;

describe('lot zones survive demolition', () => {
  it('gives the lot back to its zone so robots can rebuild on it', () => {
    const sim = flatSim(42, true);
    const w = sim.world;
    road(sim, 96, 104, 130, 104);
    depot(sim, 98, 102);
    zone(sim, 100, 105, 100, 105, 1, 0);
    expect(run(sim, { type: 'debugGrow', x: 100, y: 105, archetype: rciId(1, 0, 1), progress: 1 })).toBe(true);
    const slot = w.bId[105 * MAP + 100]! - 1;
    expect(w.bZone[slot]).toBe(1);
    expect(w.zone[105 * MAP + 100]).toBe(0);
    w.bAband[slot] = 250;
    for (let t = 0; t < 3000 && w.bArch[slot] !== 0; t++) {
      holdDemand(sim, -0.9, 0);
      w.bFlags[slot] = w.bArch[slot] !== 0 ? w.bFlags[slot]! | BFLAG.ABANDONED : 0;
      step(sim);
    }
    expect(w.bArch[slot]).toBe(0);
    expect(w.zone[105 * MAP + 100]).toBe(1);
    // With demand back the lot is built again.
    for (let t = 0; t < 3000 && finished(sim).length === 0; t++) { holdDemand(sim, 0.9, 120); step(sim); }
    expect(finished(sim).length).toBe(1);
    expect(w.bX[finished(sim)[0]!]).toBe(100);
  });
});

describe('depot undo', () => {
  const place = (sim: ReturnType<typeof flatSim>): number => {
    sim.events = [];
    execute(sim, { type: 'placeBuilding', arch: ARCH.DEPOT, x: 98, y: 102, rot: 0, id: 900 + sim.world.scalars[S.tick]!, tick: 0 });
    const e = sim.events[sim.events.length - 1]!;
    if (e.type !== 'accepted' || !e.journal) throw new Error('depot not placed');
    return e.journal;
  };
  const undo = (sim: ReturnType<typeof flatSim>, journal: number): string => {
    sim.events = [];
    execute(sim, { type: 'undo', target: journal, id: 5000 + sim.world.scalars[S.tick]!, tick: 0 });
    const e = sim.events[sim.events.length - 1]!;
    return e.type === 'rejected' ? e.reason : 'ok';
  };

  it('refunds an untouched depot but not one whose robots or stock are in use', () => {
    const fresh = flatSim();
    road(fresh, 96, 104, 130, 104);
    const treasury = fresh.world.scalars[S.treasury]!;
    const j1 = place(fresh);
    expect(undo(fresh, j1)).toBe('ok');
    expect(fresh.world.scalars[S.treasury]).toBe(treasury);

    const used = flatSim();
    road(used, 96, 104, 130, 104);
    const j2 = place(used);
    runTicks(used, 60);
    expect(agents(used).length).toBeGreaterThan(0);
    expect(undo(used, j2)).toBe('consumed');
    expect(depots(used)).toHaveLength(1);

    const drained = flatSim();
    road(drained, 96, 104, 130, 104);
    const j3 = place(drained);
    runTicks(drained, 6);
    expect(drained.world.bStock[depots(drained)[0]!]).toBe(DEPOT_START_STOCK);
    drained.world.bStock[depots(drained)[0]!] = 10;
    expect(undo(drained, j3)).toBe('consumed');
  });
});

describe('depot work radius', () => {
  it('a new depot with no haulers beside a far site does not stop the old depot haulers from serving it', () => {
    const sim = flatSim();
    const w = sim.world;
    road(sim, 96, 104, 180, 104);
    depot(sim, 98, 102);
    runTicks(sim, 400);
    const haulers = agents(sim, AKIND.HAULER);
    expect(haulers.length).toBeGreaterThan(0);
    depot(sim, 160, 102);
    const fresh = depots(sim).find((s) => w.bX[s] === 160)!;
    w.scalars[S.treasury] = 100;
    expect(agents(sim, AKIND.HAULER).filter((a) => w.aHome[a] !== 0 && ((w.aHome[a]! & 0xffff) - 1) === fresh)).toEqual([]);
    zone(sim, 164, 105, 166, 107);
    let built = false;
    for (let t = 0; t < 5000 && !built; t++) {
      holdDemand(sim, 0.9, 120);
      w.scalars[S.treasury] = Math.max(w.scalars[S.treasury]!, 100);
      step(sim);
      built = finished(sim).length > 0;
    }
    expect(built).toBe(true);
  });
});

describe('candidate cache', () => {
  it('does not rescan the map while nothing changed', () => {
    const sim = flatSim();
    road(sim, 96, 104, 130, 104);
    depot(sim, 98, 102);
    zone(sim, 100, 105, 101, 105);
    for (let t = 0; t < 4000 && finished(sim).length < 2; t++) { holdDemand(sim, 0.9, 100); step(sim); }
    expect(finished(sim).length).toBe(2);
    holdDemand(sim, 0.9, 100);
    runTicks(sim, 60);
    const before = scanStats.scans;
    for (let t = 0; t < 2000; t++) { holdDemand(sim, 0.9, 100); step(sim); }
    expect(scanStats.scans - before).toBeLessThanOrEqual(1);
  });
});
