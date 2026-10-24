import { describe, expect, it } from 'vitest';
import { ARCH, rciId } from './catalog.ts';
import { execute, type Command, type CommandBody } from './commands.ts';
import {
  DIRECTIVES, DIRECTIVE_COUNT, DIRECTIVE_PERIOD, MEGA_SAVINGS_GOAL, ROAD_GOAL, directiveHave, directiveIndex, directiveMet, directiveStats, scanFacts,
} from './directives.ts';
import { apply, createSim, packAgents, restore, snapshot, stateHash, step } from './engine.ts';
import { AMAX, MAP, S, SPEC } from './layers.ts';
import { AKIND } from './robots/constants.ts';
import { flatSim, road, run, zone, depot } from './robots/testkit.ts';
import { starterSite, STARTER_BUILDERS, STARTER_HAULERS } from './starter.ts';
import type { Sim } from './world.ts';

const idOf = (id: string): number => directiveIndex(id);
const haveOf = (sim: Sim, id: string): number => directiveHave(scanFacts(sim.world))[idOf(id)]!;
const need = (id: string): number => DIRECTIVES[idOf(id)]!.need;
const met = (sim: Sim, id: string): boolean => directiveMet(sim.world, idOf(id));

/** Run a command through the same path the queue uses and return the events it produced. */
function claim(sim: Sim, index: number): string {
  sim.events = [];
  const ok = execute(sim, { type: 'claimDirective', index, id: 900 + index, tick: 0 } as Command);
  const rejected = sim.events.find((e) => e.type === 'rejected');
  return ok ? 'ok' : (rejected as { reason: string }).reason;
}

describe('the directive table', () => {
  it('has twelve distinct directives that fit the two bit masks, each with a reward and a need', () => {
    expect(DIRECTIVE_COUNT).toBe(12);
    expect(new Set(DIRECTIVES.map((d) => d.id)).size).toBe(DIRECTIVE_COUNT);
    expect(DIRECTIVE_COUNT).toBeLessThanOrEqual(31);
    for (const d of DIRECTIVES) { expect(d.reward, d.id).toBeGreaterThan(0); expect(d.need, d.id).toBeGreaterThan(0); }
  });

  it('keeps its three scalars inside the registry scalar array and apart from the others', () => {
    const idx = Object.values(S);
    expect(new Set(idx).size).toBe(idx.length);
    expect(Math.max(...idx)).toBeLessThan(SPEC.scalars.length);
  });

  it('starts every directive unmet on an empty world; saving starts from the opening treasury', () => {
    const sim = flatSim();
    const have = directiveHave(scanFacts(sim.world));
    expect(have.map((h, i) => h >= DIRECTIVES[i]!.need)).toEqual(DIRECTIVES.map(() => false));
    expect(have.filter((h, i) => i !== idOf('megaproject'))).toEqual(DIRECTIVES.slice(1).map(() => 0));
    expect(have[idOf('megaproject')]).toBe(sim.world.scalars[S.treasury]);
  });
});

describe('conditions from synthetic worlds', () => {
  it('road: counts road tiles connected to a depot door, capped, and ignores a road elsewhere', () => {
    const sim = flatSim();
    depot(sim, 98, 102);
    road(sim, 200, 200, 230, 200);
    expect(haveOf(sim, 'road')).toBe(0);
    road(sim, 96, 104, 100, 104);
    expect(haveOf(sim, 'road')).toBe(5);
    expect(met(sim, 'road')).toBe(false);
    road(sim, 100, 104, 130, 104);
    expect(haveOf(sim, 'road')).toBe(ROAD_GOAL);
    expect(met(sim, 'road')).toBe(true);
  });

  it('residential, commercial and industrial: count zoned tiles of that type and nothing else', () => {
    const sim = flatSim();
    zone(sim, 10, 10, 13, 12, 1);
    expect(haveOf(sim, 'residential')).toBe(12);
    expect(met(sim, 'residential')).toBe(true);
    expect(haveOf(sim, 'commercial')).toBe(0);
    zone(sim, 20, 10, 22, 12, 2);
    expect(scanFacts(sim.world).zoned[2]).toBe(9);
    expect(haveOf(sim, 'commercial')).toBe(need('commercial'));
    expect(met(sim, 'commercial')).toBe(true);
    zone(sim, 30, 10, 31, 12, 3);
    expect(haveOf(sim, 'industrial')).toBe(6);
    expect(met(sim, 'industrial')).toBe(false);
    zone(sim, 30, 13, 31, 14, 3);
    expect(met(sim, 'industrial')).toBe(true);
  });

  it('zoned tiles that a building now covers still count, so a built lot does not undo the step', () => {
    const sim = flatSim(42, true);
    zone(sim, 10, 10, 13, 12, 1);
    const before = haveOf(sim, 'residential');
    run(sim, { type: 'debugGrow', x: 10, y: 10, archetype: rciId(1, 0, 1), progress: 0.5 });
    expect(haveOf(sim, 'residential')).toBe(before);
  });

  it('firstHome: needs a finished residential building, not a site under construction or a shop', () => {
    const sim = flatSim(42, true);
    run(sim, { type: 'debugGrow', x: 10, y: 10, archetype: rciId(1, 0, 1), progress: 0.5 });
    expect(met(sim, 'firstHome')).toBe(false);
    run(sim, { type: 'debugGrow', x: 20, y: 10, archetype: rciId(2, 0, 1), progress: 1 });
    expect(met(sim, 'firstHome')).toBe(false);
    run(sim, { type: 'debugGrow', x: 30, y: 10, archetype: rciId(1, 0, 1), progress: 1 });
    expect(met(sim, 'firstHome')).toBe(true);
  });

  it('power and water: each needs the building and the line or pipe, one point apiece', () => {
    const sim = flatSim();
    run(sim, { type: 'placeBuilding', arch: ARCH.POWER_PLANT, x: 40, y: 40, rot: 0 });
    expect(haveOf(sim, 'power')).toBe(1);
    expect(met(sim, 'power')).toBe(false);
    run(sim, { type: 'placeLine', kind: 'power', ax: 44, ay: 41, bx: 50, by: 41 });
    expect(haveOf(sim, 'power')).toBe(2);
    expect(met(sim, 'power')).toBe(true);
    run(sim, { type: 'placeLine', kind: 'water', ax: 60, ay: 60, bx: 64, by: 60 });
    expect(haveOf(sim, 'water')).toBe(1);
    run(sim, { type: 'placeBuilding', arch: ARCH.WATER_PUMP, x: 70, y: 70, rot: 0 });
    expect(met(sim, 'water')).toBe(true);
  });

  it('population, settlement and the tier read the sim scalars', () => {
    const sim = flatSim();
    sim.world.scalars[S.population] = 99;
    expect(met(sim, 'population')).toBe(false);
    sim.world.scalars[S.population] = 100;
    expect(met(sim, 'population')).toBe(true);
    expect(met(sim, 'settlement')).toBe(false);
    sim.world.scalars[S.tier] = 1;
    expect(met(sim, 'settlement')).toBe(true);
  });

  it('safety: a fire station or a clinic', () => {
    const a = flatSim(), b = flatSim();
    expect(met(a, 'safety')).toBe(false);
    run(a, { type: 'placeBuilding', arch: ARCH.FIRE_STATION, x: 40, y: 40, rot: 0 });
    run(b, { type: 'placeBuilding', arch: ARCH.CLINIC, x: 40, y: 40, rot: 0 });
    expect(met(a, 'safety')).toBe(true);
    expect(met(b, 'safety')).toBe(true);
  });

  it('upgrade: medium density zoning, or an avenue', () => {
    const a = flatSim(), b = flatSim();
    zone(a, 10, 10, 11, 11, 1, 0);
    expect(met(a, 'upgrade')).toBe(false);
    zone(a, 20, 10, 21, 11, 1, 1);
    expect(met(a, 'upgrade')).toBe(true);
    b.world.scalars[S.tier] = 2;
    run(b, { type: 'placeRoad', ax: 10, ay: 10, bx: 20, by: 10, cls: 2 });
    expect(met(b, 'upgrade')).toBe(true);
  });

  it('megaproject: the treasury reaching the cheapest project, or a project standing', () => {
    const sim = flatSim(42, true);
    sim.world.scalars[S.treasury] = MEGA_SAVINGS_GOAL - 1;
    expect(haveOf(sim, 'megaproject')).toBe(MEGA_SAVINGS_GOAL - 1);
    expect(met(sim, 'megaproject')).toBe(false);
    sim.world.scalars[S.treasury] = MEGA_SAVINGS_GOAL;
    expect(met(sim, 'megaproject')).toBe(true);
    sim.world.scalars[S.treasury] = 10;
    expect(met(sim, 'megaproject')).toBe(false);
    run(sim, { type: 'debugGrow', x: 100, y: 100, archetype: ARCH.FUSION_SPIRE, progress: 0.5 });
    expect(met(sim, 'megaproject')).toBe(true);
  });
});

describe('the directives system', () => {
  const tickTo = (sim: Sim, tick: number): void => { while (sim.world.scalars[S.tick]! < tick) step(sim); };

  it('latches a met directive once, fires one directiveReady, and keeps it done after the evidence is bulldozed', () => {
    const sim = flatSim();
    zone(sim, 10, 10, 13, 12, 1);
    tickTo(sim, DIRECTIVE_PERIOD);
    const ready = sim.events.filter((e) => e.type === 'directiveReady');
    expect(ready).toEqual([{ type: 'directiveReady', tick: DIRECTIVE_PERIOD, index: idOf('residential') }]);
    expect(directiveStats(sim.world).done).toBe(1 << idOf('residential'));
    run(sim, { type: 'bulldoze', x0: 10, y0: 10, x1: 13, y1: 12 });
    sim.events = [];
    tickTo(sim, DIRECTIVE_PERIOD * 3);
    expect(sim.events.filter((e) => e.type === 'directiveReady')).toEqual([]);
    expect(directiveStats(sim.world).done).toBe(1 << idOf('residential'));
    expect(directiveStats(sim.world).have[idOf('residential')]).toBe(0);
  });

  it('fires firstBuilding once, with the footprint of the first finished grown building', () => {
    const sim = flatSim(42, true);
    run(sim, { type: 'debugGrow', x: 10, y: 10, archetype: rciId(1, 0, 1), progress: 0.5 });
    tickTo(sim, DIRECTIVE_PERIOD);
    expect(sim.events.filter((e) => e.type === 'firstBuilding')).toEqual([]);
    run(sim, { type: 'debugGrow', x: 30, y: 10, archetype: rciId(1, 0, 1), progress: 1 });
    tickTo(sim, DIRECTIVE_PERIOD * 2);
    const first = sim.events.filter((e) => e.type === 'firstBuilding');
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ x: 30, y: 10, w: 1, h: 1 });
    run(sim, { type: 'debugGrow', x: 40, y: 10, archetype: rciId(1, 0, 1), progress: 1 });
    sim.events = [];
    tickTo(sim, DIRECTIVE_PERIOD * 4);
    expect(sim.events.filter((e) => e.type === 'firstBuilding')).toEqual([]);
  });
});

describe('claimDirective', () => {
  it('pays the reward once and rejects the second claim as claimed, leaving the treasury alone', () => {
    const sim = flatSim();
    zone(sim, 10, 10, 13, 12, 1);
    const index = idOf('residential');
    const before = sim.world.scalars[S.treasury]!;
    expect(claim(sim, index)).toBe('ok');
    expect(sim.world.scalars[S.treasury]).toBe(before + DIRECTIVES[index]!.reward);
    expect(sim.events.find((e) => e.type === 'directiveClaimed')).toMatchObject({ index, reward: DIRECTIVES[index]!.reward });
    expect(directiveStats(sim.world).claimed).toBe(1 << index);
    const after = sim.world.scalars[S.treasury]!;
    expect(claim(sim, index)).toBe('claimed');
    expect(sim.world.scalars[S.treasury]).toBe(after);
    expect(directiveStats(sim.world).claimed).toBe(1 << index);
  });

  it('rejects a directive that is not met, a bad index, and stays rejected after it was claimed even if the evidence is gone', () => {
    const sim = flatSim();
    const before = sim.world.scalars[S.treasury]!;
    expect(claim(sim, idOf('residential'))).toBe('not-ready');
    for (const bad of [-1, DIRECTIVE_COUNT, 1.5, NaN]) expect(claim(sim, bad)).toBe('invalid');
    expect(sim.world.scalars[S.treasury]).toBe(before);
    zone(sim, 10, 10, 13, 12, 1);
    expect(claim(sim, idOf('residential'))).toBe('ok');
    run(sim, { type: 'bulldoze', x0: 10, y0: 10, x1: 13, y1: 12 });
    expect(claim(sim, idOf('residential'))).toBe('claimed');
  });

  it('pays a directive whose condition lapsed after it latched, because done never clears', () => {
    const sim = flatSim();
    zone(sim, 10, 10, 13, 12, 1);
    for (let i = 0; i < DIRECTIVE_PERIOD; i++) step(sim);
    run(sim, { type: 'bulldoze', x0: 10, y0: 10, x1: 13, y1: 12 });
    expect(met(sim, 'residential')).toBe(false);
    expect(claim(sim, idOf('residential'))).toBe('ok');
  });

  it('is saved and hashed: claimed state survives a snapshot and changes the world hash', () => {
    const sim = flatSim();
    zone(sim, 10, 10, 13, 12, 1);
    const unclaimed = stateHash(sim);
    claim(sim, idOf('residential'));
    expect(stateHash(sim)).not.toBe(unclaimed);
    const back = restore(snapshot(sim));
    expect(directiveStats(back.world).claimed).toBe(1 << idOf('residential'));
    expect(stateHash(back)).toBe(stateHash(sim));
    expect(claim(back, idOf('residential'))).toBe('claimed');
  });
});

describe('the starter kit', () => {
  const starter = (seed = 42): Sim => createSim(seed, { starter: true });
  const depots = (sim: Sim): number[] => [...sim.world.bArch].flatMap((a, s) => (a === ARCH.DEPOT ? [s] : []));
  const robots = (sim: Sim, kind: number): number => sim.world.aKind.slice(0, AMAX).filter((k) => k === kind).length;

  it('puts one finished depot, a street at its door and an idle crew in a new city at tick 0', () => {
    const sim = starter();
    const [slot, ...more] = depots(sim);
    expect(slot).toBeDefined();
    expect(more).toEqual([]);
    const w = sim.world;
    expect(sim.world.scalars[S.tick]).toBe(0);
    expect(w.bFlags[slot!]).toBe(0);
    expect(w.bStock[slot!]).toBeGreaterThan(0);
    expect(robots(sim, AKIND.BUILDER)).toBe(STARTER_BUILDERS);
    expect(robots(sim, AKIND.HAULER)).toBe(STARTER_HAULERS);
    expect(scanFacts(w).depotRoad).toBe(6);
    expect(sim.roads!.isRoad(w.bY[slot!]! * MAP + w.bX[slot!]! + 2 * MAP)).toBe(true);
  });

  it('costs nothing and is the same for the same seed, different for another', () => {
    const a = starter(42), b = starter(42), c = starter(7);
    expect(a.world.scalars[S.treasury]).toBe(createSim(42).world.scalars[S.treasury]);
    expect(stateHash(a)).toBe(stateHash(b));
    expect(stateHash(a)).not.toBe(stateHash(c));
  });

  it('sits on flat dry land, with the window clear of water', () => {
    for (const seed of [1, 7, 42, 99, 1234]) {
      const sim = createSim(seed);
      const site = starterSite(sim.world);
      expect(site, `seed ${seed}`).not.toBeNull();
      const w = sim.world;
      let lo = Infinity, hi = -Infinity;
      for (let y = site!.y; y < site!.y + 10; y++) for (let x = site!.x; x < site!.x + 16; x++) {
        expect(w.waterDepth[y * MAP + x], `seed ${seed} ${x},${y}`).toBe(0);
        lo = Math.min(lo, w.height[y * MAP + x]!); hi = Math.max(hi, w.height[y * MAP + x]!);
      }
      expect(hi - lo, `seed ${seed}`).toBeLessThanOrEqual(32);
    }
  });

  it('is only added by createSim for a new city: a bare sim and a restored snapshot never get one', () => {
    const bare = createSim(42);
    expect(depots(bare)).toEqual([]);
    expect(robots(bare, AKIND.BUILDER)).toBe(0);
    const loaded = restore(snapshot(bare));
    expect(depots(loaded)).toEqual([]);
    expect(robots(loaded, AKIND.BUILDER) + robots(loaded, AKIND.HAULER)).toBe(0);
    const kept = restore(snapshot(starter()));
    expect(depots(kept)).toHaveLength(1);
    expect(robots(kept, AKIND.BUILDER)).toBe(STARTER_BUILDERS);
  });

  it('sends the idle crew to the renderer but keeps idle firefighters in their station', () => {
    const sim = starter();
    const pos = new Float32Array(AMAX * 3), ids = new Uint32Array(AMAX * 2);
    expect(packAgents(sim, pos, ids)).toBe(STARTER_BUILDERS + STARTER_HAULERS);
    const slot = sim.world.aKind.indexOf(AKIND.BUILDER);
    sim.world.aKind[slot] = AKIND.FIREFIGHTER;
    expect(packAgents(sim, pos, ids)).toBe(STARTER_BUILDERS + STARTER_HAULERS - 1);
  });

  it('lets the crew start work at once: a zone beside the starter street gets a building under construction', () => {
    const sim = starter();
    const s = depots(sim)[0]!, x = sim.world.bX[s]!, y = sim.world.bY[s]!;
    apply(sim, { id: 1, tick: 0, type: 'zone', x0: x, y0: y + 3, x1: x + 5, y1: y + 4, zone: 1, density: 0 });
    let built = false;
    for (let t = 0; t < 2500 && !built; t++) {
      step(sim);
      built = scanFacts(sim.world).finishedR > 0;
    }
    expect(built).toBe(true);
  }, 60000);
});

describe('the chain under a scripted command sequence', () => {
  /** Road out from the starter street, homes beside it, a claim for each, run for 400 ticks. */
  function play(seed: number): Sim {
    const sim = createSim(seed, { starter: true });
    const s = sim.world.bArch.indexOf(ARCH.DEPOT);
    const x = sim.world.bX[s]!, y = sim.world.bY[s]!;
    const script: [number, CommandBody][] = [
      [3, { type: 'placeRoad', ax: x + 4, ay: y + 2, bx: x + 12, by: y + 2, cls: 1 }],
      [20, { type: 'claimDirective', index: idOf('road') }],
      [21, { type: 'claimDirective', index: idOf('road') }],
      [30, { type: 'zone', x0: x, y0: y + 3, x1: x + 5, y1: y + 4, zone: 1, density: 0 }],
      [60, { type: 'claimDirective', index: idOf('residential') }],
      [61, { type: 'claimDirective', index: idOf('commercial') }],
      [70, { type: 'zone', x0: x + 7, y0: y + 3, x1: x + 10, y1: y + 4, zone: 2, density: 0 }],
      [90, { type: 'claimDirective', index: idOf('commercial') }],
    ];
    script.forEach(([tick, body], i) => apply(sim, { ...body, id: i + 1, tick } as Command));
    for (let t = 0; t < 400; t++) step(sim);
    return sim;
  }

  it('pays exactly the claims that were ready, once each', () => {
    const sim = play(42);
    const stats = directiveStats(sim.world);
    expect(stats.claimed).toBe((1 << idOf('road')) | (1 << idOf('residential')) | (1 << idOf('commercial')));
    expect(stats.done & stats.claimed).toBe(stats.claimed);
    expect(stats.have[idOf('road')]).toBe(ROAD_GOAL);
  });

  it('is deterministic: two runs match, and a snapshot taken mid-way resumes to the same hash', () => {
    expect(stateHash(play(42))).toBe(stateHash(play(42)));
    const straight = play(42);
    const first = createSim(42, { starter: true });
    const resumed = restore(snapshot(first));
    expect(stateHash(resumed)).toBe(stateHash(first));
    for (let t = 0; t < 100; t++) { step(first); step(resumed); }
    expect(stateHash(resumed)).toBe(stateHash(first));
    expect(stateHash(straight)).not.toBe(stateHash(first));
  }, 60000);
});
