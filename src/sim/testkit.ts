import type { Command, CommandBody } from './commands.ts';
import { apply, step } from './engine.ts';
import { MAP, TERRAIN, type World } from './layers.ts';
import type { Sim } from './world.ts';
import { ARCH } from './catalog.ts';

const OK = new Set<number>([TERRAIN.GRASS, TERRAIN.SAND, TERRAIN.FOREST]);

/** First 4-aligned top-left of a size x size window of zonable land, scanning rows then columns. */
export function findLandWindow(world: World, size: number): { x: number; y: number } {
  for (let y = 8; y + size < MAP - 8; y += 4) {
    for (let x = 8; x + size < MAP - 8; x += 4) {
      let ok = true;
      for (let yy = y; yy < y + size && ok; yy++) for (let xx = x; xx < x + size; xx++) if (!OK.has(world.terrain[yy * MAP + xx]!)) { ok = false; break; }
      if (ok) return { x, y };
    }
  }
  throw new Error('no land window');
}

/** The scripted city: roads, three zones, four buildings, a bulldoze, an undo, a tax change and one bad command. */
export function scriptedCity(world: World): Command[] {
  const { x: ox, y: oy } = findLandWindow(world, 32);
  const body: [number, CommandBody][] = [
    [1, { type: 'placeRoad', ax: ox, ay: oy + 10, bx: ox + 30, by: oy + 10, cls: 1 }],
    // Only what a day-one city may build: avenues and high density are locked until their population tier (unlocks.ts).
    [2, { type: 'placeRoad', ax: ox + 15, ay: oy + 10, bx: ox + 15, by: oy + 30, cls: 1 }],
    [3, { type: 'zone', x0: ox + 2, y0: oy + 2, x1: ox + 12, y1: oy + 8, zone: 1, density: 1 }],
    [4, { type: 'zone', x0: ox + 17, y0: oy + 12, x1: ox + 25, y1: oy + 18, zone: 2, density: 0 }],
    [5, { type: 'zone', x0: ox + 2, y0: oy + 22, x1: ox + 10, y1: oy + 28, zone: 3, density: 1 }],
    [10, { type: 'placeBuilding', arch: ARCH.DEPOT, x: ox + 3, y: oy + 12, rot: 0 }],
    [11, { type: 'placeBuilding', arch: ARCH.POWER_PLANT, x: ox + 18, y: oy + 20, rot: 0 }],
    [12, { type: 'placeBuilding', arch: ARCH.WATER_PUMP, x: ox + 12, y: oy + 12, rot: 1 }],
    [13, { type: 'placeBuilding', arch: ARCH.FIRE_STATION, x: ox + 20, y: oy + 24, rot: 0 }],
    [20, { type: 'bulldoze', x0: ox + 2, y0: oy + 2, x1: ox + 3, y1: oy + 3 }],
    // Undo targets a sim-assigned journal id; the I-zone is the fifth journaled command.
    [30, { type: 'undo', target: 5 }],
    [40, { type: 'setTax', rate: 12 }],
    [60, { type: 'zone', x0: -4, y0: 0, x1: 3, y1: 3, zone: 1, density: 0 }],
  ];
  return body.map(([tick, b], i) => ({ ...b, id: i + 1, tick }) as Command);
}

export function runTicks(sim: Sim, n: number): void {
  for (let i = 0; i < n; i++) step(sim);
}

export function runScripted(sim: Sim, cmds: Command[], ticks: number): void {
  for (const c of cmds) apply(sim, c);
  runTicks(sim, ticks);
}
