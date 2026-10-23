import { bytesOf, fnv1a } from './hash.ts';
import { REGISTRY, type TypedCtor, type World } from './layers.ts';
import { allocWorld } from './world.ts';
import { PROTOCOL_VERSION } from './protocol.ts';

// Layout (little endian):
//   magic 'IRDN' | formatVersion u16 | protocolVersion u16 | layerCount u16
//   per layer (TLV): nameLen u8 | name utf8 | typeCode u8 | byteLen u32 | bytes
//   trailer: FNV-1a u32 of everything before it
// A protocolVersion that differs from the running one is rejected (a future migrate hook may relax this).
// Unknown layer names are skipped; layers missing from the buffer stay zero. A layer whose type or length
// disagrees with the registry is an error. Decode builds a fresh World and returns it only on full success.

export const MAGIC = 0x4e445249; // 'IRDN'
export const FORMAT_VERSION = 1;

const TYPES: TypedCtor[] = [Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array];
const typeCode = (c: TypedCtor): number => TYPES.indexOf(c);

export class SnapshotError extends Error {}

export function encodeSnapshot(world: World): Uint8Array {
  const enc = new TextEncoder();
  const names = REGISTRY.map((l) => enc.encode(l.name));
  let size = 4 + 2 + 2 + 2 + 4;
  REGISTRY.forEach((l, i) => { size += 1 + names[i]!.length + 1 + 4 + world[l.name].byteLength; });
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  let o = 0;
  dv.setUint32(o, MAGIC, true); o += 4;
  dv.setUint16(o, FORMAT_VERSION, true); o += 2;
  dv.setUint16(o, PROTOCOL_VERSION, true); o += 2;
  dv.setUint16(o, REGISTRY.length, true); o += 2;
  REGISTRY.forEach((l, i) => {
    const nm = names[i]!;
    out[o++] = nm.length;
    out.set(nm, o); o += nm.length;
    out[o++] = typeCode(l.ctor);
    const data = bytesOf(world[l.name]);
    dv.setUint32(o, data.byteLength, true); o += 4;
    out.set(data, o); o += data.byteLength;
  });
  dv.setUint32(o, fnv1a(out.subarray(0, o)), true);
  return out;
}

export function decodeSnapshot(buf: Uint8Array): World {
  if (buf.byteLength < 16) throw new SnapshotError('snapshot truncated');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new SnapshotError('bad magic');
  const body = buf.byteLength - 4;
  if (dv.getUint32(body, true) !== fnv1a(buf.subarray(0, body))) throw new SnapshotError('checksum mismatch');
  const fmt = dv.getUint16(4, true);
  if (fmt > FORMAT_VERSION) throw new SnapshotError(`unsupported format ${fmt}`);
  const proto = dv.getUint16(6, true);
  if (proto !== PROTOCOL_VERSION) throw new SnapshotError(`protocol version ${proto} does not match ${PROTOCOL_VERSION}`);
  const count = dv.getUint16(8, true);
  const world = allocWorld();
  const dec = new TextDecoder();
  const byName = new Map(REGISTRY.map((l) => [l.name as string, l]));
  let o = 10;
  for (let i = 0; i < count; i++) {
    if (o + 1 > body) throw new SnapshotError('snapshot truncated');
    const nl = buf[o++]!;
    if (o + nl + 5 > body) throw new SnapshotError('snapshot truncated');
    const name = dec.decode(buf.subarray(o, o + nl)); o += nl;
    const tc = buf[o++]!;
    const len = dv.getUint32(o, true); o += 4;
    if (o + len > body) throw new SnapshotError('snapshot truncated');
    const info = byName.get(name);
    if (info) {
      if (typeCode(info.ctor) !== tc || len !== info.length * info.ctor.BYTES_PER_ELEMENT) throw new SnapshotError(`layer ${name} shape mismatch`);
      bytesOf(world[info.name]).set(buf.subarray(o, o + len));
    }
    o += len;
  }
  if (o !== body) throw new SnapshotError('trailing bytes');
  return world;
}
