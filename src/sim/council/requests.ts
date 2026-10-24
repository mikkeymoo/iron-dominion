import { ARCH, BFLAG, archetype, isRci } from '../catalog.ts';
import { zoneOfArch } from '../economy/totals.ts';
import { estimateSite } from '../estimate.ts';
import { roll } from '../firmware.ts';
import { BMAX, C, F, MAP, MAX_REQUESTS, ROAD, S, ZONE, type World } from '../layers.ts';
import type { IssueOverlay } from '../protocol.ts';
import type { Sim } from '../world.ts';
import { noteOutcome, nudgeApproval } from './approval.ts';
import {
  BUILD_JOBS, GROUP, JOBS_ASKED, DEADLINE_MIN, DEADLINE_SPAN, DECLINE_PENALTY, JAM_CLEAR, JAM_HEAT, MONTH_TICKS, PARK_RADIUS, POLLUTION_RADIUS, POWER_TARGET, REQ, REQ_STATE,
} from './tables.ts';

// Council requests: a citizen group asks for one thing, the request carries a deadline, a reward and a penalty, and the sim checks it
// from the world once a second. A request is only posted when the city's own state makes it achievable (a free site for the park, a
// polluter near the homes, a jam on a road that can be widened). Generation draws from firmware's roll(seed, tick, key), a pure hash,
// so it never touches the weather stream and a snapshot resumes the same offers.

export const KIND = { PARK: 0, POWER: 1, POLLUTION: 2, COMMERCIAL_JOBS: 3, INDUSTRIAL_JOBS: 4, BUILD_JOBS: 5, TRAFFIC: 6 } as const;
export const KIND_COUNT = 7;

interface KindDef { id: number; group: number; cash: number; approval: number; rp: number; penalty: number; overlay: IssueOverlay }
/** Reward and penalty by kind; the cash is multiplied by (1 + population tier) when the request is posted. */
const KINDS: readonly KindDef[] = [
  { id: KIND.PARK, group: GROUP.RESIDENTS, cash: 500, approval: 5, rp: 2, penalty: 4, overlay: 'parks' },
  { id: KIND.POWER, group: GROUP.ENGINEERS, cash: 900, approval: 7, rp: 4, penalty: 6, overlay: 'power' },
  { id: KIND.POLLUTION, group: GROUP.RESIDENTS, cash: 700, approval: 6, rp: 3, penalty: 5, overlay: 'pollution' },
  { id: KIND.COMMERCIAL_JOBS, group: GROUP.MERCHANTS, cash: 800, approval: 5, rp: 2, penalty: 4, overlay: 'none' },
  { id: KIND.INDUSTRIAL_JOBS, group: GROUP.INDUSTRIALISTS, cash: 800, approval: 5, rp: 2, penalty: 4, overlay: 'none' },
  { id: KIND.BUILD_JOBS, group: GROUP.INDUSTRIALISTS, cash: 600, approval: 4, rp: 2, penalty: 3, overlay: 'none' },
  { id: KIND.TRAFFIC, group: GROUP.ENGINEERS, cash: 900, approval: 7, rp: 4, penalty: 6, overlay: 'traffic' },
];
export const kindDef = (kind: number): KindDef => KINDS[kind]!;

/** A request as the layer holds it. */
export interface Request {
  slot: number;
  id: number;
  kind: number;
  group: number;
  state: number;
  posted: number;
  deadline: number;
  x: number;
  y: number;
  target: number;
  base: number;
  cash: number;
  approval: number;
  rp: number;
  penalty: number;
}

const at = (slot: number): number => C.REQ0 + slot * C.REQ_STRIDE;

export function readRequest(w: World, slot: number): Request | null {
  const c = w.council, o = at(slot);
  if (slot < 0 || slot >= MAX_REQUESTS || c[o + REQ.STATE] === REQ_STATE.FREE) return null;
  return {
    slot, id: c[o + REQ.ID]!, kind: c[o + REQ.KIND]!, group: c[o + REQ.GROUP]!, state: c[o + REQ.STATE]!, posted: c[o + REQ.POSTED]!, deadline: c[o + REQ.DEADLINE]!,
    x: c[o + REQ.X]!, y: c[o + REQ.Y]!, target: c[o + REQ.TARGET]!, base: c[o + REQ.BASE]!, cash: c[o + REQ.CASH]!, approval: c[o + REQ.APPROVAL]!, rp: c[o + REQ.RP]!, penalty: c[o + REQ.PENALTY]!,
  };
}

/** Pending and accepted requests, in slot order. */
export function openRequests(w: World): Request[] {
  const out: Request[] = [];
  for (let s = 0; s < MAX_REQUESTS; s++) { const r = readRequest(w, s); if (r) out.push(r); }
  return out;
}

const clearSlot = (w: World, slot: number): void => { w.council.fill(0, at(slot), at(slot) + C.REQ_STRIDE); };

// ---- Reading the city ----
const finished = (w: World, s: number): boolean => (w.bFlags[s]! & (BFLAG.CONSTRUCTING | BFLAG.RUBBLE | BFLAG.ABANDONED)) === 0;
const centreOf = (w: World, s: number): { x: number; y: number } => ({ x: w.bX[s]! + (w.bW[s]! >> 1), y: w.bY[s]! + (w.bH[s]! >> 1) });
const cheb = (ax: number, ay: number, bx: number, by: number): number => Math.max(Math.abs(ax - bx), Math.abs(ay - by));

/** Finished RCI buildings and how many of them are dark. */
function consumers(w: World): { total: number; unpowered: number } {
  let total = 0, unpowered = 0;
  for (let s = 0; s < BMAX; s++) {
    if (!isRci(w.bArch[s]!) || !finished(w, s)) continue;
    total++;
    if ((w.bFlags[s]! & BFLAG.UNPOWERED) !== 0) unpowered++;
  }
  return { total, unpowered };
}

/** Whole-percent share of finished RCI buildings with power; 100 when the city has none or does not model power yet. */
export function powerCoverage(w: World): number {
  const c = consumers(w);
  return c.total === 0 || (w.scalars[S.grid]! & 1) === 0 ? 100 : Math.floor(((c.total - c.unpowered) * 100) / c.total);
}

/** Mean pollution (0..255) over the tiles within `r` of (x, y). */
export function pollutionAround(w: World, x: number, y: number, r: number): number {
  let sum = 0, n = 0;
  for (let yy = Math.max(0, y - r); yy <= Math.min(MAP - 1, y + r); yy++) for (let xx = Math.max(0, x - r); xx <= Math.min(MAP - 1, x + r); xx++) { sum += w.pollution[yy * MAP + xx]!; n++; }
  return n === 0 ? 0 : Math.floor(sum / n);
}

/** Highest traffic heat (0..255) within `r` of (x, y). */
export function heatAround(w: World, x: number, y: number, r: number): number {
  let m = 0;
  for (let yy = Math.max(0, y - r); yy <= Math.min(MAP - 1, y + r); yy++) for (let xx = Math.max(0, x - r); xx <= Math.min(MAP - 1, x + r); xx++) m = Math.max(m, w.traffic[yy * MAP + xx]!);
  return m;
}

const isPark = (arch: number): boolean => arch === ARCH.PARK_SMALL || arch === ARCH.PARK_LARGE;

function parkNear(w: World, x: number, y: number): boolean {
  for (let s = 0; s < BMAX; s++) {
    if (!isPark(w.bArch[s]!) || !finished(w, s)) continue;
    const c = centreOf(w, s);
    if (cheb(c.x, c.y, x, y) <= PARK_RADIUS) return true;
  }
  return false;
}

/** Build and level-up jobs the robots are running now. */
function activeJobs(w: World): number {
  let n = 0;
  for (let s = 0; s < BMAX; s++) if (w.bArch[s] !== 0 && (w.jKind[s] === 1 || w.jKind[s] === 2) && w.jGen[s] === w.bGen[s]) n++;
  return n;
}

function depots(w: World): number {
  let n = 0;
  for (let s = 0; s < BMAX; s++) if (w.bArch[s] === ARCH.DEPOT) n++;
  return n;
}

function freeZoned(w: World, zone: number): number {
  let n = 0;
  for (let i = 0; i < MAP * MAP; i++) if ((w.zone[i]! & 3) === zone && w.bId[i] === 0) n++;
  return n;
}

/** The middle of the district around one finished home (picked by `pick`): mean centre of the finished homes within 16 tiles of it. */
function homesCentroid(w: World, pick: number): { x: number; y: number } | null {
  const homes: number[] = [];
  for (let s = 0; s < BMAX; s++) if (zoneOfArch(w.bArch[s]!) === ZONE.R && finished(w, s)) homes.push(s);
  if (homes.length === 0) return null;
  const seed = homes[pick % homes.length]!, c0 = centreOf(w, seed);
  let sx = 0, sy = 0, n = 0;
  for (const s of homes) { const c = centreOf(w, s); if (cheb(c.x, c.y, c0.x, c0.y) <= 16) { sx += c.x; sy += c.y; n++; } }
  return { x: Math.floor(sx / n), y: Math.floor(sy / n) };
}

/** A 2x2 park fits on free land within `r` of (x, y) and the treasury covers it. */
function parkSiteNear(w: World, x: number, y: number, r: number): boolean {
  const park = archetype(ARCH.PARK_SMALL)!;
  for (let yy = Math.max(0, y - r); yy <= Math.min(MAP - 2, y + r); yy++) for (let xx = Math.max(0, x - r); xx <= Math.min(MAP - 2, x + r); xx++) {
    if (!estimateSite(w, park, xx, yy, 0, park.cost, w.scalars[S.treasury]).reason) return true;
  }
  return false;
}

// ---- Wording ----
const THIRDS = ['north', '', 'south'] as const;
const SIDES = ['west', '', 'east'] as const;
/** "the north-east", "the centre": where a tile is on the map, for request text. */
export function areaWord(x: number, y: number): string {
  const row = Math.min(2, Math.floor((y * 3) / MAP)), col = Math.min(2, Math.floor((x * 3) / MAP));
  const parts = [THIRDS[row], SIDES[col]].filter((p) => p !== '');
  return parts.length === 0 ? 'the centre' : `the ${parts.join('-')}`;
}

export function requestText(r: Pick<Request, 'kind' | 'x' | 'y' | 'target' | 'base'>): string {
  const where = `${areaWord(r.x, r.y)} (${r.x}, ${r.y})`;
  switch (r.kind) {
    case KIND.PARK: return `Build a park within ${PARK_RADIUS} tiles of the homes in ${where}.`;
    case KIND.POWER: return `Reach ${r.target}% power coverage.`;
    case KIND.POLLUTION: return `Cut pollution near the homes in ${where} below ${r.target}.`;
    case KIND.COMMERCIAL_JOBS: return `Add ${r.target - r.base} commercial jobs.`;
    case KIND.INDUSTRIAL_JOBS: return `Add ${r.target - r.base} industrial jobs.`;
    case KIND.BUILD_JOBS: return `Finish ${r.target - r.base} construction jobs.`;
    case KIND.TRAFFIC: return `Clear the traffic jam on the road at ${where}.`;
    default: return 'The council has a request.';
  }
}

export interface Progress { have: number; need: number; done: boolean; text: string }

/** How far the city is from a request's goal right now. */
export function progressOf(w: World, r: Request): Progress {
  switch (r.kind) {
    case KIND.PARK: { const done = parkNear(w, r.x, r.y); return { have: done ? 1 : 0, need: 1, done, text: done ? 'Park built' : 'No park yet' }; }
    case KIND.POWER: { const have = powerCoverage(w); return { have, need: r.target, done: have >= r.target, text: `Power coverage ${have}% of ${r.target}%` }; }
    case KIND.POLLUTION: {
      const have = pollutionAround(w, r.x, r.y, POLLUTION_RADIUS);
      return { have, need: r.target, done: have < r.target, text: `Pollution ${have}, goal under ${r.target}` };
    }
    case KIND.COMMERCIAL_JOBS: case KIND.INDUSTRIAL_JOBS: {
      const have = Math.max(0, w.scalars[r.kind === KIND.COMMERCIAL_JOBS ? S.jobsC : S.jobsI]! - r.base), need = r.target - r.base;
      return { have: Math.min(have, need), need, done: have >= need, text: `${Math.min(have, need)} of ${need} jobs added` };
    }
    case KIND.BUILD_JOBS: {
      const have = Math.max(0, w.council[C.BUILT]! - r.base), need = r.target - r.base;
      return { have: Math.min(have, need), need, done: have >= need, text: `${Math.min(have, need)} of ${need} jobs finished` };
    }
    case KIND.TRAFFIC: {
      const have = heatAround(w, r.x, r.y, 2), roadHere = (w.road[r.y * MAP + r.x]! & ROAD.CLASS_MASK) !== 0;
      return { have, need: r.target, done: roadHere && have < r.target, text: `Traffic heat ${have}, goal under ${r.target}` };
    }
    default: return { have: 0, need: 1, done: false, text: '' };
  }
}

/** The overlay that shows a request on the map. */
export const overlayOf = (kind: number): IssueOverlay => KINDS[kind]?.overlay ?? 'none';

// ---- Generation ----
interface Spec { kind: number; x: number; y: number; target: number; base: number }

const city = (w: World): { x: number; y: number } => {
  let n = 0, sx = 0, sy = 0;
  for (let s = 0; s < BMAX; s++) if (isRci(w.bArch[s]!) && finished(w, s)) { const c = centreOf(w, s); sx += c.x; sy += c.y; n++; }
  if (n > 0) return { x: Math.floor(sx / n), y: Math.floor(sy / n) };
  const depot = w.bArch.indexOf(ARCH.DEPOT);
  return depot >= 0 ? centreOf(w, depot) : { x: MAP >> 1, y: MAP >> 1 };
};

/** What this kind would ask of the city now, or null when it cannot be asked fairly (already met, or no way to meet it). `force` skips the fairness checks. */
function candidate(w: World, kind: number, pick: number, force: boolean): Spec | null {
  const sc = w.scalars, treasury = sc[S.treasury]!;
  switch (kind) {
    case KIND.PARK: {
      const c = homesCentroid(w, pick) ?? (force ? city(w) : null);
      if (!c || (!force && (parkNear(w, c.x, c.y) || treasury < 600 || !parkSiteNear(w, c.x, c.y, PARK_RADIUS - 1)))) return null;
      return { kind, x: c.x, y: c.y, target: 1, base: 0 };
    }
    case KIND.POWER: {
      const have = powerCoverage(w), t = consumers(w).total;
      if (!force && ((sc[S.grid]! & 1) === 0 || t < 6 || have < 25 || have > 90 || treasury < 1500)) return null;
      const target = have < POWER_TARGET - 5 ? POWER_TARGET : Math.min(95, 5 * Math.ceil((have + 8) / 5));
      return { kind, x: city(w).x, y: city(w).y, target, base: have };
    }
    case KIND.POLLUTION: {
      const c = homesCentroid(w, pick) ?? (force ? city(w) : null);
      if (!c) return null;
      const have = pollutionAround(w, c.x, c.y, POLLUTION_RADIUS);
      if (!force) {
        if (have < 40) return null;
        let emitter = false;
        for (let s = 0; s < BMAX && !emitter; s++) {
          const arch = w.bArch[s]!;
          if (arch === 0 || (isRci(arch) ? zoneOfArch(arch) !== ZONE.I : (archetype(arch)?.pollution ?? 0) === 0)) continue;
          const e = centreOf(w, s);
          if (cheb(e.x, e.y, c.x, c.y) <= POLLUTION_RADIUS + 10) emitter = true;
        }
        if (!emitter) return null;
      }
      return { kind, x: c.x, y: c.y, target: Math.max(15, Math.floor((have * 3) / 5)), base: have };
    }
    case KIND.COMMERCIAL_JOBS: case KIND.INDUSTRIAL_JOBS: {
      const zone = kind === KIND.COMMERCIAL_JOBS ? ZONE.C : ZONE.I, demand = sc[kind === KIND.COMMERCIAL_JOBS ? S.demandC : S.demandI]!;
      if (!force && (demand < 0.1 || freeZoned(w, zone) < 10 || depots(w) === 0)) return null;
      const base = sc[zone === ZONE.C ? S.jobsC : S.jobsI]!;
      return { kind, x: city(w).x, y: city(w).y, target: base + JOBS_ASKED, base };
    }
    case KIND.BUILD_JOBS: {
      if (!force && (activeJobs(w) < BUILD_JOBS || depots(w) === 0)) return null;
      const base = w.council[C.BUILT]!;
      return { kind, x: city(w).x, y: city(w).y, target: base + BUILD_JOBS, base };
    }
    case KIND.TRAFFIC: {
      let best = -1, heat = 0;
      for (let i = 0; i < MAP * MAP; i++) {
        const v = w.traffic[i]!, cls = w.road[i]! & ROAD.CLASS_MASK;
        if (v > heat && cls > 0 && cls < 3) { heat = v; best = i; }
      }
      if (best < 0 || (!force && heat < JAM_HEAT)) return force ? { kind, x: city(w).x, y: city(w).y, target: JAM_CLEAR, base: heat } : null;
      return { kind, x: best % MAP, y: (best / MAP) | 0, target: JAM_CLEAR, base: heat };
    }
    default: return null;
  }
}

/** Write a spec into a free slot. Returns the slot, or -1 when both are taken. */
function write(sim: Sim, spec: Spec, accepted: boolean): number {
  const w = sim.world, c = w.council, tick = w.scalars[S.tick]!;
  let slot = -1;
  for (let s = 0; s < MAX_REQUESTS; s++) if (c[at(s) + REQ.STATE] === REQ_STATE.FREE) { slot = s; break; }
  if (slot < 0) return -1;
  const def = kindDef(spec.kind), o = at(slot);
  const months = DEADLINE_MIN + (roll(w.scalars[S.seed]!, tick, 0x77 + c[C.SEQ]!) % DEADLINE_SPAN);
  c[C.SEQ]!++;
  c[o + REQ.STATE] = accepted ? REQ_STATE.ACCEPTED : REQ_STATE.PENDING;
  c[o + REQ.ID] = c[C.SEQ]!;
  c[o + REQ.KIND] = spec.kind; c[o + REQ.GROUP] = def.group;
  c[o + REQ.POSTED] = tick; c[o + REQ.DEADLINE] = tick + months * MONTH_TICKS;
  c[o + REQ.X] = spec.x; c[o + REQ.Y] = spec.y; c[o + REQ.TARGET] = spec.target; c[o + REQ.BASE] = spec.base;
  c[o + REQ.CASH] = def.cash * (1 + w.scalars[S.tier]!); c[o + REQ.APPROVAL] = def.approval; c[o + REQ.RP] = def.rp; c[o + REQ.PENALTY] = def.penalty;
  c[C.LAST_KIND] = spec.kind + 1;
  event(sim, 'posted', slot);
  return slot;
}

function event(sim: Sim, phase: 'posted' | 'accepted' | 'declined' | 'expired' | 'completed' | 'failed', slot: number, r: Request | null = readRequest(sim.world, slot)): void {
  if (!r) return;
  sim.events.push({
    type: 'council', tick: sim.world.scalars[S.tick]!, phase, id: r.id, kind: r.kind, group: r.group, x: r.x, y: r.y,
    cash: r.cash, approval: phase === 'failed' ? -r.penalty : r.approval, rp: r.rp,
  });
}

/**
 * Post the next request, if the city offers a fair one and a slot is free. Starts at a kind picked by the seeded hash and tries the
 * rest in order, skipping the kinds already open and the one posted last. Returns the slot, or -1.
 */
export function postNext(sim: Sim): number {
  const w = sim.world, tick = w.scalars[S.tick]!, seed = w.scalars[S.seed]!;
  const open = new Set(openRequests(w).map((r) => r.kind));
  if (open.size >= MAX_REQUESTS) return -1;
  const start = roll(seed, tick, 0x51) % KIND_COUNT, pick = roll(seed, tick, 0x52);
  // The kind posted last waits its turn: it is only offered again when nothing else is fair.
  for (const skipLast of [true, false]) {
    for (let i = 0; i < KIND_COUNT; i++) {
      const kind = (start + i) % KIND_COUNT;
      if (open.has(kind) || (skipLast && w.council[C.LAST_KIND] === kind + 1)) continue;
      const spec = candidate(w, kind, pick, false);
      if (spec) return write(sim, spec, false);
    }
  }
  return -1;
}

/** Debug-only: post a request of `kind` now, whatever the city looks like. */
export function debugPost(sim: Sim, kind: number, accept: boolean): string | undefined {
  if (!sim.debug) return 'debug-only';
  if (!Number.isInteger(kind) || kind < 0 || kind >= KIND_COUNT) return 'invalid';
  const spec = candidate(sim.world, kind, roll(sim.world.scalars[S.seed]!, sim.world.scalars[S.tick]!, 0x52), true);
  if (!spec) return 'noop';
  return write(sim, spec, accept) < 0 ? 'full' : undefined;
}

// ---- Responses and outcomes ----
export function respond(sim: Sim, slot: number, accept: boolean, id?: number): string | undefined {
  const w = sim.world;
  if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_REQUESTS || typeof accept !== 'boolean') return 'invalid';
  if (id !== undefined && !Number.isInteger(id)) return 'invalid';
  const r = readRequest(w, slot);
  if (!r || r.state !== REQ_STATE.PENDING || (id !== undefined && r.id !== id)) return 'no-request';
  if (accept) { w.council[at(slot) + REQ.STATE] = REQ_STATE.ACCEPTED; event(sim, 'accepted', slot, r); return undefined; }
  event(sim, 'declined', slot, r);
  clearSlot(w, slot);
  w.council[C.DECLINED]!++;
  nudgeApproval(w, -DECLINE_PENALTY);
  return undefined;
}

function complete(sim: Sim, r: Request): void {
  const w = sim.world;
  event(sim, 'completed', r.slot, r);
  clearSlot(w, r.slot);
  w.scalars[S.treasury]! += r.cash;
  w.firmware[F.RP]! += r.rp;
  w.firmware[F.EARNED]! += r.rp;
  w.council[C.COMPLETED]!++;
  noteOutcome(w, r.approval);
}

function fail(sim: Sim, r: Request): void {
  const w = sim.world;
  event(sim, 'failed', r.slot, r);
  clearSlot(w, r.slot);
  w.council[C.FAILED]!++;
  noteOutcome(w, -r.penalty);
}

/** Pay the requests the city has met and retire the ones past their deadline. An unanswered request that lapses counts as declined. */
export function checkRequests(sim: Sim): void {
  const w = sim.world, tick = w.scalars[S.tick]!;
  for (let s = 0; s < MAX_REQUESTS; s++) {
    const r = readRequest(w, s);
    if (!r) continue;
    if (r.state === REQ_STATE.ACCEPTED && progressOf(w, r).done) complete(sim, r);
    else if (tick >= r.deadline) {
      if (r.state === REQ_STATE.ACCEPTED) fail(sim, r);
      else { event(sim, 'expired', s, r); clearSlot(w, s); w.council[C.DECLINED]!++; nudgeApproval(w, -DECLINE_PENALTY); }
    }
  }
}
