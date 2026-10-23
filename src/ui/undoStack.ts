export interface UndoEntry {
  /** Sim-assigned journal id from the `accepted` event. */
  id: number;
  /** Treasury the command spent; the refund shown when it is undone. */
  cost: number;
  label: string;
}

/** Rejection reasons after which an undo can never succeed, so the entry is dropped. */
export const DEAD_UNDO = new Set(['consumed', 'not-undoable']);

/**
 * The player's undoable journal ids, newest last. The sim keeps only 16 journal slots, so the stack holds at most 16 and
 * the oldest falls off. An entry leaves the stack when its undo is accepted or the sim says it is consumed; while an
 * undo of an entry is in flight the entry is skipped, so Undo cannot be issued twice for it.
 */
export class UndoStack {
  private items: UndoEntry[] = [];
  private readonly inFlight = new Set<number>();

  constructor(private readonly cap = 16) {}

  get size(): number { return this.items.length; }
  /** The newest entry that has no undo in flight. */
  top(): UndoEntry | undefined {
    for (let i = this.items.length - 1; i >= 0; i--) if (!this.inFlight.has(this.items[i]!.id)) return this.items[i];
    return undefined;
  }
  get canUndo(): boolean { return this.top() !== undefined; }
  entries(): readonly UndoEntry[] { return this.items; }

  /** A command was accepted with a journal id. */
  push(e: UndoEntry): void {
    this.items = this.items.filter((x) => x.id !== e.id);
    this.items.push(e);
    if (this.items.length > this.cap) this.items.shift();
  }

  /** An undo of `id` was sent. */
  begin(id: number): void { this.inFlight.add(id); }

  /** An undo of `id` was accepted: returns the entry that was removed, if it was ours. */
  undone(id: number): UndoEntry | undefined {
    this.inFlight.delete(id);
    const at = this.items.findIndex((x) => x.id === id);
    return at < 0 ? undefined : this.items.splice(at, 1)[0];
  }

  /** An undo of `id` was rejected: drop the entry when the reason is permanent. Returns whether it was dropped. */
  rejected(id: number, reason: string): boolean {
    this.inFlight.delete(id);
    if (!DEAD_UNDO.has(reason)) return false;
    const before = this.items.length;
    this.items = this.items.filter((x) => x.id !== id);
    return this.items.length < before;
  }

  clear(): void { this.items = []; this.inFlight.clear(); }
}
