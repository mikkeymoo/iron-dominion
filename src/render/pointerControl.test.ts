import { describe, expect, it } from 'vitest';
import { CameraRig } from './camera.ts';
import { MIN_FLUSH_DT, PointerControl } from './pointerControl.ts';

function setup() {
  const rig = new CameraRig(() => 0);
  rig.reset(128, 128, 0, 0.8, 100);
  const ctl = new PointerControl({ rig, viewHeight: () => 800, groundAt: () => ({ x: 128, z: 128 }) });
  return { rig, ctl };
}

describe('pointer control velocity', () => {
  it('several moves in one frame produce one velocity from the total, not a sum of per-event velocities', () => {
    const a = setup();
    a.ctl.down(1, 100, 100, 'touch');
    a.ctl.move(1, 110, 100);
    a.ctl.move(1, 120, 100);
    a.ctl.flush(0.016);
    const split = a.rig.velocity.x;
    const b = setup();
    b.ctl.down(1, 100, 100, 'touch');
    b.ctl.move(1, 120, 100);
    b.ctl.flush(0.016);
    expect(split).toBeCloseTo(b.rig.velocity.x, 9);
    expect(Math.abs(split)).toBeGreaterThan(0);
  });

  it('events with identical timestamps cannot blow the velocity up: dt is clamped to 1/120 s', () => {
    const { rig, ctl } = setup();
    ctl.down(1, 100, 100, 'touch');
    ctl.move(1, 101, 100);
    ctl.move(1, 102, 100);
    ctl.flush(0);
    const moved = Math.abs(rig.state.x - 128);
    expect(Math.abs(rig.velocity.x)).toBeLessThanOrEqual(moved / MIN_FLUSH_DT + 1e-9);
    expect(Math.abs(rig.velocity.x)).toBeCloseTo(moved / MIN_FLUSH_DT, 6);
    expect(Number.isFinite(rig.velocity.x)).toBe(true);
  });

  it('keeps the last velocity when nothing moved this frame', () => {
    const { rig, ctl } = setup();
    ctl.down(1, 0, 0, 'touch');
    ctl.move(1, 5, 0);
    ctl.flush(0.016);
    const v = rig.velocity.x;
    ctl.flush(0.016);
    expect(rig.velocity.x).toBe(v);
  });
});

describe('pointer control mode fallback', () => {
  it('2 -> 1 fingers resumes pan from the remaining finger without a jump', () => {
    const { rig, ctl } = setup();
    ctl.down(1, 100, 400, 'touch');
    ctl.down(2, 300, 400, 'touch');
    expect(ctl.activeMode).toBe('two');
    ctl.move(2, 310, 400);
    ctl.up(1);
    expect(ctl.activeMode).toBe('pan');
    const x = rig.state.x, z = rig.state.z, dist = rig.state.dist, yaw = rig.state.yaw;
    ctl.move(2, 310, 400);
    expect(rig.state.x).toBe(x);
    expect(rig.state.z).toBe(z);
    ctl.move(2, 330, 400);
    expect(rig.state.x).not.toBe(x);
    expect(rig.state.dist).toBe(dist);
    expect(rig.state.yaw).toBe(yaw);
  });

  it('3 -> 2 fingers keeps the two-finger gesture and does not jump', () => {
    const { rig, ctl } = setup();
    ctl.down(1, 100, 400, 'touch');
    ctl.down(2, 300, 400, 'touch');
    ctl.down(3, 500, 400, 'touch');
    ctl.up(3);
    expect(ctl.activeMode).toBe('two');
    const d = rig.state.dist;
    ctl.move(1, 100, 400);
    expect(rig.state.dist).toBe(d);
    ctl.move(2, 400, 400);
    expect(rig.state.dist).toBeLessThan(d);
  });

  it('releasing every finger ends the drag and mouse buttons pick pan or rotate', () => {
    const { rig, ctl } = setup();
    ctl.down(1, 0, 0, 'touch');
    ctl.up(1);
    expect(ctl.activeMode).toBe('none');
    ctl.down(7, 0, 0, 'mouse', 0);
    expect(ctl.activeMode).toBe('pan');
    ctl.up(7, 'mouse');
    ctl.down(7, 0, 0, 'mouse', 2);
    expect(ctl.activeMode).toBe('rotate');
    const yaw = rig.state.yaw;
    ctl.move(7, 50, 0);
    expect(rig.state.yaw).not.toBe(yaw);
    ctl.up(7, 'mouse');
    expect(ctl.activeMode).toBe('none');
  });
});
