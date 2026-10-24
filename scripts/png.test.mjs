import { describe, expect, it } from 'vitest';
import { PNG_SIGNATURE, crc32, encodePng, readPngSize, renderIcon, renderIconPng } from './png.mjs';

describe('png encoder', () => {
  it('writes the PNG signature, an IHDR with the requested size, and ends with IEND', () => {
    const png = encodePng(3, 2, new Uint8Array(3 * 2 * 4).fill(255));
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(png.toString('ascii', 12, 16)).toBe('IHDR');
    expect(readPngSize(png)).toEqual({ width: 3, height: 2 });
    expect(png.subarray(png.length - 8, png.length - 4).toString('ascii')).toBe('IEND');
  });

  it('matches the CRC-32 check value', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('rejects a buffer of the wrong length', () => {
    expect(() => encodePng(2, 2, new Uint8Array(3))).toThrow();
  });

  it('readPngSize returns null for non-PNG bytes', () => {
    expect(readPngSize(Buffer.from('not a png at all, not a png at all, nope'))).toBeNull();
  });
});

describe('icon renderer', () => {
  it('produces a square png of the requested size', () => {
    expect(readPngSize(renderIconPng(64))).toEqual({ width: 64, height: 64 });
  });

  it('rounded icons have transparent corners and an opaque centre-adjacent background', () => {
    const px = renderIcon(64);
    expect(px[3]).toBe(0);
    const o = (10 * 64 + 10) * 4;
    expect(px[o + 3]).toBe(255);
  });

  it('maskable icons are opaque edge to edge', () => {
    const px = renderIcon(64, { maskable: true });
    expect(px[3]).toBe(255);
    expect(px[(64 * 64 - 1) * 4 + 3]).toBe(255);
  });

  it('draws glyph pixels in the accent colour', () => {
    const px = renderIcon(96);
    let accent = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] > 100 && px[i + 1] > 200 && px[i + 3] === 255) accent++;
    expect(accent).toBeGreaterThan(100);
  });
});
