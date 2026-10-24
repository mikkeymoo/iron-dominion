import { describe, expect, it } from 'vitest';
import { MAP, TERRAIN } from '../../sim/layers.ts';
import { buildWaterMesh } from '../terrainMesh.ts';
import { isBridgeTile } from './bridge.ts';
import { packWaterInfo } from './shore.ts';

const grid = (rows: string[]): ((x: number, y: number) => boolean) => (x, y) => rows[y]?.[x] === '#';

describe('river bridge tiles', () => {
  it('bridges a diagonal pair of wet tiles on exactly one of the two dry corners', () => {
    const down = grid(['#.', '.#']);
    expect([isBridgeTile(down, 1, 0), isBridgeTile(down, 0, 1)]).toEqual([true, false]);
    const up = grid(['.#', '#.']);
    expect([isBridgeTile(up, 0, 0), isBridgeTile(up, 1, 1)]).toEqual([true, false]);
  });

  it('leaves wet tiles, connected water and isolated tiles alone', () => {
    const wet = grid(['##', '.#']);
    for (const [x, y] of [[0, 0], [1, 0], [1, 1], [0, 1]] as const) expect(isBridgeTile(wet, x, y), `${x},${y}`).toBe(false);
    expect(isBridgeTile(grid(['...', '.#.', '...']), 0, 0)).toBe(false);
  });

  it('turns a diagonal chain into a connected channel: n wet tiles gain n - 1 bridges', () => {
    const rows = ['#....', '.#...', '..#..', '...#.', '....#'];
    const wet = grid(rows);
    let bridges = 0;
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) if (isBridgeTile(wet, x, y)) bridges++;
    expect(bridges).toBe(4);
  });

  it('draws the bridges in the water mesh and gives them water in the info texture', () => {
    const terrain = new Uint8Array(MAP * MAP).fill(TERRAIN.GRASS);
    const depth = new Uint8Array(MAP * MAP);
    const height = new Int16Array(MAP * MAP).fill(160);
    for (let k = 0; k < 6; k++) { terrain[(20 + k) * MAP + 30 + k] = TERRAIN.RIVER; depth[(20 + k) * MAP + 30 + k] = 24; }
    const mesh = buildWaterMesh({ height, terrain, waterDepth: depth, road: new Uint16Array(MAP * MAP) }, 16, 16, 32);
    expect(mesh.triangleCount / 2, 'one quad per wet tile plus one per bridge').toBe(6 + 5);
    expect(Array.from(mesh.positions).every(Number.isFinite), 'every bridge corner has a level, even one touching no wet tile').toBe(true);
    const info = packWaterInfo(terrain, depth, MAP);
    // A bridge is the east member of a down-right pair: (31, 20) sits between (30, 20) and (31, 21).
    expect(info[(20 * MAP + 31) * 4 + 1], 'shore distance written for the bridge tile').toBeGreaterThan(0);
    expect(info[(20 * MAP + 31) * 4 + 2], 'marked as river water').toBe(128);
    expect(info[(21 * MAP + 30) * 4 + 2], 'the other corner stays dry').toBe(0);
  });
});
