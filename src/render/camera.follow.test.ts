import { describe, expect, it } from 'vitest';
import { CameraRig, FOLLOW } from './camera.ts';

const flat = (): number => 2;

describe('CameraRig.followTarget', () => {
  it('snaps to the target, then trails it from behind at street level', () => {
    const rig = new CameraRig(flat);
    rig.reset(10, 10, 0.3, 1.0, 80);
    let x = 100, z = 120;
    rig.followTarget(() => ({ x, z, yaw: Math.PI / 2 }));
    rig.step(0.016);
    expect(rig.state.x).toBeCloseTo(100, 5);
    expect(rig.state.z).toBeCloseTo(120, 5);
    for (let i = 0; i < 240; i++) { x += 0.02; rig.step(0.016); }
    const s = rig.state;
    expect(s.dist).toBeCloseTo(FOLLOW.dist, 1);
    expect(s.pitch).toBeCloseTo(FOLLOW.pitch, 1);
    expect(Math.abs(s.x - x)).toBeLessThan(0.3);
    // The robot faces +x, so the camera sits on -x of it: yaw = heading + pi puts the camera at (sin yaw, cos yaw) = (-1, 0) from the target.
    const p = rig.pose();
    expect(p.px).toBeLessThan(s.x - 1.5);
    expect(Math.abs(p.pz - s.z)).toBeLessThan(0.5);
    expect(p.py).toBeLessThan(2 + FOLLOW.lift + FOLLOW.dist * Math.sin(FOLLOW.pitch) + 0.3);
    expect(rig.following).toBe(true);
  });

  it('keeps the camera above the ground by the street-level clearance only', () => {
    const rig = new CameraRig(flat);
    rig.followTarget(() => ({ x: 50, z: 50, yaw: 0 }));
    for (let i = 0; i < 120; i++) rig.step(0.016);
    expect(rig.pose().py).toBeGreaterThanOrEqual(2 + FOLLOW.clearance - 1e-6);
    expect(rig.pose().py).toBeLessThan(3);
  });

  it('ends when the target is gone or on stopFollow, handing the rig back', () => {
    const rig = new CameraRig(flat);
    let alive = true;
    rig.followTarget(() => (alive ? { x: 60, z: 60, yaw: 0 } : null));
    rig.step(0.016);
    expect(rig.following).toBe(true);
    alive = false;
    rig.step(0.016);
    expect(rig.following).toBe(false);
    rig.followTarget(() => ({ x: 70, z: 70, yaw: 0 }));
    rig.stopFollow();
    const before = { ...rig.state };
    rig.step(0.5);
    expect(rig.state.x).toBeCloseTo(before.x, 5);
    expect(rig.following).toBe(false);
  });

  it('turns the short way round when the target turns across the +-pi seam', () => {
    const rig = new CameraRig(flat);
    let yaw = Math.PI - 0.1;
    rig.followTarget(() => ({ x: 30, z: 30, yaw }));
    rig.step(0.016);
    yaw = -Math.PI + 0.1;
    const before = rig.state.yaw;
    rig.step(0.05);
    const d = Math.abs(((rig.state.yaw - before + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    expect(d).toBeLessThan(0.5);
  });
});
