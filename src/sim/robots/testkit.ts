import { expect } from 'vitest';
import { ARCH, BFLAG, isRci } from '../catalog.ts';
import { execute, type Command, type CommandBody } from '../commands.ts';
import { createSim, step } from '../engine.ts';
import { AMAX, BMAX, S, TERRAIN } from '../layers.ts';
import type { Sim } from '../world.ts';
import { AST } from './constants.ts';

// Scenario builders shared by the robot tests. They go through real commands, so costs, validation and the undo journal run.

let nextId = 1;
export function run(sim: Sim, body: CommandBody): boolean {
  return execute(sim, { ...body, id: nextId++, tick: 0 } as Command);
}

/** A seeded sim on flat grass at height 10 tiles with no water. */
export function flatSim(seed = 42, debug = false): Sim {
  const sim = createSim(seed, { debug });
  sim.world.terrain.fill(TERRAIN.GRASS);
  sim.world.height.fill(160);
  sim.world.waterDepth.fill(0);
  return sim;
}

export const road = (sim: Sim, ax: number, ay: number, bx: number, by: number): void => {
  expect(run(sim, { type: 'placeRoad', ax, ay, bx, by, cls: 1 })).toBe(true);
};
export const zone = (sim: Sim, x0: number, y0: number, x1: number, y1: number, z = 1, density = 0): void => {
  expect(run(sim, { type: 'zone', x0, y0, x1, y1, zone: z, density })).toBe(true);
};
export const depot = (sim: Sim, x: number, y: number): void => {
  expect(run(sim, { type: 'placeBuilding', arch: ARCH.DEPOT, x, y, rot: 0 })).toBe(true);
};

/** Depot at (98,102) on the west end of a street along y = 104, residential lots on the rows south of the street. */
export function town(sim: Sim = flatSim()): Sim {
  road(sim, 96, 104, 130, 104);
  depot(sim, 98, 102);
  zone(sim, 100, 105, 120, 108);
  return sim;
}

/** A ring road with the depot beside its west side: two routes to every lot inside it. */
export function ringTown(): Sim {
  const sim = flatSim();
  road(sim, 100, 100, 124, 100); road(sim, 124, 100, 124, 106); road(sim, 124, 106, 100, 106); road(sim, 100, 106, 100, 100);
  depot(sim, 98, 102);
  zone(sim, 102, 101, 122, 105);
  return sim;
}

export const slotsOf = (sim: Sim, pred: (s: number) => boolean): number[] => {
  const out: number[] = [];
  for (let s = 0; s < BMAX; s++) if (sim.world.bArch[s] !== 0 && pred(s)) out.push(s);
  return out;
};
export const grown = (sim: Sim): number[] => slotsOf(sim, (s) => isRci(sim.world.bArch[s]!));
export const constructing = (sim: Sim): number[] => grown(sim).filter((s) => (sim.world.bFlags[s]! & BFLAG.CONSTRUCTING) !== 0);
export const finished = (sim: Sim): number[] => grown(sim).filter((s) => (sim.world.bFlags[s]! & BFLAG.CONSTRUCTING) === 0);
export const depots = (sim: Sim): number[] => slotsOf(sim, (s) => sim.world.bArch[s] === ARCH.DEPOT);
export const agents = (sim: Sim, kind?: number): number[] => {
  const out: number[] = [];
  for (let a = 0; a < AMAX; a++) if (sim.world.aKind[a] !== 0 && (kind === undefined || sim.world.aKind[a] === kind)) out.push(a);
  return out;
};
export const active = (sim: Sim): number[] => agents(sim).filter((a) => sim.world.aState[a] !== AST.IDLE);
export const tickOf = (sim: Sim): number => sim.world.scalars[S.tick]!;

export function runUntil(sim: Sim, pred: () => boolean, max: number): boolean {
  for (let t = 0; t < max; t++) { if (pred()) return true; step(sim); }
  return pred();
}
