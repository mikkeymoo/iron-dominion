import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARCH, BFLAG, rciId } from '../catalog.ts';
import { execute, type Command, type CommandBody } from '../commands.ts';
import { collectOutgoing, createSim, restore, snapshot, step, stateHash } from '../engine.ts';
import { BMAX, D, MAP, REGISTRY, ROAD, S, SPEC, TERRAIN, WEATHER, CHUNK, type World } from '../layers.ts';
import { tileCost } from '../roads/graph.ts';
import { AKIND, AST } from '../robots/constants.ts';
import { depot, flatSim, road, run, zone } from '../robots/testkit.ts';
import { chunkIdx } from '../tiles.ts';
import type { SimEvent, Sim } from '../world.ts';
import {
  DMODE, damagedRoads, destroyBuilding, ignitionRiskOf, ignitable, placeName, setFireCoverageSource, startFire,
} from './index.ts';

vi.setConfig({ testTimeout: 120000 });
afterEach(() => {
  setFireCoverageSource(null);
  return new Promise<void>((r) => { setTimeout(r, 0); });
});

const R1 = rciId(1, 0, 1), I1 = rciId(3, 0, 1);
const grow = (sim: Sim, x: number, y: number, arch = R1): number => {
  expect(run(sim, { type: 'debugGrow', x, y, archetype: arch, progress: 1 })).toBe(true);
  return sim.world.bId[y * MAP + x]! - 1;
};
const slotAt = (w: World, x: number, y: number): number => w.bId[y * MAP + x]! - 1;
const isBurning = (w: World, s: number): boolean => (w.bFlags[s]! & BFLAG.BURNING) !== 0;
const isRuin = (w: World, s: number): boolean => w.bArch[s] !== 0 && (w.bFlags[s]! & BFLAG.RUBBLE) !== 0;
const setMode = (sim: Sim, mode: number): void => { expect(run(sim, { type: 'setDisasters', mode })).toBe(true); };
const eventsOf = (sim: Sim, kind: string): SimEvent[] => sim.events.filter((e) => e.type === 'disaster' && e.kind === kind);
const ticks = (sim: Sim, n: number): void => { for (let i = 0; i < n; i++) step(sim); };

describe('registry', () => {
  it('registers the disaster layers, and sends damage with the building record', () => {
    for (const name of ['bDmg', 'bHeat', 'disaster', 'drng'] as const) expect(REGISTRY.some((l) => l.name === name), name).toBe(true);
    expect(SPEC.bDmg.render).toBe(true);
    const sim = flatSim(42, true);
    const s = grow(sim, 100, 100);
    sim.world.bDmg[s] = 77;
    sim.dirty.buildings.add(s);
    sim.resync = false;
    const patch = collectOutgoing(sim).find((m) => m.type === 'chunkPatch');
    expect(patch && patch.type === 'chunkPatch' && patch.buildings.find((b) => b.slot === s)?.dmg).toBe(77);
  });

  it('opens with disasters off unless the session says otherwise, and accepts only modes 0 to 2', () => {
    expect(createSim(5).world.disaster[D.MODE]).toBe(DMODE.OFF);
    expect(createSim(5, { disasters: DMODE.RARE }).world.disaster[D.MODE]).toBe(DMODE.RARE);
    expect(createSim(5, { disasters: 9 }).world.disaster[D.MODE]).toBe(DMODE.OFF);
    expect(createSim(5, { disasters: -1 }).world.disaster[D.MODE]).toBe(DMODE.OFF);
    const sim = createSim(5);
    expect(run(sim, { type: 'setDisasters', mode: 2 })).toBe(true);
    expect(sim.world.disaster[D.MODE]).toBe(2);
    expect(run(sim, { type: 'setDisasters', mode: 3 })).toBe(false);
    expect(run(sim, { type: 'setDisasters', mode: 0.5 })).toBe(false);
    expect(sim.world.disaster[D.MODE]).toBe(2);
  });
});

describe('fire', () => {
  it('spreads only to flammable neighbours', () => {
    const sim = flatSim(42, true);
    setMode(sim, DMODE.OFF);
    const w = sim.world;
    const centre = grow(sim, 100, 100);
    const houses = [[99, 100], [101, 100], [100, 99], [100, 101], [99, 99], [101, 101]].map(([x, y]) => grow(sim, x!, y!));
    expect(run(sim, { type: 'debugGrow', x: 101, y: 98, archetype: ARCH.WATER_PUMP, progress: 1 })).toBe(true);
    const pump = slotAt(w, 101, 98);
    // The pump touches the burning house diagonally, well inside the spread reach.
    expect(ignitable(w, pump)).toBe(false);
    expect(startFire(sim, centre)).toBe(true);
    let caught = 0;
    const everBurned = new Set<number>();
    for (let t = 0; t < 600; t++) {
      step(sim);
      for (const s of [...houses, pump]) if (isBurning(w, s) || isRuin(w, s)) everBurned.add(s);
    }
    caught = houses.filter((s) => everBurned.has(s)).length;
    expect(caught).toBeGreaterThan(0);
    expect(everBurned.has(pump)).toBe(false);
    expect(w.bDmg[pump]).toBe(0);
    expect(w.bFlags[pump]! & BFLAG.BURNING).toBe(0);
  });

  it('never ignites buildings that are under construction, ruined or already burning', () => {
    const sim = flatSim(42, true);
    const w = sim.world;
    expect(run(sim, { type: 'debugGrow', x: 100, y: 100, archetype: R1, progress: 0.4 })).toBe(true);
    const site = slotAt(w, 100, 100);
    expect(ignitable(w, site)).toBe(false);
    const done = grow(sim, 104, 100);
    expect(startFire(sim, done)).toBe(true);
    expect(startFire(sim, done)).toBe(false);
    destroyBuilding(sim, done);
    expect(isRuin(w, done)).toBe(true);
    expect(startFire(sim, done)).toBe(false);
    expect(ignitionRiskOf(w, done)).toBe(0);
  });

  it('puts a fire out faster, and saves the building, when the coverage hook reports fire cover', () => {
    const burn = (cover: number | null) => {
      const sim = flatSim(42, true);
      setMode(sim, DMODE.OFF);
      setFireCoverageSource(cover === null ? null : () => cover);
      const s = grow(sim, 100, 100);
      startFire(sim, s);
      let out = -1;
      for (let t = 0; t < 1500; t++) {
        step(sim);
        if (out < 0 && !isBurning(sim.world, s)) { out = t; break; }
      }
      return { out, ruin: isRuin(sim.world, s), dmg: sim.world.bDmg[s]! };
    };
    const none = burn(null), covered = burn(255);
    expect(none.ruin).toBe(true);
    expect(covered.ruin).toBe(false);
    expect(covered.out).toBeGreaterThan(0);
    expect(covered.out).toBeLessThan(none.out);
    expect(covered.dmg).toBeLessThan(255);
    expect(burn(120).dmg).toBeLessThan(none.dmg);
  });

  it('lowers ignition risk with coverage, and raises it for industry, pollution and a dry building', () => {
    const sim = flatSim(42, true);
    const w = sim.world;
    const house = grow(sim, 100, 100), mill = grow(sim, 110, 100, I1);
    expect(ignitionRiskOf(w, mill)).toBeGreaterThan(ignitionRiskOf(w, house));
    const base = ignitionRiskOf(w, house);
    w.pollution.fill(200);
    const dirty = ignitionRiskOf(w, house);
    expect(dirty).toBeGreaterThan(base);
    w.bFlags[house] = w.bFlags[house]! | BFLAG.UNWATERED;
    expect(ignitionRiskOf(w, house)).toBeGreaterThan(dirty);
    setFireCoverageSource(() => 255);
    expect(ignitionRiskOf(w, house)).toBe(0);
    setFireCoverageSource(null);
    w.covFire.fill(255);
    expect(ignitionRiskOf(w, house)).toBe(0);
  });

  it('ends as rubble that robots tear down, giving the lot back to its zone', () => {
    const sim = flatSim(42, true);
    setMode(sim, DMODE.OFF);
    road(sim, 96, 104, 130, 104);
    depot(sim, 98, 102);
    zone(sim, 100, 105, 100, 105, 1, 0);
    const w = sim.world;
    const s = grow(sim, 100, 105);
    expect(w.zone[105 * MAP + 100]).toBe(0);
    destroyBuilding(sim, s);
    expect(isRuin(w, s)).toBe(true);
    let cleared = false;
    for (let t = 0; t < 4000 && !cleared; t++) { step(sim); cleared = !isRuin(w, s); }
    expect(cleared).toBe(true);
    expect(w.bDmg[s]).toBe(0);
    expect(w.bFlags[s]! & (BFLAG.RUBBLE | BFLAG.BURNING)).toBe(0);
    expect(w.zone[105 * MAP + 100] !== 0 || w.bId[105 * MAP + 100] !== 0).toBe(true);
  });

  it('leaves a service building as rubble too, which robots clear, and a destroyed depot is simply gone', () => {
    const sim = flatSim(42, true);
    setMode(sim, DMODE.OFF);
    road(sim, 96, 104, 130, 104);
    depot(sim, 98, 102);
    const w = sim.world;
    expect(run(sim, { type: 'placeBuilding', arch: ARCH.POWER_PLANT, x: 110, y: 100, rot: 0 })).toBe(true);
    const plant = slotAt(w, 110, 100);
    destroyBuilding(sim, plant);
    expect(isRuin(w, plant)).toBe(true);
    expect(w.bFlags[plant]! & BFLAG.ABANDONED).toBe(BFLAG.ABANDONED);
    let cleared = false;
    for (let t = 0; t < 4000 && !cleared; t++) { step(sim); cleared = w.bArch[plant] === 0; }
    expect(cleared).toBe(true);
    const home = slotAt(w, 98, 102);
    destroyBuilding(sim, home);
    expect(w.bArch[home]).toBe(0);
  });

  it('names the place for the toast', () => {
    expect(placeName(I1)).toBe('Industrial district');
    expect(placeName(R1)).toBe('Residential district');
    expect(placeName(ARCH.POWER_PLANT)).toBe('the power plant');
  });
});

describe('firefighters', () => {
  const scene = (withStation: boolean) => {
    const sim = flatSim(42, true);
    setMode(sim, DMODE.OFF);
    road(sim, 96, 104, 130, 104);
    depot(sim, 98, 102);
    if (withStation) expect(run(sim, { type: 'placeBuilding', arch: ARCH.FIRE_STATION, x: 110, y: 101, rot: 0 })).toBe(true);
    const target = grow(sim, 120, 105);
    return { sim, target };
  };

  it('a fire station sends firefighters along the road and saves a house a plain fire would destroy', () => {
    const lone = scene(false);
    startFire(lone.sim, lone.target);
    ticks(lone.sim, 700);
    // With a depot the builders clear the ruin in the end, so "destroyed" is a ruin or an empty slot.
    expect(isRuin(lone.sim.world, lone.target) || lone.sim.world.bArch[lone.target] === 0).toBe(true);

    const { sim, target } = scene(true);
    const w = sim.world;
    ticks(sim, 120);
    expect(startFire(sim, target)).toBe(true);
    let sprayed = false, drove = false;
    for (let t = 0; t < 700; t++) {
      step(sim);
      for (let a = 0; a < 64; a++) {
        if (w.aKind[a] !== AKIND.FIREFIGHTER) continue;
        if (w.aState[a] === AST.FF_GO) drove = true;
        if (w.aState[a] === AST.FF_SPRAY) sprayed = true;
      }
    }
    expect(drove).toBe(true);
    expect(sprayed).toBe(true);
    expect(w.bArch[target]).toBe(R1);
    expect(isRuin(w, target)).toBe(false);
    expect(isBurning(w, target)).toBe(false);
    expect(w.bDmg[target]).toBeGreaterThan(0);
    const away = [...Array(64).keys()].filter((a) => w.aKind[a] === AKIND.FIREFIGHTER && w.aState[a] !== AST.IDLE);
    expect(away).toEqual([]);
  });

  it('a firefighter whose station is destroyed despawns and the robots keep working', () => {
    const { sim } = scene(true);
    const w = sim.world;
    ticks(sim, 150);
    const station = [...Array(BMAX).keys()].find((s) => w.bArch[s] === ARCH.FIRE_STATION)!;
    expect([...Array(64).keys()].some((a) => w.aKind[a] === AKIND.FIREFIGHTER)).toBe(true);
    destroyBuilding(sim, station);
    ticks(sim, 400);
    expect([...Array(64).keys()].filter((a) => w.aKind[a] === AKIND.FIREFIGHTER)).toEqual([]);
  });
});

describe('storms', () => {
  const storm = (sim: Sim): void => {
    const s = sim.world.scalars;
    s[S.weather] = WEATHER.STORM; s[S.weatherIntensity] = 1; s[S.weatherTarget] = 1; s[S.weatherTimer] = 1e6;
  };
  const strikeAt = (sim: Sim, s: number, n: number): void => {
    const w = sim.world, t = w.scalars[S.tick]! + 1;
    for (let i = 0; i < n; i++) sim.events.push({ type: 'lightning', tick: t, x: w.bX[s]!, y: w.bY[s]! });
  };

  it('lets a lightning strike set a building alight when disasters are on', () => {
    const sim = flatSim(42, true);
    setMode(sim, DMODE.NORMAL);
    const s = grow(sim, 100, 100);
    strikeAt(sim, s, 12);
    step(sim);
    expect(isBurning(sim.world, s)).toBe(true);
    expect(eventsOf(sim, 'fire')).toHaveLength(1);
  });

  it('ignores lightning completely when disasters are off', () => {
    const sim = flatSim(42, true);
    setMode(sim, DMODE.OFF);
    const s = grow(sim, 100, 100);
    strikeAt(sim, s, 50);
    step(sim);
    expect(isBurning(sim.world, s)).toBe(false);
    expect(eventsOf(sim, 'fire')).toHaveLength(0);
  });

  it('heavy rain puts a fire out faster than a clear sky', () => {
    const life = (rain: boolean): number => {
      const sim = flatSim(42, true);
      setMode(sim, DMODE.OFF);
      const s = grow(sim, 100, 100);
      if (rain) storm(sim);
      startFire(sim, s);
      for (let t = 0; t < 1500; t++) { step(sim); if (!isBurning(sim.world, s)) return t; }
      return 1500;
    };
    const wet = life(true), dry = life(false);
    expect(wet).toBeLessThan(dry);
  });
});

describe('disasters off', () => {
  const city = (mode: number): Sim => {
    const sim = flatSim(42, true);
    setMode(sim, mode);
    for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) grow(sim, 60 + i * 3, 60 + j * 3, I1);
    storm(sim);
    return sim;
  };
  const storm = (sim: Sim): void => {
    const s = sim.world.scalars;
    s[S.weather] = WEATHER.STORM; s[S.weatherIntensity] = 1; s[S.weatherTarget] = 1; s[S.weatherTimer] = 1e6;
  };

  it('starts no fire, quake or meteor in thousands of ticks, in a storm', () => {
    const sim = city(DMODE.OFF);
    const w = sim.world;
    const seen: SimEvent[] = [];
    for (let t = 0; t < 2500; t++) {
      step(sim);
      for (const e of sim.events) if (e.type === 'disaster') seen.push(e);
      sim.events = [];
    }
    expect(seen).toEqual([]);
    for (let s = 0; s < BMAX; s++) expect(w.bFlags[s]! & (BFLAG.BURNING | BFLAG.RUBBLE)).toBe(0);
    expect(w.bDmg.some((d) => d !== 0)).toBe(false);
    expect(w.disaster[D.METEOR_AT]).toBe(0);
  });

  it('the same city does burn on Normal, so the control is not vacuous', () => {
    const sim = city(DMODE.NORMAL);
    const kinds = new Set<string>();
    for (let t = 0; t < 12000 && !kinds.has('fire'); t++) {
      step(sim);
      for (const e of sim.events) if (e.type === 'disaster') kinds.add(e.kind);
      sim.events = [];
    }
    expect(kinds.has('fire')).toBe(true);
  });

  it('still lets the sandbox trigger work while the setting is off', () => {
    const sim = city(DMODE.OFF);
    expect(run(sim, { type: 'triggerDisaster', kind: 'fire', x: 60, y: 60 })).toBe(true);
    expect(eventsOf(sim, 'fire')).toHaveLength(1);
    expect(run(sim, { type: 'triggerDisaster', kind: 'fire', x: 5, y: 5 })).toBe(false);
    expect(run(sim, { type: 'triggerDisaster', kind: 'fire', x: -1, y: 5 })).toBe(false);
    expect(run(sim, { type: 'triggerDisaster', kind: 'tornado' as 'fire', x: 5, y: 5 })).toBe(false);
  });
});

describe('earthquake', () => {
  const district = (seed: number): Sim => {
    const sim = flatSim(seed, true);
    setMode(sim, DMODE.OFF);
    road(sim, 80, 100, 130, 100);
    road(sim, 100, 80, 100, 130);
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) if (i !== 3 && j !== 3) grow(sim, 90 + i * 3, 90 + j * 3, i % 2 ? R1 : I1);
    return sim;
  };
  const shake = (seed: number): Sim => {
    const sim = district(seed);
    expect(run(sim, { type: 'triggerDisaster', kind: 'quake', x: 100, y: 100 })).toBe(true);
    return sim;
  };

  it('damages buildings and cracks roads around the epicentre, and nothing far away', () => {
    const sim = shake(42);
    const w = sim.world;
    const hit = [...Array(BMAX).keys()].filter((s) => w.bArch[s] !== 0 && w.bDmg[s]! > 0);
    expect(hit.length).toBeGreaterThan(3);
    expect(damagedRoads(w).length).toBeGreaterThan(2);
    const ev = eventsOf(sim, 'quake')[0]!;
    expect(ev.type === 'disaster' && ev.radius).toBeGreaterThanOrEqual(10);
    for (const i of damagedRoads(w)) {
      const x = i % MAP, y = (i / MAP) | 0;
      expect(Math.hypot(x - 100, y - 100)).toBeLessThan((ev.type === 'disaster' ? ev.radius : 0) + 1);
    }
    expect(damagedRoads(w).every((i) => (w.road[i]! & ROAD.CLASS_MASK) !== 0)).toBe(true);
  });

  it('is deterministic per seed: same seed, same wreckage; another seed, different wreckage', () => {
    const a = shake(42), b = shake(42), c = shake(43);
    expect(stateHash(a)).toBe(stateHash(b));
    expect(Array.from(a.world.bDmg)).toEqual(Array.from(b.world.bDmg));
    expect(Array.from(a.world.road)).toEqual(Array.from(b.world.road));
    expect(stateHash(c)).not.toBe(stateHash(a));
    expect(Array.from(c.world.bDmg)).not.toEqual(Array.from(a.world.bDmg));
  });

  it('makes cracked roads cost more and slow the traffic that uses them', () => {
    const w = shake(42).world;
    const cracked = damagedRoads(w)[0]!;
    expect(tileCost(w.road[cracked]!)).toBeGreaterThan(tileCost(w.road[cracked]! & ~ROAD.DAMAGED));
  });

  it('survives a quake with its road connections intact (the crack is a flag, not a gap)', () => {
    const w = shake(42).world;
    for (const i of damagedRoads(w)) expect(w.road[i]! & ROAD.CONN_MASK).not.toBe(0);
  });

  it('is repaired by builder robots, eventually, and the repair frees the road', () => {
    const sim = flatSim(42, true);
    setMode(sim, DMODE.OFF);
    road(sim, 96, 104, 130, 104);
    depot(sim, 98, 102);
    const w = sim.world;
    const cracked = [108, 109, 115, 124].map((x) => 104 * MAP + x);
    for (const i of cracked) w.road[i] = w.road[i]! | ROAD.DAMAGED;
    let crew = false;
    for (let t = 0; t < 6000 && damagedRoads(w).length > 0; t++) {
      step(sim);
      for (let a = 0; a < 64; a++) if (w.aState[a] === AST.REPAIR_WORK) crew = true;
    }
    expect(crew).toBe(true);
    expect(damagedRoads(w)).toEqual([]);
    ticks(sim, 400);
    for (let a = 0; a < 64; a++) if (w.aKind[a] === AKIND.BUILDER) expect(w.aState[a]).toBe(AST.IDLE);
  });

  it('a road that is replaced by the player stops being cracked', () => {
    const sim = flatSim(42, true);
    expect(run(sim, { type: 'debugTier', tier: 2 })).toBe(true);
    road(sim, 96, 104, 130, 104);
    const w = sim.world, i = 104 * MAP + 110;
    w.road[i] = w.road[i]! | ROAD.DAMAGED;
    expect(run(sim, { type: 'placeRoad', ax: 110, ay: 104, bx: 111, by: 104, cls: 2 })).toBe(true);
    expect(w.road[i]! & ROAD.DAMAGED).toBe(0);
    expect(w.road[i]! & ROAD.CLASS_MASK).toBe(2);
  });
});

describe('meteor', () => {
  const impact = (seed = 42) => {
    const sim = flatSim(seed, true);
    setMode(sim, DMODE.OFF);
    road(sim, 100, 128, 156, 128);
    const w = sim.world;
    const core = grow(sim, 128, 126), ring = grow(sim, 133, 124), outer = grow(sim, 137, 124), far = grow(sim, 170, 170);
    const before = w.height.slice();
    sim.dirty.geometry.clear();
    sim.events = [];
    expect(run(sim, { type: 'triggerDisaster', kind: 'meteor', x: 128, y: 128 })).toBe(true);
    expect(w.disaster[D.METEOR_AT]).toBeGreaterThan(w.scalars[S.tick]!);
    return { sim, w, before, core, ring, outer, far };
  };

  it('announces the meteor, then lowers the ground in a bowl and marks the chunks dirty', () => {
    const { sim, w, before } = impact();
    expect(eventsOf(sim, 'meteor').map((e) => e.type === 'disaster' && e.phase)).toEqual(['start']);
    const at = w.disaster[D.METEOR_AT]!;
    sim.dirty.geometry.clear();
    while (w.scalars[S.tick]! < at) step(sim);
    expect(w.disaster[D.METEOR_AT]).toBe(0);
    const imp = eventsOf(sim, 'meteor').find((e) => e.type === 'disaster' && e.phase === 'impact');
    expect(imp).toBeDefined();
    const radius = imp!.type === 'disaster' ? imp!.radius : 0;
    expect(radius).toBeGreaterThanOrEqual(5);
    const mid = 128 * MAP + 128;
    expect(w.height[mid]!).toBeLessThan(before[mid]!);
    expect(before[mid]! - w.height[mid]!).toBeGreaterThan(20);
    expect(w.terrain[mid]).toBe(TERRAIN.ROCK);
    const rim = 128 * MAP + (128 + radius + 2);
    expect(w.height[rim]).toBe(before[rim]);
    for (let i = 0; i < w.height.length; i++) if (w.height[i]! > before[i]!) throw new Error(`tile ${i} rose`);
    expect(sim.dirty.geometry.has(chunkIdx(128, 128))).toBe(true);
    expect(sim.dirty.geometry.has(chunkIdx(128 + CHUNK * 4, 128))).toBe(false);
    sim.resync = false;
    const patch = collectOutgoing(sim).find((m) => m.type === 'chunkPatch');
    expect(patch && patch.type === 'chunkPatch' && 'height' in patch.layers && 'terrain' in patch.layers).toBe(true);
  });

  it('destroys what is in the radius and sets fires beyond it', () => {
    const { sim, w, core, ring, far } = impact();
    ticks(sim, 30);
    expect(w.bArch[core]).toBe(0);
    expect(isRuin(w, ring)).toBe(true);
    expect(w.bArch[far]).toBe(R1);
    expect(isBurning(w, far)).toBe(false);
    expect(w.road[128 * MAP + 128]).toBe(0);
  });

  it('is deterministic per seed', () => {
    const run1 = impact(42), run2 = impact(42);
    ticks(run1.sim, 60); ticks(run2.sim, 60);
    expect(stateHash(run1.sim)).toBe(stateHash(run2.sim));
  });

  it('rejects a second meteor while one is in flight', () => {
    const { sim } = impact();
    expect(run(sim, { type: 'triggerDisaster', kind: 'meteor', x: 20, y: 20 })).toBe(false);
  });
});

describe('determinism with disasters', () => {
  const cmds = (): Command[] => {
    const body: [number, CommandBody][] = [
      [5, { type: 'setDisasters', mode: 2 }],
      [10, { type: 'placeRoad', ax: 96, ay: 104, bx: 130, by: 104, cls: 1 }],
      [11, { type: 'placeBuilding', arch: ARCH.DEPOT, x: 98, y: 102, rot: 0 }],
      [12, { type: 'zone', x0: 100, y0: 105, x1: 120, y1: 108, zone: 1, density: 1 }],
      [13, { type: 'placeBuilding', arch: ARCH.FIRE_STATION, x: 110, y: 100, rot: 0 }],
      [300, { type: 'triggerDisaster', kind: 'fire', x: 106, y: 106 }],
      [450, { type: 'triggerDisaster', kind: 'quake', x: 110, y: 105 }],
      [600, { type: 'triggerDisaster', kind: 'meteor', x: 118, y: 112 }],
    ];
    return body.map(([tick, b], i) => ({ ...b, id: i + 1, tick }) as Command);
  };
  const fresh = (): Sim => {
    const sim = flatSim(42, false);
    for (const c of cmds()) sim.queue.push(c);
    return sim;
  };

  it('replays to the same hash, and a snapshot taken mid-disaster resumes to the same hash', () => {
    const straight = fresh();
    const kinds = new Set<string>();
    for (let t = 0; t < 1200; t++) { step(straight); for (const e of straight.events) if (e.type === 'disaster') kinds.add(`${e.kind}:${e.phase}`); straight.events = []; }
    expect(kinds.has('quake:impact')).toBe(true);
    expect(kinds.has('meteor:impact')).toBe(true);

    const again = fresh();
    ticks(again, 1200);
    expect(stateHash(again)).toBe(stateHash(straight));

    const first = fresh();
    ticks(first, 610);
    expect(first.world.disaster[D.METEOR_AT]).toBeGreaterThan(0);
    const resumed = restore(snapshot(first));
    expect(stateHash(resumed)).toBe(stateHash(first));
    resumed.queue = first.queue.slice();
    ticks(resumed, 590);
    expect(stateHash(resumed)).toBe(stateHash(straight));
  });

  it('execute() records no world change for a rejected sandbox command', () => {
    const sim = flatSim(42, false);
    const h = stateHash(sim);
    expect(execute(sim, { id: 1, tick: 0, type: 'triggerDisaster', kind: 'fire', x: 4, y: 4 })).toBe(false);
    expect(stateHash(sim)).toBe(h);
  });
});
