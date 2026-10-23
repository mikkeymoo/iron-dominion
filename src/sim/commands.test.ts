import { describe, expect, it } from 'vitest';
import { ARCH } from './catalog.ts';
import type { Command, CommandBody } from './commands.ts';
import { apply, createSim, restore, snapshot, step } from './engine.ts';
import { hashWorld } from './hash.ts';
import { MAP, ROAD, S, TERRAIN } from './layers.ts';
import { findLandWindow } from './testkit.ts';
import type { Sim } from './world.ts';

let nextId = 1;
function run(sim: Sim, body: CommandBody): { id: number; journal?: number; accepted: boolean; reason?: string } {
  const id = nextId++;
  sim.events = [];
  apply(sim, { ...body, id, tick: 0 } as Command);
  step(sim);
  const ev = sim.events.find((e) => (e.type === 'accepted' || e.type === 'rejected') && e.cmd === id);
  if (!ev) throw new Error('no command event');
  return { id, journal: ev.type === 'accepted' ? ev.journal : undefined, accepted: ev.type === 'accepted', reason: ev.type === 'rejected' ? ev.reason : undefined };
}

function findBridgeSpan(sim: Sim): { y: number; x0: number; x1: number } {
  const t = sim.world.terrain, wet = (v: number) => v === TERRAIN.WATER || v === TERRAIN.RIVER;
  for (let y = 4; y < MAP - 4; y++) {
    for (let x = 4; x < MAP - 12; x++) {
      if (wet(t[y * MAP + x]!)) continue;
      let k = x + 1;
      while (k < MAP - 1 && wet(t[y * MAP + k]!)) k++;
      if (k > x + 1 && k - x < 12 && !wet(t[y * MAP + k]!)) return { y, x0: x, x1: k };
    }
  }
  throw new Error('no water crossing');
}

describe('command validation', () => {
  it('rejects out-of-bounds, water zoning and insufficient funds without changing state', () => {
    const sim = createSim(42);
    const { x, y } = findLandWindow(sim.world, 8);
    const wet = sim.world.terrain.indexOf(TERRAIN.WATER);
    const wx = wet % MAP, wy = (wet / MAP) | 0;
    step(sim);
    const baseTick = sim.world.scalars[S.tick]!;

    const bad: [CommandBody, string][] = [
      [{ type: 'placeRoad', ax: -1, ay: 0, bx: 5, by: 0, cls: 1 }, 'bounds'],
      [{ type: 'zone', x0: 0, y0: 0, x1: MAP, y1: 3, zone: 1, density: 0 }, 'bounds'],
      [{ type: 'zone', x0: wx, y0: wy, x1: wx, y1: wy, zone: 1, density: 0 }, 'terrain'],
      [{ type: 'placeBuilding', arch: 99, x, y, rot: 0 }, 'unknown-archetype'],
      [{ type: 'placeBuilding', arch: ARCH.DEPOT, x: MAP - 1, y, rot: 0 }, 'bounds'],
      [{ type: 'placeRoad', ax: 1.5, ay: 0, bx: 5, by: 0, cls: 1 }, 'invalid'],
      [{ type: 'undo', target: 12345 }, 'not-undoable'],
    ];
    for (const [body, reason] of bad) {
      const r = run(sim, body);
      expect(r.accepted, JSON.stringify(body)).toBe(false);
      expect(r.reason).toBe(reason);
    }
    // Only the tick counter advanced.
    expect(sim.world.scalars[S.tick]).toBe(baseTick + bad.length);

    const poor = createSim(42);
    poor.world.scalars[S.treasury] = 5;
    step(poor);
    const r = run(poor, { type: 'placeBuilding', arch: ARCH.POWER_PLANT, x, y, rot: 0 });
    expect(r.reason).toBe('funds');
    expect(poor.world.bArch.every((v) => v === 0)).toBe(true);
    expect(poor.world.scalars[S.treasury]).toBe(5);
  });

  it('leaves every layer untouched when a command is rejected', () => {
    const sim = createSim(42);
    // The economy refreshes landValue and pollution on its own schedule, so those layers move with the tick like the scalars.
    const strip = (s: Sim) => hashWorld(s.world, (n) => n !== 'scalars' && n !== 'rng' && n !== 'landValue' && n !== 'pollution');
    const before = strip(sim);
    const wet = sim.world.terrain.indexOf(TERRAIN.WATER);
    run(sim, { type: 'zone', x0: wet % MAP, y0: (wet / MAP) | 0, x1: wet % MAP, y1: (wet / MAP) | 0, zone: 1, density: 0 });
    run(sim, { type: 'placeRoad', ax: -5, ay: 0, bx: 5, by: 0, cls: 1 });
    expect(strip(sim)).toBe(before);
  });
});

describe('roads', () => {
  it('updates connectivity bits on neighbours, including a crossing placed later', () => {
    const sim = createSim(42);
    const { x, y } = findLandWindow(sim.world, 16);
    expect(run(sim, { type: 'placeRoad', ax: x, ay: y + 5, bx: x + 10, by: y + 5, cls: 1 }).accepted).toBe(true);
    const r = sim.world.road, at = (px: number, py: number) => r[py * MAP + px]!;
    expect(at(x, y + 5) & ROAD.CONN_MASK).toBe(ROAD.E);
    expect(at(x + 5, y + 5) & ROAD.CONN_MASK).toBe(ROAD.E | ROAD.W);
    expect(at(x + 10, y + 5) & ROAD.CONN_MASK).toBe(ROAD.W);

    expect(run(sim, { type: 'placeRoad', ax: x + 5, ay: y + 5, bx: x + 5, by: y + 10, cls: 1 }).accepted).toBe(true);
    expect(at(x + 5, y + 5) & ROAD.CONN_MASK).toBe(ROAD.E | ROAD.W | ROAD.S);
    expect(at(x + 5, y + 10) & ROAD.CONN_MASK).toBe(ROAD.N);

    expect(run(sim, { type: 'bulldoze', x0: x + 5, y0: y + 5, x1: x + 5, y1: y + 5 }).accepted).toBe(true);
    expect(at(x + 4, y + 5) & ROAD.CONN_MASK).toBe(ROAD.W);
    expect(at(x + 6, y + 5) & ROAD.CONN_MASK).toBe(ROAD.E);
    expect(at(x + 5, y + 6) & ROAD.CONN_MASK).toBe(ROAD.S);
  });

  it('sets the bridge flag over water only', () => {
    const sim = createSim(42);
    const { y, x0, x1 } = findBridgeSpan(sim);
    expect(run(sim, { type: 'placeRoad', ax: x0, ay: y, bx: x1, by: y, cls: 1 }).accepted).toBe(true);
    for (let x = x0; x <= x1; x++) {
      const wet = sim.world.terrain[y * MAP + x] === TERRAIN.WATER || sim.world.terrain[y * MAP + x] === TERRAIN.RIVER;
      expect((sim.world.road[y * MAP + x]! & ROAD.BRIDGE) !== 0, `x=${x}`).toBe(wet);
    }
  });
});

describe('undo', () => {
  it('refunds and restores while unconsumed, and refuses once consumed', () => {
    const sim = createSim(42);
    const { x, y } = findLandWindow(sim.world, 16);
    const t0 = sim.world.scalars[S.treasury]!;
    const clean = hashWorld(sim.world, (n) => n === 'road' || n === 'zone' || n === 'bId');
    const road = run(sim, { type: 'placeRoad', ax: x, ay: y, bx: x + 6, by: y, cls: 1 });
    expect(sim.world.scalars[S.treasury]).toBeLessThan(t0);
    expect(run(sim, { type: 'undo', target: road.journal! }).accepted).toBe(true);
    expect(sim.world.scalars[S.treasury]).toBe(t0);
    expect(hashWorld(sim.world, (n) => n === 'road' || n === 'zone' || n === 'bId')).toBe(clean);
    expect(run(sim, { type: 'undo', target: road.journal! }).reason).toBe('not-undoable');

    const zone = run(sim, { type: 'zone', x0: x, y0: y + 2, x1: x + 3, y1: y + 4, zone: 1, density: 0 });
    run(sim, { type: 'bulldoze', x0: x, y0: y + 2, x1: x, y1: y + 2 });
    expect(run(sim, { type: 'undo', target: zone.journal! }).reason).toBe('consumed');

    const bld = run(sim, { type: 'placeBuilding', arch: ARCH.DEPOT, x: x + 8, y: y + 8, rot: 0 });
    sim.world.bProg[sim.world.bId[(y + 8) * MAP + x + 8]! - 1] = 10;
    expect(run(sim, { type: 'undo', target: bld.journal! }).reason).toBe('consumed');
  });

  it('refuses to undo a building whose slot was freed and reused', () => {
    const sim = createSim(42);
    const { x, y } = findLandWindow(sim.world, 16);
    const depot = run(sim, { type: 'placeBuilding', arch: ARCH.DEPOT, x, y, rot: 0 });
    run(sim, { type: 'bulldoze', x0: x, y0: y, x1: x + 1, y1: y + 1 });
    const plant = run(sim, { type: 'placeBuilding', arch: ARCH.POWER_PLANT, x: x + 6, y: y + 6, rot: 0 });
    expect(plant.accepted).toBe(true);
    const slot = sim.world.bId[(y + 6) * MAP + x + 6]! - 1;
    expect(slot).toBe(0);
    const treasury = sim.world.scalars[S.treasury];
    const r = run(sim, { type: 'undo', target: depot.journal! });
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('not-undoable');
    expect(sim.world.bArch[slot]).toBe(ARCH.POWER_PLANT);
    expect(sim.world.bId[(y + 6) * MAP + x + 6]).toBe(slot + 1);
    expect(sim.world.scalars[S.treasury]).toBe(treasury);
  });

  it('keeps undo ids sim-assigned, so a restored snapshot cannot be confused by a new session', () => {
    const a = createSim(42);
    const { x, y } = findLandWindow(a.world, 16);
    const road = run(a, { type: 'placeRoad', ax: x, ay: y, bx: x + 5, by: y, cls: 1 });
    const b = restore(snapshot(a));
    const roadHash = hashWorld(b.world, (n) => n === 'road');
    // A client command id restarting at 1 must not alias the journaled road.
    const zone = run(b, { type: 'zone', x0: x, y0: y + 3, x1: x + 2, y1: y + 4, zone: 1, density: 0 });
    expect(zone.journal).not.toBe(road.journal);
    expect(run(b, { type: 'undo', target: road.journal! }).accepted).toBe(true);
    expect(hashWorld(b.world, (n) => n === 'road')).not.toBe(roadHash);
    expect(b.world.road.every((v) => v === 0)).toBe(true);
    expect(b.world.zone[(y + 3) * MAP + x]).toBe(1);
  });
});
