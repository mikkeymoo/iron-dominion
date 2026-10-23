import { describe, expect, it } from 'vitest';
import { HEIGHT_SCALE, MAP, ROAD, TERRAIN, TILES } from '../sim/layers.ts';
import { PALETTE, buildRoadMesh, buildTerrainMesh, buildWaterMesh, withNeighbours, type MeshData, type TerrainLayers } from './terrainMesh.ts';

function layers(fn: (x: number, y: number) => { h?: number; t?: number; w?: number; r?: number } = () => ({})): TerrainLayers {
  const l = { height: new Int16Array(TILES), terrain: new Uint8Array(TILES), waterDepth: new Uint8Array(TILES), road: new Uint16Array(TILES) };
  for (let y = 0; y < MAP; y++) {
    for (let x = 0; x < MAP; x++) {
      const v = fn(x, y), i = y * MAP + x;
      l.height[i] = Math.round((v.h ?? 0) * HEIGHT_SCALE);
      l.terrain[i] = v.t ?? TERRAIN.GRASS;
      l.waterDepth[i] = v.w ?? 0;
      l.road[i] = v.r ?? 0;
    }
  }
  return l;
}

const faceNormal = (m: MeshData, tri: number): [number, number, number] => {
  const i = [m.indices[tri * 3]!, m.indices[tri * 3 + 1]!, m.indices[tri * 3 + 2]!];
  const p = (k: number): number[] => [m.positions[i[k]! * 3]!, m.positions[i[k]! * 3 + 1]!, m.positions[i[k]! * 3 + 2]!];
  const a = p(0), b = p(1), c = p(2);
  const e1 = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!], e2 = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
  return [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
};

describe('buildTerrainMesh', () => {
  const hills = layers((x, y) => ({ h: Math.sin(x / 7) * 3 + Math.cos(y / 5) * 2, t: (x + y) % 3 === 0 ? TERRAIN.SAND : TERRAIN.GRASS }));

  it('produces a (16+1)^2 grid plus four skirt strips for a 16x16 chunk', () => {
    const m = buildTerrainMesh(hills, 32, 48, 16, 1, 1.5);
    expect(m.vertexCount).toBe(17 * 17 + 4 * 17);
    expect(m.triangleCount).toBe(16 * 16 * 2 + 4 * 16 * 2);
    expect(m.positions.length).toBe(m.vertexCount * 3);
    expect(m.normals.length).toBe(m.vertexCount * 3);
    expect(m.colors!.length).toBe(m.vertexCount * 3);
    expect(m.indices.length).toBe(m.triangleCount * 3);
    expect(m.indices.BYTES_PER_ELEMENT).toBe(2);
    for (const i of m.indices) expect(i).toBeLessThan(m.vertexCount);
  });

  it('covers exactly the requested tile corners', () => {
    const m = buildTerrainMesh(hills, 32, 48, 16, 1, 1.5);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let v = 0; v < m.vertexCount; v++) {
      minX = Math.min(minX, m.positions[v * 3]!); maxX = Math.max(maxX, m.positions[v * 3]!);
      minZ = Math.min(minZ, m.positions[v * 3 + 2]!); maxZ = Math.max(maxZ, m.positions[v * 3 + 2]!);
    }
    expect([minX, maxX, minZ, maxZ]).toEqual([32, 48, 48, 64]);
  });

  it('is deterministic', () => {
    const a = buildTerrainMesh(hills, 64, 64, 16, 1, 1.5), b = buildTerrainMesh(hills, 64, 64, 16, 1, 1.5);
    expect(a.positions).toEqual(b.positions);
    expect(a.colors).toEqual(b.colors);
    expect(a.normals).toEqual(b.normals);
    expect(a.indices).toEqual(b.indices);
  });

  it('hangs skirts below every border edge and faces them outward', () => {
    const skirt = 2;
    const m = buildTerrainMesh(hills, 32, 48, 16, 1, skirt);
    const top = 17 * 17;
    for (let e = 0; e < 4; e++) {
      for (let k = 0; k < 17; k++) {
        const v = top + e * 17 + k;
        let match = -1;
        for (let t = 0; t < top; t++) {
          if (m.positions[t * 3] === m.positions[v * 3] && m.positions[t * 3 + 2] === m.positions[v * 3 + 2]) { match = t; break; }
        }
        expect(match).toBeGreaterThanOrEqual(0);
        expect(m.positions[v * 3 + 1]).toBeCloseTo(m.positions[match * 3 + 1]! - skirt, 5);
      }
    }
    const outward = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const;
    const gridTris = 16 * 16 * 2;
    for (let t = 0; t < gridTris; t++) expect(faceNormal(m, t)[1]).toBeGreaterThan(0);
    for (let e = 0; e < 4; e++) {
      for (let q = 0; q < 32; q++) {
        const n = faceNormal(m, gridTris + e * 32 + q);
        expect(n[0] * outward[e]![0] + n[2] * outward[e]![1]).toBeGreaterThan(0);
      }
    }
  });

  it('chunk borders meet: neighbouring chunks share edge vertex heights', () => {
    const a = buildTerrainMesh(hills, 0, 0, 16, 1, 1.5), b = buildTerrainMesh(hills, 16, 0, 16, 1, 1.5);
    for (let z = 0; z <= 16; z++) {
      expect(a.positions[(z * 17 + 16) * 3 + 1]).toBeCloseTo(b.positions[(z * 17) * 3 + 1]!, 6);
    }
  });

  it('a coarse 64x64 superchunk at step 4 has the same vertex budget and spans 64 tiles', () => {
    const m = buildTerrainMesh(hills, 64, 64, 64, 4, 6);
    expect(m.vertexCount).toBe(17 * 17 + 4 * 17);
    let maxX = -Infinity;
    for (let v = 0; v < m.vertexCount; v++) maxX = Math.max(maxX, m.positions[v * 3]!);
    expect(maxX).toBe(128);
  });

  it('colours by terrain type and keeps normals unit length and upward on flat ground', () => {
    const lin = (t: number) => PALETTE[t]!;
    const grass = buildTerrainMesh(layers(), 100, 100, 16, 1, 1.5);
    const rock = buildTerrainMesh(layers(() => ({ t: TERRAIN.ROCK })), 100, 100, 16, 1, 1.5);
    const water = buildTerrainMesh(layers(() => ({ t: TERRAIN.WATER, h: -3 })), 100, 100, 16, 1, 1.5);
    const mid = (8 * 17 + 8) * 3;
    expect(grass.colors![mid + 1]).toBeGreaterThan(grass.colors![mid]!);
    expect(grass.colors![mid + 1]).toBeGreaterThan(grass.colors![mid + 2]!);
    expect(Math.abs(rock.colors![mid]! - rock.colors![mid + 2]!)).toBeLessThan(0.08);
    expect(water.colors![mid + 2]).toBeGreaterThan(water.colors![mid]!);
    expect(grass.colors![mid]!).toBeGreaterThan(lin(TERRAIN.GRASS)[0] * 0.9);
    expect(grass.colors![mid]!).toBeLessThan(lin(TERRAIN.GRASS)[0] * 1.1);
    for (let v = 0; v < grass.vertexCount; v++) {
      expect(Math.hypot(grass.normals[v * 3]!, grass.normals[v * 3 + 1]!, grass.normals[v * 3 + 2]!)).toBeCloseTo(1, 5);
    }
    expect(grass.normals[mid + 1]).toBeCloseTo(1, 5);
  });

  it('tilts normals away from a slope', () => {
    const ramp = layers((x) => ({ h: x * 0.5 }));
    const m = buildTerrainMesh(ramp, 100, 100, 16, 1, 1.5);
    const mid = (8 * 17 + 8) * 3;
    expect(m.normals[mid]).toBeLessThan(-0.2);
    expect(m.normals[mid + 2]).toBeCloseTo(0, 5);
  });

  it('works at the map corners where neighbours are clamped', () => {
    const m = buildTerrainMesh(hills, MAP - 16, MAP - 16, 16, 1, 1.5);
    for (const v of m.positions) expect(Number.isFinite(v)).toBe(true);
    for (const v of m.normals) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('buildWaterMesh and buildRoadMesh', () => {
  it('emits one quad per wet tile at its surface level and nothing for dry land', () => {
    expect(buildWaterMesh(layers(), 0, 0, 64).triangleCount).toBe(0);
    const pond = layers((x, y) => (x >= 10 && x < 13 && y >= 20 && y < 22 ? { h: -2, w: 2 * HEIGHT_SCALE, t: TERRAIN.WATER } : {}));
    const m = buildWaterMesh(pond, 0, 0, 64);
    expect(m.triangleCount).toBe(6 * 2);
    expect(m.vertexCount).toBe(6 * 4);
    for (let v = 0; v < m.vertexCount; v++) {
      expect(m.positions[v * 3 + 1]).toBeCloseTo(0, 5);
      expect(m.normals[v * 3 + 1]).toBe(1);
    }
  });

  it('keeps a stepped river continuous: shared corners get one level', () => {
    const river = layers((x) => (x === 5 || x === 6 ? { h: x === 5 ? 4 : 3, w: 8, t: TERRAIN.RIVER } : { h: 5 }));
    const m = buildWaterMesh(river, 0, 0, 16);
    const at = new Map<string, Set<number>>();
    for (let v = 0; v < m.vertexCount; v++) {
      const k = `${m.positions[v * 3]},${m.positions[v * 3 + 2]}`;
      (at.get(k) ?? at.set(k, new Set()).get(k)!).add(m.positions[v * 3 + 1]!);
    }
    for (const s of at.values()) expect(s.size).toBe(1);
  });

  it('builds a centre square plus one arm per connection, draped above the ground', () => {
    const road = layers((x, y) => (x === 40 && y === 40 ? { h: 1, r: 1 | ROAD.N | ROAD.S } : { h: 1 }));
    const m = buildRoadMesh(road, 0, 0, 64);
    expect(m.triangleCount).toBe(3 * 2);
    for (let v = 0; v < m.vertexCount; v++) {
      expect(m.positions[v * 3 + 1]).toBeGreaterThan(1);
      expect(m.positions[v * 3]).toBeGreaterThanOrEqual(40);
      expect(m.positions[v * 3]).toBeLessThanOrEqual(41);
    }
    expect(buildRoadMesh(layers(), 0, 0, 64).triangleCount).toBe(0);
  });

  it('lifts a bridge above the water surface', () => {
    const bridge = layers((x, y) => (x === 40 && y === 40 ? { h: -4, w: 4 * HEIGHT_SCALE, t: TERRAIN.WATER, r: 1 | ROAD.BRIDGE } : { h: -4, w: 4 * HEIGHT_SCALE, t: TERRAIN.WATER }));
    const m = buildRoadMesh(bridge, 0, 0, 64);
    for (let v = 0; v < m.vertexCount; v++) expect(m.positions[v * 3 + 1]).toBeGreaterThan(0.1);
  });

  it('switches to 32-bit indices when a region needs more than 65535 vertices', () => {
    const dense = layers((x, y) => (x < 64 && y < 64 ? { r: 1 | ROAD.N | ROAD.E | ROAD.S | ROAD.W } : {}));
    const m = buildRoadMesh(dense, 0, 0, 64);
    expect(m.vertexCount).toBeGreaterThan(65535);
    expect(m.indices.BYTES_PER_ELEMENT).toBe(4);
  });
});

describe('seams and holes', () => {
  it('editing an edge tile changes the neighbouring chunk border vertices, so neighbours must be rebuilt', () => {
    const before = layers(() => ({ h: 2 }));
    const after = layers((x, y) => ({ h: x === 15 && y === 5 ? 9 : 2 }));
    const borderCol = (m: MeshData): number[] => Array.from({ length: 17 }, (_, z) => m.positions[(z * 17) * 3 + 1]!);
    const a = buildTerrainMesh(before, 16, 0, 16, 1, 1.5), b = buildTerrainMesh(after, 16, 0, 16, 1, 1.5);
    expect(borderCol(b)).not.toEqual(borderCol(a));
    const sandy = layers((x, y) => ({ t: x === 15 && y === 5 ? TERRAIN.SAND : TERRAIN.GRASS }));
    expect(buildTerrainMesh(sandy, 16, 0, 16, 1, 1.5).colors).not.toEqual(buildTerrainMesh(layers(), 16, 0, 16, 1, 1.5).colors);
    const only = layers((x, y) => (x === 16 && y === 5 ? { h: -1, w: 16 } : { h: -1 }));
    const both = layers((x, y) => (x === 16 && y === 5 ? { h: -1, w: 16 } : x === 15 && y === 5 ? { h: -3, w: 16 } : { h: -1 }));
    const cornerY = (m: MeshData): number => { for (let v = 0; v < m.vertexCount; v++) if (m.positions[v * 3] === 16 && m.positions[v * 3 + 2] === 5) return m.positions[v * 3 + 1]!; return NaN; };
    expect(cornerY(buildWaterMesh(both, 16, 0, 16))).not.toBeCloseTo(cornerY(buildWaterMesh(only, 16, 0, 16)), 3);
  });

  it('withNeighbours adds the eight surrounding chunks, clamped to the map', () => {
    const CH = 16;
    expect([...withNeighbours([5 * CH + 5], CH)].sort((a, b) => a - b)).toEqual(
      [4, 5, 6].flatMap((y) => [4, 5, 6].map((x) => y * CH + x)),
    );
    expect(withNeighbours([0], CH).size).toBe(4);
    expect(withNeighbours([CH * CH - 1], CH).size).toBe(4);
    expect(withNeighbours([], CH).size).toBe(0);
  });

  it('cuts quads out of a coarse mesh and skirts the hole border outward', () => {
    const hills = layers((x, y) => ({ h: Math.sin(x / 9) * 3 + Math.cos(y / 6) * 2 }));
    const full = buildTerrainMesh(hills, 0, 0, 64, 4, 6);
    const holed = buildTerrainMesh(hills, 0, 0, 64, 4, 6, (a, b) => a >= 4 && a < 8 && b >= 4 && b < 8);
    const gridTris = 16 * 16 * 2, outerSkirt = 4 * 16 * 2;
    expect(holed.triangleCount).toBe(gridTris - 16 * 2 + outerSkirt + 16 * 2);
    expect(holed.vertexCount).toBe(full.vertexCount + 16 * 2);
    expect(full.triangleCount).toBe(gridTris + outerSkirt);
    const start = holed.triangleCount - 16 * 2;
    const centre = [(4 + 8) / 2 * 4, (4 + 8) / 2 * 4];
    for (let t = start; t < holed.triangleCount; t++) {
      const n = faceNormal(holed, t);
      const i = holed.indices[t * 3]!;
      const toward = [centre[0]! - holed.positions[i * 3]!, centre[1]! - holed.positions[i * 3 + 2]!];
      expect(n[0] * toward[0]! + n[2] * toward[1]!).toBeGreaterThan(0);
    }
    for (const i of holed.indices) expect(i).toBeLessThan(holed.vertexCount);
  });
});
