import { MAP, ROAD } from '../layers.ts';
import { HALF_WIDTH, LANES } from './constants.ts';

// Where a vehicle is drawn. The route is a list of tile centres; each tile is crossed along a quadratic curve from the midpoint of
// the edge it entered by, through (an offset copy of) its centre, to the midpoint of the edge it leaves by. A straight tile gives a
// straight line, a corner a rounded turn, and every point stays inside the tile. The curve is shifted to the right of travel by the
// vehicle's lane, so oncoming traffic passes on the other side. Pure of three and of the world's agent arrays.

export interface Pose { x: number; y: number; heading: number }

const DX = [0, 1, 0, -1] as const;
const DY = [-1, 0, 1, 0] as const;
/** Heading (atan2(dx, dy), the robots' convention: 0 faces +y, which is south) of travel in each direction. */
const HEADING = [Math.PI, Math.PI / 2, 0, -Math.PI / 2] as const;

/** Direction index (0 N, 1 E, 2 S, 3 W) of a tile-index difference between two adjacent tiles. */
export const dirOfStep = (diff: number): number => (diff === 1 ? 1 : diff === MAP ? 2 : diff === -1 ? 3 : 0);

/** Lateral offset (tiles, to the right of travel) of every (road class, lane): the middle of that lane's strip. Lanes past the road's count use its last. */
const OFFSETS = new Float64Array(8 * 4);
for (let cls = 0; cls < 8; cls++) {
  const lanes = LANES[cls]!;
  for (let lane = 0; lane < 4; lane++) OFFSETS[cls * 4 + lane] = ((Math.min(lane, lanes - 1) + 0.5) * HALF_WIDTH[cls]!) / lanes;
}

/** Offset of lane `lane` on a tile of road word `road`. */
export const laneOffset = (road: number, lane: number): number => OFFSETS[((road & ROAD.CLASS_MASK) << 2) | (lane & 3)]!;

/**
 * Pose of a point `pc` tiles along the route (route[0] is at pc 0), driving in lane `lane`. `road` is the road layer, `route` the tile
 * indices. Tile t covers pc in [t - 0.5, t + 0.5); it is entered at its edge midpoint and left at the next one.
 */
export function poseAlong(road: ArrayLike<number>, route: ArrayLike<number>, base: number, len: number, lane: number, pc: number, out: Pose): Pose {
  let t = Math.floor(pc + 0.5);
  if (t < 0) t = 0;
  if (t > len - 1) t = len - 1;
  const u = Math.min(1, Math.max(0, pc - (t - 0.5)));
  const tile = route[base + t]!;
  const prev = t > 0 ? route[base + t - 1]! : -1, next = t < len - 1 ? route[base + t + 1]! : -1;
  let din = prev >= 0 ? dirOfStep(tile - prev) : -1, dout = next >= 0 ? dirOfStep(next - tile) : -1;
  if (din < 0) din = dout < 0 ? 0 : dout;
  if (dout < 0) dout = din;
  const lane3 = lane & 3;
  const o = OFFSETS[((road[tile]! & ROAD.CLASS_MASK) << 2) | lane3]!;
  const oIn = prev >= 0 ? (o + OFFSETS[((road[prev]! & ROAD.CLASS_MASK) << 2) | lane3]!) / 2 : o;
  const oOut = next >= 0 ? (o + OFFSETS[((road[next]! & ROAD.CLASS_MASK) << 2) | lane3]!) / 2 : o;
  const cx = (tile & (MAP - 1)) + 0.5, cy = (tile >> 8) + 0.5;
  // Right-hand normal of direction d is (-dy, dx).
  const rix = -DY[din]!, riy = DX[din]!;
  const ex = cx - DX[din]! * 0.5 + rix * oIn, ey = cy - DY[din]! * 0.5 + riy * oIn;
  if (din === dout) {
    const xx = cx + DX[dout]! * 0.5 + rix * oOut, xy = cy + DY[dout]! * 0.5 + riy * oOut;
    out.x = ex + (xx - ex) * u;
    out.y = ey + (xy - ey) * u;
    out.heading = HEADING[dout]!;
    return out;
  }
  const rox = -DY[dout]!, roy = DX[dout]!;
  const xx = cx + DX[dout]! * 0.5 + rox * oOut, xy = cy + DY[dout]! * 0.5 + roy * oOut;
  const turn = (din + 2) % 4 !== dout;
  const px = cx + (turn ? rix * o + rox * o : rix * o), py = cy + (turn ? riy * o + roy * o : riy * o);
  const a = (1 - u) * (1 - u), b = 2 * u * (1 - u), c = u * u;
  out.x = a * ex + b * px + c * xx;
  out.y = a * ey + b * py + c * xy;
  const tx = 2 * (1 - u) * (px - ex) + 2 * u * (xx - px), ty = 2 * (1 - u) * (py - ey) + 2 * u * (xy - py);
  out.heading = Math.atan2(tx, ty);
  return out;
}
