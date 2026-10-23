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

export function generateTerrain(world: World, seed: number): void {
  const n = new Float32Array(TILES);
  const hist = new Uint32Array(1024);
  for (let y = 0; y < MAP; y++) for (let x = 0; x < MAP; x++) {
    const v = fbm(seed, x / 56, y / 56, 5);
    n[y * MAP + x] = v;
    hist[Math.min(1023, Math.floor(v * 1024))]!++;
  }
  // Sea level: the noise value below which ~28% of tiles fall.
  let acc = 0, bin = 0;
  while (bin < 1023 && acc + hist[bin]! < TILES * 0.28) acc += hist[bin++]!;
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

  let threshold = 260;
  const riverCells = (th: number): number => {
    let c = 0;
    for (let i = 0; i < TILES; i++) if (h[i]! > 0 && parent[i]! >= 0 && flow[i]! >= th) c++;
    return c;
  };
  while (threshold > 4 && riverCells(threshold) < 12) threshold = Math.floor(threshold / 2);
  const carve = 1.5 * HEIGHT_SCALE;
  for (let i = 0; i < TILES; i++) {
    if (h[i]! > 0 && parent[i]! >= 0 && flow[i]! >= threshold) {
      h[i] = h[i]! - carve;
      t[i] = TERRAIN.RIVER;
      world.waterDepth[i] = carve;
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
