import type { CameraRig } from './camera.ts';
import { PointerControl } from './pointerControl.ts';
import type { ToolInput } from './tools/pointer.ts';

export interface InputHost {
  element: HTMLElement;
  rig: CameraRig;
  groundAt(px: number, py: number): { x: number; z: number } | null;
  /** With a tool active, one finger / the left button drives the tool; two fingers and the other buttons still drive the camera. */
  tool?: ToolInput;
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

  const tool = host.tool;
  let toolPtr: { id: number; x: number; y: number } | null = null;

  const onDown = (e: PointerEvent): void => {
    try { element.setPointerCapture?.(e.pointerId); } catch { /* the pointer is already gone; the gesture still works without capture */ }
    const p = local(e);
    const kind = e.pointerType === 'mouse' ? 'mouse' : 'touch';
    element.focus({ preventScroll: true });
    if (tool?.active() && !toolPtr && control.pointerCount === 0 && (kind === 'touch' || e.button === 0)) {
      toolPtr = { id: e.pointerId, x: p.x, y: p.y };
      tool.begin(p.x, p.y);
      return;
    }
    if (toolPtr && kind === 'touch') {
      // A second finger means the player is steering the camera, not drawing: drop the tool drag and give both fingers to the rig.
      tool?.cancelDrag();
      control.down(toolPtr.id, toolPtr.x, toolPtr.y, 'touch');
      toolPtr = null;
    }
    control.down(e.pointerId, p.x, p.y, kind, e.button);
  };
  const onMove = (e: PointerEvent): void => {
    const p = local(e);
    if (toolPtr) {
      if (e.pointerId === toolPtr.id) { toolPtr.x = p.x; toolPtr.y = p.y; tool?.move(p.x, p.y); }
      return;
    }
    if (tool?.active() && e.pointerType === 'mouse' && e.buttons === 0) tool.move(p.x, p.y);
    control.move(e.pointerId, p.x, p.y);
  };
  const onUp = (e: PointerEvent): void => {
    element.releasePointerCapture?.(e.pointerId);
    if (toolPtr && e.pointerId === toolPtr.id) {
      toolPtr = null;
      if (e.type === 'pointercancel') tool?.cancelDrag(); else tool?.end();
      if (e.pointerType !== 'mouse') tool?.leave();
      return;
    }
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
      toolPtr = null;
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
