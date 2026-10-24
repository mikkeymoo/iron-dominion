import { fireEvent } from '@testing-library/react';

interface PointerInit { id?: number; x?: number; y?: number; type?: string; button?: number }

/** jsdom has no PointerEvent, so fireEvent.pointerDown drops its init. This sends a mouse event under the pointer name with the pointer fields set. */
export function pointer(el: Element, kind: 'down' | 'up' | 'move' | 'cancel', init: PointerInit = {}): void {
  const e = new MouseEvent(`pointer${kind}`, { bubbles: true, cancelable: true, clientX: init.x ?? 0, clientY: init.y ?? 0, button: init.button ?? 0 });
  Object.defineProperties(e, { pointerId: { value: init.id ?? 1 }, pointerType: { value: init.type ?? 'touch' } });
  fireEvent(el, e);
}

/** A press and release: a tap with no movement, or a swipe when the end point differs. */
export function gesture(el: Element, from: { x: number; y: number }, to: { x: number; y: number } = from, id = 1): void {
  pointer(el, 'down', { id, ...from });
  pointer(el, 'up', { id, ...to });
}
