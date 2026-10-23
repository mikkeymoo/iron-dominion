import { describe, expect, it } from 'vitest';
import { createSim } from './engine.ts';
import { hashWorld } from './hash.ts';
import { TERRAIN, TILES } from './layers.ts';

const terrainHash = (seed: number) => hashWorld(createSim(seed).world, (n) => n === 'height' || n === 'terrain' || n === 'waterDepth');

describe('terrain generation', () => {
  it('is deterministic per seed and differs between seeds', () => {
    expect(terrainHash(42)).toBe(terrainHash(42));
    expect(terrainHash(42)).not.toBe(terrainHash(43));
  });

  it('produces water, land, a river and sand', () => {
    const t = createSim(42).world.terrain;
    const counts = new Array<number>(8).fill(0);
    for (let i = 0; i < TILES; i++) counts[t[i]!]!++;
    expect(counts[TERRAIN.WATER]).toBeGreaterThan(TILES * 0.1);
    expect(counts[TERRAIN.GRASS]! + counts[TERRAIN.FOREST]!).toBeGreaterThan(TILES * 0.2);
    expect(counts[TERRAIN.RIVER]).toBeGreaterThan(0);
    expect(counts[TERRAIN.SAND]).toBeGreaterThan(0);
  });
});
