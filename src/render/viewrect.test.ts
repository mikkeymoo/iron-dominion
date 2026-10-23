import { describe, expect, it } from 'vitest';
import { HEIGHT_SCALE, MAP } from '../sim/layers.ts';
import { poseOf } from './camera.ts';
import { computeViewRect } from './viewrect.ts';

const flat: { layers: Record<string, Int16Array> } = { layers: { height: new Int16Array(MAP * MAP) } };
const high = { layers: { height: new Int16Array(MAP * MAP).fill(2 * HEIGHT_SCALE) } };

describe('computeViewRect', () => {
  it('looking steeply down the rect is the ground footprint around the target', () => {
    const pose = poseOf({ x: 128, z: 128, yaw: 0, pitch: 1.4, dist: 60, ty: 0 }, () => 0);
    const r = computeViewRect(pose, 45, 16 / 9, flat, 200);
    expect(r.x0).toBeLessThan(128);
    expect(r.x1).toBeGreaterThan(128);
    expect(r.y0).toBeLessThan(128);
    expect(r.y1).toBeGreaterThan(128);
    expect(r.x1 - r.x0).toBeLessThan(120);
  });

  it('sky-hitting rays extend the rect away from the camera: yaw 0 looks toward -z', () => {
    const pose = poseOf({ x: 128, z: 128, yaw: 0, pitch: 0.1, dist: 40, ty: 0 }, () => 0);
    const r = computeViewRect(pose, 45, 16 / 9, flat, 100);
    expect(r.y0).toBeLessThan(100);
    expect(r.y1).toBeGreaterThan(128);
    expect(r.x0).toBeLessThan(128);
    expect(r.x1).toBeGreaterThan(128);
  });

  it('yaw 90 degrees looks toward -x, so the rect extends along x instead of z', () => {
    const pose = poseOf({ x: 128, z: 128, yaw: Math.PI / 2, pitch: 0.1, dist: 40, ty: 0 }, () => 0);
    const r = computeViewRect(pose, 45, 16 / 9, flat, 100);
    expect(r.x0).toBeLessThan(100);
    expect(r.x1).toBeGreaterThan(128);
    expect(r.y0).toBeLessThan(128);
    expect(r.y1).toBeGreaterThan(128);
    const yaw0 = computeViewRect(poseOf({ x: 128, z: 128, yaw: 0, pitch: 0.1, dist: 40, ty: 0 }, () => 0), 45, 16 / 9, flat, 100);
    expect(r.x1 - r.x0).toBeLessThan(yaw0.x1 - yaw0.x0);
    expect(r.y1 - r.y0).toBeGreaterThan(yaw0.y1 - yaw0.y0);
  });

  it('clamps to the map and works over raised ground', () => {
    const pose = poseOf({ x: 250, z: 250, yaw: 2.3, pitch: 0.1, dist: 40, ty: 2 }, () => 2);
    const r = computeViewRect(pose, 45, 1, high, 400);
    for (const v of [r.x0, r.x1, r.y0, r.y1]) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(MAP); }
    expect(r.x0).toBeLessThanOrEqual(r.x1);
  });
});
