import { describe, expect, it } from 'vitest';
import { WEATHER } from '../sim/layers.ts';
import { TIERS, TIER_TABLE } from './tier.ts';
import {
  ASPECT_IDS, BOKEH_SCALE, DEFAULT_PHOTO, GRAIN_AMPLITUDE, NO_POST_LOOK, aspectRatio, captureSize, cropFov, cropRect, mergeSettings, photoLook, postLook,
} from './photoSettings.ts';

describe('mergeSettings', () => {
  it('clamps every numeric field and wraps time into 0..1', () => {
    const m = mergeSettings(DEFAULT_PHOTO, { time: 1.25, exposure: 99, saturation: -4, vignette: 7, grain: -1, fov: 5, tiltFocus: 3, tiltStrength: 2 });
    expect(m.time).toBeCloseTo(0.25, 12);
    expect(m.exposure).toBe(2); expect(m.saturation).toBe(0); expect(m.vignette).toBe(1); expect(m.grain).toBe(0);
    expect(m.fov).toBe(20); expect(m.tiltFocus).toBe(1); expect(m.tiltStrength).toBe(1);
    expect(mergeSettings(DEFAULT_PHOTO, { time: -0.25 }).time).toBeCloseTo(0.75, 12);
  });
  it('keeps the old value for NaN, a bad weather name or a bad aspect', () => {
    const m = mergeSettings(DEFAULT_PHOTO, { exposure: NaN, weather: 'hail' as never, aspect: '3:2' as never, time: Infinity });
    expect(m.exposure).toBe(1); expect(m.weather).toBe('live'); expect(m.aspect).toBe('view');
    expect(Number.isFinite(m.time)).toBe(true);
  });
  it('does not mutate the base', () => {
    const before = { ...DEFAULT_PHOTO };
    mergeSettings(DEFAULT_PHOTO, { fov: 30 });
    expect(DEFAULT_PHOTO).toEqual(before);
  });
});

describe('photoLook: settings to what the atmosphere applies', () => {
  it('live weather leaves the sim weather alone and auto tilt keeps the camera-driven strength', () => {
    const l = photoLook(DEFAULT_PHOTO);
    expect(l.weather).toBeNull();
    expect(l.tilt).toBeNull();
    expect(l.dayFrac).toBe(DEFAULT_PHOTO.time);
    expect(l.tiltCenter).toBe(0.5);
  });
  it('pins the weather kinds the renderer already knows', () => {
    expect(photoLook({ ...DEFAULT_PHOTO, weather: 'clear' }).weather).toEqual({ kind: WEATHER.CLEAR, intensity: 0 });
    expect(photoLook({ ...DEFAULT_PHOTO, weather: 'rain' }).weather?.kind).toBe(WEATHER.RAIN);
    expect(photoLook({ ...DEFAULT_PHOTO, weather: 'snow' }).weather?.kind).toBe(WEATHER.SNOW);
    expect(photoLook({ ...DEFAULT_PHOTO, weather: 'storm' }).weather).toEqual({ kind: WEATHER.STORM, intensity: 1 });
  });
  it('manual tilt overrides the strength and carries the focus line', () => {
    const l = photoLook({ ...DEFAULT_PHOTO, tiltAuto: false, tiltStrength: 0.9, tiltFocus: 0.25 });
    expect(l.tilt).toBe(0.9);
    expect(l.tiltCenter).toBe(0.25);
  });
});

describe('postLook: look to uniform values', () => {
  it('no look is the game default: centred focus, neutral saturation, tier vignette, no grain, full bokeh', () => {
    expect(postLook(null)).toEqual(NO_POST_LOOK);
    expect(NO_POST_LOOK).toEqual({ tiltCenter: 0.5, saturation: 1, vignette: null, grain: 0, bokeh: BOKEH_SCALE });
  });
  it('maps the sliders to uniforms', () => {
    const p = postLook(photoLook(mergeSettings(DEFAULT_PHOTO, { tiltFocus: 0.3, saturation: 1.4, vignette: 0.6, grain: 0.5, dof: false })));
    expect(p.tiltCenter).toBe(0.3);
    expect(p.saturation).toBe(1.4);
    expect(p.vignette).toBe(0.6);
    expect(p.grain).toBeCloseTo(0.5 * GRAIN_AMPLITUDE, 12);
    expect(p.bokeh).toBe(0);
  });
  it('DOF on gives the bokeh scale the post chain was built with', () => {
    expect(postLook(photoLook({ ...DEFAULT_PHOTO, dof: true })).bokeh).toBe(BOKEH_SCALE);
  });
  it('re-clamps a look that bypassed mergeSettings', () => {
    const p = postLook({ ...photoLook(DEFAULT_PHOTO), saturation: 9, vignette: -1, grain: 5, tiltCenter: 4 });
    expect(p.saturation).toBe(2); expect(p.vignette).toBe(0); expect(p.grain).toBeCloseTo(GRAIN_AMPLITUDE, 12); expect(p.tiltCenter).toBe(1);
  });
});

describe('aspect and crop', () => {
  it('the preset ratios, and "view" follows the screen', () => {
    expect(aspectRatio('16:9', 800, 600)).toBeCloseTo(16 / 9, 12);
    expect(aspectRatio('9:16', 800, 600)).toBeCloseTo(9 / 16, 12);
    expect(aspectRatio('1:1', 800, 600)).toBe(1);
    expect(aspectRatio('4:5', 800, 600)).toBeCloseTo(0.8, 12);
    expect(aspectRatio('2.39:1', 800, 600)).toBeCloseTo(2.39, 12);
    expect(aspectRatio('view', 800, 600)).toBeCloseTo(4 / 3, 12);
  });
  it.each(ASPECT_IDS)('%s crop is centred, inside the view, and has the requested aspect', (id) => {
    for (const [vw, vh] of [[1280, 760], [390, 844], [800, 800]] as const) {
      const a = aspectRatio(id, vw, vh);
      const r = cropRect(a, vw, vh);
      expect(r.w / r.h).toBeCloseTo(a, 9);
      expect(r.x).toBeGreaterThanOrEqual(-1e-9); expect(r.y).toBeGreaterThanOrEqual(-1e-9);
      expect(r.x + r.w).toBeLessThanOrEqual(vw + 1e-9); expect(r.y + r.h).toBeLessThanOrEqual(vh + 1e-9);
      expect(r.x + r.w / 2).toBeCloseTo(vw / 2, 9); expect(r.y + r.h / 2).toBeCloseTo(vh / 2, 9);
      // Largest fit: it touches the view on at least one axis.
      expect(Math.abs(r.w - vw) < 1e-9 || Math.abs(r.h - vh) < 1e-9).toBe(true);
    }
  });
  it('known crops: 9:16 on a landscape screen is a tall strip, 16:9 on a phone is a wide band', () => {
    const tall = cropRect(9 / 16, 1280, 760);
    expect(tall.h).toBe(760); expect(tall.w).toBeCloseTo(427.5, 9); expect(tall.x).toBeCloseTo((1280 - 427.5) / 2, 9);
    const wide = cropRect(16 / 9, 390, 844);
    expect(wide.w).toBe(390); expect(wide.h).toBeCloseTo(219.375, 9); expect(wide.y).toBeCloseTo((844 - 219.375) / 2, 9);
  });
  it('degenerate input does not produce NaN', () => {
    const r = cropRect(NaN, 0, 0);
    expect(Number.isFinite(r.w) && Number.isFinite(r.h)).toBe(true);
  });
  it('cropFov keeps the field of view for a full-height crop and narrows it for a shorter one', () => {
    expect(cropFov(45, 760, 760)).toBeCloseTo(45, 9);
    expect(cropFov(45, 760, 380)).toBeLessThan(45);
    // A half-height crop sees half the tangent of the half-angle.
    expect(Math.tan((cropFov(60, 800, 400) * Math.PI) / 360)).toBeCloseTo(0.5 * Math.tan(Math.PI / 6), 9);
    expect(cropFov(45, 760, 9999)).toBeCloseTo(45, 9);
  });
});

describe('captureSize', () => {
  it('doubles the framed size by default and keeps it when it fits', () => {
    expect(captureSize(640, 360, 2, 4096)).toEqual({ width: 1280, height: 720, clamped: false });
    expect(captureSize(640, 360, 1, 4096)).toEqual({ width: 640, height: 360, clamped: false });
  });
  it('quality is held to 1..2', () => {
    expect(captureSize(100, 100, 5, 4096).width).toBe(200);
    expect(captureSize(100, 100, 0.2, 4096).width).toBe(100);
    expect(captureSize(100, 100, NaN, 4096).width).toBe(200);
  });
  it.each(TIERS)('%s: the long side never exceeds the tier texture ceiling and the aspect survives', (tier) => {
    const max = TIER_TABLE[tier].maxTextureSize;
    for (const [w, h] of [[1280, 760], [390, 693], [3840, 2160], [2160, 3840], [10000, 40]] as const) {
      const s = captureSize(w, h, 2, max);
      expect(Math.max(s.width, s.height)).toBeLessThanOrEqual(max);
      expect(Math.min(s.width, s.height)).toBeGreaterThanOrEqual(1);
      // Rounding each side to a whole pixel moves the ratio by at most half a pixel per side.
      expect(Math.abs(s.width / s.height - w / h) / (w / h)).toBeLessThanOrEqual(0.5 / s.width + 0.5 / s.height + 1e-9);
    }
    expect(captureSize(8000, 4000, 2, max)).toEqual({ width: max, height: max / 2, clamped: true });
  });
  it('flags only the shots that were scaled down', () => {
    expect(captureSize(1024, 512, 1, 1024).clamped).toBe(false);
    expect(captureSize(1024, 512, 2, 1024)).toEqual({ width: 1024, height: 512, clamped: true });
  });
  it('a sliver or a zero size still yields at least one pixel', () => {
    expect(captureSize(0, 0, 2, 1024)).toEqual({ width: 1, height: 1, clamped: false });
  });
});
