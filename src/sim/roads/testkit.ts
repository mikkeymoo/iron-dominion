import { MAP, ROAD, type World } from '../layers.ts';

// Helpers that write the road layer directly, with connectivity bits derived the way commands.fixRoad derives them.
// For tests and benches; the sim itself only changes roads through commands.

const NEI = [[0, -1, ROAD.N], [1, 0, ROAD.E], [0, 1, ROAD.S], [-1, 0, ROAD.W]] as const;

function fixTile(world: World, x: number, y: number): void {
  if (x < 0 || y < 0 || x >= MAP || y >= MAP) return;
  const i = y * MAP + x, r = world.road[i]!;
  if ((r & ROAD.CLASS_MASK) === 0) return;
  let conn = 0;
  for (const [dx, dy, bit] of NEI) {
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < MAP && ny < MAP && (world.road[ny * MAP + nx]! & ROAD.CLASS_MASK) !== 0) conn |= bit;
  }
  world.road[i] = (r & (ROAD.CLASS_MASK | ROAD.BRIDGE | ROAD.SLOPE)) | conn;
}

function fixAround(world: World, x: number, y: number): void {
  fixTile(world, x, y);
  for (const [dx, dy] of NEI) fixTile(world, x + dx, y + dy);
}

/** Set one road tile (class 0 removes it) and repair the connectivity bits around it. */
export function setRoad(world: World, x: number, y: number, cls: number, flags = 0): void {
  world.road[y * MAP + x] = cls === 0 ? 0 : cls | flags;
  fixAround(world, x, y);
}

export function setRoads(world: World, tiles: Iterable<readonly [number, number, number?, number?]>): void {
  const list = [...tiles];
  for (const [x, y, cls = 1, flags = 0] of list) world.road[y * MAP + x] = cls === 0 ? 0 : cls | flags;
  for (const [x, y] of list) fixAround(world, x, y);
}

export function clearRoads(world: World): void {
  world.road.fill(0);
}

/**
 * Lay a map out from text rows placed at (ox, oy). '#' street, '=' avenue, 'H' highway, 'b' street bridge,
 * '^' sloped street, anything else is empty.
 */
export function drawRoads(world: World, rows: string[], ox: number, oy: number): void {
  const tiles: [number, number, number, number][] = [];
  rows.forEach((row, j) => [...row].forEach((ch, i) => {
    const cls = ch === '#' || ch === 'b' || ch === '^' ? 1 : ch === '=' ? 2 : ch === 'H' ? 3 : 0;
    if (cls) tiles.push([ox + i, oy + j, cls, ch === 'b' ? ROAD.BRIDGE : ch === '^' ? ROAD.SLOPE : 0]);
  }));
  setRoads(world, tiles);
}

export const tile = (x: number, y: number): number => y * MAP + x;
