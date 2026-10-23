import { REGISTRY, type World } from './layers.ts';

const PRIME = 16777619;

/** FNV-1a over the raw bytes of one buffer, 32-bit words first then the byte tail. */
export function fnv1a(buf: Uint8Array, seed = 2166136261): number {
  let h = seed >>> 0;
  const words = buf.byteLength >> 2;
  if (words > 0 && (buf.byteOffset & 3) === 0) {
    const w = new Uint32Array(buf.buffer, buf.byteOffset, words);
    for (let i = 0; i < words; i++) h = Math.imul(h ^ w[i]!, PRIME) >>> 0;
    for (let i = words << 2; i < buf.byteLength; i++) h = Math.imul(h ^ buf[i]!, PRIME) >>> 0;
  } else {
    for (let i = 0; i < buf.byteLength; i++) h = Math.imul(h ^ buf[i]!, PRIME) >>> 0;
  }
  return h;
}

export const bytesOf = (a: ArrayBufferView): Uint8Array => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

/** Hash of every registry layer (name, length and contents), in registry order. Scalars, rng and pools are layers. */
export function hashWorld(world: World, only?: (name: string) => boolean): number {
  let h = 2166136261;
  for (const l of REGISTRY) {
    if (only && !only(l.name)) continue;
    for (let i = 0; i < l.name.length; i++) h = Math.imul(h ^ l.name.charCodeAt(i), PRIME) >>> 0;
    h = fnv1a(bytesOf(world[l.name]), h);
  }
  return h >>> 0;
}
