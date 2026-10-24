import { BFLAG, RCI_BASE, SVC } from '../catalog.ts';
import { BMAX, MAP, TILES, ZONE, type World } from '../layers.ts';
import { UNREACHED, lotAccess, roadFlow, roadsOf } from '../roads/index.ts';
import { footprintMean, isOperating, occupancyOf, zoneOfArch } from '../economy/totals.ts';
import { markDirty, type Sim } from '../world.ts';
import type { ServiceKindStats, ServiceStats } from '../protocol.ts';
import {
  COV_HALO, CRIME_ABANDONED, CRIME_DENSITY, CRIME_POOR_W, CRIME_POLICE_W, FIRE_FLAMMABLE, ONE, falloff, serviceCapacity, serviceKind, serviceRadius, works,
} from './tables.ts';

// Road coverage. Fire, police, health and education reach along the road network, not through the air: every working service
// building spreads its coverage from its access road with roadFlow, up to its radius in road tiles, falling off with distance.
// A service can only serve `capacity` people. Each operating building (the demand point) splits its occupants between the services
// that reach it in proportion to their coverage there; a service loaded past its capacity covers only capacity / load of full strength.
// The pass writes one coverage layer, 0..255, and the stats the Services panel shows. A lot takes the coverage of the roads within
// COV_HALO tiles, so a building is covered exactly when a road it can reach is.

const val = new Uint8Array(TILES);
const mid = new Uint8Array(TILES);
const next = new Uint8Array(TILES);
const pool: Uint16Array[] = [];
const dAcc = new Int32Array(BMAX);
const dOcc = new Int32Array(BMAX);
const dSum = new Int32Array(BMAX);

interface Svc { access: number; radius: number; capacity: number; load: number }

export const emptyKindStats = (): ServiceKindStats => ({ buildings: 0, working: 0, capacity: 0, population: 0, served: 0, pct: 0 });
export const emptyServiceStats = (): ServiceStats => ({
  fire: emptyKindStats(), police: emptyKindStats(), health: emptyKindStats(), edu: emptyKindStats(), parks: 0, repairBays: 0, crimeIndex: 0, fireRisk: 0,
});
export const servicesOf = (sim: Sim): ServiceStats => (sim.services ??= emptyServiceStats());

/** Coverage layer written by each service kind. */
export function coverageLayer(w: World, kind: number): Uint8Array {
  switch (kind) {
    case SVC.FIRE: return w.covFire;
    case SVC.POLICE: return w.covPolice;
    case SVC.HEALTH: return w.covHealth;
    case SVC.EDU: return w.covEdu;
    case SVC.PARK: return w.covPark;
    default: return w.covRepair;
  }
}

/** Max of a tile layer under a building's footprint. */
export function footprintMax(w: World, layer: Uint8Array, slot: number): number {
  const bw = w.bW[slot]!, bh = w.bH[slot]!, x0 = w.bX[slot]!, y0 = w.bY[slot]!;
  let m = 0;
  for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) { const v = layer[y * MAP + x]!; if (v > m) m = v; }
  return m;
}

/** Copy `src` into `layer`, dirtying the overlay chunk of every tile that changed. */
function commit(sim: Sim, layer: Uint8Array, src: Uint8Array): void {
  for (let i = 0; i < TILES; i++) if (layer[i] !== src[i]) { layer[i] = src[i]!; markDirty(sim, 'overlay', i % MAP, (i / MAP) | 0); }
}

/** Max over the (2 * COV_HALO + 1) square around each tile, as two separable passes. */
function halo(src: Uint8Array, dst: Uint8Array): void {
  for (let y = 0; y < MAP; y++) {
    const row = y * MAP;
    for (let x = 0; x < MAP; x++) {
      let m = 0;
      const a = x < COV_HALO ? 0 : x - COV_HALO, b = x > MAP - 1 - COV_HALO ? MAP - 1 : x + COV_HALO;
      for (let k = a; k <= b; k++) { const v = src[row + k]!; if (v > m) m = v; }
      mid[row + x] = m;
    }
  }
  for (let y = 0; y < MAP; y++) {
    const a = y < COV_HALO ? 0 : y - COV_HALO, b = y > MAP - 1 - COV_HALO ? MAP - 1 : y + COV_HALO;
    for (let x = 0; x < MAP; x++) {
      let m = 0;
      for (let k = a; k <= b; k++) { const v = mid[k * MAP + x]!; if (v > m) m = v; }
      dst[y * MAP + x] = m;
    }
  }
}

const kindStatsOf = (st: ServiceStats, kind: number): ServiceKindStats =>
  kind === SVC.FIRE ? st.fire : kind === SVC.POLICE ? st.police : kind === SVC.HEALTH ? st.health : st.edu;

/**
 * One coverage pass for a road kind (SVC.FIRE, POLICE, HEALTH or EDU). Fire and police serve every operating building by its
 * occupants (residents or jobs); health and education serve residents only.
 */
export function coveragePass(sim: Sim, kind: number): void {
  const w = sim.world, net = roadsOf(sim), stats = kindStatsOf(servicesOf(sim), kind);
  const residentsOnly = kind === SVC.HEALTH || kind === SVC.EDU;
  const svcs: Svc[] = [];
  let buildings = 0, working = 0, capacity = 0;
  for (let s = 0; s < BMAX; s++) {
    const arch = w.bArch[s]!;
    if (arch === 0 || serviceKind(arch) !== kind) continue;
    buildings++;
    if (!works(w.bFlags[s]!)) continue;
    working++;
    capacity += serviceCapacity(arch);
    const access = lotAccess(net, w.bX[s]!, w.bY[s]!, w.bW[s]!, w.bH[s]!);
    if (access >= 0) svcs.push({ access, radius: serviceRadius(arch), capacity: serviceCapacity(arch), load: 0 });
  }

  let nd = 0, population = 0;
  for (let s = 0; s < BMAX && svcs.length > 0; s++) {
    const arch = w.bArch[s]!, z = zoneOfArch(arch);
    if (z === 0 || !isOperating(w, s) || (residentsOnly && z !== ZONE.R)) continue;
    dAcc[nd] = lotAccess(net, w.bX[s]!, w.bY[s]!, w.bW[s]!, w.bH[s]!);
    dOcc[nd] = occupancyOf(arch); dSum[nd] = 0;
    population += dOcc[nd]!;
    nd++;
  }
  if (svcs.length === 0) {
    // Nothing to count a population for, but the panel still shows how many people the city has to serve.
    for (let s = 0; s < BMAX; s++) {
      const z = zoneOfArch(w.bArch[s]!);
      if (z !== 0 && isOperating(w, s) && !(residentsOnly && z !== ZONE.R)) population += occupancyOf(w.bArch[s]!);
    }
  }

  val.fill(0);
  const reached: Int32Array[] = [];
  svcs.forEach((sv, j) => {
    const dist = (pool[j] ??= new Uint16Array(TILES));
    reached.push(roadFlow(net, [sv.access], sv.radius, dist).reached);
    for (let h = 0; h < nd; h++) {
      const a = dAcc[h]!;
      if (a >= 0 && dist[a] !== UNREACHED) dSum[h]! += falloff(dist[a]!, sv.radius);
    }
  });
  let served = 0;
  svcs.forEach((sv, j) => {
    const dist = pool[j]!;
    for (let h = 0; h < nd; h++) {
      const a = dAcc[h]!;
      if (a >= 0 && dist[a] !== UNREACHED && dSum[h]! > 0) sv.load += Math.floor((dOcc[h]! * falloff(dist[a]!, sv.radius)) / dSum[h]!);
    }
    served += Math.min(sv.load, sv.capacity);
    const capQ = sv.load <= sv.capacity ? ONE : Math.floor((sv.capacity * ONE) / sv.load);
    for (const t of reached[j]!) {
      const v = (falloff(dist[t]!, sv.radius) * capQ) >> 10;
      if (v > val[t]!) val[t] = v;
    }
  });

  if (svcs.length === 0) next.fill(0); else halo(val, next);
  commit(sim, coverageLayer(w, kind), next);
  stats.buildings = buildings; stats.working = working; stats.capacity = capacity; stats.population = population; stats.served = served;
  stats.pct = population > 0 ? Math.min(100, Math.floor((served * 100) / population)) : 0;
}

/**
 * Parks and repair bays cover a plain disc: no roads, no capacity. The value is 255 on the building and falls off with the
 * square of the distance from its footprint, reaching 0 just past the radius.
 */
export function discPass(sim: Sim): void {
  const w = sim.world, st = servicesOf(sim);
  for (const kind of [SVC.PARK, SVC.REPAIR]) {
    next.fill(0);
    let count = 0;
    for (let s = 0; s < BMAX; s++) {
      const arch = w.bArch[s]!;
      if (arch === 0 || serviceKind(arch) !== kind || !works(w.bFlags[s]!)) continue;
      count++;
      const r = serviceRadius(arch), r2 = (r + 1) * (r + 1), bx = w.bX[s]!, by = w.bY[s]!, bw = w.bW[s]!, bh = w.bH[s]!;
      for (let y = Math.max(0, by - r); y <= Math.min(MAP - 1, by + bh - 1 + r); y++) {
        const dy = y < by ? by - y : y > by + bh - 1 ? y - (by + bh - 1) : 0;
        for (let x = Math.max(0, bx - r); x <= Math.min(MAP - 1, bx + bw - 1 + r); x++) {
          const dx = x < bx ? bx - x : x > bx + bw - 1 ? x - (bx + bw - 1) : 0;
          const d2 = dx * dx + dy * dy;
          if (d2 >= r2) continue;
          const v = Math.floor((255 * (r2 - d2)) / r2);
          if (v > next[y * MAP + x]!) next[y * MAP + x] = v;
        }
      }
    }
    commit(sim, coverageLayer(w, kind), next);
    if (kind === SVC.PARK) st.parks = count; else st.repairBays = count;
  }
}

/** Fire risk of one building, 0..255: the share of its flammability that fire coverage leaves exposed. Zero for non-RCI and sites. */
export function fireRiskOf(w: World, slot: number): number {
  const z = zoneOfArch(w.bArch[slot]!);
  if (z === 0 || (w.bFlags[slot]! & BFLAG.CONSTRUCTING) !== 0) return 0;
  return ((255 - footprintMax(w, w.covFire, slot)) * FIRE_FLAMMABLE[z]!) >> 8;
}

/** Crime of one building, 0..255, from police coverage, land value, density and abandonment. */
export function crimeOf(w: World, slot: number): number {
  const arch = w.bArch[slot]!;
  const z = zoneOfArch(arch);
  if (z === 0 || (w.bFlags[slot]! & BFLAG.CONSTRUCTING) !== 0) return 0;
  const lv = footprintMean(w, w.landValue, slot);
  const base = ((255 - footprintMax(w, w.covPolice, slot)) * CRIME_POLICE_W + (255 - lv) * CRIME_POOR_W) >> 8;
  const density = CRIME_DENSITY[densityOf(arch)]!;
  const c = (base * density) >> 8;
  return Math.min(255, c + ((w.bFlags[slot]! & BFLAG.ABANDONED) !== 0 ? CRIME_ABANDONED : 0));
}

const densityOf = (arch: number): number => Math.floor(((arch - RCI_BASE) % 9) / 3);

/** The crime layer (each finished building paints its footprint and one tile around it) plus the crime and fire-risk indices. */
export function crimePass(sim: Sim): void {
  const w = sim.world, st = servicesOf(sim);
  next.fill(0);
  let weight = 0, crimeSum = 0, fireSum = 0;
  for (let s = 0; s < BMAX; s++) {
    const arch = w.bArch[s]!;
    if (zoneOfArch(arch) === 0 || (w.bFlags[s]! & BFLAG.CONSTRUCTING) !== 0) continue;
    const c = crimeOf(w, s);
    const wt = 1 + (isOperating(w, s) ? occupancyOf(arch) : 0);
    weight += wt; crimeSum += c * wt; fireSum += fireRiskOf(w, s) * wt;
    const bx = w.bX[s]!, by = w.bY[s]!, bw = w.bW[s]!, bh = w.bH[s]!;
    for (let y = Math.max(0, by - 1); y <= Math.min(MAP - 1, by + bh); y++) {
      for (let x = Math.max(0, bx - 1); x <= Math.min(MAP - 1, bx + bw); x++) if (c > next[y * MAP + x]!) next[y * MAP + x] = c;
    }
  }
  commit(sim, w.crime, next);
  st.crimeIndex = weight > 0 ? Math.floor((crimeSum * 100) / (255 * weight)) : 0;
  st.fireRisk = weight > 0 ? Math.floor((fireSum * 100) / (255 * weight)) : 0;
}
