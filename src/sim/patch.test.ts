import { describe, expect, it } from 'vitest';
import { RenderMirror } from '../render/mirror.ts';
import { ARCH } from './catalog.ts';
import { apply, collectOutgoing, createSim, makeResync, step } from './engine.ts';
import { fnv1a, bytesOf } from './hash.ts';
import { CHUNK, CHUNKS, REGISTRY } from './layers.ts';
import type { ChunkPatch } from './protocol.ts';
import { findLandWindow } from './testkit.ts';

const sameAsResync = (m: RenderMirror, sim: ReturnType<typeof createSim>) => {
  const fresh = new RenderMirror();
  fresh.apply(makeResync(sim.world));
  for (const l of REGISTRY.filter((x) => x.render)) {
    expect(fnv1a(bytesOf(m.layers[l.name]!)), l.name).toBe(fnv1a(bytesOf(fresh.layers[l.name]!)));
  }
};

describe('ChunkPatch and mirror', () => {
  it('marks only the touched chunks dirty and keeps the mirror equal to a fresh Resync', () => {
    const sim = createSim(42);
    const mirror = new RenderMirror();
    for (const m of collectOutgoing(sim)) mirror.apply(m);
    expect(mirror.hasResync).toBe(true);
    expect(mirror.takeDirtyGeometry()).toHaveLength(CHUNKS * CHUNKS);
    sameAsResync(mirror, sim);

    const { x, y } = findLandWindow(sim.world, 16);
    apply(sim, { id: 1, tick: 0, type: 'placeRoad', ax: x, ay: y, bx: x + 3, by: y, cls: 1 });
    step(sim);
    const out = collectOutgoing(sim);
    const patch = out.find((m) => m.type === 'chunkPatch') as ChunkPatch;
    expect(patch).toBeDefined();
    const expected = new Set<number>();
    for (let px = x - 1; px <= x + 4; px++) for (let py = y - 1; py <= y + 1; py++) {
      expected.add(((py / CHUNK) | 0) * CHUNKS + ((px / CHUNK) | 0));
    }
    expect(patch.chunks.length).toBeGreaterThan(0);
    expect(patch.chunks.length).toBeLessThanOrEqual(expected.size);
    for (const c of patch.chunks) expect(expected.has(c)).toBe(true);
    expect(Object.keys(patch.layers)).toContain('road');
    expect(Object.keys(patch.layers)).not.toContain('landValue');
    expect(sim.dirty.geometry.size).toBe(0);

    for (const m of out) mirror.apply(m);
    expect(mirror.takeDirtyGeometry()).toEqual(patch.chunks);
    expect(mirror.roadAt(x, y)).toBe(sim.world.road[y * 256 + x]);
    sameAsResync(mirror, sim);

    apply(sim, { id: 2, tick: 0, type: 'placeBuilding', arch: ARCH.FIRE_STATION, x: x + 6, y: y + 6, rot: 0 });
    step(sim);
    for (const m of collectOutgoing(sim)) mirror.apply(m);
    const slot = mirror.buildingAt(x + 6, y + 6);
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(mirror.building(slot)?.arch).toBe(ARCH.FIRE_STATION);
    sameAsResync(mirror, sim);

    expect(collectOutgoing(sim).some((m) => m.type === 'chunkPatch')).toBe(false);
  });

  it('reports building slots that a Resync empties', () => {
    const sim = createSim(42);
    const { x, y } = findLandWindow(sim.world, 16);
    apply(sim, { id: 1, tick: 0, type: 'placeBuilding', arch: ARCH.DEPOT, x, y, rot: 0 });
    step(sim);
    const mirror = new RenderMirror();
    for (const m of collectOutgoing(sim)) mirror.apply(m);
    const slot = mirror.buildingAt(x, y);
    expect(mirror.building(slot)).toBeDefined();
    mirror.takeDirtyBuildings();
    const empty = createSim(42);
    mirror.apply(makeResync(empty.world));
    expect(mirror.building(slot)).toBeUndefined();
    expect(mirror.takeDirtyBuildings()).toContain(slot);
  });
});
