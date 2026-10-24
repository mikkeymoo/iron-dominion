import { describe, expect, it, vi } from 'vitest';
import { CameraRig, poseOf, type RigState } from './camera.ts';
import {
  CinematicPlayer, EASINGS, dolly, ease, flyTo, orbit, pathEnd, pickTourStops, planTour, sequence, spline, type EasingName, type Path,
} from './cinematic.ts';

const NAMES = Object.keys(EASINGS) as EasingName[];
const A: RigState = { x: 40, z: 60, yaw: 0.5, pitch: 0.6, dist: 80, ty: 2 };
const B: RigState = { x: 120, z: 30, yaw: 2.2, pitch: 0.9, dist: 20, ty: 9 };

const sample = (p: Path, n = 400): RigState[] => Array.from({ length: n + 1 }, (_, i) => p.at((p.duration * i) / n));
const angle = (d: number): number => Math.abs(Math.atan2(Math.sin(d), Math.cos(d)));
/** Largest jump between neighbouring samples, in tiles, radians (as an angle, so 2 pi apart is the same view) and log-distance. */
const maxStep = (s: RigState[]): number => {
  let m = 0;
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1]!, b = s[i]!;
    m = Math.max(m, Math.hypot(b.x - a.x, b.z - a.z), Math.abs(b.ty - a.ty), angle(b.yaw - a.yaw),Math.abs(b.pitch - a.pitch), Math.abs(Math.log(b.dist / a.dist)));
  }
  return m;
};

describe('easing', () => {
  it.each(NAMES)('%s maps 0 to 0 and 1 to 1 exactly and never leaves 0..1', (name) => {
    expect(ease(name, 0)).toBe(0);
    expect(ease(name, 1)).toBe(1);
    for (let i = 0; i <= 100; i++) { const v = ease(name, i / 100); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
  });
  it.each(NAMES)('%s is monotonic', (name) => {
    let prev = 0;
    for (let i = 1; i <= 200; i++) { const v = ease(name, i / 200); expect(v).toBeGreaterThanOrEqual(prev - 1e-12); prev = v; }
  });
  it('clamps out-of-range and non-finite input', () => {
    expect(ease('inOut', -3)).toBe(0);
    expect(ease('inOut', 9)).toBe(1);
    expect(ease('inOut', NaN)).toBe(0);
  });
  it('inOut eases at both ends: the first and last 10% cover well under 10% of the distance', () => {
    expect(ease('inOut', 0.1)).toBeLessThan(0.05);
    expect(1 - ease('inOut', 0.9)).toBeLessThan(0.05);
    expect(ease('inOut', 0.5)).toBeCloseTo(0.5, 10);
  });
});

describe('orbit', () => {
  const target = { x: 100, z: 90, ty: 12 };
  const flat = (): number => -1000;

  it('keeps the camera exactly `radius` from the target at every instant', () => {
    const p = orbit(target, 35, 8, { pitch: 0.5, turns: 1, easing: 'inOut' });
    for (const s of sample(p, 80)) {
      const pose = poseOf(s, flat);
      expect(Math.hypot(pose.px - target.x, pose.py - target.ty, pose.pz - target.z)).toBeCloseTo(35, 9);
      expect(pose.tx).toBe(target.x); expect(pose.tz).toBe(target.z); expect(pose.ty).toBe(target.ty);
    }
  });
  it('one turn returns to the starting yaw and a negative turn runs the other way', () => {
    const p = orbit(target, 30, 6, { startYaw: 0.7, turns: 1 });
    expect(p.at(0).yaw).toBeCloseTo(0.7, 12);
    expect(p.at(6).yaw).toBeCloseTo(0.7 + Math.PI * 2, 12);
    expect(orbit(target, 30, 6, { turns: -0.5 }).at(6).yaw).toBeCloseTo(-Math.PI, 12);
  });
  it('is continuous and clamps t outside 0..duration', () => {
    const p = orbit(target, 30, 6, { easing: 'inOut' });
    expect(maxStep(sample(p))).toBeLessThan(0.05);
    expect(p.at(-5)).toEqual(p.at(0));
    expect(p.at(99)).toEqual(p.at(6));
  });
  it('a zero-length orbit is a still shot at its end', () => {
    expect(orbit(target, 30, 0, { turns: 1 }).at(0).yaw).toBeCloseTo(Math.PI * 2, 12);
  });
  it('writes into the out parameter without allocating', () => {
    const out = { x: 0, z: 0, yaw: 0, pitch: 0, dist: 0, ty: 0 };
    expect(orbit(target, 30, 6).at(1, out)).toBe(out);
    expect(out.dist).toBe(30);
  });
});

describe('flyTo and dolly', () => {
  it('starts exactly at the first pose and ends exactly at the second', () => {
    const p = flyTo(A, B, 4);
    expect(p.at(0)).toEqual(A);
    expect(p.at(4)).toEqual(B);
  });
  it('is continuous', () => {
    expect(maxStep(sample(flyTo(A, B, 4)))).toBeLessThan(0.6);
    expect(maxStep(sample(flyTo(A, B, 4, { easing: 'inOutQuint', lift: 0.5 })))).toBeLessThan(1.2);
  });
  it('turns the short way round: 3.0 to -3.0 rad crosses pi, not zero', () => {
    const p = flyTo({ ...A, yaw: 3.0 }, { ...A, yaw: -3.0 }, 2, { easing: 'linear' });
    const mid = p.at(1).yaw;
    expect(Math.abs(Math.abs(mid) - Math.PI)).toBeLessThan(0.2);
    expect(maxStep(sample(p))).toBeLessThan(0.05);
  });
  it('changes distance geometrically and lifts only mid-flight', () => {
    const noLift = flyTo(A, B, 4, { easing: 'linear', lift: 0 });
    expect(noLift.at(2).dist).toBeCloseTo(Math.sqrt(A.dist * B.dist), 9);
    const lifted = flyTo(A, B, 4, { easing: 'linear', lift: 0.5 });
    expect(lifted.at(0).dist).toBeCloseTo(A.dist, 9);
    expect(lifted.at(4).dist).toBeCloseTo(B.dist, 9);
    expect(lifted.at(2).dist).toBeGreaterThan(noLift.at(2).dist);
  });
  it('dolly changes only the distance', () => {
    const p = dolly(A, 25, 3, { easing: 'linear' });
    expect(p.at(0)).toEqual(A);
    expect(p.at(3)).toEqual({ ...A, dist: 25 });
    const mid = p.at(1.5);
    expect(mid.x).toBe(A.x); expect(mid.yaw).toBe(A.yaw);
    expect(mid.dist).toBeLessThan(A.dist); expect(mid.dist).toBeGreaterThan(25);
  });
});

describe('spline', () => {
  const keys: RigState[] = [A, { x: 90, z: 100, yaw: 1.4, pitch: 0.5, dist: 40, ty: 6 }, { x: 160, z: 70, yaw: 2.6, pitch: 0.7, dist: 60, ty: 3 }, B];
  it('hits every key at its time with linear easing, and the endpoints with any easing', () => {
    const p = spline(keys, 9, { easing: 'linear' });
    keys.forEach((k, i) => {
      const s = p.at((9 * i) / (keys.length - 1));
      expect(s.x).toBeCloseTo(k.x, 6); expect(s.z).toBeCloseTo(k.z, 6); expect(s.yaw).toBeCloseTo(k.yaw, 6);
      expect(s.pitch).toBeCloseTo(k.pitch, 6); expect(s.dist).toBeCloseTo(k.dist, 6); expect(s.ty).toBeCloseTo(k.ty, 6);
    });
    expect(spline(keys, 9).at(0)).toEqual(A);
    expect(spline(keys, 9).at(9).x).toBe(B.x);
    expect(spline(keys, 9).at(9).yaw).toBeCloseTo(B.yaw, 12);
    expect(spline(keys, 9).at(9).dist).toBe(B.dist);
  });
  it('is continuous through the interior keys', () => {
    expect(maxStep(sample(spline(keys, 9, { easing: 'linear' }), 900))).toBeLessThan(0.5);
  });
  it('unwraps yaw so a key past pi does not spin the long way', () => {
    const wrapKeys: RigState[] = [{ ...A, yaw: 3.0 }, { ...A, yaw: -3.0, x: 70 }, { ...A, yaw: 3.0, x: 100 }];
    for (const s of sample(spline(wrapKeys, 6, { easing: 'linear' }), 600)) { expect(s.yaw).toBeGreaterThan(2.9); expect(s.yaw).toBeLessThan(3.6); }
  });
  it('one key is a still shot and no keys is an error', () => {
    expect(spline([A], 3).at(1.5)).toEqual(A);
    expect(() => spline([], 3)).toThrow();
  });
});

describe('sequence and planTour', () => {
  it('adds the durations and has no seam where the paths meet', () => {
    const mid = { ...B };
    const p = sequence([flyTo(A, mid, 3), orbit(mid, mid.dist, 4, { pitch: mid.pitch, startYaw: mid.yaw, turns: 0.5 }), flyTo(pathEnd(orbit(mid, mid.dist, 4, { pitch: mid.pitch, startYaw: mid.yaw, turns: 0.5 })), A, 3)]);
    expect(p.duration).toBe(10);
    // 10 s sampled 1000 times: the fastest legitimate motion is under ~0.5 tiles a sample; a seam would jump tens of tiles.
    expect(maxStep(sample(p, 1000))).toBeLessThan(0.6);
  });
  it('a tour starts and ends at the camera it began with and is continuous throughout', () => {
    const stops = [{ x: 100, z: 100, ty: 8, radius: 40 }, { x: 160, z: 90, ty: 14 }, { x: 70, z: 160, ty: 6 }];
    const p = planTour(A, stops, { orbitSeconds: 4, flySeconds: 3 });
    expect(p.duration).toBeCloseTo(3 * 4 + 4 * 3, 9);
    const first = p.at(0), last = p.at(p.duration);
    for (const k of ['x', 'z', 'pitch', 'dist', 'ty'] as const) { expect(first[k]).toBeCloseTo(A[k], 6); expect(last[k]).toBeCloseTo(A[k], 6); }
    expect(maxStep(sample(p, 2000))).toBeLessThan(1);
  });
  it('visits each stop: the camera circles it at the stop radius', () => {
    const p = planTour(A, [{ x: 100, z: 100, ty: 8, radius: 40 }], { orbitSeconds: 4, flySeconds: 3 });
    const s = p.at(3 + 2);
    expect(s.x).toBe(100); expect(s.z).toBe(100); expect(s.dist).toBe(40);
  });
  it('with no stops it is a slow orbit of the start target that comes back round', () => {
    const p = planTour(A, []);
    expect(p.at(0).x).toBe(A.x);
    expect(p.at(p.duration).yaw).toBeCloseTo(A.yaw + Math.PI * 2, 9);
    expect(sample(p).every((s) => s.dist === A.dist)).toBe(true);
  });
  it('sequence of nothing is an error', () => { expect(() => sequence([])).toThrow(); });
});

describe('pickTourStops', () => {
  const cands = [
    { x: 10, z: 10, ty: 1, score: 5 }, { x: 12, z: 11, ty: 1, score: 9 }, { x: 80, z: 80, ty: 1, score: 7 },
    { x: 150, z: 20, ty: 1, score: 3 }, { x: 40, z: 90, ty: 1, score: 7 },
  ];
  it('takes the highest scores, skipping neighbours inside the separation, with stable ties', () => {
    const got = pickTourStops(cands, 3, 24);
    expect(got.map((c) => [c.x, c.z])).toEqual([[12, 11], [40, 90], [80, 80]]);
  });
  it('returns fewer when not enough are far apart, and nothing for nothing', () => {
    expect(pickTourStops(cands, 10, 500)).toHaveLength(1);
    expect(pickTourStops([], 4)).toEqual([]);
  });
});

describe('CinematicPlayer', () => {
  const path = orbit({ x: 0, z: 0, ty: 0 }, 20, 2, { turns: 1 });
  it('steps poses, delivers the final pose, then goes quiet and reports completion', () => {
    const end = vi.fn();
    const pl = new CinematicPlayer();
    pl.play(path, end);
    expect(pl.active).toBe(true);
    expect(pl.step(1)!.yaw).toBeCloseTo(Math.PI, 9);
    expect(end).not.toHaveBeenCalled();
    const last = pl.step(5)!;
    expect(last.yaw).toBeCloseTo(Math.PI * 2, 9);
    expect(end).toHaveBeenCalledExactlyOnceWith(true);
    expect(pl.active).toBe(false);
    expect(pl.step(0.1)).toBeNull();
  });
  it('skip ends playback at once with completed = false and no further poses', () => {
    const end = vi.fn();
    const pl = new CinematicPlayer();
    pl.play(path, end);
    pl.step(0.5);
    pl.skip();
    expect(end).toHaveBeenCalledExactlyOnceWith(false);
    expect(pl.active).toBe(false);
    expect(pl.step(0.5)).toBeNull();
    pl.skip();
    expect(end).toHaveBeenCalledTimes(1);
  });
  it('starting a new path cancels the old one', () => {
    const a = vi.fn(), b = vi.fn();
    const pl = new CinematicPlayer();
    pl.play(path, a);
    pl.play(path, b);
    expect(a).toHaveBeenCalledExactlyOnceWith(false);
    expect(b).not.toHaveBeenCalled();
    expect(pl.elapsed).toBe(0);
  });
  it('ignores negative dt', () => {
    const pl = new CinematicPlayer();
    pl.play(path);
    pl.step(-3);
    expect(pl.elapsed).toBe(0);
  });
});

describe('CameraRig.script', () => {
  it('applies the scripted state each step without easing the target height, and hands back control when it returns null', () => {
    const rig = new CameraRig(() => 0);
    const pl = new CinematicPlayer();
    pl.play(orbit({ x: 100, z: 100, ty: 30 }, 40, 1, { pitch: 0.5, turns: 0.5 }));
    rig.script((dt) => pl.step(dt));
    expect(rig.scripting).toBe(true);
    const v0 = rig.version;
    rig.step(0.5);
    expect(rig.state.ty).toBe(30);
    expect(rig.state.dist).toBe(40);
    expect(rig.version).toBeGreaterThan(v0);
    rig.step(0.6);
    expect(rig.state.ty).toBe(30);
    rig.step(0.1);
    expect(rig.scripting).toBe(false);
    expect(rig.state.ty).toBeLessThan(30);
  });
  it('clamps a scripted pose into the rig limits', () => {
    const rig = new CameraRig(() => 0);
    rig.script(() => ({ x: 9999, z: -5, yaw: 0, pitch: 3, dist: 1, ty: 0 }));
    rig.step(0.016);
    expect(rig.state.x).toBeLessThanOrEqual(256);
    expect(rig.state.z).toBe(0);
    expect(rig.state.pitch).toBeLessThan(1.5);
    expect(rig.state.dist).toBe(3);
  });
  it('starting a script ends a follow', () => {
    const rig = new CameraRig(() => 0);
    rig.followTarget(() => ({ x: 5, z: 5, yaw: 0 }));
    rig.script(() => null);
    expect(rig.following).toBe(false);
  });
});
