// Ring-buffer emitter bookkeeping for the GPU particle system. The CPU owns the write index; the GPU only ever reads a
// particle's own element, so there is nothing for a compute kernel (or WebGL2 transform feedback) to race on. Pure.
//
// The ring wraps at `limit`, not at `capacity`: the draw call covers [0, filled) and `filled` never exceeds `limit`, so the
// vertex work tracks the live particle count instead of the tier's ceiling. `limit` starts small and doubles (up to
// `capacity`) only when a write would overwrite a particle that is still alive.

export class ParticleRing {
  /** Next slot to write. */
  head = 0;
  /** Slots in use: emitted so far, capped at `limit` once the ring has wrapped. */
  filled = 0;
  limit: number;

  constructor(readonly capacity: number, initialLimit = capacity) {
    if (!(capacity >= 1)) throw new Error('ParticleRing needs a capacity of at least 1');
    this.limit = Math.max(1, Math.min(capacity, Math.floor(initialLimit)));
  }

  /** Reserve one slot (no allocation). */
  next(): number {
    const s = this.head;
    this.head = s + 1 >= this.limit ? 0 : s + 1;
    if (this.filled < this.limit) this.filled = Math.min(this.limit, Math.max(this.filled, s + 1));
    return s;
  }

  /** True when the next write would land on an occupied slot and the ring is allowed to grow instead. */
  canGrow(): boolean { return this.filled >= this.limit && this.limit < this.capacity; }

  /** Double the limit and continue writing in the new space. Returns the previous limit. */
  grow(): number {
    const old = this.limit;
    this.limit = Math.min(this.capacity, old * 2);
    this.head = old;
    return old;
  }

  /**
   * Reserve `count` slots. Returns the slots in write order; when `count` exceeds the limit only the newest
   * `limit` survive (older ones in the same call are overwritten, never indexed out of range).
   */
  take(count: number): number[] {
    const n = Math.max(0, Math.floor(count));
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(this.next());
    return out.length > this.limit ? out.slice(out.length - this.limit) : out;
  }

  /** Contiguous [start, end) ranges covering slots written since `since` (a previous head), at most two when wrapped. */
  rangesSince(since: number, count: number): [number, number][] {
    const n = Math.min(this.limit, Math.max(0, count));
    if (n === 0) return [];
    if (n >= this.limit) return [[0, this.limit]];
    const end = since + n;
    if (end <= this.limit) return [[since, end]];
    return [[since, this.limit], [0, end - this.limit]];
  }
}

/** Deterministic per-emitter fractional accumulator: how many whole particles to emit after `dt` at `rate` per second. */
export function accumulate(carry: number, rate: number, dt: number): { emit: number; carry: number } {
  const total = carry + Math.max(0, rate) * Math.max(0, dt);
  const emit = Math.floor(total);
  return { emit, carry: total - emit };
}
