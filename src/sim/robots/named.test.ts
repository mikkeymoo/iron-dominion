import { describe, expect, it } from 'vitest';
import { execute, type Command, type CommandBody } from '../commands.ts';
import { packAgents, restore, snapshot, stateHash, step } from '../engine.ts';
import { answerInfo } from '../info.ts';
import { ARCH } from '../catalog.ts';
import { AMAX, S } from '../layers.ts';
import { AKIND, AST } from './constants.ts';
import { LIVERIES, LIVERY_COUNT } from './livery.ts';
import { HALL_CAP, HAT_VARIANTS, NAMED_JOBS, botName, creditJob, hallOfBots, hatOfMeta, hatVariant, liveryOfMeta } from './names.ts';
import { spawnAgent, refOf } from './pool.ts';
import { agents, depots, runUntil, town, tickOf } from './testkit.ts';
import type { Sim } from '../world.ts';

let id = 1000;
const cmd = (sim: Sim, body: CommandBody): boolean => execute(sim, { ...body, id: id++, tick: 0 } as Command);

/** The packed second Agents word of agent slot `a`, or undefined when the agent is not in the message. */
function metaOf(sim: Sim, a: number): number | undefined {
  const pos = new Float32Array(AMAX * 3), ids = new Uint32Array(AMAX * 2);
  const n = packAgents(sim, pos, ids);
  for (let i = 0; i < n; i++) if ((ids[i * 2]! & 0xffff) === a) return ids[i * 2 + 1]!;
  return undefined;
}

describe('bot names', () => {
  it('are deterministic from slot and generation and look like "Rivet-7" or "Sprocket"', () => {
    for (let slot = 0; slot < 50; slot++) {
      expect(botName(slot, 3)).toBe(botName(slot, 3));
      expect(botName(slot, 3)).toMatch(/^[A-Z][a-z]+(-[1-9])?$/);
    }
    const names = new Set<string>();
    for (let slot = 0; slot < 200; slot++) names.add(botName(slot, 0));
    expect(names.size).toBeGreaterThan(60);
    expect(botName(7, 0)).not.toBe(botName(7, 1));
  });

  it('pick one of the hat variants and keep it', () => {
    const seen = new Set<number>();
    for (let slot = 0; slot < 100; slot++) {
      const v = hatVariant(slot, 2);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(HAT_VARIANTS);
      expect(hatVariant(slot, 2)).toBe(v);
      seen.add(v);
    }
    expect(seen.size).toBe(HAT_VARIANTS);
  });
});

describe('named bots in the sim', () => {
  it('counts jobs per agent, names the bot at 100 and puts the hat in the Agents message from then on', () => {
    const sim = town();
    const depot = depots(sim)[0]!;
    const a = spawnAgent(sim.world, AKIND.BUILDER, refOf(sim.world, depot), 99, 103);
    expect(a).toBeGreaterThanOrEqual(0);
    sim.world.aState[a] = AST.TO_SITE;
    for (let i = 0; i < NAMED_JOBS - 1; i++) creditJob(sim, a);
    expect(sim.world.aJobs[a]).toBe(NAMED_JOBS - 1);
    expect(sim.events.some((e) => e.type === 'botNamed')).toBe(false);
    expect(hatOfMeta(metaOf(sim, a)!)).toBe(0);

    creditJob(sim, a);
    const named = sim.events.filter((e) => e.type === 'botNamed');
    expect(named).toHaveLength(1);
    const gen = sim.world.aGen[a]!;
    expect(named[0]).toMatchObject({ type: 'botNamed', slot: a, gen, kind: AKIND.BUILDER, name: botName(a, gen) });
    expect(hatOfMeta(metaOf(sim, a)!)).toBe(hatVariant(a, gen));

    creditJob(sim, a);
    expect(sim.events.filter((e) => e.type === 'botNamed')).toHaveLength(1);
  });

  it('does not name firefighters or vehicles', () => {
    const sim = town();
    const depot = depots(sim)[0]!;
    const f = spawnAgent(sim.world, AKIND.FIREFIGHTER, refOf(sim.world, depot), 99, 103);
    for (let i = 0; i < NAMED_JOBS + 5; i++) creditJob(sim, f);
    expect(sim.world.aJobs[f]).toBe(0);
    expect(hallOfBots(sim.world)).toEqual([]);
  });

  it('earns jobs from real work: builders on finished buildings and haulers on deliveries', () => {
    const sim = town();
    expect(runUntil(sim, () => agents(sim).some((a) => sim.world.aJobs[a]! > 0), 4000)).toBe(true);
    runUntil(sim, () => agents(sim, AKIND.BUILDER).some((a) => sim.world.aJobs[a]! > 0) && agents(sim, AKIND.HAULER).some((a) => sim.world.aJobs[a]! > 0), 6000);
    expect(agents(sim, AKIND.HAULER).some((a) => sim.world.aJobs[a]! > 0)).toBe(true);
    expect(agents(sim, AKIND.BUILDER).some((a) => sim.world.aJobs[a]! > 0)).toBe(true);
  }, 60000);

  it('emits buildingDone for a finished build', () => {
    const sim = town();
    const seen: string[] = [];
    for (let t = 0; t < 6000 && seen.length === 0; t++) {
      step(sim);
      for (const e of sim.events) if (e.type === 'buildingDone') seen.push(`${e.arch}`);
      sim.events = [];
    }
    expect(seen.length).toBeGreaterThan(0);
  }, 60000);

  it('a freed agent slot starts again at zero jobs', () => {
    const sim = town();
    const depot = depots(sim)[0]!;
    const a = spawnAgent(sim.world, AKIND.HAULER, refOf(sim.world, depot), 99, 103);
    for (let i = 0; i < 7; i++) creditJob(sim, a);
    sim.world.aKind[a] = 0;
    const b = spawnAgent(sim.world, AKIND.HAULER, refOf(sim.world, depot), 99, 103);
    expect(b).toBe(a);
    expect(sim.world.aJobs[b]).toBe(0);
  });

  it('lists named bots busiest first, capped, with the agent key', () => {
    const sim = town();
    const depot = depots(sim)[0]!;
    const ids: number[] = [];
    for (let i = 0; i < HALL_CAP + 5; i++) ids.push(spawnAgent(sim.world, i % 2 ? AKIND.HAULER : AKIND.BUILDER, refOf(sim.world, depot), 99, 103));
    ids.forEach((a, i) => { for (let j = 0; j < NAMED_JOBS + i; j++) creditJob(sim, a); });
    const hall = hallOfBots(sim.world);
    expect(hall).toHaveLength(HALL_CAP);
    expect(hall[0]!.jobs).toBe(NAMED_JOBS + ids.length - 1);
    for (let i = 1; i < hall.length; i++) expect(hall[i - 1]!.jobs).toBeGreaterThanOrEqual(hall[i]!.jobs);
    const top = ids[ids.length - 1]!;
    expect(hall[0]!.key).toBe((top | (sim.world.aGen[top]! << 16)) >>> 0);
    expect(hall[0]!.name).toBe(botName(top, sim.world.aGen[top]!));
  });

  it('shows the name, the role and the job count on the info card', () => {
    const sim = town();
    const depot = depots(sim)[0]!;
    const a = spawnAgent(sim.world, AKIND.BUILDER, refOf(sim.world, depot), 99, 103);
    const key = (a | (sim.world.aGen[a]! << 16)) >>> 0;
    const ask = () => answerInfo(sim, { type: 'requestInfo', id: 1, kind: 'agent', ref: key });
    const before = ask().info;
    expect(before).toMatchObject({ kind: 'agent', named: false, jobs: 0 });
    for (let i = 0; i < NAMED_JOBS + 34; i++) creditJob(sim, a);
    const after = ask().info;
    expect(after).toMatchObject({ kind: 'agent', name: botName(a, sim.world.aGen[a]!), named: true, jobs: NAMED_JOBS + 34 });
  });

  it('keeps job counts through a snapshot and plays on to the same hash as an uninterrupted run', () => {
    const run = (): Sim => { const s = town(); runUntil(s, () => false, 1500); return s; };
    const straight = run();
    const first = run();
    expect(agents(first).some((a) => first.world.aJobs[a]! > 0)).toBe(true);
    const counts = agents(first).map((a) => first.world.aJobs[a]);
    const resumed = restore(snapshot(first));
    expect(agents(resumed).map((a) => resumed.world.aJobs[a])).toEqual(counts);
    expect(stateHash(resumed)).toBe(stateHash(first));
    for (let i = 0; i < 400; i++) { step(resumed); step(straight); }
    expect(tickOf(resumed)).toBe(tickOf(straight));
    expect(agents(resumed).map((a) => resumed.world.aJobs[a])).toEqual(agents(straight).map((a) => straight.world.aJobs[a]));
  }, 120000);
});

describe('depot paint', () => {
  it('has six schemes', () => {
    expect(LIVERY_COUNT).toBe(6);
    expect(new Set(LIVERIES.map((l) => l.hex)).size).toBe(6);
  });

  it('setDepotLivery paints a depot, rejects bad input and is free', () => {
    const sim = town();
    const depot = depots(sim)[0]!;
    const treasury = sim.world.scalars[S.treasury]!;
    expect(cmd(sim, { type: 'setDepotLivery', slot: depot, livery: 3 })).toBe(true);
    expect(sim.world.bLivery[depot]).toBe(3);
    expect(sim.world.scalars[S.treasury]).toBe(treasury);
    expect(cmd(sim, { type: 'setDepotLivery', slot: depot, livery: 3 })).toBe(false);
    expect(cmd(sim, { type: 'setDepotLivery', slot: depot, livery: LIVERY_COUNT })).toBe(false);
    expect(cmd(sim, { type: 'setDepotLivery', slot: depot, livery: -1 })).toBe(false);
    expect(cmd(sim, { type: 'setDepotLivery', slot: 8191, livery: 1 })).toBe(false);
    expect(cmd(sim, { type: 'setDepotLivery', slot: 1.5, livery: 1 })).toBe(false);
    const road = sim.world.bArch.findIndex((v, s) => v !== 0 && s !== depot);
    if (road >= 0) expect(cmd(sim, { type: 'setDepotLivery', slot: road, livery: 1 })).toBe(false);
    expect(sim.world.bLivery[depot]).toBe(3);
  });

  it('is worn by the depot robots in the Agents message and follows a repaint', () => {
    const sim = town();
    const depot = depots(sim)[0]!;
    expect(runUntil(sim, () => agents(sim).length >= 2, 3000)).toBe(true);
    const bots = agents(sim);
    for (const a of bots) expect(liveryOfMeta(metaOf(sim, a)!)).toBe(0);
    cmd(sim, { type: 'setDepotLivery', slot: depot, livery: 4 });
    for (const a of bots) expect(liveryOfMeta(metaOf(sim, a)!)).toBe(4);
    cmd(sim, { type: 'setDepotLivery', slot: depot, livery: 2 });
    for (const a of bots) expect(liveryOfMeta(metaOf(sim, a)!)).toBe(2);
  }, 60000);

  it('is per depot: a second depot keeps its own scheme', () => {
    const sim = town();
    const first = depots(sim)[0]!;
    expect(first).toBeGreaterThanOrEqual(0);
    cmd(sim, { type: 'placeBuilding', arch: ARCH.DEPOT, x: 126, y: 102, rot: 0 });
    const both = depots(sim);
    expect(both).toHaveLength(2);
    cmd(sim, { type: 'setDepotLivery', slot: both[1]!, livery: 5 });
    expect(sim.world.bLivery[both[0]!]).toBe(0);
    expect(sim.world.bLivery[both[1]!]).toBe(5);
    const a = spawnAgent(sim.world, AKIND.HAULER, refOf(sim.world, both[1]!), 127, 103);
    expect(liveryOfMeta(metaOf(sim, a)!)).toBe(5);
    const b = spawnAgent(sim.world, AKIND.HAULER, refOf(sim.world, both[0]!), 99, 103);
    expect(liveryOfMeta(metaOf(sim, b)!)).toBe(0);
  });

  it('survives a snapshot, and resets when the depot is bulldozed so a reused slot starts plain', () => {
    const sim = town();
    const depot = depots(sim)[0]!;
    cmd(sim, { type: 'setDepotLivery', slot: depot, livery: 1 });
    const back = restore(snapshot(sim));
    expect(back.world.bLivery[depot]).toBe(1);
    expect(stateHash(back)).toBe(stateHash(sim));
    expect(cmd(sim, { type: 'bulldoze', x0: 98, y0: 102, x1: 99, y1: 103 })).toBe(true);
    expect(sim.world.bArch[depot]).toBe(0);
    expect(sim.world.bLivery[depot]).toBe(0);
  });
});
