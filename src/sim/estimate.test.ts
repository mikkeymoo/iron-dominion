import { describe, expect, it } from 'vitest';
import { RenderMirror } from '../render/mirror.ts';
import { ARCH, CATALOG, HEIGHT_MAX, HEIGHT_MIN, TERRAFORM_COST, TERRAFORM_STEP } from './catalog.ts';
import { execute, type Command, type CommandBody } from './commands.ts';
import { makeResync, simFromWorld } from './engine.ts';
import { estimate, roadPath, tileReadOf, type Estimate } from './estimate.ts';
import { MAP, REGISTRY, ROAD, S, TERRAIN, type World } from './layers.ts';
import { tileIdx } from './tiles.ts';
import { allocWorld, type Sim } from './world.ts';

// A hand-built map: rolling grass, a lake, a rock patch, a cliff, two roads and three buildings, so every kind of
// refusal is reachable. Estimates are compared with what the sim actually does to a fresh copy of it.

function baseWorld(): World {
  const w = allocWorld();
  w.terrain.fill(TERRAIN.GRASS);
  for (let y = 0; y < MAP; y++) for (let x = 0; x < MAP; x++) {
    const i = tileIdx(x, y);
    w.height[i] = 160 + Math.round(5 * Math.sin(x / 9) + 5 * Math.cos(y / 7)) + (x >= 70 && y >= 60 && y < 80 ? 40 : 0);
  }
  for (let y = 40; y < 52; y++) for (let x = 40; x < 52; x++) { w.terrain[tileIdx(x, y)] = TERRAIN.WATER; w.waterDepth[tileIdx(x, y)] = 16; }
  for (let y = 90; y < 98; y++) for (let x = 20; x < 28; x++) w.terrain[tileIdx(x, y)] = TERRAIN.ROCK;
  for (let x = 20; x < 90; x++) w.road[tileIdx(x, 30)] = 1 | ROAD.E | ROAD.W;
  for (let y = 20; y < 90; y++) w.road[tileIdx(30, y)] = 1 | ROAD.N | ROAD.S;
  const slots: [number, number, number][] = [[1, 60, 100], [4, 80, 40], [2, 100, 100]];
  slots.forEach(([arch, x, y], s) => {
    const a = CATALOG.find((c) => c.id === arch)!;
    w.bArch[s] = arch; w.bX[s] = x; w.bY[s] = y; w.bW[s] = a.w; w.bH[s] = a.h;
    for (let yy = y; yy < y + a.h; yy++) for (let xx = x; xx < x + a.w; xx++) w.bId[tileIdx(xx, yy)] = s + 1;
  });
  w.scalars[S.nextAgentId] = 1;
  return w;
}

const BASE = baseWorld();

const COPIED = REGISTRY.filter((l) => !l.name.startsWith('j'));

/** Put `sim` back to the base map (the journal arrays are left alone: nothing here reads them). */
function reset(sim: Sim, treasury: number): Sim {
  const w = sim.world;
  for (const l of COPIED) (w[l.name] as unknown as { set(a: ArrayLike<number>): void }).set(BASE[l.name] as ArrayLike<number>);
  w.scalars[S.treasury] = treasury;
  sim.events = [];
  sim.dirty.geometry.clear(); sim.dirty.buildings.clear(); sim.dirty.overlay.clear();
  return sim;
}

const SHARED = simFromWorld(allocWorld());
function fresh(treasury = 1_000_000): Sim {
  return reset(SHARED, treasury);
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Node's Buffer.compare is a fast byte-wise comparison; the project has no @types/node.
declare const Buffer: { compare(a: Uint8Array, b: Uint8Array): number };

const LAYERS = ['terrain', 'height', 'waterDepth', 'road', 'zone', 'bId'] as const;
type Snap = Record<(typeof LAYERS)[number], ArrayLike<number>>;
const snap = (w: World): Snap => Object.fromEntries(LAYERS.map((n) => [n, (w[n] as Uint16Array).slice()])) as unknown as Snap;
const bytes = (a: ArrayLike<number>): Uint8Array => { const t = a as unknown as Uint8Array; return new Uint8Array(t.buffer, t.byteOffset, t.byteLength); };
const unchanged = (a: Snap, b: Snap): boolean => LAYERS.every((n) => Buffer.compare(bytes(a[n]), bytes(b[n])) === 0);

function run(sim: Sim, body: CommandBody): { ok: boolean; reason?: string; treasury: number } {
  sim.events = [];
  const ok = execute(sim, { ...body, id: 1, tick: 0 } as Command);
  const e = sim.events[0]!;
  return { ok, reason: e.type === 'rejected' ? e.reason : undefined, treasury: sim.world.scalars[S.treasury]! };
}

function randomBody(rnd: () => number): CommandBody {
  const n = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
  const x0 = n(14, 110), y0 = n(14, 110), x1 = Math.min(MAP - 1, x0 + n(-6, 12)), y1 = Math.min(MAP - 1, y0 + n(-6, 12));
  switch (n(0, 4)) {
    case 0: return { type: 'placeRoad', ax: x0, ay: y0, bx: x1, by: y1, cls: n(1, 3) };
    case 1: return { type: 'zone', x0, y0, x1, y1, zone: n(1, 3), density: n(0, 2) };
    case 2: return { type: 'bulldoze', x0, y0, x1, y1 };
    case 3: return { type: 'placeBuilding', arch: [ARCH.DEPOT, ARCH.POWER_PLANT, ARCH.WATER_PUMP, ARCH.FIRE_STATION][n(0, 3)]!, x: x0, y: y0, rot: n(0, 3) };
    default: return { type: 'terraform', mode: (['raise', 'lower', 'level'] as const)[n(0, 2)]!, x0, y0, x1: Math.min(x1, x0 + 5), y1: Math.min(y1, y0 + 5) };
  }
}

describe('estimate matches the sim', () => {
  it('agrees on reason, cost and tiles over seeded random commands of every kind', () => {
    const rnd = mulberry(20260101);
    const seen = new Map<string, { ok: number; bad: number }>();
    const reasons = new Set<string>();
    for (let trial = 0; trial < 900; trial++) {
      const body = randomBody(rnd);
      const treasury = trial % 7 === 0 ? 40 : 1_000_000;
      const sim = fresh(treasury);
      const before = snap(sim.world);
      const est = estimate(sim.world, body, treasury);
      expect(unchanged(snap(sim.world), before), 'estimate must not mutate').toBe(true);
      const got = run(sim, body);
      const label = JSON.stringify(body);

      expect(got.ok, label).toBe(!est.reason);
      if (est.reason) {
        expect(got.reason, label).toBe(est.reason);
        expect(unchanged(snap(sim.world), before), `${label} rejected but changed layers`).toBe(true);
        expect(got.treasury).toBe(treasury);
        reasons.add(est.reason);
      } else {
        expect(treasury - got.treasury, label).toBe(est.cost);
        const after = snap(sim.world);
        const changed = (name: (typeof LAYERS)[number]): number[] => {
          const out: number[] = [];
          for (let i = 0; i < after[name].length; i++) if (after[name][i] !== before[name][i]) out.push(i);
          return out;
        };
        const valid = new Set(est.validTiles);
        switch (body.type) {
          case 'zone': expect(new Set(changed('zone')), label).toEqual(valid); break;
          case 'placeBuilding': expect(new Set(changed('bId')), label).toEqual(valid); break;
          case 'terraform':
            expect(new Set(changed('height')), label).toEqual(valid);
            est.validTiles.forEach((i, k) => expect(after.height[i], label).toBe(est.heights![k]));
            break;
          case 'placeRoad':
            for (const i of est.validTiles) expect(after.road[i]! & ROAD.CLASS_MASK, label).toBeGreaterThanOrEqual(body.cls);
            for (const i of changed('road')) {
              if ((after.road[i]! & ROAD.CLASS_MASK) !== (before.road[i]! & ROAD.CLASS_MASK)) expect(valid.has(i), `${label} tile ${i}`).toBe(true);
            }
            expect(est.validTiles).toEqual(roadPath(body));
            break;
          case 'bulldoze':
            for (const i of est.validTiles) expect(after.road[i] === 0 && after.zone[i] === 0 && after.bId[i] === 0, label).toBe(true);
            break;
        }
      }
      const s = seen.get(body.type) ?? { ok: 0, bad: 0 };
      if (est.reason) s.bad++; else s.ok++;
      seen.set(body.type, s);
    }
    for (const t of ['placeRoad', 'zone', 'bulldoze', 'placeBuilding', 'terraform']) {
      const s = seen.get(t)!;
      expect(s.ok, `${t} accepted at least 20 times`).toBeGreaterThanOrEqual(20);
      expect(s.bad, `${t} refused at least 20 times`).toBeGreaterThanOrEqual(20);
    }
    for (const r of ['blocked', 'terrain', 'funds', 'noop', 'slope']) expect([...reasons], `reason ${r} exercised`).toContain(r);
  }, 60000);

  it('gives the same answer from the render mirror as from the world', () => {
    const sim = fresh();
    const mirror = new RenderMirror();
    mirror.apply(makeResync(sim.world));
    const rnd = mulberry(7);
    for (let i = 0; i < 300; i++) {
      const body = randomBody(rnd);
      const a: Estimate = estimate(sim.world, body, 5000);
      const b: Estimate = estimate(tileReadOf(mirror.layers), body, 5000);
      expect(b, JSON.stringify(body)).toEqual(a);
    }
  });
});

describe('terraform', () => {
  const at = (sim: Sim, x: number, y: number): number => sim.world.height[tileIdx(x, y)]!;

  it('raises and lowers every tile one step and charges per tile per step', () => {
    const sim = fresh();
    const h0 = at(sim, 120, 120);
    const up = run(sim, { type: 'terraform', mode: 'raise', x0: 120, y0: 120, x1: 122, y1: 121 });
    expect(up.ok).toBe(true);
    expect(at(sim, 120, 120)).toBe(h0 + TERRAFORM_STEP);
    expect(1_000_000 - up.treasury).toBe(6 * TERRAFORM_COST);
    const down = run(sim, { type: 'terraform', mode: 'lower', x0: 120, y0: 120, x1: 122, y1: 121 });
    expect(down.ok).toBe(true);
    expect(at(sim, 120, 120)).toBe(h0);
  });

  it('levels the rect to the height of the tile the drag began on, not the average', () => {
    const sim = fresh();
    const target = at(sim, 120, 130);
    const est = estimate(sim.world, { type: 'terraform', mode: 'level', x0: 120, y0: 130, x1: 123, y1: 133 });
    expect(est.reason).toBeUndefined();
    expect(run(sim, { type: 'terraform', mode: 'level', x0: 120, y0: 130, x1: 123, y1: 133 }).ok).toBe(true);
    for (let y = 130; y <= 133; y++) for (let x = 120; x <= 123; x++) expect(at(sim, x, y)).toBe(target);
    const steps = est.validTiles.length;
    expect(steps).toBeGreaterThan(0);
    const again = run(sim, { type: 'terraform', mode: 'level', x0: 120, y0: 130, x1: 123, y1: 133 });
    expect(again.reason).toBe('noop');
  });

  it('is refused under buildings and roads, and on water, changing nothing', () => {
    const cases: [number, number, number, number, string][] = [[60, 100, 61, 101, 'blocked'], [29, 50, 31, 50, 'blocked'], [44, 44, 46, 46, 'terrain']];
    for (const [x0, y0, x1, y1, reason] of cases) {
      const sim = fresh();
      const before = snap(sim.world);
      const r = run(sim, { type: 'terraform', mode: 'raise', x0, y0, x1, y1 });
      expect(r.reason).toBe(reason);
      expect(unchanged(snap(sim.world), before)).toBe(true);
    }
  });

  it('refuses a result steeper than the slope limit, but allows a change that does not worsen an existing cliff', () => {
    const sim = fresh();
    // The cliff between x=69 and x=70 is 40 units. Raising the high side makes it worse, lowering it makes it better.
    expect(run(sim, { type: 'terraform', mode: 'raise', x0: 70, y0: 65, x1: 71, y1: 66 }).reason).toBe('slope');
    expect(run(sim, { type: 'terraform', mode: 'lower', x0: 70, y0: 65, x1: 71, y1: 66 }).ok).toBe(true);

    // On flat ground, repeated raises of one tile stop once it stands more than the limit above its neighbours.
    const flat = fresh();
    let n = 0;
    while (run(flat, { type: 'terraform', mode: 'raise', x0: 150, y0: 150, x1: 150, y1: 150 }).ok) { n++; if (n > 50) break; }
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(10);
    expect(estimate(flat.world, { type: 'terraform', mode: 'raise', x0: 150, y0: 150, x1: 150, y1: 150 }).reason).toBe('slope');
  });

  it('keeps land inside the height range', () => {
    const sim = fresh();
    const i = tileIdx(150, 150);
    sim.world.height[i] = HEIGHT_MIN + 1;
    expect(estimate(sim.world, { type: 'terraform', mode: 'lower', x0: 150, y0: 150, x1: 150, y1: 150 }).reason).toBe('limit');
    sim.world.height[i] = HEIGHT_MAX;
    expect(estimate(sim.world, { type: 'terraform', mode: 'raise', x0: 150, y0: 150, x1: 150, y1: 150 }).reason).toBe('limit');
  });

  it('marks the chunks, nearby buildings and road slope flags dirty', () => {
    const sim = fresh();
    sim.dirty.geometry.clear(); sim.dirty.buildings.clear();
    // The depot (slot 0) is at (60,100); a road tile at (30,90) is next to the rect below.
    expect(run(sim, { type: 'terraform', mode: 'raise', x0: 62, y0: 100, x1: 63, y1: 101 }).ok).toBe(true);
    expect(sim.dirty.geometry.has((100 >> 4) * 16 + (62 >> 4))).toBe(true);
    expect(sim.dirty.buildings.has(0)).toBe(true);

    const roadSim = fresh();
    const rx = 150, ry = 150, ri = tileIdx(rx, ry);
    roadSim.world.road[ri] = 1 | ROAD.SLOPE;
    run(roadSim, { type: 'terraform', mode: 'raise', x0: rx + 1, y0: ry, x1: rx + 1, y1: ry });
    expect(roadSim.world.road[ri]! & ROAD.SLOPE, 'stale slope flag recomputed from the new heights').toBe(0);
    expect(roadSim.dirty.geometry.has((ry >> 4) * 16 + (rx >> 4))).toBe(true);
  });

  it('is not undoable and does not journal', () => {
    const sim = fresh();
    sim.events = [];
    execute(sim, { type: 'terraform', mode: 'raise', x0: 120, y0: 120, x1: 120, y1: 120, id: 5, tick: 0 });
    const ev = sim.events[0]!;
    expect(ev.type).toBe('accepted');
    expect(ev.type === 'accepted' && ev.journal).toBeFalsy();
  });
});
