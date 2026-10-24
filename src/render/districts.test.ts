import { describe, expect, it } from 'vitest';
import { rciId } from '../sim/catalog.ts';
import { STYLES } from '../sim/districtTables.ts';
import { CHUNKS, MAP } from '../sim/layers.ts';
import type { BuildingRec, ChunkPatch, DistrictStat, ResyncMsg } from '../sim/protocol.ts';
import { commandFor, selectionFrom } from './tools/toolSpec.ts';
import { rimStyle } from './districtRim.ts';
import { TINT_STRIDE } from './instancePacker.ts';
import { BuildingInstances, type FineSet } from './instances.ts';
import { generate, type KitModel } from './kit/generate.ts';
import { RenderMirror } from './mirror.ts';
import { LABEL_FAR, LABEL_NEAR, labelOpacity } from '../ui/Districts.tsx';

const A = rciId(1, 0, 1);
const rec = (slot: number, arch: number, x: number, y: number, w: number): BuildingRec => ({ slot, arch, x, y, w, h: w, rot: 0, level: 1, prog: 0, flags: 0, dmg: 0 });
const stat = (id: number, style: number): DistrictStat => ({
  id, name: `D${id}`, style, edict: 0, tiles: 1, cx: 0, cy: 0, x0: 0, y0: 0, x1: 0, y1: 0, population: 0, jobs: 0, landValue: 0, approval: 0, cost: 0,
});

const models = (): ((arch: number, variant: number) => KitModel) => {
  const cache = new Map<string, KitModel>();
  return (a, v) => { const k = `${a}:${v}`; if (!cache.has(k)) cache.set(k, generate(a, v)); return cache.get(k)!; };
};

function setup(far = false) {
  const mirror = new RenderMirror();
  const near = new Set(Array.from({ length: CHUNKS * CHUNKS }, (_, i) => i));
  const fine: FineSet = { has: (c) => !far && near.has(c), version: () => 1 };
  const d = new BuildingInstances({ mirror, fine, ground: () => 1.5, variants: () => 2, getModel: models() });
  return { mirror, d };
}

const patchBuildings = (m: RenderMirror, buildings: BuildingRec[]): void => { m.apply({ type: 'chunkPatch', tick: 1, chunks: [], layers: {}, buildings } as ChunkPatch); };
function paintTiles(m: RenderMirror, ids: number[], district: number): void {
  const chunks = new Set(ids.map((i) => (((i / MAP) | 0) >> 4) * CHUNKS + ((i % MAP) >> 4)));
  const list = [...chunks].sort((a, b) => a - b);
  const data = new Uint8Array(list.length * 256);
  const next = m.layers.district!.slice();
  for (const i of ids) next[i] = district;
  list.forEach((c, n) => {
    const cx = (c % CHUNKS) * 16, cy = ((c / CHUNKS) | 0) * 16;
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) data[n * 256 + y * 16 + x] = next[(cy + y) * MAP + cx + x]!;
  });
  m.apply({ type: 'chunkPatch', tick: 2, chunks: list, layers: { district: data }, buildings: [] } as ChunkPatch);
}
const tintOf = (d: BuildingInstances, slot: number): number[] => {
  const b = d.near.batches.get(d.near.keyOf(slot)!)!, i = d.near.indexOf(slot);
  return Array.from(b.tint.subarray(i * TINT_STRIDE, (i + 1) * TINT_STRIDE));
};
const stats = (m: RenderMirror, districts: DistrictStat[]): void => {
  m.apply({
    type: 'stats', districts, tick: 0, treasury: 0, population: 0, rciDemand: [0, 0, 0], unemployment: 0, dayFrac: 0, day: 0, weather: 0, weatherIntensity: 0,
  } as never);
};

describe('district style tint on building instances', () => {
  it('tints the buildings standing in a styled district and leaves the ones beside it alone', () => {
    const { mirror, d } = setup();
    patchBuildings(mirror, [rec(0, A, 10, 10, 1), rec(1, A, 30, 10, 1)]);
    d.sync();
    const plain = tintOf(d, 0), beside = tintOf(d, 1);
    stats(mirror, [stat(1, 0)]);
    paintTiles(mirror, [10 * MAP + 10, 10 * MAP + 11, 11 * MAP + 10, 11 * MAP + 11], 1);
    d.sync();
    const [r, g, b] = STYLES[0]!.tint;
    const tinted = tintOf(d, 0);
    expect(tinted[0]).toBeCloseTo(plain[0]! * r, 5);
    expect(tinted[1]).toBeCloseTo(plain[1]! * g, 5);
    expect(tinted[2]).toBeCloseTo(plain[2]! * b, 5);
    expect(tintOf(d, 1)).toEqual(beside);
  });

  it('follows a style change, a district going away and a tile being painted out', () => {
    const { mirror, d } = setup();
    patchBuildings(mirror, [rec(0, A, 10, 10, 1)]);
    paintTiles(mirror, [10 * MAP + 10], 1);
    stats(mirror, [stat(1, 1)]);
    d.sync();
    const base = tintOf(d, 0);
    stats(mirror, [stat(1, 3)]);
    d.sync();
    const after = tintOf(d, 0);
    expect(d.lastWritten).toEqual([0]);
    expect(after[0]! / base[0]!).toBeCloseTo(STYLES[3]!.tint[0] / STYLES[1]!.tint[0], 4);
    expect(after[1]! / base[1]!).toBeCloseTo(STYLES[3]!.tint[1] / STYLES[1]!.tint[1], 4);
    stats(mirror, []);
    d.sync();
    expect(tintOf(d, 0)[0]!).toBeCloseTo(after[0]! / STYLES[3]!.tint[0], 4);
    stats(mirror, [stat(1, 1)]);
    d.sync();
    paintTiles(mirror, [10 * MAP + 10], 0);
    d.sync();
    expect(tintOf(d, 0)[0]!).toBeCloseTo(after[0]! / STYLES[3]!.tint[0], 4);
  });

  it('uses the district under the middle tile of a larger footprint, and tints the far LOD box too', () => {
    const { mirror, d } = setup(true);
    patchBuildings(mirror, [rec(0, rciId(1, 1, 2), 20, 20, 2), rec(1, rciId(1, 1, 2), 40, 20, 2)]);
    d.sync();
    const far = (slot: number) => { const b = d.far.batches.get('far')!, i = d.far.indexOf(slot); return { wall: Array.from(b.tint.subarray(i * 3, i * 3 + 3)), roof: Array.from(b.state.subarray(i * 4, i * 4 + 3)) }; };
    const plain = far(0), beside = far(1);
    stats(mirror, [stat(2, 2)]);
    paintTiles(mirror, [21 * MAP + 21], 2);
    d.sync();
    const t = STYLES[2]!.tint;
    expect(far(0).wall[2]).toBeCloseTo(plain.wall[2]! * t[2], 5);
    expect(far(0).roof[0]).toBeCloseTo(plain.roof[0]! * t[0], 5);
    expect(far(1)).toEqual(beside);
  });

  it('keeps the style table and the stats list the mirror was last told', () => {
    const { mirror } = setup();
    expect(mirror.districtStyle(1)).toBe(-1);
    const v = mirror.districtStyleVersion;
    stats(mirror, [stat(1, 5), stat(4, 2)]);
    expect(mirror.districtStyle(1)).toBe(5);
    expect(mirror.districtStyle(4)).toBe(2);
    expect(mirror.districts.map((x) => x.id)).toEqual([1, 4]);
    expect(mirror.districtStyleVersion).toBe(v + 1);
    stats(mirror, [stat(1, 5), stat(4, 2)]);
    expect(mirror.districtStyleVersion).toBe(v + 1);
    mirror.apply({ type: 'resync', tick: 5, layers: {}, scalars: new Float64Array(mirror.scalars.length) } as ResyncMsg);
    expect(mirror.districtStyle(4)).toBe(2);
  });
});

describe('district boundary line on the ground', () => {
  it('marks the outermost ring of a styled district and nothing inside, outside or unstyled', () => {
    const layer = new Uint8Array(MAP * MAP);
    for (let y = 20; y < 26; y++) for (let x = 30; x < 38; x++) layer[y * MAP + x] = 1;
    for (let x = 0; x < 3; x++) layer[x] = 2;
    const styleOf = (id: number): number => (id === 1 ? 4 : -1);
    const rim = (x: number, y: number): number => rimStyle(layer, styleOf, y * MAP + x);
    expect(rim(30, 20)).toBe(4);
    expect(rim(37, 25)).toBe(4);
    expect(rim(33, 20)).toBe(4);
    expect(rim(30, 23)).toBe(4);
    expect(rim(33, 22)).toBe(-1);
    expect(rim(29, 22)).toBe(-1);
    expect(rim(38, 22)).toBe(-1);
    expect(rim(1, 0)).toBe(-1);
    let ring = 0;
    for (let i = 0; i < layer.length; i++) if (rimStyle(layer, styleOf, i) >= 0) ring++;
    expect(ring).toBe(8 * 6 - 6 * 4);
    layer[0] = 1;
    expect(rim(0, 0), 'the map edge counts as outside').toBe(4);
  });
});

describe('district tool spec', () => {
  it('maps a drag to the paint or erase command and builds the selection from the debug form', () => {
    const paint = selectionFrom('district', { mode: 'paint', district: 3 });
    expect(paint).toEqual({ tool: 'district', mode: 'paint', district: 3 });
    expect(commandFor(paint!, { x: 5, y: 6 }, { x: 9, y: 8 }, 0)).toEqual({ type: 'paintDistrict', district: 3, x0: 5, y0: 6, x1: 9, y1: 8 });
    const erase = selectionFrom('district', { mode: 'erase' });
    expect(commandFor(erase!, { x: 1, y: 2 }, { x: 3, y: 4 }, 0)).toEqual({ type: 'eraseDistrict', x0: 1, y0: 2, x1: 3, y1: 4 });
    expect(selectionFrom('district')).toEqual({ tool: 'district', mode: 'paint', district: 1 });
    expect(selectionFrom('district', { district: 0 })).toBeNull();
    expect(selectionFrom('district', { district: 17 })).toBeNull();
    expect(selectionFrom('district', { mode: 'smear' })).toBeNull();
  });
});

describe('district labels', () => {
  it('fade in over the near edge of mid zoom, hold, and hide at far zoom', () => {
    expect(labelOpacity(LABEL_NEAR - 1)).toBe(0);
    expect(labelOpacity(LABEL_FAR + 1)).toBe(0);
    expect(labelOpacity((LABEL_NEAR + LABEL_FAR) / 2)).toBe(1);
    expect(labelOpacity(LABEL_NEAR + 5)).toBeGreaterThan(0);
    expect(labelOpacity(LABEL_NEAR + 5)).toBeLessThan(1);
    expect(labelOpacity(300)).toBe(0);
    expect(labelOpacity(110)).toBe(1);
  });
});
