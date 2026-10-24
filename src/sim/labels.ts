import { ARCH, RCI_BASE, RCI_COUNT } from './catalog.ts';

// Player-facing names for archetypes, shared by the issue list, the building card and robot job text. Pure, so the app bundle can
// import it without pulling in the sim.

const SERVICE_NAMES: Record<number, string> = {
  [ARCH.DEPOT]: 'robot depot', [ARCH.POWER_PLANT]: 'power plant', [ARCH.WATER_PUMP]: 'water pump', [ARCH.FIRE_STATION]: 'fire station',
  [ARCH.SOLAR_FARM]: 'solar farm', [ARCH.WATER_TOWER]: 'water tower', [ARCH.FUSION_REACTOR]: 'fusion reactor', [ARCH.POLICE]: 'police station',
  [ARCH.CLINIC]: 'clinic', [ARCH.HOSPITAL]: 'hospital', [ARCH.SCHOOL]: 'school', [ARCH.UNIVERSITY]: 'university', [ARCH.PARK_SMALL]: 'small park',
  [ARCH.PARK_LARGE]: 'large park', [ARCH.REPAIR_BAY]: 'repair bay', [ARCH.FUSION_SPIRE]: 'fusion spire', [ARCH.ARCOLOGY]: 'arcology',
  [ARCH.MECH_ARENA]: 'mech arena', [ARCH.SPACE_ELEVATOR]: 'space elevator', [ARCH.ROBOTICS_LAB]: 'robotics lab',
  [ARCH.LIGHTNING_ROD]: 'lightning rod', [ARCH.BATTERY_BANK]: 'battery bank', [ARCH.SEISMIC_DAMPER]: 'seismic damper', [ARCH.SHIELD_DOME]: 'shield dome',
};

/** Names by zone (R, C, I) and density row (low, medium, high). High-density industry is the steel works the smog comes from. */
const RCI_NAMES = [
  ['house', 'apartment block', 'residential tower'],
  ['shop', 'store', 'office tower'],
  ['workshop', 'factory', 'steel works'],
] as const;

/** Lower-case name of an archetype ("house", "steel works", "fire station"). */
export function archLabel(arch: number): string {
  const s = SERVICE_NAMES[arch];
  if (s) return s;
  if (arch >= RCI_BASE && arch < RCI_BASE + RCI_COUNT) {
    const i = arch - RCI_BASE;
    return RCI_NAMES[Math.floor(i / 9)]![Math.floor((i % 9) / 3)]!;
  }
  return 'building';
}

export const withArticle = (name: string): string => `${/^[aeiou]/.test(name) ? 'an' : 'a'} ${name}`;
export const capitalise = (s: string): string => (s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1));
