import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, disasterModeOf, haltDisasterMode, loadSettings, saveSetting } from './settings.ts';
import type { PlatformDb } from './db.ts';

const dbWith = (raw: Record<string, unknown>): PlatformDb => ({ allSettings: async () => ({ ok: true, value: raw }), setSetting: async () => ({ ok: true, value: undefined }) }) as unknown as PlatformDb;

describe('Disasters setting: Off / Gentle / Rare / Normal / Hard', () => {
  it('keeps the saved numbers of the older modes and adds Gentle and Hard after them', async () => {
    expect(['off', 'rare', 'normal', 'gentle', 'hard'].map((m) => disasterModeOf(m as never))).toEqual([0, 1, 2, 3, 4]);
    for (const m of ['off', 'gentle', 'rare', 'normal', 'hard']) expect((await loadSettings(dbWith({ disasters: m }), undefined)).disasters).toBe(m);
    expect((await loadSettings(dbWith({ disasters: 'brutal' }), undefined)).disasters).toBe('rare');
    expect(haltDisasterMode('gentle')).toBe(3);
  });
});

describe('haltAt debug runs', () => {
  it('take the disaster mode from the query or the shipped default, never from stored settings', async () => {
    const stored = await loadSettings(dbWith({ disasters: 'off' }), undefined);
    expect(stored.disasters).toBe('off');
    expect(haltDisasterMode(null)).toBe(disasterModeOf(DEFAULT_SETTINGS.disasters));
    expect(haltDisasterMode('bogus')).toBe(disasterModeOf('rare'));
    expect(haltDisasterMode('off')).toBe(disasterModeOf('off'));
    expect(haltDisasterMode('normal')).toBe(disasterModeOf('normal'));
  });
});

describe('handedness, focus and panel state settings', () => {
  it('default to right-handed, no focus mode and no remembered panel state', () => {
    expect(DEFAULT_SETTINGS.handedness).toBe('right');
    expect(DEFAULT_SETTINGS.focus).toBe(false);
    expect(DEFAULT_SETTINGS.panelStates).toEqual({});
  });

  it('round-trip what the player set', async () => {
    const s = await loadSettings(dbWith({ handedness: 'left', focus: true, panelStates: { budget: true, 'menu-city': false } }), undefined);
    expect(s.handedness).toBe('left');
    expect(s.focus).toBe(true);
    expect(s.panelStates).toEqual({ budget: true, 'menu-city': false });
  });

  it('fall back to the defaults for damaged values and drop non-boolean panel flags', async () => {
    const s = await loadSettings(dbWith({ handedness: 'both', focus: 'yes', panelStates: { a: true, b: 'x', c: 1, [`${'k'.repeat(60)}`]: true } }), undefined);
    expect(s.handedness).toBe('right');
    expect(s.focus).toBe(false);
    expect(s.panelStates).toEqual({ a: true });
    expect((await loadSettings(dbWith({ panelStates: 'nope' }), undefined)).panelStates).toEqual({});
  });

  it('persist each key through the store', async () => {
    const written: Record<string, unknown> = {};
    const db = { allSettings: async () => ({ ok: true, value: { ...written } }), setSetting: async (k: string, v: unknown) => { written[k] = v; return { ok: true, value: undefined }; } } as unknown as PlatformDb;
    await saveSetting(db, undefined, 'handedness', 'left');
    await saveSetting(db, undefined, 'panelStates', { budget: true });
    const s = await loadSettings(db, undefined);
    expect(s.handedness).toBe('left');
    expect(s.panelStates).toEqual({ budget: true });
  });
});

describe('onboarding and performance panel settings', () => {
  it('default to an open checklist, no hints seen, and a performance panel that follows the device', () => {
    expect(DEFAULT_SETTINGS.onboarding).toEqual({ dismissed: false, collapsed: false, hintsSeen: [] });
    expect(DEFAULT_SETTINGS.showPerf).toBeNull();
  });

  it('round-trip what the player set', async () => {
    const s = await loadSettings(dbWith({ onboarding: { dismissed: true, collapsed: true, hintsSeen: ['road', 'zone'] }, showPerf: true }), undefined);
    expect(s.onboarding).toEqual({ dismissed: true, collapsed: true, hintsSeen: ['road', 'zone'] });
    expect(s.showPerf).toBe(true);
  });

  it('fall back to the defaults for damaged values', async () => {
    const s = await loadSettings(dbWith({ onboarding: { dismissed: 'yes', collapsed: 3, hintsSeen: ['road', 7, null] }, showPerf: 'on' }), undefined);
    expect(s.onboarding).toEqual({ dismissed: false, collapsed: false, hintsSeen: ['road'] });
    expect(s.showPerf).toBeNull();
    const none = await loadSettings(dbWith({ onboarding: 'x' }), undefined);
    expect(none.onboarding).toEqual(DEFAULT_SETTINGS.onboarding);
  });
});
