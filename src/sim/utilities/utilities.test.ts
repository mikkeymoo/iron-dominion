import { afterEach, describe, expect, it, vi } from 'vitest';
import { RenderMirror } from '../../render/mirror.ts';
import { ARCH, BFLAG, CATALOG, PIPE_COST, POWER_LINE_COST, isRci, rciId } from '../catalog.ts';
import { execute, type Command, type CommandBody } from '../commands.ts';
import { countTotals, landValueAt, levelUpCandidates, lotScore, refreshTotals } from '../economy/index.ts';
import { apply, collectOutgoing, createSim, makeResync, restore, snapshot, stateHash } from '../engine.ts';
import { estimate, tileReadOf } from '../estimate.ts';
import { MAP, REGISTRY, S, TERRAIN, WEATHER, ZONE } from '../layers.ts';
import { setRoads } from '../roads/testkit.ts';
import { runTicks } from '../testkit.ts';
import type { Sim } from '../world.ts';
import {
  GRID_POWER, GRID_WATER, LOT_NO_POWER, LOT_NO_WATER, LV_NO_WATER, PLANT_MW, PUMP_INLAND_ML, PUMP_NEAR_ML, SOLAR_PEAK_MW, TOWER_ML,
  WATER_REACH, isPowerProducer, isWaterSource, powerUseOf, producerKind, pumpOutput, solarOutput, solveUtilities, sunQ, waterUseOf,
  weatherQ,
} from './index.ts';

vi.setConfig({ testTimeout: 60000 });
afterEach(() => new Promise<void>((r) => { setTimeout(r, 0); }));

let nextId = 1;
function run(sim: Sim, body: CommandBody): { ok: boolean; reason?: string; journal?: number } {
  sim.events = [];
  const ok = execute(sim, { ...body, id: nextId++, tick: 0 } as Command);
  const e = sim.events[sim.events.length - 1]!;
  return { ok, reason: e.type === 'rejected' ? e.reason : undefined, journal: e.type === 'accepted' ? e.journal : undefined };
}

/** Debug sim on flat dry grass, no roads. */
function flatSim(): Sim {
  const sim = createSim(42, { debug: true });
  const w = sim.world;
  w.terrain.fill(TERRAIN.GRASS);
  w.height.fill(160);
  w.waterDepth.fill(0);
  return sim;
}

const must = (r: { ok: boolean; reason?: string }, what: string): void => { if (!r.ok) throw new Error(`${what}: ${r.reason}`); };
const grow = (sim: Sim, x: number, y: number, arch: number, progress = 1): void => must(run(sim, { type: 'debugGrow', x, y, archetype: arch, progress }), `grow ${arch} at ${x},${y}`);
const place = (sim: Sim, arch: number, x: number, y: number, rot = 0): void => must(run(sim, { type: 'placeBuilding', arch, x, y, rot }), `place ${arch} at ${x},${y}`);
const lay = (sim: Sim, kind: 'power' | 'water', ax: number, ay: number, bx: number, by: number): number => {
  const r = run(sim, { type: 'placeLine', kind, ax, ay, bx, by });
  must(r, `line ${kind} ${ax},${ay} -> ${bx},${by}`);
  return r.journal ?? 0;
};
const slotAt = (sim: Sim, x: number, y: number): number => sim.world.bId[y * MAP + x]! - 1;
const unpowered = (sim: Sim, x: number, y: number): boolean => (sim.world.bFlags[slotAt(sim, x, y)]! & BFLAG.UNPOWERED) !== 0;
const unwatered = (sim: Sim, x: number, y: number): boolean => (sim.world.bFlags[slotAt(sim, x, y)]! & BFLAG.UNWATERED) !== 0;

const R1 = rciId(1, 0, 1), I1 = rciId(3, 0, 1), I_BIG = rciId(3, 2, 3);

/** Plant at (100,100); a power line along y = 102 from x = 104 to 130; one house under the line at each x in `xs`. */
function lineCity(xs: number[]): Sim {
  const sim = flatSim();
  place(sim, ARCH.POWER_PLANT, 100, 100);
  lay(sim, 'power', 104, 102, 130, 102);
  for (const x of xs) grow(sim, x, 103, R1);
  return sim;
}

describe('power network', () => {
  it('cutting a power line darkens exactly the downstream buildings', () => {
    const xs = [106, 110, 116, 120, 126];
    const sim = lineCity(xs);
    solveUtilities(sim);
    expect(xs.filter((x) => unpowered(sim, x, 103))).toEqual([]);
    expect(unpowered(sim, 100, 100)).toBe(false);

    must(run(sim, { type: 'bulldoze', x0: 114, y0: 102, x1: 114, y1: 102 }), 'cut');
    solveUtilities(sim);
    expect(xs.filter((x) => unpowered(sim, x, 103))).toEqual([116, 120, 126]);
    expect(xs.filter((x) => !unpowered(sim, x, 103))).toEqual([106, 110]);
    // The tile layer follows: the live side carries power, the cut-off side none.
    const on = (x: number, y: number): number => sim.world.powerOn[y * MAP + x]!;
    expect([on(108, 102), on(113, 102), on(115, 102), on(120, 102), on(116, 103)]).toEqual([1, 1, 0, 0, 3]);

    lay(sim, 'power', 114, 102, 114, 102);
    solveUtilities(sim);
    expect(xs.filter((x) => unpowered(sim, x, 103))).toEqual([]);
  });

  it('runs the same solve from the tick system, every UTIL_PERIOD ticks', () => {
    const sim = lineCity([106, 120]);
    expect(unpowered(sim, 106, 103)).toBe(false);
    must(run(sim, { type: 'bulldoze', x0: 105, y0: 102, x1: 105, y1: 102 }), 'cut');
    runTicks(sim, 5);
    expect(unpowered(sim, 106, 103)).toBe(true);
    expect(unpowered(sim, 120, 103)).toBe(true);
    expect(sim.world.scalars[S.grid]! & GRID_POWER).toBe(GRID_POWER);
    expect(sim.utils!.unpowered).toBe(2);
  });

  it('conducts through touching buildings but not through roads, gaps or diagonals', () => {
    const sim = flatSim();
    place(sim, ARCH.POWER_PLANT, 100, 100);
    grow(sim, 104, 100, R1);
    grow(sim, 105, 100, R1);
    grow(sim, 107, 100, R1);
    grow(sim, 106, 105, R1);
    setRoads(sim.world, [[106, 100], [106, 101]]);
    solveUtilities(sim);
    expect(unpowered(sim, 104, 100)).toBe(false);
    expect(unpowered(sim, 105, 100)).toBe(false);
    expect(unpowered(sim, 107, 100), 'a road tile in the gap does not conduct').toBe(true);
    expect(unpowered(sim, 106, 105), 'a building two tiles away is not adjacent').toBe(true);
    grow(sim, 108, 101, R1);
    solveUtilities(sim);
    expect(unpowered(sim, 108, 101), 'a diagonal neighbour of a dark building stays dark').toBe(true);
    lay(sim, 'power', 106, 100, 106, 100);
    solveUtilities(sim);
    expect(unpowered(sim, 107, 100), 'a line tile bridges the gap').toBe(false);
  });

  it('browns out by priority: services first, then houses and businesses by slot, as a prefix', () => {
    const build = (): Sim => {
      const sim = flatSim();
      place(sim, ARCH.POWER_PLANT, 100, 100);
      grow(sim, 104, 100, I_BIG);
      grow(sim, 104, 103, I_BIG);
      grow(sim, 104, 106, I_BIG);
      grow(sim, 107, 100, I1);
      place(sim, ARCH.FIRE_STATION, 100, 104);
      return sim;
    };
    const sim = build();
    solveUtilities(sim);
    // Supply 120. Fire station (3) first; then the three 80 MW buildings in slot order: 3 + 80 fits, 160 does not and cuts
    // the rest of the network, including the 2 MW house in the last RCI slot that would still have fitted on its own.
    expect(unpowered(sim, 100, 104)).toBe(false);
    expect(unpowered(sim, 104, 100)).toBe(false);
    expect(unpowered(sim, 104, 103)).toBe(true);
    expect(unpowered(sim, 104, 106)).toBe(true);
    expect(unpowered(sim, 107, 100)).toBe(true);
    expect(sim.utils!.power).toEqual({ supply: PLANT_MW, demand: 3 + 80 * 3 + 2 });
    expect(sim.utils!.unpowered).toBe(3);
    expect(sim.world.powerOn[100 * MAP + 100]).toBe(2);

    const again = build();
    solveUtilities(again);
    expect(Array.from(again.world.bFlags)).toEqual(Array.from(sim.world.bFlags));
    expect(stateHash(again)).toBe(stateHash(sim));

    // A second plant on the same network lifts the cut to 240 MW: the second big building now fits, the third (3 + 240 > 240)
    // and everything after it in slot order, the 2 MW house included, stays dark.
    place(sim, ARCH.POWER_PLANT, 108, 100);
    solveUtilities(sim);
    expect(sim.utils!.power.supply).toBe(2 * PLANT_MW);
    expect(sim.utils!.unpowered).toBe(2);
    expect(unpowered(sim, 104, 103)).toBe(false);
    expect(unpowered(sim, 104, 106)).toBe(true);
    expect(unpowered(sim, 107, 100)).toBe(true);
  });

  it('serves a service building ahead of an earlier-slot house when supply is short', () => {
    const sim = flatSim();
    place(sim, ARCH.POWER_PLANT, 100, 100);
    for (let k = 0; k < 2; k++) grow(sim, 104, 100 + k * 3, I_BIG);
    grow(sim, 104, 106, I_BIG);
    place(sim, ARCH.DEPOT, 100, 104);
    solveUtilities(sim);
    expect(unpowered(sim, 100, 104)).toBe(false);
    expect(unpowered(sim, 104, 100)).toBe(false);
    expect(unpowered(sim, 104, 103)).toBe(true);
  });

  it('models nothing until a FINISHED producer exists: a lone line tile or an unfinished plant site leaves the city lit', () => {
    const sim = flatSim();
    grow(sim, 100, 100, R1);
    solveUtilities(sim);
    expect(unpowered(sim, 100, 100)).toBe(false);
    expect(sim.world.scalars[S.grid]).toBe(0);
    lay(sim, 'power', 120, 120, 125, 120);
    lay(sim, 'water', 120, 124, 125, 124);
    solveUtilities(sim);
    expect(unpowered(sim, 100, 100), 'a line with nothing feeding it').toBe(false);
    expect(unwatered(sim, 100, 100), 'a pipe with nothing feeding it').toBe(false);
    expect(sim.world.scalars[S.grid]).toBe(0);
    expect(sim.utils!.modelled).toEqual({ power: false, water: false });
    grow(sim, 130, 100, ARCH.POWER_PLANT, 0.4);
    grow(sim, 140, 100, ARCH.WATER_PUMP, 0.4);
    solveUtilities(sim);
    expect(unpowered(sim, 100, 100), 'a plant site under construction').toBe(false);
    expect(unwatered(sim, 100, 100), 'a pump site under construction').toBe(false);
    expect(sim.world.scalars[S.grid]).toBe(0);
    place(sim, ARCH.POWER_PLANT, 150, 150);
    solveUtilities(sim);
    expect(unpowered(sim, 100, 100), 'a finished plant switches power on').toBe(true);
    expect(unwatered(sim, 100, 100), 'water is still not modelled').toBe(false);
    expect(sim.utils!.modelled).toEqual({ power: true, water: false });
    expect(sim.world.scalars[S.grid]! & GRID_POWER).toBe(GRID_POWER);
    must(run(sim, { type: 'bulldoze', x0: 150, y0: 150, x1: 153, y1: 153 }), 'remove the plant');
    solveUtilities(sim);
    expect(unpowered(sim, 100, 100), 'back to an unmodelled grid').toBe(false);
    expect(sim.world.scalars[S.grid]! & GRID_POWER).toBe(0);
    expect(sim.world.powerOn.every((v) => v === 0)).toBe(true);
  });

  it('gives an overlap of two water networks to the lower network id, even when that network is dry', () => {
    const sim = flatSim();
    // Network 1: a pipe down x = 200 from y = 10 with no pump (lowest tile index, so id 1). Network 2: a pump and a pipe at y = 98.
    lay(sim, 'water', 200, 10, 200, 112);
    place(sim, ARCH.WATER_PUMP, 208, 96);
    lay(sim, 'water', 206, 98, 210, 98);
    grow(sim, 203, 100, R1);
    grow(sim, 211, 100, R1);
    solveUtilities(sim);
    expect(unwatered(sim, 203, 100), 'reached by both networks: the lower id wins and has no water').toBe(true);
    expect(unwatered(sim, 211, 100), 'reached only by the pumped network').toBe(false);
    const again = flatSim();
    lay(again, 'water', 200, 10, 200, 112);
    place(again, ARCH.WATER_PUMP, 208, 96);
    lay(again, 'water', 206, 98, 210, 98);
    grow(again, 203, 100, R1);
    grow(again, 211, 100, R1);
    solveUtilities(again);
    expect(Array.from(again.world.waterOn)).toEqual(Array.from(sim.world.waterOn));
  });
});

describe('solar output', () => {
  it('follows the time of day and the weather', () => {
    expect(sunQ(0)).toBe(0);
    expect(sunQ(0.25)).toBe(0);
    expect(sunQ(0.75)).toBe(0);
    expect(sunQ(0.5)).toBe(1024);
    expect(sunQ(0.375)).toBe(768);
    expect(sunQ(0.4)).toBeLessThan(sunQ(0.45));
    expect(sunQ(0.6)).toBe(sunQ(0.4));

    const sim = flatSim();
    const w = sim.world, s = w.scalars;
    s[S.weather] = WEATHER.CLEAR; s[S.weatherIntensity] = 0;
    const at = (f: number): number => { s[S.dayFrac] = f; return solarOutput(w); };
    expect([at(0), at(0.25), at(0.375), at(0.5), at(0.9)]).toEqual([0, 0, 45, SOLAR_PEAK_MW, 0]);
    s[S.dayFrac] = 0.5;
    s[S.weather] = WEATHER.RAIN; s[S.weatherIntensity] = 1;
    expect(solarOutput(w)).toBe(30);
    s[S.weather] = WEATHER.STORM; s[S.weatherIntensity] = 1;
    expect(solarOutput(w)).toBe(11);
    s[S.weather] = WEATHER.RAIN; s[S.weatherIntensity] = 0.5;
    expect(solarOutput(w)).toBeGreaterThan(30);
    expect(solarOutput(w)).toBeLessThan(SOLAR_PEAK_MW);
    expect(weatherQ(WEATHER.CLEAR, 1)).toBe(1024);
  });

  it('powers buildings at noon and leaves them dark at night', () => {
    const sim = flatSim();
    place(sim, ARCH.SOLAR_FARM, 100, 100);
    grow(sim, 104, 100, rciId(3, 1, 2));
    const s = sim.world.scalars;
    s[S.weather] = WEATHER.CLEAR; s[S.weatherIntensity] = 0;
    s[S.dayFrac] = 0.5;
    solveUtilities(sim);
    expect(sim.utils!.power.supply).toBe(SOLAR_PEAK_MW);
    expect(unpowered(sim, 104, 100)).toBe(false);
    s[S.dayFrac] = 0.1;
    solveUtilities(sim);
    expect(sim.utils!.power.supply).toBe(0);
    expect(unpowered(sim, 104, 100)).toBe(true);
    s[S.dayFrac] = 0.5;
    s[S.weather] = WEATHER.STORM; s[S.weatherIntensity] = 1;
    solveUtilities(sim);
    expect(sim.utils!.power.supply).toBe(11);
    expect(unpowered(sim, 104, 100), 'an 18 MW building does not fit in 11 MW').toBe(true);
  });

  it('does not count a plant that is still under construction', () => {
    const sim = flatSim();
    grow(sim, 100, 100, ARCH.POWER_PLANT, 0.5);
    grow(sim, 104, 100, R1);
    solveUtilities(sim);
    expect(sim.utils!.power.supply).toBe(0);
    expect(unpowered(sim, 104, 100), 'an unfinished plant does not switch power on, so nothing is dark').toBe(false);
    expect(sim.utils!.modelled.power).toBe(false);
  });
});

describe('water network', () => {
  function lakeSim(): Sim {
    const sim = flatSim();
    const w = sim.world;
    for (let y = 50; y < 62; y++) for (let x = 50; x < 62; x++) { w.terrain[y * MAP + x] = TERRAIN.WATER; w.waterDepth[y * MAP + x] = 16; }
    return sim;
  }

  it('a pump beside water yields far more than one on dry ground', () => {
    const sim = lakeSim();
    place(sim, ARCH.WATER_PUMP, 62, 52);
    place(sim, ARCH.WATER_PUMP, 150, 150);
    place(sim, ARCH.WATER_PUMP, 64, 70);
    const w = sim.world;
    expect(pumpOutput(w, slotAt(sim, 62, 52))).toBe(PUMP_NEAR_ML);
    expect(pumpOutput(w, slotAt(sim, 150, 150))).toBe(PUMP_INLAND_ML);
    expect(pumpOutput(w, slotAt(sim, 64, 70))).toBe(PUMP_INLAND_ML);
    expect(PUMP_NEAR_ML).toBeGreaterThan(PUMP_INLAND_ML * 2);
    solveUtilities(sim);
    expect(sim.utils!.water.supply).toBe(PUMP_NEAR_ML + 2 * PUMP_INLAND_ML);
  });

  it('serves buildings within WATER_REACH tiles of a pipe and no further', () => {
    expect(WATER_REACH).toBe(3);
    const sim = flatSim();
    place(sim, ARCH.WATER_PUMP, 150, 150);
    lay(sim, 'water', 152, 150, 170, 150);
    grow(sim, 160, 153, R1);
    grow(sim, 165, 147, R1);
    grow(sim, 160, 154, R1);
    grow(sim, 168, 145, R1);
    solveUtilities(sim);
    const w = sim.world;
    expect(unwatered(sim, 160, 153), 'three tiles below the pipe').toBe(false);
    expect(unwatered(sim, 165, 147), 'three tiles above the pipe').toBe(false);
    expect(unwatered(sim, 160, 154), 'four tiles below').toBe(true);
    expect(unwatered(sim, 168, 145), 'five tiles above').toBe(true);
    expect([w.waterOn[153 * MAP + 160], w.waterOn[154 * MAP + 160], w.waterOn[150 * MAP + 171], w.waterOn[150 * MAP + 173], w.waterOn[150 * MAP + 174]]).toEqual([1, 3, 1, 1, 0]);
    expect(sim.utils!.unwatered).toBe(2);
  });

  it('a building needs the pipe to connect to a pump: a pipe alone, or a gap, gives nothing', () => {
    const sim = flatSim();
    place(sim, ARCH.WATER_PUMP, 150, 150);
    lay(sim, 'water', 154, 150, 160, 150);
    grow(sim, 157, 152, R1);
    solveUtilities(sim);
    expect(unwatered(sim, 157, 152), 'one tile of gap between pump and pipe').toBe(true);
    lay(sim, 'water', 152, 150, 153, 150);
    solveUtilities(sim);
    expect(unwatered(sim, 157, 152)).toBe(false);
  });

  it('a tower adds capacity only to a network that has a running pump', () => {
    const sim = flatSim();
    place(sim, ARCH.WATER_TOWER, 100, 100);
    solveUtilities(sim);
    expect(sim.utils!.water.supply).toBe(0);
    place(sim, ARCH.WATER_PUMP, 102, 100);
    solveUtilities(sim);
    expect(sim.utils!.water.supply).toBe(PUMP_INLAND_ML + TOWER_ML);
  });

  it('browns out water the same way, and lowers land value and lot score where it is missing', () => {
    const sim = flatSim();
    place(sim, ARCH.WATER_PUMP, 150, 150);
    lay(sim, 'water', 152, 150, 156, 150);
    // 24 ML inland: two 18 ML buildings cannot both be served, the lower slot wins.
    grow(sim, 152, 152, rciId(1, 2, 2));
    grow(sim, 156, 152, rciId(1, 2, 2));
    grow(sim, 100, 100, R1);
    solveUtilities(sim);
    expect(unwatered(sim, 152, 152)).toBe(false);
    expect(unwatered(sim, 156, 152)).toBe(true);
    expect(unwatered(sim, 100, 100)).toBe(true);
    expect(sim.world.waterOn[152 * MAP + 152]).toBe(2);

    const dry = landValueAt(sim.world, 100, 100);
    sim.world.waterOn[100 * MAP + 100] = 1;
    expect(landValueAt(sim.world, 100, 100) - dry).toBe(LV_NO_WATER);
    const idle = flatSim();
    expect(idle.world.scalars[S.grid]).toBe(0);
    expect(landValueAt(idle.world, 100, 100), 'no water penalty before water is modelled').toBe(landValueAt(sim.world, 100, 100));
  });
});

describe('economy effects', () => {
  it('an unpowered building gives no residents and no jobs', () => {
    const sim = flatSim();
    place(sim, ARCH.POWER_PLANT, 100, 100);
    lay(sim, 'power', 104, 102, 112, 102);
    grow(sim, 106, 103, R1);
    grow(sim, 110, 103, I1);
    solveUtilities(sim);
    expect(countTotals(sim.world)).toMatchObject({ population: 6, jobsI: 6 });
    must(run(sim, { type: 'bulldoze', x0: 108, y0: 102, x1: 108, y1: 102 }), 'cut');
    solveUtilities(sim);
    expect(countTotals(sim.world)).toMatchObject({ population: 6, jobsI: 0 });
    refreshTotals(sim.world);
    expect(sim.world.scalars[S.jobsI]).toBe(0);
    must(run(sim, { type: 'bulldoze', x0: 104, y0: 102, x1: 104, y1: 102 }), 'cut again');
    solveUtilities(sim);
    expect(countTotals(sim.world)).toMatchObject({ population: 0, jobsI: 0 });
  });

  it('gates growth: level-ups skip a building the water misses; lots with no reachable service score lower', () => {
    const sim = flatSim();
    const w = sim.world;
    place(sim, ARCH.POWER_PLANT, 100, 100);
    place(sim, ARCH.WATER_PUMP, 100, 106);
    lay(sim, 'water', 102, 107, 112, 107);
    lay(sim, 'power', 104, 103, 108, 104);
    grow(sim, 104, 100, R1);
    grow(sim, 106, 100, R1);
    grow(sim, 108, 105, R1);
    grow(sim, 108, 110, R1);
    for (const [x, y] of [[104, 100], [106, 100], [108, 105], [108, 110]] as const) w.landValue[y * MAP + x] = 200;
    w.scalars[S.demandR] = 0.8;
    solveUtilities(sim);
    expect(unwatered(sim, 104, 100), 'seven tiles from the pipe').toBe(true);
    expect(unwatered(sim, 108, 105), 'two tiles from the pipe').toBe(false);
    expect(unpowered(sim, 108, 105), 'touches the end of the power line').toBe(false);
    expect(unpowered(sim, 108, 110), 'not connected to power').toBe(true);
    expect(unwatered(sim, 108, 110), 'three tiles from the pipe').toBe(false);
    // Powered but dry (104,100) and watered but dark (108,110) stay put; only the building with both services may grow.
    expect(levelUpCandidates(sim, ZONE.R, 10).map((c) => `${c.x},${c.y}`)).toEqual(['108,105']);
  });

  it('scores a lot without reachable power or water lower once the city models them, and not before', () => {
    const roads = Array.from({ length: 20 }, (_, k) => [90 + k, 120, 1] as const);
    const modelled = flatSim();
    setRoads(modelled.world, roads);
    place(modelled, ARCH.POWER_PLANT, 20, 20);
    place(modelled, ARCH.WATER_PUMP, 20, 40);
    const idle = flatSim();
    setRoads(idle.world, roads);
    solveUtilities(modelled);
    const lot = (s: Sim): number => lotScore(s, 100, 119, ZONE.R, 1, 1, null)!;
    const base = lot(modelled);
    expect(lot(idle) - base).toBe(LOT_NO_POWER + LOT_NO_WATER);
    modelled.world.powerOn[119 * MAP + 101] = 1;
    expect(lot(idle) - lot(modelled)).toBe(LOT_NO_WATER);
    modelled.world.waterOn[119 * MAP + 100] = 1;
    expect(lot(modelled)).toBe(lot(idle));
  });
});

describe('placeLine commands', () => {
  it('charges per new tile, skips tiles that already carry the line, and refuses water and (for power) buildings', () => {
    const sim = flatSim();
    const w = sim.world;
    for (let y = 40; y < 50; y++) for (let x = 40; x < 50; x++) { w.terrain[y * MAP + x] = TERRAIN.WATER; w.waterDepth[y * MAP + x] = 16; }
    const t0 = w.scalars[S.treasury]!;
    lay(sim, 'power', 100, 100, 109, 100);
    expect(t0 - w.scalars[S.treasury]!).toBe(10 * POWER_LINE_COST);
    lay(sim, 'power', 105, 100, 112, 100);
    expect(t0 - w.scalars[S.treasury]!).toBe(13 * POWER_LINE_COST);
    expect(run(sim, { type: 'placeLine', kind: 'power', ax: 100, ay: 100, bx: 105, by: 100 }).reason).toBe('noop');
    const t1 = w.scalars[S.treasury]!;
    lay(sim, 'water', 100, 100, 104, 100);
    expect(t1 - w.scalars[S.treasury]!).toBe(5 * PIPE_COST);
    expect(w.ugPower[100 * MAP + 100], 'power and water share a tile').toBe(1);
    expect(w.ugWater[100 * MAP + 100]).toBe(1);

    expect(run(sim, { type: 'placeLine', kind: 'water', ax: 38, ay: 45, bx: 52, by: 45 }).reason).toBe('terrain');
    expect(w.ugWater[45 * MAP + 38]).toBe(0);
    grow(sim, 130, 130, R1);
    expect(run(sim, { type: 'placeLine', kind: 'power', ax: 128, ay: 130, bx: 132, by: 130 }).reason).toBe('blocked');
    expect(run(sim, { type: 'placeLine', kind: 'water', ax: 128, ay: 130, bx: 132, by: 130 }).ok, 'a pipe may pass under a building').toBe(true);
    expect(run(sim, { type: 'placeLine', kind: 'steam' as never, ax: 1, ay: 1, bx: 2, by: 1 }).reason).toBe('invalid');
    expect(run(sim, { type: 'placeLine', kind: 'power', ax: -1, ay: 1, bx: 2, by: 1 }).reason).toBe('bounds');
    w.scalars[S.treasury] = 10;
    expect(run(sim, { type: 'placeLine', kind: 'power', ax: 20, ay: 20, bx: 30, by: 20 }).reason).toBe('funds');
  });

  it('refuses to put a building on a power line, and growth skips lines', () => {
    const sim = flatSim();
    lay(sim, 'power', 100, 100, 104, 100);
    expect(run(sim, { type: 'placeBuilding', arch: ARCH.DEPOT, x: 102, y: 99, rot: 0 }).reason).toBe('blocked');
    expect(run(sim, { type: 'placeBuilding', arch: ARCH.DEPOT, x: 102, y: 101, rot: 0 }).ok).toBe(true);
  });

  it('refuses to terraform ground that carries a power line or a pipe, and allows it once they are gone', () => {
    const sim = flatSim();
    lay(sim, 'power', 100, 100, 104, 100);
    lay(sim, 'water', 110, 100, 114, 100);
    for (const x of [102, 112]) {
      const body = { type: 'terraform', mode: 'raise', x0: x, y0: 99, x1: x, y1: 101 } as const;
      expect(estimate(sim.world, body).reason).toBe('blocked');
      expect(run(sim, body).reason).toBe('blocked');
    }
    must(run(sim, { type: 'bulldoze', x0: 102, y0: 100, x1: 102, y1: 100 }), 'remove the line tile');
    expect(run(sim, { type: 'terraform', mode: 'raise', x0: 102, y0: 99, x1: 102, y1: 101 }).ok).toBe(true);
  });

  it('refuses the locked fusion reactor', () => {
    const sim = flatSim();
    expect(CATALOG.find((a) => a.id === ARCH.FUSION_REACTOR)!.locked).toBe(true);
    expect(run(sim, { type: 'placeBuilding', arch: ARCH.FUSION_REACTOR, x: 100, y: 100, rot: 0 }).reason).toBe('locked');
    expect(estimate(sim.world, { type: 'placeBuilding', arch: ARCH.FUSION_REACTOR, x: 100, y: 100, rot: 0 }).reason).toBe('locked');
  });

  it('undoes a line: tiles and cost restored; refuses once the line was changed', () => {
    const sim = flatSim();
    const w = sim.world;
    const t0 = w.scalars[S.treasury]!;
    const j = lay(sim, 'power', 100, 100, 110, 100);
    expect(j).toBeGreaterThan(0);
    expect(w.ugPower[100 * MAP + 105]).toBe(1);
    must(run(sim, { type: 'undo', target: j }), 'undo');
    expect(w.ugPower.every((v) => v === 0)).toBe(true);
    expect(w.scalars[S.treasury]).toBe(t0);
    expect(run(sim, { type: 'undo', target: j }).reason).toBe('not-undoable');

    const k = lay(sim, 'water', 100, 100, 110, 100);
    lay(sim, 'power', 100, 100, 110, 100);
    must(run(sim, { type: 'undo', target: k }), 'undoing the pipe leaves the power line alone');
    expect(w.ugWater[100 * MAP + 105]).toBe(0);
    expect(w.ugPower[100 * MAP + 105]).toBe(1);

    const m = lay(sim, 'water', 120, 120, 125, 120);
    must(run(sim, { type: 'bulldoze', x0: 122, y0: 120, x1: 122, y1: 120, under: true }), 'dig up a pipe tile');
    expect(w.ugWater[120 * MAP + 122]).toBe(0);
    expect(run(sim, { type: 'undo', target: m }).reason).toBe('consumed');
  });

  it('bulldozes power lines on the surface and pipes only underground', () => {
    const sim = flatSim();
    const w = sim.world;
    lay(sim, 'power', 100, 100, 110, 100);
    lay(sim, 'water', 100, 100, 110, 100);
    must(run(sim, { type: 'bulldoze', x0: 100, y0: 100, x1: 104, y1: 100 }), 'surface');
    expect([w.ugPower[100 * MAP + 102], w.ugWater[100 * MAP + 102], w.ugPower[100 * MAP + 106]]).toEqual([0, 1, 1]);
    must(run(sim, { type: 'bulldoze', x0: 100, y0: 100, x1: 104, y1: 100, under: true }), 'underground');
    expect([w.ugWater[100 * MAP + 102], w.ugWater[100 * MAP + 106]]).toEqual([0, 1]);
    expect(run(sim, { type: 'bulldoze', x0: 100, y0: 100, x1: 104, y1: 100, under: true }).reason).toBe('noop');
  });

  it('sends line edits with the immediate chunk patch, not the throttled overlay one', () => {
    const sim = flatSim();
    collectOutgoing(sim);
    lay(sim, 'power', 100, 100, 104, 100);
    const out = collectOutgoing(sim);
    const patch = out.find((m) => m.type === 'chunkPatch');
    expect(patch && Object.keys(patch.layers)).toContain('ugPower');
    expect(patch && Object.keys(patch.layers)).toContain('ugWater');
    expect(out.some((m) => m.type === 'overlayPatch')).toBe(false);
  });
});

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Whole-array equality without the matcher's per-element cost on 65k-entry arrays. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

describe('estimate matches the sim for placeLine and underground bulldoze', () => {
  const base = ((): Sim => {
    const sim = flatSim();
    const w = sim.world;
    for (let y = 40; y < 52; y++) for (let x = 40; x < 52; x++) { w.terrain[y * MAP + x] = TERRAIN.WATER; w.waterDepth[y * MAP + x] = 16; }
    place(sim, ARCH.DEPOT, 60, 100);
    place(sim, ARCH.POWER_PLANT, 80, 60);
    lay(sim, 'power', 70, 70, 90, 70);
    lay(sim, 'water', 70, 72, 70, 90);
    return sim;
  })();
  const shared = flatSim();
  /** The shared sim put back to the base map; the journal layers are left alone, nothing here reads them. */
  function world(): Sim {
    for (const l of REGISTRY) if (!l.name.startsWith('j')) (shared.world[l.name] as unknown as { set(a: ArrayLike<number>): void }).set(base.world[l.name] as ArrayLike<number>);
    shared.events = [];
    return shared;
  }

  it('agrees on reason, cost and changed tiles over seeded random commands', () => {
    const rnd = mulberry(909);
    const n = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
    const mirror = new RenderMirror();
    let accepted = 0, refused = 0;
    const reasons = new Set<string>();
    for (let trial = 0; trial < 400; trial++) {
      const sim = world();
      if (trial % 4 === 0) mirror.apply(makeResync(sim.world));
      const x0 = n(30, 110), y0 = n(30, 110);
      const body: CommandBody = trial % 5 === 4
        ? { type: 'bulldoze', x0, y0, x1: x0 + n(0, 8), y1: y0 + n(0, 8), under: rnd() < 0.5 }
        : { type: 'placeLine', kind: rnd() < 0.5 ? 'power' : 'water', ax: x0, ay: y0, bx: x0 + n(-10, 14), by: y0 + n(-10, 14) };
      const treasury = trial % 6 === 0 ? 60 : 1_000_000;
      sim.world.scalars[S.treasury] = treasury;
      const est = estimate(sim.world, body, treasury);
      if (trial % 4 === 0) expect(estimate(tileReadOf(mirror.layers), body, treasury), 'mirror agrees with world').toEqual(est);
      const beforeP = sim.world.ugPower.slice(), beforeW = sim.world.ugWater.slice();
      const got = run(sim, body);
      expect(got.ok, JSON.stringify(body)).toBe(!est.reason);
      if (est.reason) {
        expect(got.reason).toBe(est.reason);
        expect(sameBytes(sim.world.ugPower, beforeP) && sameBytes(sim.world.ugWater, beforeW), `${JSON.stringify(body)} rejected but changed a layer`).toBe(true);
        expect(sim.world.scalars[S.treasury]).toBe(treasury);
        reasons.add(est.reason);
        refused++;
      } else {
        accepted++;
        expect(treasury - sim.world.scalars[S.treasury]!).toBe(est.cost);
        // The tiles the estimate lists are exactly the tiles of the touched layer that changed (a surface bulldoze also clears
        // roads, zones and buildings, so only the pipe and line commands are compared tile for tile).
        const touched = body.type === 'placeLine' && body.kind === 'power' ? 'ugPower' : 'ugWater';
        if (body.type === 'placeLine' || body.under) {
          const before = touched === 'ugPower' ? beforeP : beforeW;
          const changed = new Set<number>();
          for (let i = 0; i < before.length; i++) if (sim.world[touched][i] !== before[i]) changed.add(i);
          expect(changed, JSON.stringify(body)).toEqual(new Set(est.validTiles));
        }
      }
    }
    expect(accepted).toBeGreaterThan(100);
    expect(refused).toBeGreaterThan(30);
    for (const r of ['terrain', 'noop', 'funds']) expect([...reasons]).toContain(r);
  }, 60000);
});

describe('determinism with utilities', () => {
  function scripted(): Sim {
    const sim = flatSim();
    const w = sim.world;
    for (let y = 70; y < 80; y++) for (let x = 90; x < 100; x++) { w.terrain[y * MAP + x] = TERRAIN.WATER; w.waterDepth[y * MAP + x] = 16; }
    const at = (tick: number, body: CommandBody): void => apply(sim, { ...body, id: nextId++, tick } as Command);
    at(0, { type: 'placeBuilding', arch: ARCH.POWER_PLANT, x: 100, y: 100, rot: 0 });
    at(0, { type: 'placeBuilding', arch: ARCH.SOLAR_FARM, x: 100, y: 104, rot: 0 });
    at(0, { type: 'placeBuilding', arch: ARCH.WATER_PUMP, x: 100, y: 80, rot: 0 });
    at(1, { type: 'placeLine', kind: 'power', ax: 104, ay: 102, bx: 130, by: 102 });
    at(1, { type: 'placeLine', kind: 'water', ax: 102, ay: 81, bx: 102, by: 100 });
    at(1, { type: 'placeLine', kind: 'water', ax: 102, ay: 100, bx: 130, by: 100 });
    // Two 80 MW buildings: 160 MW is more than the plant alone (120) but within plant plus a clear noon sun (180).
    for (let k = 0; k < 8; k++) at(2, { type: 'debugGrow', x: 106 + k * 3, y: 103, archetype: k === 1 || k === 4 ? I_BIG : R1, progress: 1 });
    at(300, { type: 'bulldoze', x0: 118, y0: 102, x1: 118, y1: 102 });
    at(500, { type: 'placeLine', kind: 'power', ax: 118, ay: 102, bx: 118, by: 102 });
    return sim;
  }

  it('gives the same hash from two runs and across a snapshot resume', () => {
    const a = scripted(), b = scripted();
    runTicks(a, 1200);
    runTicks(b, 1200);
    expect(stateHash(a)).toBe(stateHash(b));
    expect(a.world.scalars[S.grid]).toBe(GRID_POWER | GRID_WATER);

    const first = scripted();
    runTicks(first, 603);
    const rest = restore(snapshot(first));
    rest.debug = true;
    rest.queue = first.queue.slice();
    expect(stateHash(rest)).toBe(stateHash(first));
    runTicks(rest, 597);
    expect(stateHash(rest)).toBe(stateHash(a));
    expect(Array.from(rest.world.bFlags)).toEqual(Array.from(a.world.bFlags));
    expect(Array.from(rest.world.powerOn)).toEqual(Array.from(a.world.powerOn));
  });

  it('darkens the far side of a queued cut within one solve period and restores it when the line is repaired', () => {
    const sim = lineCity([106, 110, 116, 120, 126]);
    const dark = (): number => sim.world.bArch.reduce((n, a, s) => n + (a !== 0 && (sim.world.bFlags[s]! & BFLAG.UNPOWERED) !== 0 ? 1 : 0), 0);
    apply(sim, { id: nextId++, tick: 20, type: 'bulldoze', x0: 114, y0: 102, x1: 114, y1: 102 });
    apply(sim, { id: nextId++, tick: 120, type: 'placeLine', kind: 'power', ax: 114, ay: 102, bx: 114, by: 102 });
    runTicks(sim, 10);
    expect(dark()).toBe(0);
    runTicks(sim, 15);
    expect(dark()).toBe(3);
    runTicks(sim, 80);
    expect(dark()).toBe(3);
    runTicks(sim, 35);
    expect(dark()).toBe(0);
  });
});

describe('registry', () => {
  it('declares the utilities layers and the line layers travel with the geometry patch', () => {
    const byName = new Map(REGISTRY.map((l) => [l.name as string, l]));
    for (const n of ['ugPower', 'ugWater']) expect(byName.get(n)).toMatchObject({ render: true, dirty: 'geometry' });
    for (const n of ['powerOn', 'waterOn']) expect(byName.get(n)).toMatchObject({ render: true, dirty: 'overlay' });
    for (const n of ['jPrevUg', 'jPostUg']) expect(byName.get(n)).toMatchObject({ render: false });
  });

  it('classifies every catalog archetype: RCI buildings consume, utility buildings produce, nothing is both', () => {
    for (const a of CATALOG) {
      if (isRci(a.id)) {
        expect(powerUseOf(a.id), a.name).toBeGreaterThan(0);
        expect(waterUseOf(a.id), a.name).toBeGreaterThan(0);
        expect(producerKind(a.id), a.name).toBe(0);
      } else if (a.utility === 'power') {
        expect(isPowerProducer(a.id), a.name).toBe(true);
        expect([powerUseOf(a.id), waterUseOf(a.id)], a.name).toEqual([0, 0]);
      } else if (a.utility === 'water') {
        expect(isWaterSource(a.id), a.name).toBe(true);
        expect([powerUseOf(a.id), waterUseOf(a.id)], a.name).toEqual([0, 0]);
      } else {
        expect(isPowerProducer(a.id) || isWaterSource(a.id), a.name).toBe(false);
      }
    }
    expect(powerUseOf(ARCH.FIRE_STATION)).toBeGreaterThan(0);
    expect(CATALOG.filter((a) => a.locked).map((a) => a.name)).toEqual(['fusionReactor']);
  });
});
