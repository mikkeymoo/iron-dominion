import { DIRECTIVES } from '../sim/directives.ts';
import { TIERS } from '../sim/unlocks.ts';

// UNIT-0's lines. The sim table (sim/directives.ts) decides when a directive is met and what it pays; this table is only words.
// Keys are the sim ids, and a test fails when either table has an id the other lacks.

export interface ProgressCtx { population: number; treasury: number }

export interface DirectiveCopy {
  /** Short name, for the chip and the screen reader. */
  title: string;
  /** What UNIT-0 says while the directive is open. */
  say: string;
  /** The toast when it is met. */
  done: string;
  /** Progress line from the sim's capped have / need. */
  progress(have: number, need: number, ctx: ProgressCtx): string;
}

const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');
const count = (unit: string) => (have: number, need: number): string => `${fmt(have)} of ${fmt(need)} ${unit}`;
const parts = (a: string, b: string) => (have: number): string => `${have === 0 ? 'Nothing placed yet' : have === 1 ? 'One of two placed' : `${a} and ${b} placed`}`;

export const DIRECTIVE_COPY: Record<string, DirectiveCopy> = {
  road: {
    title: 'Lay a road',
    say: 'Hi, I am UNIT-0, your foreman. My crew is waiting at the depot. Lay a road out from it so we can reach the land.',
    done: 'Road laid. Nice and straight.',
    progress: count('road tiles reach the depot'),
  },
  residential: {
    title: 'Zone homes',
    say: 'Now zone Residential along the road. Drag a box beside it and my builders will do the rest.',
    done: 'Homes zoned. My crew is on it.',
    progress: count('tiles zoned for homes'),
  },
  firstHome: {
    title: 'Watch the first home',
    say: 'Watch closely: bots haul the material and build your first home. Give them a minute.',
    done: 'Your first home is standing. Beautiful.',
    progress: (have, need) => (have >= need ? 'First home finished' : 'Waiting for the first home to finish'),
  },
  commercial: {
    title: 'Zone shops',
    say: 'People need shops. Zone Commercial beside the road, close to the homes.',
    done: 'Shops zoned. The town is getting a high street.',
    progress: count('tiles zoned for shops'),
  },
  industrial: {
    title: 'Zone industry',
    say: 'And somewhere to work. Zone Industrial a little way from the homes, it is noisy.',
    done: 'Industry zoned. Jobs are coming.',
    progress: count('tiles zoned for industry'),
  },
  power: {
    title: 'Power the town',
    say: 'Nothing runs without power. Place a power plant, then run a power line to the town.',
    done: 'The grid is up. I can feel the hum.',
    progress: parts('Plant', 'line'),
  },
  water: {
    title: 'Bring water',
    say: 'Water next. A pump works best near the shore. Add a pipe to carry it to the homes.',
    done: 'Water is flowing. Splendid.',
    progress: parts('Pump', 'pipe'),
  },
  population: {
    title: 'Reach 100 people',
    say: 'Homes with power and water fill up on their own. Grow the town to 100 people.',
    done: 'One hundred citizens. They love it here.',
    progress: (_have, need, ctx) => `Population ${fmt(ctx.population)} of ${fmt(need)}`,
  },
  safety: {
    title: 'Keep them safe',
    say: 'Fires and illness happen. Build a fire station or a clinic near the homes.',
    done: 'Safety first, and you did it.',
    progress: (have) => (have >= 1 ? 'A station or clinic stands' : 'No fire station or clinic yet'),
  },
  settlement: {
    title: 'Reach Settlement',
    say: `Grow the town to ${TIERS[1]!.pop} people and it becomes a ${TIERS[1]!.name}, with new buildings to place.`,
    done: `${TIERS[1]!.name} tier reached. Look at us go.`,
    progress: (_have, _need, ctx) => `Population ${fmt(ctx.population)} of ${fmt(TIERS[1]!.pop)}`,
  },
  upgrade: {
    title: 'Build up',
    say: 'Time to build up. Zone some Medium density: bigger lots hold more people.',
    done: 'Taller buildings, here we come.',
    progress: (have) => (have >= 1 ? 'Medium density in place' : 'No medium density yet'),
  },
  megaproject: {
    title: 'Save for a megaproject',
    say: 'Big dreams, boss. Start saving for a megaproject. Open Projects in the menu to see what they need.',
    done: 'The savings are there. Open Projects and start something huge.',
    progress: (have, need) => `$${fmt(have)} of $${fmt(need)} saved`,
  },
};

export const copyOf = (id: string): DirectiveCopy | undefined => DIRECTIVE_COPY[id];

/** The directive ids with no copy, and the copy keys with no directive: both lists must be empty. */
export function copyGaps(): { missing: string[]; extra: string[] } {
  const ids = DIRECTIVES.map((d) => d.id);
  return { missing: ids.filter((id) => !(id in DIRECTIVE_COPY)), extra: Object.keys(DIRECTIVE_COPY).filter((k) => !ids.includes(k)) };
}
