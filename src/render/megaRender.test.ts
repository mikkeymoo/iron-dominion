import { describe, expect, it } from 'vitest';
import { ARCH, BFLAG, CATALOG } from '../sim/catalog.ts';
import { MEGA_ARCHS, megaStages } from '../sim/megaprojects.ts';
import type { BuildingRec, ChunkPatch } from '../sim/protocol.ts';
import { CHUNKS } from '../sim/layers.ts';
import { celebrate, type CelebrateDeps } from './celebrate.ts';
import { CinematicPlayer, MEGA_CINEMATIC_SECONDS, megaOrbit, type MegaTarget } from './cinematic.ts';
import { CameraRig, type RigState } from './camera.ts';
import { BuildingInstances, MEGA_CRANES, extraCrane, type FineSet } from './instances.ts';
import { STATE_STRIDE } from './instancePacker.ts';
import { FINISH, FOUNDATION_END, builtFraction } from './kit/construction.ts';
import { generate, mergeParts, triangleCap } from './kit/generate.ts';
import { PULSE_WID, SLOT } from './kit/geo.ts';
import { TETHER_TOP } from './kit/mega.ts';
import { RECIPES } from './kit/recipes.ts';
import { RenderMirror, type CelebrationEvent } from './mirror.ts';

describe('megaproject models', () => {
  it('has a recipe, a footprint of 5 to 7 tiles, and a stage model for every stage plus the finished one', () => {
    expect(MEGA_ARCHS).toHaveLength(4);
    for (const arch of MEGA_ARCHS) {
      const a = CATALOG.find((c) => c.id === arch)!;
      expect(RECIPES[arch], a.name).toBeTypeOf('function');
      expect(a.w).toBeGreaterThanOrEqual(5);
      expect(a.w).toBeLessThanOrEqual(7);
      expect(a.h).toBe(a.w);
      const n = megaStages(arch);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(5);
      for (let v = 0; v <= n; v++) expect(() => generate(arch, v), `${a.name} model ${v}`).not.toThrow();
    }
  });

  it('grows stage by stage: every stage model differs from the last, never shrinks the structure, and the finished model keeps it', () => {
    for (const arch of MEGA_ARCHS) {
      const n = megaStages(arch), models = Array.from({ length: n + 1 }, (_, v) => generate(arch, v));
      for (let k = 1; k < n; k++) {
        expect(models[k]!.triangles, `${arch} stage ${k} differs from stage ${k - 1}`).not.toBe(models[k - 1]!.triangles);
        expect(models[k]!.height, `${arch} stage ${k} reaches at least the last`).toBeGreaterThanOrEqual(models[k - 1]!.height - 1e-6);
      }
      expect(models[n]!.height).toBeGreaterThanOrEqual(models[n - 1]!.height * 0.9);
      expect(generate(arch, n + 3).triangles).toBe(models[n]!.triangles);
    }
  });

  it('stays under its triangle cap and the Uint16 index range in every model', () => {
    for (const arch of MEGA_ARCHS) {
      for (let v = 0; v <= megaStages(arch); v++) {
        const m = generate(arch, v);
        expect(m.triangles, `${arch} model ${v}`).toBeLessThanOrEqual(triangleCap(arch));
        expect(mergeParts(m.parts).positions.length / 3).toBeLessThan(65536);
      }
    }
  });

  it('puts a pulsing accent (plasma, beacons, scoreboard) in every finished model and none in plain buildings', () => {
    for (const arch of MEGA_ARCHS) {
      const done = generate(arch, megaStages(arch));
      expect(done.parts[SLOT.ACCENT]!.wid.some((w) => w >= PULSE_WID), `megaproject ${arch}`).toBe(true);
    }
    expect(generate(ARCH.FUSION_REACTOR, 0).parts[SLOT.ACCENT]!.wid.some((w) => w >= PULSE_WID)).toBe(false);
    expect(generate(ARCH.DEPOT, 0).parts[SLOT.ACCENT]!.wid.every((w) => w < PULSE_WID)).toBe(true);
  });

  it('builds the Space Elevator tether up into the sky, only once its tether stage is under way', () => {
    const n = megaStages(ARCH.SPACE_ELEVATOR);
    expect(generate(ARCH.SPACE_ELEVATOR, 2).height).toBeLessThan(10);
    expect(generate(ARCH.SPACE_ELEVATOR, 3).height).toBeGreaterThanOrEqual(TETHER_TOP);
    expect(generate(ARCH.SPACE_ELEVATOR, n).height).toBeGreaterThan(TETHER_TOP);
  });

  it('wraps the structure in scaffold while a stage is under construction and removes it when finished', () => {
    const n = megaStages(ARCH.FUSION_SPIRE);
    expect(generate(ARCH.FUSION_SPIRE, n - 1).parts[SLOT.METAL]!.indices.length).toBeGreaterThan(generate(ARCH.FUSION_SPIRE, n).parts[SLOT.METAL]!.indices.length);
  });
});

const ALL = new Set(Array.from({ length: CHUNKS * CHUNKS }, (_, i) => i));
const rec = (slot: number, arch: number, x: number, y: number, w: number, extra: Partial<BuildingRec> = {}): BuildingRec =>
  ({ slot, arch, x, y, w, h: w, rot: 0, level: 0, prog: 0, flags: 0, dmg: 0, ...extra });

function setup(fine: Set<number> = ALL) {
  const mirror = new RenderMirror();
  const set: FineSet = { has: (c) => fine.has(c), version: () => 1 };
  const d = new BuildingInstances({ mirror, fine: set, ground: () => 1, variants: () => 2 });
  const put = (r: BuildingRec): void => { mirror.apply({ type: 'chunkPatch', tick: 1, chunks: [], layers: {}, buildings: [r] } satisfies ChunkPatch); d.sync(); };
  return { d, put };
}

describe('megaproject instances', () => {
  it('draws the model of the stage under construction, clipping this stage\'s geometry from the previous top to its own as progress rises', () => {
    const { d, put } = setup();
    const arch = ARCH.ARCOLOGY, stage = 2;
    const base = generate(arch, stage - 1).height, top = generate(arch, stage).height;
    for (const prog of [0, 64, 128, 255]) {
      put(rec(3, arch, 100, 100, 7, { flags: BFLAG.CONSTRUCTING, level: stage, prog }));
      expect(d.near.keyOf(3)).toBe(`${arch}:${stage}`);
      const s = d.near.batches.get(d.near.keyOf(3)!)!.state, i = d.near.indexOf(3) * STATE_STRIDE;
      const clip = builtFraction(s[i]!) * s[i + 2]!;
      expect(s[i + 2]).toBeCloseTo(top, 4);
      // The reveal never quite reaches the top until the stage completes and the finished model replaces it.
      const f = Math.min(0.999, (base + (top - base) * Math.min(0.999, prog / 255)) / top);
      expect(clip).toBeCloseTo(f * top, 3);
      expect(clip).toBeGreaterThanOrEqual(base - 1e-3);
      expect(s[i]!).toBeGreaterThanOrEqual(FOUNDATION_END);
      expect(s[i]!).toBeLessThan(FINISH);
    }
  });

  it('switches to the finished model with no clip once every stage is done', () => {
    const { d, put } = setup();
    const arch = ARCH.MECH_ARENA;
    put(rec(4, arch, 100, 100, 6, { flags: BFLAG.CONSTRUCTING, level: 2, prog: 200 }));
    put(rec(4, arch, 100, 100, 6, { level: megaStages(arch), prog: 255 }));
    expect(d.near.keyOf(4)).toBe(`${arch}:${megaStages(arch)}`);
    const s = d.near.batches.get(d.near.keyOf(4)!)!.state;
    expect(s[d.near.indexOf(4) * STATE_STRIDE]).toBe(1);
    expect(d.site.has(4)).toBe(false);
  });

  it('shows a foundation site, the standard crane and extra cranes while building, and none when done', () => {
    const { d, put } = setup();
    const arch = ARCH.FUSION_SPIRE;
    put(rec(5, arch, 100, 100, 5, { flags: BFLAG.CONSTRUCTING, level: 0, prog: 0 }));
    expect(d.site.has(5)).toBe(true);
    expect(d.crane.has(5)).toBe(true);
    for (let i = 0; i < MEGA_CRANES; i++) expect(d.crane.has(extraCrane(5, i)), `extra crane ${i}`).toBe(true);
    put(rec(5, arch, 100, 100, 5, { level: megaStages(arch), prog: 255 }));
    expect(d.site.has(5)).toBe(false);
    expect(d.crane.total).toBe(0);
    put(rec(5, 0, 0, 0, 0));
    expect(d.near.total).toBe(0);
  });

  it('always draws a megaproject as its full model, even in a chunk outside the fine set', () => {
    const { d, put } = setup(new Set());
    put(rec(6, ARCH.SPACE_ELEVATOR, 100, 100, 6, { level: 5, prog: 255 }));
    expect(d.stats.near).toBe(1);
    expect(d.stats.far).toBe(0);
  });

  it('keeps a lit icon from floating at the top of the tether', () => {
    const { d, put } = setup();
    put(rec(7, ARCH.SPACE_ELEVATOR, 100, 100, 6, { level: 5, prog: 255, flags: BFLAG.UNPOWERED }));
    expect(d.outages.get(7)!.y).toBeLessThan(10);
  });
});

const angleBetween = (a: number, b: number): number => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

describe('cinematic', () => {
  const rig = (): RigState => ({ x: 40, z: 60, yaw: 0.6, pitch: 0.7, dist: 90, ty: 3 });
  const target: MegaTarget = { x: 120, z: 130, ground: 2, height: 6, size: 5 };

  it('runs for six seconds and ends exactly where the camera started', () => {
    const from = rig(), p = megaOrbit(from, target);
    expect(MEGA_CINEMATIC_SECONDS).toBe(6);
    expect(p.duration).toBeCloseTo(6, 6);
    expect(p.at(0)).toEqual(from);
    const end = p.at(p.duration);
    expect(end.x).toBeCloseTo(from.x, 6);
    expect(end.z).toBeCloseTo(from.z, 6);
    expect(end.dist).toBeCloseTo(from.dist, 6);
    expect(end.ty).toBeCloseTo(from.ty, 6);
    expect(angleBetween(end.yaw, from.yaw)).toBeLessThan(1e-6);
  });

  it('orbits the project: on the target mid-move, closer than the start, a lap of yaw, continuous at the swing in', () => {
    const from = rig(), p = megaOrbit(from, target);
    const mid = p.at(p.duration * 0.5);
    expect(mid.x).toBe(target.x);
    expect(mid.z).toBe(target.z);
    expect(mid.dist).toBeLessThan(from.dist);
    const swing = p.duration * 0.18;
    const a = p.at(swing - 1e-4), b = p.at(swing + 1e-4);
    expect(Math.abs(a.yaw - b.yaw)).toBeLessThan(0.01);
    expect(Math.abs(a.dist - b.dist)).toBeLessThan(0.5);
    const yaws = [0.2, 0.4, 0.6, 0.8].map((t) => p.at(p.duration * t).yaw);
    expect(Math.abs(yaws[3]! - yaws[0]!)).toBeGreaterThan(Math.PI);
  });

  it('plays through the shared player and skipping reports an interrupted move', () => {
    const player = new CinematicPlayer();
    const ends: boolean[] = [];
    player.play(megaOrbit(rig(), target), (completed) => ends.push(completed));
    player.step(1.5);
    expect(player.active).toBe(true);
    player.skip();
    expect(ends).toEqual([false]);
    expect(player.active).toBe(false);
    expect(player.step(0.1)).toBeNull();
    player.play(megaOrbit(rig(), target), (completed) => ends.push(completed));
    player.step(10);
    expect(ends).toEqual([false, true]);
  });

  it('drives a real camera rig through its script hook and leaves its state valid', () => {
    const r = new CameraRig(() => 2), player = new CinematicPlayer();
    r.reset(40, 60, 0.6, 0.7, 90);
    const before = { ...r.state };
    player.play(megaOrbit(r.state, target));
    r.script((dt) => player.step(dt));
    for (let i = 0; i < 20; i++) r.step(0.1);
    expect(r.state.dist).toBeLessThan(before.dist);
    player.skip();
    r.script(null);
    expect(Number.isFinite(r.state.dist)).toBe(true);
  });
});

describe('celebrations', () => {
  interface Emit { kind: string; x: number; y: number; z: number; count: number }
  function deps(): { d: CelebrateDeps; emits: Emit[]; cine: MegaTarget[] } {
    const emits: Emit[] = [], cine: MegaTarget[] = [];
    return {
      emits, cine,
      d: {
        emit: (kind, x, y, z, count) => { emits.push({ kind, x, y, z, count }); },
        ground: () => 2,
        focus: () => ({ x: 128, z: 128, dist: 60 }),
        finishedHeight: () => 6,
        startCinematic: (t) => { cine.push(t); },
      },
    };
  }
  const ev = (e: Partial<CelebrationEvent> & { type: CelebrationEvent['type'] }): CelebrationEvent => ({ tick: 1, ...e }) as CelebrationEvent;

  it('throws confetti for a milestone and starts no camera move', () => {
    const { d, emits, cine } = deps();
    celebrate([ev({ type: 'milestone', tier: 2, bonus: 5000 } as never)], d);
    expect(emits.length).toBeGreaterThan(0);
    expect(emits.every((e) => e.kind === 'confetti')).toBe(true);
    expect(emits.reduce((n, e) => n + e.count, 0)).toBeGreaterThanOrEqual(100);
    expect(cine).toEqual([]);
  });

  it('bursts sparks round a finished stage, with no camera move', () => {
    const { d, emits, cine } = deps();
    celebrate([ev({ type: 'megaStage', arch: ARCH.ARCOLOGY, slot: 1, stage: 0, stages: 4, x: 100, y: 100, w: 7, h: 7 } as never)], d);
    expect(emits.some((e) => e.kind === 'spark')).toBe(true);
    expect(cine).toEqual([]);
  });

  it('starts the orbit around the footprint centre on completion, with a bigger burst than a stage', () => {
    const stage = deps(), done = deps();
    celebrate([ev({ type: 'megaStage', arch: ARCH.MECH_ARENA, slot: 1, stage: 0, stages: 3, x: 100, y: 100, w: 6, h: 6 } as never)], stage.d);
    celebrate([ev({ type: 'megaComplete', arch: ARCH.MECH_ARENA, slot: 1, x: 100, y: 100, w: 6, h: 6 } as never)], done.d);
    expect(done.cine).toEqual([{ x: 103, z: 103, ground: 2, height: 6, size: 6 }]);
    const total = (l: Emit[]): number => l.reduce((n, e) => n + e.count, 0);
    expect(total(done.emits)).toBeGreaterThan(total(stage.emits) * 2);
    expect(done.emits.some((e) => e.kind === 'confetti')).toBe(true);
  });

  it('queues the sim\'s milestone and megaproject events in the mirror for the renderer, once each', () => {
    const m = new RenderMirror();
    m.apply({ type: 'events', tick: 5, events: [{ type: 'milestone', tick: 5, tier: 1, bonus: 2000 }, { type: 'lightning', tick: 5, x: 1, y: 1 }, { type: 'victory', tick: 5 }] });
    expect(m.takeCelebrations().map((e) => e.type)).toEqual(['milestone', 'victory']);
    expect(m.takeCelebrations()).toEqual([]);
    expect(m.takeLightning()).toHaveLength(1);
  });
});
