import { DAY_TICKS } from '../layers.ts';

// Every balancing constant of approval, council requests and festivals. Plain numbers: the sim reads them, the tests and the panel quote them.

/** Approval meter bounds and the thresholds the effects switch on at. Festivals need approval strictly above FESTIVAL_MIN. */
export const APPROVAL_NEUTRAL = 50;
export const FESTIVAL_MIN = 70;
export const HIGH = 70;
export const LOW = 35;
export const VERY_LOW = 15;
/** Consecutive months under VERY_LOW before the warning event. */
export const VERY_LOW_MONTHS = 3;
/** Share of the gap to the monthly target that approval closes each month (an EMA). */
export const EMA = 0.35;

// ---- Effects ----
/** Demand (Q10) a point of approval above HIGH adds to R and C; a point below LOW takes from all three zones. */
export const DEMAND_UP_PER_PT = 6;
export const DEMAND_DOWN_PER_PT = 5;
/** Below LOW, each point costs this share of every zone's tax income (0.004 = 0.4%, so 14% at approval 0). */
export const TAX_RESIST_PER_PT = 0.004;
/** Below LOW, robots build this much slower ("robot sabotage"). */
export const SABOTAGE_SLOW = 0.05;

// ---- The monthly target: BASE plus one term per factor, each with its own range (see approval.ts) ----
export const BASE = 58;
export const W_SERVICES = 20;
export const SERVICES_OFFSET = -6;
export const W_POLLUTION = 16;
export const W_CRIME = 16;
export const W_COMMUTE = 20;
export const W_OUTAGE = 24;
export const EMPLOY_BASE = 4;
export const EMPLOY_SLOPE = 40;
export const EMPLOY_MIN = -16;
export const TAX_SLOPE_PTS = 1.5;
export const TAX_MIN = -12;
export const TAX_MAX_PTS = 6;
export const DISASTER_W = 3.5;
export const DISASTER_CAP = 14;
export const OUTCOME_W = 0.5;
export const OUTCOME_CAP = 10;

// ---- Requests ----
export const MONTH_TICKS = DAY_TICKS;
/** A request is posted every REQUEST_GAP_MIN to REQUEST_GAP_MIN + REQUEST_GAP_SPAN - 1 months. */
export const REQUEST_GAP_MIN = 2;
export const REQUEST_GAP_SPAN = 3;
/** Deadline of a request, in months: DEADLINE_MIN to DEADLINE_MIN + DEADLINE_SPAN - 1. */
export const DEADLINE_MIN = 2;
export const DEADLINE_SPAN = 3;
/** Requests are checked for completion and deadline this often. */
export const REQUEST_PERIOD = 20;
export const DECLINE_PENALTY = 1;
export const PARK_RADIUS = 12;
export const POLLUTION_RADIUS = 8;
/** Jobs a commercial or industrial request asks the city to add. */
export const JOBS_ASKED = 20;
export const BUILD_JOBS = 3;
export const POWER_TARGET = 80;
export const JAM_HEAT = 150;
export const JAM_CLEAR = 100;

/** The citizen groups that post requests. */
export const GROUP = { RESIDENTS: 0, MERCHANTS: 1, INDUSTRIALISTS: 2, ENGINEERS: 3 } as const;
export const GROUP_NAMES = ['Residents', 'Merchants', 'Industrialists', 'Engineers'] as const;

/** Offsets inside a request record of the `council` layer (C.REQ0 + slot * C.REQ_STRIDE). */
export const REQ = {
  STATE: 0, ID: 1, KIND: 2, GROUP: 3, POSTED: 4, DEADLINE: 5, X: 6, Y: 7, TARGET: 8, BASE: 9, CASH: 10, APPROVAL: 11, RP: 12, PENALTY: 13,
} as const;
export const REQ_STATE = { FREE: 0, PENDING: 1, ACCEPTED: 2 } as const;

// ---- Festivals ----
export interface FestivalDef {
  id: number;
  name: string;
  cost: number;
  /** Approval points added on the day. */
  approval: number;
  /** Commercial demand (Q10) added while the boost lasts, and for how long. */
  demand: number;
  boostTicks: number;
  /** How long the show runs. */
  showTicks: number;
  cooldownTicks: number;
  nightOnly: boolean;
  blurb: string;
}

export const FESTIVAL = { BLOCK_PARTY: 0, ROBOT_PARADE: 1, FIREWORKS: 2 } as const;
export const FESTIVALS: readonly FestivalDef[] = [
  { id: FESTIVAL.BLOCK_PARTY, name: 'Block Party', cost: 600, approval: 3, demand: 120, boostTicks: DAY_TICKS, showTicks: 1200, cooldownTicks: 2 * DAY_TICKS, nightOnly: false, blurb: 'Streamers and a street feast.' },
  { id: FESTIVAL.ROBOT_PARADE, name: 'Robot Parade', cost: 2500, approval: 6, demand: 200, boostTicks: DAY_TICKS, showTicks: 1800, cooldownTicks: 4 * DAY_TICKS, nightOnly: false, blurb: 'Every robot marches down the main road.' },
  { id: FESTIVAL.FIREWORKS, name: 'Fireworks Night', cost: 6000, approval: 10, demand: 300, boostTicks: 2 * DAY_TICKS, showTicks: 1500, cooldownTicks: 6 * DAY_TICKS, nightOnly: true, blurb: 'After dark only.' },
];
export const FESTIVAL_COUNT = FESTIVALS.length;
