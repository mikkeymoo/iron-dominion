import { STORAGE_KEY, TIERS, isTier, type Tier } from '../render/tier.ts';
import type { PlatformDb } from './db.ts';

export type TierOverride = 'auto' | Tier;
export const TIER_OVERRIDES: readonly TierOverride[] = ['auto', ...TIERS];

export interface Settings {
  tier: TierOverride;
  graphics: { shadows: boolean; bloom: boolean; resolutionScale: number };
  audio: { muted: boolean; volume: number };
  /** Per-bus levels under the master `audio.volume`; `musicOn` mutes music alone. */
  soundMix: { music: number; ambience: number; sfx: number; musicOn: boolean };
  disasters: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  tier: 'auto',
  graphics: { shadows: true, bloom: true, resolutionScale: 1 },
  audio: { muted: false, volume: 0.7 },
  soundMix: { music: 0.6, ambience: 0.8, sfx: 0.9, musicOn: true },
  disasters: true,
};

export const isTierOverride = (v: unknown): v is TierOverride => v === 'auto' || isTier(v);

/** The renderer reads its override synchronously from `STORAGE_KEY` (iron.tier) at startup; the settings store is the source of truth. */

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function sanitize(raw: Record<string, unknown>): Settings {
  const d = DEFAULT_SETTINGS;
  const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
  const bool = (v: unknown, f: boolean): boolean => (typeof v === 'boolean' ? v : f);
  const num = (v: unknown, f: number, lo: number, hi: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : f);
  const g = obj(raw.graphics), a = obj(raw.audio), m = obj(raw.soundMix);
  return {
    tier: isTierOverride(raw.tier) ? raw.tier : d.tier,
    graphics: { shadows: bool(g.shadows, d.graphics.shadows), bloom: bool(g.bloom, d.graphics.bloom), resolutionScale: num(g.resolutionScale, d.graphics.resolutionScale, 0.25, 2) },
    audio: { muted: bool(a.muted, d.audio.muted), volume: num(a.volume, d.audio.volume, 0, 1) },
    soundMix: { music: num(m.music, d.soundMix.music, 0, 1), ambience: num(m.ambience, d.soundMix.ambience, 0, 1), sfx: num(m.sfx, d.soundMix.sfx, 0, 1), musicOn: bool(m.musicOn, d.soundMix.musicOn) },
    disasters: bool(raw.disasters, d.disasters),
  };
}

/** Keeps the renderer's synchronous startup read in step with the stored override. 'auto' removes it. */
export function mirrorTierToStorage(tier: TierOverride, storage: StorageLike | undefined): void {
  try {
    if (!storage) return;
    if (tier === 'auto') storage.removeItem(STORAGE_KEY);
    else storage.setItem(STORAGE_KEY, tier);
  } catch { /* storage denied: the override applies on the next successful write */ }
}

/**
 * Loads settings. A legacy `iron.tier` override is read once and moved into the store when the store has none;
 * afterwards the key only mirrors the stored value for the renderer.
 */
export async function loadSettings(db: PlatformDb | undefined, storage: StorageLike | undefined): Promise<Settings> {
  let raw: Record<string, unknown> = {};
  if (db) {
    const r = await db.allSettings();
    if (r.ok) raw = r.value;
  }
  if (!isTierOverride(raw.tier)) {
    let legacy: string | null = null;
    try { legacy = storage?.getItem(STORAGE_KEY) ?? null; } catch { /* ignore */ }
    if (isTierOverride(legacy) && legacy !== 'auto') {
      raw = { ...raw, tier: legacy };
      if (db) await db.setSetting('tier', legacy);
    }
  }
  const settings = sanitize(raw);
  mirrorTierToStorage(settings.tier, storage);
  return settings;
}

export async function saveSetting<K extends keyof Settings>(db: PlatformDb | undefined, storage: StorageLike | undefined, key: K, value: Settings[K]): Promise<boolean> {
  if (key === 'tier') mirrorTierToStorage(value as TierOverride, storage);
  if (!db) return false;
  return (await db.setSetting(key, value)).ok;
}
