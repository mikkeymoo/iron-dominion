import { describe, expect, it } from 'vitest';
import { MAP } from '../sim/layers.ts';
import { CAMERA, CameraRig, pixelToNdc, poseOf, rayFromPose, zoomToward } from './camera.ts';
import { groundScale, panDelta, rotateDelta, twoFingerDelta, wheelFactor } from './gestures.ts';

const flat = (h = 0) => () => h;

describe('camera clamps', () => {
  it('clamps distance, pitch and map bounds on reset', () => {
    const r = new CameraRig(flat());
    r.reset(-50, 9999, 0, 5, 10000);
    expect(r.state.x).toBe(0);
    expect(r.state.z).toBe(MAP);
    expect(r.state.dist).toBe(CAMERA.maxDist);
    expect(r.state.pitch).toBe(CAMERA.maxPitch);
    r.reset(10, 10, 0, -1, 0.1);
    expect(r.state.dist).toBe(CAMERA.minDist);
    expect(r.state.pitch).toBe(CAMERA.minPitch);
  });

  it('keeps street level near 3 tiles and satellite at 300', () => {
    expect(CAMERA.minDist).toBe(3);
    expect(CAMERA.maxDist).toBe(300);
  });

  it('zoom stops at the distance limits', () => {
    const r = new CameraRig(flat());
    r.reset(128, 128, 0, 0.8, 50);
    for (let i = 0; i < 100; i++) r.zoom(0.8);
    expect(r.state.dist).toBe(CAMERA.minDist);
    for (let i = 0; i < 100; i++) r.zoom(1.25);
    expect(r.state.dist).toBe(CAMERA.maxDist);
  });

  it('pan, rotate and keys cannot leave the map or the pitch range', () => {
    const r = new CameraRig(flat());
    r.reset(128, 128, 0, 0.8, 50);
    r.pan(-1000, 1000, 0.016);
    expect(r.state.x).toBe(0);
    expect(r.state.z).toBe(MAP);
    r.rotate(0, 10, 0.016);
    expect(r.state.pitch).toBe(CAMERA.maxPitch);
    r.rotate(0, -10, 0.016);
    expect(r.state.pitch).toBe(CAMERA.minPitch);
    r.setKey('KeyW', true);
    for (let i = 0; i < 600; i++) r.step(0.05);
    expect(r.state.z).toBeGreaterThanOrEqual(0);
    expect(r.state.z).toBeLessThanOrEqual(MAP);
  });

  it('lifts the camera over a hill without moving the look-at point', () => {
    const r = new CameraRig((x, z) => (Math.hypot(x - 128, z - 160) < 20 ? 40 : 0));
    r.reset(128, 128, 0, 0.3, 40);
    const p = r.pose();
    expect(p.py).toBeGreaterThanOrEqual(40 + CAMERA.clearance - 1e-6);
    expect(p.tx).toBe(128);
    expect(p.tz).toBe(128);
  });

  it('eases the target height toward the ground under it', () => {
    let h = 0;
    const r = new CameraRig(() => h);
    r.reset(128, 128, 0, 0.8, 50);
    h = 20;
    r.step(0.016);
    expect(r.state.ty).toBeGreaterThan(0);
    expect(r.state.ty).toBeLessThan(20);
    for (let i = 0; i < 200; i++) r.step(0.05);
    expect(r.state.ty).toBeCloseTo(20, 3);
  });

  it('glides after release and stops', () => {
    const r = new CameraRig(flat());
    r.reset(100, 100, 0, 0.8, 50);
    r.beginDrag();
    r.pan(2, 0, 0.016);
    r.endDrag();
    const x0 = r.state.x;
    r.step(0.1);
    const x1 = r.state.x;
    expect(x1).toBeGreaterThan(x0);
    for (let i = 0; i < 400; i++) r.step(0.05);
    const x2 = r.state.x;
    r.step(0.05);
    expect(r.state.x).toBe(x2);
    expect(x2).toBeGreaterThan(x1);
  });

  it('W moves the target away from the camera along the view direction', () => {
    const r = new CameraRig(flat());
    r.reset(128, 128, 0, 0.8, 50);
    r.setKey('KeyW', true);
    r.step(0.1);
    expect(r.state.z).toBeLessThan(128);
    expect(r.state.x).toBeCloseTo(128, 6);
    r.setKey('KeyW', false);
    r.reset(128, 128, Math.PI / 2, 0.8, 50);
    r.setKey('KeyW', true);
    r.step(0.1);
    expect(r.state.x).toBeLessThan(128);
  });
});

describe('zoom to cursor', () => {
  it('moves the target toward the anchor in proportion to the distance change', () => {
    const t = zoomToward({ x: 100, z: 100 }, { x: 120, z: 80 }, 100, 50);
    expect(t.x).toBeCloseTo(110);
    expect(t.z).toBeCloseTo(90);
    const same = zoomToward({ x: 100, z: 100 }, { x: 120, z: 80 }, 100, 100);
    expect(same).toEqual({ x: 100, z: 100 });
  });

  it('keeps the anchored ground point at the same screen position', () => {
    const ground = flat();
    const r = new CameraRig(ground);
    r.reset(128, 128, 0.7, 0.9, 80);
    const aspect = 16 / 9;
    const n = pixelToNdc(900, 200, 1280, 720);
    const hit = (): { x: number; z: number } => {
      const ray = rayFromPose(r.pose(), CAMERA.fovDeg, aspect, n.nx, n.ny);
      const k = -ray.oy / ray.dy;
      return { x: ray.ox + ray.dx * k, z: ray.oz + ray.dz * k };
    };
    const before = hit();
    r.zoom(0.5, before);
    const after = hit();
    expect(after.x).toBeCloseTo(before.x, 3);
    expect(after.z).toBeCloseTo(before.z, 3);
  });
});

describe('rayFromPose', () => {
  it('sends the centre ray through the look-at point and mirrors left/right', () => {
    const p = poseOf({ x: 128, z: 128, yaw: 0.4, pitch: 0.7, dist: 60, ty: 5 }, flat());
    const c = rayFromPose(p, 45, 1.5, 0, 0);
    const len = Math.hypot(p.tx - p.px, p.ty - p.py, p.tz - p.pz);
    expect(c.ox + (c.dx / Math.hypot(c.dx, c.dy, c.dz)) * len).toBeCloseTo(p.tx, 4);
    expect(c.oy + (c.dy / Math.hypot(c.dx, c.dy, c.dz)) * len).toBeCloseTo(p.ty, 4);
    const l = rayFromPose(p, 45, 1.5, -1, 0), r = rayFromPose(p, 45, 1.5, 1, 0);
    expect(l.dx + r.dx).toBeCloseTo(2 * c.dx, 6);
    expect(l.dy).toBeCloseTo(r.dy, 6);
    const top = rayFromPose(p, 45, 1.5, 0, 1), bot = rayFromPose(p, 45, 1.5, 0, -1);
    expect(top.dy).toBeGreaterThan(bot.dy);
  });

  it('maps pixels to NDC with y up', () => {
    expect(pixelToNdc(0, 0, 100, 50)).toEqual({ nx: -1, ny: 1 });
    expect(pixelToNdc(100, 50, 100, 50)).toEqual({ nx: 1, ny: -1 });
    expect(pixelToNdc(50, 25, 100, 50)).toEqual({ nx: 0, ny: 0 });
  });
});

describe('gesture math', () => {
  const scale = groundScale(100, 800, Math.PI / 2);

  it('scales ground movement with distance and compensates for a shallow pitch', () => {
    expect(groundScale(200, 800, Math.PI / 2).side).toBeCloseTo(2 * scale.side);
    const shallow = groundScale(100, 800, 0.3);
    expect(shallow.fwd).toBeGreaterThan(shallow.side);
    expect(scale.fwd).toBeCloseTo(scale.side);
  });

  it('drag pans opposite to the pointer: the ground follows the finger', () => {
    const d = panDelta(0, 10, 0, scale);
    expect(d.dx).toBeLessThan(0);
    expect(d.dz).toBeCloseTo(0, 9);
    const down = panDelta(0, 0, 10, scale);
    expect(down.dz).toBeLessThan(0);
    const rot = panDelta(Math.PI / 2, 10, 0, scale);
    expect(Math.abs(rot.dx)).toBeCloseTo(0, 9);
    expect(rot.dz).toBeGreaterThan(0);
  });

  it('right-drag rotates and tilts; positive wheel zooms out', () => {
    const r = rotateDelta(100, 40);
    expect(r.dyaw).toBeLessThan(0);
    expect(r.dpitch).toBeGreaterThan(0);
    expect(wheelFactor(100, 0)).toBeGreaterThan(1);
    expect(wheelFactor(-100, 0)).toBeLessThan(1);
    expect(wheelFactor(3, 1)).toBeCloseTo(wheelFactor(48, 0));
    expect(wheelFactor(0, 0)).toBe(1);
    expect(wheelFactor(1e9, 0)).toBeLessThan(Math.exp(1.1));
  });

  it('two fingers: pinch zooms, twist rotates, vertical drag tilts', () => {
    const prev = [{ x: 100, y: 100 }, { x: 200, y: 100 }] as const;
    const apart = twoFingerDelta(prev, [{ x: 50, y: 100 }, { x: 250, y: 100 }]);
    expect(apart.zoomFactor).toBeCloseTo(0.5);
    expect(apart.dyaw).toBeCloseTo(0);
    expect(apart.dpitch).toBeCloseTo(0);
    const together = twoFingerDelta(prev, [{ x: 125, y: 100 }, { x: 175, y: 100 }]);
    expect(together.zoomFactor).toBeCloseTo(2);

    const cw = twoFingerDelta(prev, [{ x: 150 - 50 * Math.cos(0.3), y: 100 - 50 * Math.sin(0.3) }, { x: 150 + 50 * Math.cos(0.3), y: 100 + 50 * Math.sin(0.3) }]);
    expect(cw.zoomFactor).toBeCloseTo(1, 6);
    expect(cw.dyaw).toBeCloseTo(-0.3, 6);

    const down = twoFingerDelta(prev, [{ x: 100, y: 160 }, { x: 200, y: 160 }]);
    expect(down.zoomFactor).toBeCloseTo(1);
    expect(down.dyaw).toBeCloseTo(0);
    expect(down.dpitch).toBeGreaterThan(0);
    expect(down.mid).toEqual({ x: 150, y: 160 });
  });

  it('wraps the twist across the +-pi seam and ignores a degenerate pinch', () => {
    const prev = [{ x: 100, y: 100 }, { x: 99, y: 100.01 }] as const;
    const cur = [{ x: 100, y: 100 }, { x: 99, y: 99.99 }] as const;
    const g = twoFingerDelta(prev, cur);
    expect(Math.abs(g.dyaw)).toBeCloseTo(0.02, 3);
    expect(g.zoomFactor).toBe(1);
  });
});
