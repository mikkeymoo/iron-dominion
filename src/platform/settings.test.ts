import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings } from './settings.ts';
import type { PlatformDb } from './db.ts';

const dbWith = (raw: Record<string, unknown>): PlatformDb => ({ allSettings: async () => ({ ok: true, value: raw }), setSetting: async () => ({ ok: true, value: undefined }) }) as unknown as PlatformDb;

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
