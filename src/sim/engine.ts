import type { Command } from './commands.ts';
import { hashWorld } from './hash.ts';
import { AMAX, CHUNK, REGISTRY, S, isTileLayer, type World } from './layers.ts';
import type { ChunkPatch, EventsMsg, FromWorker, OverlayPatch, ResyncMsg, Typed } from './protocol.ts';
import { RoadNet } from './roads/graph.ts';
import { roadsSystem } from './roads/index.ts';
import { seedRng } from './rng.ts';
import { decodeSnapshot, encodeSnapshot } from './snapshot.ts';
import { generateTerrain } from './terrain.ts';
import { commandsSystem, runTick } from './tick.ts';
import { copyChunkOut, readBuilding } from './tiles.ts';
import { allocWorld, newDirty, type Sim } from './world.ts';

export const START_TREASURY = 50000;
export const DEFAULT_TAX = 9;

export function createSim(seed: number, opt: { debug?: boolean } = {}): Sim {
  const world = allocWorld();
  const s = world.scalars;
  s[S.seed] = seed >>> 0;
  s[S.treasury] = START_TREASURY;
  s[S.taxR] = DEFAULT_TAX; s[S.taxC] = DEFAULT_TAX; s[S.taxI] = DEFAULT_TAX;
  s[S.nextAgentId] = 1;
  seedRng(world.rng, seed);
  generateTerrain(world, seed);
  return { world, queue: [], events: [], dirty: newDirty(), resync: true, debug: opt.debug === true, roads: RoadNet.build(world) };
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
    if (w.aKind[s] === 0) continue;
    const x = w.aX[s]!, y = w.aY[s]!;
    if (view && (x < view.x0 || x > view.x1 || y < view.y0 || y > view.y1)) continue;
    pos[n * 3] = x; pos[n * 3 + 1] = y; pos[n * 3 + 2] = w.aHead[s]!;
    ids[n * 2] = (s | (w.aGen[s]! << 16)) >>> 0; ids[n * 2 + 1] = w.aKind[s]!;
    n++;
  }
  return n;
}
