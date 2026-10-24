import { ARCH, archetype } from '../sim/catalog.ts';
import { BMAX, MAP, ROAD } from '../sim/layers.ts';

type Layers = Record<string, ArrayLike<number>>;

/** What the player has built so far, read from the render mirror (or any layer table of the same shape). */
export interface CityFacts {
  depots: number;
  /** A depot has a road tile touching its footprint. */
  depotOnRoad: boolean;
  /** A residential zone tile touches a road tile. */
  residentialOnRoad: boolean;
  /** A commercial or industrial zone tile touches a road tile. */
  workZoneOnRoad: boolean;
  powerPlants: number;
  powerLines: number;
  waterPumps: number;
  pipes: number;
}

export const NO_FACTS: CityFacts = { depots: 0, depotOnRoad: false, residentialOnRoad: false, workZoneOnRoad: false, powerPlants: 0, powerLines: 0, waterPumps: 0, pipes: 0 };

const isRoad = (road: ArrayLike<number>, x: number, y: number): boolean => x >= 0 && y >= 0 && x < MAP && y < MAP && (road[y * MAP + x]! & ROAD.CLASS_MASK) !== 0;

/** Count the buildings of one archetype in the building table. */
export function countBuildings(layers: Layers, arch: number): number {
  const a = layers.bArch;
  if (!a) return 0;
  let n = 0;
  for (let s = 0; s < BMAX; s++) if (a[s] === arch) n++;
  return n;
}

/** Scan the layers once. Cheap enough to run a couple of times a second: one pass over the building table and one over the tiles. */
export function factsFromLayers(layers: Layers): CityFacts {
  const f: CityFacts = { ...NO_FACTS };
  const arch = layers.bArch, bx = layers.bX, by = layers.bY, bw = layers.bW, bh = layers.bH, road = layers.road, zone = layers.zone;
  if (arch && bx && by && bw && bh) {
    for (let s = 0; s < BMAX; s++) {
      const id = arch[s]!;
      if (id === 0) continue;
      const util = archetype(id)?.utility;
      if (id === ARCH.DEPOT) {
        f.depots++;
        if (road && !f.depotOnRoad) {
          const x0 = bx[s]!, y0 = by[s]!, w = bw[s]! || 2, h = bh[s]! || 2;
          for (let i = 0; i < w && !f.depotOnRoad; i++) f.depotOnRoad = isRoad(road, x0 + i, y0 - 1) || isRoad(road, x0 + i, y0 + h);
          for (let j = 0; j < h && !f.depotOnRoad; j++) f.depotOnRoad = isRoad(road, x0 - 1, y0 + j) || isRoad(road, x0 + w, y0 + j);
        }
      } else if (util === 'power') f.powerPlants++;
      else if (util === 'water') f.waterPumps++;
    }
  }
  const power = layers.ugPower, water = layers.ugWater;
  if (power) for (let i = 0; i < power.length; i++) if (power[i]) f.powerLines++;
  if (water) for (let i = 0; i < water.length; i++) if (water[i]) f.pipes++;
  if (road && zone) {
    for (let y = 0; y < MAP && !(f.residentialOnRoad && f.workZoneOnRoad); y++) {
      for (let x = 0; x < MAP; x++) {
        const z = zone[y * MAP + x]! & 3;
        if (z === 0) continue;
        if (z === 1 ? f.residentialOnRoad : f.workZoneOnRoad) continue;
        if (isRoad(road, x - 1, y) || isRoad(road, x + 1, y) || isRoad(road, x, y - 1) || isRoad(road, x, y + 1)) {
          if (z === 1) f.residentialOnRoad = true; else f.workZoneOnRoad = true;
        }
      }
    }
  }
  return f;
}

/** First-use hint per tool group (one line, shown once). */
export const TOOL_HINTS: Record<string, string> = {
  bulldoze: 'Drag over anything to clear it. Refunds are partial.',
  road: 'Drag to draw a road. Zones and the depot need one beside them.',
  zone: 'Drag a box beside a road. Robots build what the city asks for.',
  service: 'Tap the map to place. Each extra depot adds robots.',
  utilities: 'Power lines and pipes connect plants and pumps to buildings.',
  terraform: 'Drag to raise, lower or level the ground.',
};
