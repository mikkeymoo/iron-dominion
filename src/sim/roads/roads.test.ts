import { describe, expect, it } from 'vitest';
import { apply, createSim, drainCommands, restore, snapshot, stateHash, step } from '../engine.ts';
import { MAP, ROAD, S, TILES } from '../layers.ts';
import { findLandWindow, runTicks } from '../testkit.ts';
import { allocWorld } from '../world.ts';
import { RoadNet, clusterOf, ENTRANCE_SPACING } from './graph.ts';
import { UNREACHED, roadFlow } from './flow.ts';
import { lotAccess, nearestRoad } from './access.ts';
import { findPath, isValid, pathTiles, refineNext, replan, tilePathCost } from './path.ts';
import { queryPath, roadsOf } from './index.ts';
import { clearRoads, drawRoads, setRoad, setRoads, tile } from './testkit.ts';

function rngOf(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fresh = () => { const world = allocWorld(); return { world, net: RoadNet.build(world) }; };

describe('graph from synthetic layouts', () => {
  it('straight road: entrances at each border crossing, exact intra costs', () => {
    const { world } = fresh();
    drawRoads(world, ['#'.repeat(40)], 4, 20);
    const net = RoadNet.build(world);
    const c0 = clusterOf(tile(4, 20)), c1 = c0 + 1, c2 = c0 + 2;
    expect(Array.from(net.ent[c0]!)).toEqual([tile(15, 20)]);
    expect(Array.from(net.ent[c1]!)).toEqual([tile(16, 20), tile(31, 20)]);
    expect(Array.from(net.ent[c2]!)).toEqual([tile(32, 20)]);
    expect(net.cost[c1]![1]).toBe(15 * 60);
    expect(net.connected(tile(4, 20), tile(43, 20))).toBe(true);
    expect(net.connected(tile(4, 20), tile(4, 21))).toBe(false);
  });

  it('road class changes cost: highway beats street, bridge and slope add penalty', () => {
    const { world } = fresh();
    drawRoads(world, ['#####', '', 'HHHHH', '', 'bbbbb', '', '^^^^^'], 2, 2);
    const net = RoadNet.build(world);
    const cost = (row: number) => net.tileAStar(tile(2, 2 + 2 * row), tile(6, 2 + 2 * row))!.cost;
    expect(cost(0)).toBe(4 * 60);
    expect(cost(1)).toBe(4 * 24);
    expect(cost(2)).toBe(4 * 72);
    expect(cost(3)).toBe(4 * 90);
  });

  it('grid: all crossings are connected, one component', () => {
    const { world } = fresh();
    const rows: string[] = [];
    for (let y = 0; y < 40; y++) rows.push(y % 5 === 0 ? '#'.repeat(40) : '#    '.repeat(8));
    drawRoads(world, rows, 10, 10);
    const net = RoadNet.build(world);
    expect(net.connected(tile(10, 10), tile(45, 45))).toBe(true);
    expect(net.connected(tile(10, 10), tile(10, 45))).toBe(true);
    const h = findPath(net, tile(10, 10), tile(45, 45))!;
    expect(tilePathCost(net, pathTiles(net, h)!)).toBe(h.cost);
  });

  it('disconnected islands are separate components with no path', () => {
    const { world } = fresh();
    drawRoads(world, ['#######'], 10, 10);
    drawRoads(world, ['#######'], 10, 12);
    drawRoads(world, ['#######'], 100, 100);
    const net = RoadNet.build(world);
    expect(net.connected(tile(10, 10), tile(16, 10))).toBe(true);
    expect(net.connected(tile(10, 10), tile(10, 12))).toBe(false);
    expect(net.connected(tile(10, 10), tile(100, 100))).toBe(false);
    expect(net.connected(tile(10, 10), tile(50, 50))).toBe(false);
    expect(findPath(net, tile(10, 10), tile(100, 100))).toBeNull();
    expect(new Set([net.componentOf(tile(10, 10)), net.componentOf(tile(10, 12)), net.componentOf(tile(100, 100))]).size).toBe(3);
  });

  it('bridge tiles are ordinary graph nodes with a cost penalty', () => {
    const { world } = fresh();
    drawRoads(world, ['###bbbb###'], 20, 30);
    const net = RoadNet.build(world);
    const h = findPath(net, tile(20, 30), tile(29, 30))!;
    expect(pathTiles(net, h)!.length).toBe(10);
    expect(h.cost).toBe(2 * (6 * 30 + 4 * 36) - 60);
  });

  it('dead ends: a spur does not change reachability of the trunk and is reachable itself', () => {
    const { world } = fresh();
    drawRoads(world, ['##########', '    #     ', '    #     ', '    #     '], 14, 40);
    const net = RoadNet.build(world);
    expect(net.connected(tile(14, 40), tile(23, 40))).toBe(true);
    expect(net.connected(tile(18, 43), tile(23, 40))).toBe(true);
    const p = pathTiles(net, findPath(net, tile(18, 43), tile(14, 40))!)!;
    expect(Array.from(p).slice(0, 4)).toEqual([tile(18, 43), tile(18, 42), tile(18, 41), tile(18, 40)]);
  });

  it('long runs of crossings keep every ENTRANCE_SPACING-th tile and the last', () => {
    const { world } = fresh();
    const rows = Array.from({ length: 32 }, () => '#'.repeat(32));
    drawRoads(world, rows, 0, 0);
    const net = RoadNet.build(world);
    const c = 0;
    const east = Array.from(net.ent[c]!).filter((t) => (t & 255) === 15);
    expect(east.map((t) => t >> 8)).toEqual([0, ENTRANCE_SPACING, 2 * ENTRANCE_SPACING, 3 * ENTRANCE_SPACING, 15]);
    expect(net.connected(tile(0, 0), tile(31, 31))).toBe(true);
  });
});

describe('incremental update', () => {
  function randomEdits(world: ReturnType<typeof allocWorld>, rng: () => number, n: number): void {
    for (let k = 0; k < n; k++) {
      const x = 4 + Math.floor(rng() * 90), y = 4 + Math.floor(rng() * 90);
      if (rng() < 0.55) {
        const len = 1 + Math.floor(rng() * 25), horiz = rng() < 0.5, cls = 1 + Math.floor(rng() * 3);
        const tiles: [number, number, number][] = [];
        for (let i = 0; i < len; i++) tiles.push(horiz ? [x + i, y, cls] : [x, y + i, cls]);
        setRoads(world, tiles);
      } else setRoad(world, x, y, 0);
    }
  }

  it('matches a full rebuild after every batch of random edits', () => {
    const rng = rngOf(99);
    const world = allocWorld();
    randomEdits(world, rng, 40);
    const net = RoadNet.build(world);
    for (let round = 0; round < 25; round++) {
      randomEdits(world, rng, 1 + Math.floor(rng() * 6));
      net.sync();
      const a = net.canonicalDump(), b = RoadNet.build(world).canonicalDump();
      const at = a.findIndex((line, i) => line !== b[i]);
      expect(at, `round ${round}: first differing dump line ${at}: ${a[at]?.slice(0, 120)} vs ${b[at]?.slice(0, 120)}`).toBe(-1);
    }
  });

  it('rebuilds only the cluster of an interior edit, and the neighbour too for a border edit', () => {
    const { world, net } = fresh();
    drawRoads(world, ['#'.repeat(60)], 10, 50);
    net.sync();
    expect(net.sync()).toBe(false);
    setRoad(world, 20, 52, 1);
    expect(net.sync()).toBe(true);
    expect(net.lastRebuilt).toEqual([clusterOf(tile(20, 52))]);
    setRoad(world, 31, 55, 1);
    net.sync();
    expect(net.lastRebuilt).toEqual([clusterOf(tile(31, 55)), clusterOf(tile(32, 55))]);
    expect(net.lastRebuilt.length).toBeLessThan(5);
  });

  it('sync with no change is a no-op and bumps nothing', () => {
    const { world, net } = fresh();
    drawRoads(world, ['####'], 10, 10);
    expect(net.sync()).toBe(true);
    expect(net.sync()).toBe(false);
    expect(net.epoch).toBe(1);
  });
});

function randomMap(world: ReturnType<typeof allocWorld>, seed: number): number[] {
  const rng = rngOf(seed);
  clearRoads(world);
  const ox = Math.floor(rng() * 100), oy = Math.floor(rng() * 100);
  const nSeg = 30 + Math.floor(rng() * 50);
  const tiles: [number, number, number, number][] = [];
  for (let k = 0; k < nSeg; k++) {
    const x = ox + Math.floor(rng() * 150), y = oy + Math.floor(rng() * 150);
    const len = 10 + Math.floor(rng() * 90), horiz = rng() < 0.5;
    const r = rng(), cls = r < 0.6 ? 1 : r < 0.85 ? 2 : 3;
    const flag = rng() < 0.08 ? ROAD.SLOPE : rng() < 0.06 ? ROAD.BRIDGE : 0;
    for (let i = 0; i < len; i++) {
      const tx = horiz ? x + i : x, ty = horiz ? y : y + i;
      if (tx < MAP && ty < MAP) tiles.push([tx, ty, cls, flag]);
    }
  }
  setRoads(world, tiles);
  const out: number[] = [];
  for (let i = 0; i < TILES; i++) if (world.road[i]! & ROAD.CLASS_MASK) out.push(i);
  return out;
}

describe('hierarchical path vs tile A* oracle', () => {
  it('exists iff the oracle finds one, cost within 1.25x, tile path legal and equal to the reported cost (200 seeded maps)', () => {
    const world = allocWorld();
    let found = 0, none = 0, worst = 1, sum = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const roads = randomMap(world, seed * 7919);
      const net = RoadNet.build(world);
      const rng = rngOf(seed);
      for (let q = 0; q < 6; q++) {
        const a = roads[Math.floor(rng() * roads.length)]!, b = roads[Math.floor(rng() * roads.length)]!;
        const oracle = net.tileAStar(a, b);
        const h = findPath(net, a, b);
        expect(h !== null, `seed ${seed} q ${q}: hierarchical vs oracle existence`).toBe(oracle !== null);
        expect(net.connected(a, b)).toBe(oracle !== null);
        if (!oracle || !h) { none++; continue; }
        found++;
        const tiles = pathTiles(net, h)!;
        expect(tiles[0]).toBe(a);
        expect(tiles[tiles.length - 1]).toBe(b);
        expect(tilePathCost(net, tiles), `seed ${seed} q ${q}: legal steps`).toBe(h.cost);
        const ratio = oracle.cost === 0 ? 1 : h.cost / oracle.cost;
        expect(h.cost).toBeGreaterThanOrEqual(oracle.cost);
        expect(ratio, `seed ${seed} q ${q}`).toBeLessThanOrEqual(1.25);
        worst = Math.max(worst, ratio); sum += ratio;
      }
    }
    console.log(`oracle: ${found} connected queries, ${none} disconnected, mean ratio ${(sum / found).toFixed(4)}, worst ${worst.toFixed(4)}`);
    expect(found).toBeGreaterThan(300);
    expect(none).toBeGreaterThan(50);
  }, 120000);

  it('refines lazily one cluster segment at a time and the segments concatenate to the full path', () => {
    const { world } = fresh();
    drawRoads(world, ['#'.repeat(100)], 10, 30);
    const net = RoadNet.build(world);
    const h = findPath(net, tile(10, 30), tile(109, 30))!;
    expect(h.cursor).toBe(0);
    const first = refineNext(net, h)!;
    expect(h.cursor).toBe(1);
    expect(first[0]).toBe(tile(10, 30));
    expect(first.length).toBeLessThan(100);
    const all = [...first];
    for (let seg = refineNext(net, h); seg; seg = refineNext(net, h)) all.push(...seg.slice(1));
    expect(all).toEqual(Array.from(pathTiles(net, h)!));
    expect(all).toHaveLength(100);
  });

  it('single-tile and same-cluster queries work, including a route that is shorter by leaving the cluster', () => {
    const { world } = fresh();
    drawRoads(world, ['#'], 5, 5);
    let net = RoadNet.build(world);
    expect(Array.from(pathTiles(net, findPath(net, tile(5, 5), tile(5, 5))!)!)).toEqual([tile(5, 5)]);
    clearRoads(world);
    drawRoads(world, ['###########', '           ', '           ', '           ', '###########'], 4, 2);
    drawRoads(world, ['#', '#', '#', '#', '#'], 4, 2);
    drawRoads(world, ['##', ' #', ' #', ' #', '##'], 15, 2);
    net = RoadNet.build(world);
    const h = findPath(net, tile(14, 2), tile(14, 6))!;
    expect(h.cost).toBe(8 * 60);
    expect(Array.from(pathTiles(net, h)!)).toContain(tile(16, 4));
  });
});

describe('determinism', () => {
  function cityWithRoads() {
    const sim = createSim(42, { debug: true });
    const { x, y } = findLandWindow(sim.world, 32);
    apply(sim, { id: 1, tick: 0, type: 'placeRoad', ax: x, ay: y + 4, bx: x + 30, by: y + 4, cls: 1 });
    apply(sim, { id: 2, tick: 0, type: 'placeRoad', ax: x + 15, ay: y + 4, bx: x + 15, by: y + 28, cls: 2 });
    apply(sim, { id: 3, tick: 0, type: 'placeRoad', ax: x, ay: y + 20, bx: x + 15, by: y + 20, cls: 3 });
    runTicks(sim, 3);
    return { sim, x, y };
  }

  it('gives the same path for the same query twice, and after a snapshot restore', () => {
    const { sim, x, y } = cityWithRoads();
    const a = tile(x, y + 4), b = tile(x, y + 20);
    const net = sim.roads!;
    const p1 = findPath(net, a, b)!, p2 = findPath(net, a, b)!;
    expect(Array.from(p1.waypoints)).toEqual(Array.from(p2.waypoints));
    expect(Array.from(pathTiles(net, p1)!)).toEqual(Array.from(pathTiles(net, p2)!));

    const back = restore(snapshot(sim));
    const net2 = back.roads!;
    const p3 = findPath(net2, a, b)!;
    expect(Array.from(p3.waypoints)).toEqual(Array.from(p1.waypoints));
    expect(Array.from(pathTiles(net2, p3)!)).toEqual(Array.from(pathTiles(net, p1)!));
    expect(p3.epoch).toBe(p1.epoch);
    expect(back.world.scalars[S.graphEpoch]).toBe(sim.world.scalars[S.graphEpoch]);
    expect(net2.canonicalDump()).toEqual(net.canonicalDump());
  });

  it('keeps the resume equality with roads placed: 100 + restore + 100 equals 200 straight', () => {
    const a = cityWithRoads().sim;
    const b = restore(snapshot(a));
    runTicks(a, 100); runTicks(b, 100);
    expect(stateHash(b)).toBe(stateHash(a));
  });

  it('publishes exactly one graphEpoch bump per tick with road changes, however many commands', () => {
    const sim = createSim(42);
    const { x, y } = findLandWindow(sim.world, 32);
    expect(sim.world.scalars[S.graphEpoch]).toBe(0);
    runTicks(sim, 2);
    expect(sim.world.scalars[S.graphEpoch]).toBe(0);
    apply(sim, { id: 1, tick: 0, type: 'placeRoad', ax: x, ay: y, bx: x + 10, by: y, cls: 1 });
    apply(sim, { id: 2, tick: 0, type: 'placeRoad', ax: x, ay: y + 3, bx: x + 10, by: y + 3, cls: 1 });
    step(sim);
    expect(sim.world.scalars[S.graphEpoch]).toBe(1);
    runTicks(sim, 5);
    expect(sim.world.scalars[S.graphEpoch]).toBe(1);
    apply(sim, { id: 3, tick: 0, type: 'bulldoze', x0: x + 4, y0: y, x1: x + 4, y1: y });
    step(sim);
    expect(sim.world.scalars[S.graphEpoch]).toBe(2);
    const sync = roadsOf(sim);
    expect(sync.connected(tile(x, y), tile(x + 10, y))).toBe(false);
  });

  it('undo of a road placement updates the graph', () => {
    const sim = createSim(42);
    const { x, y } = findLandWindow(sim.world, 32);
    apply(sim, { id: 1, tick: 0, type: 'placeRoad', ax: x, ay: y, bx: x + 10, by: y, cls: 1 });
    step(sim);
    const journal = (sim.events.find((e) => e.type === 'accepted' && e.cmd === 1) as { journal?: number }).journal!;
    expect(roadsOf(sim).isRoad(tile(x + 5, y))).toBe(true);
    apply(sim, { id: 2, tick: 0, type: 'undo', target: journal });
    step(sim);
    expect(roadsOf(sim).isRoad(tile(x + 5, y))).toBe(false);
    expect(sim.world.scalars[S.graphEpoch]).toBe(2);
  });
});

describe('path handle validity', () => {
  function layout() {
    const { world } = fresh();
    drawRoads(world, ['#'.repeat(191)], 10, 100);
    drawRoads(world, ['#'.repeat(191)], 10, 104);
    for (const x of [10, 200]) drawRoads(world, ['#', '#', '#', '#'], x, 101);
    drawRoads(world, ['#'.repeat(50)], 10, 200);
    return { world, net: RoadNet.build(world) };
  }

  it('stays valid when an unrelated segment is removed, invalid when the segment it uses is removed', () => {
    const { world, net } = layout();
    const h = findPath(net, tile(10, 100), tile(200, 100))!;
    expect(isValid(net, h)).toBe(true);
    setRoad(world, 30, 200, 0);
    net.sync();
    expect(net.epoch).toBe(h.epoch + 1);
    expect(isValid(net, h)).toBe(true);
    setRoad(world, 100, 100, 0);
    net.sync();
    expect(isValid(net, h)).toBe(false);
  });

  it('replan routes around the removed edge, or fails when no route remains', () => {
    const { world, net } = layout();
    const h = findPath(net, tile(10, 100), tile(200, 100))!;
    setRoad(world, 100, 100, 0);
    net.sync();
    const h2 = replan(net, h)!;
    expect(h2).not.toBeNull();
    expect(isValid(net, h2)).toBe(true);
    const tiles = pathTiles(net, h2)!;
    expect(tiles).not.toContain(tile(100, 100));
    expect(tiles[tiles.length - 1]).toBe(tile(200, 100));
    setRoad(world, 100, 104, 0);
    net.sync();
    expect(replan(net, h2)).toBeNull();
  });

  it('a cluster changed after the path was planned invalidates it, one changed before does not', () => {
    const { world, net } = layout();
    setRoad(world, 100, 100, 0);
    net.sync();
    const h = findPath(net, tile(10, 104), tile(200, 104))!;
    expect(isValid(net, h)).toBe(true);
    setRoad(world, 150, 104, 0);
    net.sync();
    expect(isValid(net, h)).toBe(false);
  });

  it('ignores clusters the agent already left behind', () => {
    const { world, net } = layout();
    const h = findPath(net, tile(10, 100), tile(200, 100))!;
    refineNext(net, h);
    refineNext(net, h);
    refineNext(net, h);
    setRoad(world, 12, 100, 0);
    net.sync();
    expect(isValid(net, h)).toBe(true);
  });
});

describe('debug path query', () => {
  it('answers only for debug sims and reports why a query fails', () => {
    const sim = createSim(42, { debug: true });
    const { x, y } = findLandWindow(sim.world, 32);
    apply(sim, { id: 1, tick: 0, type: 'placeRoad', ax: x, ay: y, bx: x + 5, by: y, cls: 1 });
    apply(sim, { id: 2, tick: 0, type: 'placeRoad', ax: x, ay: y + 3, bx: x + 5, by: y + 3, cls: 1 });
    step(sim);
    const a = { x, y }, b = { x: x + 5, y }, c = { x, y: y + 3 };
    const ok = queryPath(sim, 7, a, b);
    expect(ok).toMatchObject({ type: 'path', id: 7, ok: true });
    expect(ok.cost).toBe(tilePathCost(roadsOf(sim), ok.tiles));
    expect(ok.tiles).toEqual([0, 1, 2, 3, 4, 5].map((i) => tile(x + i, y)));
    expect(queryPath(sim, 8, a, c)).toMatchObject({ ok: false, reason: 'unreachable', tiles: [] });
    expect(queryPath(sim, 9, a, { x, y: y + 1 })).toMatchObject({ ok: false, reason: 'no-road' });
    expect(queryPath(sim, 10, a, { x: -1, y: 0 })).toMatchObject({ ok: false, reason: 'bounds' });
    expect(queryPath(sim, 11, a, { x: 1.5, y: 0 })).toMatchObject({ ok: false, reason: 'bounds' });
    sim.debug = false;
    expect(queryPath(sim, 12, a, b)).toMatchObject({ ok: false, reason: 'debug-only' });
  });

  it('syncs a command applied while paused before answering', () => {
    const sim = createSim(42, { debug: true });
    const { x, y } = findLandWindow(sim.world, 32);
    apply(sim, { id: 1, tick: 0, type: 'placeRoad', ax: x, ay: y, bx: x + 5, by: y, cls: 1 });
    drainCommands(sim);
    expect(sim.world.scalars[S.graphEpoch]).toBe(1);
    const reply = queryPath(sim, 1, { x, y }, { x: x + 5, y });
    expect(reply.ok).toBe(true);
    expect(reply.epoch).toBe(sim.world.scalars[S.graphEpoch]);
    step(sim);
    expect(sim.world.scalars[S.graphEpoch]).toBe(1);
  });

  it('a paused edit, snapshot, restore and step equals the straight run (hash and graphEpoch)', () => {
    const make = () => { const s = createSim(42); runTicks(s, 5); return s; };
    const a = make(), b = make();
    const { x, y } = findLandWindow(a.world, 32);
    const cmd = { id: 1, tick: 0, type: 'placeRoad' as const, ax: x, ay: y, bx: x + 8, by: y, cls: 1 };
    apply(a, cmd); step(a);
    apply(b, cmd); drainCommands(b);
    const resumed = restore(snapshot(b));
    step(resumed);
    expect(resumed.world.scalars[S.graphEpoch]).toBe(a.world.scalars[S.graphEpoch]);
    expect(stateHash(resumed)).toBe(stateHash(a));
    runTicks(resumed, 20); runTicks(a, 20);
    expect(stateHash(resumed)).toBe(stateHash(a));
  });

  it('refineNext and queryPath refuse a path whose crossing step was removed behind the handle', () => {
    const { world, net } = fresh();
    drawRoads(world, ['#'.repeat(40)], 4, 20);
    net.sync();
    const h = findPath(net, tile(4, 20), tile(43, 20))!;
    setRoad(world, 16, 20, 0);
    net.sync();
    expect(isValid(net, h)).toBe(false);
    expect(pathTiles(net, h)).toBeNull();
    const copy = { ...h, cursor: 0 };
    let got: Int32Array | null = Int32Array.of(0);
    while (got && copy.cursor < copy.waypoints.length - 1) got = refineNext(net, copy);
    expect(got).toBeNull();
    const crossing = { epoch: 0, waypoints: Int32Array.of(tile(15, 20), tile(16, 20)), cursor: 0, cost: 0 };
    expect(refineNext(net, crossing)).toBeNull();
    expect(crossing.cursor).toBe(0);
  });
});

describe('lot access', () => {
  it('returns the adjacent road tile in a fixed scan order, or -1', () => {
    const { world } = fresh();
    drawRoads(world, ['#####', '#   #', '#   #', '#   #', '#####'], 20, 20);
    const net = RoadNet.build(world);
    expect(lotAccess(net, 21, 21, 3, 3)).toBe(tile(21, 20));
    expect(lotAccess(net, 21, 21, 3, 3)).toBe(lotAccess(net, 21, 21, 3, 3));
    expect(lotAccess(net, 22, 22, 1, 1)).toBe(-1);
    expect(lotAccess(net, 40, 40, 2, 2)).toBe(-1);
    expect(lotAccess(net, 25, 21, 1, 1)).toBe(tile(24, 21));
  });

  it('with reachFrom only accepts a road connected to it', () => {
    const { world } = fresh();
    drawRoads(world, ['#####'], 20, 20);
    drawRoads(world, ['#####'], 20, 23);
    const net = RoadNet.build(world);
    expect(lotAccess(net, 21, 21, 2, 1)).toBe(tile(21, 20));
    expect(lotAccess(net, 21, 21, 2, 1, tile(20, 23))).toBe(-1);
    expect(lotAccess(net, 21, 22, 2, 1, tile(20, 23))).toBe(tile(21, 23));
  });

  it('nearestRoad finds the closest by Manhattan distance and honours maxDist', () => {
    const { world } = fresh();
    drawRoads(world, ['#'], 50, 50);
    drawRoads(world, ['#'], 53, 50);
    const net = RoadNet.build(world);
    expect(nearestRoad(net, 50, 50, 5)).toBe(tile(50, 50));
    expect(nearestRoad(net, 52, 50, 5)).toBe(tile(53, 50));
    expect(nearestRoad(net, 51, 51, 1)).toBe(-1);
    expect(nearestRoad(net, 51, 51, 2)).toBe(tile(50, 50));
    expect(nearestRoad(net, 100, 100, 10)).toBe(-1);
  });
});

describe('road flow', () => {
  it('matches a BFS oracle on 30 seeded maps and respects maxDist', () => {
    const world = allocWorld();
    for (let seed = 1; seed <= 30; seed++) {
      const roads = randomMap(world, seed * 104729);
      const net = RoadNet.build(world);
      const rng = rngOf(seed);
      const sources = [0, 1, 2].map(() => roads[Math.floor(rng() * roads.length)]!);
      const maxDist = 10 + Math.floor(rng() * 80);
      const flow = roadFlow(net, sources, maxDist);

      const want = new Map<number, number>();
      let frontier = [...new Set(sources)];
      frontier.forEach((s) => want.set(s, 0));
      for (let d = 0; d < maxDist; d++) {
        const next: number[] = [];
        for (const t of frontier) {
          const x = t & 255, y = t >> 8;
          for (const [dx, dy, bit] of [[0, -1, ROAD.N], [1, 0, ROAD.E], [0, 1, ROAD.S], [-1, 0, ROAD.W]] as const) {
            const nx = x + dx, ny = y + dy;
            if (!(world.road[t]! & bit) || nx < 0 || ny < 0 || nx >= MAP || ny >= MAP) continue;
            const n = ny * MAP + nx;
            if ((world.road[n]! & ROAD.CLASS_MASK) && !want.has(n)) { want.set(n, d + 1); next.push(n); }
          }
        }
        frontier = next;
      }
      let reached = 0, wrong = 0;
      for (let t = 0; t < TILES; t++) {
        const w = want.get(t);
        if (flow.dist[t] !== (w === undefined ? UNREACHED : w)) wrong++;
        if (w !== undefined) reached++;
      }
      expect(wrong, `seed ${seed}: tiles with a wrong distance`).toBe(0);
      expect(reached).toBeGreaterThan(0);
      expect(flow.reached.length).toBe(reached);
      const again = roadFlow(net, sources, maxDist);
      expect(Array.from(again.reached)).toEqual(Array.from(flow.reached));
    }
  });

  it('ignores non-road sources and gives nothing for an empty set', () => {
    const { world } = fresh();
    drawRoads(world, ['####'], 10, 10);
    const net = RoadNet.build(world);
    expect(roadFlow(net, [tile(0, 0)], 5).reached.length).toBe(0);
    expect(roadFlow(net, [], 5).reached.length).toBe(0);
  });
});

describe('performance', () => {
  function denseGrid(world: ReturnType<typeof allocWorld>, period: number): void {
    const tiles: [number, number, number][] = [];
    for (let y = 0; y < MAP; y++) for (let x = 0; x < MAP; x++) if (x % period === 0 || y % period === 0) tiles.push([x, y, 1]);
    setRoads(world, tiles);
  }

  it('builds a dense 256x256 grid fast and answers 200-tile queries in ~ms', () => {
    const world = allocWorld();
    denseGrid(world, 4);
    let best = Infinity;
    for (let i = 0; i < 5; i++) { const t0 = performance.now(); RoadNet.build(world); best = Math.min(best, performance.now() - t0); }
    console.log(`perf: dense grid (every 4th row/col, ${TILES} tiles) full graph build ${best.toFixed(1)} ms (best of 5)`);
    expect(best).toBeLessThan(200);

    const solid = allocWorld();
    solid.road.fill(0);
    setRoads(solid, Array.from({ length: TILES }, (_, i) => [i & 255, i >> 8, 1] as [number, number, number]));
    const t1 = performance.now();
    RoadNet.build(solid);
    const solidMs = performance.now() - t1;
    console.log(`perf: fully paved 256x256 (worst case) full graph build ${solidMs.toFixed(1)} ms`);
    expect(solidMs).toBeLessThan(2000);

    const net = RoadNet.build(world);
    const rng = rngOf(5);
    for (let i = 0; i < 100; i++) findPath(net, tile(0, 0), tile(100, 100));
    let totalMs = 0, tilesSeen = 0, planMs = 0;
    for (let q = 0; q < 1000; q++) {
      const dx = 4 * (20 + Math.floor(rng() * 11)), dy = 200 - dx;
      const x = 4 * Math.floor(rng() * ((MAP - 1 - dx) / 4)), y = 4 * Math.floor(rng() * ((MAP - 1 - dy) / 4));
      const flip = rng() < 0.5;
      const a = flip ? tile(x + dx, y) : tile(x, y), b = flip ? tile(x, y + dy) : tile(x + dx, y + dy);
      const t0 = performance.now();
      const h = findPath(net, a, b)!;
      planMs += performance.now() - t0;
      const tiles = pathTiles(net, h)!;
      totalMs += performance.now() - t0;
      tilesSeen += tiles.length;
    }
    console.log(`perf: 1000 queries, mean path ${(tilesSeen / 1000).toFixed(0)} tiles: plan ${(planMs / 1000).toFixed(3)} ms, plan + full refine ${(totalMs / 1000).toFixed(3)} ms per query`);
    expect(tilesSeen / 1000).toBeGreaterThan(150);
    expect(totalMs / 1000).toBeLessThan(8);
  }, 60000);

  it('the per-tick sync scan with no road change is cheap', () => {
    const world = allocWorld();
    denseGrid(world, 4);
    const net = RoadNet.build(world);
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) net.sync();
    console.log(`perf: no-change sync ${((performance.now() - t0) / 1000).toFixed(4)} ms per tick`);
  });
});
