// Photo-mode settings and the pure maths around them: the look handed to the atmosphere and post chain, the aspect-ratio crop,
// and the capture size. No three, no DOM.
import { parseWeatherParam, type WeatherName } from './fx/weatherMap.ts';

export type PhotoWeather = 'live' | WeatherName;
export const PHOTO_WEATHERS: readonly PhotoWeather[] = ['live', 'clear', 'rain', 'snow', 'storm'];

export type AspectId = 'view' | '16:9' | '9:16' | '1:1' | '4:5' | '2.39:1';
export const ASPECT_IDS: readonly AspectId[] = ['view', '16:9', '9:16', '1:1', '4:5', '2.39:1'];
export const ASPECT_LABELS: Record<AspectId, string> = { view: 'Screen', '16:9': '16:9', '9:16': '9:16 phone', '1:1': '1:1', '4:5': '4:5', '2.39:1': 'Cinema' };
const ASPECT_VALUE: Record<Exclude<AspectId, 'view'>, number> = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5, '2.39:1': 2.39 };

export interface PhotoSettings {
  /** Day fraction, 0 = midnight, 0.5 = noon. */
  time: number;
  weather: PhotoWeather;
  /** Vertical position of the sharp band, 0 = top of frame, 1 = bottom. */
  tiltFocus: number;
  tiltAuto: boolean;
  tiltStrength: number;
  dof: boolean;
  exposure: number;
  saturation: number;
  vignette: number;
  grain: number;
  aspect: AspectId;
  fov: number;
  /** Leave the sim running while posing the shot. */
  keepRunning: boolean;
}

export const FOV_RANGE = { min: 20, max: 75 } as const;
export const EXPOSURE_RANGE = { min: 0.4, max: 2 } as const;
export const SATURATION_RANGE = { min: 0, max: 2 } as const;
export const MAX_QUALITY = 2;
/** Grain slider 1.0 adds this much noise amplitude to the display-space colour. */
export const GRAIN_AMPLITUDE = 0.1;

export const DEFAULT_PHOTO: PhotoSettings = {
  time: 0.5, weather: 'live', tiltFocus: 0.5, tiltAuto: true, tiltStrength: 0.6, dof: true, exposure: 1, saturation: 1,
  vignette: 0.3, grain: 0, aspect: 'view', fov: 45, keepRunning: false,
};

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** Merge a partial change into settings, clamping every field so a bad slider value or debug call cannot reach a shader. */
export function mergeSettings(base: PhotoSettings, patch: Partial<PhotoSettings>): PhotoSettings {
  const m = { ...base, ...patch };
  const t = num(m.time, base.time);
  return {
    time: t - Math.floor(t),
    weather: PHOTO_WEATHERS.includes(m.weather) ? m.weather : base.weather,
    tiltFocus: clamp(num(m.tiltFocus, base.tiltFocus), 0, 1),
    tiltAuto: !!m.tiltAuto,
    tiltStrength: clamp(num(m.tiltStrength, base.tiltStrength), 0, 1),
    dof: !!m.dof,
    exposure: clamp(num(m.exposure, base.exposure), EXPOSURE_RANGE.min, EXPOSURE_RANGE.max),
    saturation: clamp(num(m.saturation, base.saturation), SATURATION_RANGE.min, SATURATION_RANGE.max),
    vignette: clamp(num(m.vignette, base.vignette), 0, 1),
    grain: clamp(num(m.grain, base.grain), 0, 1),
    aspect: ASPECT_IDS.includes(m.aspect) ? m.aspect : base.aspect,
    fov: clamp(num(m.fov, base.fov), FOV_RANGE.min, FOV_RANGE.max),
    keepRunning: !!m.keepRunning,
  };
}

/** What the atmosphere manager applies while photo mode is on. `null` fields mean "leave the game's own value". */
export interface PhotoLook {
  dayFrac: number;
  weather: { kind: number; intensity: number } | null;
  exposure: number;
  /** Tilt-shift strength 0..1, or null to keep the camera-driven value. */
  tilt: number | null;
  tiltCenter: number;
  dof: boolean;
  saturation: number;
  vignette: number;
  grain: number;
}

export function photoLook(s: PhotoSettings): PhotoLook {
  return {
    dayFrac: s.time,
    weather: s.weather === 'live' ? null : parseWeatherParam(s.weather),
    exposure: s.exposure,
    tilt: s.tiltAuto ? null : s.tiltStrength,
    tiltCenter: s.tiltFocus,
    dof: s.dof,
    saturation: s.saturation,
    vignette: s.vignette,
    grain: s.grain,
  };
}

/** Values written to the post chain's uniforms. `vignette: null` keeps the tier's own vignette. */
export interface PostLook { tiltCenter: number; saturation: number; vignette: number | null; grain: number; bokeh: number }

export const BOKEH_SCALE = 1.1;
export const NO_POST_LOOK: PostLook = { tiltCenter: 0.5, saturation: 1, vignette: null, grain: 0, bokeh: BOKEH_SCALE };

/** Photo look -> uniform values (grain slider scaled to colour amplitude, DOF toggle to bokeh scale). Null look = the game's defaults. */
export function postLook(look: PhotoLook | null): PostLook {
  if (!look) return NO_POST_LOOK;
  return {
    tiltCenter: clamp(look.tiltCenter, 0, 1),
    saturation: clamp(look.saturation, SATURATION_RANGE.min, SATURATION_RANGE.max),
    vignette: clamp(look.vignette, 0, 1),
    grain: clamp(look.grain, 0, 1) * GRAIN_AMPLITUDE,
    bokeh: look.dof ? BOKEH_SCALE : 0,
  };
}

/** Width over height of the chosen frame; `view` follows the screen. */
export function aspectRatio(id: AspectId, viewW: number, viewH: number): number {
  return id === 'view' ? Math.max(1, viewW) / Math.max(1, viewH) : ASPECT_VALUE[id];
}

export interface Rect { x: number; y: number; w: number; h: number }

/** Largest centred rectangle of `aspect` that fits in the view. */
export function cropRect(aspect: number, viewW: number, viewH: number): Rect {
  const vw = Math.max(1, viewW), vh = Math.max(1, viewH);
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : vw / vh;
  const w = Math.min(vw, vh * a);
  const h = w / a;
  return { x: (vw - w) / 2, y: (vh - h) / 2, w, h };
}

/** Vertical field of view of a frame that shows only `cropH` of a `viewH`-tall view shot at `fovDeg`, so the capture matches the framed crop. */
export function cropFov(fovDeg: number, viewH: number, cropH: number): number {
  const f = clamp(cropH / Math.max(1, viewH), 0, 1);
  return (2 * Math.atan(f * Math.tan((fovDeg * Math.PI) / 360)) * 180) / Math.PI;
}

export interface CaptureSize { width: number; height: number; clamped: boolean }

/**
 * Output pixels: the framed crop in CSS pixels times `quality` (1..2), scaled down, keeping the aspect, until the long side fits
 * `maxTexture` (the tier's texture ceiling).
 */
export function captureSize(cropW: number, cropH: number, quality: number, maxTexture: number): CaptureSize {
  const q = clamp(num(quality, MAX_QUALITY), 1, MAX_QUALITY);
  const max = Math.max(1, Math.floor(maxTexture));
  let w = Math.max(1, cropW * q), h = Math.max(1, cropH * q);
  const long = Math.max(w, h);
  const clamped = long > max;
  if (clamped) { const k = max / long; w *= k; h *= k; }
  return { width: clamp(Math.round(w), 1, max), height: clamp(Math.round(h), 1, max), clamped };
}
