import { describe, expect, it } from 'vitest';
import { pixelToNdc, rayFromPose, type Pose } from './camera.ts';
import { TAP_MS, TAP_SLOP_PX, TapDetector, nearestPoint, nearestSegment, projectToPixel, tapEligible } from './tap.ts';

const pose: Pose = { px: 100, py: 40, pz: 130, tx: 100, ty: 0, tz: 100 };
const FOV = 45, W = 800, H = 600;
const project = (x: number, y: number, z: number) => projectToPixel(pose, FOV, W, H, x, y, z);

describe('projectToPixel', () => {
  it('puts the look-at point at the middle of the view', () => {
    const q = project(100, 0, 100)!;
    expect(q.px).toBeCloseTo(W / 2, 3);
    expect(q.py).toBeCloseTo(H / 2, 3);
    expect(q.depth).toBeCloseTo(Math.hypot(0, 40, 30), 5);
  });

  it('inverts the ray the pointer picks with: a point on a pixel ray projects back to that pixel', () => {
    for (const [px, py] of [[120, 90], [400, 300], [700, 520], [10, 580]] as const) {
      const n = pixelToNdc(px, py, W, H);
      const r = rayFromPose(pose, FOV, W / H, n.nx, n.ny);
      const len = Math.hypot(r.dx, r.dy, r.dz);
      const t = 37;
      const q = project(r.ox + (r.dx / len) * t, r.oy + (r.dy / len) * t, r.oz + (r.dz / len) * t)!;
      expect(q.px).toBeCloseTo(px, 2);
      expect(q.py).toBeCloseTo(py, 2);
    }
  });

  it('returns null for a point behind the camera and puts higher points higher on screen', () => {
    expect(project(100, 40, 400)).toBeNull();
    expect(project(100, 10, 100)!.py).toBeLessThan(project(100, 0, 100)!.py);
  });
});

describe('TapDetector', () => {
  it('reports a short press that barely moved', () => {
    const d = new TapDetector();
    d.down(1, 50, 60, 1000, true);
    expect(d.up(1, 52, 61, 1100, true)).toEqual({ x: 52, y: 61 });
  });

  it('ignores a drag, a long press, a press that something else owns, and a second finger', () => {
    const d = new TapDetector();
    d.down(1, 50, 60, 0, true); d.move(1, 50 + TAP_SLOP_PX + 1, 60);
    expect(d.up(1, 50 + TAP_SLOP_PX + 1, 60, 100, true)).toBeNull();
    d.down(1, 50, 60, 0, true);
    expect(d.up(1, 50, 60, TAP_MS + 1, true)).toBeNull();
    d.down(1, 50, 60, 0, false);
    expect(d.up(1, 50, 60, 50, true)).toBeNull();
    d.down(1, 50, 60, 0, true); d.down(2, 90, 60, 10, true);
    expect(d.up(1, 50, 60, 60, false)).toBeNull();
    expect(d.up(2, 90, 60, 70, true)).toBeNull();
    d.down(3, 10, 10, 0, true);
    expect(d.up(3, 10, 10, 30, true), 'ready again once every pointer is up').toEqual({ x: 10, y: 10 });
  });

  it('forgets a cancelled gesture', () => {
    const d = new TapDetector();
    d.down(1, 5, 5, 0, true);
    d.cancel();
    expect(d.up(1, 5, 5, 10, true)).toBeNull();
  });
});

describe('tapEligible', () => {
  const free = { handler: true, toolActive: false, primary: true, mouse: true, button: 0, radialOpen: false };

  it('lets a plain primary press become a tap', () => {
    expect(tapEligible(free)).toBe(true);
    expect(tapEligible({ ...free, mouse: false, button: -1 })).toBe(true);
  });

  it('refuses a press with no handler, an active tool, a second finger or a non-primary mouse button', () => {
    for (const o of [{ handler: false }, { toolActive: true }, { primary: false }, { button: 2 }]) expect(tapEligible({ ...free, ...o })).toBe(false);
  });

  it('a press that dismisses the open radial menu is not a tap, so it does not also open an info card', () => {
    expect(tapEligible({ ...free, radialOpen: true })).toBe(false);
    const d = new TapDetector();
    d.down(1, 50, 60, 1000, tapEligible({ ...free, radialOpen: true }));
    expect(d.up(1, 50, 60, 1100, true)).toBeNull();
    d.down(2, 50, 60, 2000, tapEligible(free));
    expect(d.up(2, 50, 60, 2100, true)).toEqual({ x: 50, y: 60 });
  });
});

describe('picking by screen position', () => {
  const c = project(100, 0, 100)!;
  it('takes the nearest point within the radius, the nearer to the camera on a tie, and none outside it', () => {
    const pts = [{ id: 1, x: 100, y: 0, z: 100 }, { id: 2, x: 101, y: 0, z: 100 }, { id: 3, x: 140, y: 0, z: 100 }];
    expect(nearestPoint(pts, project, c.px, c.py, 26)).toBe(1);
    expect(nearestPoint(pts, project, c.px + 40, c.py + 200, 26)).toBeNull();
    const far = project(140, 0, 100)!;
    expect(nearestPoint(pts, project, far.px, far.py, 26)).toBe(3);
    const stacked = [{ id: 7, x: 100, y: 0, z: 90 }, { id: 8, x: 100, y: 0, z: 100 }];
    const q = project(100, 0, 100)!;
    expect(nearestPoint(stacked, project, q.px, q.py, 60)).toBe(8);
  });

  it('picks a tall building by its face: the segment from its base to its roof', () => {
    const tower = { id: 4, ax: 100, ay: 0, az: 100, bx: 100, by: 12, bz: 100 };
    const low = { id: 5, ax: 108, ay: 0, az: 100, bx: 108, by: 1, bz: 100 };
    const mid = project(100, 6, 100)!;
    expect(nearestSegment([low, tower], project, mid.px + 5, mid.py, 22)).toBe(4);
    expect(nearestSegment([low, tower], project, mid.px + 200, mid.py, 22)).toBeNull();
    const lowTop = project(108, 0.5, 100)!;
    expect(nearestSegment([low, tower], project, lowTop.px, lowTop.py, 22)).toBe(5);
  });
});
