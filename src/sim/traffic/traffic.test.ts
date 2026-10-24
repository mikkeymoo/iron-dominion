import { afterEach, describe, expect, it, vi } from 'vitest';
import { packAgents, restore, snapshot, stateHash, step } from '../engine.ts';
import { landValueAt, pollutionPass } from '../economy/index.ts';
import { AMAX, MAP, PATH_CAP, REGISTRY, RMAX, ROAD, S, SPEC, TILES, VMAX, ZONE } from '../layers.ts';
import { findPath, pathTiles, roadsOf } from '../roads/index.ts';
import { AKIND } from '../robots/index.ts';
import { SYSTEMS } from '../tick.ts';
import { runTicks } from '../testkit.ts';
import {
  CAPACITY, CFAIL_CYCLE, COMMUTE_WINDOW, FREE_Q, HALF_WIDTH, HOURLY, LANES, MAX_LOAD, PURPOSE, SPEED_Q, VEHICLE_BUDGET, VKIND, VST, laneOffset, loadHeat, poseAlong,
  speedFactor, trafficRamp, trafficStats, updateVehicles, spawnVehicle, rebuildOccupancy, type Pose,
} from './index.ts';
import {
  flatSim, grow, gridCity, injectVehicles, occupancyProblem, road, routeOf, routePool, run, tileUnder, vehicles,
} from './testkit.ts';

vi.setConfig({ testTimeout: 120000 });
afterEach(() => new Promise<void>((r) => { setTimeout(r, 0); }));

const tile = (x: number, y: number): number => y * MAP + x;
const maxOf = (a: ArrayLike<number>): number => { let m = -Infinity; for (let i = 0; i < a.length; i++) if (a[i]! > m) m = a[i]!; return m; };
const sc = (sim: ReturnType<typeof flatSim>) => sim.world.scalars;
/** Trips begun so far: finished, failed, and still driving. */
const begun = (sim: ReturnType<typeof flatSim>): number => sc(sim)[S.tripsDone]! + sc(sim)[S.tripsFailed]! + sc(sim)[S.vehicles]!;

describe('layers', () => {
  it('registers the traffic layers with the right shapes and the vehicle pool beside the robot pool', () => {
    const by = new Map<string, (typeof REGISTRY)[number]>(REGISTRY.map((l) => [l.name, l]));
    expect(by.get('traffic')).toMatchObject({ length: TILES, render: true, dirty: 'overlay' });
    expect(by.get('cFail')).toMatchObject({ length: TILES, render: false });
    expect(by.get('tLoad')).toMatchObject({ length: TILES * 4, render: false });
    expect(by.get('tLane')).toMatchObject({ length: TILES * 4, render: false });
    expect(by.get('vPath')).toMatchObject({ length: VMAX * PATH_CAP });
    expect(by.get('vLen')!.length).toBe(VMAX);
    expect(by.get('vDeadline')!.length).toBe(VMAX);
    expect(AMAX).toBe(RMAX + VMAX);
    expect(VEHICLE_BUDGET).toBeLessThanOrEqual(VMAX);
    expect(SPEC.scalars.length).toBeGreaterThan(S.occEpoch);
    expect(PATH_CAP).toBeLessThanOrEqual(255);
  });

  it('keeps every vehicle kind apart from the robot kinds', () => {
    expect(Math.min(VKIND.CAR, VKIND.TAXI, VKIND.TRUCK, VKIND.BUS)).toBeGreaterThan(AKIND.HAULER);
    expect(new Set([VKIND.CAR, VKIND.TAXI, VKIND.TRUCK, VKIND.BUS]).size).toBe(4);
    expect(VST.DRIVE).not.toBe(5);
    expect(VST.SLOW).not.toBe(5);
  });
});

describe('trip generation', () => {
  it('shares each purpose out over the day: every hourly row sums to 1 and peaks where commuters do', () => {
    for (const row of Object.values(HOURLY)) expect(row.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    const peak = (row: readonly number[]): number => row.indexOf(Math.max(...row));
    expect(peak(HOURLY.out)).toBe(8);
    expect(peak(HOURLY.back)).toBe(17);
    expect([12, 13]).toContain(peak(HOURLY.shop));
  });

  it('is proportional to the city: twice the buildings start about twice the trips', () => {
    const at = (sim: ReturnType<typeof flatSim>, tickOfDay: number): void => { sc(sim)[S.tickOfDay] = tickOfDay; sc(sim)[S.dayFrac] = tickOfDay / 4800; };
    const small = gridCity({ cols: 4, rows: 4 }), large = gridCity({ cols: 8, rows: 4 });
    at(small, 1400); at(large, 1400);
    runTicks(small, 800); runTicks(large, 800);
    const a = begun(small), b = begun(large);
    expect(a).toBeGreaterThan(60);
    expect(b / a).toBeGreaterThan(1.7);
    expect(b / a).toBeLessThan(2.3);
    console.log(`traffic: trips over the morning peak, ${sc(small)[S.population]} residents -> ${a}, ${sc(large)[S.population]} residents -> ${b}`);
  });

  it('follows the clock: the morning peak starts many times more trips than the small hours', () => {
    const night = gridCity({ cols: 6, rows: 6 }), peak = gridCity({ cols: 6, rows: 6 });
    sc(night)[S.tickOfDay] = 400; sc(night)[S.dayFrac] = 400 / 4800;
    sc(peak)[S.tickOfDay] = 1500; sc(peak)[S.dayFrac] = 1500 / 4800;
    runTicks(night, 200); runTicks(peak, 200);
    expect(begun(peak)).toBeGreaterThan(begun(night) * 4);
    expect(begun(night)).toBeGreaterThanOrEqual(0);
  });

  it('is deterministic: the same city gives the same hash and trip counts, another seed does not', () => {
    const a = gridCity({ cols: 6, rows: 6 }, flatSim(42)), b = gridCity({ cols: 6, rows: 6 }, flatSim(42)), c = gridCity({ cols: 6, rows: 6 }, flatSim(7));
    runTicks(a, 600); runTicks(b, 600); runTicks(c, 600);
    expect(stateHash(a)).toBe(stateHash(b));
    expect(trafficStats(a.world)).toEqual(trafficStats(b.world));
    expect(stateHash(c)).not.toBe(stateHash(a));
    expect(vehicles(a).length).toBeGreaterThan(0);
  });

  it('never exceeds the simulation budget', () => {
    const sim = gridCity({ cols: 30, rows: 30, density: 2, level: 3 });
    let most = 0;
    for (let t = 0; t < 700; t++) { step(sim); most = Math.max(most, sc(sim)[S.vehicles]!); }
    expect(most).toBeGreaterThan(300);
    expect(most).toBeLessThanOrEqual(VEHICLE_BUDGET);
  });

  it('sends commuters between homes and jobs and trucks from industry to shops', () => {
    const sim = gridCity({ cols: 6, rows: 6 });
    sc(sim)[S.tickOfDay] = 1400; sc(sim)[S.dayFrac] = 1400 / 4800;
    const seen = new Set<number>();
    const purposes = new Set<number>();
    for (let t = 0; t < 1400; t++) {
      step(sim);
      for (const a of vehicles(sim)) { seen.add(sim.world.aKind[a]!); purposes.add(sim.world.aCarry[a]! >> 2); }
    }
    expect(seen.has(VKIND.CAR)).toBe(true);
    expect(seen.has(VKIND.TAXI)).toBe(true);
    expect(seen.has(VKIND.TRUCK)).toBe(true);
    expect([...purposes].sort()).toEqual([PURPOSE.OUT, PURPOSE.BACK, PURPOSE.SHOP, PURPOSE.FREIGHT]);
  });
});

describe('vehicles on the road', () => {
  it('stay over road tiles every tick, on both sides of every street', () => {
    const sim = gridCity({ cols: 6, rows: 6 });
    let checked = 0;
    for (let t = 0; t < 1200; t++) {
      step(sim);
      for (const a of vehicles(sim)) {
        const under = tileUnder(sim, a);
        expect(under, `vehicle ${a} at tick ${t}`).toBeGreaterThanOrEqual(0);
        expect(sim.world.road[under]! & ROAD.CLASS_MASK, `vehicle ${a} at ${sim.world.aX[a]}, ${sim.world.aY[a]}`).not.toBe(0);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  it('drive on the right: opposite directions use opposite sides of the street', () => {
    const sim = flatSim();
    road(sim, 100, 100, 120, 100);
    const net = roadsOf(sim);
    const east = pathTiles(net, findPath(net, tile(100, 100), tile(120, 100))!)!, west = pathTiles(net, findPath(net, tile(120, 100), tile(100, 100))!)!;
    expect(spawnVehicle(sim.world, VKIND.CAR, PURPOSE.SHOP, 0, 0, east, east.length, 0)).toBe('ok');
    expect(spawnVehicle(sim.world, VKIND.CAR, PURPOSE.SHOP, 0, 0, west, west.length, 0)).toBe('ok');
    runTicks(sim, 20);
    const [e, w] = vehicles(sim);
    // Heading east the right-hand side is south (+y); heading west it is north (-y).
    expect(sim.world.aY[e!]! - 100.5).toBeGreaterThan(0.05);
    expect(sim.world.aY[w!]! - 100.5).toBeLessThan(-0.05);
    expect(Math.abs(sim.world.aHead[e!]! - Math.PI / 2)).toBeLessThan(0.05);
    expect(Math.abs(Math.abs(sim.world.aHead[w!]!) - Math.PI / 2)).toBeLessThan(0.05);
  });

  it('are packed for the render with a kind that is not a robot', () => {
    const sim = gridCity({ cols: 6, rows: 6 });
    runTicks(sim, 600);
    const pos = new Float32Array(AMAX * 3), ids = new Uint32Array(AMAX * 2);
    const n = packAgents(sim, pos, ids);
    expect(n).toBe(vehicles(sim).length);
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      const kind = ids[i * 2 + 1]! & 0xff, state = (ids[i * 2 + 1]! >> 8) & 0xff;
      expect(kind).toBeGreaterThan(AKIND.HAULER);
      expect([VST.DRIVE, VST.SLOW]).toContain(state);
      expect(ids[i * 2]! & 0xffff).toBeGreaterThanOrEqual(RMAX);
    }
    const view = { x0: 0, y0: 0, x1: 1, y1: 1 };
    expect(packAgents(sim, pos, ids, view)).toBe(0);
  });

  it('keep a slot and generation: a slot reused after a trip carries a new generation', () => {
    const sim = flatSim();
    road(sim, 100, 100, 110, 100);
    const net = roadsOf(sim);
    const t = pathTiles(net, findPath(net, tile(100, 100), tile(110, 100))!)!;
    spawnVehicle(sim.world, VKIND.CAR, PURPOSE.SHOP, 0, 0, t, t.length, 0);
    const [a] = vehicles(sim);
    const gen = sim.world.aGen[a!]!;
    runTicks(sim, 200);
    expect(vehicles(sim)).toHaveLength(0);
    expect(sim.world.aGen[a!]).toBe((gen + 1) & 0xffff);
    spawnVehicle(sim.world, VKIND.CAR, PURPOSE.SHOP, 0, 0, t, t.length, 0);
    expect(vehicles(sim)[0]).toBe(a);
    expect(sim.world.aGen[a!]).toBe((gen + 1) & 0xffff);
  });
});

describe('congestion', () => {
  it('lowers speed monotonically with load on every road class', () => {
    for (let cls = 1; cls <= 3; cls++) {
      let prev = Infinity;
      for (let load = 0; load <= CAPACITY[cls]!; load++) {
        const f = speedFactor(load, cls);
        expect(f, `class ${cls} load ${load}`).toBeLessThan(prev);
        prev = f;
      }
      expect(speedFactor(0, cls)).toBe(1);
      expect(speedFactor(CAPACITY[cls]!, cls)).toBeLessThan(0.35);
      expect(speedFactor(1, cls)).toBeGreaterThan(0.9);
    }
    for (const kind of [VKIND.CAR, VKIND.TAXI, VKIND.TRUCK, VKIND.BUS]) {
      for (let cls = 1; cls <= 3; cls++) {
        let prev = Infinity;
        for (let load = 1; load <= MAX_LOAD; load++) {
          const q = SPEED_Q[(kind * 8 + cls) * (MAX_LOAD + 1) + load]!;
          expect(q).toBeLessThanOrEqual(prev);
          expect(q).toBeGreaterThan(0);
          prev = q;
        }
        expect(SPEED_Q[(kind * 8 + cls) * (MAX_LOAD + 1) + 1]!).toBeLessThanOrEqual(FREE_Q[kind * 8 + cls]!);
      }
    }
    expect(FREE_Q[VKIND.CAR * 8 + 3]!).toBeGreaterThan(FREE_Q[VKIND.CAR * 8 + 2]!);
    expect(FREE_Q[VKIND.CAR * 8 + 2]!).toBeGreaterThan(FREE_Q[VKIND.CAR * 8 + 1]!);
    expect(FREE_Q[VKIND.TRUCK * 8 + 1]!).toBeLessThan(FREE_Q[VKIND.CAR * 8 + 1]!);
  });

  it('slows a real vehicle as the load on its tile-direction rises', () => {
    const advance = (load: number): number => {
      const sim = flatSim();
      road(sim, 100, 100, 130, 100);
      const net = roadsOf(sim);
      const t = pathTiles(net, findPath(net, tile(100, 100), tile(130, 100))!)!;
      spawnVehicle(sim.world, VKIND.CAR, PURPOSE.SHOP, 0, 0, t, t.length, 0);
      const [a] = vehicles(sim);
      const before = sim.world.aStep[a!]! * 1024 + sim.world.aFrac[a!]! * 1024;
      sim.world.tLoad[tile(100, 100) * 4 + 1] = load;
      updateVehicles(net, sim.world, { moved: 0, free: 0, active: 0 });
      return sim.world.aStep[a!]! * 1024 + sim.world.aFrac[a!]! * 1024 - before;
    };
    const moves = [1, 2, 3].map(advance);
    expect(moves[0]!).toBeGreaterThan(moves[1]!);
    expect(moves[1]!).toBeGreaterThan(moves[2]!);
    expect(moves[2]!).toBeGreaterThan(0);
  });

  it('builds a queue on a saturated street and reports it as congestion', () => {
    const sim = flatSim();
    road(sim, 100, 100, 160, 100);
    const net = roadsOf(sim);
    const t = pathTiles(net, findPath(net, tile(100, 100), tile(160, 100))!)!;
    let peakLoad = 0, slow = 0;
    for (let k = 0; k < 400; k++) {
      spawnVehicle(sim.world, VKIND.CAR, PURPOSE.SHOP, 0, 0, t, t.length, 0);
      spawnVehicle(sim.world, VKIND.CAR, PURPOSE.SHOP, 0, 0, t, t.length, 0);
      step(sim);
      for (let i = 0; i < sim.world.tLoad.length; i++) peakLoad = Math.max(peakLoad, sim.world.tLoad[i]!);
      slow = Math.max(slow, vehicles(sim).filter((a) => sim.world.aState[a] === VST.SLOW).length);
    }
    expect(peakLoad).toBeGreaterThanOrEqual(CAPACITY[1]!);
    expect(slow).toBeGreaterThan(0);
    expect(sc(sim)[S.congestion]!).toBeGreaterThan(0.05);
    expect(sc(sim)[S.congestion]!).toBeLessThanOrEqual(1);
  });

  it('never puts two vehicles in one lane slot and keeps tLoad equal to the vehicles, mixing cars and trucks on one lane', () => {
    const sim = flatSim();
    road(sim, 100, 100, 150, 100);
    const net = roadsOf(sim);
    const t = pathTiles(net, findPath(net, tile(100, 100), tile(150, 100))!)!;
    let maxAlive = 0, placed = 0;
    for (let k = 0; k < 300; k++) {
      if (spawnVehicle(sim.world, k % 5 === 0 ? VKIND.TRUCK : VKIND.CAR, PURPOSE.SHOP, 0, 0, t, t.length, 0) === 'ok') placed++;
      step(sim);
      expect(occupancyProblem(sim), `tick ${k}`).toBeNull();
      maxAlive = Math.max(maxAlive, vehicles(sim).length);
    }
    expect(placed).toBeGreaterThan(50);
    expect(maxAlive).toBeGreaterThan(10);
  });

  it('keeps a following vehicle behind its leader: no overtaking within a lane', () => {
    const sim = flatSim();
    road(sim, 100, 100, 150, 100);
    const net = roadsOf(sim);
    const t = pathTiles(net, findPath(net, tile(100, 100), tile(150, 100))!)!;
    // Identify a vehicle by (slot, generation): a slot is reused once its trip ends.
    const ids: { a: number; gen: number }[] = [];
    for (let k = 0; k < 250; k++) {
      const before = new Set(vehicles(sim));
      if (spawnVehicle(sim.world, k % 4 === 0 ? VKIND.TRUCK : VKIND.CAR, PURPOSE.SHOP, 0, 0, t, t.length, 0) === 'ok') {
        const a = vehicles(sim).find((v) => !before.has(v))!;
        ids.push({ a, gen: sim.world.aGen[a]! });
      }
      step(sim);
      const live = ids.filter((i) => sim.world.aKind[i.a] !== 0 && sim.world.aGen[i.a] === i.gen);
      const progress = live.map((i) => sim.world.aStep[i.a]! * 1024 + sim.world.aFrac[i.a]! * 1024);
      for (let i = 1; i < progress.length; i++) expect(progress[i]!, `tick ${k}: vehicle ${live[i]!.a} passed ${live[i - 1]!.a}`).toBeLessThan(progress[i - 1]!);
    }
    expect(ids.length).toBeGreaterThan(40);
  });

  it('holds 4,000 vehicles on a dense street grid without breaking lane occupancy', () => {
    const sim = gridCity({ cols: 30, rows: 30, density: 2, level: 3 });
    const pool = routePool(sim, 200, 30, 150);
    let salt = 1;
    for (let t = 0; t < 500; t++) {
      step(sim);
      const n = vehicles(sim).length;
      if (n < 4000) injectVehicles(sim, pool, Math.min(30, 4000 - n), salt++);
      if (t % 25 === 0) expect(occupancyProblem(sim), `tick ${t}`).toBeNull();
    }
    expect(vehicles(sim).length).toBeGreaterThan(3500);
    expect(occupancyProblem(sim)).toBeNull();
  });
});

describe('road changes', () => {
  const ring = (): ReturnType<typeof flatSim> => {
    const sim = flatSim();
    road(sim, 100, 100, 124, 100); road(sim, 124, 100, 124, 106); road(sim, 124, 106, 100, 106); road(sim, 100, 106, 100, 100);
    return sim;
  };

  it('replans around a cut road and still arrives', () => {
    const sim = ring();
    const net = roadsOf(sim);
    const route = pathTiles(net, findPath(net, tile(100, 103), tile(124, 103))!)!;
    expect(spawnVehicle(sim.world, VKIND.CAR, PURPOSE.OUT, 0, 0, route, route.length, 0)).toBe('ok');
    const [a] = vehicles(sim);
    runTicks(sim, 8);
    const cutAt = route[Math.floor(route.length * 0.6)]!;
    const before = routeOf(sim, a!);
    expect(before).toContain(cutAt);
    expect(run(sim, { type: 'bulldoze', x0: cutAt % MAP, y0: Math.floor(cutAt / MAP), x1: cutAt % MAP, y1: Math.floor(cutAt / MAP) })).toBe(true);
    step(sim);
    expect(vehicles(sim)).toEqual([a]);
    const after = routeOf(sim, a!);
    expect(after).not.toContain(cutAt);
    expect(after[after.length - 1]).toBe(tile(124, 103));
    expect(occupancyProblem(sim)).toBeNull();
    for (let t = 0; t < 400 && vehicles(sim).length > 0; t++) {
      step(sim);
      const under = tileUnder(sim, vehicles(sim)[0] ?? a!);
      if (vehicles(sim).length > 0) expect(sim.world.road[under]! & ROAD.CLASS_MASK).not.toBe(0);
    }
    expect(vehicles(sim)).toHaveLength(0);
    expect(sc(sim)[S.tripsDone]).toBe(1);
    expect(sc(sim)[S.tripsFailed]).toBe(0);
  });

  it('fails the trip when the cut leaves no way to the goal, and counts it as a failed commute', () => {
    const sim = flatSim();
    road(sim, 100, 100, 130, 100);
    const net = roadsOf(sim);
    const route = pathTiles(net, findPath(net, tile(100, 100), tile(130, 100))!)!;
    expect(spawnVehicle(sim.world, VKIND.CAR, PURPOSE.OUT, 0, 0, route, route.length, 0)).toBe('ok');
    runTicks(sim, 10);
    expect(run(sim, { type: 'bulldoze', x0: 115, y0: 100, x1: 115, y1: 100 })).toBe(true);
    step(sim);
    expect(vehicles(sim)).toHaveLength(0);
    expect(sc(sim)[S.tripsFailed]).toBe(1);
    expect(sc(sim)[S.commuteFailed]).toBe(1);
    expect(sc(sim)[S.tripsDone]).toBe(0);
    expect(occupancyProblem(sim)).toBeNull();
    expect(Array.from(sim.world.tLane).every((v) => v === 0)).toBe(true);
    expect(Array.from(sim.world.tLoad).every((v) => v === 0)).toBe(true);
  });

  it('removes a vehicle whose own tile is bulldozed in the same tick, so none is ever left off the road', () => {
    const sim = flatSim();
    road(sim, 100, 100, 130, 100);
    const net = roadsOf(sim);
    const route = pathTiles(net, findPath(net, tile(100, 100), tile(130, 100))!)!;
    spawnVehicle(sim.world, VKIND.CAR, PURPOSE.SHOP, 0, 0, route, route.length, 0);
    runTicks(sim, 30);
    const [a] = vehicles(sim);
    const under = tileUnder(sim, a!);
    run(sim, { type: 'bulldoze', x0: under % MAP, y0: Math.floor(under / MAP), x1: under % MAP, y1: Math.floor(under / MAP) });
    step(sim);
    for (const v of vehicles(sim)) expect(sim.world.road[tileUnder(sim, v)]! & ROAD.CLASS_MASK).not.toBe(0);
    expect(sc(sim)[S.tripsFailed]).toBe(1);
  });

  it('keeps the trip going when a road is added elsewhere (a new epoch is not a replan)', () => {
    const sim = ring();
    const net = roadsOf(sim);
    const route = pathTiles(net, findPath(net, tile(100, 103), tile(124, 103))!)!;
    spawnVehicle(sim.world, VKIND.CAR, PURPOSE.SHOP, 0, 0, route, route.length, 0);
    const [a] = vehicles(sim);
    runTicks(sim, 5);
    road(sim, 140, 140, 150, 140);
    step(sim);
    expect(routeOf(sim, a!)).toEqual(Array.from(route));
    expect(sim.world.aEpoch[a!]).toBe(sc(sim)[S.graphEpoch]);
  });
});

describe('failed commutes and the economy', () => {
  /** Six homes on one street and six shops on another, with or without a road between them. The clock starts in the morning rush. */
  const split = (linked: boolean): ReturnType<typeof flatSim> => {
    const sim = flatSim();
    road(sim, 100, 100, 124, 100);
    road(sim, 100, 140, 124, 140);
    if (linked) road(sim, 100, 100, 100, 140);
    for (let k = 0; k < 6; k++) { grow(sim, 102 + 4 * k, 98, ZONE.R, 1, 2); grow(sim, 102 + 4 * k, 141, ZONE.C, 1, 2); }
    sc(sim)[S.tickOfDay] = 1400; sc(sim)[S.dayFrac] = 1400 / 4800;
    return sim;
  };

  it('counts a commute with no route as failed, and a connected city as fine', () => {
    const cut = split(false), linked = split(true);
    runTicks(cut, 700); runTicks(linked, 700);
    const bad = trafficStats(cut.world), good = trafficStats(linked.world);
    expect(bad.failedPct).toBeGreaterThan(50);
    expect(sc(cut)[S.tripsDone]).toBe(0);
    expect(bad.failedTrips).toBeGreaterThan(10);
    expect(good.failedPct).toBe(0);
    expect(good.trips).toBeGreaterThan(10);
    expect(vehicles(cut)).toHaveLength(0);
  });

  it('lowers land value around the homes whose commutes fail, and not in the connected city', () => {
    const cut = split(false), linked = split(true);
    runTicks(cut, 700); runTicks(linked, 700);
    const home = tile(103, 99);
    expect(cut.world.cFail[home]!).toBeGreaterThan(8);
    expect(linked.world.cFail[home]).toBe(0);
    const x = 103, y = 99;
    const withMemory = landValueAt(cut.world, x, y);
    const remembered = cut.world.cFail.slice();
    cut.world.cFail.fill(0);
    const without = landValueAt(cut.world, x, y);
    cut.world.cFail.set(remembered);
    expect(without - withMemory).toBe(remembered[home]! >> 2);
    expect(withMemory).toBeLessThan(without);
    expect(landValueAt(linked.world, x, y)).toBe(landValueAt(cut.world, x, y) + (cut.world.cFail[home]! >> 2));
  });

  it('forgets: the failure memory fades by one per CFAIL_CYCLE ticks once commutes work again', () => {
    const sim = split(false);
    runTicks(sim, 700);
    const peak = maxOf(sim.world.cFail);
    expect(peak).toBeGreaterThan(16);
    road(sim, 100, 100, 100, 140);
    runTicks(sim, 4 * CFAIL_CYCLE);
    expect(maxOf(sim.world.cFail)).toBeLessThanOrEqual(peak - 3);
  });

  it('halves the commute counters every window so the percentage follows the recent past', () => {
    const sim = split(false);
    runTicks(sim, 700);
    const failed = sc(sim)[S.commuteFailed]!;
    expect(failed).toBeGreaterThan(10);
    expect(trafficStats(sim.world).failedPct).toBeGreaterThan(60);
    road(sim, 100, 100, 100, 140);
    runTicks(sim, 4 * COMMUTE_WINDOW);
    expect(sc(sim)[S.commuteFailed]!).toBeLessThan(failed);
    expect(trafficStats(sim.world).failedPct).toBeLessThan(40);
  });

  it('adds pollution on busy roads only', () => {
    const calm = flatSim(), busy = flatSim();
    for (const sim of [calm, busy]) road(sim, 100, 100, 160, 100);
    const net = roadsOf(busy);
    const t = pathTiles(net, findPath(net, tile(100, 100), tile(160, 100))!)!;
    for (let k = 0; k < 150; k++) { spawnVehicle(busy.world, VKIND.TRUCK, PURPOSE.SHOP, 0, 0, t, t.length, 0); spawnVehicle(busy.world, VKIND.CAR, PURPOSE.SHOP, 0, 0, t, t.length, 0); step(busy); step(calm); }
    expect(maxOf(busy.world.tLoad)).toBeGreaterThan(2);
    for (let k = 0; k < 40; k++) { pollutionPass(busy); pollutionPass(calm); }
    expect(maxOf(busy.world.pollution)).toBeGreaterThan(0);
    for (let i = 0; i < TILES; i++) if (busy.world.pollution[i]! > 0) expect(Math.abs((i >> 8) - 100)).toBeLessThanOrEqual(8);
    expect(maxOf(calm.world.pollution)).toBe(0);
  });
});

describe('traffic overlay and stats', () => {
  it('fills the traffic layer along busy roads, marks it dirty, and fades it when the road empties', () => {
    const sim = flatSim();
    road(sim, 100, 100, 160, 100);
    const net = roadsOf(sim);
    const t = pathTiles(net, findPath(net, tile(100, 100), tile(160, 100))!)!;
    for (let k = 0; k < 120; k++) { spawnVehicle(sim.world, VKIND.CAR, PURPOSE.SHOP, 0, 0, t, t.length, 0); step(sim); }
    const lit = Array.from(sim.world.traffic).filter((v) => v > 0).length;
    expect(lit).toBeGreaterThan(10);
    for (let i = 0; i < TILES; i++) if (sim.world.traffic[i]! > 0) expect(sim.world.road[i]! & ROAD.CLASS_MASK).not.toBe(0);
    expect(sim.dirty.overlay.size).toBeGreaterThan(0);
    runTicks(sim, 1500);
    expect(vehicles(sim)).toHaveLength(0);
    expect(Array.from(sim.world.traffic).every((v) => v === 0)).toBe(true);
  });

  it('colours the overlay from clear through amber to red', () => {
    expect(trafficRamp(0)[3]).toBe(0);
    const low = trafficRamp(30), mid = trafficRamp(128), high = trafficRamp(255);
    expect(low[1]).toBeGreaterThan(low[0]);
    expect(high[0]).toBeGreaterThan(high[1]);
    expect(mid[0]).toBeGreaterThan(150);
    expect(mid[1]).toBeGreaterThan(150);
    expect(high[3]).toBeGreaterThan(low[3]);
  });

  it('reports loadHeat as the busiest direction against lane capacity', () => {
    const sim = flatSim();
    expect(run(sim, { type: 'debugTier', tier: 2 })).toBe(true);
    road(sim, 100, 100, 110, 100, 2);
    const i = tile(105, 100);
    sim.world.tLoad[i * 4 + 1] = 3;
    sim.world.tLoad[i * 4 + 3] = 1;
    expect(loadHeat(sim.world, i)).toBe(Math.floor((3 * 255) / CAPACITY[2]!));
    sim.world.tLoad[i * 4 + 1] = 0;
    sim.world.tLoad[i * 4 + 3] = 0;
    expect(loadHeat(sim.world, i)).toBe(0);
  });

  it('defines vehicles, congestion and the failed-commute percentage in the stats', () => {
    const sim = gridCity({ cols: 6, rows: 6 });
    runTicks(sim, 800);
    const s = trafficStats(sim.world);
    expect(s.vehicles).toBe(vehicles(sim).length);
    expect(s.vehicles).toBeGreaterThan(0);
    expect(Number.isFinite(s.congestion)).toBe(true);
    expect(s.congestion).toBeGreaterThanOrEqual(0);
    expect(s.congestion).toBeLessThanOrEqual(1);
    expect(s.failedPct).toBeGreaterThanOrEqual(0);
    expect(s.failedPct).toBeLessThanOrEqual(100);
    expect(s.trips).toBeGreaterThan(0);
  });
});

describe('pose', () => {
  const pose: Pose = { x: 0, y: 0, heading: 0 };
  const road1 = (): Uint16Array => { const r = new Uint16Array(TILES); for (const t of [tile(10, 10), tile(11, 10), tile(12, 10), tile(12, 11), tile(12, 12)]) r[t] = 1 | ROAD.N | ROAD.E | ROAD.S | ROAD.W; return r; };
  const route = Uint16Array.of(tile(10, 10), tile(11, 10), tile(12, 10), tile(12, 11), tile(12, 12));

  it('puts a lane to the right of the centre line and inside its tile all along a turn', () => {
    const r = road1();
    for (let pc = 0; pc <= 4; pc += 0.05) {
      poseAlong(r, route, 0, route.length, 0, pc, pose);
      const t = route[Math.min(4, Math.floor(pc + 0.5))]!;
      expect(pose.x).toBeGreaterThanOrEqual((t & 255) - 1e-9);
      expect(pose.x).toBeLessThanOrEqual((t & 255) + 1 + 1e-9);
      expect(pose.y).toBeGreaterThanOrEqual((t >> 8) - 1e-9);
      expect(pose.y).toBeLessThanOrEqual((t >> 8) + 1 + 1e-9);
    }
    poseAlong(r, route, 0, route.length, 0, 1, pose);
    expect(pose.y).toBeGreaterThan(10.5);
    expect(pose.heading).toBeCloseTo(Math.PI / 2, 5);
  });

  it('turns smoothly: heading changes continuously around a corner and ends facing the new way', () => {
    const r = road1();
    let prev = 0;
    for (let pc = 1.4; pc <= 2.6; pc += 0.02) {
      poseAlong(r, route, 0, route.length, 0, pc, pose);
      if (pc > 1.4) expect(Math.abs(pose.heading - prev)).toBeLessThan(0.3);
      prev = pose.heading;
    }
    poseAlong(r, route, 0, route.length, 0, 3, pose);
    expect(pose.heading).toBeCloseTo(0, 5);
    expect(pose.x).toBeLessThan(12.5);
  });

  it('is continuous across tile boundaries', () => {
    const r = road1();
    const a: Pose = { x: 0, y: 0, heading: 0 }, b: Pose = { x: 0, y: 0, heading: 0 };
    for (const edge of [0.5, 1.5, 2.5, 3.5]) {
      poseAlong(r, route, 0, route.length, 1, edge - 1e-6, a);
      poseAlong(r, route, 0, route.length, 1, edge + 1e-6, b);
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1e-4);
    }
  });

  it('spreads lanes across the asphalt of wide roads', () => {
    for (let cls = 1; cls <= 3; cls++) {
      const offsets = Array.from({ length: LANES[cls]! }, (_, l) => laneOffset(cls, l));
      for (const o of offsets) { expect(o).toBeGreaterThan(0); expect(o).toBeLessThan(HALF_WIDTH[cls]!); }
      expect([...offsets].sort((x, y) => x - y)).toEqual(offsets);
    }
  });
});

describe('occupancy rebuild', () => {
  it('reproduces the incremental lane slots and loads exactly', () => {
    const sim = gridCity({ cols: 6, rows: 6 });
    runTicks(sim, 700);
    expect(vehicles(sim).length).toBeGreaterThan(5);
    const lane = sim.world.tLane.slice(), load = sim.world.tLoad.slice();
    rebuildOccupancy(sim.world);
    expect(Array.from(sim.world.tLane)).toEqual(Array.from(lane));
    expect(Array.from(sim.world.tLoad)).toEqual(Array.from(load));
  });
});

describe('snapshots', () => {
  it('resumes mid-traffic: 100 + restore + 100 equals 200 straight', () => {
    const make = (): ReturnType<typeof flatSim> => gridCity({ cols: 6, rows: 6 });
    const straight = make();
    runTicks(straight, 200);
    const first = make();
    runTicks(first, 100);
    expect(vehicles(first).length).toBeGreaterThan(0);
    expect(trafficStats(first.world).trips + vehicles(first).length).toBeGreaterThan(0);
    const resumed = restore(snapshot(first));
    expect(stateHash(resumed)).toBe(stateHash(first));
    runTicks(resumed, 100);
    expect(stateHash(resumed)).toBe(stateHash(straight));
    expect(vehicles(resumed)).toEqual(vehicles(straight));
  });

  it('resumes across a road cut: cut at 60, snapshot at 100, 200 in total', () => {
    const cut = (sim: ReturnType<typeof flatSim>): void => { run(sim, { type: 'bulldoze', x0: 50, y0: 20, x1: 50, y1: 20 }); };
    const make = (): ReturnType<typeof flatSim> => gridCity({ cols: 6, rows: 6, x0: 20, y0: 20 });
    const straight = make();
    runTicks(straight, 60); cut(straight); runTicks(straight, 140);
    const first = make();
    runTicks(first, 60); cut(first); runTicks(first, 40);
    const resumed = restore(snapshot(first));
    runTicks(resumed, 100);
    expect(stateHash(resumed)).toBe(stateHash(straight));
  });

  it('writes the traffic layers into the snapshot and loads them back', () => {
    const sim = gridCity({ cols: 6, rows: 6 });
    runTicks(sim, 300);
    const back = restore(snapshot(sim));
    for (const name of ['tLoad', 'tLane', 'vPath', 'vLen', 'vDeadline', 'traffic', 'cFail'] as const) expect(Array.from(back.world[name])).toEqual(Array.from(sim.world[name]));
    expect(occupancyProblem(back)).toBeNull();
  });
});

describe('perf', () => {
  it('runs 4,000 vehicles in under 3 ms of traffic work per tick (prints)', () => {
    const sim = gridCity({ cols: 30, rows: 30, density: 2, level: 3 });
    const pool = routePool(sim, 300, 30, 150);
    let salt = 1;
    for (let t = 0; t < 700; t++) {
      for (const s of SYSTEMS) s.run(sim);
      const n = vehicles(sim).length;
      if (n < 4000) injectVehicles(sim, pool, Math.min(30, 4000 - n), salt++);
    }
    const N = 200;
    const ms: Record<string, number> = {};
    let alive = 0;
    for (let t = 0; t < N; t++) {
      for (const s of SYSTEMS) { const t0 = performance.now(); s.run(sim); ms[s.name] = (ms[s.name] ?? 0) + performance.now() - t0; }
      alive += vehicles(sim).length;
      const n = vehicles(sim).length;
      if (n < 4000) injectVehicles(sim, pool, Math.min(30, 4000 - n), salt++);
    }
    const traffic = ms.traffic! / N, whole = Object.values(ms).reduce((x, y) => x + y, 0) / N;
    console.log(`perf: ${Math.round(alive / N)} vehicles, traffic system ${traffic.toFixed(3)} ms/tick, whole tick ${whole.toFixed(3)} ms`);
    expect(alive / N).toBeGreaterThan(3500);
    // The target is 3 ms; the gate is double so a busy machine does not flake it.
    expect(traffic).toBeLessThan(6);
    expect(occupancyProblem(sim)).toBeNull();
  });
});
