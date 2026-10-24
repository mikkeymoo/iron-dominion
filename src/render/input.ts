import type { CameraRig } from './camera.ts';
import { isEditableTarget } from './editable.ts';
import { LongPressDetector } from './longPress.ts';
import { PointerControl } from './pointerControl.ts';
import type { ToolInput } from './tools/pointer.ts';

/** The radial build menu, as input.ts drives it. Coordinates are canvas pixels. */
export interface RadialHost {
  isOpen(): boolean;
  /** A long press (touch) or a right-click (mouse). Returns whether a menu opened. */
  open(px: number, py: number, source: 'touch' | 'mouse'): boolean;
  /** The finger that opened the menu moved: highlight the item under it. */
  move(px: number, py: number): void;
  /** That finger lifted: pick the item under it, if any. */
  release(px: number, py: number): void;
  close(): void;
}

export interface InputHost {
  element: HTMLElement;
  rig: CameraRig;
  groundAt(px: number, py: number): { x: number; z: number } | null;
  /** With a tool active, one finger / the left button drives the tool; two fingers and the other buttons still drive the camera. */
  tool?: ToolInput;
  /** Long press on the map and right-click open this menu. Absent in tests that only need the camera. */
  radial?: RadialHost;
}

export interface CameraInput {
  /** Call once per frame before rig.step with the frame time in seconds. */
  flush(dtSeconds: number): void;
  dispose(): void;
}

/** A right-click that moves further than this (CSS px) is a rotate drag, not a click. */
const RIGHT_CLICK_SLOP = 5;

/** Mouse, touch and keyboard bindings for the orbit rig. */
export function bindCameraInput(host: InputHost): CameraInput {
  const { element, rig, radial } = host;
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
  let radialPtr: number | null = null;
  let rightPtr: { id: number; x: number; y: number } | null = null;

  const press = new LongPressDetector({
    onFire: (x, y, id) => {
      if (!radial || tool?.active() || control.pointerCount !== 1) return;
      if (!radial.open(x, y, 'touch')) return;
      radialPtr = id;
      // The finger now belongs to the menu: the camera stops following it.
      control.up(id, 'touch');
      try { navigator.vibrate?.(12); } catch { /* haptics are optional */ }
    },
  });

  const onDown = (e: PointerEvent): void => {
    try { element.setPointerCapture?.(e.pointerId); } catch { /* the pointer is already gone; the gesture still works without capture */ }
    const p = local(e);
    const kind = e.pointerType === 'mouse' ? 'mouse' : 'touch';
    element.focus({ preventScroll: true });
    if (radial?.isOpen()) {
      // A tap on the map dismisses the menu and does nothing else.
      radial.close();
      radialPtr = null;
      return;
    }
    if (tool?.active() && !toolPtr && control.pointerCount === 0 && (kind === 'touch' || e.button === 0)) {
      toolPtr = { id: e.pointerId, x: p.x, y: p.y };
      tool.begin(p.x, p.y);
      return;
    }
    if (toolPtr && kind === 'touch') {
      // A second finger means the player is steering the camera, not drawing: drop the tool drag and give both fingers to the rig.
      tool?.cancelDrag();
      tool?.leave();
      control.down(toolPtr.id, toolPtr.x, toolPtr.y, 'touch');
      toolPtr = null;
    }
    if (kind === 'mouse') { if (e.button === 2) rightPtr = { id: e.pointerId, x: p.x, y: p.y }; }
    else if (radial && !tool?.active()) press.down(e.pointerId, p.x, p.y);
    control.down(e.pointerId, p.x, p.y, kind, e.button);
  };
  const onMove = (e: PointerEvent): void => {
    const p = local(e);
    if (radialPtr === e.pointerId) { radial?.move(p.x, p.y); return; }
    if (toolPtr && e.pointerId === toolPtr.id) { toolPtr.x = p.x; toolPtr.y = p.y; tool?.move(p.x, p.y); return; }
    if (tool?.active() && e.pointerType === 'mouse' && e.buttons === 0) tool.move(p.x, p.y);
    if (rightPtr?.id === e.pointerId && Math.hypot(p.x - rightPtr.x, p.y - rightPtr.y) > RIGHT_CLICK_SLOP) rightPtr = null;
    press.move(e.pointerId, p.x, p.y);
    control.move(e.pointerId, p.x, p.y);
  };
  const onUp = (e: PointerEvent): void => {
    element.releasePointerCapture?.(e.pointerId);
    const p = local(e);
    const wasFired = press.up(e.pointerId);
    if (radialPtr === e.pointerId) {
      radialPtr = null;
      if (wasFired || radial?.isOpen()) { if (e.type === 'pointercancel') radial?.close(); else radial?.release(p.x, p.y); }
      return;
    }
    if (rightPtr?.id === e.pointerId) {
      const click = rightPtr;
      rightPtr = null;
      if (e.type === 'pointerup' && e.button === 2 && radial && Math.hypot(p.x - click.x, p.y - click.y) <= RIGHT_CLICK_SLOP) radial.open(p.x, p.y, 'mouse');
    }
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
    return !isEditableTarget(e.target) && !e.ctrlKey && !e.metaKey && !e.altKey;
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
      radialPtr = null;
      rightPtr = null;
      press.reset();
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
