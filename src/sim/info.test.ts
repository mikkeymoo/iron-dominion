import { describe, expect, it } from 'vitest';
import { ARCH, BFLAG } from './catalog.ts';
import { answerInfo, etaText } from './info.ts';
import { MAP, RMAX, S } from './layers.ts';
import type { AgentInfo, BuildingInfo, InfoMsg } from './protocol.ts';
import { AKIND, AST } from './robots/constants.ts';
import { flatSim, road, run, runUntil, depot, zone } from './robots/testkit.ts';
import { runTicks } from './testkit.ts';
import type { Sim } from './world.ts';

const grow = (sim: Sim, x: number, y: number, archetype = 16): void => {
  expect(run(sim, { type: 'debugGrow', x, y, archetype, progress: 1 })).toBe(true);
};
const slotAt = (sim: Sim, x: number, y: number): number => sim.world.bId[y * MAP + x]! - 1;
const keyOf = (sim: Sim, a: number): number => (a | (sim.world.aGen[a]! << 16)) >>> 0;
const building = (sim: Sim, slot: number): BuildingInfo => {
  const m = answerInfo(sim, { type: 'requestInfo', id: 1, kind: 'building', ref: slot });
  expect(m.ok, JSON.stringify(m)).toBe(true);
  return m.info as BuildingInfo;
};
const agent = (sim: Sim, a: number): AgentInfo => {
  const m = answerInfo(sim, { type: 'requestInfo', id: 1, kind: 'agent', ref: keyOf(sim, a) });
  expect(m.ok, JSON.stringify(m)).toBe(true);
  return m.info as AgentInfo;
};
const texts = (i: BuildingInfo): string[] => i.thoughts.map((t) => t.text);

function busyTown(): Sim {
  const sim = flatSim(42, true);
  road(sim, 96, 104, 130, 104);
  depot(sim, 98, 102);
  zone(sim, 100, 105, 120, 108);
  return sim;
}

const firstAgent = (sim: Sim, kind: number, state: number): number => {
  for (let a = 0; a < RMAX; a++) if (sim.world.aKind[a] === kind && sim.world.aState[a] === state) return a;
  return -1;
};

describe('requestInfo answers for robots', () => {
  it('words a loaded hauler as hauling N material to a named site with an ETA', () => {
    const sim = busyTown();
    expect(runUntil(sim, () => firstAgent(sim, AKIND.HAULER, AST.HAUL) >= 0, 1500)).toBe(true);
    const a = firstAgent(sim, AKIND.HAULER, AST.HAUL);
    const info = agent(sim, a);
    expect(info.name).toMatch(/^Hauler drone #\d+$/);
    expect(info.akind).toBe(AKIND.HAULER);
    expect(info.job).toMatch(/^Hauling [1-4] material to the (house|apartment block) at \(\d+, \d+\), ETA ~\d+ s\.$/);
    expect(info.waiting).toBeUndefined();
    expect(info.etaSec).toBeGreaterThanOrEqual(0);
    expect(info.target).toBeDefined();
    expect(info.job).toContain(`Hauling ${sim.world.aCarry[a]} material`);
  });

  it('says "Waiting: road blocked" for a robot whose route is cut, and "no road" when it is off the network', () => {
    const sim = busyTown();
    expect(runUntil(sim, () => firstAgent(sim, AKIND.HAULER, AST.HAUL) >= 0, 1500)).toBe(true);
    const a = firstAgent(sim, AKIND.HAULER, AST.HAUL);
    const w = sim.world;
    w.aTry[a] = 3;
    const blocked = agent(sim, a);
    expect(blocked.job).toBe('Waiting: road blocked');
    expect(blocked.waiting).toBe('road blocked');
    expect(blocked.detail).toMatch(/^Hauling/);
    expect(blocked.etaSec).toBeUndefined();
    w.aX[a] = 40.5; w.aY[a] = 40.5;
    expect(agent(sim, a).job).toBe('Waiting: no road');
  });

  it('describes a builder walking to and working on a site', () => {
    const sim = busyTown();
    expect(runUntil(sim, () => firstAgent(sim, AKIND.BUILDER, AST.TO_SITE) >= 0, 1500)).toBe(true);
    expect(agent(sim, firstAgent(sim, AKIND.BUILDER, AST.TO_SITE)).job).toMatch(/^Walking to build the (house|apartment block) at \(\d+, \d+\), ETA ~\d+ s\.$/);
    expect(runUntil(sim, () => firstAgent(sim, AKIND.BUILDER, AST.WORK) >= 0, 1500)).toBe(true);
    expect(agent(sim, firstAgent(sim, AKIND.BUILDER, AST.WORK)).job).toMatch(/^(Building|Waiting for material at) the (house|apartment block) at/);
  });

  it('describes a resting robot and answers "gone" for a stale key or building', () => {
    const sim = flatSim(42, true);
    road(sim, 96, 104, 130, 104);
    depot(sim, 98, 102);
    runTicks(sim, 100);
    const idle = firstAgent(sim, AKIND.BUILDER, AST.IDLE);
    expect(idle).toBeGreaterThanOrEqual(0);
    expect(agent(sim, idle).job).toMatch(/^Resting in the robot depot at/);
    const stale = (keyOf(sim, idle) + 0x10000) >>> 0;
    const m: InfoMsg = answerInfo(sim, { type: 'requestInfo', id: 9, kind: 'agent', ref: stale });
    expect(m).toEqual({ type: 'info', id: 9, ok: false, reason: 'gone' });
    expect(answerInfo(sim, { type: 'requestInfo', id: 3, kind: 'building', ref: 4000 }).ok).toBe(false);
    expect(answerInfo(sim, { type: 'requestInfo', id: 3, kind: 'building', ref: -1 }).ok).toBe(false);
  });

  it('does not change the world hash', async () => {
    const sim = busyTown();
    runTicks(sim, 200);
    const { stateHash } = await import('./engine.ts');
    const before = stateHash(sim);
    for (let a = 0; a < RMAX; a++) if (sim.world.aKind[a] !== 0) agent(sim, a);
    for (let s = 0; s < 40; s++) if (sim.world.bArch[s] !== 0) building(sim, s);
    expect(stateHash(sim)).toBe(before);
  });
});

describe('requestInfo answers for buildings', () => {
  it('names the cause of a missing power connection', () => {
    const sim = flatSim(42, true);
    expect(run(sim, { type: 'placeBuilding', arch: ARCH.POWER_PLANT, x: 100, y: 100, rot: 0 })).toBe(true);
    grow(sim, 110, 100);
    runTicks(sim, 10);
    const info = building(sim, slotAt(sim, 110, 100));
    expect(info.name).toBe('House');
    expect(info.status).toBe('idle');
    expect(texts(info)[0]).toBe('No power: connect a power line to the grid.');
    expect(info.thoughts[0]!.overlay).toBe('power');
    expect(info.thoughts[0]!.tone).toBe('bad');
    expect(info.residents).toBe(0);
  });

  it('says what stops a house from levelling up: a missing school', () => {
    const sim = flatSim(42, true);
    grow(sim, 110, 100);
    const w = sim.world, s = slotAt(sim, 110, 100);
    w.scalars[S.demandR] = 0.8;
    w.landValue.fill(100);
    w.covHealth.fill(255);
    const info = building(sim, s);
    expect(info.residents).toBe(6);
    expect(info.level).toBe(1);
    expect(texts(info)).toContain("No school nearby - can't level up.");
    expect(info.thoughts.find((t) => t.text.startsWith('No school'))!.overlay).toBe('education');
    w.covEdu.fill(255);
    expect(texts(building(sim, s))).toContain('Ready to grow: it can level up.');
  });

  it('blames the steel works for smog near a home', () => {
    const sim = flatSim(42, true);
    grow(sim, 104, 100);
    grow(sim, 112, 100, 42);
    const w = sim.world;
    for (let y = 98; y < 104; y++) for (let x = 102; x < 108; x++) w.pollution[y * MAP + x] = 110;
    const info = building(sim, slotAt(sim, 104, 100));
    expect(texts(info)).toContain('Smog from the steel works.');
    expect(info.thoughts.find((t) => t.text.startsWith('Smog'))!.overlay).toBe('pollution');
  });

  it('reports a site that is far from every depot as slow, and a missing depot as the cause', () => {
    const sim = flatSim(42, true);
    road(sim, 20, 20, 120, 20);
    depot(sim, 20, 18);
    expect(run(sim, { type: 'debugGrow', x: 110, y: 21, archetype: 16, progress: 0.4 })).toBe(true);
    runTicks(sim, 40);
    const s = slotAt(sim, 110, 21);
    const info = building(sim, s);
    expect(info.status).toBe('constructing');
    expect(info.progress).toBe(40);
    const all = texts(info).join(' | ');
    expect(all, all).toMatch(/Slow: no nearby depot/);
    const none = flatSim(42, true);
    expect(run(none, { type: 'debugGrow', x: 110, y: 21, archetype: 16, progress: 0.4 })).toBe(true);
    expect(texts(building(none, slotAt(none, 110, 21))).join(' | ')).toMatch(/Waiting for a work order|No depot yet/);
  });

  it('describes a depot with its work radius, and a service with the share of the city it covers', () => {
    const sim = flatSim(42, true);
    road(sim, 96, 104, 130, 104);
    depot(sim, 98, 102);
    const d = building(sim, slotAt(sim, 98, 102));
    expect(d.depot).toMatchObject({ radius: 40 });
    expect(texts(d).join(' ')).toMatch(/work within 40 road tiles/);
    sim.world.bFlags[slotAt(sim, 98, 102)] = BFLAG.CONSTRUCTING;
    expect(building(sim, slotAt(sim, 98, 102)).status).toBe('constructing');
  });

  it('formats an ETA in whole seconds under ten and fives above', () => {
    expect(etaText(0.2)).toBe('ETA ~1 s');
    expect(etaText(7.4)).toBe('ETA ~7 s');
    expect(etaText(21.9)).toBe('ETA ~20 s');
    expect(etaText(23)).toBe('ETA ~25 s');
  });
});
