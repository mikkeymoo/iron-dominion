import { BFLAG } from '../catalog.ts';
import { clearBuilding, settleGround } from '../commands.ts';
import { BMAX, D, MAP, ROAD, S, TERRAIN, isWaterTerrain } from '../layers.ts';
import { nextU32 } from '../rng.ts';
import { markDirty, type Sim } from '../world.ts';
import { addDamage, destroyBuilding, startFire } from './fire.ts';
import {
  CRATER_BLAST, CRATER_CORE, CRATER_DEPTH, CRATER_FIRE, CRATER_FIRE_CHANCE, CRATER_MIN_RADIUS, CRATER_RADIUS_SPAN, CRATER_ROAD, HEAL_STEP,
  METEOR_DELAY, QUAKE_DAMAGE_MIN, QUAKE_DAMAGE_SPAN, QUAKE_HIT, QUAKE_MIN_RADIUS, QUAKE_RADIUS_SPAN, QUAKE_ROAD,
} from './tables.ts';

const roll16 = (sim: Sim): number => nextU32(sim.world.drng) >>> 16;
const roll = (sim: Sim, n: number): number => Math.floor((nextU32(sim.world.drng) * n) / 4294967296);

/** Distance from (cx, cy) to a building's centre, in tiles. */
const dist = (sim: Sim, s: number, cx: number, cy: number): number => {
  const w = sim.world;
  return Math.sqrt((w.bX[s]! + w.bW[s]! / 2 - cx - 0.5) ** 2 + (w.bY[s]! + w.bH[s]! / 2 - cy - 0.5) ** 2);
};

/** Crack roads inside `radius` of the centre: a tile cracks with probability `chance / 65536` falling linearly to zero at the edge. Returns the count. */
function crackRoads(sim: Sim, cx: number, cy: number, radius: number, chance: number): number {
  const w = sim.world;
  let n = 0;
  for (let y = Math.max(0, Math.floor(cy - radius)); y <= Math.min(MAP - 1, Math.ceil(cy + radius)); y++) {
    for (let x = Math.max(0, Math.floor(cx - radius)); x <= Math.min(MAP - 1, Math.ceil(cx + radius)); x++) {
      const i = y * MAP + x;
      if ((w.road[i]! & ROAD.CLASS_MASK) === 0 || (w.road[i]! & ROAD.DAMAGED) !== 0) continue;
      const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (d >= radius) continue;
      if (roll16(sim) < Math.floor(chance * (1 - d / radius))) { w.road[i] = w.road[i]! | ROAD.DAMAGED; markDirty(sim, 'geometry', x, y); n++; }
    }
  }
  return n;
}

export const quakeRadius = (sim: Sim): number => QUAKE_MIN_RADIUS + roll(sim, QUAKE_RADIUS_SPAN + 1);

/**
 * An earthquake centred on tile (cx, cy). Buildings within `radius` (finished ones only) are hit with a probability that falls
 * from QUAKE_HIT at the epicentre to zero at the edge and take damage that does the same; enough damage collapses a building
 * into rubble. Road tiles crack on the same falloff. Every roll comes from the disaster stream, in slot then raster order, so
 * a seed and a state give one outcome.
 */
export function quake(sim: Sim, cx: number, cy: number, radius: number): { hit: number; collapsed: number; cracks: number } {
  const w = sim.world;
  let hit = 0, collapsed = 0;
  for (let s = 0; s < BMAX; s++) {
    if (w.bArch[s] === 0 || (w.bFlags[s]! & (BFLAG.CONSTRUCTING | BFLAG.RUBBLE)) !== 0) continue;
    const fall = 1 - dist(sim, s, cx, cy) / radius;
    if (fall <= 0) continue;
    if (roll16(sim) >= Math.floor(QUAKE_HIT * fall)) continue;
    const amount = QUAKE_DAMAGE_MIN + Math.floor(QUAKE_DAMAGE_SPAN * fall) + roll(sim, 32);
    hit++;
    addDamage(sim, s, amount);
    if ((w.bFlags[s]! & BFLAG.RUBBLE) !== 0 || w.bArch[s] === 0) collapsed++;
  }
  const cracks = crackRoads(sim, cx, cy, radius, QUAKE_ROAD);
  sim.events.push({ type: 'disaster', tick: w.scalars[S.tick]!, kind: 'quake', phase: 'impact', x: cx, y: cy, radius, arch: 0, impactTick: 0 });
  return { hit, collapsed, cracks };
}

/** A meteor is on its way: the impact is stored in the world (so a save mid-flight still lands it) and announced for the renderer. */
export function launchMeteor(sim: Sim, x: number, y: number): boolean {
  const w = sim.world;
  if (w.disaster[D.METEOR_AT] !== 0) return false;
  const at = w.scalars[S.tick]! + METEOR_DELAY;
  w.disaster[D.METEOR_AT] = at; w.disaster[D.METEOR_X] = x; w.disaster[D.METEOR_Y] = y;
  sim.events.push({ type: 'disaster', tick: w.scalars[S.tick]!, kind: 'meteor', phase: 'start', x, y, radius: 0, arch: 0, impactTick: at });
  return true;
}

export const craterRadius = (sim: Sim): number => CRATER_MIN_RADIUS + roll(sim, CRATER_RADIUS_SPAN + 1);

/**
 * The impact: lower the ground in a smooth bowl (never below HEIGHT_MIN, never under water), scorch the core to rock, wipe roads,
 * zones and lines there, remove buildings in the core, turn buildings in the blast ring to rubble and set a ring of fires beyond it.
 * Heights go through the same dirty marking and ground settling as the terraform command.
 */
export function meteorImpact(sim: Sim, cx: number, cy: number, radius: number): void {
  const w = sim.world;
  const core = radius * CRATER_CORE;
  const x0 = Math.max(0, Math.floor(cx - radius)), x1 = Math.min(MAP - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius)), y1 = Math.min(MAP - 1, Math.ceil(cy + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (d > radius) continue;
      const i = y * MAP + x;
      if (isWaterTerrain(w.terrain[i]!) || w.waterDepth[i]! > 0) continue;
      const t = 1 - d / radius, depth = Math.floor(CRATER_DEPTH * t * t * (3 - 2 * t));
      if (depth > 0) w.height[i] = Math.max(1, w.height[i]! - depth);
      if (d <= core) {
        w.terrain[i] = TERRAIN.ROCK;
        w.road[i] = 0; w.zone[i] = 0; w.ugPower[i] = 0; w.ugWater[i] = 0;
      }
      markDirty(sim, 'geometry', x, y);
    }
  }
  settleGround(sim, x0 - 1, y0 - 1, x1 + 1, y1 + 1);

  for (let s = 0; s < BMAX; s++) {
    if (w.bArch[s] === 0) continue;
    const d = dist(sim, s, cx, cy);
    if (d <= core) clearBuilding(sim, s);
    else if (d <= radius * CRATER_BLAST) destroyBuilding(sim, s);
    else if (d <= radius * CRATER_FIRE && roll16(sim) < CRATER_FIRE_CHANCE) startFire(sim, s, false);
  }
  crackRoads(sim, cx, cy, radius * CRATER_BLAST, CRATER_ROAD);
  w.disaster[D.METEOR_AT] = 0; w.disaster[D.METEOR_X] = 0; w.disaster[D.METEOR_Y] = 0;
  sim.events.push({
    type: 'disaster', tick: w.scalars[S.tick]!, kind: 'meteor', phase: 'impact', x: cx, y: cy, radius, arch: 0, impactTick: w.scalars[S.tick]!,
  });
}

/** Buildings shake off a little damage over time when nothing is burning them. */
export function healPass(sim: Sim): void {
  const w = sim.world;
  for (let s = 0; s < BMAX; s++) {
    if (w.bArch[s] === 0 || w.bDmg[s] === 0 || (w.bFlags[s]! & (BFLAG.BURNING | BFLAG.RUBBLE)) !== 0) continue;
    w.bDmg[s] = Math.max(0, w.bDmg[s]! - HEAL_STEP);
    sim.dirty.buildings.add(s);
  }
}
