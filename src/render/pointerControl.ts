import type { CameraRig } from './camera.ts';
import { groundScale, panDelta, rotateDelta, twoFingerDelta, wheelFactor, type Pt } from './gestures.ts';

// Pointer-event state machine for the orbit rig. DOM-free: input.ts feeds it plain numbers.
// Motion is applied immediately; release velocity is computed once per frame in flush() from the whole gesture,
// so several events (or several fingers) in one frame cannot multiply the velocity.

export const MIN_FLUSH_DT = 1 / 120;

type Mode = 'none' | 'pan' | 'rotate' | 'two';
export type PointerKind = 'mouse' | 'touch';

export interface ControlHost {
  rig: CameraRig;
  viewHeight(): number;
  /** Ground point under a canvas-relative pixel, or null if the ray misses the map. */
  groundAt(px: number, py: number): { x: number; z: number } | null;
}

export class PointerControl {
  private readonly pointers = new Map<number, Pt>();
  private mode: Mode = 'none';
  private prevPair: [Pt, Pt] | null = null;
  private sx = 0; private sz = 0; private syaw = 0; private spitch = 0;
  private touched = false;

  constructor(private readonly host: ControlHost) {}

  get activeMode(): Mode { return this.mode; }
  get pointerCount(): number { return this.pointers.size; }

  private setMode(m: Mode): void {
    if (this.mode === 'none' && m !== 'none') this.host.rig.beginDrag();
    else if (this.mode !== 'none' && m === 'none') this.host.rig.endDrag();
    this.mode = m;
  }

  private pair(): [Pt, Pt] | null {
    const v = [...this.pointers.values()];
    return v.length >= 2 ? [{ ...v[0]! }, { ...v[1]! }] : null;
  }

  /** Choose the mode for the pointers that are down right now. */
  private settle(kind: PointerKind, button: number): void {
    const n = this.pointers.size;
    if (n === 0) { this.setMode('none'); this.prevPair = null; return; }
    if (kind === 'mouse') { this.setMode(button === 0 ? 'pan' : 'rotate'); return; }
    if (n === 1) { this.setMode('pan'); this.prevPair = null; return; }
    this.setMode('two');
    this.prevPair = this.pair();
  }

  down(id: number, x: number, y: number, kind: PointerKind, button = 0): void {
    this.pointers.set(id, { x, y });
    this.settle(kind, button);
  }

  up(id: number, kind: PointerKind = 'touch'): void {
    this.pointers.delete(id);
    this.settle(kind, 0);
  }

  move(id: number, x: number, y: number): void {
    const prev = this.pointers.get(id);
    if (!prev || this.mode === 'none') return;
    const cur = { x, y };
    this.pointers.set(id, cur);
    const rig = this.host.rig, s = rig.state;
    if (this.mode === 'pan') {
      const d = panDelta(s.yaw, cur.x - prev.x, cur.y - prev.y, groundScale(s.dist, this.host.viewHeight(), s.pitch));
      rig.pan(d.dx, d.dz, 0);
      this.sx += d.dx; this.sz += d.dz; this.touched = true;
    } else if (this.mode === 'rotate') {
      const d = rotateDelta(cur.x - prev.x, cur.y - prev.y);
      rig.rotate(d.dyaw, d.dpitch, 0);
      this.syaw += d.dyaw; this.spitch += d.dpitch; this.touched = true;
    } else {
      const now = this.pair();
      if (!now || !this.prevPair) return;
      const g = twoFingerDelta(this.prevPair, now);
      this.prevPair = now;
      rig.zoom(g.zoomFactor, this.host.groundAt(g.mid.x, g.mid.y) ?? undefined);
      rig.rotate(g.dyaw, g.dpitch, 0);
      this.syaw += g.dyaw; this.spitch += g.dpitch; this.touched = true;
    }
  }

  wheel(x: number, y: number, deltaY: number, deltaMode: number): void {
    this.host.rig.zoom(wheelFactor(deltaY, deltaMode), this.host.groundAt(x, y) ?? undefined);
  }

  /** Once per frame, before rig.step: turn this frame's total motion into the release velocity. */
  flush(dtSeconds: number): void {
    if (!this.touched) return;
    const dt = Math.max(dtSeconds, MIN_FLUSH_DT);
    this.host.rig.impulse(this.sx / dt, this.sz / dt, this.syaw / dt, this.spitch / dt);
    this.sx = this.sz = this.syaw = this.spitch = 0;
    this.touched = false;
  }

  reset(): void {
    this.pointers.clear();
    this.setMode('none');
    this.prevPair = null;
  }
}
