import { AUTO_STORAGE_KEY, STORAGE_KEY, TIERS, isTier, type Tier } from '../render/tier.ts';
import type { PlatformDb } from './db.ts';

export type TierOverride = 'auto' | Tier;
export const TIER_OVERRIDES: readonly TierOverride[] = ['auto', ...TIERS];

export interface Settings {
  tier: TierOverride;
  graphics: { shadows: boolean; bloom: boolean; resolutionScale: number };
  audio: { muted: boolean; volume: number };
  disasters: boolean;
  /** Starter checklist and first-use tool hints: dismissed, collapsed to a chip, and the hint ids already shown. */
  onboarding: { dismissed: boolean; collapsed: boolean; hintsSeen: string[] };
  /** Performance panel: null follows the device (shown on desktop, hidden on a phone). */
  showPerf: boolean | null;
  /** The tier the auto governor settled on for this device (null until it has moved); the next launch starts there. */
  autoTier: Tier | null;
  /** HUD panel state: top bar expanded, tool bar expanded (phones start collapsed), and whether the tool bar folds itself after idle. */
  panels: { topOpen: boolean; autoCollapse: boolean };
}

export const DEFAULT_SETTINGS: Settings = {
  tier: 'auto',
  graphics: { shadows: true, bloom: true, resolutionScale: 1 },
  audio: { muted: false, volume: 0.7 },
  disasters: true,
  onboarding: { dismissed: false, collapsed: false, hintsSeen: [] },
  showPerf: null,
  autoTier: null,
  panels: { topOpen: false, autoCollapse: true },
};

export const isTierOverride = (v: unknown): v is TierOverride => v === 'auto' || isTier(v);

/** The renderer reads its override synchronously from `STORAGE_KEY` (iron.tier) at startup; the settings store is the source of truth. */

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function sanitize(raw: Record<string, unknown>): Settings {
  const d = DEFAULT_SETTINGS;
  const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
  const bool = (v: unknown, f: boolean): boolean => (typeof v === 'boolean' ? v : f);
  const num = (v: unknown, f: number, lo: number, hi: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : f);
  const g = obj(raw.graphics), a = obj(raw.audio), o = obj(raw.onboarding);
  const seen = Array.isArray(o.hintsSeen) ? o.hintsSeen.filter((h): h is string => typeof h === 'string').slice(0, 32) : d.onboarding.hintsSeen;
  return {
    onboarding: { dismissed: bool(o.dismissed, d.onboarding.dismissed), collapsed: bool(o.collapsed, d.onboarding.collapsed), hintsSeen: seen },
    showPerf: typeof raw.showPerf === 'boolean' ? raw.showPerf : d.showPerf,
    autoTier: isTier(raw.autoTier) ? raw.autoTier : d.autoTier,
    panels: { topOpen: bool(obj(raw.panels).topOpen, d.panels.topOpen), autoCollapse: bool(obj(raw.panels).autoCollapse, d.panels.autoCollapse) },
    tier: isTierOverride(raw.tier) ? raw.tier : d.tier,
    graphics: { shadows: bool(g.shadows, d.graphics.shadows), bloom: bool(g.bloom, d.graphics.bloom), resolutionScale: num(g.resolutionScale, d.graphics.resolutionScale, 0.25, 2) },
    audio: { muted: bool(a.muted, d.audio.muted), volume: num(a.volume, d.audio.volume, 0, 1) },
    disasters: bool(raw.disasters, d.disasters),
  };
}

/** Mirrors the settled auto tier for the renderer's synchronous startup read. */
export function mirrorAutoTierToStorage(tier: Tier | null, storage: StorageLike | undefined): void {
  try {
    if (!storage) return;
    if (tier === null) storage.removeItem(AUTO_STORAGE_KEY);
    else storage.setItem(AUTO_STORAGE_KEY, tier);
  } catch { /* storage denied: the next launch re-detects */ }
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
  mirrorAutoTierToStorage(settings.autoTier, storage);
  return settings;
}

export async function saveSetting<K extends keyof Settings>(db: PlatformDb | undefined, storage: StorageLike | undefined, key: K, value: Settings[K]): Promise<boolean> {
  if (key === 'tier') mirrorTierToStorage(value as TierOverride, storage);
  if (key === 'autoTier') mirrorAutoTierToStorage(value as Tier | null, storage);
  if (!db) return false;
  return (await db.setSetting(key, value)).ok;
}
