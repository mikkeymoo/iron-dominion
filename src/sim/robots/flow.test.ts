import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARCH, BFLAG, rciId } from '../catalog.ts';
import { restore, snapshot, stateHash, step } from '../engine.ts';
import { AMAX, MAP, ROAD, S } from '../layers.ts';
import { roadsOf } from '../roads/index.ts';
import { runTicks } from '../testkit.ts';
import { SYSTEMS } from '../tick.ts';
import { AKIND, AST, DEPOT_START_STOCK, depotAccess, despawnAgent, pathOf, spawnAgent, startTrip } from './index.ts';
import {
  active, agents, constructing, depot, depots, finished, flatSim, grown, ringTown, road, run, runUntil, slotsOf, town,
} from './testkit.ts';

vi.setConfig({ testTimeout: 120000 });
afterEach(() => new Promise<void>((r) => { setTimeout(r, 0); }));

const onRoad = (sim: ReturnType<typeof flatSim>, a: number): boolean =>
  (sim.world.road[Math.floor(sim.world.aY[a]!) * MAP + Math.floor(sim.world.aX[a]!)]! & ROAD.CLASS_MASK) !== 0;

describe('material', () => {
  it('makes no progress without material, advances only to the delivered fraction, and finishes when the rest arrives', () => {
    const sim = town();
    const w = sim.world;
    expect(runUntil(sim, () => agents(sim, AKIND.BUILDER).some((a) => w.aState[a] === AST.WORK && w.aFrac[a]! >= 1), 1500)).toBe(true);
    const worker = agents(sim, AKIND.BUILDER).find((a) => w.aState[a] === AST.WORK)!;
    const site = (w.aTarget[worker]! & 0xffff) - 1;
    const need = w.jNeed[site]!;
    // Pretend nothing was delivered and everything is already on its way, so no new haulers are sent.
    w.jHave[site] = 0; w.jProg[site] = 0; w.jInbound[site] = need;
    runTicks(sim, 120);
    expect(w.jProg[site]).toBe(0);
    expect(w.bProg[site]).toBe(0);
    w.jHave[site] = need >> 1;
    runTicks(sim, 600);
    expect(w.jProg[site]).toBe(Math.floor(((need >> 1) * 65535) / need));
    expect(w.jKind[site]).not.toBe(0);
    w.jHave[site] = need;
    expect(runUntil(sim, () => w.jKind[site] === 0, 3000)).toBe(true);
    expect(w.bFlags[site]! & BFLAG.CONSTRUCTING).toBe(0);
  });

  it('keeps progress at or below the delivered material fraction on every tick', () => {
    const sim = town();
    const w = sim.world;
    for (let t = 0; t < 1500; t++) {
      step(sim);
      for (let s = 0; s < w.jKind.length; s++) {
        const k = w.jKind[s]!;
        if (k !== 1 && k !== 2) continue;
        const need = w.jNeed[s]!;
        expect(w.jProg[s]!).toBeLessThanOrEqual(w.jHave[s]! >= need ? 65535 : Math.floor((w.jHave[s]! * 65535) / need));
      }
    }
  });

  it('industry produces into its own stock and depots start stocked', () => {
    const sim = flatSim(42, true);
    const w = sim.world;
    run(sim, { type: 'debugGrow', x: 20, y: 20, archetype: rciId(3, 0, 1), progress: 1 });
    run(sim, { type: 'debugGrow', x: 30, y: 20, archetype: rciId(3, 0, 1), progress: 0.5 });
    depot(sim, 40, 20);
    runTicks(sim, 200);
    const [done, building] = slotsOf(sim, (s) => w.bArch[s] === rciId(3, 0, 1)) as [number, number];
    expect(w.bStock[done]).toBeGreaterThanOrEqual(5);
    expect(w.bStock[building]).toBe(0);
    expect(w.bStock[depots(sim)[0]!]).toBeGreaterThanOrEqual(DEPOT_START_STOCK - 10);
  });
});

describe('movement', () => {
  it('keeps every moving robot, haulers included, on a road tile', () => {
    const sim = town();
    let moving = 0;
    for (let t = 0; t < 1500; t++) {
      step(sim);
      for (const a of agents(sim)) {
        const st = sim.world.aState[a]!;
        if (st === AST.IDLE || st === AST.WORK) continue;
        moving++;
        expect(onRoad(sim, a), `agent ${a} state ${st} at ${sim.world.aX[a]},${sim.world.aY[a]} tick ${t}`).toBe(true);
      }
    }
    expect(moving).toBeGreaterThan(200);
  });

  it('replans around a road cut while a hauler is under way and still finishes', () => {
    const sim = ringTown();
    const w = sim.world;
    const net = roadsOf(sim);
    expect(runUntil(sim, () => agents(sim, AKIND.HAULER).some((a) => w.aState[a] === AST.HAUL), 2000)).toBe(true);
    const a = agents(sim, AKIND.HAULER).find((h) => w.aState[h] === AST.HAUL)!;
    const path = pathOf(net, w, a)!;
    const cut = path[Math.min(path.length - 2, w.aStep[a]! + 3)]!;
    const epoch = w.scalars[S.graphEpoch]!;
    expect(run(sim, { type: 'bulldoze', x0: cut & 255, y0: cut >> 8, x1: cut & 255, y1: cut >> 8 })).toBe(true);
    step(sim);
    expect(w.scalars[S.graphEpoch]).toBeGreaterThan(epoch);
    if (w.aState[a] === AST.HAUL) {
      const np = pathOf(roadsOf(sim), w, a);
      if (np) expect(Array.from(np)).not.toContain(cut);
    }
    const before = finished(sim).length;
    for (let t = 0; t < 4000 && finished(sim).length <= before; t++) {
      step(sim);
      for (const h of agents(sim)) if (w.aState[h] !== AST.IDLE && w.aState[h] !== AST.WORK) expect(onRoad(sim, h)).toBe(true);
    }
    expect(finished(sim).length).toBeGreaterThan(before);
  });

  it('waits and retries with backoff when a robot has no path', () => {
    const sim = flatSim();
    road(sim, 96, 104, 110, 104);
    road(sim, 96, 120, 110, 120);
    depot(sim, 98, 102);
    runTicks(sim, 60);
    const w = sim.world, net = roadsOf(sim);
    const b = agents(sim, AKIND.BUILDER)[0]!;
    const from = depotAccess(net, w, depots(sim)[0]!);
    w.aState[b] = AST.RETURN;
    expect(startTrip(net, w, b, from, 120 * MAP + 100)).toBe(false);
    runTicks(sim, 5);
    expect(w.aTry[b]).toBeGreaterThan(0);
    expect(w.aWait[b]).toBeGreaterThan(0);
  });
});

describe('cancellation and depots', () => {
  it('cancels a job when its lot is bulldozed and frees the robots', () => {
    const sim = town();
    const w = sim.world;
    expect(runUntil(sim, () => constructing(sim).length > 0 && active(sim).length > 0, 600)).toBe(true);
    runTicks(sim, 60);
    const site = constructing(sim)[0]!;
    const ref = (site + 1) | (w.bGen[site]! << 16);
    expect(agents(sim).filter((a) => w.aTarget[a] === ref).length).toBeGreaterThan(0);
    const x = w.bX[site]!, y = w.bY[site]!, bw = w.bW[site]!, bh = w.bH[site]!;
    expect(run(sim, { type: 'bulldoze', x0: x, y0: y, x1: x + bw - 1, y1: y + bh - 1 })).toBe(true);
    step(sim);
    expect(w.bGen[site]).not.toBe(ref >>> 16);
    runTicks(sim, 5);
    // A robot still walking to a pickup may keep its stale reference until it arrives, but none is working or hauling for it.
    const stale = agents(sim).filter((a) => w.aTarget[a] === ref);
    for (const a of stale) expect([AST.TO_PICKUP, AST.IDLE, AST.RETURN]).toContain(w.aState[a]);
    runTicks(sim, 600);
    expect(agents(sim).filter((a) => w.aTarget[a] === ref)).toHaveLength(0);
  });

  it('stalls jobs when the only depot is deleted, and the robots go idle', () => {
    const sim = town();
    const w = sim.world;
    expect(runUntil(sim, () => constructing(sim).length > 0 && active(sim).length > 0, 600)).toBe(true);
    runTicks(sim, 40);
    const d = depots(sim)[0]!;
    const x = w.bX[d]!, y = w.bY[d]!;
    expect(run(sim, { type: 'bulldoze', x0: x, y0: y, x1: x + 1, y1: y + 1 })).toBe(true);
    runTicks(sim, 200);
    const prog = constructing(sim).map((s) => w.jProg[s]!);
    expect(prog.length).toBeGreaterThan(0);
    runTicks(sim, 200);
    expect(constructing(sim).map((s) => w.jProg[s]!)).toEqual(prog);
    expect(active(sim)).toHaveLength(0);
    const count = grown(sim).length;
    runTicks(sim, 300);
    expect(grown(sim)).toHaveLength(count);
    runTicks(sim, 800);
    expect(agents(sim)).toHaveLength(0);
  });

  it('reassigns robots to another depot when theirs is deleted', () => {
    const sim = town();
    const w = sim.world;
    depot(sim, 126, 102);
    runTicks(sim, 500);
    const first = slotsOf(sim, (s) => w.bArch[s] === ARCH.DEPOT && w.bX[s] === 98)[0]!;
    expect(run(sim, { type: 'bulldoze', x0: 98, y0: 102, x1: 99, y1: 103 })).toBe(true);
    expect(w.bArch[first]).toBe(0);
    const before = finished(sim).length;
    expect(runUntil(sim, () => finished(sim).length > before + 1, 8000)).toBe(true);
    const second = depots(sim)[0]!;
    expect(agents(sim).length).toBeGreaterThan(0);
    expect(agents(sim).every((a) => (w.aHome[a]! & 0xffff) === second + 1)).toBe(true);
  });
});

describe('agent pool', () => {
  it('increments the slot generation each time a slot is reused', () => {
    const w = flatSim().world;
    const a = spawnAgent(w, AKIND.HAULER, 0, 1, 1);
    const gen0 = w.aGen[a]!;
    despawnAgent(w, a);
    expect(w.aGen[a]).toBe(gen0 + 1);
    const b = spawnAgent(w, AKIND.BUILDER, 0, 2, 2);
    expect(b).toBe(a);
    expect(w.aGen[b]).toBe(gen0 + 1);
    despawnAgent(w, b);
    expect(w.aGen[b]).toBe(gen0 + 2);
  });
});

describe('determinism with robots active', () => {
  it('resumes from a snapshot mid-build: 150 + restore + 150 equals 300 straight', () => {
    const straight = town();
    runTicks(straight, 300);
    const first = town();
    runTicks(first, 150);
    expect(active(first).length).toBeGreaterThan(0);
    expect(constructing(first).length).toBeGreaterThan(0);
    const resumed = restore(snapshot(first));
    expect(stateHash(resumed)).toBe(stateHash(first));
    runTicks(resumed, 150);
    expect(stateHash(resumed)).toBe(stateHash(straight));
  });

  it('resumes across a road change: cut at 120, snapshot, 200 more equals the straight run', () => {
    const cut = (sim: ReturnType<typeof flatSim>): void => { run(sim, { type: 'bulldoze', x0: 112, y0: 100, x1: 112, y1: 100 }); };
    const straight = ringTown();
    runTicks(straight, 120); cut(straight); runTicks(straight, 201);
    const first = ringTown();
    runTicks(first, 120); cut(first); step(first);
    const resumed = restore(snapshot(first));
    runTicks(resumed, 200);
    expect(stateHash(resumed)).toBe(stateHash(straight));
  });
});

describe('perf', () => {
  it('runs 2000 active robots in about 2 ms per tick of robot work (prints)', () => {
    const sim = flatSim();
    const w = sim.world;
    w.scalars[S.treasury] = 1e9;
    road(sim, 4, 50, 251, 50);
    for (let k = 0; k < 123; k++) { depot(sim, 4 + 2 * k, 48); depot(sim, 4 + 2 * k, 51); }
    const net = roadsOf(sim);
    expect(depots(sim)).toHaveLength(246);
    const kick = (): void => {
      for (let a = 0; a < AMAX; a++) {
        if (w.aKind[a] === 0 || w.aState[a] !== AST.IDLE) continue;
        const home = (w.aHome[a]! & 0xffff) - 1;
        if (home < 0 || w.bArch[home] !== ARCH.DEPOT) continue;
        const far = 50 * MAP + (((a * 37) % 240) + 8);
        if (startTrip(net, w, a, depotAccess(net, w, home), far)) w.aState[a] = AST.RETURN;
      }
    };
    for (let t = 0; t < 400; t++) { step(sim); kick(); }
    expect(agents(sim).length).toBeGreaterThanOrEqual(1900);
    const ms: Record<string, number> = {};
    let activeSum = 0;
    const N = 200;
    for (let t = 0; t < N; t++) {
      for (const sys of SYSTEMS) {
        const t0 = performance.now();
        sys.run(sim);
        ms[sys.name] = (ms[sys.name] ?? 0) + performance.now() - t0;
      }
      kick();
      activeSum += active(sim).length;
    }
    const robots = ms.growth! / N;
    console.log(`perf: ${agents(sim).length} robots, avg ${Math.round(activeSum / N)} active, robots system ${robots.toFixed(3)} ms/tick, whole tick ${(Object.values(ms).reduce((x, y) => x + y, 0) / N).toFixed(3)} ms`);
    expect(activeSum / N).toBeGreaterThan(1500);
    // The target is 2 ms; the gate is double that so a busy CI machine does not flake it.
    expect(robots).toBeLessThan(4);
  });
});
