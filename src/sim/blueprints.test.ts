import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARCH, BFLAG, archetype } from './catalog.ts';
import { blueprintStats, queueOf } from './blueprints.ts';
import { restore, snapshot, stateHash, step } from './engine.ts';
import { BP_MAX, MAP, S } from './layers.ts';
import { JOB } from './robots/constants.ts';
import { depot, flatSim, road, run, tickOf, zone } from './robots/testkit.ts';
import type { Sim, SimEvent } from './world.ts';

vi.setConfig({ testTimeout: 120000 });
afterEach(() => new Promise<void>((r) => { setTimeout(r, 0); }));

const CLINIC = ARCH.CLINIC, SCHOOL = ARCH.SCHOOL, PARK = ARCH.PARK_SMALL;
const AT = { a: { x: 100, y: 105 }, b: { x: 106, y: 105 }, c: { x: 112, y: 105 } };

/** A street along y = 104 with a depot at its west end; the blueprint sites are the free rows south of it, touching the street. */
function city(): Sim {
  const sim = flatSim(42, true);
  road(sim, 96, 104, 130, 104);
  depot(sim, 98, 102);
  return sim;
}

const plan = (sim: Sim, arch: number, at: { x: number; y: number }, rot = 0): boolean => run(sim, { type: 'placeBlueprint', arch, x: at.x, y: at.y, rot });
const lastReason = (sim: Sim): string | undefined => {
  const e = sim.events[sim.events.length - 1];
  return e && e.type === 'rejected' ? e.reason : undefined;
};
const archOrder = (sim: Sim): number[] => queueOf(sim.world).map((s) => sim.world.bpArch[s]!);
const slotAt = (sim: Sim, at: { x: number; y: number }): number => queueOf(sim.world).find((s) => sim.world.bpX[s] === at.x && sim.world.bpY[s] === at.y)!;

/** Steps until `n` blueprintStarted/Skipped events have been seen; returns them in order. */
function runEvents(sim: Sim, n: number, max = 6000): SimEvent[] {
  const seen: SimEvent[] = [];
  for (let t = 0; t < max && seen.length < n; t++) {
    sim.events = [];
    step(sim);
    for (const e of sim.events) if (e.type === 'blueprintStarted' || e.type === 'blueprintSkipped') seen.push(e);
  }
  return seen;
}

describe('blueprint queue', () => {
  it('queues blueprints in placement order and costs nothing while they wait', () => {
    const sim = city();
    const w = sim.world, before = w.scalars[S.treasury]!;
    expect(plan(sim, CLINIC, AT.a)).toBe(true);
    expect(plan(sim, SCHOOL, AT.b)).toBe(true);
    expect(plan(sim, PARK, AT.c)).toBe(true);
    expect(archOrder(sim)).toEqual([CLINIC, SCHOOL, PARK]);
    expect(w.scalars[S.treasury]).toBe(before);
    expect(w.bId[AT.a.y * MAP + AT.a.x]).toBe(0);
    expect(blueprintStats(w).map((b) => [b.order, b.arch, b.cost])).toEqual([[0, CLINIC, 900], [1, SCHOOL, 1400], [2, PARK, 300]]);
  });

  it('moves a blueprint to the front, up and down; positions stay 0..n-1', () => {
    const sim = city();
    const w = sim.world;
    plan(sim, CLINIC, AT.a); plan(sim, SCHOOL, AT.b); plan(sim, PARK, AT.c);
    expect(run(sim, { type: 'moveBlueprint', slot: slotAt(sim, AT.c), to: 0 })).toBe(true);
    expect(archOrder(sim)).toEqual([PARK, CLINIC, SCHOOL]);
    expect(run(sim, { type: 'moveBlueprint', slot: slotAt(sim, AT.c), to: 1 })).toBe(true);
    expect(archOrder(sim)).toEqual([CLINIC, PARK, SCHOOL]);
    expect(run(sim, { type: 'moveBlueprint', slot: slotAt(sim, AT.a), to: 99 })).toBe(true);
    expect(archOrder(sim)).toEqual([PARK, SCHOOL, CLINIC]);
    expect(queueOf(w).map((s) => w.bpSeq[s])).toEqual([0, 1, 2]);
    expect(run(sim, { type: 'moveBlueprint', slot: 40, to: 0 })).toBe(false);
    expect(lastReason(sim)).toBe('no-blueprint');
  });

  it('refuses a depot, a megaproject, an overlap, a bad site and a full queue', () => {
    const sim = city();
    sim.world.scalars[S.tier] = 5;
    expect(plan(sim, ARCH.DEPOT, AT.a)).toBe(false);
    expect(lastReason(sim)).toBe('no-blueprint');
    expect(plan(sim, ARCH.FUSION_SPIRE, AT.a)).toBe(false);
    expect(lastReason(sim)).toBe('no-blueprint');
    expect(plan(sim, CLINIC, { x: 100, y: 104 })).toBe(false);
    expect(lastReason(sim)).toBe('blocked');
    expect(plan(sim, CLINIC, AT.a)).toBe(true);
    expect(plan(sim, PARK, { x: 101, y: 106 })).toBe(false);
    expect(lastReason(sim)).toBe('planned');
    for (let i = 1; i < BP_MAX; i++) expect(plan(sim, ARCH.LIGHTNING_ROD, { x: 100 + (i % 30), y: 120 + ((i / 30) | 0) * 2 })).toBe(true);
    expect(plan(sim, ARCH.LIGHTNING_ROD, { x: 100, y: 140 })).toBe(false);
    expect(lastReason(sim)).toBe('queue-full');
  });

  it('cancels a blueprint without touching the treasury', () => {
    const sim = city();
    const w = sim.world, before = w.scalars[S.treasury]!;
    plan(sim, CLINIC, AT.a); plan(sim, SCHOOL, AT.b);
    expect(run(sim, { type: 'cancelBlueprint', slot: slotAt(sim, AT.a) })).toBe(true);
    expect(archOrder(sim)).toEqual([SCHOOL]);
    expect(queueOf(w).map((s) => w.bpSeq[s])).toEqual([0]);
    expect(w.scalars[S.treasury]).toBe(before);
    expect(run(sim, { type: 'cancelBlueprint', slot: 5 })).toBe(false);
    expect(lastReason(sim)).toBe('no-blueprint');
  });

  it('starts blueprints in queue order and charges the price only when the foundation goes down', () => {
    const sim = city();
    const w = sim.world;
    plan(sim, CLINIC, AT.a); plan(sim, SCHOOL, AT.b);
    let started: SimEvent | undefined;
    for (let t = 0; t < 6000 && !started; t++) {
      const treasury = w.scalars[S.treasury]!;
      sim.events = [];
      step(sim);
      started = sim.events.find((e) => e.type === 'blueprintStarted');
      if (!started) expect(w.scalars[S.treasury], `tick ${tickOf(sim)}`).toBe(treasury);
      else expect(w.scalars[S.treasury]).toBe(treasury - archetype(CLINIC)!.cost);
    }
    expect(started).toMatchObject({ type: 'blueprintStarted', arch: CLINIC, x: AT.a.x, y: AT.a.y, cost: 900 });
    const slot = w.bId[AT.a.y * MAP + AT.a.x]! - 1;
    expect(w.bArch[slot]).toBe(CLINIC);
    expect(w.bFlags[slot]! & BFLAG.CONSTRUCTING).toBe(BFLAG.CONSTRUCTING);
    expect(w.jKind[slot]).toBe(JOB.BUILD);
    expect(archOrder(sim)).toEqual([SCHOOL]);
  });

  it('a pinned blueprint is started before the ones ahead of it, and the building is finished by the robots', () => {
    const sim = city();
    const w = sim.world;
    plan(sim, CLINIC, AT.a); plan(sim, SCHOOL, AT.b);
    expect(run(sim, { type: 'moveBlueprint', slot: slotAt(sim, AT.b), to: 0 })).toBe(true);
    const events = runEvents(sim, 2);
    expect(events.map((e) => (e as { arch: number }).arch)).toEqual([SCHOOL, CLINIC]);
    const school = w.bId[AT.b.y * MAP + AT.b.x]! - 1, clinic = w.bId[AT.a.y * MAP + AT.a.x]! - 1;
    expect(school).toBeLessThan(clinic);
    for (let t = 0; t < 9000 && (w.bFlags[school]! & BFLAG.CONSTRUCTING) !== 0; t++) step(sim);
    expect(w.bFlags[school]! & BFLAG.CONSTRUCTING).toBe(0);
    expect(w.bLevel[school]).toBe(0);
    expect(queueOf(w)).toEqual([]);
  });

  it('skips a blueprint whose site was taken, with an event and no charge, then starts the next', () => {
    const sim = city();
    const w = sim.world;
    plan(sim, CLINIC, AT.a); plan(sim, SCHOOL, AT.b);
    expect(run(sim, { type: 'debugGrow', x: AT.a.x, y: AT.a.y, archetype: ARCH.PARK_SMALL, progress: 1 })).toBe(true);
    const treasury = w.scalars[S.treasury]!;
    const events = runEvents(sim, 2);
    expect(events[0]).toMatchObject({ type: 'blueprintSkipped', arch: CLINIC, reason: 'blocked' });
    expect(events[1]).toMatchObject({ type: 'blueprintStarted', arch: SCHOOL });
    expect(w.scalars[S.treasury]).toBe(treasury - archetype(SCHOOL)!.cost);
    expect(queueOf(w)).toEqual([]);
  });

  it('holds the whole queue while the head cannot be paid for', () => {
    const sim = city();
    const w = sim.world;
    plan(sim, SCHOOL, AT.b); plan(sim, PARK, AT.c);
    w.scalars[S.treasury] = 1000;
    const none = runEvents(sim, 1, 1500);
    expect(none).toEqual([]);
    expect(archOrder(sim)).toEqual([SCHOOL, PARK]);
    w.scalars[S.treasury] = 50000;
    const events = runEvents(sim, 2);
    expect(events.map((e) => (e as { arch: number }).arch)).toEqual([SCHOOL, PARK]);
  });

  it('keeps a blueprint queued while no road reaches it, and starts the next one', () => {
    const sim = city();
    plan(sim, CLINIC, { x: 100, y: 140 }); plan(sim, SCHOOL, AT.b);
    const events = runEvents(sim, 1);
    expect(events[0]).toMatchObject({ type: 'blueprintStarted', arch: SCHOOL });
    expect(archOrder(sim)).toEqual([CLINIC]);
  });

  it('resumes from a snapshot with blueprints queued, in the same order, and plays on identically', () => {
    const sim = city();
    plan(sim, CLINIC, AT.a); plan(sim, SCHOOL, AT.b); plan(sim, PARK, AT.c);
    run(sim, { type: 'moveBlueprint', slot: slotAt(sim, AT.c), to: 0 });
    for (let t = 0; t < 20; t++) step(sim);
    const back = restore(snapshot(sim));
    expect(stateHash(back)).toBe(stateHash(sim));
    expect(archOrder(back)).toEqual(archOrder(sim));
    for (let t = 0; t < 1500; t++) { step(sim); step(back); }
    expect(stateHash(back)).toBe(stateHash(sim));
    expect(archOrder(back)).toEqual(archOrder(sim));
  });

  it('builds on zoned land before the city grows there, and tearing it down gives the zone back', () => {
    const sim = city();
    const w = sim.world;
    zone(sim, 100, 105, 120, 106);
    plan(sim, CLINIC, AT.a);
    const events = runEvents(sim, 1);
    expect(events[0]).toMatchObject({ type: 'blueprintStarted', arch: CLINIC });
    const slot = w.bId[AT.a.y * MAP + AT.a.x]! - 1;
    expect(w.bArch[slot]).toBe(CLINIC);
    expect(w.zone[AT.a.y * MAP + AT.a.x]).toBe(0);
    expect(w.bZone[slot]).not.toBe(0);
  });
});
