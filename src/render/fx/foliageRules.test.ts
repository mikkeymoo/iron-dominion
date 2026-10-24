import { describe, expect, it } from 'vitest';
import { CHUNK, CHUNKS, HEIGHT_SCALE, MAP, TERRAIN, ZONE } from '../../sim/layers.ts';
import { TIER_TABLE, TIERS } from '../tier.ts';
import {
  SPECIES_COUNT, STRIDE, buildChunkFoliage, classifyTile, clump, instanceTile, nextToStructure, tileBlocked, treeSpecies, type ChunkFoliage, type FoliageDensity,
  type FoliageLayers,
} from './foliageRules.ts';

interface World { terrain: Uint8Array; road: Uint16Array; bId: Uint16Array; zone: Uint8Array; ugPower: Uint8Array; waterDepth: Uint8Array; height: Int16Array }

function world(fill: number = TERRAIN.GRASS): World {
  return {
    terrain: new Uint8Array(MAP * MAP).fill(fill),
    road: new Uint16Array(MAP * MAP),
    bId: new Uint16Array(MAP * MAP),
    zone: new Uint8Array(MAP * MAP),
    ugPower: new Uint8Array(MAP * MAP),
    waterDepth: new Uint8Array(MAP * MAP),
    height: new Int16Array(MAP * MAP).fill(2 * HEIGHT_SCALE),
  };
}

const DENSE: FoliageDensity = { grass: 8, shrubs: 0.5, trees: 4 };
const SEED = 4242;
const CHUNK_AT = 5 * CHUNKS + 5;

const tilesOf = (list: number[]): number[] => {
  const out: number[] = [];
  for (let i = 0; i < list.length; i += STRIDE) out.push(instanceTile(list[i]!, list[i + 2]!));
  return out;
};
const count = (c: ChunkFoliage): number => (c.grass.length + c.shrubs.length + c.trees.length) / STRIDE;

describe('foliage placement rules', () => {
  it('plants grass tufts and shrubs on grass tiles but no trees', () => {
    const c = buildChunkFoliage(world(TERRAIN.GRASS), CHUNK_AT, SEED, DENSE);
    expect(c.grass.length / STRIDE).toBeGreaterThan(200);
    expect(c.shrubs.length).toBeGreaterThan(0);
    expect(c.trees.length).toBe(0);
  });

  it('plants trees only on forest tiles, never on grass, sand, rock or ore', () => {
    for (const type of [TERRAIN.GRASS, TERRAIN.SAND, TERRAIN.ROCK, TERRAIN.ORE]) {
      expect(buildChunkFoliage(world(type), CHUNK_AT, SEED, DENSE).trees.length, `type ${type}`).toBe(0);
    }
    const forest = buildChunkFoliage(world(TERRAIN.FOREST), CHUNK_AT, SEED, DENSE);
    expect(forest.trees.length / STRIDE).toBeGreaterThan(100);
    expect(buildChunkFoliage(world(TERRAIN.SAND), CHUNK_AT, SEED, DENSE)).toEqual({ grass: [], shrubs: [], trees: [] });
    expect(buildChunkFoliage(world(TERRAIN.WATER), CHUNK_AT, SEED, DENSE)).toEqual({ grass: [], shrubs: [], trees: [] });
  });

  it('keeps every instance inside its own tile, inside the chunk, and on the ground height', () => {
    const l = world(TERRAIN.FOREST);
    const c = buildChunkFoliage(l, CHUNK_AT, SEED, DENSE);
    const x0 = (CHUNK_AT % CHUNKS) * CHUNK, y0 = Math.floor(CHUNK_AT / CHUNKS) * CHUNK;
    for (const list of [c.grass, c.shrubs, c.trees]) {
      for (let i = 0; i < list.length; i += STRIDE) {
        expect(list[i]!).toBeGreaterThanOrEqual(x0);
        expect(list[i]!).toBeLessThan(x0 + CHUNK);
        expect(list[i + 2]!).toBeGreaterThanOrEqual(y0);
        expect(list[i + 2]!).toBeLessThan(y0 + CHUNK);
        expect(list[i + 1]!).toBeCloseTo(2, 5);
        expect(list[i + 3]!).toBeGreaterThan(0.5);
      }
    }
  });

  it('excludes road tiles, building footprints and power-line tiles', () => {
    for (const type of [TERRAIN.GRASS, TERRAIN.FOREST]) {
      const l = world(type);
      const x0 = (CHUNK_AT % CHUNKS) * CHUNK, y0 = Math.floor(CHUNK_AT / CHUNKS) * CHUNK;
      const road = new Set<number>(), bld = new Set<number>(), pylon = new Set<number>();
      for (let y = y0; y < y0 + CHUNK; y++) {
        l.road[y * MAP + x0 + 3] = 1; road.add(y * MAP + x0 + 3);
        if (y >= y0 + 4 && y < y0 + 8) for (let x = x0 + 8; x < x0 + 11; x++) { l.bId[y * MAP + x] = 7; bld.add(y * MAP + x); }
        l.ugPower[y * MAP + x0 + 14] = 1; pylon.add(y * MAP + x0 + 14);
      }
      const c = buildChunkFoliage(l, CHUNK_AT, SEED, DENSE);
      for (const list of [c.grass, c.shrubs, c.trees]) {
        for (const t of tilesOf(list)) {
          expect(road.has(t), 'road').toBe(false);
          expect(bld.has(t), 'building').toBe(false);
          expect(pylon.has(t), 'pylon').toBe(false);
        }
      }
      expect(count(c)).toBeGreaterThan(100);
    }
  });

  it('keeps trees and shrubs off tiles that touch a road or a building, so canopies do not clip walls', () => {
    const l = world(TERRAIN.FOREST);
    const x0 = (CHUNK_AT % CHUNKS) * CHUNK, y0 = Math.floor(CHUNK_AT / CHUNKS) * CHUNK;
    for (let y = y0; y < y0 + CHUNK; y++) l.road[y * MAP + x0 + 6] = 1;
    const c = buildChunkFoliage(l, CHUNK_AT, SEED, DENSE);
    for (const list of [c.trees, c.shrubs]) for (const t of tilesOf(list)) expect(nextToStructure(l, t % MAP, Math.floor(t / MAP))).toBe(false);
    expect(tileBlocked(l, x0 + 6, y0)).toBe(true);
    expect(nextToStructure(l, x0 + 5, y0)).toBe(true);
    expect(nextToStructure(l, x0 + 2, y0)).toBe(false);
  });

  it('thins zoned lots and puts no trees or shrubs on them', () => {
    const l = world(TERRAIN.FOREST);
    const x0 = (CHUNK_AT % CHUNKS) * CHUNK, y0 = Math.floor(CHUNK_AT / CHUNKS) * CHUNK;
    const zoned = new Set<number>();
    for (let y = y0; y < y0 + CHUNK; y++) for (let x = x0; x < x0 + 8; x++) { l.zone[y * MAP + x] = ZONE.R; zoned.add(y * MAP + x); }
    const c = buildChunkFoliage(l, CHUNK_AT, SEED, DENSE);
    for (const list of [c.trees, c.shrubs]) for (const t of tilesOf(list)) expect(zoned.has(t)).toBe(false);
    const plain = buildChunkFoliage(world(TERRAIN.FOREST), CHUNK_AT, SEED, DENSE);
    const grassOn = (list: number[]): number => tilesOf(list).filter((t) => zoned.has(t)).length;
    expect(grassOn(c.grass)).toBeLessThan(grassOn(plain.grass) * 0.6);
  });

  it('skips water, steep ground and the map edge', () => {
    const l = world(TERRAIN.GRASS);
    l.waterDepth[10 * MAP + 10] = 20;
    for (let y = 18; y < 30; y++) for (let x = 20; x < 30; x++) l.height[y * MAP + x] = 30 * HEIGHT_SCALE;
    expect(classifyTile(l, 10, 10)).toBe('blocked');
    expect(classifyTile(l, 19, 22)).toBe('blocked');
    expect(classifyTile(l, 24, 24)).toBe('grass');
    expect(classifyTile(l, 40, 40)).toBe('grass');
    expect(classifyTile(l, -1, 5)).toBe('blocked');
    expect(classifyTile(l, MAP, 5)).toBe('blocked');
    expect(classifyTile(world(TERRAIN.FOREST), 40, 40)).toBe('forest');
    expect(classifyTile(world(TERRAIN.RIVER), 40, 40)).toBe('blocked');
  });

  it('is deterministic per seed and differs between seeds', () => {
    const l = world(TERRAIN.GRASS);
    const a = buildChunkFoliage(l, CHUNK_AT, SEED, DENSE), b = buildChunkFoliage(l, CHUNK_AT, SEED, DENSE);
    expect(a).toEqual(b);
    expect(buildChunkFoliage(l, CHUNK_AT, SEED + 1, DENSE).grass).not.toEqual(a.grass);
    expect(clump(SEED, 12, 34)).toBe(clump(SEED, 12, 34));
    expect(treeSpecies(SEED, 3, 4, 0)).toBe(treeSpecies(SEED, 3, 4, 0));
    for (let i = 0; i < 100; i++) expect(treeSpecies(SEED, i, i * 3, i % 4)).toBeLessThan(SPECIES_COUNT);
  });

  it('density follows the tier: low none, then more at every tier, and a lower density is a prefix of a higher one', () => {
    const l = world(TERRAIN.FOREST);
    const counts = TIERS.map((t) => {
      const f = TIER_TABLE[t].gfx.foliage;
      return count(buildChunkFoliage(l, CHUNK_AT, SEED, { grass: f.grass, shrubs: f.shrubs, trees: f.trees }));
    });
    expect(counts[0]).toBe(0);
    for (let i = 1; i < counts.length; i++) expect(counts[i]!, `${TIERS[i]}`).toBeGreaterThan(counts[i - 1]!);
    const lo = buildChunkFoliage(l, CHUNK_AT, SEED, { grass: 3, shrubs: 0, trees: 2 });
    const hi = buildChunkFoliage(l, CHUNK_AT, SEED, { grass: 10, shrubs: 0, trees: 4 });
    const key = (a: number[], i: number): string => a.slice(i, i + STRIDE).join(',');
    const hiKeys = new Set<string>();
    for (let i = 0; i < hi.trees.length; i += STRIDE) hiKeys.add(key(hi.trees, i));
    for (let i = 0; i < lo.trees.length; i += STRIDE) expect(hiKeys.has(key(lo.trees, i))).toBe(true);
  });

  it('zero density places nothing, whatever the terrain', () => {
    expect(buildChunkFoliage(world(TERRAIN.FOREST), CHUNK_AT, SEED, { grass: 0, shrubs: 0, trees: 0 })).toEqual({ grass: [], shrubs: [], trees: [] });
  });
});
