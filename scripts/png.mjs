// Dependency-free PNG encoder and icon rasterizer (node:zlib only). Used by build.mjs to write the PWA/TWA icons.
import { deflateSync } from 'node:zlib';

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** rgba is width*height*4 bytes, row-major, straight (non-premultiplied) alpha. */
export function encodePng(width, height, rgba) {
  if (rgba.length !== width * height * 4) throw new Error(`encodePng: expected ${width * height * 4} bytes, got ${rgba.length}`);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Width and height from a PNG's IHDR, or null when the bytes are not a PNG. */
export function readPngSize(bytes) {
  const b = Buffer.from(bytes);
  if (b.length < 33 || !b.subarray(0, 8).equals(PNG_SIGNATURE) || b.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

const BG = [0x0b, 0x11, 0x16];
const FG = [0x7b, 0xe8, 0xdf];
// Geometry in the 192-unit space of public/icon.svg.
const HEX = [[96, 24], [158, 60], [158, 132], [96, 168], [34, 132], [34, 60]];
const HEX_HALF = 4;
const D_HALF = 6;
const D_SEGMENTS = [[68, 65, 68, 127], [90, 65, 106, 65], [90, 65, 90, 127], [90, 127, 106, 127]];
const D_ARC = { cx: 106, cy: 96, r: 31 };

function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function inGlyph(x, y) {
  for (let i = 0; i < HEX.length; i++) {
    const a = HEX[i], b = HEX[(i + 1) % HEX.length];
    if (segDist(x, y, a[0], a[1], b[0], b[1]) <= HEX_HALF) return true;
  }
  for (const s of D_SEGMENTS) if (segDist(x, y, s[0], s[1], s[2], s[3]) <= D_HALF) return true;
  return x >= D_ARC.cx && Math.abs(Math.hypot(x - D_ARC.cx, y - D_ARC.cy) - D_ARC.r) <= D_HALF;
}

function inRoundedSquare(x, y, size, radius) {
  const cx = Math.min(Math.max(x, radius), size - radius), cy = Math.min(Math.max(y, radius), size - radius);
  return Math.hypot(x - cx, y - cy) <= radius;
}

/**
 * Renders the game icon at size x size. `maskable` fills the whole square (the OS applies its own mask) and shrinks the
 * glyph into the 80% safe zone; otherwise the square is rounded with transparent corners like public/icon.svg.
 */
export function renderIcon(size, { maskable = false } = {}) {
  const rgba = new Uint8Array(size * size * 4);
  const ss = 3;
  const scale = 192 / size;
  const glyphScale = maskable ? 0.7 : 1;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bg = 0, fg = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const ux = (px + (sx + 0.5) / ss) * scale, uy = (py + (sy + 0.5) / ss) * scale;
          if (maskable || inRoundedSquare(ux, uy, 192, 38)) {
            bg++;
            if (inGlyph(96 + (ux - 96) / glyphScale, 96 + (uy - 96) / glyphScale)) fg++;
          }
        }
      }
      if (bg === 0) continue;
      const f = fg / bg;
      const o = (py * size + px) * 4;
      rgba[o] = Math.round(BG[0] + (FG[0] - BG[0]) * f);
      rgba[o + 1] = Math.round(BG[1] + (FG[1] - BG[1]) * f);
      rgba[o + 2] = Math.round(BG[2] + (FG[2] - BG[2]) * f);
      rgba[o + 3] = Math.round((255 * bg) / (ss * ss));
    }
  }
  return rgba;
}

export function renderIconPng(size, opts) {
  return encodePng(size, size, renderIcon(size, opts));
}
