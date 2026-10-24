import { describe, expect, it } from 'vitest';
import { ARCH } from '../sim/catalog.ts';
import { MAP, ROAD, TERRAIN, TILES } from '../sim/layers.ts';
import { DEPOT_WORK_RADIUS } from '../sim/robots/constants.ts';
import { allocWorld } from '../sim/world.ts';
import { REACH_DOOR, REACH_EDGE, depotDoors, doorOfBuilding, reachLayer } from './depotReach.ts';
import { RenderMirror } from './mirror.ts';
import { overlayLayersOf, paintAll } from './overlayPaint.ts';

type Layers = Record<string, ArrayLike<number>>;

/** A straight street along y = 104 from x = 60 to x = 200 and a depot at (98, 102) whose door is the street tile (98, 104). */
function street() {
  const w = allocWorld();
  w.terrain.fill(TERRAIN.GRASS);
  for (let x = 60; x <= 200; x++) w.road[104 * MAP + x] = 1 | (x > 60 ? ROAD.W : 0) | (x < 200 ? ROAD.E : 0);
  w.bArch[0] = ARCH.DEPOT; w.bX[0] = 98; w.bY[0] = 102; w.bW[0] = 2; w.bH[0] = 2;
  return { w, L: w as unknown as Layers };
}

describe('depot work radius', () => {
  it('finds the road tile at the door of every depot, and of a ghost', () => {
    const { w, L } = street();
    expect(depotDoors(L)).toEqual([104 * MAP + 98]);
    expect(doorOfBuilding(L, 0)).toBe(104 * MAP + 98);
    expect(depotDoors(L, { x: 150, y: 102, w: 2, h: 2 })).toEqual([104 * MAP + 98, 104 * MAP + 150]);
    expect(depotDoors(L, { x: 150, y: 120, w: 2, h: 2 }), 'a ghost with no road at its door adds nothing').toEqual([104 * MAP + 98]);
    w.bArch[0] = 0;
    expect(depotDoors(L)).toEqual([]);
  });

  it('is full strength at the door, falls to the edge value at the radius, and stops there', () => {
    const { L } = street();
    const out = new Uint8Array(TILES);
    const n = reachLayer(L, depotDoors(L), out);
    expect(n).toBeGreaterThan(0);
    expect(out[104 * MAP + 98]).toBe(REACH_DOOR);
    expect(out[104 * MAP + 98 + 20]).toBeLessThan(REACH_DOOR);
    expect(out[104 * MAP + 98 + 20]).toBeGreaterThan(out[104 * MAP + 98 + 39]!);
    // The last road tile (at the radius) is REACH_EDGE itself; the halo of the tiles just inside it lifts the street tile to their value.
    const edge = out[104 * MAP + 98 + DEPOT_WORK_RADIUS]!;
    expect(edge).toBeGreaterThanOrEqual(REACH_EDGE);
    expect(edge).toBeLessThan(REACH_EDGE + 15);
    expect(out[104 * MAP + 98 + DEPOT_WORK_RADIUS + 3], 'beyond the radius even the halo is gone').toBe(0);
    expect(out[104 * MAP + 98 - DEPOT_WORK_RADIUS]).toBe(edge);
    expect(out[106 * MAP + 98], 'two tiles off the street still gets the tint').toBe(REACH_DOOR);
    expect(out[107 * MAP + 98], 'three tiles off the street does not').toBe(0);
  });

  it('measures along the roads: a street that does not connect is out of reach however near it is', () => {
    const { w, L } = street();
    for (let x = 100; x <= 110; x++) w.road[110 * MAP + x] = 1 | (x > 100 ? ROAD.W : 0) | (x < 110 ? ROAD.E : 0);
    const out = new Uint8Array(TILES);
    reachLayer(L, depotDoors(L), out);
    expect(out[110 * MAP + 105]).toBe(0);
    for (let y = 105; y < 110; y++) w.road[y * MAP + 105] = 1 | ROAD.N | ROAD.S;
    w.road[104 * MAP + 105] = w.road[104 * MAP + 105]! | ROAD.S;
    w.road[110 * MAP + 105] = w.road[110 * MAP + 105]! | ROAD.N;
    reachLayer(L, depotDoors(L), out);
    expect(out[110 * MAP + 105]).toBeGreaterThan(REACH_EDGE);
  });

  it('is empty with no doors, and paints as a teal tint only where it reaches, on dry land', () => {
    const { w, L } = street();
    const out = new Uint8Array(TILES);
    expect(reachLayer(L, [], out)).toBe(0);
    reachLayer(L, depotDoors(L), out);
    const m = new RenderMirror();
    m.setDepotReach(out);
    expect(m.depotReachVersion).toBe(1);
    const layers = overlayLayersOf({ ...(w as unknown as Layers), depotReach: m.depotReach });
    const px = new Uint8Array(TILES * 4);
    paintAll('depotReach', layers, px);
    const at = (x: number, y: number): number[] => Array.from(px.subarray((y * MAP + x) * 4, (y * MAP + x) * 4 + 4));
    const door = at(98, 104), far = at(98 + 30, 104), outside = at(98, 130);
    expect(door.slice(0, 3)).toEqual([60, 214, 255]);
    expect(door[3]).toBeGreaterThan(far[3]!);
    expect(far[3]).toBeGreaterThan(0);
    expect(outside).toEqual([0, 0, 0, 0]);
    w.terrain[104 * MAP + 98] = TERRAIN.WATER;
    paintAll('depotReach', layers, px);
    expect(at(98, 104)).toEqual([0, 0, 0, 0]);
  });
});
