import type { Command } from './commands.ts';
import { hashWorld } from './hash.ts';
import { AMAX, CHUNK, D, DAY_TICKS, REGISTRY, S, isTileLayer, type World } from './layers.ts';
import { DMODE } from './disasters/tables.ts';
import type { ChunkPatch, EventsMsg, FromWorker, OverlayPatch, ResyncMsg, Typed } from './protocol.ts';
import { DEFAULT_TAX } from './economy/tables.ts';
import { RoadNet } from './roads/graph.ts';
import { AKIND } from './robots/constants.ts';
import { roadsSystem } from './roads/index.ts';
import { seedRng } from './rng.ts';
import { decodeSnapshot, encodeSnapshot } from './snapshot.ts';
import { setupScenario } from './scenarioTown.ts';
import type { ScenarioSpec } from './scenarios.ts';
import { placeStarter } from './starter.ts';
import { generateTerrain } from './terrain.ts';
import { commandsSystem, runTick } from './tick.ts';
import { copyChunkOut, readBuilding } from './tiles.ts';
import { allocWorld, newDirty, type Sim } from './world.ts';

export const START_TREASURY = 50000;
export const START_DAYFRAC = 0.3;

/**
 * `disasters` is the starting mode (a DMODE value: 0 off, 1 rare, 2 normal, 3 gentle, 4 hard). A bare createSim opens with disasters off, so tests of the other
 * systems never see a random fire; a session opens with the player's setting through Hello.disasters.
 * `starter` adds the new-city kit (sim/starter.ts: a depot, a short street and an idle crew). The worker always asks for it; a bare
 * createSim leaves the map empty so the system tests keep building their own towns, and a loaded snapshot never has it added.
 * `scenario` opens a scenario or challenge (sim/scenarios.ts): its seed replaces `seed`, and its spec decides the terrain, money, kit or town.
 */
export function createSim(seed: number, opt: { debug?: boolean; disasters?: number; starter?: boolean; scenario?: ScenarioSpec } = {}): Sim {
  const spec = opt.scenario;
  if (spec) seed = spec.seed;
  const world = allocWorld();
  const s = world.scalars;
  s[S.seed] = seed >>> 0;
  s[S.treasury] = START_TREASURY;
  s[S.taxR] = DEFAULT_TAX; s[S.taxC] = DEFAULT_TAX; s[S.taxI] = DEFAULT_TAX;
  s[S.nextAgentId] = 1;
  // A new city opens at 07:00 so the first robots build in morning light.
  s[S.dayFrac] = START_DAYFRAC;
  s[S.tickOfDay] = Math.round(START_DAYFRAC * DAY_TICKS);
  // A new city opens on the first day of spring.
  s[S.season] = START_DAYFRAC;
  seedRng(world.rng, seed);
  // Disasters draw from their own stream, so switching them on or off never shifts the weather.
  seedRng(world.drng, seed ^ 0xd15a57e2);
  seedRng(world.hrng, seed ^ 0x5ea50a1d);
  world.disaster[D.MODE] = opt.disasters !== undefined && opt.disasters >= 0 && opt.disasters <= DMODE.HARD ? Math.floor(opt.disasters) : DMODE.OFF;
  generateTerrain(world, seed, spec?.terrain);
  const sim: Sim = { world, queue: [], events: [], dirty: newDirty(), resync: true, debug: opt.debug === true };
  if (spec) setupScenario(sim, spec);
  else if (opt.starter && placeStarter(sim) < 0) console.warn(`seed ${seed}: no flat dry site for the starter kit`);
  sim.roads = RoadNet.build(world);
  return sim;
}

export function simFromWorld(world: World): Sim {
  return { world, queue: [], events: [], dirty: newDirty(), resync: true, roads: RoadNet.build(world) };
}

export const step = (sim: Sim): void => runTick(sim);
/**
 * Run the queued commands due at the current tick without advancing it. This is exactly what the first two systems (commands,
 * roads) of the next step would do, including the graphEpoch bump, so applying a command while paused and then stepping gives the same state and hash as applying it and
 * stepping. The worker uses it only while paused or at speed 0; while running, commands wait for the next tick start.
 */
export const drainCommands = (sim: Sim): void => { commandsSystem(sim); roadsSystem(sim); };
export const apply = (sim: Sim, cmd: Command): void => { sim.queue.push(cmd); };
export const tickOf = (sim: Sim): number => sim.world.scalars[S.tick]!;
export const stateHash = (sim: Sim): number => hashWorld(sim.world);
export const snapshot = (sim: Sim): Uint8Array => encodeSnapshot(sim.world);
/** Throws SnapshotError on a bad buffer; the caller's sim is untouched. */
export const restore = (data: Uint8Array): Sim => simFromWorld(decodeSnapshot(data));

function renderLayers(kind: 'geometry' | 'overlay') {
  return REGISTRY.filter((l) => l.render && isTileLayer(l) && l.dirty === kind);
}

function gather(world: World, chunks: number[], kind: 'geometry' | 'overlay'): Record<string, Typed> {
  const out: Record<string, Typed> = {};
  const n = CHUNK * CHUNK;
  for (const l of renderLayers(kind)) {
    const arr = new l.ctor(chunks.length * n) as Typed;
    chunks.forEach((c, i) => copyChunkOut(world[l.name], c, arr, i * n));
    out[l.name] = arr;
  }
  return out;
}

export function makeResync(world: World): ResyncMsg {
  const layers: Record<string, Typed> = {};
  for (const l of REGISTRY) if (l.render) layers[l.name] = (world[l.name] as Typed).slice();
  return { type: 'resync', tick: world.scalars[S.tick]!, layers, scalars: world.scalars.slice() };
}

export interface CollectOptions {
  /** Emit overlay patches too (the worker throttles these to ~1 Hz). */
  overlay?: boolean;
}

/**
 * Coalesced output since the last collect: a Resync when pending, else at most one ChunkPatch (all dirty
 * geometry chunks plus changed building slots) and one OverlayPatch, then events. Chunk indices are sorted.
 */
export function collectOutgoing(sim: Sim, opt: CollectOptions = {}): FromWorker[] {
  const out: FromWorker[] = [];
  const w = sim.world;
  const tick = w.scalars[S.tick]!;
  if (sim.resync) {
    out.push(makeResync(w));
    sim.resync = false;
    sim.dirty.geometry.clear(); sim.dirty.overlay.clear(); sim.dirty.buildings.clear();
  } else {
    if (sim.dirty.geometry.size > 0 || sim.dirty.buildings.size > 0) {
      const chunks = [...sim.dirty.geometry].sort((a, b) => a - b);
      const slots = [...sim.dirty.buildings].sort((a, b) => a - b);
      const patch: ChunkPatch = { type: 'chunkPatch', tick, chunks, layers: gather(w, chunks, 'geometry'), buildings: slots.map((s) => readBuilding(w, s)) };
      out.push(patch);
      sim.dirty.geometry.clear(); sim.dirty.buildings.clear();
    }
    if (opt.overlay && sim.dirty.overlay.size > 0) {
      const chunks = [...sim.dirty.overlay].sort((a, b) => a - b);
      const patch: OverlayPatch = { type: 'overlayPatch', tick, chunks, layers: gather(w, chunks, 'overlay') };
      out.push(patch);
      sim.dirty.overlay.clear();
    }
  }
  if (sim.events.length > 0) {
    const ev: EventsMsg = { type: 'events', tick, events: sim.events };
    out.push(ev);
    sim.events = [];
  }
  return out;
}

/** Fill caller-owned buffers with live agents in slot order; returns the count. */
export function packAgents(sim: Sim, pos: Float32Array, ids: Uint32Array, view?: { x0: number; y0: number; x1: number; y1: number }): number {
  const w = sim.world;
  let n = 0;
  for (let s = 0; s < AMAX; s++) {
    // Idle builders and haulers are sent too: the renderer stands them outside their depot to wave. Idle firefighters stay in the station.
    const kind = w.aKind[s]!;
    if (kind === 0 || (w.aState[s] === 0 && kind !== AKIND.BUILDER && kind !== AKIND.HAULER)) continue;
    const x = w.aX[s]!, y = w.aY[s]!;
    if (view && (x < view.x0 || x > view.x1 || y < view.y0 || y > view.y1)) continue;
    pos[n * 3] = x; pos[n * 3 + 1] = y; pos[n * 3 + 2] = w.aHead[s]!;
    ids[n * 2] = (s | (w.aGen[s]! << 16)) >>> 0;
    ids[n * 2 + 1] = w.aKind[s]! | (w.aState[s]! << 8) | (w.aCarry[s]! > 0 && w.aState[s] === 5 ? (1 + (w.aRes[s]! & 3)) << 16 : 0);
    n++;
  }
  return n;
}
