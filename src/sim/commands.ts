import { archetype, BFLAG, type Archetype } from './catalog.ts';
import { repayLoan, takeLoan } from './economy/budget.ts';
import { TAX_SCALAR } from './economy/demand.ts';
import { TAX_MAX } from './economy/tables.ts';
import { estimate, estimateSite, footprintOf, isInts, rectOf } from './estimate.ts';
import { MAP, ROAD, S, SLOPE_LIMIT, TERRAIN, UCELLS, UMAX, isWaterTerrain, type World } from './layers.ts';
import { inBounds, tileIdx } from './tiles.ts';
import { markDirty, type Sim } from './world.ts';

export type CommandBody =
  | { type: 'placeRoad'; ax: number; ay: number; bx: number; by: number; cls: number }
  | { type: 'zone'; x0: number; y0: number; x1: number; y1: number; zone: number; density: number }
  | { type: 'bulldoze'; x0: number; y0: number; x1: number; y1: number }
  | { type: 'placeBuilding'; arch: number; x: number; y: number; rot: number }
  /** (x0, y0) is where the drag began: `level` flattens to that tile's height. Not undoable (the journal holds roads and zones only). */
  | { type: 'terraform'; mode: 'raise' | 'lower' | 'level'; x0: number; y0: number; x1: number; y1: number }
  | { type: 'debugGrow'; x: number; y: number; archetype: number; progress: number }
  | { type: 'debugLevel'; x0: number; y0: number; x1: number; y1: number; margin: number }
  /** Whole percent 0..TAX_MAX for one zone (1 R, 2 C, 3 I), or for all three when `zone` is omitted. */
  | { type: 'setTax'; rate: number; zone?: number }
  /** Borrow LOAN_TIERS[tier]; at most MAX_LOANS at once. */
  | { type: 'takeLoan'; tier: number }
  /** Repay the whole principal of the loan in `slot` from the treasury. */
  | { type: 'repayLoan'; slot: number }
  | { type: 'undo'; target: number };

/** For undo, `target` is the sim-assigned journal id from the `accepted` event, not a command id. `tick` is the earliest tick the command may run; `id` is unique and positive. */
export type Command = { id: number; tick: number } & CommandBody;

const UNDO = { NONE: 0, ROAD: 1, ZONE: 2, BUILDING: 3 } as const;
const NEI = [[0, -1, ROAD.N], [1, 0, ROAD.E], [0, 1, ROAD.S], [-1, 0, ROAD.W]] as const;

class Reject extends Error {}
const reject = (reason: string): never => { throw new Reject(reason); };

function fixRoad(world: World, x: number, y: number): void {
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
  world.road[i] = (r & ROAD.CLASS_MASK) | (r & ROAD.BRIDGE) | conn | slope;
}

interface Capture {
  cells: number[];
  road: number[];
  zone: number[];
}

/** Previous road/zone values of the cells a command is about to change. */
function capture(w: World, cells: Iterable<number>): Capture {
  const uniq = [...new Set(cells)];
  return { cells: uniq, road: uniq.map((i) => w.road[i]!), zone: uniq.map((i) => w.zone[i]!) };
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
  cap.cells.forEach((idx, n) => {
    w.jIdx[base + n] = idx;
    w.jPrevRoad[base + n] = cap.road[n]!;
    w.jPostRoad[base + n] = w.road[idx]!;
    w.jPrevZone[base + n] = cap.zone[n]!;
    w.jPostZone[base + n] = w.zone[idx]!;
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

function zone(sim: Sim, c: Extract<Command, { type: 'zone' }>): number {
  const w = sim.world;
  const { validTiles: changed, cost } = checked(sim, c);
  const value = c.zone | (c.density << 2);
  const cap = capture(w, changed);
  for (const i of changed) { w.zone[i] = value; markDirty(sim, 'geometry', i % MAP, (i / MAP) | 0); }
  w.scalars[S.treasury]! -= cost;
  return journalCommit(sim, cap, UNDO.ZONE, cost, 0);
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
  w.bStock[slot] = 0; w.bAux[slot] = 0;
  w.jKind[slot] = 0; w.jNeed[slot] = 0; w.jHave[slot] = 0; w.jInbound[slot] = 0; w.jProg[slot] = 0; w.jAccess[slot] = 0;
  w.bGen[slot] = (w.bGen[slot]! + 1) & 0xffff;
  for (let u = 0; u < UMAX; u++) if (w.uKind[u] === UNDO.BUILDING && w.uArg[u] === slot) { w.uKind[u] = UNDO.NONE; w.uCmd[u] = 0; }
  sim.dirty.buildings.add(slot);
}

function bulldoze(sim: Sim, c: Extract<Command, { type: 'bulldoze' }>): void {
  const w = sim.world;
  const { cost, rect } = checked(sim, c);
  const [x0, y0, x1, y1] = rect!;
  const slots = new Set<number>();
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (w.bId[tileIdx(x, y)]) slots.add(w.bId[tileIdx(x, y)]! - 1);
  for (const s of [...slots].sort((a, b) => a - b)) clearBuilding(sim, s);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = tileIdx(x, y);
    if (w.road[i] || w.zone[i]) { w.road[i] = 0; w.zone[i] = 0; markDirty(sim, 'geometry', x, y); }
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
  if (!a.placeable) reject('not-placeable');
  return placeSite(sim, a, c.x, c.y, c.rot, { level: 0, prog: 0, flags: 0, cost: a.cost, journal: true });
}

/** Debug-only: put a (possibly RCI) building on free land at a chosen construction progress, free of charge and not undoable. */
function debugGrow(sim: Sim, c: Extract<Command, { type: 'debugGrow' }>): void {
  if (!sim.debug) reject('debug-only');
  if (!isInts(c.x, c.y, c.archetype) || !Number.isFinite(c.progress) || c.progress < 0 || c.progress > 1) reject('invalid');
  const a = archetype(c.archetype) ?? reject('unknown-archetype');
  const done = c.progress >= 1;
  placeSite(sim, a, c.x, c.y, 0, {
    level: a.level ?? 0, prog: done ? 255 : Math.round(c.progress * 255), flags: done ? 0 : BFLAG.CONSTRUCTING, cost: 0, journal: false,
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

/** Heights moved inside the rect: road slope flags and building ground heights in and around it are stale. Clamps to the map. */
function settleGround(sim: Sim, rx0: number, ry0: number, rx1: number, ry1: number): void {
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
  for (let k = 0; k < n; k++) {
    const i = w.jIdx[base + k]!;
    if (w.road[i] !== w.jPostRoad[base + k] || w.zone[i] !== w.jPostZone[base + k]) reject('consumed');
  }
  if (kind === UNDO.BUILDING) {
    const b = w.uArg[slot]!;
    if (w.bArch[b] === 0 || w.bGen[b] !== w.uGen[slot] || w.bProg[b] !== 0 || w.bLevel[b] !== 0) reject('consumed');
    clearBuilding(sim, b);
  }
  const refund = w.uCost[slot]!;
  for (let k = 0; k < n; k++) {
    const i = w.jIdx[base + k]!;
    w.road[i] = w.jPrevRoad[base + k]!;
    w.zone[i] = w.jPrevZone[base + k]!;
    markDirty(sim, 'geometry', i % MAP, (i / MAP) | 0);
  }
  w.scalars[S.treasury]! += refund;
  w.uCmd[slot] = 0; w.uKind[slot] = UNDO.NONE; w.uCount[slot] = 0; w.uArg[slot] = 0; w.uGen[slot] = 0; w.uCost[slot] = 0;
  return 0;
}

function setTax(sim: Sim, c: Extract<Command, { type: 'setTax' }>): void {
  if (!isInts(c.rate) || (c.zone !== undefined && !isInts(c.zone))) reject('invalid');
  if (c.rate < 0 || c.rate > TAX_MAX) reject('bounds');
  if (c.zone !== undefined && (c.zone < 1 || c.zone > 3)) reject('bounds');
  for (const z of c.zone === undefined ? [1, 2, 3] : [c.zone!]) sim.world.scalars[TAX_SCALAR[z - 1]!] = c.rate;
}

function loan(sim: Sim, c: Extract<Command, { type: 'takeLoan' | 'repayLoan' }>): void {
  const why = c.type === 'takeLoan' ? takeLoan(sim.world, c.tier) : repayLoan(sim.world, c.slot);
  if (why) reject(why);
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
      case 'bulldoze': bulldoze(sim, cmd); break;
      case 'placeBuilding': journal = placeBuilding(sim, cmd); break;
      case 'terraform': terraform(sim, cmd); break;
      case 'debugGrow': debugGrow(sim, cmd); break;
      case 'debugLevel': debugLevel(sim, cmd); break;
      case 'setTax': setTax(sim, cmd); break;
      case 'takeLoan': case 'repayLoan': loan(sim, cmd); break;
      case 'undo': undo(sim, cmd); break;
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
