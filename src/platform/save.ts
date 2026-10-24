import { fnv1a, hashWorld } from '../sim/hash.ts';
import { S } from '../sim/layers.ts';
import { PROTOCOL_VERSION } from '../sim/protocol.ts';
import { decodeSnapshot, snapshotProtocol } from '../sim/snapshot.ts';
import { parseJournal, type JournalData } from './journal.ts';

// Container (little endian):
//   magic 'IDSV' | containerVersion u16 | created f64 (ms since epoch) | metaLen u32 | meta JSON utf8
//   | payloadLen u32 | checksum u32 (FNV-1a of the compressed payload) | payload = gzip(sim snapshot)
// The sim snapshot carries its own magic, protocol version and checksum; parseSave runs the snapshot decoder on the
// main thread (it is DOM-free) so nothing is replaced until the whole file has validated.

export const SAVE_MAGIC = 'IDSV';
export const CONTAINER_VERSION = 1;
export const FILE_EXTENSION = '.irondominion';
/** Upper bound on the decompressed snapshot; stops a tiny file from inflating without limit. */
export const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const MAX_META_BYTES = 256 * 1024;
const FIXED = 4 + 2 + 8 + 4;

export interface SaveMeta {
  name: string;
  population: number;
  treasury: number;
  day: number;
  thumbnail?: string;
  /** Sim protocol version the snapshot was made with; absent in saves from before it was recorded. */
  protocol?: number;
  /** The event journal (platform/journal.ts) at the time of the save; absent in saves from before it existed. Not part of the sim state or its hash. */
  journal?: JournalData;
}

export interface Codec {
  compress(data: Uint8Array): Promise<Uint8Array>;
  decompress(data: Uint8Array, maxBytes: number): Promise<Uint8Array>;
}

async function collect(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel().catch(() => undefined); throw new Error('decompressed data too large'); }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}

async function pipe(data: Uint8Array, t: CompressionStream | DecompressionStream, maxBytes: number): Promise<Uint8Array> {
  const writer = t.writable.getWriter();
  const written = writer.write(data as unknown as BufferSource).then(() => writer.close());
  written.catch(() => undefined);
  const out = await collect(t.readable as ReadableStream<Uint8Array>, maxBytes);
  await written;
  return out;
}

/** Browser codec: gzip through CompressionStream / DecompressionStream. */
export const browserCodec: Codec = {
  compress: (data) => pipe(data, new CompressionStream('gzip'), Number.MAX_SAFE_INTEGER),
  decompress: (data, maxBytes) => pipe(data, new DecompressionStream('gzip'), maxBytes),
};

export type SaveErrorCode = 'magic' | 'version' | 'old' | 'truncated' | 'checksum' | 'meta' | 'gzip' | 'snapshot';
export const OLD_VERSION_REASON = 'This save was made by an older version of the game and cannot be loaded.';
export interface ParsedSave { meta: SaveMeta; created: number; snapshot: Uint8Array }
export type ParseResult = { ok: true; value: ParsedSave } | { ok: false; code: SaveErrorCode; reason: string };

const bad = (code: SaveErrorCode, reason: string): ParseResult => ({ ok: false, code, reason });

// fnv1a reads 32-bit words only when the view is aligned, so the checksum is always taken over an aligned copy.
const aligned = (b: Uint8Array): Uint8Array => ((b.byteOffset & 3) === 0 ? b : b.slice());

export async function buildSave(snapshot: Uint8Array, meta: SaveMeta, created: number, codec: Codec = browserCodec): Promise<Uint8Array> {
  const payload = aligned(await codec.compress(snapshot));
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  const out = new Uint8Array(FIXED + metaBytes.length + 8 + payload.length);
  const dv = new DataView(out.buffer);
  let o = 0;
  out.set(new TextEncoder().encode(SAVE_MAGIC), o); o += 4;
  dv.setUint16(o, CONTAINER_VERSION, true); o += 2;
  dv.setFloat64(o, created, true); o += 8;
  dv.setUint32(o, metaBytes.length, true); o += 4;
  out.set(metaBytes, o); o += metaBytes.length;
  dv.setUint32(o, payload.length, true); o += 4;
  dv.setUint32(o, fnv1a(payload), true); o += 4;
  out.set(payload, o);
  return out;
}

function readMeta(v: unknown): SaveMeta | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const m = v as Record<string, unknown>;
  if (typeof m.name !== 'string' || typeof m.population !== 'number' || typeof m.treasury !== 'number' || typeof m.day !== 'number') return undefined;
  if (m.thumbnail !== undefined && typeof m.thumbnail !== 'string') return undefined;
  const meta: SaveMeta = { name: m.name.slice(0, 80), population: m.population, treasury: m.treasury, day: m.day };
  if (typeof m.thumbnail === 'string') meta.thumbnail = m.thumbnail;
  if (typeof m.protocol === 'number') meta.protocol = m.protocol;
  const journal = parseJournal(m.journal);
  if (journal) meta.journal = journal;
  return meta;
}

/** Validates the container and inflates the payload, without decoding the snapshot. Never throws. */
async function openContainer(bytes: Uint8Array, codec: Codec): Promise<ParseResult> {
  if (bytes.byteLength < 4 || String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!) !== SAVE_MAGIC) return bad('magic', 'not an Iron Dominion save file');
  if (bytes.byteLength < FIXED) return bad('truncated', 'save file is truncated');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint16(4, true);
  if (version > CONTAINER_VERSION) return bad('version', `save format ${version} is newer than this game understands (${CONTAINER_VERSION})`);
  if (version < 1) return bad('version', `unknown save format ${version}`);
  const created = dv.getFloat64(6, true);
  const metaLen = dv.getUint32(14, true);
  if (metaLen > MAX_META_BYTES) return bad('meta', 'save header is malformed');
  let o = FIXED;
  if (o + metaLen + 8 > bytes.byteLength) return bad('truncated', 'save file is truncated');
  let meta: SaveMeta | undefined;
  try { meta = readMeta(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(o, o + metaLen)))); } catch { meta = undefined; }
  if (!meta) return bad('meta', 'save header is malformed');
  o += metaLen;
  const payloadLen = dv.getUint32(o, true); o += 4;
  const checksum = dv.getUint32(o, true); o += 4;
  if (o + payloadLen !== bytes.byteLength) return bad(o + payloadLen > bytes.byteLength ? 'truncated' : 'checksum', o + payloadLen > bytes.byteLength ? 'save file is truncated' : 'save file has trailing data');
  const payload = bytes.slice(o, o + payloadLen);
  if (fnv1a(payload) !== checksum) return bad('checksum', 'save file is damaged (checksum mismatch)');
  let snapshot: Uint8Array;
  try { snapshot = await codec.decompress(payload, MAX_SNAPSHOT_BYTES); } catch (e) { return bad('gzip', `save data could not be decompressed: ${e instanceof Error ? e.message : String(e)}`); }
  return { ok: true, value: { meta, created, snapshot } };
}

/** Validates the container, then the sim snapshot inside. Never throws and never mutates anything. */
export async function parseSave(bytes: Uint8Array, codec: Codec = browserCodec): Promise<ParseResult> {
  const r = await openContainer(bytes, codec);
  if (!r.ok) return r;
  const proto = snapshotProtocol(r.value.snapshot);
  if (proto !== undefined && proto < PROTOCOL_VERSION) return { ok: false, code: 'old', reason: OLD_VERSION_REASON };
  try { decodeSnapshot(r.value.snapshot); } catch (e) { return bad('snapshot', e instanceof Error ? e.message : String(e)); }
  return r;
}

/** Protocol version a stored save was made with, or undefined when the file is not a readable save. Used to mark old slots in the list. */
export async function saveProtocol(bytes: Uint8Array, codec: Codec = browserCodec): Promise<number | undefined> {
  const r = await openContainer(bytes, codec);
  return r.ok ? snapshotProtocol(r.value.snapshot) : undefined;
}

/** True for a slot written by an older protocol: the sim refuses it, so the slot list greys it out instead of offering a failing load. */
export const isOldVersion = (protocol: number | undefined): boolean => protocol !== undefined && protocol < PROTOCOL_VERSION;

/** Tick, world hash and headline stats of a snapshot, read through the decoder the worker uses (throws SnapshotError). */
export function inspectSnapshot(snapshot: Uint8Array): { tick: number; hash: number; population: number; treasury: number; day: number } {
  const world = decodeSnapshot(snapshot);
  const sc = world.scalars;
  return { tick: sc[S.tick]!, hash: hashWorld(world), population: sc[S.population]!, treasury: sc[S.treasury]!, day: sc[S.day]! };
}

export function saveFileName(name: string): string {
  const base = name.replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-').slice(0, 40) || 'city';
  return `${base}${FILE_EXTENSION}`;
}

/** Offers the container as a download. Browser only. */
export function downloadSave(bytes: Uint8Array, name: string, doc: Document = document): void {
  const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: 'application/octet-stream' }));
  const a = doc.createElement('a');
  a.href = url;
  a.download = saveFileName(name);
  a.rel = 'noopener';
  doc.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function readFileBytes(file: Blob): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}
