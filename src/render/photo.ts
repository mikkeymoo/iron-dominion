// Photo mode controller: settings, enter/exit, and the capture sequence. The renderer is reached only through hooks, so the
// state machine runs under test without a GPU. The capture runs inside the frame loop (`service()` after the frame's render),
// never from an event handler, so it cannot interleave with a frame and a WebGL canvas still holds its pixels when encoded.
import {
  DEFAULT_PHOTO, MAX_QUALITY, aspectRatio, captureSize, cropFov, cropRect, mergeSettings, photoLook,
  type PhotoLook, type PhotoSettings, type Rect,
} from './photoSettings.ts';

export interface PhotoHooks {
  viewSize(): { w: number; h: number };
  maxTexture(): number;
  currentDayFrac(): number;
  baseFov(): number;
  /** Push the look and field of view to the renderer; `null, null` restores the game's own. */
  applyLook(look: PhotoLook | null, fov: number | null): void;
  /** Resize the output to width x height, set the camera aspect and field of view, and draw the frame. */
  renderAt(width: number, height: number, aspect: number, fovDeg: number): void;
  /** Undo renderAt and draw one frame at the live size. */
  restore(): void;
  /** Start encoding the canvas as PNG now (the pixels are read when called); null when the browser cannot. */
  encode(): Promise<Blob | null>;
}

export interface PhotoResult { width: number; height: number; bytes: number }

export interface PhotoController {
  readonly active: boolean;
  readonly settings: PhotoSettings;
  readonly capturing: boolean;
  /** The last captured PNG, kept so the UI can save or share it. */
  readonly lastBlob: Blob | null;
  enter(): void;
  exit(): void;
  set(patch: Partial<PhotoSettings>): PhotoSettings;
  reset(): void;
  /** Frame crop inside the live view, for the on-screen guide. */
  frame(): Rect;
  /** Capture the framed shot. Resolves on the next frame; rejects when photo mode is off. */
  capture(quality?: number): Promise<PhotoResult>;
  /** Call once per frame after the render. */
  service(): void;
  subscribe(fn: () => void): () => void;
}

export function createPhoto(hooks: PhotoHooks): PhotoController {
  let active = false;
  let settings: PhotoSettings = { ...DEFAULT_PHOTO };
  let pending: { quality: number; promise: Promise<PhotoResult>; resolve(r: PhotoResult): void; reject(e: unknown): void } | null = null;
  let capturing = false;
  let lastBlob: Blob | null = null;
  const listeners = new Set<() => void>();
  const emit = (): void => { for (const fn of listeners) fn(); };
  const push = (): void => hooks.applyLook(photoLook(settings), settings.fov);

  const frame = (): Rect => {
    const v = hooks.viewSize();
    return cropRect(aspectRatio(settings.aspect, v.w, v.h), v.w, v.h);
  };

  const run = async (job: NonNullable<typeof pending>): Promise<void> => {
    capturing = true;
    try {
      const v = hooks.viewSize();
      const rect = cropRect(aspectRatio(settings.aspect, v.w, v.h), v.w, v.h);
      const size = captureSize(rect.w, rect.h, job.quality, hooks.maxTexture());
      hooks.renderAt(size.width, size.height, rect.w / rect.h, cropFov(settings.fov, v.h, rect.h));
      let encoded: Promise<Blob | null>;
      try { encoded = hooks.encode(); } finally { hooks.restore(); }
      const blob = await encoded;
      if (!blob || blob.size === 0) throw new Error('The browser could not encode the frame as PNG');
      lastBlob = blob;
      job.resolve({ width: size.width, height: size.height, bytes: blob.size });
    } catch (e) {
      job.reject(e);
    } finally {
      capturing = false;
      emit();
    }
  };

  return {
    get active() { return active; },
    get settings() { return settings; },
    get capturing() { return capturing || pending !== null; },
    get lastBlob() { return lastBlob; },
    enter() {
      if (active) return;
      active = true;
      settings = { ...DEFAULT_PHOTO, fov: hooks.baseFov(), time: hooks.currentDayFrac() };
      push();
      emit();
    },
    exit() {
      if (!active) return;
      active = false;
      hooks.applyLook(null, null);
      if (pending) { const p = pending; pending = null; p.reject(new Error('Photo mode closed before the capture ran')); }
      emit();
    },
    set(patch) {
      settings = mergeSettings(settings, patch);
      if (active) push();
      emit();
      return settings;
    },
    reset() {
      settings = { ...DEFAULT_PHOTO, fov: hooks.baseFov(), time: hooks.currentDayFrac() };
      if (active) push();
      emit();
    },
    frame,
    capture(quality = MAX_QUALITY) {
      if (!active) return Promise.reject(new Error('Photo mode is not active'));
      if (pending) return pending.promise;
      let resolve!: (r: PhotoResult) => void, reject!: (e: unknown) => void;
      const promise = new Promise<PhotoResult>((res, rej) => { resolve = res; reject = rej; });
      pending = { quality, promise, resolve, reject };
      emit();
      return promise;
    },
    service() {
      if (!pending || capturing) return;
      const job = pending;
      pending = null;
      void run(job);
    },
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
}
