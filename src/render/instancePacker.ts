// Packed per-instance buffers for map-wide instanced meshes, keyed by batch (one batch = one InstancedMesh).
// Pure typed-array bookkeeping, no three: a sim slot owns at most one instance in a packer. Removing an instance swaps the
// last one into the hole, so buffers stay dense and `count` is the draw count; `indexOf(slot)` stays valid for every
// surviving slot. Writing one slot touches only that instance's floats and marks only its batch dirty.

export const MATRIX_STRIDE = 16;
export const TINT_STRIDE = 3;
export const STATE_STRIDE = 4;

export interface Batch {
  key: string;
  count: number;
  capacity: number;
  matrix: Float32Array;
  tint: Float32Array;
  state: Float32Array;
  /** Sim slot stored at each instance index. */
  slots: Int32Array;
  /** Bumped whenever the arrays were reallocated: the GPU buffers must be recreated, not just re-uploaded. */
  generation: number;
}

export interface InstanceData {
  matrix: ArrayLike<number>;
  tint: ArrayLike<number>;
  state: ArrayLike<number>;
}

const INITIAL = 16;

function alloc(key: string, capacity: number, prev?: Batch): Batch {
  const b: Batch = {
    key, count: prev?.count ?? 0, capacity,
    matrix: new Float32Array(capacity * MATRIX_STRIDE), tint: new Float32Array(capacity * TINT_STRIDE),
    state: new Float32Array(capacity * STATE_STRIDE), slots: new Int32Array(capacity).fill(-1), generation: (prev?.generation ?? 0) + 1,
  };
  if (prev) {
    b.matrix.set(prev.matrix.subarray(0, prev.count * MATRIX_STRIDE));
    b.tint.set(prev.tint.subarray(0, prev.count * TINT_STRIDE));
    b.state.set(prev.state.subarray(0, prev.count * STATE_STRIDE));
    b.slots.set(prev.slots.subarray(0, prev.count));
  }
  return b;
}

export class InstancePacker {
  readonly batches = new Map<string, Batch>();
  private readonly where = new Map<number, { key: string; index: number }>();
  private readonly dirtyKeys = new Set<string>();

  get total(): number { return this.where.size; }
  has(slot: number): boolean { return this.where.has(slot); }
  keyOf(slot: number): string | undefined { return this.where.get(slot)?.key; }
  indexOf(slot: number): number { return this.where.get(slot)?.index ?? -1; }
  slotsOf(): number[] { return [...this.where.keys()]; }

  /** Insert or overwrite the instance owned by `slot`. Moving to another batch removes it from the old one first. */
  set(slot: number, key: string, data: InstanceData): void {
    const cur = this.where.get(slot);
    if (cur && cur.key !== key) this.remove(slot);
    let batch = this.batches.get(key);
    if (!batch) { batch = alloc(key, INITIAL); this.batches.set(key, batch); }
    let index = this.where.get(slot)?.index;
    if (index === undefined) {
      if (batch.count === batch.capacity) { batch = alloc(key, batch.capacity * 2, batch); this.batches.set(key, batch); }
      index = batch.count++;
      this.where.set(slot, { key, index });
      batch.slots[index] = slot;
    }
    for (let i = 0; i < MATRIX_STRIDE; i++) batch.matrix[index * MATRIX_STRIDE + i] = data.matrix[i]!;
    for (let i = 0; i < TINT_STRIDE; i++) batch.tint[index * TINT_STRIDE + i] = data.tint[i]!;
    for (let i = 0; i < STATE_STRIDE; i++) batch.state[index * STATE_STRIDE + i] = data.state[i]!;
    this.dirtyKeys.add(key);
  }

  /** Remove the slot's instance, compacting by moving the last instance of its batch into the freed index. */
  remove(slot: number): boolean {
    const cur = this.where.get(slot);
    if (!cur) return false;
    const batch = this.batches.get(cur.key)!;
    const last = batch.count - 1;
    if (cur.index !== last) {
      const moved = batch.slots[last]!;
      batch.matrix.copyWithin(cur.index * MATRIX_STRIDE, last * MATRIX_STRIDE, (last + 1) * MATRIX_STRIDE);
      batch.tint.copyWithin(cur.index * TINT_STRIDE, last * TINT_STRIDE, (last + 1) * TINT_STRIDE);
      batch.state.copyWithin(cur.index * STATE_STRIDE, last * STATE_STRIDE, (last + 1) * STATE_STRIDE);
      batch.slots[cur.index] = moved;
      this.where.get(moved)!.index = cur.index;
    }
    batch.slots[last] = -1;
    batch.count = last;
    this.where.delete(slot);
    this.dirtyKeys.add(cur.key);
    return true;
  }

  /** Keys whose buffers changed since the last call. */
  takeDirty(): string[] { const r = [...this.dirtyKeys]; this.dirtyKeys.clear(); return r; }

  clear(): void {
    for (const k of this.batches.keys()) this.dirtyKeys.add(k);
    for (const b of this.batches.values()) { b.count = 0; b.slots.fill(-1); }
    this.where.clear();
  }
}
