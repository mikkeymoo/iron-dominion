import { describe, expect, it } from 'vitest';
import { ARCH } from '../sim/catalog.ts';
import { BMAX, MAP, ROAD, TILES } from '../sim/layers.ts';
import { NO_FACTS, checklistDone, evaluateChecklist, factsFromLayers, type CityFacts } from './progress';

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

const done = (f: CityFacts): string[] => evaluateChecklist(f).filter((s) => s.done).map((s) => s.id);

describe('starter checklist from the mirror', () => {
  it('has six unticked steps for an empty city, in order', () => {
    const f = factsFromLayers(layers());
    expect(f).toEqual(NO_FACTS);
    const steps = evaluateChecklist(f);
    expect(steps.map((s) => s.id)).toEqual(['depot', 'road', 'residential', 'work', 'power', 'water']);
    expect(checklistDone(steps)).toBe(0);
  });

  it('ticks step 1 as soon as a depot exists, and step 2 only once a road touches it', () => {
    const l = layers();
    place(l, 3, ARCH.DEPOT, 20, 20, 2, 2);
    expect(done(factsFromLayers(l))).toEqual(['depot']);
    road(l, 30, 30);
    expect(done(factsFromLayers(l))).toEqual(['depot']);
    road(l, 21, 22);
    expect(done(factsFromLayers(l))).toEqual(['depot', 'road']);
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

  it('ticks the residential step for a residential tile beside a road and the work step for commercial or industrial', () => {
    const l = layers();
    road(l, 50, 50);
    l.zone[idx(50, 51)] = 1;
    expect(factsFromLayers(l)).toMatchObject({ residentialOnRoad: true, workZoneOnRoad: false });
    l.zone[idx(60, 60)] = 2;
    expect(factsFromLayers(l).workZoneOnRoad).toBe(false);
    l.zone[idx(51, 50)] = 3;
    expect(factsFromLayers(l)).toMatchObject({ residentialOnRoad: true, workZoneOnRoad: true });
    expect(done(factsFromLayers(l))).toEqual(['residential', 'work']);
  });

  it('needs both the plant and a power line, and both the pump and a pipe', () => {
    const l = layers();
    place(l, 1, ARCH.POWER_PLANT, 40, 40, 4, 4);
    expect(done(factsFromLayers(l))).toEqual([]);
    l.ugPower[idx(44, 40)] = 1;
    expect(done(factsFromLayers(l))).toEqual(['power']);
    place(l, 2, ARCH.WATER_PUMP, 60, 40, 2, 2);
    expect(done(factsFromLayers(l))).toEqual(['power']);
    l.ugWater[idx(62, 40)] = 1;
    expect(done(factsFromLayers(l))).toEqual(['power', 'water']);
  });

  it('accepts a solar farm or a water tower as the utility building', () => {
    const l = layers();
    place(l, 1, ARCH.SOLAR_FARM, 40, 40, 4, 4);
    place(l, 2, ARCH.WATER_TOWER, 60, 40, 2, 2);
    l.ugPower[0] = 1; l.ugWater[0] = 1;
    expect(done(factsFromLayers(l))).toEqual(['power', 'water']);
  });

  it('marks every step done for a finished starter city', () => {
    const l = layers();
    place(l, 0, ARCH.DEPOT, 20, 20, 2, 2);
    place(l, 1, ARCH.POWER_PLANT, 40, 40, 4, 4);
    place(l, 2, ARCH.WATER_PUMP, 60, 40, 2, 2);
    road(l, 22, 20); road(l, 23, 20);
    l.zone[idx(22, 21)] = 1; l.zone[idx(23, 21)] = 2;
    l.ugPower[5] = 1; l.ugWater[5] = 1;
    const steps = evaluateChecklist(factsFromLayers(l));
    expect(checklistDone(steps)).toBe(6);
  });

  it('points each step at its own tool, with step 1 on the depot', () => {
    const steps = evaluateChecklist(NO_FACTS);
    expect(steps[0]!.tool).toEqual({ tool: 'service', arch: ARCH.DEPOT });
    expect(steps[1]!.tool.tool).toBe('road');
    expect(steps[2]!.tool).toMatchObject({ tool: 'zone', zone: 1 });
    expect(steps[3]!.tool).toMatchObject({ tool: 'zone', zone: 2 });
  });
});
