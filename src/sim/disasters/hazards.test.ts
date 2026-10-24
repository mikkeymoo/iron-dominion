import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARCH, BFLAG, rciId } from '../catalog.ts';
import { execute } from '../commands.ts';
import { restore, snapshot, step, stateHash } from '../engine.ts';
import { deriveIssues } from '../issues.ts';
import { BMAX, D, H, HAZ, MAP, REGISTRY, S, SPEC, WEATHER, type World } from '../layers.ts';
import { depot, flatSim, road, run } from '../robots/testkit.ts';
import type { Sim, SimEvent } from '../world.ts';
import {
  DAMAGE_PCT, DMODE, DURATION, LEAD_MIN, LEAD_SPAN, LEVEL_CAP, bonusFor, covers, eventCount, hazardActive, hazardLevel, hazardStats, launchMeteor, meteorImpact, planHazard,
  preparedness, quake, shieldsOf, DAMPER_RADIUS, ROD_RADIUS, DOME_RADIUS,
} from './index.ts';

vi.setConfig({ testTimeout: 120000 });
afterEach(() => new Promise<void>((r) => { setTimeout(r, 0); }));

const R1 = rciId(1, 0, 1);
const slotAt = (w: World, x: number, y: number): number => w.bId[y * MAP + x]! - 1;

/** A debug sim on flat land with a grid of n x n one-tile houses three tiles apart from (100,100): room between them for defences. */
function city(mode: number, n = 6, seed = 42): Sim {
  const sim = flatSim(seed, true);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    expect(run(sim, { type: 'debugGrow', x: 100 + i * 3, y: 100 + j * 3, archetype: R1, progress: 1 })).toBe(true);
  }
  expect(run(sim, { type: 'setDisasters', mode })).toBe(true);
  return sim;
}

const houses = (w: World): number[] => { const out: number[] = []; for (let s = 0; s < BMAX; s++) if (w.bArch[s] === R1) out.push(s); return out; };
const damageOf = (w: World): number[] => houses(w).map((s) => (w.bArch[s] === 0 ? 255 : w.bDmg[s]!));

/** Steps and returns every event of the given type. */
function collect<T extends SimEvent['type']>(sim: Sim, ticks: number, ...types: T[]): Extract<SimEvent, { type: T }>[] {
  const out: Extract<SimEvent, { type: T }>[] = [];
  for (let t = 0; t < ticks; t++) {
    step(sim);
    for (const e of sim.events) if ((types as string[]).includes(e.type)) out.push(e as Extract<SimEvent, { type: T }>);
    sim.events = [];
  }
  return out;
}

describe('registry', () => {
  it('registers the hazard layers, none of them rendered', () => {
    for (const name of ['hazard', 'hrng'] as const) {
      expect(REGISTRY.some((l) => l.name === name), name).toBe(true);
      expect(SPEC[name].render).toBe(false);
    }
    expect(SPEC.hazard.length).toBeGreaterThan(Math.max(...Object.values(H)));
    expect(Math.max(...Object.values(S))).toBeLessThan(SPEC.scalars.length);
  });

  it('seeds the hazard stream from the seed and keeps it apart from the weather and disaster streams', () => {
    const a = flatSim(1), b = flatSim(2), c = flatSim(1);
    expect(Array.from(a.world.hrng)).toEqual(Array.from(c.world.hrng));
    expect(Array.from(a.world.hrng)).not.toEqual(Array.from(b.world.hrng));
    expect(Array.from(a.world.hrng)).not.toEqual(Array.from(a.world.drng));
    expect(Array.from(a.world.hrng)).not.toEqual(Array.from(a.world.rng));
  });
});

describe('the forecast', () => {
  it('announces a hazard one to two months before it starts, and it starts exactly when announced', () => {
    const sim = city(DMODE.NORMAL);
    const seen = collect(sim, 20000, 'forecast', 'hazardStart', 'hazardEnd');
    const forecast = seen.find((e) => e.type === 'forecast');
    expect(forecast?.type).toBe('forecast');
    if (forecast?.type !== 'forecast') return;
    const lead = forecast.startTick - forecast.tick;
    expect(lead).toBeGreaterThanOrEqual(LEAD_MIN);
    expect(lead).toBeLessThan(LEAD_MIN + LEAD_SPAN);
    expect(forecast.tick).toBeGreaterThan(4000);
    const start = seen.find((e) => e.type === 'hazardStart');
    expect(start?.tick).toBe(forecast.startTick);
    expect(start?.type === 'hazardStart' && start.kind).toBe(forecast.kind);
    const end = seen.find((e) => e.type === 'hazardEnd');
    expect(end?.tick).toBe(forecast.startTick + DURATION[forecast.kind]!);
  });

  it('plans nothing with disasters off, however long it runs', () => {
    const sim = city(DMODE.OFF);
    expect(collect(sim, 12000, 'forecast', 'hazardStart')).toEqual([]);
    expect(sim.world.hazard[H.PHASE]).toBe(0);
    expect(sim.world.hazard[H.PLAN_AT]).toBe(0);
  });

  it('clears a plan when disasters are switched off, and plans again when they come back', () => {
    const sim = city(DMODE.NORMAL);
    expect(run(sim, { type: 'debugHazard', kind: HAZ.QUAKE_SWARM, lead: 500 })).toBe(true);
    expect(sim.world.hazard[H.PHASE]).toBe(1);
    expect(run(sim, { type: 'setDisasters', mode: DMODE.OFF })).toBe(true);
    step(sim);
    expect(sim.world.hazard[H.PHASE]).toBe(0);
    expect(run(sim, { type: 'setDisasters', mode: DMODE.NORMAL })).toBe(true);
    sim.events = [];
    expect(collect(sim, 5000, 'forecast').length).toBe(1);
  });

  it('chooses by the season it will land in and never repeats a kind back to back', () => {
    const sim = city(DMODE.NORMAL);
    sim.world.scalars[S.grid] = 1;
    const kindsBySeason: Set<number>[] = [new Set(), new Set(), new Set(), new Set()];
    for (let season = 0; season < 4; season++) {
      sim.world.scalars[S.day] = season * 6 + 2;
      sim.world.scalars[S.tickOfDay] = 100;
      for (let i = 0; i < 400; i++) {
        sim.world.hazard[H.PHASE] = 0; sim.world.hazard[H.LAST] = 0;
        expect(planHazard(sim)).toBe(true);
        kindsBySeason[season]!.add(sim.world.hazard[H.KIND]!);
      }
    }
    expect(kindsBySeason[1]!.has(HAZ.HEATWAVE)).toBe(true);
    expect(kindsBySeason[3]!.has(HAZ.COLD_SNAP)).toBe(true);
    expect(kindsBySeason[0]!.has(HAZ.HEATWAVE)).toBe(false);
    expect(kindsBySeason[0]!.has(HAZ.COLD_SNAP)).toBe(false);
    expect(kindsBySeason[1]!.has(HAZ.COLD_SNAP)).toBe(false);
    expect(kindsBySeason[3]!.has(HAZ.HEATWAVE)).toBe(false);
    expect(kindsBySeason[1]!.has(HAZ.STORM)).toBe(true);
    for (let i = 0; i < 300; i++) {
      const last = sim.world.hazard[H.KIND]!;
      sim.world.hazard[H.PHASE] = 0; sim.world.hazard[H.LAST] = last;
      planHazard(sim);
      expect(sim.world.hazard[H.KIND]).not.toBe(last);
    }
  });

  it('does not forecast heat or cold for a city with no power grid', () => {
    const sim = city(DMODE.NORMAL);
    sim.world.scalars[S.day] = 8;
    const kinds = new Set<number>();
    for (let i = 0; i < 300; i++) { sim.world.hazard[H.PHASE] = 0; sim.world.hazard[H.LAST] = 0; planHazard(sim); kinds.add(sim.world.hazard[H.KIND]!); }
    expect(kinds.has(HAZ.HEATWAVE)).toBe(false);
    expect(kinds.has(HAZ.COLD_SNAP)).toBe(false);
  });

  it('pins the weather for a storm, a cold snap and a heatwave, and the sky does not re-roll until it ends', () => {
    for (const [kind, weather] of [[HAZ.STORM, WEATHER.STORM], [HAZ.COLD_SNAP, WEATHER.SNOW], [HAZ.HEATWAVE, WEATHER.CLEAR]] as const) {
      const sim = city(DMODE.NORMAL);
      expect(run(sim, { type: 'debugHazard', kind, lead: 20 })).toBe(true);
      sim.world.scalars[S.weather] = weather === WEATHER.CLEAR ? WEATHER.STORM : WEATHER.CLEAR;
      for (let t = 0; t < 30; t++) step(sim);
      expect(hazardActive(sim.world, kind)).toBe(true);
      expect(sim.world.scalars[S.weather]).toBe(weather);
      expect(sim.world.scalars[S.weatherTimer]).toBeGreaterThan(DURATION[kind]! - 100);
    }
  });
});

describe('being ready', () => {
  it('pays a bonus at the start when lightning rods cover the city, and nothing when they do not', () => {
    const ready = city(DMODE.NORMAL), bare = city(DMODE.NORMAL);
    expect(run(ready, { type: 'placeBuilding', arch: ARCH.LIGHTNING_ROD, x: 108, y: 108, rot: 0 })).toBe(true);
    const cash = (s: Sim): number => s.world.scalars[S.treasury]!;
    const before = [cash(ready), cash(bare)];
    for (const sim of [ready, bare]) expect(run(sim, { type: 'debugHazard', kind: HAZ.STORM, lead: 30 })).toBe(true);
    const a = collect(ready, 40, 'hazardStart')[0]!, b = collect(bare, 40, 'hazardStart')[0]!;
    expect(a.type === 'hazardStart' && a.prepared).toBe(true);
    expect(a.type === 'hazardStart' && a.bonus).toBe(bonusFor(1));
    expect(bonusFor(1)).toBe(2000);
    expect(cash(ready) - before[0]!).toBeGreaterThan(1900);
    expect(b.type === 'hazardStart' && b.prepared).toBe(false);
    expect(b.type === 'hazardStart' && b.applicable).toBe(true);
    expect(cash(bare) - before[1]!).toBeLessThan(1000);
    expect(ready.world.hazard[H.BONUS]).toBe(2000);
    expect(hazardStats(ready.world).forecast?.bonus).toBe(2000);
  });

  it('scores each kind by its own defence', () => {
    const sim = city(DMODE.NORMAL);
    const w = sim.world;
    for (const kind of [HAZ.STORM, HAZ.QUAKE_SWARM, HAZ.METEOR_SHOWER]) {
      const p = preparedness(w, kind, 1);
      expect(p).toEqual({ applicable: true, ready: false, coverage: 0 });
    }
    expect(preparedness(w, HAZ.HEATWAVE, 1).applicable).toBe(false);
    expect(run(sim, { type: 'placeBuilding', arch: ARCH.SEISMIC_DAMPER, x: 107, y: 107, rot: 0 })).toBe(true);
    expect(preparedness(w, HAZ.QUAKE_SWARM, 1)).toEqual({ applicable: true, ready: true, coverage: 1 });
    expect(preparedness(w, HAZ.STORM, 1).ready).toBe(false);
    expect(preparedness(w, HAZ.NONE, 1).applicable).toBe(false);
  });

  it('reaches ROD_RADIUS, DAMPER_RADIUS and DOME_RADIUS tiles from the centre, and no farther', () => {
    const sim = flatSim(42, true);
    const w = sim.world;
    for (const [arch, x, r] of [[ARCH.LIGHTNING_ROD, 50, ROD_RADIUS], [ARCH.SEISMIC_DAMPER, 100, DAMPER_RADIUS], [ARCH.SHIELD_DOME, 170, DOME_RADIUS]] as const) {
      expect(run(sim, { type: 'debugGrow', x, y: 100, archetype: arch, progress: 1 })).toBe(true);
      const list = shieldsOf(w, arch, r);
      expect(list).toHaveLength(1);
      const cx = list[0]!.x, cy = list[0]!.y;
      expect(covers(list, Math.floor(cx + r - 1), Math.floor(cy))).toBe(true);
      expect(covers(list, Math.floor(cx + r + 1), Math.floor(cy))).toBe(false);
      expect(covers(list, Math.floor(cx), Math.floor(cy + r + 1))).toBe(false);
    }
  });

  it('counts only buildings that are standing, and a dome only while it has power', () => {
    const sim = flatSim(42, true);
    const w = sim.world;
    expect(run(sim, { type: 'debugGrow', x: 100, y: 100, archetype: ARCH.SHIELD_DOME, progress: 1 })).toBe(true);
    const s = slotAt(w, 100, 100);
    expect(shieldsOf(w, ARCH.SHIELD_DOME, DOME_RADIUS)).toHaveLength(1);
    w.bFlags[s] = w.bFlags[s]! | BFLAG.UNPOWERED;
    expect(shieldsOf(w, ARCH.SHIELD_DOME, DOME_RADIUS)).toHaveLength(0);
    w.bFlags[s] = BFLAG.RUBBLE;
    expect(shieldsOf(w, ARCH.SHIELD_DOME, DOME_RADIUS)).toHaveLength(0);
  });

  it('puts an advisor line up when a hazard is near and the city is not ready, and takes it down once it is', () => {
    const sim = city(DMODE.NORMAL);
    expect(run(sim, { type: 'debugHazard', kind: HAZ.STORM, lead: 3000 })).toBe(true);
    const find = (): ReturnType<typeof deriveIssues>[number] | undefined => deriveIssues(sim).find((i) => i.kind === 'hazard');
    const issue = find();
    expect(issue).toBeDefined();
    expect(issue!.text).toMatch(/^Storm season in 1 month: only 0% of the city is protected\. Build lightning rods\.$/);
    expect(issue!.category).toBe('safety');
    expect(run(sim, { type: 'placeBuilding', arch: ARCH.LIGHTNING_ROD, x: 108, y: 108, rot: 0 })).toBe(true);
    expect(find()).toBeUndefined();
    const far = city(DMODE.NORMAL);
    expect(run(far, { type: 'debugHazard', kind: HAZ.STORM, lead: 9000 })).toBe(true);
    expect(deriveIssues(far).some((i) => i.kind === 'hazard'), 'not yet near').toBe(false);
  });
});

describe('what the defences do', () => {
  it('Lightning Rods ground the storm: the same storm burns a city without them and spares one with them', () => {
    const fires = (withRod: boolean): { fires: number; blocked: number; strikes: number } => {
      const sim = city(DMODE.RARE);
      expect(run(sim, { type: 'debugTier', tier: 5 })).toBe(true);
      if (withRod) expect(run(sim, { type: 'placeBuilding', arch: ARCH.LIGHTNING_ROD, x: 108, y: 108, rot: 0 })).toBe(true);
      expect(run(sim, { type: 'debugHazard', kind: HAZ.STORM, lead: 20 })).toBe(true);
      const seen = collect(sim, 20 + DURATION[HAZ.STORM] + 10, 'disaster', 'hazardBlocked', 'lightning');
      return {
        // Only fires lit in the tick of a planned bolt count: a random ignition elsewhere in the window says nothing about the rods.
        fires: seen.filter((e) => e.type === 'disaster' && e.kind === 'fire' && seen.some((l) => l.type === 'lightning' && l.planned === true && l.tick === e.tick)).length,
        blocked: seen.filter((e) => e.type === 'hazardBlocked').length,
        strikes: seen.filter((e) => e.type === 'lightning' && e.planned === true).length,
      };
    };
    const open = fires(false), rodded = fires(true);
    expect(open.strikes).toBe(eventCount(HAZ.STORM, LEVEL_CAP[DMODE.RARE]!));
    expect(rodded.strikes).toBe(open.strikes);
    expect(open.fires).toBeGreaterThan(0);
    expect(open.blocked).toBe(0);
    expect(rodded.fires).toBe(0);
    expect(rodded.blocked).toBeGreaterThan(0);
  });

  it('a rod also grounds the random lightning of an ordinary storm', () => {
    const sim = city(DMODE.NORMAL);
    expect(run(sim, { type: 'placeBuilding', arch: ARCH.LIGHTNING_ROD, x: 108, y: 108, rot: 0 })).toBe(true);
    const target = houses(sim.world)[0]!;
    const tick = sim.world.scalars[S.tick]! + 1;
    for (let i = 0; i < 40; i++) sim.events.push({ type: 'lightning', tick, x: sim.world.bX[target]!, y: sim.world.bY[target]! });
    step(sim);
    expect(sim.events.some((e) => e.type === 'disaster' && e.kind === 'fire')).toBe(false);
    expect(sim.events.some((e) => e.type === 'hazardBlocked')).toBe(true);
    const open = city(DMODE.NORMAL);
    const t2 = open.world.scalars[S.tick]! + 1;
    for (let i = 0; i < 40; i++) open.events.push({ type: 'lightning', tick: t2, x: open.world.bX[target]!, y: open.world.bY[target]! });
    step(open);
    expect(open.events.some((e) => e.type === 'disaster' && e.kind === 'fire')).toBe(true);
  });

  it('Seismic Dampers cut quake damage inside their reach: the same quake does less, house by house', () => {
    const shake = (withDamper: boolean): { dmg: number[]; cracks: number } => {
      const sim = city(DMODE.OFF);
      road(sim, 98, 104, 130, 104);
      if (withDamper) expect(run(sim, { type: 'placeBuilding', arch: ARCH.SEISMIC_DAMPER, x: 107, y: 107, rot: 0 })).toBe(true);
      const w = sim.world;
      quake(sim, 108, 108, 20);
      let cracks = 0;
      for (let i = 0; i < w.road.length; i++) if ((w.road[i]! & 512) !== 0) cracks++;
      return { dmg: damageOf(w), cracks };
    };
    const open = shake(false), damped = shake(true);
    expect(open.dmg.some((d) => d > 0)).toBe(true);
    for (let i = 0; i < open.dmg.length; i++) expect(damped.dmg[i]!).toBeLessThanOrEqual(open.dmg[i]!);
    const sum = (a: number[]): number => a.reduce((x, y) => x + y, 0);
    expect(sum(damped.dmg)).toBeLessThan(sum(open.dmg) * 0.6);
    expect(open.cracks).toBeGreaterThan(0);
    expect(damped.cracks).toBeLessThanOrEqual(open.cracks);
  });

  it('a damper does nothing for a building out of its reach', () => {
    const shake = (withDamper: boolean): number => {
      const sim = flatSim(42, true);
      expect(run(sim, { type: 'debugGrow', x: 150, y: 100, archetype: R1, progress: 1 })).toBe(true);
      if (withDamper) expect(run(sim, { type: 'debugGrow', x: 100, y: 100, archetype: ARCH.SEISMIC_DAMPER, progress: 1 })).toBe(true);
      quake(sim, 150, 100, 12);
      return sim.world.bArch[slotAt(sim.world, 150, 100)] === 0 ? 255 : sim.world.bDmg[slotAt(sim.world, 150, 100)]!;
    };
    expect(shake(true)).toBe(shake(false));
    expect(shake(false)).toBeGreaterThan(0);
  });

  it('a Shield Dome stops a meteor inside its reach, and an unpowered one does not', () => {
    const strike = (setup: (sim: Sim) => void): { height: number; blocked: number } => {
      const sim = flatSim(42, true);
      setup(sim);
      const h0 = sim.world.height[100 * MAP + 100]!;
      expect(launchMeteor(sim, 100, 100)).toBe(true);
      sim.events = [];
      const seen = collect(sim, 40, 'hazardBlocked', 'disaster');
      return { height: sim.world.height[100 * MAP + 100]! - h0, blocked: seen.filter((e) => e.type === 'hazardBlocked').length };
    };
    const dome = (sim: Sim): number => { expect(run(sim, { type: 'debugGrow', x: 120, y: 100, archetype: ARCH.SHIELD_DOME, progress: 1 })).toBe(true); return slotAt(sim.world, 120, 100); };
    const open = strike(() => undefined);
    const shielded = strike((sim) => { dome(sim); });
    const down = strike((sim) => { const s = dome(sim); sim.world.bFlags[s] = sim.world.bFlags[s]! | BFLAG.UNPOWERED; });
    expect(open.height).toBeLessThan(-8);
    expect(open.blocked).toBe(0);
    expect(shielded.height).toBe(0);
    expect(shielded.blocked).toBe(1);
    expect(down.height).toBeLessThan(-8);
  });

  it('a dome far from the target does not help', () => {
    const sim = flatSim(42, true);
    expect(run(sim, { type: 'debugGrow', x: 200, y: 200, archetype: ARCH.SHIELD_DOME, progress: 1 })).toBe(true);
    const h0 = sim.world.height[100 * MAP + 100]!;
    sim.world.disaster[D.METEOR_AT] = 0;
    meteorImpact(sim, 100, 100, 6);
    expect(sim.world.height[100 * MAP + 100]!).toBeLessThan(h0 - 8);
  });
});

describe('Gentle mode and intensity', () => {
  it('scales the hazard level with the population tier, and caps it by mode', () => {
    const level = (mode: number, tier: number): number => {
      const sim = flatSim(42, true);
      run(sim, { type: 'setDisasters', mode });
      sim.world.scalars[S.tier] = tier;
      return hazardLevel(sim.world);
    };
    const table = (mode: number): number[] => [0, 1, 2, 3, 4, 5].map((t) => level(mode, t));
    expect(table(DMODE.NORMAL)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(table(DMODE.RARE)).toEqual([1, 2, 3, 4, 4, 4]);
    expect(table(DMODE.GENTLE)).toEqual([1, 2, 2, 2, 2, 2]);
    expect(table(DMODE.HARD)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(table(DMODE.OFF)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(LEVEL_CAP[DMODE.GENTLE]).toBe(2);
    for (let t = 1; t < 6; t++) expect(level(DMODE.NORMAL, t)).toBeGreaterThan(level(DMODE.NORMAL, t - 1));
  });

  it('brings more strikes, meteors and quakes, and a bigger bonus, as the level rises', () => {
    for (const kind of [HAZ.STORM, HAZ.METEOR_SHOWER, HAZ.QUAKE_SWARM]) {
      expect(eventCount(kind, 6)).toBeGreaterThan(eventCount(kind, 1));
      for (let l = 2; l <= 6; l++) expect(eventCount(kind, l)).toBeGreaterThanOrEqual(eventCount(kind, l - 1));
    }
    expect(eventCount(HAZ.HEATWAVE, 6)).toBe(0);
    expect(bonusFor(6)).toBeGreaterThan(bonusFor(1));
  });

  it('plans the level of the city at the time: a growing city meets a stronger hazard', () => {
    const sim = city(DMODE.NORMAL);
    sim.world.hazard[H.PHASE] = 0;
    run(sim, { type: 'debugTier', tier: 4 });
    expect(planHazard(sim, { kind: HAZ.STORM, lead: 100 })).toBe(true);
    expect(sim.world.hazard[H.LEVEL]).toBe(5);
    expect(hazardStats(sim.world).forecast?.level).toBe(5);
  });

  it('never plans a meteor shower, and cancels one that was planned before the switch', () => {
    const sim = city(DMODE.GENTLE);
    const kinds = new Set<number>();
    for (let day = 0; day < 24; day++) {
      sim.world.scalars[S.day] = day;
      for (let i = 0; i < 100; i++) { sim.world.hazard[H.PHASE] = 0; sim.world.hazard[H.LAST] = 0; planHazard(sim); kinds.add(sim.world.hazard[H.KIND]!); }
    }
    expect(kinds.has(HAZ.METEOR_SHOWER)).toBe(false);
    expect(kinds.has(HAZ.STORM) && kinds.has(HAZ.QUAKE_SWARM)).toBe(true);
    const normal = city(DMODE.NORMAL);
    const seen = new Set<number>();
    for (let day = 0; day < 24; day++) {
      normal.world.scalars[S.day] = day;
      for (let i = 0; i < 100; i++) { normal.world.hazard[H.PHASE] = 0; normal.world.hazard[H.LAST] = 0; planHazard(normal); seen.add(normal.world.hazard[H.KIND]!); }
    }
    expect(seen.has(HAZ.METEOR_SHOWER), 'Normal does plan them, so the control is not vacuous').toBe(true);

    const late = city(DMODE.NORMAL);
    expect(run(late, { type: 'debugHazard', kind: HAZ.METEOR_SHOWER, lead: 50 })).toBe(true);
    expect(run(late, { type: 'setDisasters', mode: DMODE.GENTLE })).toBe(true);
    expect(collect(late, 200, 'hazardStart')).toEqual([]);
    expect(late.world.hazard[H.PHASE]).toBe(0);
    expect(late.world.disaster[D.METEOR_AT]).toBe(0);
  });

  it('halves the damage of a quake and of a fire, and starts no random fire', () => {
    const shake = (mode: number): number[] => {
      const sim = city(mode);
      quake(sim, 108, 108, 20);
      return damageOf(sim.world);
    };
    const normal = shake(DMODE.NORMAL), gentle = shake(DMODE.GENTLE);
    expect(DAMAGE_PCT[DMODE.GENTLE]).toBe(50);
    const sum = (a: number[]): number => a.reduce((x, y) => x + y, 0);
    expect(sum(normal)).toBeGreaterThan(200);
    expect(sum(gentle)).toBeLessThan(sum(normal) * 0.7);
    for (let i = 0; i < normal.length; i++) expect(gentle[i]!).toBeLessThanOrEqual(normal[i]!);

    const burn = (mode: number): number => {
      const sim = city(mode, 1);
      const s = houses(sim.world)[0]!;
      expect(run(sim, { type: 'triggerDisaster', kind: 'fire', x: sim.world.bX[s]!, y: sim.world.bY[s]! })).toBe(true);
      for (let t = 0; t < 60; t++) step(sim);
      return sim.world.bArch[s] === 0 ? 255 : sim.world.bDmg[s]!;
    };
    const full = burn(DMODE.NORMAL), half = burn(DMODE.GENTLE);
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(full * 0.65);

    const calm = city(DMODE.GENTLE, 12);
    const fires = collect(calm, 6000, 'disaster').filter((e) => e.type === 'disaster' && e.kind === 'fire');
    expect(fires).toEqual([]);
  });

  it('still forecasts and plays a Gentle quake swarm through, at its capped level', () => {
    const sim = city(DMODE.GENTLE);
    run(sim, { type: 'debugTier', tier: 5 });
    expect(run(sim, { type: 'debugHazard', kind: HAZ.QUAKE_SWARM, lead: 30 })).toBe(true);
    expect(sim.world.hazard[H.LEVEL]).toBe(2);
    const seen = collect(sim, 30 + DURATION[HAZ.QUAKE_SWARM] + 10, 'disaster', 'hazardEnd');
    expect(seen.filter((e) => e.type === 'disaster' && e.kind === 'quake').length).toBe(eventCount(HAZ.QUAKE_SWARM, 2));
    expect(seen.some((e) => e.type === 'hazardEnd')).toBe(true);
  });
});

describe('debug commands', () => {
  it('are refused outside a debug session, and a hazard needs disasters on', () => {
    const plain = flatSim(42, false);
    run(plain, { type: 'setDisasters', mode: DMODE.NORMAL });
    const tryRun = (sim: Sim, body: Parameters<typeof run>[1]): string => {
      sim.events = [];
      const ok = run(sim, body);
      const last = sim.events[sim.events.length - 1]!;
      return ok ? 'ok' : last.type === 'rejected' ? last.reason : '?';
    };
    expect(tryRun(plain, { type: 'debugSeason', day: 7 })).toBe('debug-only');
    expect(tryRun(plain, { type: 'debugHazard', kind: HAZ.STORM })).toBe('debug-only');
    const off = flatSim(42, true);
    expect(tryRun(off, { type: 'debugHazard', kind: HAZ.STORM })).toBe('disasters-off');
    run(off, { type: 'setDisasters', mode: DMODE.RARE });
    expect(tryRun(off, { type: 'debugHazard', kind: 99 })).toBe('invalid');
    expect(tryRun(off, { type: 'debugHazard', kind: HAZ.STORM, lead: 0 })).toBe('invalid');
    expect(tryRun(off, { type: 'debugSeason', day: -1 })).toBe('invalid');
    expect(tryRun(off, { type: 'debugSeason', day: 13 })).toBe('ok');
    expect(off.world.scalars[S.day]).toBe(13);
    expect(Math.floor(off.world.scalars[S.season]!)).toBe(13);
    expect(execute(off, { id: 99, tick: 0, type: 'debugHazard', kind: HAZ.HEATWAVE })).toBe(true);
  });
});

describe('determinism with hazards', () => {
  it('replays to the same hash and resumes from a snapshot taken while a hazard is only forecast', () => {
    const make = (): Sim => { const sim = city(DMODE.NORMAL, 3); run(sim, { type: 'debugHazard', kind: HAZ.QUAKE_SWARM, lead: 2500 }); return sim; };
    const straight = make();
    const again = make();
    for (let t = 0; t < 6000; t++) { step(straight); step(again); }
    expect(stateHash(again)).toBe(stateHash(straight));
    expect(straight.world.hazard[H.COUNT]).toBe(1);

    const first = make();
    for (let t = 0; t < 1500; t++) step(first);
    expect(first.world.hazard[H.PHASE], 'forecast pending, not yet started').toBe(1);
    const resumed = restore(snapshot(first));
    expect(stateHash(resumed)).toBe(stateHash(first));
    for (let t = 0; t < 4500; t++) step(resumed);
    expect(stateHash(resumed)).toBe(stateHash(straight));
  });

  it('resumes from a snapshot taken in the middle of a storm window, with strikes still to come', () => {
    const make = (): Sim => { const sim = city(DMODE.NORMAL, 4); run(sim, { type: 'debugTier', tier: 3 }); run(sim, { type: 'debugHazard', kind: HAZ.STORM, lead: 40 }); return sim; };
    const straight = make();
    for (let t = 0; t < 5200; t++) step(straight);
    const first = make();
    for (let t = 0; t < 1800; t++) step(first);
    expect(first.world.hazard[H.PHASE]).toBe(2);
    expect(first.world.hazard[H.LEFT]).toBeGreaterThan(0);
    const resumed = restore(snapshot(first));
    for (let t = 0; t < 3400; t++) step(resumed);
    expect(stateHash(resumed)).toBe(stateHash(straight));
  });

  it('runs the hazard stream apart from the weather: the same weather with disasters off or on', () => {
    const a = city(DMODE.OFF, 2), b = city(DMODE.NORMAL, 2);
    const seen: number[][] = [[], []];
    for (let t = 0; t < 6000; t++) { step(a); step(b); if (t % 100 === 0) { seen[0]!.push(a.world.scalars[S.weather]!); seen[1]!.push(b.world.scalars[S.weather]!); } }
    expect(seen[1]).toEqual(seen[0]);
    expect(Array.from(b.world.rng)).toEqual(Array.from(a.world.rng));
    expect(b.world.hazard[H.PHASE], 'the plan was made inside the run').toBe(1);
    expect(a.world.hazard[H.PHASE]).toBe(0);
  });
});

describe('stats for the HUD', () => {
  it('reports the season, the forecast, the defences and the ruins', () => {
    const sim = city(DMODE.NORMAL);
    expect(run(sim, { type: 'placeBuilding', arch: ARCH.LIGHTNING_ROD, x: 108, y: 108, rot: 0 })).toBe(true);
    expect(run(sim, { type: 'placeBuilding', arch: ARCH.SEISMIC_DAMPER, x: 107, y: 111, rot: 0 })).toBe(true);
    const idle = hazardStats(sim.world);
    expect(idle.forecast).toBeNull();
    expect(idle.kit).toMatchObject({ rods: 1, dampers: 1, batteries: 0, domes: 0, charge: 0 });
    expect(idle.season).toBe(0);
    expect(idle.climate).toBe(1);
    expect(idle.daylight).toBe(0.5);
    expect(idle.level).toBe(1);
    expect(run(sim, { type: 'debugHazard', kind: HAZ.STORM, lead: 700 })).toBe(true);
    const f = hazardStats(sim.world).forecast!;
    expect(f).toMatchObject({ kind: HAZ.STORM, level: 1, active: false, startsIn: 700, lead: 700 });
    expect(f.prep.ready).toBe(true);
    for (let t = 0; t < 720; t++) step(sim);
    const on = hazardStats(sim.world).forecast!;
    expect(on.active).toBe(true);
    expect(on.startsIn).toBe(0);
    expect(on.endsIn).toBeGreaterThan(0);
  });
});
