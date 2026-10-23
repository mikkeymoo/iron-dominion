import { describe, expect, it } from 'vitest';
import { ATLAS_CELL_PX, ATLAS_H, ATLAS_W, buildWindowAtlas, CELL, cellUv, type CellId } from './atlas.ts';

const fnv = (a: Uint8Array): number => { let h = 2166136261; for (let i = 0; i < a.length; i++) h = Math.imul(h ^ a[i]!, 16777619); return h >>> 0; };

describe('window atlas', () => {
  it('is deterministic and the right size', () => {
    const a = buildWindowAtlas(), b = buildWindowAtlas();
    expect(a.length).toBe(ATLAS_W * ATLAS_H * 4);
    expect(fnv(a)).toBe(fnv(b));
    expect(a).toEqual(b);
  });

  it('puts glass in every window cell and none in the opaque garage cell', () => {
    const data = buildWindowAtlas();
    const stat = (cell: CellId): { pane: number; glow: number } => {
      const cx = (cell % 4) * ATLAS_CELL_PX, cy = Math.floor(cell / 4) * ATLAS_CELL_PX;
      let pane = 0, glow = 0;
      for (let y = 0; y < ATLAS_CELL_PX; y++) for (let x = 0; x < ATLAS_CELL_PX; x++) {
        const o = ((cy + y) * ATLAS_W + cx + x) * 4;
        pane += data[o]! / 255; glow += data[o + 1]! / 255;
      }
      const n = ATLAS_CELL_PX * ATLAS_CELL_PX;
      return { pane: pane / n, glow: glow / n };
    };
    for (const c of [CELL.SASH, CELL.TALL, CELL.RIBBON, CELL.STORE, CELL.DOOR, CELL.SLIT, CELL.CURTAIN] as CellId[]) {
      const s = stat(c);
      expect(s.pane, `cell ${c} pane`).toBeGreaterThan(0.12);
      expect(s.pane).toBeLessThan(0.95);
      expect(s.glow).toBeGreaterThan(0.05);
      expect(s.glow).toBeLessThanOrEqual(s.pane + 1e-6);
    }
    expect(stat(CELL.GARAGE).pane).toBe(0);
  });

  it('keeps every sash cell frame (mullions) distinct from its glass', () => {
    const data = buildWindowAtlas();
    const at = (u: number, v: number): number => data[(Math.floor(v * ATLAS_CELL_PX) * ATLAS_W + Math.floor(u * ATLAS_CELL_PX)) * 4]!;
    expect(at(0.3, 0.3)).toBeGreaterThan(200);
    expect(at(0.5, 0.3)).toBeLessThan(40);
    expect(at(0.02, 0.5)).toBe(0);
  });

  it('gives cell uv rectangles that stay inside their cell', () => {
    for (let c = 0; c < 8; c++) {
      const [u0, v0, u1, v1] = cellUv(c as CellId);
      expect(u0).toBeGreaterThan((c % 4) / 4); expect(u1).toBeLessThan(((c % 4) + 1) / 4);
      expect(v0).toBeGreaterThan(Math.floor(c / 4) / 2); expect(v1).toBeLessThan((Math.floor(c / 4) + 1) / 2);
    }
  });
});
