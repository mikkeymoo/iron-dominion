import { describe, expect, it } from 'vitest';
import { ARCH, archetype } from '../../sim/catalog.ts';
import type { CommandBody } from '../../sim/commands.ts';
import { recomputeLandValue } from '../../sim/economy/index.ts';
import { footprintMean } from '../../sim/economy/totals.ts';
import { estimate } from '../../sim/estimate.ts';
import { BMAX, S } from '../../sim/layers.ts';
import { flatSim, road, run, depot, zone } from '../../sim/robots/testkit.ts';
import { COVERED_MIN, footprintMax, recomputeServices } from '../../sim/services/index.ts';
import { runTicks } from '../../sim/testkit.ts';
import type { Sim } from '../../sim/world.ts';
import type { Plan } from './controller.ts';
import { ghostChips, serviceGain } from './ghostScore.ts';

type Layers = Record<string, ArrayLike<number>>;
const layersOf = (sim: Sim): Layers => sim.world as unknown as Layers;
const planFor = (sim: Sim, cmd: CommandBody): Plan => ({ cmd, est: estimate(sim.world, cmd, sim.world.scalars[S.treasury]), tile: { x: 0, y: 0 } });
const place = (sim: Sim, arch: number, x: number, y: number): void => { expect(run(sim, { type: 'placeBuilding', arch, x, y, rot: 0 })).toBe(true); };
const grow = (sim: Sim, x: number, y: number, archetype = 16): void => { expect(run(sim, { type: 'debugGrow', x, y, archetype, progress: 1 })).toBe(true); };

/** A street along y = 104 with eleven houses on its south side, 2 tiles apart. */
function street(): Sim {
  const sim = flatSim(42, true);
  road(sim, 96, 104, 130, 104);
  for (let x = 100; x <= 120; x += 2) grow(sim, x, 105);
  recomputeServices(sim);
  recomputeLandValue(sim);
  return sim;
}

const houses = (sim: Sim): number[] => {
  const out: number[] = [];
  for (let s = 0; s < BMAX; s++) if (sim.world.bArch[s] === 16) out.push(s);
  return out;
};
const meanLv = (sim: Sim, slots: number[]): number => slots.reduce((a, s) => a + footprintMean(sim.world, sim.world.landValue, s), 0) / slots.length;

describe('placement chips match what the sim does', () => {
  it('predicts the buildings a fire station newly covers, and the land value they gain', () => {
    const sim = street();
    const fire = archetype(ARCH.FIRE_STATION)!;
    const g = serviceGain(layersOf(sim), fire, 108, 101, 0);
    expect(g.door).toBe(true);
    const before = meanLv(sim, houses(sim));
    place(sim, ARCH.FIRE_STATION, 108, 101);
    recomputeServices(sim);
    recomputeLandValue(sim);
    const covered = houses(sim).filter((s) => footprintMax(sim.world, sim.world.covFire, s) >= COVERED_MIN).length;
    expect(covered).toBeGreaterThan(0);
    expect(g.newlyCovered).toBe(covered);
    expect(Math.abs(g.landValue - (meanLv(sim, houses(sim)) - before))).toBeLessThanOrEqual(1);
  });

  it('predicts what a park adds to the land value around it', () => {
    const sim = street();
    const park = archetype(ARCH.PARK_SMALL)!;
    const g = serviceGain(layersOf(sim), park, 108, 106, 0);
    const before = houses(sim).map((s) => footprintMean(sim.world, sim.world.landValue, s));
    place(sim, ARCH.PARK_SMALL, 108, 106);
    recomputeServices(sim);
    recomputeLandValue(sim);
    const gains = houses(sim).map((s, i) => footprintMean(sim.world, sim.world.landValue, s) - before[i]!).filter((d) => d > 0);
    expect(gains.length).toBeGreaterThan(0);
    expect(g.reached).toBeGreaterThanOrEqual(gains.length);
    const actual = gains.reduce((a, d) => a + d, 0) / gains.length;
    expect(Math.abs(g.landValue - actual)).toBeLessThanOrEqual(1);
  });

  it('shows the covered-building count and land value as green chips, and nothing for a placement the sim refuses', () => {
    const sim = street();
    const ok = ghostChips({ layers: layersOf(sim) }, planFor(sim, { type: 'placeBuilding', arch: ARCH.FIRE_STATION, x: 108, y: 101, rot: 0 }));
    expect(ok[0]).toMatchObject({ id: 'cover', tone: 'good' });
    expect(ok[0]!.text).toMatch(/^\+\d+ buildings with fire cover$/);
    expect(ghostChips({ layers: layersOf(sim) }, planFor(sim, { type: 'placeBuilding', arch: ARCH.FIRE_STATION, x: 100, y: 104, rot: 0 }))).toEqual([]);
    expect(ghostChips({ layers: layersOf(sim) }, null)).toEqual([]);
  });

  it('turns a road service with no road at its door into a red chip', () => {
    const sim = street();
    const chips = ghostChips({ layers: layersOf(sim) }, planFor(sim, { type: 'placeBuilding', arch: ARCH.FIRE_STATION, x: 140, y: 140, rot: 0 }));
    expect(chips).toEqual([{ id: 'door', text: 'No road at its door: it covers nothing', tone: 'bad' }]);
  });

  it('counts the homes a power plant would smog, and the megawatts it adds', () => {
    const sim = street();
    const near = ghostChips({ layers: layersOf(sim) }, planFor(sim, { type: 'placeBuilding', arch: ARCH.POWER_PLANT, x: 108, y: 108, rot: 0 }));
    expect(near.find((c) => c.id === 'smog')).toMatchObject({ tone: 'bad', text: 'Smog will drift over 11 homes' });
    expect(near.find((c) => c.id === 'mw')).toMatchObject({ tone: 'good', text: '+120 MW' });
    const far = ghostChips({ layers: layersOf(sim) }, planFor(sim, { type: 'placeBuilding', arch: ARCH.POWER_PLANT, x: 200, y: 200, rot: 0 }));
    expect(far.find((c) => c.id === 'smog')).toMatchObject({ tone: 'good' });
    expect(near[0]!.tone, 'worst first').toBe('bad');
  });

  it('colours a zone by its land value, smog and road, from exactly the tiles the estimate says would be zoned', () => {
    const sim = street();
    const w = sim.world;
    const cmd: CommandBody = { type: 'zone', x0: 100, y0: 110, x1: 105, y1: 112, zone: 1, density: 0 };
    const plan = planFor(sim, cmd);
    expect(plan.est.reason).toBeUndefined();
    const sum = plan.est.validTiles.reduce((a, i) => a + w.landValue[i]!, 0);
    const lv = ghostChips({ layers: layersOf(sim) }, plan).find((c) => c.id === 'lv')!;
    expect(lv.text).toBe(`Land value ${Math.round(sum / plan.est.validTiles.length)}`);
    const noRoad = ghostChips({ layers: layersOf(sim) }, plan).find((c) => c.id === 'road');
    expect(noRoad).toMatchObject({ tone: 'bad' });

    for (const i of plan.est.validTiles) w.pollution[i] = 140;
    const smoggy = ghostChips({ layers: layersOf(sim) }, plan);
    expect(smoggy.find((c) => c.id === 'smog')).toMatchObject({ tone: 'bad', text: 'Smog here (140)' });

    const beside = planFor(sim, { type: 'zone', x0: 100, y0: 105, x1: 105, y1: 107, zone: 1, density: 0 });
    for (const i of beside.est.validTiles) w.landValue[i] = 130;
    const fine = ghostChips({ layers: layersOf(sim) }, beside);
    expect(fine.find((c) => c.id === 'lv')).toMatchObject({ tone: 'good' });
    expect(fine.find((c) => c.id === 'road')).toBeUndefined();
    expect(fine.length).toBeLessThanOrEqual(4);
  });

  it('says how many zoned tiles a new depot brings into reach, and when another depot already covers them', () => {
    const sim = flatSim(42, true);
    road(sim, 96, 104, 130, 104);
    zone(sim, 100, 105, 110, 108);
    const first = ghostChips({ layers: layersOf(sim) }, planFor(sim, { type: 'placeBuilding', arch: ARCH.DEPOT, x: 98, y: 102, rot: 0 }));
    // The street tints two tiles either side (rows 102 to 106), so of the 44 zoned tiles (rows 105 to 108) the first two rows count.
    expect(first[0]).toMatchObject({ id: 'reach', tone: 'good', text: '+22 zoned tiles in reach' });
    depot(sim, 98, 102);
    const second = ghostChips({ layers: layersOf(sim) }, planFor(sim, { type: 'placeBuilding', arch: ARCH.DEPOT, x: 120, y: 102, rot: 0 }));
    expect(second[0]).toMatchObject({ id: 'reach', tone: 'warn', text: 'Already in reach of another depot' });
    const nodoor = ghostChips({ layers: layersOf(sim) }, planFor(sim, { type: 'placeBuilding', arch: ARCH.DEPOT, x: 150, y: 150, rot: 0 }));
    expect(nodoor[0]).toMatchObject({ id: 'door', tone: 'bad' });
  });

  it('warns that a building with no power or water touching it will be dark, once the grids exist', () => {
    const sim = street();
    place(sim, ARCH.POWER_PLANT, 100, 98);
    place(sim, ARCH.WATER_PUMP, 104, 98);
    runTicks(sim, 10);
    const chips = ghostChips({ layers: layersOf(sim) }, planFor(sim, { type: 'placeBuilding', arch: ARCH.POLICE, x: 120, y: 100, rot: 0 }));
    expect(chips.map((c) => c.id)).toEqual(expect.arrayContaining(['power', 'water']));
    expect(chips.find((c) => c.id === 'power')!.tone).toBe('warn');
  });
});
