import { ARCH } from '../catalog.ts';
import { HAZ } from '../layers.ts';

// Words for the forecast strip and card. Kept apart from the scheduler so the HUD can name a hazard without pulling the sim into the
// app bundle (as names.ts does for fires).

export const HAZARD_NAMES = ['', 'Storm season', 'Heatwave', 'Cold snap', 'Meteor shower', 'Quake swarm'] as const;

/** The line shown when a hazard is about to land and the city is ready for it ("Ready for the storm: +$2,000"). */
export const READY_PHRASES = ['', 'Ready for the storm', 'Ready for the heat', 'Ready for the cold', 'Ready for the meteors', 'Ready for the quakes'] as const;

/** One word for what each hazard does to the city, for the card. */
export const HAZARD_BLURBS = [
  '',
  'Heavy rain and lightning strikes. Struck buildings can catch fire.',
  'Air conditioning drives power demand up, and fires start more easily.',
  'Heating drives power demand up, and solar farms produce less.',
  'Meteors fall on the city. Each one leaves a crater and burns what is near it.',
  'A run of earthquakes. Buildings crack or collapse and roads split.',
] as const;

export interface HazardHelp {
  /** Catalog archetype that protects against it. */
  arch: number;
  /** Name on the card. */
  name: string;
  /** What the building does, in one sentence. */
  text: string;
}

/** What helps, by hazard. Heat and cold share the Battery Bank; spare power plants help too and are mentioned in the text. */
export const HAZARD_HELP: readonly (HazardHelp | null)[] = [
  null,
  { arch: ARCH.LIGHTNING_ROD, name: 'Lightning Rod', text: 'Grounds every strike within its reach, so the buildings near it cannot be set alight.' },
  { arch: ARCH.BATTERY_BANK, name: 'Battery Bank', text: 'Stores power while there is a surplus and covers the brown-outs, as does any spare power plant.' },
  { arch: ARCH.BATTERY_BANK, name: 'Battery Bank', text: 'Stores power while there is a surplus and covers the brown-outs, as does any spare power plant.' },
  { arch: ARCH.SHIELD_DOME, name: 'Shield Dome', text: 'Stops meteors from landing anywhere inside its reach. Needs power.' },
  { arch: ARCH.SEISMIC_DAMPER, name: 'Seismic Damper', text: 'Cuts quake damage to the buildings and roads inside its reach.' },
];

export const HAZARD_KINDS: readonly number[] = [HAZ.STORM, HAZ.HEATWAVE, HAZ.COLD_SNAP, HAZ.METEOR_SHOWER, HAZ.QUAKE_SWARM];

/** "in 1 month", "in 2 months", or "soon" when it is under a month away. A month is one game day (DAY_TICKS). */
export function leadText(ticks: number, monthTicks = 4800): string {
  if (ticks <= 0) return 'now';
  if (ticks <= monthTicks * 0.25) return 'soon';
  const months = Math.ceil(ticks / monthTicks);
  return `in ${months} ${months === 1 ? 'month' : 'months'}`;
}
