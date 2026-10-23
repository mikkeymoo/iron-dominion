import type { PlatformDb } from './db.ts';

export type TierOverride = 'auto' | 'low' | 'mid' | 'high' | 'ultra';
export const TIER_OVERRIDES: readonly TierOverride[] = ['auto', 'low', 'mid', 'high', 'ultra'];

export interface Settings {
  tier: TierOverride;
  graphics: { shadows: boolean; bloom: boolean; resolutionScale: number };
  audio: { muted: boolean; volume: number };
  disasters: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  tier: 'auto',
  graphics: { shadows: true, bloom: true, resolutionScale: 1 },
  audio: { muted: false, volume: 0.7 },
  disasters: true,
};

/** The renderer reads its override synchronously from this key at startup; the settings store is the source of truth. */
export const LEGACY_TIER_KEY = 'iron.tier';

export const isTierOverride = (v: unknown): v is TierOverride => typeof v === 'string' && (TIER_OVERRIDES as readonly string[]).includes(v);

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function sanitize(raw: Record<string, unknown>): Settings {
  const d = DEFAULT_SETTINGS;
  const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
  const bool = (v: unknown, f: boolean): boolean => (typeof v === 'boolean' ? v : f);
  const num = (v: unknown, f: number, lo: number, hi: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : f);
  const g = obj(raw.graphics), a = obj(raw.audio);
  return {
    tier: isTierOverride(raw.tier) ? raw.tier : d.tier,
    graphics: { shadows: bool(g.shadows, d.graphics.shadows), bloom: bool(g.bloom, d.graphics.bloom), resolutionScale: num(g.resolutionScale, d.graphics.resolutionScale, 0.25, 2) },
    audio: { muted: bool(a.muted, d.audio.muted), volume: num(a.volume, d.audio.volume, 0, 1) },
    disasters: bool(raw.disasters, d.disasters),
  };
}

/** Keeps the renderer's synchronous startup read in step with the stored override. 'auto' removes it. */
export function mirrorTierToStorage(tier: TierOverride, storage: StorageLike | undefined): void {
  try {
    if (!storage) return;
    if (tier === 'auto') storage.removeItem(LEGACY_TIER_KEY);
    else storage.setItem(LEGACY_TIER_KEY, tier);
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
    try { legacy = storage?.getItem(LEGACY_TIER_KEY) ?? null; } catch { /* ignore */ }
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
