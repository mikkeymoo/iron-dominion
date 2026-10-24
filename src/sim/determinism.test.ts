import { describe, expect, it } from 'vitest';
import golden from './golden.json';
import { createSim, restore, snapshot, stateHash } from './engine.ts';
import { hashWorld } from './hash.ts';
import { REGISTRY, S } from './layers.ts';
import { fnv1a } from './hash.ts';
import { decodeSnapshot, encodeSnapshot } from './snapshot.ts';
import { runScripted, runTicks, scriptedCity } from './testkit.ts';
import { gridCity } from './traffic/testkit.ts';
import { disasterModeOf, DEFAULT_SETTINGS } from '../platform/settings.ts';
import type { Sim } from './world.ts';

const DEFAULT_DISASTERS = disasterModeOf(DEFAULT_SETTINGS.disasters);

interface Golden {
  seed: number;
  scripted: { ticks: number; hash: number };
  /**
   * Seed 42, no commands, 200 ticks, opened on the default Disasters setting (Rare, which the app's Hello carries) with the
   * starter kit the worker always asks for: what `?seed=42&haltAt=200` must report in the browser worker.
   */
  idle: { ticks: number; hash: number };
  /** A completed 4x4 block street grid on flat land (traffic/testkit.ts gridCity) with traffic running: the scripted city builds no completed buildings in 2000 ticks, so this is the golden that covers vehicles. */
  traffic: { ticks: number; hash: number };
}

/** The layers added after the first golden: firmware's two (bMod, firmware), the scenario layer and the council's (approval, requests, festivals), all zeros in a sandbox city, and the production chain's six (jRes, aRes, bAlloy, bParts, bIn, chain). */
const FIRMWARE_LAYERS = new Set(['bMod', 'firmware', 'scenario', 'council', 'jRes', 'aRes', 'bAlloy', 'bParts', 'bIn', 'chain']);
const legacyHash = (sim: Sim): number => hashWorld(sim.world, (name) => !FIRMWARE_LAYERS.has(name));

function compute(): Golden & { legacy: { scripted: number; idle: number; traffic: number } } {
  const sim = createSim(42);
  runScripted(sim, scriptedCity(sim.world), 2000);
  const idle = createSim(42, { disasters: DEFAULT_DISASTERS, starter: true });
  runTicks(idle, 200);
  const town = trafficTown();
  return {
    seed: 42, scripted: { ticks: 2000, hash: stateHash(sim) }, idle: { ticks: 200, hash: stateHash(idle) }, traffic: { ticks: 300, hash: stateHash(town) },
    legacy: { scripted: legacyHash(sim), idle: legacyHash(idle), traffic: legacyHash(town) },
  };
}

/** A 4x4 block grid in the morning rush, 300 ticks in: small enough to be quick, busy enough to have vehicles on the road and trips done. */
function trafficTown(): ReturnType<typeof gridCity> {
  const town = gridCity({ cols: 4, rows: 4 });
  runTicks(town, 300);
  return town;
}

describe('determinism', () => {
  // The firmware, scenario and council units added layers (bMod, firmware, scenario, council), so the golden hashes moved. `legacy` holds the
  // hashes from before them, over every other layer: they must still match, which shows a city that buys no firmware, fits no module, enacts no
  // edict, opens no scenario and keeps neutral approval (the golden runs end before the first budget month closes) plays exactly as it did.
  it('matches the golden hashes in golden.json (a deliberate change pastes the printed value there)', () => {
    const got = compute();
    expect(got, `golden.json should become: ${JSON.stringify(got)}`).toEqual(golden);
  }, 30000);

  it('the traffic golden city really carries traffic', () => {
    const town = trafficTown();
    expect(town.world.scalars[S.vehicles]! + town.world.scalars[S.tripsDone]!).toBeGreaterThan(5);
  });

  it('executes the scripted city: every command accepted except the deliberate bad one', () => {
    const sim = createSim(42);
    const cmds = scriptedCity(sim.world);
    const events = [] as string[];
    for (const c of cmds) sim.queue.push(c);
    for (let i = 0; i < 100; i++) {
      runTicks(sim, 1);
      for (const e of sim.events) if (e.type === 'rejected') events.push(`${e.cmd}:${e.reason}`);
      sim.events = [];
    }
    expect(events).toEqual([`${cmds.length}:bounds`]);
    expect(sim.world.bArch.filter((v) => v !== 0)).toHaveLength(4);
  });

  it('gives identical hashes for two independent runs', () => {
    const a = createSim(7), b = createSim(7);
    runScripted(a, scriptedCity(a.world), 500);
    runScripted(b, scriptedCity(b.world), 500);
    expect(stateHash(a)).toBe(stateHash(b));
  }, 30000);

  it('resumes from a snapshot: 1000 + restore + 1000 equals 2000 straight', () => {
    const straight = createSim(42);
    runScripted(straight, scriptedCity(straight.world), 2000);

    const first = createSim(42);
    runScripted(first, scriptedCity(first.world), 1000);
    const resumed = restore(snapshot(first));
    expect(stateHash(resumed)).toBe(stateHash(first));
    runTicks(resumed, 1000);
    expect(stateHash(resumed)).toBe(stateHash(straight));
  }, 60000);

  it('soaks 10k ticks on the scripted city without NaN, Infinity or a non-monotonic tick', async () => {
    const sim = createSim(42);
    for (const c of scriptedCity(sim.world)) sim.queue.push(c);
    let prev = 0;
    for (let i = 0; i < 10000; i++) {
      // Yield now and then so vitest's worker heartbeat is not starved by a 30 s synchronous loop.
      if (i % 500 === 0) await new Promise((r) => setTimeout(r, 0));
      runTicks(sim, 1);
      const t = sim.world.scalars[S.tick]!;
      expect(t).toBe(prev + 1);
      prev = t;
    }
    for (const l of REGISTRY) {
      if (!(l.ctor === Float32Array || l.ctor === Float64Array)) continue;
      const arr = sim.world[l.name] as Float32Array | Float64Array;
      for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i]!)) throw new Error(`${l.name}[${i}] = ${arr[i]}`);
    }
    expect(sim.world.scalars[S.treasury]).toBeGreaterThan(0);
  }, 120000);

  it('prints the cost of 1000 ticks (non-gating)', () => {
    const sim = createSim(42);
    for (const c of scriptedCity(sim.world)) sim.queue.push(c);
    const t0 = performance.now();
    runTicks(sim, 1000);
    console.log(`perf: 1000 ticks in ${(performance.now() - t0).toFixed(1)} ms`);
  }, 30000);
});

describe('snapshot', () => {
  const sim = createSim(42);
  runScripted(sim, scriptedCity(sim.world), 300);
  const buf = encodeSnapshot(sim.world);

  it('round-trips every layer exactly', () => {
    const back = decodeSnapshot(buf);
    expect(hashWorld(back)).toBe(hashWorld(sim.world));
    for (const l of REGISTRY) expect(Array.from(back[l.name].slice(0, 64)), l.name).toEqual(Array.from(sim.world[l.name].slice(0, 64)));
  });

  it('rejects truncated, corrupt, wrong-magic and trailing-garbage buffers', () => {
    expect(() => decodeSnapshot(buf.slice(0, buf.length - 1))).toThrow();
    expect(() => decodeSnapshot(buf.slice(0, 100))).toThrow();
    expect(() => decodeSnapshot(new Uint8Array(0))).toThrow();
    const flipped = buf.slice();
    flipped[5000] = flipped[5000]! ^ 0xff;
    expect(() => decodeSnapshot(flipped)).toThrow(/checksum/);
    const magic = buf.slice();
    magic[0] = 0x58;
    expect(() => decodeSnapshot(magic)).toThrow(/magic/);
    const proto = buf.slice();
    new DataView(proto.buffer).setUint16(6, 99, true);
    new DataView(proto.buffer).setUint32(proto.length - 4, fnv1a(proto.subarray(0, proto.length - 4)), true);
    expect(() => decodeSnapshot(proto)).toThrow(/protocol version/);
    const longer = new Uint8Array(buf.length + 3);
    longer.set(buf);
    expect(() => decodeSnapshot(longer)).toThrow();
  });
});
