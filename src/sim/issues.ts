import { ARCH, BFLAG } from './catalog.ts';
import {
  BANKRUPT_MONTHS, CRIME_TOLERANCE, computeBudget, footprintMean, growthCandidates, isOperating, needsOf, reachAnchors, shopCentres, zoneDemand, zoneOfArch,
} from './economy/index.ts';
import { hazardForecast } from './disasters/hazards.ts';
import { HAZARD_HELP, HAZARD_NAMES, leadText } from './disasters/hazardNames.ts';
import { approvalFactors, approvalOf, GROUP_NAMES, LOW, MONTH_TICKS, openRequests, overlayOf, progressOf, REQ_STATE, requestText, VERY_LOW } from './council/index.ts';
import { mods } from './firmware.ts';
import { archLabel, capitalise } from './labels.ts';
import { BMAX, MAP, RMAX, S, TILES, type World } from './layers.ts';
import type { Issue, IssueCategory, IssueKind, IssueOverlay } from './protocol.ts';
import { isMega, megaOf } from './megaprojects.ts';
import { AKIND, AST, BUILDER_COST, DEPOT_WORK_RADIUS, IMPORT_PRICE, JOB, RES, RES_COUNT, RES_NAMES, SPAWN_RESERVE } from './robots/constants.ts';
import { available, countAgents, disasterOwned, nearestTileOf } from './robots/pool.ts';
import { reachableStock } from './robots/stock.ts';
import { nearestRoad, roadFlow, roadsOf, UNREACHED, type RoadNet } from './roads/index.ts';
import { COVERED_MIN, crimeOf, footprintMax } from './services/index.ts';
import type { Sim } from './world.ts';

// The advisor's list: what is wrong with the city right now, ranked. Pure and read-only: it reads registry layers and the
// derived caches, writes nothing to the world, and is never hashed or saved, so it cannot change a run. The worker refreshes it
// about every ISSUE_PERIOD ticks (2 s at 1x); the same world always gives the same list in the same order.

export const ISSUE_PERIOD = 20;
export const MAX_ISSUES = 8;

/** A robot that has failed this many path searches in a row (the backoff doubles each time) counts as stuck. */
const STUCK_TRIES = 2;
/** A crime hot spot is a building at or over this crime (0..255); it takes HOT_BUILDINGS of them to call it an area. */
const CRIME_HOT = 150;
const HOT_BUILDINGS = 3;
/** Failed-commute memory (cFail, 0..255) at which a home counts as cut off from work; 2 failed commutes put 48 there. */
const COMMUTE_HOT = 48;
/** Buildings outside every fire station's reach before the advisor says so. */
const UNCOVERED_FIRE = 3;
/** Zone demand (0..1) at which missing land is worth a warning. */
const DEMAND_WARN = 0.3;
/** Longest search for the nearest powered or watered tile beside a dark building. */
const GAP_REACH = 12;
/** Months of cash left (at the running month's net) under which the advisor warns before the treasury goes negative. */
const RUNWAY_MONTHS = 4;

const KIND_ORDER: readonly IssueKind[] = ['fire', 'budget', 'depot', 'power', 'water', 'stuck', 'jobs', 'resource', 'commute', 'crime', 'hazard', 'noFire', 'noLand', 'abandoned', 'needs', 'request', 'approval'];
/** Buildings stuck for the same missing thing before the advisor says so. */
const NEEDS_MIN = 3;
const ZONE_WORD = ['', 'homes', 'shops', 'industry'] as const;
const ZONE_BUILDING = ['', 'residential', 'commercial', 'industrial'] as const;

const distBuf = new Uint16Array(TILES);

const netOf = (sim: Sim): RoadNet => (sim.roads && sim.roads.world === sim.world ? sim.roads : roadsOf(sim));
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const finished = (w: World, s: number): boolean => (w.bFlags[s]! & (BFLAG.CONSTRUCTING | BFLAG.RUBBLE)) === 0;
const centreOf = (w: World, s: number): { x: number; y: number } => ({ x: w.bX[s]! + (w.bW[s]! >> 1), y: w.bY[s]! + (w.bH[s]! >> 1) });

/** Mean centre of the finished grown buildings (all zones, or one), else the middle of the map; whole tiles. */
function cityCentre(w: World, zone = 0): { x: number; y: number } {
  let n = 0, sx = 0, sy = 0;
  for (let s = 0; s < BMAX; s++) {
    const z = zoneOfArch(w.bArch[s]!);
    if (z === 0 || (zone !== 0 && z !== zone) || !finished(w, s)) continue;
    const c = centreOf(w, s);
    sx += c.x; sy += c.y; n++;
  }
  return n === 0 ? (zone === 0 ? { x: MAP >> 1, y: MAP >> 1 } : cityCentre(w)) : { x: Math.floor(sx / n), y: Math.floor(sy / n) };
}

function make(kind: IssueKind, category: IssueCategory, severity: number, count: number, at: { x: number; y: number }, text: string, overlay: IssueOverlay, id: string = kind): Issue {
  return { id, kind, category, severity: Math.max(0, Math.min(100, Math.round(severity))), count, x: at.x, y: at.y, text, overlay };
}

/**
 * Chebyshev distance from a footprint to the nearest tile of `layer` holding 1 (served) or 2 (browned out) within GAP_REACH,
 * and the value found there. d is -1 when there is none. Scans rows top to bottom, so ties keep the first tile.
 */
function nearestServed(layer: Uint8Array, x: number, y: number, bw: number, bh: number): { d: number; v: number } {
  let best = -1, bv = 0;
  const x1 = x + bw - 1, y1 = y + bh - 1;
  for (let yy = Math.max(0, y - GAP_REACH); yy <= Math.min(MAP - 1, y1 + GAP_REACH); yy++) {
    for (let xx = Math.max(0, x - GAP_REACH); xx <= Math.min(MAP - 1, x1 + GAP_REACH); xx++) {
      const v = layer[yy * MAP + xx]!;
      if (v !== 1 && v !== 2) continue;
      const dx = xx < x ? x - xx : xx > x1 ? xx - x1 : 0, dy = yy < y ? y - yy : yy > y1 ? yy - y1 : 0;
      const d = Math.max(dx, dy);
      if (best < 0 || d < best) { best = d; bv = v; }
    }
  }
  return { d: best, v: bv };
}

function outageIssue(w: World, flag: number, layer: Uint8Array, kind: 'power' | 'water'): Issue | null {
  let n = 0, best = -1, bestD = Infinity, bestV = 0;
  for (let s = 0; s < BMAX; s++) {
    if (w.bArch[s] === 0 || (w.bFlags[s]! & flag) === 0 || !finished(w, s)) continue;
    n++;
    const g = nearestServed(layer, w.bX[s]!, w.bY[s]!, w.bW[s]!, w.bH[s]!);
    const d = g.d < 0 ? Infinity : g.d;
    if (best < 0 || d < bestD) { best = s; bestD = d; bestV = g.v; }
  }
  if (n === 0) return null;
  const power = kind === 'power';
  const who = `${n === 1 ? '1 building has' : `${n} buildings have`} no ${power ? 'power' : 'water'}`;
  let why: string;
  if (bestD === Infinity) why = power ? 'there is no powered line or building within 12 tiles' : 'no water reaches within 12 tiles';
  else if (bestV === 2 && bestD <= 1) why = power ? 'the grid is overloaded, build more power plants' : 'the water supply cannot keep up, build more pumps';
  else if (power) why = bestD <= 1 ? 'it only touches the grid at a corner, join it with a power line' : `nearest gap is ${bestD - 1} ${bestD - 1 === 1 ? 'tile' : 'tiles'} to the grid`;
  else why = `the nearest water is ${bestD} ${bestD === 1 ? 'tile' : 'tiles'} away, lay a pipe`;
  const c = centreOf(w, best);
  return power
    ? make('power', 'utilities', 60 + Math.min(30, n * 2), n, c, `${who}: ${why}.`, 'power')
    : make('water', 'utilities', 55 + Math.min(30, n * 2), n, c, `${who}: ${why}.`, 'water');
}

function fireIssue(w: World): Issue | null {
  let n = 0, hot = -1, heat = -1;
  for (let s = 0; s < BMAX; s++) {
    if (w.bArch[s] === 0 || (w.bFlags[s]! & BFLAG.BURNING) === 0) continue;
    n++;
    if (w.bHeat[s]! > heat) { heat = w.bHeat[s]!; hot = s; }
  }
  if (n === 0) return null;
  const cov = Math.round((footprintMax(w, w.covFire, hot) * 100) / 255);
  const where = archLabel(w.bArch[hot]!);
  return make('fire', 'safety', 100, n, centreOf(w, hot), `${n === 1 ? `A ${where} is` : `${n} buildings are`} on fire. Fire cover there is ${cov}%.`, 'fire');
}

function budgetIssue(w: World): Issue | null {
  const s = w.scalars, treasury = s[S.treasury]!, at = cityCentre(w);
  if (treasury < 0) {
    const left = Math.max(0, BANKRUPT_MONTHS - s[S.lowMonths]!);
    return make('budget', 'economy', 90, 1, at, `The treasury is $${Math.round(-treasury).toLocaleString('en-US')} in debt. ${left === 0 ? 'Services are failing.' : `${plural(left, 'month', 'months')} until services fail.`}`, 'none');
  }
  const net = computeBudget(w, s[S.month]!).net;
  if (net >= 0) return null;
  const months = Math.floor(treasury / -net);
  if (months >= RUNWAY_MONTHS) return null;
  return make('budget', 'economy', 60 + (RUNWAY_MONTHS - months) * 8, 1, at, `The city loses $${Math.round(-net).toLocaleString('en-US')} a month. The treasury lasts about ${plural(months, 'month', 'months')}.`, 'none');
}

interface Census { depots: number; firstDepot: number; zoned: number[]; firstZoned: number; jobs: number }

function census(w: World): Census {
  let depots = 0, firstDepot = -1, jobs = 0, firstZoned = -1;
  const zoned = [0, 0, 0, 0];
  for (let s = 0; s < BMAX; s++) {
    if (w.bArch[s] === ARCH.DEPOT) { depots++; if (firstDepot < 0) firstDepot = s; }
    if (w.jKind[s] !== 0 && w.jGen[s] === w.bGen[s] && w.bArch[s] !== 0) jobs++;
  }
  for (let i = 0; i < TILES; i++) {
    const z = w.zone[i]! & 3;
    if (z === 0) continue;
    zoned[z]!++;
    if (firstZoned < 0) firstZoned = i;
  }
  return { depots, firstDepot, zoned, firstZoned, jobs };
}

function depotIssue(sim: Sim, c: Census, anchors: readonly number[] | null): Issue | null {
  const w = sim.world;
  const zoned = c.zoned[1]! + c.zoned[2]! + c.zoned[3]!;
  if (zoned === 0 && c.jobs === 0) return null;
  if (c.depots === 0) {
    const at = c.firstZoned >= 0 ? { x: c.firstZoned & (MAP - 1), y: c.firstZoned >> 8 } : cityCentre(w);
    return make('depot', 'robots', 80, 1, at, 'Nothing can be built yet: robots need a depot to work from.', 'none');
  }
  if (anchors !== null && anchors.length === 0) {
    return make('depot', 'robots', 78, c.depots, centreOf(w, c.firstDepot), 'The depot has no road at its door, so its robots cannot leave.', 'none');
  }
  return null;
}

function stuckIssue(sim: Sim, net: RoadNet): Issue | null {
  const w = sim.world;
  let strand = 0, cut = 0, firstStrand = -1, firstCut = -1;
  for (let a = 0; a < RMAX; a++) {
    const k = w.aKind[a]!;
    if ((k !== AKIND.BUILDER && k !== AKIND.HAULER) || disasterOwned(w, a)) continue;
    const st = w.aState[a]!;
    if (st === AST.IDLE || st === AST.WORK || w.aTry[a]! < STUCK_TRIES) continue;
    const t = nearestTileOf(w, a);
    if (net.isRoad(t) || nearestRoad(net, t & (MAP - 1), t >> 8, 10) >= 0) { cut++; if (firstCut < 0) firstCut = t; } else { strand++; if (firstStrand < 0) firstStrand = t; }
  }
  const n = strand + cut;
  if (n === 0) return null;
  const tile = cut >= strand ? firstCut : firstStrand;
  const at = { x: tile & (MAP - 1), y: tile >> 8 };
  const text = cut >= strand
    ? `${plural(cut, 'robot is', 'robots are')} stuck: the road to where they are going is blocked or cut.`
    : `${plural(strand, 'robot is', 'robots are')} stranded off the road network. Reconnect a road.`;
  return make('stuck', 'robots', 45 + Math.min(30, n * 5), n, at, text, 'none');
}

/** Material held by depots and working industry: what haulers can pick up. */
export function materialStock(w: World): number {
  let stock = 0;
  for (let s = 0; s < BMAX; s++) {
    const arch = w.bArch[s]!;
    if (arch === ARCH.DEPOT || (zoneOfArch(arch) === 3 && isOperating(w, s))) stock += w.bStock[s]!;
  }
  return stock;
}

/** Road distance from the nearest depot door per tile, UNREACHED beyond DEPOT_WORK_RADIUS. A shared buffer: read it before the next call. */
export function depotDistances(net: RoadNet, anchors: readonly number[], radius = DEPOT_WORK_RADIUS): Uint16Array {
  roadFlow(net, anchors, radius, distBuf);
  return distBuf;
}

type StallCause = 'road' | 'material' | 'builders' | 'haulers' | 'far';
const STALL_ORDER: readonly StallCause[] = ['road', 'material', 'builders', 'haulers', 'far'];

function jobsIssue(sim: Sim, net: RoadNet, c: Census, anchors: readonly number[] | null): Issue | null {
  const w = sim.world;
  if (c.jobs === 0 || anchors === null || anchors.length === 0) return null;
  const crew = countAgents(w);
  const stock = materialStock(w);
  const reach = depotDistances(net, anchors, mods(w).workRadius);
  const count: Record<StallCause, number> = { road: 0, material: 0, builders: 0, haulers: 0, far: 0 };
  const first: Record<StallCause, number> = { road: -1, material: -1, builders: -1, haulers: -1, far: -1 };
  for (let s = 0; s < BMAX; s++) {
    if (w.bArch[s] === 0 || w.jKind[s] === 0 || w.jGen[s] !== w.bGen[s]) continue;
    const wants = w.jKind[s] !== 3 && w.jNeed[s]! > w.jHave[s]! + w.jInbound[s]!;
    let cause: StallCause | null = null;
    if (w.jStuck[s]! > 0) cause = 'road';
    else if (wants && w.jRes[s] === 0 && stock === 0) cause = 'material';
    else if (crew.builders === 0) cause = 'builders';
    else if (wants && crew.haulers === 0) cause = 'haulers';
    else if (reach[w.jAccess[s]!] === UNREACHED) cause = 'far';
    if (!cause) continue;
    count[cause]++;
    if (first[cause] < 0) first[cause] = s;
  }
  const cause = STALL_ORDER.find((k) => count[k] > 0);
  if (!cause) return null;
  const n = count[cause], site = first[cause], sites = plural(n, 'building site', 'building sites');
  const broke = available(w) < BUILDER_COST + SPAWN_RESERVE;
  const text = {
    road: `${sites} cannot be reached by road from a depot.`,
    material: `${sites} ${n === 1 ? 'is' : 'are'} waiting for material: no depot or factory has any in stock.`,
    builders: `${sites} ${n === 1 ? 'is' : 'are'} waiting for builder bots${broke ? ': the treasury is too low to build more robots' : ''}.`,
    haulers: `${sites} ${n === 1 ? 'is' : 'are'} waiting for hauler drones${broke ? ': the treasury is too low to build more robots' : ''}.`,
    far: `${sites} ${n === 1 ? 'is' : 'are'} far from any depot, so work there is slow. Build a depot closer.`,
  }[cause];
  const severity = { road: 55, material: 50, builders: broke ? 55 : 45, haulers: broke ? 55 : 45, far: 30 }[cause];
  return make('jobs', 'robots', severity + Math.min(20, n * 2), n, centreOf(w, site), text, 'none');
}

/** One issue per scarce resource (Alloy, Components): the jobs that still want more than the depots and producers hold. */
function resourceIssues(w: World): Issue[] {
  const out: Issue[] = [];
  for (let res = RES.ALLOY; res < RES_COUNT; res++) {
    let n = 0, first = -1, short = 0;
    for (let s = 0; s < BMAX; s++) {
      if (w.bArch[s] === 0 || w.jGen[s] !== w.bGen[s] || (w.jKind[s] !== JOB.BUILD && w.jKind[s] !== JOB.LEVEL) || w.jRes[s] !== res || isMega(w.bArch[s]!)) continue;
      const left = w.jNeed[s]! - w.jHave[s]! - w.jInbound[s]!;
      if (left <= 0) continue;
      n++; short += left;
      if (first < 0) first = s;
    }
    if (n === 0 || reachableStock(w, res) >= short) continue;
    const fix = res === RES.ALLOY ? 'Build a Mine and a Smelter' : 'Build a Factory';
    out.push(make('resource', 'robots', 52 + Math.min(20, n * 2), n, centreOf(w, first), `${RES_NAMES[res]} shortage blocks ${plural(n, 'upgrade', 'upgrades')}. ${fix}, or depots import it slowly.`, 'none', `resource-${res}`));
  }
  return out;
}

/** A megaproject stage needs Components; one issue per project whose stage wants more than the depots and Factories hold. */
function megaWaitIssues(w: World): Issue[] {
  const out: Issue[] = [];
  for (let s = 0; s < BMAX; s++) {
    const arch = w.bArch[s]!, spec = megaOf(arch);
    if (!spec || w.jGen[s] !== w.bGen[s] || w.jKind[s] !== JOB.BUILD || w.jRes[s] !== RES.PARTS) continue;
    const left = w.jNeed[s]! - w.jHave[s]! - w.jInbound[s]!;
    if (left <= 0 || reachableStock(w, RES.PARTS) >= left) continue;
    const stage = spec.stages[Math.min(w.bLevel[s]!, spec.stages.length - 1)]!.name;
    out.push(make('resource', 'robots', 62, 1, centreOf(w, s),
      `The ${archLabel(arch)} stage "${stage}" waits on ${plural(left, 'Component', 'Components')}. Build a Factory, or depots import them at $${IMPORT_PRICE[RES.PARTS]} each.`, 'none', `resource-mega-${arch}`));
  }
  return out;
}

const NEED_TEXT: Record<string, [string, string, IssueOverlay]> = {
  services: ['home wants a clinic or school', 'homes want a clinic or school', 'health'],
  shop: ['home wants a shop nearby', 'homes want a shop nearby', 'none'],
  goods: ['shop needs local goods', 'shops need local goods: zone industry or build a Smelter within 30 tiles', 'none'],
  components: ['shop needs components for its goods', 'shops need components for their goods: build a Factory or stock a depot', 'none'],
};

/** Buildings that cannot level up for want of something the city could build (a clinic, a shop, a Factory): grouped by what is missing. */
function needsIssues(w: World): Issue[] {
  const shops = shopCentres(w);
  const count: Record<string, number> = { services: 0, shop: 0, goods: 0, components: 0 }, first: Record<string, number> = { services: -1, shop: -1, goods: -1, components: -1 };
  const hit = (key: string, s: number): void => { count[key]!++; if (first[key]! < 0) first[key] = s; };
  for (let s = 0; s < BMAX; s++) {
    const z = zoneOfArch(w.bArch[s]!);
    if ((z !== 1 && z !== 2) || !finished(w, s) || !isOperating(w, s) || w.bLevel[s]! >= 3) continue;
    for (const n of needsOf(w, s, shops)) {
      if (n.ok || n.id === 'power' || n.id === 'water') continue;
      hit(n.id === 'shop' || n.id === 'goods' || n.id === 'components' ? n.id : 'services', s);
    }
  }
  const out: Issue[] = [];
  for (const key of ['services', 'shop', 'goods', 'components']) {
    const n = count[key]!;
    if (n < NEEDS_MIN) continue;
    const [one, many, overlay] = NEED_TEXT[key]!;
    out.push(make('needs', 'growth', 28 + Math.min(20, n), n, centreOf(w, first[key]!), `${n} ${n === 1 ? one : many}.`, overlay, `needs-${key}`));
  }
  return out;
}

function commuteIssue(w: World): Issue | null {
  let n = 0, worst = -1, worstV = 0;
  for (let s = 0; s < BMAX; s++) {
    if (zoneOfArch(w.bArch[s]!) !== 1 || !finished(w, s)) continue;
    const v = footprintMean(w, w.cFail, s);
    if (v < COMMUTE_HOT) continue;
    n++;
    if (v > worstV) { worstV = v; worst = s; }
  }
  if (n === 0) return null;
  const jammed = w.scalars[S.congestion]! > 0.5;
  const why = jammed ? 'the roads are jammed' : 'there is no road to work, or work is too far away';
  return make('commute', 'growth', 50 + Math.min(20, n * 2), n, centreOf(w, worst), `${plural(n, 'home keeps', 'homes keep')} failing the commute: ${why}.`, 'traffic');
}

function crimeIssue(w: World): Issue | null {
  let n = 0, worst = -1, worstC = -1;
  for (let s = 0; s < BMAX; s++) {
    if (zoneOfArch(w.bArch[s]!) === 0 || !finished(w, s)) continue;
    const c = crimeOf(w, s);
    if (c < CRIME_HOT) continue;
    n++;
    if (c > worstC) { worstC = c; worst = s; }
  }
  if (n < HOT_BUILDINGS) return null;
  const police = footprintMax(w, w.covPolice, worst) < COVERED_MIN;
  const why = police ? 'no police station reaches there' : 'the police are stretched thin and land value is low';
  return make('crime', 'safety', 40 + Math.min(25, n * 2), n, centreOf(w, worst), `Crime is high around ${n} buildings: ${why}.`, 'crime');
}

function fireCoverIssue(w: World): Issue | null {
  let n = 0, pick = -1, stations = 0;
  for (let s = 0; s < BMAX; s++) {
    if (w.bArch[s] === ARCH.FIRE_STATION) stations++;
    if (zoneOfArch(w.bArch[s]!) === 0 || !finished(w, s) || footprintMax(w, w.covFire, s) >= COVERED_MIN) continue;
    n++;
    if (pick < 0) pick = s;
  }
  if (n < UNCOVERED_FIRE) return null;
  const text = stations === 0
    ? `There is no fire station: ${n} buildings are unprotected.`
    : `${n} buildings are outside any fire station's reach.`;
  return make('noFire', 'safety', 30 + Math.min(20, n), n, centreOf(w, pick), text, 'fire');
}

function landIssues(sim: Sim, c: Census): Issue[] {
  const w = sim.world, out: Issue[] = [];
  if (c.depots === 0) return out;
  for (let z = 1; z <= 3; z++) {
    const d = zoneDemand(w, z);
    if (d < DEMAND_WARN || growthCandidates(sim, z, 1).length > 0) continue;
    const pct = Math.round(d * 100);
    const word = ZONE_WORD[z]!;
    const text = c.zoned[z] === 0
      ? `Demand for ${word} is ${pct}% but no ${ZONE_BUILDING[z]} land is zoned. Zone some.`
      : `Demand for ${word} is ${pct}% but the zoned land has no free lot with a road along one edge.`;
    out.push(make('noLand', 'growth', 35 + Math.round(d * 30), 1, cityCentre(w, z), text, 'landValue', `noLand-${z}`));
  }
  return out;
}

function abandonedIssue(w: World): Issue | null {
  let n = 0, first = -1;
  for (let s = 0; s < BMAX; s++) {
    if (w.bArch[s] === 0 || (w.bFlags[s]! & (BFLAG.ABANDONED | BFLAG.RUBBLE)) !== BFLAG.ABANDONED) continue;
    n++;
    if (first < 0) first = s;
  }
  if (n === 0) return null;
  const crime = footprintMean(w, w.crime, first), smog = footprintMean(w, w.pollution, first), lv = footprintMean(w, w.landValue, first);
  const [why, overlay]: [string, IssueOverlay] = crime > CRIME_TOLERANCE ? ['crime drove people out', 'crime'] : smog >= 90 ? ['smog drove people out', 'pollution'] : [`land value is only ${lv}`, 'landValue'];
  return make('abandoned', 'growth', 35 + Math.min(30, n * 3), n, centreOf(w, first), `${capitalise(plural(n, 'building is', 'buildings are'))} abandoned: ${why}.`, overlay);
}

/** A forecast hazard this close (ticks) with the city not ready for it earns an advisor line; one that is already running does too. */
const HAZARD_NEAR = 7200;

function hazardIssue(w: World): Issue | null {
  const f = hazardForecast(w);
  if (!f || !f.prep.applicable || f.prep.ready || (!f.active && f.startsIn > HAZARD_NEAR)) return null;
  const help = HAZARD_HELP[f.kind];
  const pct = Math.round(f.prep.coverage * 100);
  const when = f.active ? 'is here' : leadText(f.startsIn);
  const fix = help ? ` Build ${help.name.toLowerCase()}s.` : '';
  const urgency = f.active ? 25 : Math.round(((HAZARD_NEAR - f.startsIn) / HAZARD_NEAR) * 25);
  return make('hazard', 'safety', 45 + urgency + f.level, 1, cityCentre(w), `${HAZARD_NAMES[f.kind]} ${when}: only ${pct}% of the city is protected.${fix}`, 'none');
}

const FACTOR_OVERLAY: Record<string, IssueOverlay> = { pollution: 'pollution', crime: 'crime', outages: 'power', commutes: 'traffic', services: 'none' };

/** Council requests near their deadline or waiting for an answer, and approval low enough to cost money and build speed. */
function councilIssues(w: World): Issue[] {
  const out: Issue[] = [];
  const tick = w.scalars[S.tick]!;
  for (const r of openRequests(w)) {
    const left = r.deadline - tick, who = GROUP_NAMES[r.group]!, p = progressOf(w, r);
    if (r.state === REQ_STATE.ACCEPTED && left < MONTH_TICKS && !p.done) {
      out.push(make('request', 'services', 50 + (1 - Math.max(0, left) / MONTH_TICKS) * 30, 1, r, `${who} deadline under a month away: ${requestText(r)} ${p.text}.`, overlayOf(r.kind), `request-${r.id}`));
    } else if (r.state === REQ_STATE.PENDING) {
      out.push(make('request', 'services', 28, 1, r, `${who} are waiting for an answer: ${requestText(r)}`, overlayOf(r.kind), `request-${r.id}`));
    }
  }
  const a = approvalOf(w);
  if (a < LOW) {
    const worst = approvalFactors(w).reduce((m, f) => (f.value < m.value ? f : m));
    const why = worst.value < 0 ? `${worst.label.toLowerCase()} is the biggest cause` : 'nothing stands out';
    const text = a < VERY_LOW
      ? `Approval is ${Math.round(a)}%, the people are furious: ${why}. Taxes are resisted and the robots are slowing down.`
      : `Approval is ${Math.round(a)}%: ${why}. Taxes are resisted and the robots are slowing down.`;
    out.push(make('approval', 'services', a < VERY_LOW ? 85 : 40 + (LOW - a) * 1.5, 1, cityCentre(w), text, FACTOR_OVERLAY[worst.key] ?? 'none'));
  }
  return out;
}

/** Every problem the world has right now, worst first, at most MAX_ISSUES. */
export function deriveIssues(sim: Sim): Issue[] {
  const w = sim.world, net = netOf(sim), c = census(w);
  const anchors = reachAnchors(sim, net);
  const found: (Issue | null)[] = [
    fireIssue(w), budgetIssue(w), depotIssue(sim, c, anchors),
    outageIssue(w, BFLAG.UNPOWERED, w.powerOn, 'power'), outageIssue(w, BFLAG.UNWATERED, w.waterOn, 'water'),
    stuckIssue(sim, net), jobsIssue(sim, net, c, anchors), commuteIssue(w), crimeIssue(w), fireCoverIssue(w), abandonedIssue(w), hazardIssue(w),
    ...landIssues(sim, c), ...councilIssues(w), ...resourceIssues(w), ...megaWaitIssues(w), ...needsIssues(w),
  ];
  const list = found.filter((i): i is Issue => i !== null);
  list.sort((a, b) => b.severity - a.severity || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (a.y * MAP + a.x) - (b.y * MAP + b.x) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return list.slice(0, MAX_ISSUES);
}

/** The cached list, re-derived when ISSUE_PERIOD ticks have passed, the sim moved backwards (a load) or `invalidateIssues` ran. */
export function issuesOf(sim: Sim): Issue[] {
  const tick = sim.world.scalars[S.tick]!;
  if (sim.issues === undefined || sim.issuesTick === undefined || tick - sim.issuesTick >= ISSUE_PERIOD || tick < sim.issuesTick) {
    sim.issues = deriveIssues(sim);
    sim.issuesTick = tick;
  }
  return sim.issues;
}

export const invalidateIssues = (sim: Sim): void => { sim.issues = undefined; };
