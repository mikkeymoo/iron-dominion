import { BFLAG } from '../sim/catalog.ts';
import { ABANDON_DESIRABILITY } from '../sim/economy/tables.ts';
import { zoneOfArch } from '../sim/economy/totals.ts';
import { BMAX, MAP, S } from '../sim/layers.ts';
import type { IconAnchor } from './instances.ts';
import type { RenderMirror } from './mirror.ts';

// Building status icons: one floating billboard per building that needs the player's eye, picked by priority. Pure (no three), so
// the choice, the zoom cut-off and the cap are unit-tested; outageIcons.ts draws what this picks.

/** Icon kinds, also the shape index in the shader. */
export const ICON = { POWER: 0, WATER: 1, FIRE: 2, JOBS: 3, CRIME: 4, SMOG: 5, UPGRADE: 6 } as const;
export type IconKind = (typeof ICON)[keyof typeof ICON];
export const ICON_NAMES = ['power', 'water', 'fire', 'jobs', 'crime', 'smog', 'upgrade'] as const;

/** When a building qualifies for several icons, the highest priority is the one it shows. */
export const ICON_PRIORITY: Record<IconKind, number> = { [ICON.FIRE]: 70, [ICON.POWER]: 60, [ICON.WATER]: 50, [ICON.JOBS]: 40, [ICON.CRIME]: 30, [ICON.SMOG]: 20, [ICON.UPGRADE]: 10 };

/** Camera distance (tiles) beyond which icons hide: the mood icons first, the three outage-grade ones (fire, power, water) later. */
export const ICON_FAR = { mood: 60, critical: 180 } as const;
export const isCritical = (k: IconKind): boolean => k === ICON.FIRE || k === ICON.POWER || k === ICON.WATER;
/** What still shows past ICON_FAR.mood: the outage-grade icons and crime. */
const showsFar = (k: IconKind): boolean => isCritical(k) || k === ICON.CRIME;
/** 0 everything shows, 1 only fire, power, water and crime, 2 nothing. */
export const farLevel = (cameraDist: number): 0 | 1 | 2 => (cameraDist > ICON_FAR.critical ? 2 : cameraDist > ICON_FAR.mood ? 1 : 0);

/** Crime (0..255) and smog (0..255 pollution) at which a home, shop or office gets its icon; unemployment (0..1) at which homes do. */
export const ICON_CRIME = 150;
export const ICON_SMOG = 70;
export const ICON_UNEMPLOYMENT = 0.4;
/** Zone demand (-1..1) and land value under which a finished building is about to be abandoned. */
export const ICON_DEMAND_LOW = -0.25;
export const ICON_LAND_LOW = ABANDON_DESIRABILITY + 40;
export const MAX_ICONS = 768;
/** Icons drawn at once: a dense district would otherwise carry one over nearly every building. */
export const VISIBLE_ICONS = 40;

export interface IconSample {
  flags: number;
  /** 0 not a grown building, else 1 R, 2 C, 3 I. */
  zone: number;
  level: number;
  /** Highest crime under the footprint, mean pollution, mean land value. */
  crime: number;
  smog: number;
  landValue: number;
  /** Demand of the building's own zone (-1..1) and the city's unemployment (0..1). */
  demand: number;
  unemployment: number;
}

/** The icon a building shows, or -1 for none. */
export function pickIcon(s: IconSample): IconKind | -1 {
  const f = s.flags;
  if ((f & BFLAG.RUBBLE) !== 0) return -1;
  const found: IconKind[] = [];
  const grown = s.zone !== 0;
  if ((f & BFLAG.CONSTRUCTING) !== 0) {
    if (grown && s.level >= 2 && (f & BFLAG.DEMOLISHING) === 0) found.push(ICON.UPGRADE);
  } else {
    if ((f & BFLAG.BURNING) !== 0) found.push(ICON.FIRE);
    if ((f & BFLAG.UNPOWERED) !== 0) found.push(ICON.POWER);
    if ((f & BFLAG.UNWATERED) !== 0) found.push(ICON.WATER);
    if (grown) {
      if ((f & BFLAG.ABANDONED) !== 0 || (s.demand < ICON_DEMAND_LOW && s.landValue < ICON_LAND_LOW) || (s.zone === 1 && s.unemployment >= ICON_UNEMPLOYMENT)) found.push(ICON.JOBS);
      if (s.crime >= ICON_CRIME) found.push(ICON.CRIME);
      if (s.zone !== 3 && s.smog >= ICON_SMOG) found.push(ICON.SMOG);
    }
  }
  let best: IconKind | undefined;
  for (const k of found) if (best === undefined || ICON_PRIORITY[k] > ICON_PRIORITY[best]) best = k;
  return best ?? -1;
}

export interface StatusRec { x: number; y: number; z: number; kind: IconKind }

/** Of `recs`, those visible at this camera distance, most important first then nearest the focus, at most `cap`. */
export function selectIcons(recs: readonly (StatusRec & { slot: number })[], dist: number, focus: { x: number; z: number }, cap = VISIBLE_ICONS): StatusRec[] {
  const far = farLevel(dist);
  if (far === 2) return [];
  const rank = (r: StatusRec): number => ICON_PRIORITY[r.kind];
  const d2 = (r: StatusRec): number => (r.x - focus.x) ** 2 + (r.z - focus.z) ** 2;
  return recs
    .filter((r) => far === 0 || showsFar(r.kind))
    .sort((a, b) => rank(b) - rank(a) || d2(a) - d2(b) || a.slot - b.slot)
    .slice(0, cap)
    .map(({ x, y, z, kind }) => ({ x, y, z, kind }));
}

function footprintStats(layer: ArrayLike<number>, x0: number, y0: number, w: number, h: number): { max: number; mean: number } {
  let max = 0, sum = 0;
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { const v = layer[y * MAP + x]!; if (v > max) max = v; sum += v; }
  return { max, mean: Math.floor(sum / (w * h)) };
}

const SCAN_MS = 250;
const FOCUS_CELL = 8;

/**
 * Works out which buildings show which icon from the mirror (flags, crime, pollution, land value, the city's demand and unemployment)
 * and the anchors BuildingInstances keeps above every roof. Rescans when buildings or overlay layers changed, the zoom crossed a cut-off or
 * the focus moved, at most every SCAN_MS; `refresh` returns null while nothing changed.
 */
export class StatusIconSystem {
  private key = '';
  private lastScan = -Infinity;
  private lastFar = -1;
  /** Icons drawn after the last refresh, and how many of each kind name; for the debug hook and tests. */
  count = 0;
  byKind: Record<string, number> = {};

  constructor(private readonly mirror: RenderMirror, private readonly anchors: () => ReadonlyMap<number, IconAnchor>, private readonly anchorVersion: () => number) {}

  refresh(focus: { x: number; z: number }, cameraDist: number, nowMs: number): StatusRec[] | null {
    const m = this.mirror, far = farLevel(cameraDist);
    const key = `${m.buildingVersion}|${m.overlayVersion}|${this.anchorVersion()}|${far}|${Math.round(focus.x / FOCUS_CELL)}|${Math.round(focus.z / FOCUS_CELL)}`;
    if (key === this.key) return null;
    if (far === this.lastFar && nowMs - this.lastScan < SCAN_MS) return null;
    this.key = key;
    this.lastFar = far;
    this.lastScan = nowMs;
    return this.scan(focus, cameraDist);
  }

  scan(focus: { x: number; z: number }, cameraDist: number): StatusRec[] {
    const m = this.mirror, t = m.table, L = m.layers, anchors = this.anchors();
    const unemployment = m.scalars[S.unemployment]!;
    const recs: (StatusRec & { slot: number })[] = [];
    if (farLevel(cameraDist) < 2) {
      for (let s = 0; s < BMAX; s++) {
        const arch = t.bArch[s]!;
        if (arch === 0) continue;
        const a = anchors.get(s);
        if (!a) continue;
        const zone = zoneOfArch(arch);
        const x = t.bX[s]!, y = t.bY[s]!, w = t.bW[s]!, h = t.bH[s]!;
        const crime = zone !== 0 ? footprintStats(L.crime!, x, y, w, h).max : 0;
        const smog = zone !== 0 ? footprintStats(L.pollution!, x, y, w, h).mean : 0;
        const lv = zone !== 0 ? footprintStats(L.landValue!, x, y, w, h).mean : 0;
        const kind = pickIcon({
          flags: t.bFlags[s]!, zone, level: t.bLevel[s]!, crime, smog, landValue: lv,
          demand: zone !== 0 ? m.scalars[S.demandR + zone - 1]! : 0, unemployment,
        });
        if (kind !== -1) recs.push({ slot: s, x: a.x, y: a.y, z: a.z, kind });
      }
    }
    const out = selectIcons(recs, cameraDist, focus);
    this.count = out.length;
    this.byKind = {};
    for (const r of out) this.byKind[ICON_NAMES[r.kind]!] = (this.byKind[ICON_NAMES[r.kind]!] ?? 0) + 1;
    return out;
  }
}
