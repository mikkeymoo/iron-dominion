import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARCH, BFLAG, rciId } from './catalog.ts';
import { createSim, restore, snapshot, stateHash, step } from './engine.ts';
import { DAY_TICKS, H, HAZ, MAP, S, WEATHER, type World } from './layers.ts';
import { flatSim, run } from './robots/testkit.ts';
import { SYSTEMS } from './tick.ts';
import {
  SEASON, SEASON_DAYS, SEASON_NAMES, WEATHER_ODDS, YEAR_DAYS, climate16, climateQ16, daylightOf, dayOfYear, hazardSolarQ, seasonOf, seasonOfDay, sunHeightQ,
  sunTimes, weatherFor, yearPosition,
} from './seasons.ts';
import { BATTERY_CAP, BATTERY_CHARGE_MW, BATTERY_MW, PLANT_MW, SOLAR_PEAK_MW, solarOutput, solveUtilities, sunQ } from './utilities/index.ts';
import type { Sim } from './world.ts';

vi.setConfig({ testTimeout: 120000 });
afterEach(() => new Promise<void>((r) => { setTimeout(r, 0); }));

describe('the calendar', () => {
  it('has four seasons of six days, spring first, and the year repeats', () => {
    expect(SEASON_DAYS).toBe(6);
    expect(YEAR_DAYS).toBe(24);
    const names = (days: number[]): string[] => days.map((d) => SEASON_NAMES[seasonOfDay(d)]!);
    expect(names([0, 5])).toEqual(['Spring', 'Spring']);
    expect(names([6, 11])).toEqual(['Summer', 'Summer']);
    expect(names([12, 17])).toEqual(['Autumn', 'Autumn']);
    expect(names([18, 23])).toEqual(['Winter', 'Winter']);
    expect([24, 30, 36, 42, 48].map(seasonOfDay)).toEqual([SEASON.SPRING, SEASON.SUMMER, SEASON.AUTUMN, SEASON.WINTER, SEASON.SPRING]);
    expect(dayOfYear(25)).toBe(1);
    expect(dayOfYear(-1)).toBe(23);
    expect(yearPosition(30, 0.25)).toBeCloseTo(6.25, 12);
  });

  it('opens a new city on the first day of spring and walks through the seasons as the days pass', () => {
    const sim = createSim(5);
    expect(seasonOf(sim.world)).toBe(SEASON.SPRING);
    expect(sim.world.scalars[S.season]).toBeCloseTo(0.3, 12);
    const seen: number[] = [];
    let ticks = 0;
    for (let day = 1; day <= 25; day++) {
      // Jump the clock to the last tick of the previous day and step across midnight (the full year is 115,200 ticks).
      sim.world.scalars[S.tickOfDay] = DAY_TICKS - 2;
      while (sim.world.scalars[S.day]! < day) { step(sim); ticks++; }
      seen.push(seasonOf(sim.world));
      expect(sim.world.scalars[S.season]).toBeCloseTo(dayOfYear(day) + sim.world.scalars[S.dayFrac]!, 12);
    }
    expect(ticks).toBeLessThan(200);
    expect(seen.slice(0, 5)).toEqual([0, 0, 0, 0, 0]);
    expect(seen.slice(5, 11)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(seen.slice(11, 17)).toEqual([2, 2, 2, 2, 2, 2]);
    expect(seen.slice(17, 23)).toEqual([3, 3, 3, 3, 3, 3]);
    expect(seen.slice(23)).toEqual([0, 0]);
  });
});

describe('weather by season', () => {
  it('has odds that sum to 100 in every season, no snow in summer and mostly snow in winter', () => {
    for (const row of WEATHER_ODDS) expect(row.reduce((a, b) => a + b, 0)).toBe(100);
    expect(WEATHER_ODDS[SEASON.SUMMER]![2]).toBe(0);
    expect(WEATHER_ODDS[SEASON.WINTER]![2]).toBeGreaterThan(WEATHER_ODDS[SEASON.WINTER]![0]!);
  });

  it('maps every roll to the table: counts over all 100 rolls equal the odds', () => {
    for (let season = 0; season < 4; season++) {
      const counts = [0, 0, 0, 0];
      for (let r = 0; r < 100; r++) counts[weatherFor(season, r)]!++;
      expect(counts).toEqual([...WEATHER_ODDS[season]!]);
    }
  });

  it('rolls the weather by the season the sim is in: storms in summer, snow in winter, rain in spring and autumn', () => {
    // The clock-and-weather system of the fixed order, run on its own so thousands of rolls cost milliseconds.
    const clockWeather = SYSTEMS.find((s) => s.name === 'clockWeather')!.run;
    const sample = (season: number): number[] => {
      const sim = createSim(77);
      const s = sim.world.scalars;
      s[S.day] = season * SEASON_DAYS + 1;
      const counts = [0, 0, 0, 0];
      for (let i = 0; i < 4000; i++) {
        s[S.weatherTimer] = 1;
        s[S.tickOfDay] = 100;
        clockWeather(sim);
        counts[s[S.weather]!]!++;
        sim.events = [];
      }
      return counts;
    };
    const share = (c: number[], k: number): number => c[k]! / 4000;
    const [spring, summer, autumn, winter] = [0, 1, 2, 3].map(sample) as [number[], number[], number[], number[]];
    expect(summer[WEATHER.SNOW]).toBe(0);
    expect(share(summer, WEATHER.STORM)).toBeGreaterThan(0.2);
    expect(share(summer, WEATHER.STORM)).toBeGreaterThan(share(spring, WEATHER.STORM) * 2);
    expect(share(summer, WEATHER.STORM)).toBeGreaterThan(share(autumn, WEATHER.STORM) * 2);
    expect(share(winter, WEATHER.SNOW)).toBeGreaterThan(0.45);
    expect(share(winter, WEATHER.SNOW)).toBeGreaterThan(share(spring, WEATHER.SNOW) * 5);
    expect(share(spring, WEATHER.RAIN)).toBeGreaterThan(0.38);
    expect(share(autumn, WEATHER.RAIN)).toBeGreaterThan(0.4);
    expect(share(spring, WEATHER.RAIN)).toBeGreaterThan(share(summer, WEATHER.RAIN) * 2);
    expect(share(winter, WEATHER.RAIN)).toBeLessThan(0.15);
    // Each season's observed odds sit within a few points of its table.
    [spring, summer, autumn, winter].forEach((c, season) => {
      for (let k = 0; k < 4; k++) expect(Math.abs(share(c, k) * 100 - WEATHER_ODDS[season]![k]!)).toBeLessThan(4);
    });
  });
});

describe('day length and the sun', () => {
  it('is half the day at an equinox, longest at the start of summer and shortest at the start of winter', () => {
    expect(daylightOf(0)).toBe(0.5);
    expect(daylightOf(12)).toBe(0.5);
    expect(daylightOf(6)).toBeGreaterThan(0.59);
    expect(daylightOf(18)).toBeLessThan(0.41);
    const days = Array.from({ length: 24 }, (_, d) => daylightOf(d));
    expect(Math.max(...days)).toBe(daylightOf(6));
    expect(Math.min(...days)).toBe(daylightOf(18));
    const t = sunTimes(daylightOf(18));
    expect(t.rise).toBeGreaterThan(0.29);
    expect(t.set).toBeLessThan(0.71);
  });

  it('keeps the equinox sun exactly as it was: the same Q10 values and the same solar output', () => {
    expect(sunQ(0.25)).toBe(0);
    expect(sunQ(0.5)).toBe(1024);
    expect(sunQ(0.375)).toBe(768);
    expect(sunQ(0.375, 0.5)).toBe(768);
    expect(sunQ(0.5, 0.6)).toBe(1024);
  });

  it('moves sunrise and sunset with the season', () => {
    expect(sunQ(0.27, daylightOf(6))).toBeGreaterThan(0);
    expect(sunQ(0.27, daylightOf(0))).toBeGreaterThan(0);
    expect(sunQ(0.27, daylightOf(18))).toBe(0);
    expect(sunQ(0.72, daylightOf(6))).toBeGreaterThan(0);
    expect(sunQ(0.72, daylightOf(18))).toBe(0);
    expect(sunQ(0.32, daylightOf(18))).toBeGreaterThan(0);
  });
});

describe('solar output by season', () => {
  const world = flatSim().world;
  const noon = (day: number, weather: number = WEATHER.CLEAR, hour = 0.5): number => {
    const sim = { world };
    const s = sim.world.scalars;
    s[S.day] = day; s[S.dayFrac] = hour; s[S.weather] = weather; s[S.weatherIntensity] = weather === WEATHER.CLEAR ? 0 : 1;
    return solarOutput(sim.world);
  };

  it('is the plain value at the spring equinox and keeps the old numbers', () => {
    expect(noon(0)).toBe(SOLAR_PEAK_MW);
    expect(noon(0, WEATHER.RAIN)).toBe(30);
    expect(noon(0, WEATHER.STORM)).toBe(11);
  });

  it('is strongest in summer and weakest in winter, at noon', () => {
    const peaks = Array.from({ length: 24 }, (_, d) => noon(d));
    expect(noon(6)).toBeGreaterThan(noon(0));
    expect(noon(0)).toBeGreaterThan(noon(18));
    expect(noon(6)).toBe(70);
    expect(noon(18)).toBe(49);
    expect(Math.max(...peaks)).toBe(noon(6));
    expect(Math.min(...peaks)).toBe(noon(18));
    expect(sunHeightQ(6)).toBeGreaterThan(1024);
    expect(sunHeightQ(18)).toBeLessThan(1024);
  });

  it('gives a winter day fewer hours of sun than a summer one: dawn and dusk are dark in winter', () => {
    expect(noon(6, WEATHER.CLEAR, 0.22)).toBeGreaterThan(0);
    expect(noon(18, WEATHER.CLEAR, 0.22)).toBe(0);
    expect(noon(6, WEATHER.CLEAR, 0.78)).toBeGreaterThan(0);
    expect(noon(18, WEATHER.CLEAR, 0.78)).toBe(0);
    const day = (d: number): number => { let sum = 0; for (let i = 0; i < 480; i++) sum += noon(d, WEATHER.CLEAR, i / 480); return sum; };
    expect(day(6)).toBeGreaterThan(day(0) * 1.3);
    expect(day(18)).toBeLessThan(day(0) * 0.75);
  });

  it('is dimmed by a cold snap', () => {
    const sim = flatSim();
    const s = sim.world.scalars;
    s[S.dayFrac] = 0.5;
    const clear = solarOutput(sim.world);
    sim.world.hazard[H.PHASE] = 2; sim.world.hazard[H.KIND] = HAZ.COLD_SNAP; sim.world.hazard[H.LEVEL] = 1;
    expect(hazardSolarQ(sim.world)).toBeLessThan(1024);
    expect(solarOutput(sim.world)).toBeLessThan(clear);
    sim.world.hazard[H.KIND] = HAZ.HEATWAVE;
    expect(solarOutput(sim.world)).toBe(clear);
  });
});

describe('heating and cooling demand', () => {
  /** One big factory on a plant: its power draw shows the season's load exactly. */
  function loadAt(day: number): { demand: number; supply: number } {
    const sim = flatSim(42, true);
    expect(run(sim, { type: 'debugGrow', x: 100, y: 100, archetype: ARCH.POWER_PLANT, progress: 1 })).toBe(true);
    expect(run(sim, { type: 'debugGrow', x: 100, y: 104, archetype: rciId(3, 2, 3), progress: 1 })).toBe(true);
    sim.world.scalars[S.day] = day;
    solveUtilities(sim);
    return { demand: sim.utils!.power.demand, supply: sim.utils!.power.supply };
  }

  it('is the base load in spring and peaks in winter, with a smaller peak in summer', () => {
    const spring = loadAt(0);
    expect(spring).toEqual({ demand: 80, supply: PLANT_MW });
    const summer = loadAt(9), autumn = loadAt(15), winter = loadAt(21);
    expect(summer.demand).toBe(95);
    expect(autumn.demand).toBe(80);
    expect(winter.demand).toBe(105);
    expect(winter.demand).toBeGreaterThan(summer.demand);
    expect(summer.demand).toBeGreaterThan(spring.demand);
    expect(climate16(0)).toBe(16);
    expect(Math.max(...Array.from({ length: 24 }, (_, d) => climate16(d)))).toBe(climate16(21));
  });

  it('adds the load of a running heatwave or cold snap on top of the season', () => {
    const sim = flatSim(42, true);
    sim.world.scalars[S.day] = 9;
    const base = climateQ16(sim.world);
    expect(base).toBe(19);
    sim.world.hazard[H.PHASE] = 2; sim.world.hazard[H.LEVEL] = 1; sim.world.hazard[H.KIND] = HAZ.HEATWAVE;
    expect(climateQ16(sim.world)).toBe(base + 3);
    sim.world.hazard[H.KIND] = HAZ.COLD_SNAP;
    expect(climateQ16(sim.world)).toBe(base + 4);
    sim.world.hazard[H.LEVEL] = 6;
    expect(climateQ16(sim.world)).toBe(base + 7);
    sim.world.hazard[H.PHASE] = 1;
    expect(climateQ16(sim.world)).toBe(base);
  });

  it('browns out a grid that was fine in spring when winter comes', () => {
    const sim = flatSim(42, true);
    expect(run(sim, { type: 'debugGrow', x: 100, y: 100, archetype: ARCH.POWER_PLANT, progress: 1 })).toBe(true);
    expect(run(sim, { type: 'debugGrow', x: 100, y: 104, archetype: rciId(3, 2, 3), progress: 1 })).toBe(true);
    expect(run(sim, { type: 'debugGrow', x: 103, y: 104, archetype: rciId(3, 1, 2), progress: 1 })).toBe(true);
    const dark = (s: Sim): number => s.utils!.unpowered;
    sim.world.scalars[S.day] = 0;
    solveUtilities(sim);
    expect(sim.utils!.power.demand).toBe(98);
    expect(dark(sim)).toBe(0);
    sim.world.scalars[S.day] = 21;
    solveUtilities(sim);
    expect(sim.utils!.power.demand).toBe(129);
    expect(sim.utils!.power.demand).toBeGreaterThan(PLANT_MW);
    expect(dark(sim)).toBe(1);
    sim.world.scalars[S.day] = 24;
    solveUtilities(sim);
    expect(dark(sim)).toBe(0);
  });
});

describe('Battery Banks', () => {
  /** A 120 MW plant, a Battery Bank touching it, a 80 MW factory and an 18 MW one on the same network. */
  function grid(withBank: boolean): Sim {
    const sim = flatSim(42, true);
    expect(run(sim, { type: 'debugGrow', x: 100, y: 100, archetype: ARCH.POWER_PLANT, progress: 1 })).toBe(true);
    if (withBank) expect(run(sim, { type: 'debugGrow', x: 104, y: 100, archetype: ARCH.BATTERY_BANK, progress: 1 })).toBe(true);
    expect(run(sim, { type: 'debugGrow', x: 100, y: 104, archetype: rciId(3, 2, 3), progress: 1 })).toBe(true);
    expect(run(sim, { type: 'debugGrow', x: 103, y: 104, archetype: rciId(3, 1, 2), progress: 1 })).toBe(true);
    return sim;
  }
  const bank = (sim: Sim): number => sim.world.bId[100 * MAP + 104]! - 1;
  const second = (sim: Sim): boolean => (sim.world.bFlags[sim.world.bId[104 * MAP + 103]! - 1]! & BFLAG.UNPOWERED) !== 0;
  const heat = (w: World, kind: number, level = 1): void => { w.hazard[H.PHASE] = 2; w.hazard[H.KIND] = kind; w.hazard[H.LEVEL] = level; };

  it('charges from a surplus at its charge rate and stops when full', () => {
    const sim = grid(true);
    solveUtilities(sim);
    expect(sim.world.bStock[bank(sim)]).toBe(BATTERY_CHARGE_MW);
    for (let i = 0; i < 10; i++) solveUtilities(sim);
    expect(sim.world.bStock[bank(sim)]).toBe(BATTERY_CHARGE_MW * 11);
    sim.world.bStock[bank(sim)] = BATTERY_CAP - 5;
    solveUtilities(sim);
    expect(sim.world.bStock[bank(sim)]).toBe(BATTERY_CAP);
    solveUtilities(sim);
    expect(sim.world.bStock[bank(sim)]).toBe(BATTERY_CAP);
  });

  it('does not charge when there is no surplus', () => {
    const sim = grid(true);
    sim.world.scalars[S.day] = 21;
    solveUtilities(sim);
    expect(sim.world.bStock[bank(sim)]).toBe(0);
  });

  it('covers the brown-out of a cold snap, up to its output, and a city without one goes dark', () => {
    const withBank = grid(true), without = grid(false);
    for (const sim of [withBank, without]) { sim.world.scalars[S.day] = 9; solveUtilities(sim); }
    withBank.world.bStock[bank(withBank)] = 500;
    for (const sim of [withBank, without]) heat(sim.world, HAZ.HEATWAVE);
    solveUtilities(without);
    expect(without.utils!.power.demand).toBeGreaterThan(PLANT_MW);
    expect(second(without)).toBe(true);
    solveUtilities(withBank);
    const given = 500 - withBank.world.bStock[bank(withBank)]!;
    expect(given).toBeGreaterThan(0);
    expect(given).toBeLessThanOrEqual(BATTERY_MW);
    expect(second(withBank)).toBe(false);
    expect(withBank.utils!.power.supply).toBe(PLANT_MW + given);
    expect(withBank.utils!.power.demand).toBe(without.utils!.power.demand);
  });

  it('runs dry: once its charge is spent the brown-out returns', () => {
    const sim = grid(true);
    sim.world.scalars[S.day] = 9;
    heat(sim.world, HAZ.HEATWAVE);
    sim.world.bStock[bank(sim)] = 40;
    let covered = 0;
    for (let i = 0; i < 12; i++) { solveUtilities(sim); if (!second(sim)) covered++; }
    expect(covered).toBeGreaterThan(0);
    expect(covered).toBeLessThan(12);
    expect(sim.world.bStock[bank(sim)]).toBe(0);
    expect(second(sim)).toBe(true);
  });

  it('forgets nothing across a snapshot: charge is state', () => {
    const sim = grid(true);
    for (let i = 0; i < 20; i++) solveUtilities(sim);
    const back = restore(snapshot(sim));
    expect(back.world.bStock[bank(back)]).toBe(sim.world.bStock[bank(sim)]);
    expect(stateHash(back)).toBe(stateHash(sim));
  });
});

describe('determinism across a season boundary', () => {
  it('resumes from a snapshot taken in the last minutes of spring', () => {
    const make = (): Sim => {
      const sim = flatSim(42, true);
      expect(run(sim, { type: 'debugGrow', x: 100, y: 100, archetype: ARCH.POWER_PLANT, progress: 1 })).toBe(true);
      expect(run(sim, { type: 'debugGrow', x: 100, y: 104, archetype: rciId(3, 2, 3), progress: 1 })).toBe(true);
      expect(run(sim, { type: 'debugGrow', x: 106, y: 100, archetype: ARCH.SOLAR_FARM, progress: 1 })).toBe(true);
      expect(run(sim, { type: 'setDisasters', mode: 2 })).toBe(true);
      sim.world.scalars[S.day] = 5;
      sim.world.scalars[S.tickOfDay] = DAY_TICKS - 400;
      sim.world.scalars[S.dayFrac] = (DAY_TICKS - 400) / DAY_TICKS;
      return sim;
    };
    const straight = make();
    for (let t = 0; t < 1200; t++) step(straight);
    expect(seasonOf(straight.world)).toBe(SEASON.SUMMER);

    const first = make();
    for (let t = 0; t < 300; t++) step(first);
    expect(seasonOf(first.world)).toBe(SEASON.SPRING);
    const resumed = restore(snapshot(first));
    expect(stateHash(resumed)).toBe(stateHash(first));
    for (let t = 0; t < 900; t++) step(resumed);
    expect(seasonOf(resumed.world)).toBe(SEASON.SUMMER);
    expect(stateHash(resumed)).toBe(stateHash(straight));
    expect(resumed.world.scalars[S.season]).toBe(straight.world.scalars[S.season]);
  });
});
