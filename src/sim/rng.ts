// sfc32 over a Uint32Array(4) so the whole generator state lives in the world registry (hashed and snapshotted).
// Integer-only: no Math.* in the hot path.

export function seedRng(s: Uint32Array, seed: number): void {
  let x = seed >>> 0;
  for (let i = 0; i < 4; i++) {
    // splitmix32 expands one seed word into four state words.
    x = (x + 0x9e3779b9) >>> 0;
    let z = x;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    s[i] = (z ^ (z >>> 16)) >>> 0;
  }
  for (let i = 0; i < 12; i++) nextU32(s);
}

export function nextU32(s: Uint32Array): number {
  const t = (((s[0]! + s[1]!) >>> 0) + s[3]!) >>> 0;
  s[3] = (s[3]! + 1) >>> 0;
  s[0] = s[1]! ^ (s[1]! >>> 9);
  s[1] = (s[2]! + (s[2]! << 3)) >>> 0;
  s[2] = (((s[2]! << 21) | (s[2]! >>> 11)) + t) >>> 0;
  return t;
}

/** Uniform in [0, 1). */
export function nextFloat(s: Uint32Array): number {
  return nextU32(s) / 4294967296;
}

/** Uniform integer in [0, n) for n < 2^21 (product stays exact in a double). */
export function nextInt(s: Uint32Array, n: number): number {
  return Math.floor((nextU32(s) * n) / 4294967296);
}
