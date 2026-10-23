import { describe, expect, it } from 'vitest';
import { UndoStack } from './undoStack.ts';

const e = (id: number, cost = 10) => ({ id, cost, label: `cmd ${id}` });

describe('undo stack', () => {
  it('pushes on accepted, undoes newest first, and pops when the undo is accepted', () => {
    const s = new UndoStack();
    expect(s.canUndo).toBe(false);
    s.push(e(3)); s.push(e(7));
    expect(s.canUndo).toBe(true);
    expect(s.top()?.id).toBe(7);
    expect(s.undone(7)?.cost).toBe(10);
    expect(s.top()?.id).toBe(3);
    expect(s.undone(7)).toBeUndefined();
    s.undone(3);
    expect(s.canUndo).toBe(false);
  });

  it('drops an entry the sim reports consumed or no longer undoable, which disables the button when it was the last', () => {
    const s = new UndoStack();
    s.push(e(1));
    expect(s.rejected(1, 'consumed')).toBe(true);
    expect(s.canUndo).toBe(false);
    s.push(e(2)); s.push(e(3));
    expect(s.rejected(3, 'not-undoable')).toBe(true);
    expect(s.canUndo).toBe(true);
    expect(s.top()?.id).toBe(2);
  });

  it('skips an entry while its undo is in flight and offers it again after a transient rejection', () => {
    const s = new UndoStack();
    s.push(e(1)); s.push(e(2));
    s.begin(2);
    expect(s.top()?.id).toBe(1);
    s.begin(1);
    expect(s.canUndo).toBe(false);
    s.rejected(1, 'superseded');
    expect(s.top()?.id).toBe(1);
    s.undone(2);
    expect(s.size).toBe(1);
  });

  it('keeps an entry after a transient rejection', () => {
    const s = new UndoStack();
    s.push(e(4));
    expect(s.rejected(4, 'superseded')).toBe(false);
    expect(s.canUndo).toBe(true);
  });

  it('holds at most as many entries as the sim journal and forgets the oldest', () => {
    const s = new UndoStack(3);
    for (let i = 1; i <= 5; i++) s.push(e(i));
    expect(s.entries().map((x) => x.id)).toEqual([3, 4, 5]);
    s.push(e(4));
    expect(s.entries().map((x) => x.id)).toEqual([3, 5, 4]);
  });
});
