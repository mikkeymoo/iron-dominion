/** Binary min-heap of packed int keys, fixed capacity. Pack as `dist * 256 + node` to order by distance then node. */
export class IntHeap {
  private readonly h: Int32Array;
  n = 0;
  constructor(capacity: number) { this.h = new Int32Array(capacity); }

  push(key: number): void {
    const h = this.h;
    let k = this.n++;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (h[p]! <= key) break;
      h[k] = h[p]!;
      k = p;
    }
    h[k] = key;
  }

  pop(): number {
    const h = this.h, top = h[0]!, n = --this.n;
    if (n > 0) {
      const last = h[n]!;
      let k = 0;
      for (;;) {
        let c = 2 * k + 1;
        if (c >= n) break;
        if (c + 1 < n && h[c + 1]! < h[c]!) c++;
        if (last <= h[c]!) break;
        h[k] = h[c]!;
        k = c;
      }
      h[k] = last;
    }
    return top;
  }
}

/**
 * Binary min-heap over (f, g, id) triples, compared lexicographically. The id is a tile index, so equal-cost
 * candidates always pop in the same order: this is what makes every search in this folder deterministic.
 * `pop` returns false when empty and leaves the popped triple in `f`, `g`, `id`.
 */
export class Heap {
  private hf = new Int32Array(1024);
  private hg = new Int32Array(1024);
  private hi = new Int32Array(1024);
  private n = 0;
  f = 0;
  g = 0;
  id = 0;

  get size(): number { return this.n; }
  clear(): void { this.n = 0; }

  push(f: number, g: number, id: number): void {
    if (this.n === this.hf.length) this.grow();
    const hf = this.hf, hg = this.hg, hi = this.hi;
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hf[p]! < f || (hf[p] === f && (hg[p]! < g || (hg[p] === g && hi[p]! <= id)))) break;
      hf[i] = hf[p]!; hg[i] = hg[p]!; hi[i] = hi[p]!;
      i = p;
    }
    hf[i] = f; hg[i] = g; hi[i] = id;
  }

  pop(): boolean {
    if (this.n === 0) return false;
    const hf = this.hf, hg = this.hg, hi = this.hi;
    this.f = hf[0]!; this.g = hg[0]!; this.id = hi[0]!;
    const n = --this.n;
    if (n === 0) return true;
    const f = hf[n]!, g = hg[n]!, id = hi[n]!;
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      const r = c + 1;
      if (r < n && (hf[r]! < hf[c]! || (hf[r] === hf[c] && (hg[r]! < hg[c]! || (hg[r] === hg[c] && hi[r]! < hi[c]!))))) c = r;
      if (f < hf[c]! || (f === hf[c] && (g < hg[c]! || (g === hg[c] && id <= hi[c]!)))) break;
      hf[i] = hf[c]!; hg[i] = hg[c]!; hi[i] = hi[c]!;
      i = c;
    }
    hf[i] = f; hg[i] = g; hi[i] = id;
    return true;
  }

  private grow(): void {
    const len = this.hf.length * 2;
    const nf = new Int32Array(len), ng = new Int32Array(len), ni = new Int32Array(len);
    nf.set(this.hf); ng.set(this.hg); ni.set(this.hi);
    this.hf = nf; this.hg = ng; this.hi = ni;
  }
}
