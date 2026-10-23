import type { CameraRig } from './camera.ts';
import { PointerControl } from './pointerControl.ts';

export interface InputHost {
  element: HTMLElement;
  rig: CameraRig;
  groundAt(px: number, py: number): { x: number; z: number } | null;
}

export interface CameraInput {
  /** Call once per frame before rig.step with the frame time in seconds. */
  flush(dtSeconds: number): void;
  dispose(): void;
}

/** Mouse, touch and keyboard bindings for the orbit rig. */
export function bindCameraInput(host: InputHost): CameraInput {
  const { element, rig } = host;
  const control = new PointerControl({
    rig,
    viewHeight: () => element.getBoundingClientRect().height,
    groundAt: host.groundAt,
  });
  const local = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = element.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onDown = (e: PointerEvent): void => {
    element.setPointerCapture?.(e.pointerId);
    const p = local(e);
    control.down(e.pointerId, p.x, p.y, e.pointerType === 'mouse' ? 'mouse' : 'touch', e.button);
    element.focus({ preventScroll: true });
  };
  const onMove = (e: PointerEvent): void => { const p = local(e); control.move(e.pointerId, p.x, p.y); };
  const onUp = (e: PointerEvent): void => {
    element.releasePointerCapture?.(e.pointerId);
    control.up(e.pointerId, e.pointerType === 'mouse' ? 'mouse' : 'touch');
  };
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const p = local(e);
    control.wheel(p.x, p.y, e.deltaY, e.deltaMode);
  };

  const keyOk = (e: KeyboardEvent): boolean => {
    const t = e.target as HTMLElement | null;
    return !(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) && !e.ctrlKey && !e.metaKey && !e.altKey;
  };
  const onKeyDown = (e: KeyboardEvent): void => { if (keyOk(e)) rig.setKey(e.code, true); };
  const onKeyUp = (e: KeyboardEvent): void => rig.setKey(e.code, false);
  const onBlur = (): void => rig.clearKeys();
  const onMenu = (e: Event): void => e.preventDefault();

  element.addEventListener('pointerdown', onDown);
  element.addEventListener('pointermove', onMove);
  element.addEventListener('pointerup', onUp);
  element.addEventListener('pointercancel', onUp);
  element.addEventListener('wheel', onWheel, { passive: false });
  element.addEventListener('contextmenu', onMenu);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  return {
    flush: (dt) => control.flush(dt),
    dispose() {
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onUp);
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('contextmenu', onMenu);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      control.reset();
    },
  };
}
