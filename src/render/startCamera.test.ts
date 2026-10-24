import { describe, expect, it } from 'vitest';
import type { TileRead } from '../sim/estimate.ts';
import { MAP, TERRAIN, TILES } from '../sim/layers.ts';
import { START_DIST, START_PITCH, startCameraFor } from './startCamera.ts';

function read(fill: number = TERRAIN.GRASS): TileRead & { terrain: Uint8Array; height: Int16Array } {
  return {
    terrain: new Uint8Array(TILES).fill(fill), height: new Int16Array(TILES).fill(100), waterDepth: new Uint8Array(TILES),
    road: new Uint16Array(TILES), zone: new Uint8Array(TILES), bId: new Uint16Array(TILES),
  };
}

describe('new city start camera', () => {
  it('sits at neighbourhood zoom, never at satellite distance', () => {
    const s = startCameraFor(read());
    expect(s.dist).toBe(START_DIST);
    expect(s.dist).toBeLessThanOrEqual(70);
    expect(s.dist).toBeGreaterThanOrEqual(45);
    expect(s.pitch).toBe(START_PITCH);
    expect(s.pitch).toBeGreaterThan(0.8);
  });

  it('looks at the middle of the flat window nearest the map centre', () => {
    const s = startCameraFor(read());
    expect(Math.abs(s.x - MAP / 2)).toBeLessThanOrEqual(10);
    expect(Math.abs(s.z - MAP / 2)).toBeLessThanOrEqual(10);
  });

  it('is deterministic for the same layers', () => {
    const a = startCameraFor(read()), b = startCameraFor(read());
    expect(a).toEqual(b);
  });

  it('moves off a lake at the centre onto buildable land', () => {
    const r = read();
    for (let y = 100; y < 156; y++) for (let x = 100; x < 156; x++) r.terrain[y * MAP + x] = TERRAIN.WATER;
    const s = startCameraFor(r);
    const tx = Math.floor(s.x), ty = Math.floor(s.z);
    expect(r.terrain[ty * MAP + tx]).not.toBe(TERRAIN.WATER);
    expect(Math.hypot(s.x - MAP / 2, s.z - MAP / 2)).toBeGreaterThan(20);
  });

  it('prefers the flatter window when a bumpy patch is nearer the centre', () => {
    const r = read();
    for (let y = 110; y < 146; y++) for (let x = 110; x < 146; x++) r.height[y * MAP + x] = 100 + ((x + y) % 2) * 60;
    const s = startCameraFor(r);
    const near = (x: number, z: number): boolean => x >= 106 && x < 150 && z >= 106 && z < 150;
    expect(near(s.x, s.z)).toBe(false);
  });

  it('falls back to the map centre when nothing is buildable', () => {
    const s = startCameraFor(read(TERRAIN.WATER));
    expect(s).toMatchObject({ x: MAP / 2, z: MAP / 2, dist: START_DIST });
  });
});
