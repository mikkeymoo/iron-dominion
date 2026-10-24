import { describe, expect, it, vi } from 'vitest';
import { createPhoto, type PhotoHooks } from './photo.ts';
import { chooseSaveMethod, photoFileName } from './photoSave.ts';

function hooks(over: Partial<PhotoHooks> = {}): PhotoHooks & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    viewSize: () => ({ w: 1280, h: 760 }),
    maxTexture: () => 4096,
    currentDayFrac: () => 0.33,
    baseFov: () => 45,
    applyLook: vi.fn(() => { calls.push('look'); }),
    renderAt: vi.fn(() => { calls.push('renderAt'); }),
    restore: vi.fn(() => { calls.push('restore'); }),
    encode: vi.fn(() => { calls.push('encode'); return Promise.resolve(new Blob([new Uint8Array(1234)], { type: 'image/png' })); }),
    ...over,
  };
}

describe('photo controller', () => {
  it('enter starts from the displayed time and the base fov, pushes the look, and notifies', () => {
    const h = hooks();
    const p = createPhoto(h);
    const seen = vi.fn();
    p.subscribe(seen);
    expect(p.active).toBe(false);
    p.enter();
    expect(p.active).toBe(true);
    expect(p.settings.time).toBe(0.33);
    expect(p.settings.fov).toBe(45);
    expect(h.applyLook).toHaveBeenCalledWith(expect.objectContaining({ dayFrac: 0.33, weather: null }), 45);
    expect(seen).toHaveBeenCalled();
  });

  it('set clamps, pushes the look while active, and reset returns to the defaults', () => {
    const h = hooks();
    const p = createPhoto(h);
    p.enter();
    p.set({ exposure: 50, weather: 'snow', fov: 60 });
    expect(p.settings.exposure).toBe(2);
    expect(h.applyLook).toHaveBeenLastCalledWith(expect.objectContaining({ exposure: 2, weather: expect.objectContaining({ kind: 2 }) }), 60);
    p.reset();
    expect(p.settings.exposure).toBe(1);
    expect(p.settings.weather).toBe('live');
    expect(p.settings.fov).toBe(45);
  });

  it('exit hands the look back to the game', () => {
    const h = hooks();
    const p = createPhoto(h);
    p.enter();
    p.exit();
    expect(p.active).toBe(false);
    expect(h.applyLook).toHaveBeenLastCalledWith(null, null);
    p.exit();
    expect(h.applyLook).toHaveBeenCalledTimes(2);
  });

  it('restores the view and rejects when renderAt throws, and a later capture still works', async () => {
    let fail = true;
    const h = hooks({ renderAt: vi.fn(() => { h.calls.push('renderAt'); if (fail) throw new Error('context lost'); }) });
    const p = createPhoto(h);
    p.enter();
    const first = p.capture();
    p.service();
    await expect(first).rejects.toThrow(/context lost/);
    expect(h.restore).toHaveBeenCalledTimes(1);
    expect(h.encode).not.toHaveBeenCalled();
    expect(p.capturing).toBe(false);
    fail = false;
    const second = p.capture();
    p.service();
    await expect(second).resolves.toMatchObject({ bytes: 1234 });
    expect(h.restore).toHaveBeenCalledTimes(2);
  });

  it('capture rejects when photo mode is off', async () => {
    await expect(createPhoto(hooks()).capture()).rejects.toThrow(/not active/);
  });

  it('capture waits for the frame loop, renders at 2x the framed size, encodes before restoring, and reports the bytes', async () => {
    const h = hooks();
    const p = createPhoto(h);
    p.enter();
    p.set({ aspect: '16:9' });
    const done = p.capture();
    expect(h.renderAt).not.toHaveBeenCalled();
    expect(p.capturing).toBe(true);
    p.service();
    const r = await done;
    // 16:9 in a 1280x760 view: 1280 wide, 720 high, doubled.
    expect(r).toEqual({ width: 2560, height: 1440, bytes: 1234 });
    expect(h.renderAt).toHaveBeenCalledWith(2560, 1440, expect.closeTo(16 / 9, 9), expect.closeTo((2 * Math.atan((720 / 760) * Math.tan((45 * Math.PI) / 360)) * 180) / Math.PI, 9));
    expect(h.calls.filter((c) => c !== 'look')).toEqual(['renderAt', 'encode', 'restore']);
    expect(p.lastBlob?.size).toBe(1234);
    expect(p.capturing).toBe(false);
  });

  it('clamps to the tier texture ceiling', async () => {
    const h = hooks({ maxTexture: () => 1024 });
    const p = createPhoto(h);
    p.enter();
    const done = p.capture();
    p.service();
    const r = await done;
    expect(Math.max(r.width, r.height)).toBe(1024);
    expect(h.renderAt).toHaveBeenCalledWith(r.width, r.height, expect.any(Number), expect.any(Number));
  });

  it('a second capture while one is pending shares it', async () => {
    const h = hooks();
    const p = createPhoto(h);
    p.enter();
    const a = p.capture(), b = p.capture();
    expect(a).toBe(b);
    p.service();
    await a;
    expect(h.encode).toHaveBeenCalledTimes(1);
  });

  it('restores the live view and rejects when encoding throws or yields nothing', async () => {
    const boom = hooks({ encode: vi.fn(() => { throw new Error('toBlob blew up'); }) });
    const p = createPhoto(boom);
    p.enter();
    const failing = p.capture();
    p.service();
    await expect(failing).rejects.toThrow('toBlob blew up');
    expect(boom.restore).toHaveBeenCalledTimes(1);
    expect(p.capturing).toBe(false);

    const empty = hooks({ encode: vi.fn(() => Promise.resolve(null)) });
    const q = createPhoto(empty);
    q.enter();
    const none = q.capture();
    q.service();
    await expect(none).rejects.toThrow(/PNG/);
    expect(empty.restore).toHaveBeenCalledTimes(1);
  });

  it('closing photo mode rejects a capture that has not run', async () => {
    const p = createPhoto(hooks());
    p.enter();
    const pending = p.capture();
    p.exit();
    await expect(pending).rejects.toThrow(/closed/);
    p.service();
  });
});

describe('saving', () => {
  it('shares only on a touch-first device that accepts files', () => {
    expect(chooseSaveMethod({ coarsePointer: true, canShareFiles: true })).toBe('share');
    expect(chooseSaveMethod({ coarsePointer: false, canShareFiles: true })).toBe('download');
    expect(chooseSaveMethod({ coarsePointer: true, canShareFiles: false })).toBe('download');
  });
  it('names the file by local date and time', () => {
    expect(photoFileName(new Date(2026, 9, 4, 7, 5, 9))).toBe('iron-dominion-20261004-070509.png');
  });
});
