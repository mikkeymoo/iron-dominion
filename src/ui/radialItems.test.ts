import { describe, expect, it, vi } from 'vitest';
import { ARCH, BFLAG } from '../sim/catalog.ts';
import { MAP, ROAD } from '../sim/layers.ts';
import { tileIdx } from '../sim/tiles.ts';
import { buildingInfoText, bulldozeTile, radialItemsFor, radialTargetAt } from './radialItems';

const layers = () => ({
  bId: new Uint16Array(MAP * MAP), bArch: new Uint8Array(8192), bFlags: new Uint8Array(8192), bLevel: new Uint8Array(8192), bProg: new Uint8Array(8192),
  road: new Uint16Array(MAP * MAP),
});
const ids = (items: { id: string }[]): string[] => items.map((i) => i.id);

describe('radial targets', () => {
  it('finds bare land, a road and a building, with the building winning over the road under it', () => {
    const L = layers();
    L.road[tileIdx(5, 5)] = 2;
    L.bId[tileIdx(8, 8)] = 4;
    L.bArch[3] = ARCH.DEPOT;
    L.road[tileIdx(8, 8)] = 1;
    expect(radialTargetAt(L, { x: 1, y: 1 }).kind).toBe('land');
    expect(radialTargetAt(L, { x: 5, y: 5 })).toMatchObject({ kind: 'road', cls: 2 });
    expect(radialTargetAt(L, { x: 8, y: 8 })).toMatchObject({ kind: 'building', slot: 3, arch: ARCH.DEPOT });
  });

  it('ignores the connection bits of a road tile when reading its class', () => {
    const L = layers();
    L.road[tileIdx(5, 5)] = 3 | ROAD.N | ROAD.E;
    expect(radialTargetAt(L, { x: 5, y: 5 })).toMatchObject({ kind: 'road', cls: 3 });
  });
});

describe('radial items', () => {
  it('offers the five build tools on empty land', () => {
    expect(ids(radialItemsFor({ kind: 'land', tile: { x: 0, y: 0 } }, { tier: 0 }))).toEqual(['road', 'zone', 'service', 'utilities', 'terraform']);
  });

  it('offers Info, Bulldoze and Follow on a building, and Upgrade only where the sim has one', () => {
    const t = { kind: 'building', tile: { x: 0, y: 0 }, slot: 0, arch: 1 } as const;
    expect(ids(radialItemsFor(t, { tier: 0 }))).toEqual(['info', 'bulldoze', 'follow']);
    expect(ids(radialItemsFor(t, { tier: 0, canUpgrade: true }))).toEqual(['info', 'upgrade', 'bulldoze', 'follow']);
    expect(ids(radialItemsFor(t, { tier: 0, canFollow: false }))).toEqual(['info', 'bulldoze']);
  });

  it('offers a road upgrade only once the next class is unlocked', () => {
    const street = { kind: 'road', tile: { x: 0, y: 0 }, cls: 1 } as const;
    expect(ids(radialItemsFor(street, { tier: 0 }))).toEqual(['bulldoze']);
    const up = radialItemsFor(street, { tier: 2 });
    expect(ids(up)).toEqual(['bulldoze', 'upgrade-road']);
    expect(up[1]!.action).toEqual({ kind: 'roadUpgrade', cls: 2 });
    expect(ids(radialItemsFor({ ...street, cls: 3 }, { tier: 5 }))).toEqual(['bulldoze']);
  });
});

describe('building info', () => {
  it('names the building and what is wrong with it', () => {
    const L = layers();
    L.bArch[2] = ARCH.DEPOT;
    L.bFlags[2] = BFLAG.UNPOWERED | BFLAG.UNWATERED;
    expect(buildingInfoText(L, 2)).toBe('Depot, no power, no water');
    L.bFlags[2] = BFLAG.CONSTRUCTING;
    L.bProg[2] = 128;
    expect(buildingInfoText(L, 2)).toMatch(/under construction 50%/);
    expect(buildingInfoText(L, 5)).toBe('Nothing here.');
  });
});

describe('quick bulldoze', () => {
  it('drags the bulldoze tool over one tile and restores the previous selection', () => {
    const calls: unknown[] = [];
    const c = {
      sel: { tool: 'road', cls: 1 } as unknown,
      select: vi.fn(function (this: { sel: unknown }, s: unknown) { this.sel = s; calls.push(s); }),
      dragTiles: vi.fn(() => 7),
    };
    expect(bulldozeTile(c as never, { x: 3, y: 4 })).toBe(7);
    expect(c.dragTiles).toHaveBeenCalledWith({ x: 3, y: 4 }, { x: 3, y: 4 });
    expect(calls).toEqual([{ tool: 'bulldoze' }, { tool: 'road', cls: 1 }]);
  });
});
