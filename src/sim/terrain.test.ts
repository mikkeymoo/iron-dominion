import { describe, expect, it } from 'vitest';
import { createSim } from './engine.ts';
import { hashWorld } from './hash.ts';
import { MAP, TERRAIN, TILES } from './layers.ts';
import { generateTerrain } from './terrain.ts';
import { allocWorld } from './world.ts';

const cache = new Map<number, ReturnType<typeof allocWorld>>();
const generated = (seed: number) => {
  let w = cache.get(seed);
  if (!w) { w = allocWorld(); generateTerrain(w, seed); cache.set(seed, w); }
  return w;
};

const terrainHash = (seed: number) => hashWorld(createSim(seed).world, (n) => n === 'height' || n === 'terrain' || n === 'waterDepth');

describe('terrain generation', () => {
  it('is deterministic per seed and differs between seeds', () => {
    expect(terrainHash(42)).toBe(terrainHash(42));
    expect(terrainHash(42)).not.toBe(terrainHash(43));
  });

  it('produces water, land, a river and sand', () => {
    const t = createSim(42).world.terrain;
    const counts = new Array<number>(8).fill(0);
    for (let i = 0; i < TILES; i++) counts[t[i]!]!++;
    expect(counts[TERRAIN.WATER]).toBeGreaterThan(TILES * 0.1);
    expect(counts[TERRAIN.GRASS]! + counts[TERRAIN.FOREST]!).toBeGreaterThan(TILES * 0.2);
    expect(counts[TERRAIN.RIVER]).toBeGreaterThan(0);
    expect(counts[TERRAIN.SAND]).toBeGreaterThan(0);
  });
});

const isWet = (v: number | undefined): boolean => v === TERRAIN.RIVER || v === TERRAIN.WATER;

const riverComponents = (t: Uint8Array): number[][] => {
  const seen = new Uint8Array(TILES);
  const comps: number[][] = [];
  for (let s = 0; s < TILES; s++) {
    if (t[s] !== TERRAIN.RIVER || seen[s]) continue;
    const comp: number[] = [], stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      const x = i % MAP, y = (i / MAP) | 0;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
        if (nx < 0 || ny < 0 || nx >= MAP || ny >= MAP) continue;
        const j = ny * MAP + nx;
        if (t[j] === TERRAIN.RIVER && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    comps.push(comp);
  }
  return comps;
};

describe('rivers', () => {
  it('are 4-connected channels that reach the sea, a lake or the map edge, for 50 seeds', () => {
    let rivers = 0;
    for (let seed = 1; seed <= 50; seed++) {
      const t = generated(seed).terrain;
      for (const comp of riverComponents(t)) {
        rivers++;
        let outlet = false;
        for (const i of comp) {
          const x = i % MAP, y = (i / MAP) | 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx <= 0 || ny <= 0 || nx >= MAP - 1 || ny >= MAP - 1 || t[ny * MAP + nx] === TERRAIN.WATER) outlet = true;
          }
        }
        expect(outlet, `seed ${seed}: a river of ${comp.length} tiles starting at ${comp[0]} has no outlet`).toBe(true);
      }
    }
    expect(rivers).toBeGreaterThan(0);
  }, 120000);

  it('never leaves two wet tiles that touch only at a corner', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const t = generated(seed).terrain;
      for (let y = 0; y < MAP - 1; y++) for (let x = 0; x < MAP - 1; x++) {
        const a = t[y * MAP + x], b = t[y * MAP + x + 1], c = t[(y + 1) * MAP + x], d = t[(y + 1) * MAP + x + 1];
        const river = a === TERRAIN.RIVER || b === TERRAIN.RIVER || c === TERRAIN.RIVER || d === TERRAIN.RIVER;
        if (river && isWet(a) && isWet(d) && !isWet(b) && !isWet(c)) throw new Error(`seed ${seed}: diagonal wet pair at ${x},${y}`);
        if (river && isWet(b) && isWet(c) && !isWet(a) && !isWet(d)) throw new Error(`seed ${seed}: diagonal wet pair at ${x + 1},${y}`);
      }
    }
  }, 120000);

  it('leave seed 42 buildable sites near the centre for the smoke site finder', () => {
    const w = generated(42);
    const buildable = (v: number): boolean => v === TERRAIN.SAND || v === TERRAIN.GRASS || v === TERRAIN.FOREST;
    const site = (size: number, spread: number, radius: number): boolean => {
      for (let y0 = 128 - radius; y0 <= 128 + radius - size; y0++) {
        for (let x0 = 128 - radius; x0 <= 128 + radius - size; x0++) {
          let lo = Infinity, hi = -Infinity, ok = true;
          for (let y = y0; y < y0 + size && ok; y++) {
            for (let x = x0; x < x0 + size; x++) {
              const i = y * MAP + x;
              if (!buildable(w.terrain[i]!) || w.waterDepth[i]! > 0) { ok = false; break; }
              lo = Math.min(lo, w.height[i]!); hi = Math.max(hi, w.height[i]!);
            }
          }
          if (ok && hi - lo <= spread) return true;
        }
      }
      return false;
    };
    expect(site(14, 32, 40), 'flat 14x14').toBe(true);
    expect(site(24, 10000, 60), 'dry 24x24').toBe(true);
  });
});
