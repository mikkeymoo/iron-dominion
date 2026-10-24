// Districts: the constants, the name pool, the styles and the six district edicts. Pure data, shared by the sim (districts.ts), the
// ghost estimate on the main thread, the renderer (style tint) and the panels, so a card can never disagree with the sim.

/** Byte offsets inside one row of the `districtTab` layer. NAME holds up to NAME_MAX printable ASCII bytes of a player-typed name. */
export const DT = { POOL: 0, STYLE: 1, EDICT: 2, NAME_LEN: 3, NAME: 4 } as const;
export const NAME_MAX = 20;
/** DT.POOL value of a district named by the player. */
export const POOL_CUSTOM = 255;

/** Generated names, handed out in order to new districts (the first one no district is using). */
export const NAME_POOL: readonly string[] = [
  'Rustbelt', 'Neon Quarter', 'Copperfield', 'Gearworks', 'Ironside', 'Sparkgate', 'Chromeyard', 'Brasswood',
  'Steamfield', 'Anvil Hill', 'Cogsworth', 'Lamplight', 'Foundry Row', 'Rivet Park', 'Starlight Mile', 'Gantry Heights',
  'Blueprint Bay', 'Arc Light', 'Dynamo Flats', 'Boilerside', 'Pylon Point', 'Coppergate', 'Voltaire Row', 'Tinkers Rise',
];

export interface DistrictStyle {
  id: number;
  name: string;
  /** Multiplier on a building's wall and roof colour (the instance tint), and the neon accent that lights its trim. */
  tint: readonly [number, number, number];
  /** Boundary line and label colour, 0..1 rgb. */
  line: readonly [number, number, number];
  /** CSS colour of the same, for the label and panel. */
  css: string;
}

export const STYLES: readonly DistrictStyle[] = [
  { id: 0, name: 'Copper', tint: [1.22, 0.9, 0.7], line: [0.95, 0.55, 0.28], css: '#f28c48' },
  { id: 1, name: 'Neon', tint: [1.15, 0.78, 1.25], line: [0.95, 0.35, 0.95], css: '#f25af2' },
  { id: 2, name: 'Teal', tint: [0.76, 1.1, 1.18], line: [0.25, 0.85, 0.85], css: '#40d9d9' },
  { id: 3, name: 'Amber', tint: [1.25, 1.1, 0.68], line: [1, 0.78, 0.2], css: '#ffc733' },
  { id: 4, name: 'Slate', tint: [0.82, 0.9, 1.05], line: [0.55, 0.65, 0.95], css: '#8ca6f2' },
  { id: 5, name: 'Verdant', tint: [0.8, 1.15, 0.78], line: [0.4, 0.9, 0.4], css: '#66e666' },
  { id: 6, name: 'Crimson', tint: [1.22, 0.78, 0.78], line: [0.95, 0.3, 0.3], css: '#f24d4d' },
  { id: 7, name: 'Ivory', tint: [1.05, 1.03, 0.95], line: [0.95, 0.92, 0.8], css: '#f2ebcc' },
];
export const STYLE_COUNT = STYLES.length;

/** The district edicts. 0 is none. Every number an edict changes is here, and DISTRICT_MODS applies them. */
export const DEDICT = { NONE: 0, QUIET_ZONE: 1, INDUSTRIAL_PARK: 2, HIGH_RISE: 3, GREEN_BELT: 4, NIGHT_MARKET: 5, ROBOT_PRIORITY: 6 } as const;

export const DEDICT_NUMBERS = {
  quietPollutionPct: -50, quietIncomeCPct: -15,
  parkOutputPct: 30, parkPollutionPct: 35,
  highRiseLvPts: 30,
  greenLandValuePts: 8,
  nightDemandCPts: 16, nightCrimePct: 25,
  robotSpeedPct: 30,
} as const;

export interface DistrictEdictEffect { text: string; good: boolean }
export interface DistrictEdictDef {
  id: number;
  name: string;
  /** Credits per month while the district exists. */
  cost: number;
  blurb: string;
  effects: readonly DistrictEdictEffect[];
}

const N = DEDICT_NUMBERS;
export const DISTRICT_EDICTS: readonly DistrictEdictDef[] = [
  { id: DEDICT.NONE, name: 'No edict', cost: 0, blurb: 'The district follows the city-wide rules.', effects: [] },
  {
    id: DEDICT.QUIET_ZONE, name: 'Quiet Zone', cost: 120, blurb: 'Hush the streets. Homes feel less of the smog and the noise; shops lose some trade.',
    effects: [
      { text: `${N.quietPollutionPct}% pollution counted against land value`, good: true },
      { text: `${N.quietIncomeCPct}% commercial income`, good: false },
    ],
  },
  {
    id: DEDICT.INDUSTRIAL_PARK, name: 'Industrial Park', cost: 150, blurb: 'Factories here run flat out, and the air shows it.',
    effects: [
      { text: `+${N.parkOutputPct}% industrial material output`, good: true },
      { text: `+${N.parkPollutionPct}% industrial pollution`, good: false },
    ],
  },
  {
    id: DEDICT.HIGH_RISE, name: 'High-Rise Permit', cost: 200, blurb: 'Towers may go up on cheaper land.',
    effects: [{ text: `${N.highRiseLvPts} points less land value needed to level up`, good: true }],
  },
  {
    id: DEDICT.GREEN_BELT, name: 'Green Belt', cost: 100, blurb: 'Trees and parkland. No new factories.',
    effects: [
      { text: `+${N.greenLandValuePts} land value`, good: true },
      { text: 'no new industrial buildings', good: false },
    ],
  },
  {
    id: DEDICT.NIGHT_MARKET, name: 'Night Market', cost: 150, blurb: 'Stalls and lanterns after dark. The police are busier.',
    effects: [
      { text: `+${N.nightDemandCPts} commercial demand at night`, good: true },
      { text: `+${N.nightCrimePct}% crime`, good: false },
    ],
  },
  {
    id: DEDICT.ROBOT_PRIORITY, name: 'Robot Priority', cost: 120, blurb: 'Bots get right of way on every street in the district.',
    effects: [{ text: `+${N.robotSpeedPct}% robot speed`, good: true }],
  },
];
export const DEDICT_COUNT = DISTRICT_EDICTS.length;

/** What a district edict changes at one tile or building. Multipliers are 1 and additions 0 outside any district or under no edict. */
export interface DistrictMods {
  /** Tax income multiplier per building, indexed zone - 1. */
  income: readonly [number, number, number];
  industryOutput: number;
  /** Industrial pollution emission multiplier. */
  emission: number;
  /** Q8 multiplier on the pollution that counts against land value and a lot's score (256 = all of it). */
  pollutionQ: number;
  /** Added to the tile's land value. */
  landValue: number;
  /** Taken off the land value a building needs to level up. */
  levelUpLv: number;
  /** No new industrial buildings and no industrial level-ups. */
  noIndustry: boolean;
  crime: number;
  /** Added to a shop lot's growth score (Q10 demand points) while it is night. */
  nightDemandC: number;
  robotSpeed: number;
}

const pct = (v: number): number => v / 100;
export const NEUTRAL_MODS: DistrictMods = {
  income: [1, 1, 1], industryOutput: 1, emission: 1, pollutionQ: 256, landValue: 0, levelUpLv: 0, noIndustry: false, crime: 1, nightDemandC: 0, robotSpeed: 1,
};

/** The modifiers of each edict id; the sim reads them through districtMods() and nothing else. */
export const DISTRICT_MODS: readonly DistrictMods[] = [
  NEUTRAL_MODS,
  { ...NEUTRAL_MODS, pollutionQ: Math.round((256 * (100 + N.quietPollutionPct)) / 100), income: [1, 1 + pct(N.quietIncomeCPct), 1] },
  { ...NEUTRAL_MODS, industryOutput: 1 + pct(N.parkOutputPct), emission: 1 + pct(N.parkPollutionPct) },
  { ...NEUTRAL_MODS, levelUpLv: N.highRiseLvPts },
  { ...NEUTRAL_MODS, landValue: N.greenLandValuePts, noIndustry: true },
  { ...NEUTRAL_MODS, nightDemandC: Math.round((N.nightDemandCPts * 1024) / 100), crime: 1 + pct(N.nightCrimePct) },
  { ...NEUTRAL_MODS, robotSpeed: 1 + pct(N.robotSpeedPct) },
];
