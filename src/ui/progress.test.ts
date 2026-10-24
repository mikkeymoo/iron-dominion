import { describe, expect, it } from 'vitest';
import { ARCH } from '../sim/catalog.ts';
import { BMAX, MAP, ROAD, TILES } from '../sim/layers.ts';
import { NO_FACTS, factsFromLayers } from './progress';

const idx = (x: number, y: number): number => y * MAP + x;

function layers() {
  return {
    bArch: new Uint8Array(BMAX), bX: new Uint16Array(BMAX), bY: new Uint16Array(BMAX), bW: new Uint8Array(BMAX), bH: new Uint8Array(BMAX),
    road: new Uint16Array(TILES), zone: new Uint8Array(TILES), ugPower: new Uint8Array(TILES), ugWater: new Uint8Array(TILES),
  };
}
const place = (l: ReturnType<typeof layers>, slot: number, arch: number, x: number, y: number, w: number, h: number): void => {
  l.bArch[slot] = arch; l.bX[slot] = x; l.bY[slot] = y; l.bW[slot] = w; l.bH[slot] = h;
};
const road = (l: ReturnType<typeof layers>, x: number, y: number): void => { l.road[idx(x, y)] = 1 | ROAD.E | ROAD.W; };

describe('city facts from the mirror', () => {
  it('reads nothing from an empty city', () => {
    expect(factsFromLayers(layers())).toEqual(NO_FACTS);
  });

  it('counts depots, and sees a road only once it touches one', () => {
    const l = layers();
    place(l, 3, ARCH.DEPOT, 20, 20, 2, 2);
    expect(factsFromLayers(l)).toMatchObject({ depots: 1, depotOnRoad: false });
    road(l, 30, 30);
    expect(factsFromLayers(l).depotOnRoad).toBe(false);
    road(l, 21, 22);
    expect(factsFromLayers(l)).toMatchObject({ depots: 1, depotOnRoad: true });
  });

  it('counts a road on any side of the footprint, not diagonals', () => {
    for (const [x, y] of [[19, 20], [22, 21], [20, 19], [21, 22]] as const) {
      const l = layers();
      place(l, 0, ARCH.DEPOT, 20, 20, 2, 2);
      road(l, x, y);
      expect(factsFromLayers(l).depotOnRoad, `road at ${x},${y}`).toBe(true);
    }
    const l = layers();
    place(l, 0, ARCH.DEPOT, 20, 20, 2, 2);
    road(l, 19, 19);
    expect(factsFromLayers(l).depotOnRoad).toBe(false);
  });

  it('sees residential zones beside a road and commercial or industrial ones as work zones', () => {
    const l = layers();
    road(l, 50, 50);
    l.zone[idx(50, 51)] = 1;
    expect(factsFromLayers(l)).toMatchObject({ residentialOnRoad: true, workZoneOnRoad: false });
    l.zone[idx(60, 60)] = 2;
    expect(factsFromLayers(l).workZoneOnRoad).toBe(false);
    l.zone[idx(51, 50)] = 3;
    expect(factsFromLayers(l)).toMatchObject({ residentialOnRoad: true, workZoneOnRoad: true });
  });

  it('counts utility buildings, lines and pipes, with solar farms and water towers as utilities', () => {
    const l = layers();
    place(l, 1, ARCH.SOLAR_FARM, 40, 40, 4, 4);
    place(l, 2, ARCH.WATER_TOWER, 60, 40, 2, 2);
    l.ugPower[0] = 1; l.ugWater[0] = 1; l.ugWater[1] = 1;
    expect(factsFromLayers(l)).toMatchObject({ powerPlants: 1, powerLines: 1, waterPumps: 1, pipes: 2 });
  });
});
