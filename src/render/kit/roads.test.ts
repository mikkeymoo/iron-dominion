import { describe, expect, it } from 'vitest';
import { HEIGHT_SCALE, MAP, ROAD, TERRAIN, TILES } from '../../sim/layers.ts';
import { buildRoadMesh, selectRoadTile } from './roads.ts';
import type { TerrainLayers } from '../terrainMesh.ts';

const N = 1, E = 2, S = 4, W = 8;
const mask = (c: number): number => 1 | (c & N ? ROAD.N : 0) | (c & E ? ROAD.E : 0) | (c & S ? ROAD.S : 0) | (c & W ? ROAD.W : 0);

const layers = (f: (x: number, y: number) => { r?: number; h?: number; w?: number; t?: number } = () => ({})): TerrainLayers => {
  const l = { height: new Int16Array(TILES), terrain: new Uint8Array(TILES), waterDepth: new Uint8Array(TILES), road: new Uint16Array(TILES) };
  for (let y = 0; y < MAP; y++) for (let x = 0; x < MAP; x++) {
    const v = f(x, y), i = y * MAP + x;
    l.height[i] = Math.round((v.h ?? 1) * HEIGHT_SCALE); l.terrain[i] = v.t ?? TERRAIN.GRASS; l.waterDepth[i] = v.w ?? 0; l.road[i] = v.r ?? 0;
  }
  return l;
};

describe('selectRoadTile', () => {
  const EXPECTED: Record<number, [string, number]> = {
    0: ['isolated', 0],
    [N]: ['end', 0], [E]: ['end', 1], [S]: ['end', 2], [W]: ['end', 3],
    [N | S]: ['straight', 0], [E | W]: ['straight', 1],
    [N | E]: ['corner', 0], [E | S]: ['corner', 1], [S | W]: ['corner', 2], [W | N]: ['corner', 3],
    [E | S | W]: ['tee', 0], [N | S | W]: ['tee', 1], [N | E | W]: ['tee', 2], [N | E | S]: ['tee', 3],
    [N | E | S | W]: ['cross', 0],
  };

  it('maps all 16 connectivity masks to a shape and rotation', () => {
    expect(Object.keys(EXPECTED)).toHaveLength(16);
    for (let c = 0; c < 16; c++) {
      const t = selectRoadTile(mask(c));
      expect([t.shape, t.rot], `mask ${c.toString(2).padStart(4, '0')}`).toEqual(EXPECTED[c]);
      expect(t.conn).toBe(c);
      expect(t.crosswalks).toBe(t.shape === 'tee' || t.shape === 'cross');
    }
  });

  it('carries class, bridge and slope flags without changing the shape', () => {
    const t = selectRoadTile(3 | ROAD.N | ROAD.S | ROAD.BRIDGE | ROAD.SLOPE);
    expect(t).toMatchObject({ shape: 'straight', rot: 0, cls: 3, bridge: true, slope: true });
    for (let c = 0; c < 16; c++) {
      const plain = selectRoadTile(mask(c)), bridge = selectRoadTile(mask(c) | ROAD.BRIDGE);
      expect(bridge.shape).toBe(plain.shape);
      expect(bridge.rot).toBe(plain.rot);
      expect(bridge.bridge).toBe(true);
    }
  });
});

describe('buildRoadMesh', () => {
  const one = (r: number, extra: { h?: number; w?: number; t?: number } = {}) => layers((x, y) => (x === 40 && y === 40 ? { r, ...extra } : {}));

  it('emits nothing for an empty region', () => {
    expect(buildRoadMesh(layers(), 0, 0, 64).triangleCount).toBe(0);
  });

  it('builds valid, finite, in-tile geometry for all 16 masks in each class', () => {
    for (const cls of [1, 2, 3]) {
      for (let c = 0; c < 16; c++) {
        const m = buildRoadMesh(one(cls | (mask(c) & ~7)), 0, 0, 64);
        expect(m.triangleCount, `class ${cls} mask ${c}`).toBeGreaterThan(8);
        expect(m.triangleCount).toBeLessThan(400);
        for (let v = 0; v < m.vertexCount; v++) {
          expect(Number.isFinite(m.positions[v * 3 + 1]!)).toBe(true);
          expect(m.positions[v * 3]!).toBeGreaterThanOrEqual(40 - 1e-6);
          expect(m.positions[v * 3]!).toBeLessThanOrEqual(41 + 1e-6);
          expect(m.positions[v * 3 + 2]!).toBeGreaterThanOrEqual(40 - 1e-6);
          expect(m.positions[v * 3 + 2]!).toBeLessThanOrEqual(41 + 1e-6);
        }
        for (const i of m.indices) expect(i).toBeLessThan(m.vertexCount);
        expect(m.colors!.length).toBe(m.positions.length);
      }
    }
  });

  it('draws intersections with crosswalk and curb detail, so a cross costs more than a straight', () => {
    const straight = buildRoadMesh(one(1 | ROAD.N | ROAD.S), 0, 0, 64).triangleCount;
    const cross = buildRoadMesh(one(1 | ROAD.N | ROAD.S | ROAD.E | ROAD.W), 0, 0, 64).triangleCount;
    expect(cross).toBeGreaterThan(straight);
  });

  it('faces every triangle up or outward consistently (no inverted curb or deck faces)', () => {
    const m = buildRoadMesh(one(1 | ROAD.N | ROAD.S | ROAD.E | ROAD.W), 0, 0, 64);
    let bad = 0;
    for (let i = 0; i < m.indices.length; i += 3) {
      const [a, b, c] = [m.indices[i]!, m.indices[i + 1]!, m.indices[i + 2]!];
      const p = (k: number): number[] => [m.positions[k * 3]!, m.positions[k * 3 + 1]!, m.positions[k * 3 + 2]!];
      const [A, B, C] = [p(a), p(b), p(c)];
      const u = [B[0]! - A[0]!, B[1]! - A[1]!, B[2]! - A[2]!], v = [C[0]! - A[0]!, C[1]! - A[1]!, C[2]! - A[2]!];
      const g = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
      const n = [m.normals[a * 3]!, m.normals[a * 3 + 1]!, m.normals[a * 3 + 2]!];
      if (Math.hypot(g[0]!, g[1]!, g[2]!) < 1e-9) continue;
      if (g[0]! * n[0]! + g[1]! * n[1]! + g[2]! * n[2]! < 0) bad++;
    }
    expect(bad).toBe(0);
  });

  it('uses flat strips outside the detail predicate', () => {
    const r = one(1 | ROAD.N | ROAD.S | ROAD.E | ROAD.W);
    const full = buildRoadMesh(r, 0, 0, 64, () => true).triangleCount;
    const far = buildRoadMesh(r, 0, 0, 64, () => false).triangleCount;
    expect(far).toBeGreaterThan(0);
    expect(far).toBeLessThan(full / 2);
  });

  it('puts a bridge deck above the water surface with pillars and railings', () => {
    const water = { h: -4, w: 4 * HEIGHT_SCALE, t: TERRAIN.WATER };
    const bridge = layers((x, y) => (x === 40 && y === 40 ? { r: 1 | ROAD.N | ROAD.S | ROAD.BRIDGE, ...water } : water));
    const m = buildRoadMesh(bridge, 0, 0, 64);
    let top = -Infinity, below = 0;
    for (let v = 0; v < m.vertexCount; v++) { top = Math.max(top, m.positions[v * 3 + 1]!); if (m.positions[v * 3 + 1]! < -0.2) below++; }
    expect(top).toBeGreaterThan(0.1);
    expect(below).toBeGreaterThan(0);
    const dry = buildRoadMesh(one(1 | ROAD.N | ROAD.S), 0, 0, 64).triangleCount;
    expect(m.triangleCount).toBeGreaterThan(dry);
  });

  it('adds dark cracks to a quake-damaged tile, in both detail levels, and keeps them inside the tile', () => {
    const plain = one(1 | ROAD.N | ROAD.S), cracked = one(1 | ROAD.N | ROAD.S | ROAD.DAMAGED);
    expect(selectRoadTile(1 | ROAD.N | ROAD.S | ROAD.DAMAGED)).toMatchObject({ shape: 'straight', damaged: true });
    expect(selectRoadTile(1 | ROAD.N | ROAD.S).damaged).toBe(false);
    for (const detail of [true, false]) {
      const a = buildRoadMesh(plain, 0, 0, 64, () => detail), b = buildRoadMesh(cracked, 0, 0, 64, () => detail);
      expect(b.triangleCount, detail ? 'full detail' : 'simple').toBeGreaterThan(a.triangleCount + 4);
      for (let v = 0; v < b.vertexCount; v++) {
        expect(b.positions[v * 3]!).toBeGreaterThanOrEqual(39.99); expect(b.positions[v * 3]!).toBeLessThanOrEqual(41.01);
        expect(Number.isFinite(b.positions[v * 3 + 1]!)).toBe(true);
      }
    }
    const again = buildRoadMesh(cracked, 0, 0, 64), once = buildRoadMesh(cracked, 0, 0, 64);
    expect(Array.from(again.positions)).toEqual(Array.from(once.positions));
  });

  it('switches to 32-bit indices when a region needs more than 65535 vertices', () => {
    const dense = layers((x, y) => (x < 64 && y < 64 ? { r: 1 | ROAD.N | ROAD.E | ROAD.S | ROAD.W } : {}));
    const m = buildRoadMesh(dense, 0, 0, 64);
    expect(m.vertexCount).toBeGreaterThan(65535);
    expect(m.indices.BYTES_PER_ELEMENT).toBe(4);
  });
});
