import { HEIGHT_SCALE, MAP, TERRAIN, TILES, type World } from './layers.ts';

// Generation runs once at init and may use Math.pow/Math.floor-style floats. Results are quantised to
// integers before they enter the world, so the only cross-engine risk is a rounding tie in a transcendental
// call; hash equality is only promised within one JS engine (see DECISIONS in the unit report).

function lattice(seed: number, x: number, y: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(seed: number, x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = lattice(seed, xi, yi), b = lattice(seed, xi + 1, yi);
  const c = lattice(seed, xi, yi + 1), d = lattice(seed, xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(seed: number, x: number, y: number, octaves: number): number {
  let amp = 0.5, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(seed + o * 101, x * freq, y * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

class MinHeap {
  keys = new Float64Array(TILES + 16);
  n = 0;
  push(k: number): void {
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p]! <= k) break;
      this.keys[i] = this.keys[p]!;
      i = p;
    }
    this.keys[i] = k;
  }
  pop(): number {
    const top = this.keys[0]!;
    const last = this.keys[--this.n]!;
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && this.keys[c + 1]! < this.keys[c]!) c++;
      if (this.keys[c]! >= last) break;
      this.keys[i] = this.keys[c]!;
      i = c;
    }
    this.keys[i] = last;
    return top;
  }
}

const DX = [0, 1, 1, 1, 0, -1, -1, -1];
const DY = [-1, -1, 0, 1, 1, 1, 0, -1];

/** Scenario terrain: the share of tiles under the sea (default 0.28) and whether rivers are carved (default true). */
export interface TerrainPreset { sea?: number; rivers?: boolean }

export function generateTerrain(world: World, seed: number, preset: TerrainPreset = {}): void {
  const n = new Float32Array(TILES);
  const hist = new Uint32Array(1024);
  for (let y = 0; y < MAP; y++) for (let x = 0; x < MAP; x++) {
    const v = fbm(seed, x / 56, y / 56, 5);
    n[y * MAP + x] = v;
    hist[Math.min(1023, Math.floor(v * 1024))]!++;
  }
  // Sea level: the noise value below which ~28% of tiles fall.
  let acc = 0, bin = 0;
  const sea = preset.sea !== undefined && preset.sea > 0 && preset.sea < 0.9 ? preset.sea : 0.28;
  while (bin < 1023 && acc + hist[bin]! < TILES * sea) acc += hist[bin++]!;
  const thr = bin / 1024;

  const h = world.height;
  let maxLand = 1;
  for (let i = 0; i < TILES; i++) {
    const v = n[i]!;
    const q = v >= thr
      ? Math.round((Math.pow((v - thr) / (1 - thr), 1.4) * 26 + 0.3) * HEIGHT_SCALE)
      : -Math.round(((thr - v) / thr * 8 + 0.2) * HEIGHT_SCALE);
    h[i] = q;
    if (q > maxLand) maxLand = q;
  }

  // Priority-flood from the sea and the map edge: pop order gives a drainage tree toward water.
  const heap = new MinHeap();
  const filled = new Int32Array(TILES);
  const parent = new Int32Array(TILES).fill(-2);
  const order = new Int32Array(TILES);
  let count = 0;
  const key = (hq: number, i: number): number => (hq + 32768) * 65536 + i;
  for (let i = 0; i < TILES; i++) {
    const x = i % MAP, y = (i / MAP) | 0;
    if (h[i]! <= 0 || x === 0 || y === 0 || x === MAP - 1 || y === MAP - 1) {
      parent[i] = -1;
      filled[i] = h[i]!;
      heap.push(key(h[i]!, i));
    }
  }
  while (heap.n > 0) {
    const i = heap.pop() % 65536;
    order[count++] = i;
    const x = i % MAP, y = (i / MAP) | 0;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX[d]!, ny = y + DY[d]!;
      if (nx < 0 || ny < 0 || nx >= MAP || ny >= MAP) continue;
      const j = ny * MAP + nx;
      if (parent[j] !== -2) continue;
      parent[j] = i;
      filled[j] = Math.max(h[j]!, filled[i]!);
      heap.push(key(filled[j]!, j));
    }
  }
  const flow = new Uint32Array(TILES).fill(1);
  for (let k = count - 1; k >= 0; k--) {
    const i = order[k]!;
    const p = parent[i]!;
    if (p >= 0) flow[p]! += flow[i]!;
  }

  const t = world.terrain;
  for (let i = 0; i < TILES; i++) t[i] = h[i]! <= 0 ? TERRAIN.WATER : TERRAIN.GRASS;

  // No rivers: the threshold no tile's flow reaches, so nothing is carved.
  const rivers = preset.rivers !== false;
  let threshold = rivers ? 260 : Infinity;
  const riverCells = (th: number): number => {
    let c = 0;
    for (let i = 0; i < TILES; i++) if (h[i]! > 0 && parent[i]! >= 0 && flow[i]! >= th) c++;
    return c;
  };
  while (rivers && threshold > 4 && riverCells(threshold) < 12) threshold = Math.floor(threshold / 2);
  const carve = 1.5 * HEIGHT_SCALE;
  // Channels are 4-connected so the water reads as one ribbon: wherever the flow path steps diagonally, one orthogonal tile
  // joins the two ends. Width grows with flow accumulation (1, 2 or 3 tiles), then the banks are lowered on a gentle slope.
  const river = new Uint8Array(TILES);
  const mark = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= MAP || y >= MAP) return;
    if (h[y * MAP + x]! > 0) river[y * MAP + x] = 1;
  };
  for (let i = 0; i < TILES; i++) {
    if (h[i]! <= 0 || parent[i]! < 0 || flow[i]! < threshold) continue;
    const x = i % MAP, y = (i / MAP) | 0;
    const f = flow[i]!;
    river[i] = 1;
    const p = parent[i]!;
    const sx = (p % MAP) - x, sy = ((p / MAP) | 0) - y;
    if (sx !== 0 && sy !== 0) {
      const a = (y * MAP) + x + sx, b = (y + sy) * MAP + x;
      const wetA = h[a]! <= 0, wetB = h[b]! <= 0;
      if (!wetA && !wetB) {
        if (h[a]! <= h[b]!) mark(x + sx, y); else mark(x, y + sy);
      }
    }
    if (f >= threshold * 3) { mark(x + 1, y); mark(x, y + 1); }
    if (f >= threshold * 8) { mark(x - 1, y); mark(x, y - 1); }
  }
  // Two branches (or a river and a coast) can still meet at a corner; join those with the lower of the two orthogonal tiles.
  const isWetNow = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < MAP && y < MAP && (river[y * MAP + x] === 1 || h[y * MAP + x]! <= 0);
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (let y = 0; y < MAP - 1; y++) for (let x = 0; x < MAP - 1; x++) {
      for (let k = 0; k < 2; k++) {
        const ax = x + k, ay = y, bx = x + 1 - k, by = y + 1;
        if (!isWetNow(ax, ay) || !isWetNow(bx, by)) continue;
        const ix = x + 1 - k, iy = y;
        const jx = x + k, jy = y + 1;
        if (isWetNow(ix, iy) || isWetNow(jx, jy)) continue;
        if (river[ay * MAP + ax] === 0 && river[by * MAP + bx] === 0) continue;
        const ci = iy * MAP + ix, cj = jy * MAP + jx;
        if (h[ci]! <= h[cj]!) river[ci] = 1; else river[cj] = 1;
        changed = true;
      }
    }
    if (!changed) break;
  }
  const lower = new Float32Array(TILES);
  for (let y = 0; y < MAP; y++) for (let x = 0; x < MAP; x++) {
    if (!river[y * MAP + x]) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= MAP || ny >= MAP) continue;
      const dist = Math.hypot(dx, dy);
      if (dist < 1 || dist > 2.5) continue;
      const k = ny * MAP + nx;
      lower[k] = Math.max(lower[k]!, 0.36 * Math.max(0, 1 - (dist - 1) / 1.6));
    }
  }
  for (let i = 0; i < TILES; i++) {
    if (river[i]) {
      h[i] = h[i]! - carve;
      t[i] = TERRAIN.RIVER;
      world.waterDepth[i] = carve;
    } else if (lower[i]! > 0 && h[i]! > 0) {
      h[i] = Math.max(1, Math.round(h[i]! - carve * lower[i]!));
    }
  }
  for (let i = 0; i < TILES; i++) if (t[i] === TERRAIN.WATER) world.waterDepth[i] = Math.min(255, -h[i]!);

  const rockLevel = maxLand * 0.62;
  const wet = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= MAP || y >= MAP) return false;
    return t[y * MAP + x] === TERRAIN.WATER;
  };
  const sand: number[] = [];
  for (let y = 0; y < MAP; y++) for (let x = 0; x < MAP; x++) {
    const i = y * MAP + x;
    if (t[i] !== TERRAIN.GRASS) continue;
    let slope = 0;
    for (let d = 0; d < 8; d += 2) {
      const nx = x + DX[d]!, ny = y + DY[d]!;
      if (nx < 0 || ny < 0 || nx >= MAP || ny >= MAP) continue;
      slope = Math.max(slope, Math.abs(h[ny * MAP + nx]! - h[i]!));
    }
    if (h[i]! > rockLevel || slope > 3 * HEIGHT_SCALE * 0.5) { t[i] = TERRAIN.ROCK; continue; }
    if (h[i]! < 1.6 * HEIGHT_SCALE) {
      let near = false;
      for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2; dx++) if (wet(x + dx, y + dy)) { near = true; break; }
      if (near) sand.push(i);
    }
  }
  for (const i of sand) t[i] = TERRAIN.SAND;
  for (let y = 0; y < MAP; y++) for (let x = 0; x < MAP; x++) {
    const i = y * MAP + x;
    if (t[i] === TERRAIN.GRASS && fbm(seed ^ 0x51ed, x / 20, y / 20, 3) > 0.58) t[i] = TERRAIN.FOREST;
    else if (t[i] === TERRAIN.ROCK && fbm(seed ^ 0x0e1f, x / 14, y / 14, 3) > 0.6) t[i] = TERRAIN.ORE;
  }
}
