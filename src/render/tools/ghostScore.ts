import { ARCH, BFLAG, SVC, archetype, type Archetype } from '../../sim/catalog.ts';
import { LV_PARK_SHIFT, LV_SERVICE_SHIFT } from '../../sim/economy/tables.ts';
import { zoneOfArch } from '../../sim/economy/totals.ts';
import { footprintOf } from '../../sim/estimate.ts';
import { BMAX, MAP, TILES, type World } from '../../sim/layers.ts';
import { lotAccess, roadFlow } from '../../sim/roads/index.ts';
import { COV_HALO, COVERED_MIN, falloff } from '../../sim/services/tables.ts';
import { PRODUCER, PUMP_INLAND_ML, PUMP_NEAR_ML, SOLAR_PEAK_MW, fixedMwOf, powerUseOf, producerKind, waterUseOf } from '../../sim/utilities/tables.ts';
import { nearWater } from '../../sim/utilities/solve.ts';
import { depotDoors, reachLayer, roadView, workRadiusOf } from '../depotReach.ts';
import type { Plan, ToolWorld } from './controller.ts';

// The chips beside the build ghost: what this placement would do, worked out on the main thread from the mirror (and the same
// estimate() the ghost's colours come from), so the player sees "+12 land value" or "smog over 14 homes" before paying. Each chip is
// green (a plain gain), yellow (a catch) or red (it will not work or it hurts). Display only: the sim never reads any of it.

export type ChipTone = 'good' | 'warn' | 'bad';
export interface Chip { id: string; text: string; tone: ChipTone }

const MAX_CHIPS = 4;
const TONE_RANK: Record<ChipTone, number> = { bad: 0, warn: 1, good: 2 };
const SMOG_REACH = 12;
const LV_GOOD = 110;
const LV_FAIR = 60;

type Layers = Record<string, ArrayLike<number>>;
const dist = new Uint16Array(TILES);
const cover = new Uint8Array(TILES);

/** Service coverage or land value a placement would add, worked out the way the sim's passes do. */
export interface Gain {
  /** The building has a road tile at its door (road services reach nothing without one). */
  door: boolean;
  /** Standing buildings that go from uncovered to covered, and all standing buildings the new coverage reaches. */
  newlyCovered: number;
  reached: number;
  /** Mean land value the reached buildings gain (per footprint tile, then per building). */
  landValue: number;
}

const COV_LAYER: Record<number, string> = { [SVC.FIRE]: 'covFire', [SVC.POLICE]: 'covPolice', [SVC.HEALTH]: 'covHealth', [SVC.EDU]: 'covEdu', [SVC.PARK]: 'covPark' };
const SERVICE_SUM = ['covFire', 'covPolice', 'covHealth', 'covEdu'] as const;

/** Fill `cover` with the coverage a new service of this kind would paint (before any capacity limit). Returns false for a road service with no door. */
function paintCoverage(layers: Layers, a: Archetype, x: number, y: number, rot: number): boolean {
  const svc = a.service!;
  cover.fill(0);
  const { w, h } = footprintOf(a, rot);
  if (svc.kind === SVC.PARK) {
    const r = svc.radius, r2 = (r + 1) * (r + 1);
    for (let yy = Math.max(0, y - r); yy <= Math.min(MAP - 1, y + h - 1 + r); yy++) {
      const dy = yy < y ? y - yy : yy > y + h - 1 ? yy - (y + h - 1) : 0;
      for (let xx = Math.max(0, x - r); xx <= Math.min(MAP - 1, x + w - 1 + r); xx++) {
        const dx = xx < x ? x - xx : xx > x + w - 1 ? xx - (x + w - 1) : 0;
        const d2 = dx * dx + dy * dy;
        if (d2 < r2) cover[yy * MAP + xx] = Math.floor((255 * (r2 - d2)) / r2);
      }
    }
    return true;
  }
  const net = roadView(layers.road!);
  const door = lotAccess(net, x, y, w, h);
  if (door < 0) return false;
  const { reached } = roadFlow(net, [door], svc.radius, dist);
  for (let k = 0; k < reached.length; k++) {
    const t = reached[k]!, v = falloff(dist[t]!, svc.radius), tx = t & (MAP - 1), ty = t >> 8;
    for (let yy = Math.max(0, ty - COV_HALO); yy <= Math.min(MAP - 1, ty + COV_HALO); yy++) {
      for (let xx = Math.max(0, tx - COV_HALO); xx <= Math.min(MAP - 1, tx + COV_HALO); xx++) if (cover[yy * MAP + xx]! < v) cover[yy * MAP + xx] = v;
    }
  }
  return true;
}

/**
 * What a service building at (x, y) would change among the standing buildings: how many it newly covers, how many it reaches, and the
 * land value it adds (the sim's serviceBonus: the four road coverages summed >> LV_SERVICE_SHIFT, parks covPark >> LV_PARK_SHIFT).
 */
export function serviceGain(layers: Layers, a: Archetype, x: number, y: number, rot: number): Gain {
  const svc = a.service;
  if (!svc || !COV_LAYER[svc.kind]) return { door: false, newlyCovered: 0, reached: 0, landValue: 0 };
  const door = paintCoverage(layers, a, x, y, rot);
  if (!door) return { door: false, newlyCovered: 0, reached: 0, landValue: 0 };
  const own = layers[COV_LAYER[svc.kind]!]!, park = svc.kind === SVC.PARK;
  const residentsOnly = svc.kind === SVC.HEALTH || svc.kind === SVC.EDU;
  const arch = layers.bArch!, bx = layers.bX!, by = layers.bY!, bw = layers.bW!, bh = layers.bH!, flags = layers.bFlags!;
  let newly = 0, reached = 0, lvSum = 0, lvN = 0;
  for (let s = 0; s < BMAX; s++) {
    const z = zoneOfArch(arch[s]!);
    if (z === 0 || (flags[s]! & (BFLAG.CONSTRUCTING | BFLAG.RUBBLE)) !== 0 || (residentsOnly && z !== 1)) continue;
    let oldMax = 0, newMax = 0, dLv = 0;
    for (let yy = by[s]!; yy < by[s]! + bh[s]!; yy++) {
      for (let xx = bx[s]!; xx < bx[s]! + bw[s]!; xx++) {
        const i = yy * MAP + xx, o = own[i]!, n = cover[i]!;
        if (o > oldMax) oldMax = o;
        if (n > newMax) newMax = n;
        if (n > o) {
          if (park) dLv += (n >> LV_PARK_SHIFT) - (o >> LV_PARK_SHIFT);
          else {
            let sum = 0;
            for (const k of SERVICE_SUM) sum += layers[k]![i]!;
            dLv += ((sum - o + n) >> LV_SERVICE_SHIFT) - (sum >> LV_SERVICE_SHIFT);
          }
        }
      }
    }
    if (newMax === 0) continue;
    reached++;
    if (newMax >= COVERED_MIN && oldMax < COVERED_MIN) newly++;
    if (dLv > 0 && z !== 3) { lvSum += dLv / (bw[s]! * bh[s]!); lvN++; }
  }
  return { door: true, newlyCovered: newly, reached, landValue: lvN === 0 ? 0 : lvSum / lvN };
}

const mean = (layer: ArrayLike<number>, tiles: readonly number[]): number => {
  let s = 0;
  for (const i of tiles) s += layer[i]!;
  return tiles.length === 0 ? 0 : s / tiles.length;
};

const anyWhere = (layer: ArrayLike<number>, pred: (v: number) => boolean): boolean => {
  for (let i = 0; i < TILES; i++) if (pred(layer[i]!)) return true;
  return false;
};
const served = (v: number): boolean => v === 1 || v === 2;

/** Whether a power line, plant or powered building touches the footprint along an edge. */
function powerTouches(layers: Layers, x: number, y: number, w: number, h: number): boolean {
  const on = layers.powerOn!;
  for (let yy = y - 1; yy <= y + h; yy++) {
    for (let xx = x - 1; xx <= x + w; xx++) {
      const inX = xx >= x && xx < x + w, inY = yy >= y && yy < y + h;
      if ((!inX && !inY) || xx < 0 || yy < 0 || xx >= MAP || yy >= MAP) continue;
      if (served(on[yy * MAP + xx]!)) return true;
    }
  }
  return false;
}

const waterReaches = (layers: Layers, x: number, y: number, w: number, h: number): boolean => {
  const on = layers.waterOn!;
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (served(on[yy * MAP + xx]!)) return true;
  return false;
};

function homesNear(layers: Layers, cx: number, cy: number, reach: number): number {
  const arch = layers.bArch!, bx = layers.bX!, by = layers.bY!, bw = layers.bW!, bh = layers.bH!;
  let n = 0;
  for (let s = 0; s < BMAX; s++) {
    if (zoneOfArch(arch[s]!) !== 1) continue;
    const ox = bx[s]! + (bw[s]! >> 1), oy = by[s]! + (bh[s]! >> 1);
    if (Math.max(Math.abs(ox - cx), Math.abs(oy - cy)) <= reach) n++;
  }
  return n;
}

const SERVICE_WORD: Record<number, string> = { [SVC.FIRE]: 'fire cover', [SVC.POLICE]: 'police cover', [SVC.HEALTH]: 'health cover', [SVC.EDU]: 'school cover' };

function zonedIn(layers: Layers, reach: Uint8Array): { in: number; all: number } {
  let inn = 0, all = 0;
  const zone = layers.zone!;
  for (let i = 0; i < TILES; i++) {
    if ((zone[i]! & 3) === 0) continue;
    all++;
    if (reach[i] !== 0) inn++;
  }
  return { in: inn, all };
}

const reachScratch = new Uint8Array(TILES);
const baseScratch = new Uint8Array(TILES);

function depotChips(layers: Layers, x: number, y: number, w: number, h: number): Chip[] {
  const out: Chip[] = [];
  const ghost = { x, y, w, h };
  if (lotAccess(roadView(layers.road!), x, y, w, h) < 0) return [{ id: 'door', text: 'No road at its door: robots cannot leave', tone: 'bad' }];
  const base = depotDoors(layers);
  reachLayer(layers, base, baseScratch);
  reachLayer(layers, depotDoors(layers, ghost), reachScratch);
  const before = zonedIn(layers, baseScratch), after = zonedIn(layers, reachScratch);
  const add = after.in - before.in;
  if (after.all === 0) out.push({ id: 'radius', text: `Work radius ${workRadiusOf(layers)} road tiles`, tone: 'good' });
  else if (add > 0) out.push({ id: 'reach', text: `+${add} zoned tiles in reach`, tone: 'good' });
  else if (before.in > 0) out.push({ id: 'reach', text: 'Already in reach of another depot', tone: 'warn' });
  else out.push({ id: 'reach', text: 'No zoned land in reach', tone: 'bad' });
  return out;
}

function buildingChips(layers: Layers, a: Archetype, x: number, y: number, rot: number): Chip[] {
  const out: Chip[] = [];
  const { w, h } = footprintOf(a, rot);
  const cx = x + (w >> 1), cy = y + (h >> 1);
  const svc = a.service;
  if (a.id === ARCH.DEPOT) return depotChips(layers, x, y, w, h);
  if (svc && COV_LAYER[svc.kind]) {
    const g = serviceGain(layers, a, x, y, rot);
    const word = svc.kind === SVC.PARK ? 'park' : SERVICE_WORD[svc.kind]!;
    if (!g.door) out.push({ id: 'door', text: 'No road at its door: it covers nothing', tone: 'bad' });
    else if (svc.kind === SVC.PARK) out.push(g.reached > 0 ? { id: 'lv', text: `+${Math.round(g.landValue)} land value near ${g.reached} buildings`, tone: Math.round(g.landValue) >= 1 ? 'good' : 'warn' } : { id: 'lv', text: 'No buildings nearby to enjoy it', tone: 'warn' });
    else {
      out.push(g.newlyCovered > 0 ? { id: 'cover', text: `+${g.newlyCovered} buildings with ${word}`, tone: 'good' } : { id: 'cover', text: g.reached > 0 ? `No new buildings gain ${word}` : `No buildings in reach of ${word}`, tone: 'warn' });
      if (Math.round(g.landValue) >= 1) out.push({ id: 'lv', text: `+${Math.round(g.landValue)} land value`, tone: 'good' });
    }
  }
  if (svc && svc.kind === SVC.REPAIR) out.push({ id: 'repair', text: `Robots work faster within ${svc.radius} tiles`, tone: 'good' });
  if (a.pollution && a.pollution > 0) {
    const n = homesNear(layers, cx, cy, SMOG_REACH);
    out.push(n > 0 ? { id: 'smog', text: `Smog will drift over ${n} ${n === 1 ? 'home' : 'homes'}`, tone: n >= 3 ? 'bad' : 'warn' } : { id: 'smog', text: 'Smog drifts over open land', tone: 'good' });
  }
  const kind = producerKind(a.id);
  if (kind === PRODUCER.PLANT || kind === PRODUCER.SOLAR) {
    const mw = kind === PRODUCER.SOLAR ? SOLAR_PEAK_MW : fixedMwOf(a.id);
    out.push({ id: 'mw', text: kind === PRODUCER.SOLAR ? `+up to ${mw} MW in daylight` : `+${mw} MW`, tone: 'good' });
  } else if (kind === PRODUCER.PUMP) {
    const near = nearWater({ terrain: layers.terrain, waterDepth: layers.waterDepth } as unknown as World, x, y, w, h);
    out.push(near ? { id: 'ml', text: `+${PUMP_NEAR_ML} ML of water`, tone: 'good' } : { id: 'ml', text: `Only +${PUMP_INLAND_ML} ML inland: build beside water`, tone: 'warn' });
  } else if (kind === PRODUCER.TOWER) out.push({ id: 'ml', text: 'Reserve water for peak demand', tone: 'good' });
  if (powerUseOf(a.id) > 0 && anyWhere(layers.powerOn!, (v) => v !== 0) && !powerTouches(layers, x, y, w, h)) {
    out.push({ id: 'power', text: 'No power touches it: connect a line', tone: 'warn' });
  }
  if (waterUseOf(a.id) > 0 && anyWhere(layers.waterOn!, (v) => v !== 0) && !waterReaches(layers, x, y, w, h)) {
    out.push({ id: 'water', text: 'No water reaches it: lay a pipe', tone: 'warn' });
  }
  return out;
}

function zoneChips(layers: Layers, tiles: readonly number[]): Chip[] {
  if (tiles.length === 0) return [];
  const out: Chip[] = [];
  const lv = Math.round(mean(layers.landValue!, tiles));
  out.push({ id: 'lv', text: `Land value ${lv}`, tone: lv >= LV_GOOD ? 'good' : lv >= LV_FAIR ? 'warn' : 'bad' });
  const smog = Math.round(mean(layers.pollution!, tiles));
  if (smog >= 25) out.push({ id: 'smog', text: `Smog here (${smog})`, tone: smog >= 60 ? 'bad' : 'warn' });
  const fire = mean(layers.covFire!, tiles);
  if (fire < COVERED_MIN) out.push({ id: 'fire', text: 'No fire cover here', tone: 'warn' });
  const road = layers.road!;
  const touchesRoad = tiles.some((i) => {
    const x = i & (MAP - 1), y = i >> 8;
    return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
      const nx = x + dx!, ny = y + dy!;
      return nx >= 0 && ny >= 0 && nx < MAP && ny < MAP && (road[ny * MAP + nx]! & 7) !== 0;
    });
  });
  if (!touchesRoad) out.push({ id: 'road', text: 'No road beside it: robots cannot build here', tone: 'bad' });
  const near = (layer: ArrayLike<number>): boolean => {
    for (const i of tiles) {
      const x = i & (MAP - 1), y = i >> 8;
      for (let yy = Math.max(0, y - 3); yy <= Math.min(MAP - 1, y + 3); yy++) for (let xx = Math.max(0, x - 3); xx <= Math.min(MAP - 1, x + 3); xx++) if (served(layer[yy * MAP + xx]!)) return true;
    }
    return false;
  };
  if (anyWhere(layers.powerOn!, (v) => v !== 0) && !near(layers.powerOn!)) out.push({ id: 'power', text: 'No power nearby', tone: 'warn' });
  if (anyWhere(layers.waterOn!, (v) => v !== 0) && !near(layers.waterOn!)) out.push({ id: 'water', text: 'No water nearby', tone: 'warn' });
  return out;
}

/** The chips for what `plan` would do, worst first, at most MAX_CHIPS. Empty when the sim would refuse the command (a plan only short of funds still shows them). */
export function ghostChips(world: Pick<ToolWorld, 'layers'>, plan: Plan | null): Chip[] {
  if (!plan || (plan.est.reason && plan.est.reason !== 'funds')) return [];
  const layers = world.layers, cmd = plan.cmd;
  let chips: Chip[] = [];
  if (cmd.type === 'placeBuilding') {
    const a = archetype(cmd.arch);
    if (a) chips = buildingChips(layers, a, cmd.x, cmd.y, cmd.rot);
  } else if (cmd.type === 'zone') chips = zoneChips(layers, plan.est.validTiles);
  return chips.sort((p, q) => TONE_RANK[p.tone] - TONE_RANK[q.tone]).slice(0, MAX_CHIPS);
}
