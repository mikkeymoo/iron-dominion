import type { ToolController } from './controller.ts';
import type { Tile } from './toolSpec.ts';

/** What input.ts needs from the tools: whether a tool owns one-finger / left-button drags, and the drag callbacks in canvas pixels. */
export interface ToolInput {
  active(): boolean;
  begin(px: number, py: number): void;
  /** Drag move, or a mouse hover when no drag is in progress. */
  move(px: number, py: number): void;
  end(): void;
  cancelDrag(): void;
  /** A touch pointer lifted: no hover preview remains. */
  leave(): void;
}

/** Adapts the controller to pixel input: `pick` turns a canvas pixel into a tile by marching the mirror height grid. */
export function createToolInput(c: ToolController, pick: (px: number, py: number) => Tile | null): ToolInput {
  return {
    active: () => c.active,
    begin(px, py) {
      c.setScreen(px, py);
      const t = pick(px, py);
      if (t) c.begin(t);
    },
    move(px, py) {
      c.setScreen(px, py);
      const t = pick(px, py);
      if (t) c.move(t);
    },
    end() { c.end(); },
    cancelDrag() { c.abortDrag(); },
    leave() { c.clearHover(); },
  };
}
