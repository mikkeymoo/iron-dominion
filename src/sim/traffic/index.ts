import { MAP, S, TILES, type World } from '../layers.ts';
import type { TrafficStats } from '../protocol.ts';
import { roadsOf } from '../roads/index.ts';
import { markDirty, type Sim } from '../world.ts';
import { CAPACITY, COMMUTE_WINDOW, OVERLAY_PERIOD, TRIP_PERIOD } from './constants.ts';
import { generateTrips } from './trips.ts';
import { decayCommuteFail, rebuildOccupancy, updateVehicles, type TickFlow } from './vehicles.ts';

export * from './constants.ts';
export { poseAlong, laneOffset, dirOfStep, type Pose } from './pose.ts';
export { generateTrips } from './trips.ts';
export { bumpCommuteFail, laneOf, purposeOf, rebuildOccupancy, recordTrip, routeBase, spawnVehicle, updateVehicles } from './vehicles.ts';

const flow: TickFlow = { moved: 0, free: 0, active: 0 };

/** Heat of one tile for the traffic overlay: the busiest direction's load as a share of its lane capacity, 0..255. */
export function loadHeat(w: World, tile: number): number {
  const cap = CAPACITY[w.road[tile]! & 7]!;
  let m = 0;
  for (let d = 0; d < 4; d++) m = Math.max(m, w.tLoad[tile * 4 + d]!);
  return Math.min(255, Math.floor((m * 255) / cap));
}

/** Move the displayed `traffic` layer half the way toward the current load (at least one step), marking changed chunks. */
function updateOverlay(sim: Sim): void {
  const w = sim.world;
  for (let i = 0; i < TILES; i++) {
    const b = i << 2;
    const busy = (w.tLoad[b]! | w.tLoad[b + 1]! | w.tLoad[b + 2]! | w.tLoad[b + 3]!) !== 0;
    const old = w.traffic[i]!;
    if (!busy && old === 0) continue;
    const target = busy ? loadHeat(w, i) : 0;
    if (target === old) continue;
    const next = target > old ? old + Math.max(1, (target - old) >> 1) : old - Math.max(1, (old - target) >> 1);
    w.traffic[i] = next;
    markDirty(sim, 'overlay', i & (MAP - 1), i >> 8);
  }
}

/**
 * Fixed-order traffic system. Rebuilds lane occupancy from the vehicles when the road graph changed, starts this period's trips, moves every vehicle in slot
 * order, then updates the congestion statistic, the commute counters, the failed-commute memory and the traffic overlay.
 * Economy hooks (see economy/overlays.ts): failed commutes lower land value through cFail, busy tiles add pollution from tLoad.
 */
export function trafficSystem(sim: Sim): void {
  const w = sim.world, sc = w.scalars, tick = sc[S.tick]!;
  const net = roadsOf(sim);
  if (sc[S.occEpoch] !== sc[S.graphEpoch]) {
    if (sc[S.vehicles]! > 0) rebuildOccupancy(w);
    sc[S.occEpoch] = sc[S.graphEpoch]!;
  }
  if (tick % TRIP_PERIOD === 0) generateTrips(net, w, sc[S.vehicles]!);
  if (sc[S.vehicles]! > 0 || tick % TRIP_PERIOD === 0) {
    updateVehicles(net, w, flow);
    sc[S.vehicles] = flow.active;
    const cong = flow.free > 0 ? 1 - flow.moved / flow.free : 0;
    sc[S.congestion] = sc[S.congestion]! * 0.9 + cong * 0.1;
  }
  if (tick % COMMUTE_WINDOW === 0) {
    sc[S.commuteOk] = sc[S.commuteOk]! / 2;
    sc[S.commuteFailed] = sc[S.commuteFailed]! / 2;
  }
  decayCommuteFail(w);
  if (tick % OVERLAY_PERIOD === 0) updateOverlay(sim);
}

/** The traffic fields of a Stats message. */
export function trafficStats(w: World): TrafficStats {
  const s = w.scalars, ok = s[S.commuteOk]!, bad = s[S.commuteFailed]!;
  return {
    vehicles: s[S.vehicles]!, congestion: s[S.congestion]!, failedPct: ok + bad > 0 ? Math.round((1000 * bad) / (ok + bad)) / 10 : 0,
    trips: s[S.tripsDone]!, failedTrips: s[S.tripsFailed]!,
  };
}

/** Colour of a traffic overlay cell for a load heat 0..255: transparent where empty, green through amber to red. Returns [r, g, b, a] bytes. */
export function trafficRamp(heat: number): [number, number, number, number] {
  if (heat <= 0) return [0, 0, 0, 0];
  const t = Math.min(1, heat / 255);
  const r = Math.round(255 * Math.min(1, t * 2)), g = Math.round(255 * Math.min(1, 2 - t * 2));
  return [r, g, 40, Math.round(120 + 100 * t)];
}
