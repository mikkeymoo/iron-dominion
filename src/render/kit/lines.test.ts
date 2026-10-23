import { describe, expect, it } from 'vitest';
import { MAP } from '../../sim/layers.ts';
import {
  ARM_FOR_X, ARM_FOR_Z, INSULATOR_DROP, LINE_E, LINE_N, LINE_S, LINE_W, PIPE_DEPTH, PYLON_H, PYLON_SPACING, buildPipes, buildPowerLines, buildPylon,
  isPylonNode, lineMask,
} from './lines.ts';

const FLAT = new Int16Array(MAP * MAP).fill(160);
const layer = (tiles: readonly [number, number][]): Uint8Array => {
  const l = new Uint8Array(MAP * MAP);
  for (const [x, y] of tiles) l[y * MAP + x] = 1;
  return l;
};
const run = (x0: number, x1: number, y: number): [number, number][] => Array.from({ length: x1 - x0 + 1 }, (_, k) => [x0 + k, y]);
const col = (x: number, y0: number, y1: number): [number, number][] => Array.from({ length: y1 - y0 + 1 }, (_, k) => [x, y0 + k]);

describe('pylon placement', () => {
  it('reads the neighbour mask of a line tile', () => {
    const l = layer([...run(10, 12, 10), [11, 11]]);
    expect(lineMask(l, 11, 10)).toBe(LINE_E | LINE_W | LINE_S);
    expect(lineMask(l, 10, 10)).toBe(LINE_E);
    expect(lineMask(l, 11, 11)).toBe(LINE_N);
    expect(lineMask(l, 0, 0)).toBe(0);
  });

  it('puts pylons at ends, bends and branches, and on every third tile of a straight run', () => {
    expect(isPylonNode(LINE_E, 11, 10)).toBe(true);
    expect(isPylonNode(0, 11, 10)).toBe(true);
    expect(isPylonNode(LINE_E | LINE_S, 11, 10)).toBe(true);
    expect(isPylonNode(LINE_E | LINE_W | LINE_N, 11, 10)).toBe(true);
    expect(isPylonNode(LINE_E | LINE_W, 12, 10)).toBe(true);
    expect(isPylonNode(LINE_E | LINE_W, 13, 10)).toBe(false);
    expect(isPylonNode(LINE_N | LINE_S, 10, 9)).toBe(true);
    expect(isPylonNode(LINE_N | LINE_S, 10, 10)).toBe(false);
  });

  it('builds a straight run as pylons joined by short spans, three conductors each', () => {
    const l = layer(run(10, 20, 10));
    const g = buildPowerLines(l, FLAT, 0, 0, MAP);
    // Ends at 10 and 20; interior nodes at 12, 15, 18.
    expect(g.pylonCount).toBe(5);
    expect(g.spans).toBe(4);
    expect(Array.from(g.pylons.filter((_, i) => i % 3 === 0))).toEqual([10.5, 12.5, 15.5, 18.5, 20.5]);
    // Per span: 3 conductors, 6 tube segments each, 3 sides, 2 triangles per side.
    expect(g.cables.triangleCount).toBe(4 * 3 * 6 * 3 * 2);
  });

  it('never leaves a span longer than PYLON_SPACING tiles', () => {
    const l = layer([...run(5, 60, 30), ...col(40, 30, 90), ...run(40, 100, 90)]);
    const g = buildPowerLines(l, FLAT, 0, 0, MAP);
    expect(g.pylonCount).toBeGreaterThan(30);
    const nodes = new Set<string>();
    for (let i = 0; i < g.pylonCount; i++) nodes.add(`${g.pylons[i * 3]! - 0.5},${g.pylons[i * 3 + 2]! - 0.5}`);
    // Walk every line tile: the distance to the nearest node along its run is under the spacing.
    let longest = 0;
    for (const [x, y] of [...run(5, 60, 30), ...col(40, 30, 90), ...run(40, 100, 90)]) {
      let best = 99;
      for (const n of nodes) { const [nx, ny] = n.split(',').map(Number); if (nx === x || ny === y) best = Math.min(best, Math.abs(nx! - x) + Math.abs(ny! - y)); }
      longest = Math.max(longest, best);
    }
    expect(longest).toBeLessThan(PYLON_SPACING);
  });

  it('gives a bend its own pylon and cables that sag between attach points', () => {
    const l = layer([...run(10, 13, 10), ...col(13, 11, 14)]);
    const g = buildPowerLines(l, FLAT, 0, 0, MAP);
    expect(Array.from({ length: g.pylonCount }, (_, i) => `${g.pylons[i * 3]! - 0.5},${g.pylons[i * 3 + 2]! - 0.5}`)).toContain('13,10');
    const ground = 10;
    const attachX = ground + ARM_FOR_X - INSULATOR_DROP;
    const attachZ = ground + ARM_FOR_Z - INSULATOR_DROP;
    let lowest = Infinity, highest = -Infinity;
    for (let i = 1; i < g.cables.positions.length; i += 3) { lowest = Math.min(lowest, g.cables.positions[i]!); highest = Math.max(highest, g.cables.positions[i]!); }
    expect(lowest).toBeLessThan(Math.min(attachX, attachZ) - 0.01);
    expect(highest).toBeLessThanOrEqual(Math.max(attachX, attachZ) + 0.02);
    for (const v of g.cables.positions) expect(Number.isFinite(v)).toBe(true);
  });

  it('partitions cleanly: the spans and pylons of the 64-tile quadrants add up to the whole map', () => {
    const tiles = [...run(30, 140, 63), ...col(64, 20, 200), ...run(100, 200, 127), ...col(190, 90, 130)];
    const l = layer(tiles);
    const whole = buildPowerLines(l, FLAT, 0, 0, MAP);
    let spans = 0, pylons = 0;
    for (let sy = 0; sy < MAP; sy += 64) for (let sx = 0; sx < MAP; sx += 64) { const g = buildPowerLines(l, FLAT, sx, sy, 64); spans += g.spans; pylons += g.pylonCount; }
    expect([spans, pylons]).toEqual([whole.spans, whole.pylonCount]);
    expect(whole.spans).toBeGreaterThan(50);
  });

  it('follows rising ground', () => {
    const h = new Int16Array(MAP * MAP);
    for (let y = 0; y < MAP; y++) for (let x = 0; x < MAP; x++) h[y * MAP + x] = 160 + x * 4;
    const g = buildPowerLines(layer(run(10, 16, 10)), h, 0, 0, MAP);
    const ys = Array.from({ length: g.pylonCount }, (_, i) => g.pylons[i * 3 + 1]!);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    expect(ys[ys.length - 1]! - ys[0]!).toBeGreaterThan(1);
  });
});

describe('pylon mesh', () => {
  it('is a small, finite lattice standing on y = 0 with coloured vertices', () => {
    const m = buildPylon();
    expect(m.triangleCount).toBeGreaterThan(100);
    expect(m.triangleCount).toBeLessThan(500);
    expect(m.colors!.length).toBe(m.positions.length);
    let top = -Infinity, bottom = Infinity;
    for (let i = 0; i < m.positions.length; i += 3) {
      for (let k = 0; k < 3; k++) expect(Number.isFinite(m.positions[i + k]!)).toBe(true);
      top = Math.max(top, m.positions[i + 1]!); bottom = Math.min(bottom, m.positions[i + 1]!);
    }
    expect(bottom).toBeGreaterThanOrEqual(-0.02);
    expect(top).toBeGreaterThanOrEqual(PYLON_H);
    expect(top).toBeLessThan(PYLON_H + 0.2);
    for (const i of m.indices) expect(i).toBeLessThan(m.positions.length / 3);
  });
});

describe('pipes', () => {
  it('builds one tube per link, joints at ends and bends, all below the ground', () => {
    const l = layer([...run(10, 14, 10), ...col(14, 11, 14)]);
    const p = buildPipes(l, FLAT, 0, 0, MAP);
    expect(p.segments).toBe(4 + 4);
    expect(p.mesh.triangleCount).toBeGreaterThan(8 * 6 * 2);
    for (let i = 1; i < p.mesh.positions.length; i += 3) expect(p.mesh.positions[i]!).toBeLessThan(10 - PIPE_DEPTH + 0.2);
    expect(buildPipes(new Uint8Array(MAP * MAP), FLAT, 0, 0, MAP).mesh.triangleCount).toBe(0);
  });

  it('uses 32-bit indices so a dense network never overflows', () => {
    const tiles: [number, number][] = [];
    for (let y = 0; y < 64; y++) tiles.push(...run(0, 63, y));
    const p = buildPipes(layer(tiles), FLAT, 0, 0, 64);
    expect(p.mesh.indices).toBeInstanceOf(Uint32Array);
    expect(p.mesh.positions.length / 3).toBeGreaterThan(65535);
  });
});
