import { ARCH, archetype, BFLAG, type Archetype } from './catalog.ts';
import { DEPOT_START_STOCK } from './robots/constants.ts';
import { DIRECTIVES, DIRECTIVE_COUNT, directiveMet } from './directives.ts';
import { grantRp, invalidateModuleCache, mods, researchNode, setModule, toggleEdictCard } from './firmware.ts';
import { debugScenario, finishScenario } from './scenarioRun.ts';
import { clearJob } from './robots/pool.ts';
import { setLivery } from './robots/livery.ts';
import { isChainArch, used } from './robots/stock.ts';
import { DMODE, LEAD_MIN, planHazard, rebuildAll, setDisasterMode, triggerDisaster } from './disasters/index.ts';
import { debugPost, holdFestival, respond } from './council/index.ts';
import { districtTileCounts, initDistrict, renameDistrict, setDistrictEdict, setDistrictStyle, touchDistricts } from './districts.ts';
import { repayLoan, takeLoan } from './economy/budget.ts';
import { TAX_SCALAR } from './economy/demand.ts';
import { TAX_MAX } from './economy/tables.ts';
import { estimate, estimateSite, footprintOf, isInts, rectOf } from './estimate.ts';
import { D, HAZ, MAP, RMAX, ROAD, S, SLOPE_LIMIT, TERRAIN, UCELLS, UMAX, isWaterTerrain, type World } from './layers.ts';
import { megaBlock } from './milestones.ts';
import { yearPosition } from './seasons.ts';
import { MAX_TIER } from './unlocks.ts';
import { isMega, megaStages } from './megaprojects.ts';
import { inBounds, tileIdx } from './tiles.ts';
import { markDirty, type Sim } from './world.ts';

export type CommandBody =
  | { type: 'placeRoad'; ax: number; ay: number; bx: number; by: number; cls: number }
  | { type: 'zone'; x0: number; y0: number; x1: number; y1: number; zone: number; density: number }
  /** `under` clears water pipes only; without it the surface is cleared: buildings, roads, zones and power lines. */
  | { type: 'bulldoze'; x0: number; y0: number; x1: number; y1: number; under?: boolean }
  /** A power line or water pipe along the road-style L path (along x at ay from ax to bx, then along y at bx). Undoable. */
  | { type: 'placeLine'; kind: 'power' | 'water'; ax: number; ay: number; bx: number; by: number }
  | { type: 'placeBuilding'; arch: number; x: number; y: number; rot: number }
  /** (x0, y0) is where the drag began: `level` flattens to that tile's height. Not undoable (the journal holds roads and zones only). */
  | { type: 'terraform'; mode: 'raise' | 'lower' | 'level'; x0: number; y0: number; x1: number; y1: number }
  /** `stage` (megaprojects only) is the stage a project under construction is at. */
  | { type: 'debugGrow'; x: number; y: number; archetype: number; progress: number; stage?: number }
  | { type: 'debugLevel'; x0: number; y0: number; x1: number; y1: number; margin: number }
  /** Debug-only: raise the population tier to at least `tier` with no bonus and no event (the showcase builds avenues and high density). */
  | { type: 'debugTier'; tier: number }
  /** Whole percent 0..TAX_MAX for one zone (1 R, 2 C, 3 I), or for all three when `zone` is omitted. */
  | { type: 'setTax'; rate: number; zone?: number }
  /** Borrow LOAN_TIERS[tier]; at most MAX_LOANS at once. */
  | { type: 'takeLoan'; tier: number }
  /** Repay the whole principal of the loan in `slot` from the treasury. */
  | { type: 'repayLoan'; slot: number }
  /** Disasters setting: 0 off, 1 rare, 2 normal. Off stops random ignition, lightning fires, quakes and meteors; fires already burning run out. */
  | { type: 'setDisasters'; mode: number }
  /** Sandbox: start a fire in the building at (x, y) (or nearest), a quake centred on it, or a meteor that lands on it. Allowed in normal play, in any mode. */
  | { type: 'triggerDisaster'; kind: 'fire' | 'quake' | 'meteor'; x: number; y: number }
  | { type: 'undo'; target: number }
  /** Pay the credit reward of UNIT-0 directive `index` (sim/directives.ts) once it has been met. Rejected as `claimed` the second time. */
  | { type: 'claimDirective'; index: number }
  /** Buy firmware node `node` (sim/firmware.ts NODE) with research points. Needs its prerequisite; rejected `owned` the second time. */
  | { type: 'research'; node: number }
  /** Enact or repeal edict `edict` (EDICT; not `id`, which every command already carries). Enacting needs its population tier and fewer than MAX_EDICTS active. */
  | { type: 'toggleEdict'; edict: number }
  /** Fit module `module` (MODULE, 0 clears) into slot `index` (0 or 1) of the depot in building slot `slot`. Pays its price, refunds half the one it replaces. */
  | { type: 'setDepotModule'; slot: number; index: number; module: number }
  /** Paint the depot in building slot `slot` in scheme `livery` (LIVERIES, 0..5); its builders and hauler drones wear it. Free. */
  | { type: 'setDepotLivery'; slot: number; livery: number }
  /** Debug-only: add research points. */
  | { type: 'debugRp'; amount: number }
  /** Order every ruin rebuilt at a 25% discount, paid now; the robots clear each ruin and raise the building again (sim/disasters/rebuild.ts). */
  | { type: 'rebuildAll' }
  /** Debug-only: jump the calendar to game day `day` (0 is the first day of spring), keeping the time of day. */
  | { type: 'debugSeason'; day: number }
  /** Debug-only: plan a hazard of kind HAZ now, announced at once and starting `lead` ticks later (default one month). Needs disasters on. */
  | { type: 'debugHazard'; kind: number; lead?: number }
  /** Accept or decline the council request in `slot` (0 or 1; sim/council). Declining costs a little approval. */
  | { type: 'councilRespond'; slot: number; accept: boolean }
  /** Pay for a festival (FESTIVAL id; needs approval above 70, the festival off cooldown, and night for Fireworks). */
  | { type: 'holdFestival'; festival: number }
  /** Debug-only: post a council request of `kind` (council KIND) at once, whatever the city looks like; `accept` also accepts it. */
  | { type: 'debugCouncil'; kind: number; accept?: boolean }
  /** Scenario: end it now as won with the stars earned so far (at least one). */
  | { type: 'finishScenario' }
  /** Debug-only: treat the scenario goal's metric as `value` and evaluate at once. */
  | { type: 'debugScenario'; value: number }
  /** Give the land in a rect to district `district` (1..DMAX; an id with no tiles founds a new district with a generated name). Free; undoable. */
  | { type: 'paintDistrict'; x0: number; y0: number; x1: number; y1: number; district: number }
  /** Take the land in a rect out of whichever districts hold it. A district with no tiles left is gone. Undoable. */
  | { type: 'eraseDistrict'; x0: number; y0: number; x1: number; y1: number }
  /** Rename a district to `name` (up to 20 letters, digits, spaces and ' - & .), or to the generated name at `pool`. */
  | { type: 'renameDistrict'; district: number; name?: string; pool?: number }
  /** Set a district's edict (DEDICT; 0 clears it). The edict's monthly price is booked in the budget. */
  | { type: 'setDistrictEdict'; district: number; edict: number }
  | { type: 'setDistrictStyle'; district: number; style: number };

/** For undo, `target` is the sim-assigned journal id from the `accepted` event, not a command id. `tick` is the earliest tick the command may run; `id` is unique and positive. */
export type Command = { id: number; tick: number } & CommandBody;

const UNDO = { NONE: 0, ROAD: 1, ZONE: 2, BUILDING: 3, LINE: 4, DISTRICT: 5 } as const;
const NEI = [[0, -1, ROAD.N], [1, 0, ROAD.E], [0, 1, ROAD.S], [-1, 0, ROAD.W]] as const;

class Reject extends Error {}
const reject = (reason: string): never => { throw new Reject(reason); };

export function fixRoad(world: World, x: number, y: number): void {
  if (!inBounds(x, y)) return;
  const i = tileIdx(x, y);
  const r = world.road[i]!;
  if ((r & ROAD.CLASS_MASK) === 0) return;
  let conn = 0, slope = 0;
  for (const [dx, dy, bit] of NEI) {
    const nx = x + dx, ny = y + dy;
    if (!inBounds(nx, ny)) continue;
    const j = tileIdx(nx, ny);
    if (world.road[j]! & ROAD.CLASS_MASK) conn |= bit;
    if (Math.abs(world.height[j]! - world.height[i]!) > SLOPE_LIMIT) slope = ROAD.SLOPE;
  }
  world.road[i] = (r & ROAD.CLASS_MASK) | (r & ROAD.BRIDGE) | (r & ROAD.DAMAGED) | conn | slope;
}

interface Capture {
  cells: number[];
  road: number[];
  zone: number[];
  ug: number[];
}

/** Power line (bit 0) and pipe (bit 1) presence of one tile. */
const ugBits = (w: World, i: number): number => w.ugPower[i]! | (w.ugWater[i]! << 1);

/** Previous road/zone/line values of the cells a command is about to change. A district command keeps the district id in the `zone` slot. */
function capture(w: World, cells: Iterable<number>, zoneLayer: Uint8Array = w.zone): Capture {
  const uniq = [...new Set(cells)];
  return { cells: uniq, road: uniq.map((i) => w.road[i]!), zone: uniq.map((i) => zoneLayer[i]!), ug: uniq.map((i) => ugBits(w, i)) };
}

/** Records the undo entry after the command mutated the world; returns the sim-assigned journal id (0 = not undoable). */
function journalCommit(sim: Sim, cap: Capture, kind: number, cost: number, arg: number): number {
  const w = sim.world;
  if (cap.cells.length > UCELLS) return 0;
  const slot = w.scalars[S.undoNext]! % UMAX;
  w.scalars[S.undoNext] = (slot + 1) % UMAX;
  const id = w.scalars[S.journalNext]! + 1;
  w.scalars[S.journalNext] = id;
  const base = slot * UCELLS;
  const zoneLayer = kind === UNDO.DISTRICT ? w.district : w.zone;
  cap.cells.forEach((idx, n) => {
    w.jIdx[base + n] = idx;
    w.jPrevRoad[base + n] = cap.road[n]!;
    w.jPostRoad[base + n] = w.road[idx]!;
    w.jPrevZone[base + n] = cap.zone[n]!;
    w.jPostZone[base + n] = zoneLayer[idx]!;
    w.jPrevUg[base + n] = cap.ug[n]!;
    w.jPostUg[base + n] = ugBits(w, idx);
  });
  w.uCmd[slot] = id;
  w.uKind[slot] = kind;
  w.uCount[slot] = cap.cells.length;
  w.uArg[slot] = arg;
  w.uGen[slot] = kind === UNDO.BUILDING ? w.bGen[arg]! : 0;
  w.uCost[slot] = cost;
  return id;
}

/** Validation and cost come from estimate(), the same module the ghost preview runs on the main thread. */
function checked(sim: Sim, c: CommandBody): ReturnType<typeof estimate> {
  const e = estimate(sim.world, c, sim.world.scalars[S.treasury]);
  if (e.reason) reject(e.reason);
  return e;
}

function placeRoad(sim: Sim, c: Extract<Command, { type: 'placeRoad' }>): number {
  const w = sim.world;
  const { validTiles: path, cost } = checked(sim, c);

  const touched: number[] = [];
  for (const i of path) {
    touched.push(i);
    const x = i % MAP, y = (i / MAP) | 0;
    for (const [dx, dy] of NEI) if (inBounds(x + dx, y + dy)) touched.push(tileIdx(x + dx, y + dy));
  }
  const cap = capture(w, touched);

  for (const i of path) {
    const cur = w.road[i]!;
    const cls = Math.max(cur & ROAD.CLASS_MASK, c.cls);
    w.road[i] = cls | (isWaterTerrain(w.terrain[i]!) ? ROAD.BRIDGE : 0);
    w.zone[i] = 0;
  }
  for (const i of cap.cells) { fixRoad(w, i % MAP, (i / MAP) | 0); markDirty(sim, 'geometry', i % MAP, (i / MAP) | 0); }
  w.scalars[S.treasury]! -= cost;
  return journalCommit(sim, cap, UNDO.ROAD, cost, 0);
}

function placeLine(sim: Sim, c: Extract<Command, { type: 'placeLine' }>): number {
  const w = sim.world;
  const { validTiles, cost } = checked(sim, c);
  const cap = capture(w, validTiles);
  const layer = c.kind === 'power' ? w.ugPower : w.ugWater;
  for (const i of validTiles) { layer[i] = 1; markDirty(sim, 'geometry', i % MAP, (i / MAP) | 0); }
  w.scalars[S.treasury]! -= cost;
  return journalCommit(sim, cap, UNDO.LINE, cost, c.kind === 'power' ? 0 : 1);
}

function zone(sim: Sim, c: Extract<Command, { type: 'zone' }>): number {
  const w = sim.world;
  const { validTiles: changed, cost } = checked(sim, c);
  const value = c.zone | (c.density << 2);
  const cap = capture(w, changed);
  for (const i of changed) { w.zone[i] = value; markDirty(sim, 'geometry', i % MAP, (i / MAP) | 0); }
  w.scalars[S.treasury]! -= cost;
  return journalCommit(sim, cap, UNDO.ZONE, cost, 0);
}

/** Paint or erase a district rect. A paint into an id with no tiles founds the district first (generated name, style, no edict). */
function districtRect(sim: Sim, c: Extract<Command, { type: 'paintDistrict' | 'eraseDistrict' }>): number {
  const w = sim.world;
  const { validTiles: changed } = checked(sim, c);
  const cap = capture(w, changed, w.district);
  const value = c.type === 'paintDistrict' ? c.district : 0;
  if (value !== 0) {
    const counts = districtTileCounts(w);
    if (counts[value] === 0) initDistrict(w, value, counts);
  }
  for (const i of changed) { w.district[i] = value; markDirty(sim, 'geometry', i % MAP, (i / MAP) | 0); }
  touchDistricts(w);
  return journalCommit(sim, cap, UNDO.DISTRICT, 0, 0);
}

function districtCommand(sim: Sim, c: Extract<Command, { type: 'renameDistrict' | 'setDistrictEdict' | 'setDistrictStyle' }>): void {
  const w = sim.world;
  const why = c.type === 'renameDistrict' ? renameDistrict(w, c.district, c.name, c.pool)
    : c.type === 'setDistrictEdict' ? setDistrictEdict(w, c.district, c.edict) : setDistrictStyle(w, c.district, c.style);
  if (why) reject(why);
  touchDistricts(w);
}

/** Free a building slot: tiles, table row, stock and any robot job on it; bumps the slot generation. */
export function clearBuilding(sim: Sim, slot: number): void {
  const w = sim.world;
  const x = w.bX[slot]!, y = w.bY[slot]!, bw = w.bW[slot]!, bh = w.bH[slot]!;
  for (let yy = y; yy < y + bh; yy++) for (let xx = x; xx < x + bw; xx++) {
    w.bId[tileIdx(xx, yy)] = 0;
    markDirty(sim, 'geometry', xx, yy);
  }
  w.bArch[slot] = 0; w.bX[slot] = 0; w.bY[slot] = 0; w.bW[slot] = 0; w.bH[slot] = 0;
  w.bRot[slot] = 0; w.bLevel[slot] = 0; w.bProg[slot] = 0; w.bFlags[slot] = 0; w.bAband[slot] = 0;
  // Stock left in a torn-down building is gone; the chain ledger books it as used so created - used still equals what exists.
  used(w, 0, w.bStock[slot]! + w.bIn[slot * 3]!); used(w, 1, w.bAlloy[slot]! + w.bIn[slot * 3 + 1]!); used(w, 2, w.bParts[slot]! + w.bIn[slot * 3 + 2]!);
  w.bAlloy[slot] = 0; w.bParts[slot] = 0; w.bIn[slot * 3] = 0; w.bIn[slot * 3 + 1] = 0; w.bIn[slot * 3 + 2] = 0;
  w.bStock[slot] = 0; w.bAux[slot] = 0; w.bZone[slot] = 0; w.bDmg[slot] = 0; w.bHeat[slot] = 0;
  if (w.bMod[slot] !== 0) { w.bMod[slot] = 0; invalidateModuleCache(w); }
  w.bLivery[slot] = 0;
  clearJob(w, slot);
  w.bGen[slot] = (w.bGen[slot]! + 1) & 0xffff;
  for (let u = 0; u < UMAX; u++) if (w.uKind[u] === UNDO.BUILDING && w.uArg[u] === slot) { w.uKind[u] = UNDO.NONE; w.uCmd[u] = 0; }
  sim.dirty.buildings.add(slot);
}

function bulldoze(sim: Sim, c: Extract<Command, { type: 'bulldoze' }>): void {
  const w = sim.world;
  const { cost, rect } = checked(sim, c);
  const [x0, y0, x1, y1] = rect!;
  if (c.under) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = tileIdx(x, y);
      if (w.ugWater[i]) { w.ugWater[i] = 0; markDirty(sim, 'geometry', x, y); }
    }
    w.scalars[S.treasury]! -= cost;
    return;
  }
  const slots = new Set<number>();
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (w.bId[tileIdx(x, y)]) slots.add(w.bId[tileIdx(x, y)]! - 1);
  for (const s of [...slots].sort((a, b) => a - b)) clearBuilding(sim, s);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = tileIdx(x, y);
    if (w.road[i] || w.zone[i] || w.ugPower[i]) { w.road[i] = 0; w.zone[i] = 0; w.ugPower[i] = 0; markDirty(sim, 'geometry', x, y); }
  }
  for (let y = y0 - 1; y <= y1 + 1; y++) for (let x = x0 - 1; x <= x1 + 1; x++) {
    if (inBounds(x, y) && (x < x0 || x > x1 || y < y0 || y > y1)) { const before = w.road[tileIdx(x, y)]; fixRoad(w, x, y); if (before !== w.road[tileIdx(x, y)]) markDirty(sim, 'geometry', x, y); }
  }
  w.scalars[S.treasury]! -= cost;
}

interface PlaceOptions { level: number; prog: number; flags: number; /** Treasury cost; 0 for free placement. */ cost: number; journal: boolean }

/** Shared placement for placeBuilding and debugGrow: validate the footprint, pick a slot, write the table and tile layers. */
function placeSite(sim: Sim, a: Archetype, x: number, y: number, rot: number, o: PlaceOptions): number {
  const w = sim.world;
  const { w: bw, h: bh } = footprintOf(a, rot);
  const site = estimateSite(w, a, x, y, rot, o.cost, w.scalars[S.treasury]);
  if (site.reason) reject(site.reason);
  let slot = -1;
  for (let s = 0; s < w.bArch.length; s++) if (w.bArch[s] === 0) { slot = s; break; }
  if (slot < 0) reject('full');
  const cells = site.validTiles;
  const cap = o.journal ? capture(w, cells) : undefined;
  w.bArch[slot] = a.id; w.bX[slot] = x; w.bY[slot] = y; w.bW[slot] = bw; w.bH[slot] = bh;
  w.bRot[slot] = rot; w.bLevel[slot] = o.level; w.bProg[slot] = o.prog; w.bFlags[slot] = o.flags; w.bAband[slot] = 0;
  w.bZone[slot] = cells.length > 0 ? w.zone[cells[0]!]! : 0;
  for (const i of cells) { w.bId[i] = slot + 1; w.zone[i] = 0; markDirty(sim, 'geometry', i % MAP, (i / MAP) | 0); }
  sim.dirty.buildings.add(slot);
  w.scalars[S.treasury]! -= o.cost;
  return cap ? journalCommit(sim, cap, UNDO.BUILDING, o.cost, slot) : 0;
}

/** Robot growth: reserve a free site for a grown building (free of charge, not undoable). Returns the slot, or -1 when the site is not valid. */
export function reserveBuilding(sim: Sim, a: Archetype, x: number, y: number, level: number, prog: number, flags: number): number {
  const slotsBefore = sim.world.bArch.indexOf(0);
  if (slotsBefore < 0) return -1;
  try {
    placeSite(sim, a, x, y, 0, { level, prog, flags, cost: 0, journal: false });
  } catch (e) {
    if (e instanceof Reject) return -1;
    throw e;
  }
  return slotsBefore;
}

function placeBuilding(sim: Sim, c: Extract<Command, { type: 'placeBuilding' }>): number {
  if (!isInts(c.arch, c.x, c.y, c.rot) || c.rot < 0 || c.rot > 3) reject('invalid');
  const a = archetype(c.arch) ?? reject('unknown-archetype');
  checked(sim, c);
  if (isMega(a.id)) {
    const block = megaBlock(sim.world, a.id);
    if (block) reject(block);
    // A megaproject starts as a bare foundation; the robots' growth director opens its first stage job once a depot's roads reach it.
    return placeSite(sim, a, c.x, c.y, c.rot, { level: 0, prog: 0, flags: BFLAG.CONSTRUCTING, cost: a.cost, journal: false });
  }
  return placeSite(sim, a, c.x, c.y, c.rot, { level: 0, prog: 0, flags: 0, cost: a.cost, journal: true });
}

/**
 * Debug-only: put a (possibly RCI) building on free land at a chosen construction progress, free of charge and not undoable.
 * It skips the placement rules on purpose, including the Mine's ore-ground rule (`noOre`), so tests and smoke can put a Mine anywhere.
 */
function debugGrow(sim: Sim, c: Extract<Command, { type: 'debugGrow' }>): void {
  if (!sim.debug) reject('debug-only');
  if (!isInts(c.x, c.y, c.archetype) || !Number.isFinite(c.progress) || c.progress < 0 || c.progress > 1) reject('invalid');
  const a = archetype(c.archetype) ?? reject('unknown-archetype');
  const done = c.progress >= 1;
  if (c.stage !== undefined && (!isInts(c.stage) || c.stage < 0)) reject('invalid');
  // A megaproject under construction is at stage `stage` (default the first); once done its level is the stage count.
  const mega = isMega(a.id);
  const level = mega ? (done ? megaStages(a.id) : Math.min(c.stage ?? 0, megaStages(a.id) - 1)) : (a.level ?? 0);
  placeSite(sim, a, c.x, c.y, 0, {
    level, prog: done ? 255 : Math.round(c.progress * 255), flags: done ? 0 : BFLAG.CONSTRUCTING, cost: 0, journal: false,
  });
}

/**
 * Debug-only: level a rectangle of land to its mean height and blend the surrounding `margin` tiles into the existing
 * ground, so a showcase district sits on a plateau instead of a hillside. Dry land only; not undoable, not charged.
 */
function debugLevel(sim: Sim, c: Extract<Command, { type: 'debugLevel' }>): void {
  const w = sim.world;
  if (!sim.debug) reject('debug-only');
  if (!isInts(c.margin) || c.margin < 0 || c.margin > 16) reject('invalid');
  const r = rectOf(c);
  if (typeof r === 'string') reject(r);
  const [x0, y0, x1, y1] = r as [number, number, number, number];
  let sum = 0, n = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = tileIdx(x, y);
    if (isWaterTerrain(w.terrain[i]!) || w.waterDepth[i]! > 0) reject('terrain');
    sum += w.height[i]!; n++;
  }
  const target = Math.round(sum / n);
  const m = c.margin;
  for (let y = Math.max(0, y0 - m); y <= Math.min(MAP - 1, y1 + m); y++) {
    for (let x = Math.max(0, x0 - m); x <= Math.min(MAP - 1, x1 + m); x++) {
      const i = tileIdx(x, y);
      const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0, dy = y < y0 ? y0 - y : y > y1 ? y - y1 : 0;
      const inside = dx === 0 && dy === 0;
      if (!inside && (isWaterTerrain(w.terrain[i]!) || w.waterDepth[i]! > 0)) continue;
      const t = inside ? 1 : Math.max(0, 1 - Math.hypot(dx, dy) / (m + 1));
      const k = t * t * (3 - 2 * t);
      w.height[i] = Math.round(w.height[i]! + (target - w.height[i]!) * k);
      if (inside) w.terrain[i] = TERRAIN.GRASS;
      markDirty(sim, 'geometry', x, y);
    }
  }
  settleGround(sim, x0 - m - 1, y0 - m - 1, x1 + m + 1, y1 + m + 1);
}

function debugTier(sim: Sim, c: Extract<Command, { type: 'debugTier' }>): void {
  if (!sim.debug) reject('debug-only');
  if (!isInts(c.tier) || c.tier < 0 || c.tier > MAX_TIER) reject('invalid');
  sim.world.scalars[S.tier] = Math.max(sim.world.scalars[S.tier]!, c.tier);
}

/** Heights moved inside the rect: road slope flags and building ground heights in and around it are stale. Clamps to the map. */
export function settleGround(sim: Sim, rx0: number, ry0: number, rx1: number, ry1: number): void {
  const w = sim.world;
  const ex0 = Math.max(0, rx0), ey0 = Math.max(0, ry0), ex1 = Math.min(MAP - 1, rx1), ey1 = Math.min(MAP - 1, ry1);
  for (let y = ey0; y <= ey1; y++) for (let x = ex0; x <= ex1; x++) {
    const i = tileIdx(x, y), before = w.road[i]!;
    if (!(before & ROAD.CLASS_MASK)) continue;
    fixRoad(w, x, y);
    if (w.road[i] !== before) markDirty(sim, 'geometry', x, y);
  }
  for (let s = 0; s < w.bArch.length; s++) {
    if (w.bArch[s] && w.bX[s]! + w.bW[s]! > ex0 && w.bX[s]! <= ex1 && w.bY[s]! + w.bH[s]! > ey0 && w.bY[s]! <= ey1) sim.dirty.buildings.add(s);
  }
}

function terraform(sim: Sim, c: Extract<Command, { type: 'terraform' }>): void {
  const w = sim.world;
  const e = checked(sim, c);
  const [x0, y0, x1, y1] = e.rect!;
  e.validTiles.forEach((i, n) => { w.height[i] = e.heights![n]!; markDirty(sim, 'geometry', i % MAP, (i / MAP) | 0); });
  w.scalars[S.treasury]! -= e.cost;
  settleGround(sim, x0 - 1, y0 - 1, x1 + 1, y1 + 1);
}

function undo(sim: Sim, c: Extract<Command, { type: 'undo' }>): number {
  const w = sim.world;
  if (!isInts(c.target) || c.target <= 0) reject('invalid');
  let slot = -1;
  for (let s = 0; s < UMAX; s++) if (w.uCmd[s] === c.target && w.uKind[s] !== UNDO.NONE) slot = s;
  if (slot < 0) reject('not-undoable');
  const base = slot * UCELLS, n = w.uCount[slot]!, kind = w.uKind[slot]!;
  // A line undo looks only at its own kind (uArg 0 power, 1 water): a pipe can be undone under a power line laid later.
  const line = kind === UNDO.LINE, bit = 1 << w.uArg[slot]!;
  for (let k = 0; k < n; k++) {
    const i = w.jIdx[base + k]!;
    if (kind === UNDO.DISTRICT ? w.district[i] !== w.jPostZone[base + k] : line ? (ugBits(w, i) & bit) !== (w.jPostUg[base + k]! & bit) : w.road[i] !== w.jPostRoad[base + k] || w.zone[i] !== w.jPostZone[base + k]) reject('consumed');
  }
  if (kind === UNDO.BUILDING) {
    const b = w.uArg[slot]!;
    if (w.bArch[b] === 0 || w.bGen[b] !== w.uGen[slot] || w.bProg[b] !== 0 || w.bLevel[b] !== 0) reject('consumed');
    // A chain building that has produced, or been fed, holds stock a refund would print.
    if (isChainArch(w.bArch[b]!) && (w.bStock[b]! + w.bAlloy[b]! + w.bParts[b]! + w.bIn[b * 3]! + w.bIn[b * 3 + 1]! > 0)) reject('consumed');
    // A depot whose starting stock was touched, or that already has robots, cannot be refunded: placing, using and undoing it would print material.
    if (w.bArch[b] === ARCH.DEPOT && w.bAux[b] === 1) {
      if (w.bStock[b] !== DEPOT_START_STOCK || w.bAlloy[b] !== 0 || w.bParts[b] !== 0 || w.bMod[b] !== 0) reject('consumed');
      const ref = ((b + 1) | (w.bGen[b]! << 16)) >>> 0;
      for (let a = 0; a < RMAX; a++) if (w.aKind[a] !== 0 && w.aHome[a] === ref) reject('consumed');
    }
    clearBuilding(sim, b);
  }
  const refund = w.uCost[slot]!;
  for (let k = 0; k < n; k++) {
    const i = w.jIdx[base + k]!;
    if (kind === UNDO.DISTRICT) w.district[i] = w.jPrevZone[base + k]!;
    else if (line) (bit === 1 ? w.ugPower : w.ugWater)[i] = (w.jPrevUg[base + k]! & bit) === 0 ? 0 : 1;
    else { w.road[i] = w.jPrevRoad[base + k]!; w.zone[i] = w.jPrevZone[base + k]!; }
    markDirty(sim, 'geometry', i % MAP, (i / MAP) | 0);
  }
  if (kind === UNDO.DISTRICT) touchDistricts(w);
  w.scalars[S.treasury]! += refund;
  w.uCmd[slot] = 0; w.uKind[slot] = UNDO.NONE; w.uCount[slot] = 0; w.uArg[slot] = 0; w.uGen[slot] = 0; w.uCost[slot] = 0;
  return 0;
}

function setTax(sim: Sim, c: Extract<Command, { type: 'setTax' }>): void {
  if (!isInts(c.rate) || (c.zone !== undefined && !isInts(c.zone))) reject('invalid');
  if (c.rate < 0 || c.rate > TAX_MAX) reject('bounds');
  if (c.rate > mods(sim.world).taxCap) reject('tax-cap');
  if (c.zone !== undefined && (c.zone < 1 || c.zone > 3)) reject('bounds');
  for (const z of c.zone === undefined ? [1, 2, 3] : [c.zone!]) sim.world.scalars[TAX_SCALAR[z - 1]!] = c.rate;
}

function loan(sim: Sim, c: Extract<Command, { type: 'takeLoan' | 'repayLoan' }>): void {
  const why = c.type === 'takeLoan' ? takeLoan(sim.world, c.tier) : repayLoan(sim.world, c.slot);
  if (why) reject(why);
}

function claimDirective(sim: Sim, c: Extract<Command, { type: 'claimDirective' }>): void {
  const sc = sim.world.scalars;
  if (!isInts(c.index) || c.index < 0 || c.index >= DIRECTIVE_COUNT) reject('invalid');
  const bit = 1 << c.index;
  if ((sc[S.directiveClaimed]! & bit) !== 0) reject('claimed');
  if ((sc[S.directiveDone]! & bit) === 0 && !directiveMet(sim.world, c.index)) reject('not-ready');
  const reward = DIRECTIVES[c.index]!.reward;
  sc[S.directiveDone] = sc[S.directiveDone]! | bit;
  sc[S.directiveClaimed] = sc[S.directiveClaimed]! | bit;
  sc[S.treasury]! += reward;
  sim.events.push({ type: 'directiveClaimed', tick: sc[S.tick]!, index: c.index, reward });
}

function firmwareCommand(sim: Sim, c: Extract<Command, { type: 'research' | 'toggleEdict' | 'setDepotModule' | 'debugRp' }>): void {
  const w = sim.world;
  let why: string | undefined;
  switch (c.type) {
    case 'research': why = researchNode(w, c.node); break;
    case 'toggleEdict': why = toggleEdictCard(w, c.edict); break;
    case 'setDepotModule': why = setModule(w, c.slot, c.index, c.module); break;
    case 'debugRp': why = sim.debug ? grantRp(w, c.amount) : 'debug-only'; break;
  }
  if (why) reject(why);
}

function debugSeason(sim: Sim, c: Extract<Command, { type: 'debugSeason' }>): void {
  if (!sim.debug) reject('debug-only');
  if (!isInts(c.day) || c.day < 0 || c.day > 100000) reject('invalid');
  const s = sim.world.scalars;
  s[S.day] = c.day;
  s[S.season] = yearPosition(c.day, s[S.dayFrac]!);
}

function debugHazard(sim: Sim, c: Extract<Command, { type: 'debugHazard' }>): void {
  if (!sim.debug) reject('debug-only');
  if (!isInts(c.kind) || c.kind < HAZ.STORM || c.kind > HAZ.QUAKE_SWARM || (c.lead !== undefined && (!isInts(c.lead) || c.lead < 1 || c.lead > 100000))) reject('invalid');
  if (sim.world.disaster[D.MODE] === DMODE.OFF) reject('disasters-off');
  planHazard(sim, { kind: c.kind, lead: c.lead ?? LEAD_MIN });
}

/** Validate and execute one command. Never throws: failures become `rejected` events with state unchanged. */
export function execute(sim: Sim, cmd: Command): boolean {
  const tick = sim.world.scalars[S.tick]!;
  try {
    if (!cmd || !Number.isInteger(cmd.id) || cmd.id <= 0) reject('invalid');
    let journal = 0;
    switch (cmd.type) {
      case 'placeRoad': journal = placeRoad(sim, cmd); break;
      case 'zone': journal = zone(sim, cmd); break;
      case 'placeLine': journal = placeLine(sim, cmd); break;
      case 'bulldoze': bulldoze(sim, cmd); break;
      case 'placeBuilding': journal = placeBuilding(sim, cmd); break;
      case 'terraform': terraform(sim, cmd); break;
      case 'debugGrow': debugGrow(sim, cmd); break;
      case 'debugLevel': debugLevel(sim, cmd); break;
      case 'debugTier': debugTier(sim, cmd); break;
      case 'setTax': setTax(sim, cmd); break;
      case 'takeLoan': case 'repayLoan': loan(sim, cmd); break;
      case 'setDisasters': { const why = setDisasterMode(sim.world, cmd.mode); if (why) reject(why); break; }
      case 'triggerDisaster': { const why = triggerDisaster(sim, cmd.kind, cmd.x, cmd.y); if (why) reject(why); break; }
      case 'undo': undo(sim, cmd); break;
      case 'claimDirective': claimDirective(sim, cmd); break;
      case 'research': case 'toggleEdict': case 'setDepotModule': case 'debugRp': firmwareCommand(sim, cmd); break;
      case 'setDepotLivery': { const why = setLivery(sim.world, cmd.slot, cmd.livery); if (why) reject(why); break; }
      case 'rebuildAll': { const why = rebuildAll(sim); if (why) reject(why); break; }
      case 'debugSeason': debugSeason(sim, cmd); break;
      case 'debugHazard': debugHazard(sim, cmd); break;
      case 'councilRespond': case 'holdFestival': case 'debugCouncil': {
        const why = cmd.type === 'councilRespond' ? respond(sim, cmd.slot, cmd.accept)
          : cmd.type === 'holdFestival' ? holdFestival(sim, cmd.festival) : debugPost(sim, cmd.kind, cmd.accept === true);
        if (why) reject(why);
        break;
      }
      case 'finishScenario': { const why = finishScenario(sim); if (why) reject(why); break; }
      case 'debugScenario': { const why = debugScenario(sim, cmd.value); if (why) reject(why); break; }
      case 'paintDistrict': case 'eraseDistrict': journal = districtRect(sim, cmd); break;
      case 'renameDistrict': case 'setDistrictEdict': case 'setDistrictStyle': districtCommand(sim, cmd); break;
      default: reject('unknown-command');
    }
    sim.events.push(journal ? { type: 'accepted', cmd: cmd.id, tick, journal } : { type: 'accepted', cmd: cmd.id, tick });
    return true;
  } catch (e) {
    const reason = e instanceof Reject ? e.message : 'internal';
    sim.events.push({ type: 'rejected', cmd: (cmd as Command | undefined)?.id ?? 0, tick, reason });
    return false;
  }
}
