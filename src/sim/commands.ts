import { archetype, BFLAG, type Archetype, BRIDGE_EXTRA, BULLDOZE_COST, ROAD_COST, ZONE_COST } from './catalog.ts';
import { MAP, ROAD, S, SLOPE_LIMIT, TERRAIN, UCELLS, UMAX, isWaterTerrain, type World } from './layers.ts';
import { inBounds, tileIdx } from './tiles.ts';
import { markDirty, type Sim } from './world.ts';

export type CommandBody =
  | { type: 'placeRoad'; ax: number; ay: number; bx: number; by: number; cls: number }
  | { type: 'zone'; x0: number; y0: number; x1: number; y1: number; zone: number; density: number }
  | { type: 'bulldoze'; x0: number; y0: number; x1: number; y1: number }
  | { type: 'placeBuilding'; arch: number; x: number; y: number; rot: number }
  | { type: 'debugGrow'; x: number; y: number; archetype: number; progress: number }
  | { type: 'debugLevel'; x0: number; y0: number; x1: number; y1: number; margin: number }
  | { type: 'setTax'; rate: number }
  | { type: 'undo'; target: number };

/** For undo, `target` is the sim-assigned journal id from the `accepted` event, not a command id. `tick` is the earliest tick the command may run; `id` is unique and positive. */
export type Command = { id: number; tick: number } & CommandBody;

const UNDO = { NONE: 0, ROAD: 1, ZONE: 2, BUILDING: 3 } as const;
const MAX_ROAD_CELLS = 600;
const MAX_ZONE_TILES = UCELLS;
const NEI = [[0, -1, ROAD.N], [1, 0, ROAD.E], [0, 1, ROAD.S], [-1, 0, ROAD.W]] as const;

class Reject extends Error {}
const reject = (reason: string): never => { throw new Reject(reason); };

const isInts = (...v: number[]): boolean => v.every((n) => Number.isInteger(n));

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

function roadPath(c: { ax: number; ay: number; bx: number; by: number }): number[] {
  const cells: number[] = [];
  const sx = Math.sign(c.bx - c.ax), sy = Math.sign(c.by - c.ay);
  let x = c.ax;
  cells.push(tileIdx(x, c.ay));
  while (x !== c.bx) { x += sx; cells.push(tileIdx(x, c.ay)); }
  let y = c.ay;
  while (y !== c.by) { y += sy; cells.push(tileIdx(x, y)); }
  return cells;
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

function spend(world: World, cost: number): void {
  if (cost > world.scalars[S.treasury]!) reject('funds');
}

function placeRoad(sim: Sim, c: Extract<Command, { type: 'placeRoad' }>): number {
  const w = sim.world;
  if (!isInts(c.ax, c.ay, c.bx, c.by, c.cls)) reject('invalid');
  if (!inBounds(c.ax, c.ay) || !inBounds(c.bx, c.by)) reject('bounds');
  if (c.cls < 1 || c.cls > 3) reject('invalid');
  const path = roadPath(c);
  if (path.length > MAX_ROAD_CELLS) reject('too-large');
  let cost = 0;
  for (const i of path) {
    if (w.bId[i]) reject('blocked');
    if ((w.road[i]! & ROAD.CLASS_MASK) < c.cls) cost += ROAD_COST[c.cls]! + (isWaterTerrain(w.terrain[i]!) ? BRIDGE_EXTRA : 0);
  }
  if (cost === 0) reject('noop');
  spend(w, cost);

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

function rect(c: { x0: number; y0: number; x1: number; y1: number }): [number, number, number, number] {
  if (!isInts(c.x0, c.y0, c.x1, c.y1)) reject('invalid');
  if (!inBounds(c.x0, c.y0) || !inBounds(c.x1, c.y1)) reject('bounds');
  return [Math.min(c.x0, c.x1), Math.min(c.y0, c.y1), Math.max(c.x0, c.x1), Math.max(c.y0, c.y1)];
}

const ZONABLE = (t: number): boolean => t === TERRAIN.SAND || t === TERRAIN.GRASS || t === TERRAIN.FOREST;

function zone(sim: Sim, c: Extract<Command, { type: 'zone' }>): number {
  const w = sim.world;
  if (!isInts(c.zone, c.density)) reject('invalid');
  if (c.zone < 1 || c.zone > 3 || c.density < 0 || c.density > 2) reject('invalid');
  const [x0, y0, x1, y1] = rect(c);
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_ZONE_TILES) reject('too-large');
  const value = c.zone | (c.density << 2);
  const changed: number[] = [];
  let valid = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = tileIdx(x, y);
    if (!ZONABLE(w.terrain[i]!) || w.road[i] || w.bId[i]) continue;
    valid++;
    if (w.zone[i] !== value) changed.push(i);
  }
  if (valid === 0) reject('terrain');
  if (changed.length === 0) reject('noop');
  const cost = changed.length * ZONE_COST;
  spend(w, cost);
  const cap = capture(w, changed);
  for (const i of changed) { w.zone[i] = value; markDirty(sim, 'geometry', i % MAP, (i / MAP) | 0); }
  w.scalars[S.treasury]! -= cost;
  return journalCommit(sim, cap, UNDO.ZONE, cost, 0);
}

function clearBuilding(sim: Sim, slot: number): void {
  const w = sim.world;
  const x = w.bX[slot]!, y = w.bY[slot]!, bw = w.bW[slot]!, bh = w.bH[slot]!;
  for (let yy = y; yy < y + bh; yy++) for (let xx = x; xx < x + bw; xx++) {
    w.bId[tileIdx(xx, yy)] = 0;
    markDirty(sim, 'geometry', xx, yy);
  }
  w.bArch[slot] = 0; w.bX[slot] = 0; w.bY[slot] = 0; w.bW[slot] = 0; w.bH[slot] = 0;
  w.bRot[slot] = 0; w.bLevel[slot] = 0; w.bProg[slot] = 0; w.bFlags[slot] = 0;
  w.bGen[slot] = (w.bGen[slot]! + 1) & 0xffff;
  for (let u = 0; u < UMAX; u++) if (w.uKind[u] === UNDO.BUILDING && w.uArg[u] === slot) { w.uKind[u] = UNDO.NONE; w.uCmd[u] = 0; }
  sim.dirty.buildings.add(slot);
}

function bulldoze(sim: Sim, c: Extract<Command, { type: 'bulldoze' }>): void {
  const w = sim.world;
  const [x0, y0, x1, y1] = rect(c);
  const slots = new Set<number>();
  let cost = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = tileIdx(x, y);
    if (w.bId[i]) { if (!slots.has(w.bId[i]! - 1)) cost += BULLDOZE_COST; slots.add(w.bId[i]! - 1); }
    else if (w.road[i] || w.zone[i]) cost += BULLDOZE_COST;
  }
  if (cost === 0) reject('noop');
  spend(w, cost);
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
  const bw = rot & 1 ? a.h : a.w, bh = rot & 1 ? a.w : a.h;
  if (!inBounds(x, y) || !inBounds(x + bw - 1, y + bh - 1)) reject('bounds');
  for (let yy = y; yy < y + bh; yy++) for (let xx = x; xx < x + bw; xx++) {
    const i = tileIdx(xx, yy);
    if (isWaterTerrain(w.terrain[i]!)) reject('terrain');
    if (w.road[i] || w.bId[i]) reject('blocked');
  }
  if (o.cost > 0) spend(w, o.cost);
  let slot = -1;
  for (let s = 0; s < w.bArch.length; s++) if (w.bArch[s] === 0) { slot = s; break; }
  if (slot < 0) reject('full');
  const cells: number[] = [];
  for (let yy = y; yy < y + bh; yy++) for (let xx = x; xx < x + bw; xx++) cells.push(tileIdx(xx, yy));
  const cap = o.journal ? capture(w, cells) : undefined;
  w.bArch[slot] = a.id; w.bX[slot] = x; w.bY[slot] = y; w.bW[slot] = bw; w.bH[slot] = bh;
  w.bRot[slot] = rot; w.bLevel[slot] = o.level; w.bProg[slot] = o.prog; w.bFlags[slot] = o.flags;
  for (const i of cells) { w.bId[i] = slot + 1; w.zone[i] = 0; markDirty(sim, 'geometry', i % MAP, (i / MAP) | 0); }
  sim.dirty.buildings.add(slot);
  w.scalars[S.treasury]! -= o.cost;
  return cap ? journalCommit(sim, cap, UNDO.BUILDING, o.cost, slot) : 0;
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
  const [x0, y0, x1, y1] = rect(c);
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
  // Heights moved, so road slope flags and building ground heights in and around the area are stale.
  const ex0 = Math.max(0, x0 - m - 1), ey0 = Math.max(0, y0 - m - 1), ex1 = Math.min(MAP - 1, x1 + m + 1), ey1 = Math.min(MAP - 1, y1 + m + 1);
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
  if (!isInts(c.rate) || c.rate < 0 || c.rate > 30) reject('bounds');
  sim.world.scalars[S.tax] = c.rate;
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
      case 'debugGrow': debugGrow(sim, cmd); break;
      case 'debugLevel': debugLevel(sim, cmd); break;
      case 'setTax': setTax(sim, cmd); break;
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
