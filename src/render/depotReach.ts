import { ARCH } from '../sim/catalog.ts';
import { BMAX, MAP, ROAD, TILES } from '../sim/layers.ts';
import { DEPOT_WORK_RADIUS } from '../sim/robots/constants.ts';
import { lotAccess, roadFlow, UNREACHED, type RoadNet } from '../sim/roads/index.ts';
import { COV_HALO } from '../sim/services/tables.ts';

// The depot's work radius on the main thread: the same roadFlow the sim's coverage passes use, run over the mirror's road layer
// from the door of every depot. Display only; the robots path anywhere connected (see DEPOT_WORK_RADIUS).

/** Tint at a depot's door, falling to REACH_EDGE at the radius. */
export const REACH_DOOR = 255;
export const REACH_EDGE = 60;

type Layers = Record<string, ArrayLike<number>>;

const queue = new Int32Array(TILES);
const dist = new Uint16Array(TILES);

/** The two members of RoadNet that roadFlow and lotAccess read, over a bare road layer. */
export function roadView(road: ArrayLike<number>): RoadNet {
  const r = road as Uint16Array;
  return { road: r, flowQueue: queue, isRoad: (t: number): boolean => t >= 0 && t < TILES && (r[t]! & ROAD.CLASS_MASK) !== 0 } as unknown as RoadNet;
}

export interface Footprint { x: number; y: number; w: number; h: number }

/** Road tiles at the door of every depot in the mirror, plus the door of `extra` (a depot ghost). A depot with no road at its door adds none. */
export function depotDoors(layers: Layers, extra?: Footprint): number[] {
  const net = roadView(layers.road!), out: number[] = [];
  const arch = layers.bArch!, bx = layers.bX!, by = layers.bY!, bw = layers.bW!, bh = layers.bH!;
  for (let s = 0; s < BMAX; s++) {
    if (arch[s] !== ARCH.DEPOT) continue;
    const t = lotAccess(net, bx[s]!, by[s]!, bw[s]!, bh[s]!);
    if (t >= 0) out.push(t);
  }
  if (extra) {
    const t = lotAccess(net, extra.x, extra.y, extra.w, extra.h);
    if (t >= 0) out.push(t);
  }
  return out;
}

/** The road tile at the door of the building in `slot`, or -1. */
export function doorOfBuilding(layers: Layers, slot: number): number {
  return lotAccess(roadView(layers.road!), layers.bX![slot]!, layers.bY![slot]!, layers.bW![slot]!, layers.bH![slot]!);
}

/**
 * Fill `out` (TILES values) with the work radius of the given door tiles: REACH_DOOR at a door, falling linearly to REACH_EDGE at
 * DEPOT_WORK_RADIUS road tiles, then spread COV_HALO tiles either side of every road tile reached (a lot takes the tint of the
 * road it borders, as it does for service coverage). Returns how many tiles are tinted.
 */
export function reachLayer(layers: Layers, doors: readonly number[], out: Uint8Array): number {
  out.fill(0);
  if (doors.length === 0) return 0;
  const net = roadView(layers.road!);
  const { reached } = roadFlow(net, doors, DEPOT_WORK_RADIUS, dist);
  let n = 0;
  for (let k = 0; k < reached.length; k++) {
    const t = reached[k]!, d = dist[t]!;
    if (d === UNREACHED) continue;
    const v = REACH_DOOR - Math.floor((d * (REACH_DOOR - REACH_EDGE)) / DEPOT_WORK_RADIUS);
    const x = t & (MAP - 1), y = t >> 8;
    for (let yy = Math.max(0, y - COV_HALO); yy <= Math.min(MAP - 1, y + COV_HALO); yy++) {
      for (let xx = Math.max(0, x - COV_HALO); xx <= Math.min(MAP - 1, x + COV_HALO); xx++) {
        const i = yy * MAP + xx;
        if (out[i]! < v) { if (out[i] === 0) n++; out[i] = v; }
      }
    }
  }
  return n;
}
