// ?showcase=1: a plan (list of sim commands + a camera pose) that fills a flat district near the map centre with a road grid
// and every RCI archetype at all levels, some under construction, plus services. Debug sims only (needs debugGrow).
import type { CommandBody } from '../../sim/commands.ts';
import { ARCH, rciFootprint, rciId } from '../../sim/catalog.ts';
import { HEIGHT_SCALE, MAP, TERRAIN } from '../../sim/layers.ts';

export const SHOWCASE_W = 48;
export const SHOWCASE_H = 26;
const PITCH = 4;
const LOTS_X = 9;
const LOTS_Y = 6;
const PROGRESS = [0.04, 0.1, 0.22, 0.38, 0.52, 0.66, 0.8, 0.9, 0.97];

export interface ShowcasePlan {
  origin: { x: number; y: number };
  commands: CommandBody[];
  camera: { x: number; z: number; yaw: number; pitch: number; dist: number };
  buildings: number;
}

interface Terrain { terrain: ArrayLike<number>; height: ArrayLike<number>; waterDepth: ArrayLike<number> }

const isLand = (t: number): boolean => t === TERRAIN.GRASS || t === TERRAIN.SAND || t === TERRAIN.FOREST;

/**
 * Flattest all-land window of w x h that is also near the map centre, or null. The sim levels it with debugLevel.
 * O(map): two summed-area tables (non-land count, height sum and sum of squares) give every window's land test and height
 * variance in constant time. Flatness is the height standard deviation, a smoother stand-in for min/max range.
 */
export function findShowcaseSite(l: Terrain, w = SHOWCASE_W, h = SHOWCASE_H): { x: number; y: number } | null {
  const W = MAP + 1;
  const bad = new Int32Array(W * W), sum = new Float64Array(W * W), sq = new Float64Array(W * W);
  for (let y = 0; y < MAP; y++) {
    let rb = 0, rs = 0, rq = 0;
    for (let x = 0; x < MAP; x++) {
      const i = y * MAP + x, v = l.height[i]! / HEIGHT_SCALE;
      rb += !isLand(l.terrain[i]!) || l.waterDepth[i]! > 0 ? 1 : 0; rs += v; rq += v * v;
      const o = (y + 1) * W + x + 1, up = y * W + x + 1;
      bad[o] = bad[up]! + rb; sum[o] = sum[up]! + rs; sq[o] = sq[up]! + rq;
    }
  }
  const box = (t: Int32Array | Float64Array, x: number, y: number): number => t[(y + h) * W + x + w]! - t[y * W + x + w]! - t[(y + h) * W + x]! + t[y * W + x]!;
  const n = w * h, c = MAP / 2;
  let best: { x: number; y: number; score: number } | null = null;
  for (let y = 4; y + h < MAP - 4; y += 2) {
    for (let x = 4; x + w < MAP - 4; x += 2) {
      if (box(bad, x, y) > 0) continue;
      const mean = box(sum, x, y) / n, variance = Math.max(0, box(sq, x, y) / n - mean * mean);
      const score = Math.sqrt(variance) * 1.5 + Math.hypot(x + w / 2 - c, y + h / 2 - c) * 0.05;
      if (!best || score < best.score) best = { x, y, score };
    }
  }
  return best ? { x: best.x, y: best.y } : null;
}

export function planShowcase(l: Terrain): ShowcasePlan | null {
  const site = findShowcaseSite(l);
  if (!site) return null;
  const { x: ox, y: oy } = site;
  const commands: CommandBody[] = [];
  let buildings = 0;
  const gridW = LOTS_X * PITCH, gridH = LOTS_Y * PITCH;
  commands.push({ type: 'debugLevel', x0: ox, y0: oy, x1: ox + SHOWCASE_W - 1, y1: oy + SHOWCASE_H - 1, margin: 10 });

  for (let r = 0; r <= LOTS_Y; r++) {
    const cls = r === 3 ? 3 : r === 0 || r === LOTS_Y ? 2 : 1;
    commands.push({ type: 'placeRoad', ax: ox, ay: oy + r * PITCH, bx: ox + gridW, by: oy + r * PITCH, cls });
  }
  for (let c = 0; c <= LOTS_X; c++) {
    const cls = c === 4 || c === 5 ? 2 : 1;
    commands.push({ type: 'placeRoad', ax: ox + c * PITCH, ay: oy, bx: ox + c * PITCH, by: oy + gridH, cls });
  }

  const grow = (x: number, y: number, archetype: number, progress: number): void => {
    commands.push({ type: 'debugGrow', x, y, archetype, progress });
    buildings++;
  };

  for (let r = 0; r < LOTS_Y; r++) {
    for (let c = 0; c < LOTS_X; c++) {
      const density = Math.floor(c / 3), level = (c % 3) + 1;
      // Rows: R, C, I finished, then R, C, I under construction at staggered progress.
      const zone = (r % 3) + 1;
      const building = r >= 3;
      const arch = rciId(zone, density, level);
      const f = rciFootprint(density, level);
      const lx = ox + c * PITCH + 1, ly = oy + r * PITCH + 1;
      const progress = building ? PROGRESS[(c + r) % PROGRESS.length]! : 1;
      if (f === 1) {
        for (const [dx, dy] of [[0, 0], [2, 0], [0, 2], [2, 2]] as const) grow(lx + dx, ly + dy, arch, building ? PROGRESS[(c + r + dx + dy) % PROGRESS.length]! : 1);
      } else if (f === 2) grow(lx + (c & 1), ly + 1, arch, progress);
      else grow(lx, ly, arch, progress);
    }
  }

  // Services east of the grid: free land, no roads.
  const sx = ox + gridW + 3;
  commands.push({ type: 'placeBuilding', arch: ARCH.POWER_PLANT, x: sx, y: oy + 2, rot: 0 });
  commands.push({ type: 'placeBuilding', arch: ARCH.WATER_PUMP, x: sx, y: oy + 8, rot: 0 });
  commands.push({ type: 'placeBuilding', arch: ARCH.DEPOT, x: sx + 4, y: oy + 8, rot: 0 });
  commands.push({ type: 'placeBuilding', arch: ARCH.FIRE_STATION, x: sx, y: oy + 12, rot: 0 });
  buildings += 4;

  return {
    origin: site,
    commands,
    camera: { x: ox + (gridW + 8) / 2, z: oy + gridH / 2 + 2, yaw: 0.55, pitch: 0.6, dist: 42 },
    buildings,
  };
}
