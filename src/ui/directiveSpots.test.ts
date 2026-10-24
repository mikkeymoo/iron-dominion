import { describe, expect, it } from 'vitest';
import { ARCH } from '../sim/catalog.ts';
import { execute, type Command, type CommandBody } from '../sim/commands.ts';
import { DIRECTIVES } from '../sim/directives.ts';
import { estimate, tileReadOf } from '../sim/estimate.ts';
import { createSim } from '../sim/engine.ts';
import type { Sim } from '../sim/world.ts';
import { PLAIN_TOOL, findStrip, roadEnd, suggestSpot, findBuilding } from './directiveSpots.ts';

type Layers = Record<string, ArrayLike<number>>;
const layersOf = (sim: Sim): Layers => sim.world as unknown as Layers;
const starter = (seed = 42): Sim => createSim(seed, { starter: true });
let id = 1;
const run = (sim: Sim, body: CommandBody): boolean => execute(sim, { ...body, id: id++, tick: 0 } as Command);

describe('where "Show me" points', () => {
  it('has nothing to point at without a depot', () => {
    expect(suggestSpot('road', layersOf(createSim(42)))).toBeNull();
  });

  it('every directive that picks a tool without a spot has a plain tool as the fallback', () => {
    for (const d of DIRECTIVES) {
      if (['firstHome', 'population', 'settlement', 'megaproject'].includes(d.id)) continue;
      expect(PLAIN_TOOL[d.id], d.id).toBeDefined();
    }
  });

  it('road: the ghost sits one tile past the end of the starter street, and a drag from there is a valid road', () => {
    const sim = starter();
    const depot = findBuilding(layersOf(sim), ARCH.DEPOT)!;
    const end = roadEnd(layersOf(sim), depot)!;
    const spot = suggestSpot('road', layersOf(sim))!;
    expect(spot.sel).toEqual({ tool: 'road', cls: 1 });
    expect(spot).toMatchObject({ x: end.end.x, y: end.end.y, ghost: { x: end.end.x + end.dx, y: end.end.y + end.dy } });
    expect(end.dx === 0 && end.dy === 0).toBe(false);
    const e = estimate(tileReadOf(layersOf(sim)), { type: 'placeRoad', ax: end.end.x, ay: end.end.y, bx: end.end.x + 8 * (end.dx || 1), by: end.end.y + 8 * end.dy, cls: 1 });
    expect(e.reason).toBeUndefined();
  });

  it('zones: a free strip of the asked size beside the street that the sim would accept in full', () => {
    const sim = starter();
    for (const [dirId, w, h, zone, density] of [['residential', 6, 2, 1, 0], ['commercial', 4, 2, 2, 0], ['industrial', 4, 2, 3, 0], ['upgrade', 4, 4, 1, 1]] as const) {
      const spot = suggestSpot(dirId, layersOf(sim))!;
      expect(spot.sel, dirId).toEqual({ tool: 'zone', zone, density });
      const d = findBuilding(layersOf(sim), ARCH.DEPOT)!, home = { x: Math.floor(d.x + d.w / 2), y: Math.floor(d.y + d.h / 2) };
      const g = spot.ghost!, strip = findStrip(tileReadOf(layersOf(sim)), layersOf(sim), home, w, h, zone, density)!;
      expect(strip, dirId).toMatchObject({ x: g.x, y: g.y });
      const e = estimate(tileReadOf(layersOf(sim)), { type: 'zone', x0: strip.x, y0: strip.y, x1: strip.x + strip.w - 1, y1: strip.y + strip.h - 1, zone, density });
      expect(e.reason, dirId).toBeUndefined();
      expect(e.validTiles.length, dirId).toBe(w * h);
    }
  });

  it('zone suggestions do not overwrite a zone that is already there', () => {
    const sim = starter();
    const first = suggestSpot('residential', layersOf(sim))!;
    const g = first.ghost!;
    expect(run(sim, { type: 'zone', x0: g.x, y0: g.y, x1: g.x + 5, y1: g.y + 1, zone: 1, density: 0 })).toBe(true);
    const second = suggestSpot('commercial', layersOf(sim))!;
    const zoneLayer = layersOf(sim).zone!;
    const s = second.ghost!;
    for (let y = s.y; y < s.y + 2; y++) for (let x = s.x; x < s.x + 4; x++) expect(zoneLayer[y * 256 + x], `${x},${y}`).toBe(0);
  });

  it('buildings: the ghost is a placement the sim accepts, and the power plant keeps its distance from the depot', () => {
    const sim = starter();
    const depot = findBuilding(layersOf(sim), ARCH.DEPOT)!;
    for (const [dirId, arch] of [['power', ARCH.POWER_PLANT], ['water', ARCH.WATER_PUMP], ['safety', ARCH.FIRE_STATION]] as const) {
      const spot = suggestSpot(dirId, layersOf(sim))!;
      expect(spot.sel, dirId).toEqual({ tool: 'service', arch });
      expect(spot.ghost, dirId).toBeDefined();
    }
    const plant = suggestSpot('power', layersOf(sim))!;
    expect(Math.max(Math.abs(plant.x - depot.x), Math.abs(plant.y - depot.y))).toBeGreaterThanOrEqual(9);
    expect(run(sim, { type: 'placeBuilding', arch: ARCH.POWER_PLANT, x: plant.x, y: plant.y, rot: 0 })).toBe(true);
  });

  it('once the plant stands, "Show me" turns to the power line, between the plant and the depot', () => {
    const sim = starter();
    const plant = suggestSpot('power', layersOf(sim))!;
    run(sim, { type: 'placeBuilding', arch: ARCH.POWER_PLANT, x: plant.x, y: plant.y, rot: 0 });
    const spot = suggestSpot('power', layersOf(sim))!;
    expect(spot.sel).toEqual({ tool: 'line', kind: 'power' });
    expect(spot.ghost).toBeUndefined();
  });

  it('the pump is offered on the shore when the map has water near the depot', () => {
    for (const seed of [42, 7, 99, 1234]) {
      const sim = starter(seed);
      const pump = suggestSpot('water', layersOf(sim))!;
      expect(pump.sel, `seed ${seed}`).toEqual({ tool: 'service', arch: ARCH.WATER_PUMP });
      expect(run(sim, { type: 'placeBuilding', arch: ARCH.WATER_PUMP, x: pump.x, y: pump.y, rot: 0 }), `seed ${seed}`).toBe(true);
    }
  });

  it('the first home and the last directive pick no tool; the last one opens Projects', () => {
    const sim = starter();
    expect(suggestSpot('firstHome', layersOf(sim))!.sel).toMatchObject({ tool: 'zone', zone: 1 });
    expect(suggestSpot('megaproject', layersOf(sim))).toMatchObject({ projects: true });
    expect(suggestSpot('megaproject', layersOf(sim))!.sel).toBeUndefined();
  });
});
