import { AUTO_STORAGE_KEY, STORAGE_KEY, TIERS, isTier, type Tier } from '../render/tier.ts';
import type { PlatformDb } from './db.ts';

export type TierOverride = 'auto' | Tier;
export const TIER_OVERRIDES: readonly TierOverride[] = ['auto', ...TIERS];

/**
 * How hard disasters hit. Off has none; Gentle has forecasts only, half damage, no meteors and a low intensity cap; Rare, Normal
 * and Hard come as forecasts plus random fires, with the intensity growing with the city. The list is in the order the menu shows;
 * the number sent to the sim as the setDisasters command is the DMODE value (sim/disasters/tables.ts), which is not the index
 * because Gentle and Hard were added after the three older modes and saves keep those numbers.
 */
export type DisastersSetting = 'off' | 'gentle' | 'rare' | 'normal' | 'hard';
export const DISASTER_MODES: readonly DisastersSetting[] = ['off', 'gentle', 'rare', 'normal', 'hard'];
export const isDisastersSetting = (v: unknown): v is DisastersSetting => DISASTER_MODES.includes(v as DisastersSetting);
const SIM_MODE: Record<DisastersSetting, number> = { off: 0, rare: 1, normal: 2, gentle: 3, hard: 4 };
export const disasterModeOf = (s: DisastersSetting): number => SIM_MODE[s];

/** Sim disaster mode for a ?haltAt debug run: the `?disasters=` value, else the shipped default, never the stored setting (the golden hash must not depend on it). */
export const haltDisasterMode = (param: string | null): number =>
  disasterModeOf(isDisastersSetting(param) ? param : DEFAULT_SETTINGS.disasters);

/** Which thumb the phone layout is built around: the build dock and its button sit on that side. */
export type Handedness = 'right' | 'left';
export const HANDEDNESS: readonly Handedness[] = ['right', 'left'];
export const isHandedness = (v: unknown): v is Handedness => HANDEDNESS.includes(v as Handedness);

const PANEL_STATE_CAP = 40;

export interface Settings {
  tier: TierOverride;
  graphics: { shadows: boolean; bloom: boolean; resolutionScale: number };
  audio: { muted: boolean; volume: number };
  /** Per-bus levels under the master `audio.volume`; `musicOn` mutes music alone. */
  soundMix: { music: number; ambience: number; sfx: number; musicOn: boolean };
  disasters: DisastersSetting;
  /** Starter checklist and first-use tool hints: dismissed, collapsed to a chip, and the hint ids already shown. */
  onboarding: { dismissed: boolean; collapsed: boolean; hintsSeen: string[] };
  /** Performance panel: null follows the device (shown on desktop, hidden on a phone). */
  showPerf: boolean | null;
  /** The tier the auto governor settled on for this device (null until it has moved); the next launch starts there. */
  autoTier: Tier | null;
  /** HUD panel state: top bar expanded, tool bar expanded (phones start collapsed), and whether the tool bar folds itself after idle. */
  panels: { topOpen: boolean; autoCollapse: boolean };
  handedness: Handedness;
  /** Focus mode: the HUD hides everything except the build button. */
  focus: boolean;
  /** Collapsed flag per panel id (see ui/Panel.tsx); a missing id uses the panel's own default. */
  panelStates: Record<string, boolean>;
  /** Pause a fast-forwarded game (4x or Max) when a hazard starts, a council request is about to expire or approval drops under 15 (ui/pacing.ts). */
  pauseOnCrises: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  tier: 'auto',
  graphics: { shadows: true, bloom: true, resolutionScale: 1 },
  audio: { muted: false, volume: 0.7 },
  soundMix: { music: 0.6, ambience: 0.8, sfx: 0.9, musicOn: true },
  disasters: 'rare',
  onboarding: { dismissed: false, collapsed: false, hintsSeen: [] },
  showPerf: null,
  autoTier: null,
  panels: { topOpen: false, autoCollapse: true },
  handedness: 'right',
  focus: false,
  panelStates: {},
  pauseOnCrises: true,
};

export const isTierOverride = (v: unknown): v is TierOverride => v === 'auto' || isTier(v);

/** The renderer reads its override synchronously from `STORAGE_KEY` (iron.tier) at startup; the settings store is the source of truth. */

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function sanitize(raw: Record<string, unknown>): Settings {
  const d = DEFAULT_SETTINGS;
  const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
  const bool = (v: unknown, f: boolean): boolean => (typeof v === 'boolean' ? v : f);
  const num = (v: unknown, f: number, lo: number, hi: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : f);
  const g = obj(raw.graphics), a = obj(raw.audio), m = obj(raw.soundMix), o = obj(raw.onboarding);
  const seen = Array.isArray(o.hintsSeen) ? o.hintsSeen.filter((h): h is string => typeof h === 'string').slice(0, 32) : d.onboarding.hintsSeen;
  return {
    onboarding: { dismissed: bool(o.dismissed, d.onboarding.dismissed), collapsed: bool(o.collapsed, d.onboarding.collapsed), hintsSeen: seen },
    showPerf: typeof raw.showPerf === 'boolean' ? raw.showPerf : d.showPerf,
    autoTier: isTier(raw.autoTier) ? raw.autoTier : d.autoTier,
    panels: { topOpen: bool(obj(raw.panels).topOpen, d.panels.topOpen), autoCollapse: bool(obj(raw.panels).autoCollapse, d.panels.autoCollapse) },
    handedness: isHandedness(raw.handedness) ? raw.handedness : d.handedness,
    focus: bool(raw.focus, d.focus),
    pauseOnCrises: bool(raw.pauseOnCrises, d.pauseOnCrises),
    panelStates: Object.fromEntries(
      Object.entries(obj(raw.panelStates)).filter((e): e is [string, boolean] => typeof e[1] === 'boolean' && e[0].length <= 48).slice(0, PANEL_STATE_CAP),
    ),
    tier: isTierOverride(raw.tier) ? raw.tier : d.tier,
    graphics: { shadows: bool(g.shadows, d.graphics.shadows), bloom: bool(g.bloom, d.graphics.bloom), resolutionScale: num(g.resolutionScale, d.graphics.resolutionScale, 0.25, 2) },
    audio: { muted: bool(a.muted, d.audio.muted), volume: num(a.volume, d.audio.volume, 0, 1) },
    soundMix: { music: num(m.music, d.soundMix.music, 0, 1), ambience: num(m.ambience, d.soundMix.ambience, 0, 1), sfx: num(m.sfx, d.soundMix.sfx, 0, 1), musicOn: bool(m.musicOn, d.soundMix.musicOn) },
    // Before the Off / Rare / Normal choice the setting was a boolean: on becomes Normal, off stays Off.
    disasters: isDisastersSetting(raw.disasters) ? raw.disasters : raw.disasters === true ? 'normal' : raw.disasters === false ? 'off' : d.disasters,
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
