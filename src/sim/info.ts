import { ARCH, BFLAG, SVC, archetype } from './catalog.ts';
import {
  CRIME_TOLERANCE, LEVELUP_DEMAND, LEVELUP_LV, LEVELUP_SVC_SHIFT, emissionOf, footprintMean, isOperating, occupancyOf, reachAnchors, zoneDemand, zoneOfArch,
} from './economy/index.ts';
import { depotDistances, materialStock } from './issues.ts';
import { needsOf } from './economy/needs.ts';
import { DAMPER_RADIUS, DOME_RADIUS, ROD_RADIUS } from './disasters/prep.ts';
import { archLabel, capitalise } from './labels.ts';
import { BATTERY_CAP } from './utilities/tables.ts';
import { AMAX, BMAX, MAP, PATH_CAP, RMAX, ROAD, S, ZONE, type World } from './layers.ts';
import type { AgentInfo, BuildingInfo, InfoMsg, IssueOverlay, NeedItem, RequestInfo, StockBar, Thought, ThoughtTone } from './protocol.ts';
import {
  AKIND, AST, BUILDER_SPEED, DEPOT_STOCK_CAP, FACTORY_BUFFER, FACTORY_IN, FIREFIGHTER_SPEED, HAULER_SPEED, JOB, JOB_MAX, OUTPUT_CAP, RES, RES_COUNT, RES_NAMES,
  SMELTER_BUFFER, SMELT_IN, TRANSFER_BIT,
} from './robots/constants.ts';
import { NAMED_JOBS, botName, canBeNamed } from './robots/names.ts';
import { chainRunning, isChainArch, reachableStock, stockLayer } from './robots/stock.ts';
import { depotCaps, mods, moduleAt } from './firmware.ts';
import { pathOf } from './robots/move.ts';
import { homeSlot, jobSlot, liveSlot, nearestTileOf, refOf } from './robots/pool.ts';
import { lotAccess, nearestRoad, roadsOf, UNREACHED, type RoadNet } from './roads/index.ts';
import { COVERED_MIN, footprintMax, works } from './services/index.ts';
import { FREE_SPEED, KIND_SPEED, VKIND, VST } from './traffic/constants.ts';
import type { Sim } from './world.ts';

// Read-only answers to "what is this thinking?" for a tapped building, robot or vehicle. Nothing here writes to the world; the
// worker answers a RequestInfo between ticks, so the text is the same for the same state.

const TICKS_PER_SECOND = 10;
const SMOG_NOTICE = 60;
const CRIME_NOTICE = CRIME_TOLERANCE;
const POLLUTER_REACH = 16;
const NEAR_HOMES = 12;

const netOf = (sim: Sim): RoadNet => (sim.roads && sim.roads.world === sim.world ? sim.roads : roadsOf(sim));
const isFinished = (flags: number): boolean => (flags & (BFLAG.CONSTRUCTING | BFLAG.RUBBLE)) === 0;
const centreOf = (w: World, s: number): { x: number; y: number } => ({ x: w.bX[s]! + (w.bW[s]! >> 1), y: w.bY[s]! + (w.bH[s]! >> 1) });
const where = (w: World, s: number): string => { const c = centreOf(w, s); return `the ${archLabel(w.bArch[s]!)} at (${c.x}, ${c.y})`; };

/** Seconds as the card writes them: whole seconds under ten, then the nearest five. */
export function etaText(sec: number): string {
  const s = Math.max(1, sec < 10 ? Math.round(sec) : Math.round(sec / 5) * 5);
  return `ETA ~${s} s`;
}

interface Weighted { w: number; t: Thought }
const thought = (w: number, tone: ThoughtTone, text: string, overlay?: IssueOverlay): Weighted => ({ w: (tone === 'bad' ? 200 : tone === 'warn' ? 100 : 0) + w, t: overlay ? { text, tone, overlay } : { text, tone } });

function polluterNear(w: World, slot: number): { slot: number } | null {
  const c = centreOf(w, slot);
  let best = -1, bestScore = 0;
  for (let s = 0; s < BMAX; s++) {
    if (s === slot) continue;
    const e = emissionOf(w, s);
    if (e === 0) continue;
    const o = centreOf(w, s), d = Math.max(Math.abs(o.x - c.x), Math.abs(o.y - c.y));
    if (d > POLLUTER_REACH) continue;
    const score = e / (1 + d);
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return best < 0 ? null : { slot: best };
}

function homesNear(w: World, slot: number): number {
  const c = centreOf(w, slot);
  let n = 0;
  for (let s = 0; s < BMAX; s++) {
    if (zoneOfArch(w.bArch[s]!) !== ZONE.R || !isFinished(w.bFlags[s]!)) continue;
    const o = centreOf(w, s);
    if (Math.max(Math.abs(o.x - c.x), Math.abs(o.y - c.y)) <= NEAR_HOMES) n++;
  }
  return n;
}

/** Whether the nearest served tile beside a dark footprint belongs to a browned-out network (value 2). */
function brownedOutNear(w: World, layer: Uint8Array, slot: number): boolean {
  const x0 = w.bX[slot]!, y0 = w.bY[slot]!, x1 = x0 + w.bW[slot]! - 1, y1 = y0 + w.bH[slot]! - 1;
  for (let y = Math.max(0, y0 - 1); y <= Math.min(MAP - 1, y1 + 1); y++) {
    for (let x = Math.max(0, x0 - 1); x <= Math.min(MAP - 1, x1 + 1); x++) if (layer[y * MAP + x] === 2) return true;
  }
  return false;
}

function fireStations(w: World): number {
  let n = 0;
  for (let s = 0; s < BMAX; s++) if (w.bArch[s] === ARCH.FIRE_STATION) n++;
  return n;
}

function builderCrew(w: World, slot: number): number {
  const ref = refOf(w, slot);
  let n = 0;
  for (let a = 0; a < RMAX; a++) {
    if (w.aKind[a] === AKIND.BUILDER && w.aTarget[a] === ref && (w.aState[a] === AST.TO_SITE || w.aState[a] === AST.WORK)) n++;
  }
  return n;
}

function jobThoughts(sim: Sim, net: RoadNet, slot: number, out: Weighted[]): void {
  const w = sim.world, flags = w.bFlags[slot]!;
  const live = w.jKind[slot] !== 0 && w.jGen[slot] === w.bGen[slot];
  const pct = Math.round((w.bProg[slot]! * 100) / 255);
  if (!live) {
    out.push(thought(30, 'warn', 'Waiting for a work order: robots need a depot with a road at its door.'));
    return;
  }
  const kind = w.jKind[slot]!, need = w.jNeed[slot]!, have = w.jHave[slot]!;
  if (kind === JOB.DEMOLISH) { out.push(thought(10, 'good', `Being torn down: ${100 - Math.round((w.jProg[slot]! * 100) / JOB_MAX)}% cleared.`)); }
  else out.push(thought(10, 'good', `${kind === JOB.LEVEL ? 'Upgrading' : 'Under construction'}: ${pct}% built, ${have} of ${need} ${w.jRes[slot] === RES.ORE ? 'material' : RES_NAMES[w.jRes[slot]!]!.toLowerCase()} delivered.`));
  const anchors = reachAnchors(sim, net);
  if (anchors === null) { out.push(thought(50, 'bad', 'No depot yet: robots need one to start work.')); return; }
  if (anchors.length === 0) { out.push(thought(50, 'bad', 'The depot has no road at its door, so its robots cannot leave.')); return; }
  if (w.jStuck[slot]! > 0) { out.push(thought(45, 'bad', 'No road from a depot reaches this site.')); return; }
  const wants = kind !== JOB.DEMOLISH && need > have + w.jInbound[slot]!;
  const res = w.jRes[slot]!;
  if (wants && res === RES.ORE && materialStock(w) === 0) out.push(thought(40, 'bad', 'Waiting for material: no depot or factory has any in stock.'));
  else if (wants && res !== RES.ORE && reachableStock(w, res) === 0) {
    out.push(thought(40, 'bad', `Waiting for ${RES_NAMES[res]!.toLowerCase()}: none in stock. Build a ${res === RES.ALLOY ? 'smelter' : 'component factory'}, or a depot will import some.`));
  }
  const radius = mods(w).workRadius;
  if (depotDistances(net, anchors, radius)[w.jAccess[slot]!] === UNREACHED) out.push(thought(30, 'warn', `Slow: no nearby depot (robots work within ${radius} road tiles of one).`));
  if (builderCrew(w, slot) === 0 && (flags & BFLAG.CONSTRUCTING) !== 0) out.push(thought(20, 'warn', 'No builder bot has reached it yet.'));
}

const NEED_THOUGHT = {
  power: 'No power: it cannot level up.', water: 'No water: it cannot level up.',
  shop: "No working shop within 20 tiles - can't level up.",
  health: "No clinic or hospital in reach - can't reach level 3.",
  school: "No school or university in reach - can't reach level 3.",
  goods: "No local goods: an industrial building or smelter must be within 30 tiles - can't level up.",
  components: "No components supply: a factory, or a depot holding components, must be within 40 tiles - can't reach level 3.",
} as const;

function levelThoughts(w: World, slot: number, out: Weighted[]): void {
  const zone = zoneOfArch(w.bArch[slot]!), level = w.bLevel[slot]!;
  if (level >= 3) { out.push(thought(5, 'good', 'Fully grown.')); return; }
  if ((w.bFlags[slot]! & BFLAG.UNWATERED) !== 0) return;
  const unmet = needsOf(w, slot).find((n) => !n.ok);
  if (unmet) {
    out.push(thought(41, 'warn', NEED_THOUGHT[unmet.id], unmet.id === 'health' ? 'health' : unmet.id === 'school' ? 'education' : undefined));
    return;
  }
  const demand = Math.round(zoneDemand(w, zone) * 1024);
  if (demand < LEVELUP_DEMAND) { out.push(thought(12, 'warn', 'Not enough demand to grow bigger yet.')); return; }
  const lv = footprintMean(w, w.landValue, slot);
  const need = LEVELUP_LV - lv;
  if (need <= 0) { out.push(thought(6, 'good', 'Ready to grow: it can level up.')); return; }
  const eduCov = footprintMean(w, w.covEdu, slot), healthCov = footprintMean(w, w.covHealth, slot);
  const gainEdu = (255 - eduCov) >> LEVELUP_SVC_SHIFT, gainHealth = (255 - healthCov) >> LEVELUP_SVC_SHIFT;
  const gainNow = (eduCov + healthCov) >> LEVELUP_SVC_SHIFT;
  if (need <= gainNow) { out.push(thought(6, 'good', 'Ready to grow: it can level up.')); return; }
  if (eduCov < COVERED_MIN && need - gainNow <= gainEdu) out.push(thought(40, 'warn', "No school nearby - can't level up.", 'education'));
  else if (healthCov < COVERED_MIN && need - gainNow <= gainHealth) out.push(thought(39, 'warn', "No clinic nearby - can't level up.", 'health'));
  else if (need - gainNow <= gainEdu + gainHealth) out.push(thought(38, 'warn', "No school or clinic nearby - can't level up.", 'education'));
  else out.push(thought(37, 'warn', `Land value is too low to level up (${lv}, needs ${LEVELUP_LV}).`, 'landValue'));
}

/** Gauges, the run-now checklist and a plain-words status for a finished Mine, Smelter or Factory. */
function chainFacts(w: World, slot: number): { stocks: StockBar[]; needs: NeedItem[]; thoughts: Weighted[] } {
  const arch = w.bArch[slot]!, flags = w.bFlags[slot]!, out: Weighted[] = [];
  const powered = (flags & BFLAG.UNPOWERED) === 0;
  const needs: NeedItem[] = [{ text: 'Power', ok: powered }];
  const stocks: StockBar[] = [];
  let made = '', inRes = -1, inNeed = 0, outRes: number = RES.ORE;
  if (arch === ARCH.MINE) { outRes = RES.ORE; made = 'Digs 6 ore every 4 s.'; }
  else if (arch === ARCH.SMELTER) { outRes = RES.ALLOY; inRes = RES.ORE; inNeed = SMELT_IN; made = 'Turns 4 ore into 2 alloy.'; }
  else { outRes = RES.PARTS; inRes = RES.ALLOY; inNeed = FACTORY_IN; made = 'Turns 2 alloy into 1 component.'; }
  const have = stockLayer(w, outRes)[slot]!;
  if (inRes >= 0) {
    const buf = w.bIn[slot * 3 + inRes]!;
    stocks.push({ res: inRes, role: 'in', have: buf, cap: inRes === RES.ORE ? SMELTER_BUFFER : FACTORY_BUFFER });
    needs.push({ text: `${RES_NAMES[inRes]}: ${buf} of ${inNeed} for a batch`, ok: buf >= inNeed });
  }
  stocks.push({ res: outRes, role: 'out', have, cap: OUTPUT_CAP });
  needs.push({ text: have >= OUTPUT_CAP ? `${RES_NAMES[outRes]} output full, the extra is sold` : `Room for ${RES_NAMES[outRes]}`, ok: have < OUTPUT_CAP });
  if (chainRunning(w, slot)) {
    if (inRes >= 0 && w.bIn[slot * 3 + inRes]! < inNeed) out.push(thought(30, 'warn', `Starved: waiting for ${RES_NAMES[inRes]!.toLowerCase()} from haulers.`));
    else if (have >= OUTPUT_CAP) out.push(thought(25, 'warn', `Output is full: the extra ${RES_NAMES[outRes]!.toLowerCase()} is sold.`));
    else out.push(thought(8, 'good', made));
  }
  return { stocks, needs, thoughts: out };
}

function buildingInfo(sim: Sim, slot: number): BuildingInfo | null {
  const w = sim.world;
  if (!Number.isInteger(slot) || slot < 0 || slot >= BMAX || w.bArch[slot] === 0) return null;
  const arch = w.bArch[slot]!, a = archetype(arch), flags = w.bFlags[slot]!, zone = zoneOfArch(arch);
  const net = netOf(sim), out: Weighted[] = [];
  const constructing = (flags & BFLAG.CONSTRUCTING) !== 0, ruin = (flags & BFLAG.RUBBLE) !== 0, burning = (flags & BFLAG.BURNING) !== 0;
  const done = isFinished(flags);

  if (ruin) {
    out.push((flags & BFLAG.REBUILD) !== 0
      ? thought(90, 'good', 'A ruin, ordered rebuilt. Robots will clear it and build it again.')
      : thought(90, 'bad', 'A ruin. Robots will clear it away.'));
  }
  if (constructing && !ruin) jobThoughts(sim, net, slot, out);
  if (burning) {
    const cov = Math.round((footprintMax(w, w.covFire, slot) * 100) / 255);
    out.push(thought(100, 'bad', `On fire! Fire cover here is ${cov}%.`, 'fire'));
  }
  if (done || burning) {
    if ((flags & BFLAG.UNPOWERED) !== 0) {
      const over = brownedOutNear(w, w.powerOn, slot);
      out.push(thought(80, 'bad', over ? 'No power: the grid is overloaded. Build more power plants.' : 'No power: connect a power line to the grid.', 'power'));
    }
    if ((flags & BFLAG.UNWATERED) !== 0) {
      const over = brownedOutNear(w, w.waterOn, slot);
      out.push(thought(70, 'bad', over ? 'No water: the supply cannot keep up. Build more pumps.' : 'No water: lay a pipe within 3 tiles.', 'water'));
    }
  }
  if ((flags & BFLAG.ABANDONED) !== 0 && !ruin) {
    const lv = footprintMean(w, w.landValue, slot), crime = footprintMean(w, w.crime, slot), smog = footprintMean(w, w.pollution, slot);
    const why = crime > CRIME_NOTICE ? 'crime drove people out' : smog >= 90 ? 'smog drove people out' : `land value is only ${lv} and nobody wants the space`;
    out.push(thought(75, 'bad', `Abandoned: ${why}.`, crime > CRIME_NOTICE ? 'crime' : smog >= 90 ? 'pollution' : 'landValue'));
  }

  if (done && zone !== 0) {
    const crime = footprintMax(w, w.crime, slot);
    if (crime >= CRIME_NOTICE) {
      const police = footprintMax(w, w.covPolice, slot) < COVERED_MIN;
      out.push(thought(60, crime >= 190 ? 'bad' : 'warn', police ? 'Crime is high: no police station in reach.' : 'Crime is high: the police here are stretched thin.', 'crime'));
    }
    if (zone !== ZONE.I) {
      const smog = footprintMean(w, w.pollution, slot);
      if (smog >= SMOG_NOTICE) {
        const src = polluterNear(w, slot);
        out.push(thought(55, smog >= 120 ? 'bad' : 'warn', src ? `Smog from the ${archLabel(w.bArch[src.slot]!)}.` : 'Smog from heavy traffic.', 'pollution'));
      }
    }
    if (footprintMax(w, w.covFire, slot) < COVERED_MIN) {
      out.push(thought(35, 'warn', fireStations(w) === 0 ? 'No fire station in the city.' : 'No fire station in reach.', 'fire'));
    }
    if (zone === ZONE.R && isOperating(w, slot)) {
      if (footprintMean(w, w.cFail, slot) >= 48) out.push(thought(50, 'warn', 'Commutes from here keep failing.', 'traffic'));
      else if (w.scalars[S.unemployment]! >= 0.3) out.push(thought(30, 'warn', 'Few jobs in the city: residents are out of work.'));
    }
    if (isOperating(w, slot)) levelThoughts(w, slot, out);
  }

  if (done && zone === 0 && a) {
    const svc = a.service;
    if (arch === ARCH.DEPOT) {
      if (lotAccess(net, w.bX[slot]!, w.bY[slot]!, w.bW[slot]!, w.bH[slot]!) < 0) out.push(thought(65, 'bad', 'No road at its door: robots cannot leave.'));
      out.push(thought(20, 'good', `Robots work within ${mods(w).workRadius} road tiles of this depot.`));
      if (w.bStock[slot]! < 8) out.push(thought(30, 'warn', `Only ${w.bStock[slot]} material left in stock.`));
    } else if (svc && svc.kind !== SVC.PARK && svc.kind !== SVC.REPAIR && works(flags)) {
      const st = sim.services && (svc.kind === SVC.FIRE ? sim.services.fire : svc.kind === SVC.POLICE ? sim.services.police : svc.kind === SVC.HEALTH ? sim.services.health : sim.services.edu);
      if (st && st.population > 0) {
        out.push(thought(15, st.pct >= 80 ? 'good' : st.pct >= 40 ? 'warn' : 'bad', `The city is ${st.pct}% covered: ${st.served.toLocaleString('en-US')} of ${st.population.toLocaleString('en-US')} people served.`));
      } else out.push(thought(5, 'good', `Covers ${svc.radius} road tiles around it.`));
    } else if (svc && svc.kind === SVC.PARK) out.push(thought(5, 'good', `Raises land value within ${svc.radius} tiles.`));
    else if (svc && svc.kind === SVC.REPAIR) out.push(thought(5, 'good', `Robots move faster within ${svc.radius} tiles.`));
    if (arch === ARCH.LIGHTNING_ROD) out.push(thought(8, 'good', `Takes every lightning strike within ${ROD_RADIUS} tiles, so nothing there is set alight.`));
    else if (arch === ARCH.SEISMIC_DAMPER) out.push(thought(8, 'good', `Cuts quake damage to the buildings and roads within ${DAMPER_RADIUS} tiles.`));
    else if (arch === ARCH.SHIELD_DOME) {
      if ((flags & BFLAG.UNPOWERED) !== 0) out.push(thought(8, 'warn', 'No power: the dome is down and meteors get through.', 'power'));
      else out.push(thought(8, 'good', `Stops meteors from landing within ${DOME_RADIUS} tiles.`));
    } else if (arch === ARCH.BATTERY_BANK) {
      const pct = Math.round((w.bStock[slot]! * 100) / BATTERY_CAP);
      out.push(thought(8, pct >= 50 ? 'good' : 'warn', `Charged ${pct}%. It fills from spare power and covers brown-outs.`));
    }
    if (a.pollution && a.pollution > 0 && works(flags)) {
      const n = homesNear(w, slot);
      out.push(thought(45, n > 0 ? 'warn' : 'good', n > 0 ? `Its smoke reaches ${n} ${n === 1 ? 'home' : 'homes'} nearby.` : 'Its smoke drifts over open land.', 'pollution'));
    }
    if (a.utility && sim.utils) {
      const net2 = a.utility === 'power' ? sim.utils.power : sim.utils.water;
      if (net2.demand > 0 || net2.supply > 0) out.push(thought(25, net2.demand > net2.supply ? 'warn' : 'good', `The city ${a.utility === 'power' ? `makes ${net2.supply} MW and uses ${net2.demand} MW` : `pumps ${net2.supply} ML and uses ${net2.demand} ML`}.`));
    }
  }

  const chain = done && isChainArch(arch) ? chainFacts(w, slot) : null;
  if (chain) out.push(...chain.thoughts);

  if (out.every((x) => x.t.tone === 'good') && done && zone !== 0) out.push(thought(1, 'good', 'Everything is fine here.'));
  out.sort((p, q) => q.w - p.w);
  const thoughts = out.slice(0, 3).map((x) => x.t);

  const occ = zone !== 0 && isOperating(w, slot) ? occupancyOf(arch) : 0;
  const info: BuildingInfo = {
    kind: 'building', slot, arch, name: capitalise(archLabel(arch)), level: zone !== 0 ? w.bLevel[slot]! : 0, maxLevel: zone !== 0 ? 3 : 0,
    x: w.bX[slot]!, y: w.bY[slot]!, w: w.bW[slot]!, h: w.bH[slot]!,
    status: burning ? 'burning' : constructing ? 'constructing' : (flags & (BFLAG.UNPOWERED | BFLAG.UNWATERED | BFLAG.ABANDONED | BFLAG.RUBBLE)) !== 0 ? 'idle' : 'working',
    progress: constructing ? Math.round((w.bProg[slot]! * 100) / 255) : 100,
    residents: zone === ZONE.R ? occ : 0, jobs: zone === ZONE.C || zone === ZONE.I ? occ : 0, thoughts,
  };
  if (chain) { info.stocks = chain.stocks; info.needs = chain.needs; }
  else if (done && zone !== 0 && w.bLevel[slot]! < 3 && isOperating(w, slot)) info.needs = needsOf(w, slot).map((n) => ({ text: n.text, ok: n.ok }));
  if (arch === ARCH.DEPOT) {
    info.stocks = Array.from({ length: RES_COUNT }, (_, res): StockBar => ({ res, role: 'stock', have: stockLayer(w, res)[slot]!, cap: DEPOT_STOCK_CAP }));
    let builders = 0, haulers = 0;
    for (let k = 0; k < RMAX; k++) {
      if (w.aKind[k] === 0 || homeSlot(w, k) !== slot) continue;
      if (w.aKind[k] === AKIND.BUILDER) builders++; else if (w.aKind[k] === AKIND.HAULER) haulers++;
    }
    const caps = depotCaps(w, slot);
    info.depot = {
      radius: mods(w).workRadius, builders, haulers, stock: w.bStock[slot]!, builderCap: caps.builders, haulerCap: caps.haulers, droneCap: caps.drones, livery: w.bLivery[slot]!,
      modules: [moduleAt(w, slot, 0), moduleAt(w, slot, 1)],
    };
  }
  return info;
}

const ROBOT_ROLE: Record<number, string> = { [AKIND.BUILDER]: 'Builder bot', [AKIND.HAULER]: 'Hauler drone', [AKIND.FIREFIGHTER]: 'Firefighter bot' };
const VEHICLE_ROLE: Record<number, string> = { [VKIND.CAR]: 'Car', [VKIND.TAXI]: 'Robo-taxi', [VKIND.TRUCK]: 'Truck', [VKIND.BUS]: 'Bus' };
const MOVING = new Set<number>([AST.TO_SITE, AST.TO_PICKUP, AST.HAUL, AST.RETURN]);

/** Seconds the rest of a planned tile path takes, from the agent's step and fraction, at the speed of each tile's road class. */
function pathSeconds(w: World, tiles: ArrayLike<number>, step: number, frac: number, speedOf: (cls: number) => number): number {
  let ticks = 0;
  for (let i = step; i < tiles.length - 1; i++) ticks += (i === step ? 1 - frac : 1) / Math.max(0.01, speedOf(w.road[tiles[i]!]! & ROAD.CLASS_MASK));
  return ticks / TICKS_PER_SECOND;
}

const tileXY = (t: number): { x: number; y: number } => ({ x: t & (MAP - 1), y: t >> 8 });

function robotInfo(sim: Sim, a: number): Omit<AgentInfo, 'kind' | 'key' | 'akind' | 'name' | 'x' | 'y'> {
  const w = sim.world, net = netOf(sim), st = w.aState[a]!, k = w.aKind[a]!;
  const j = jobSlot(w, a);
  const site = j >= 0 ? where(w, j) : 'its site';
  const speeds = k === AKIND.BUILDER ? BUILDER_SPEED : k === AKIND.FIREFIGHTER ? FIREFIGHTER_SPEED : HAULER_SPEED;
  const speedOf = (cls: number): number => speeds[cls] ?? speeds[1]!;
  let job: string;
  let target: { x: number; y: number } | undefined;
  let eta: number | undefined;
  if (MOVING.has(st)) {
    const tiles = pathOf(net, w, a);
    if (tiles && tiles.length > 0) {
      target = tileXY(tiles[tiles.length - 1]!);
      eta = pathSeconds(w, tiles, w.aStep[a]!, w.aFrac[a]!, speedOf);
    }
  }
  const home = homeSlot(w, a);
  const carry = w.aCarry[a]!;
  const verb = j >= 0 ? (w.jKind[j] === JOB.DEMOLISH ? 'tear down' : w.jKind[j] === JOB.LEVEL ? 'upgrade' : 'build') : 'build';
  const etaPart = eta !== undefined ? `, ${etaText(eta)}` : '';
  const res = w.aRes[a]! & 3, unit = res === RES.ORE ? 'material' : RES_NAMES[res]!.toLowerCase();
  const transferTo = (w.aRes[a]! & TRANSFER_BIT) !== 0 ? liveSlot(w, w.aTarget[a]!) : -1;
  const toWhere = transferTo >= 0 ? where(w, transferTo) : site;
  switch (st) {
    case AST.IDLE: job = home >= 0 ? `Resting in ${where(w, home)}.` : 'Idle, with no depot to go home to.'; break;
    case AST.TO_SITE: job = `Walking to ${verb} ${site}${etaPart}.`; break;
    case AST.WORK: {
      if (j < 0) { job = 'Finishing up.'; break; }
      const need = w.jNeed[j]!, have = w.jHave[j]!;
      if (w.jKind[j] === JOB.DEMOLISH) job = `Tearing down ${site}: ${100 - Math.round((w.jProg[j]! * 100) / JOB_MAX)}% cleared.`;
      else if (have < need && w.jProg[j]! >= Math.floor((have * JOB_MAX) / Math.max(1, need))) job = `Waiting for material at ${site}: ${have} of ${need} delivered.`;
      else job = `${capitalise(verb === 'build' ? 'building' : 'upgrading')} ${site}: ${Math.round((w.jProg[j]! * 100) / JOB_MAX)}% done.`;
      break;
    }
    case AST.RETURN: job = `Heading back to ${home >= 0 ? where(w, home) : 'a depot'}${etaPart}.`; break;
    case AST.TO_PICKUP: {
      const src = liveSlot(w, w.aSrc[a]!);
      job = `Fetching ${carry} ${unit} from ${src >= 0 ? where(w, src) : 'a depot'}${etaPart}.`;
      break;
    }
    case AST.HAUL: job = `Hauling ${carry} ${unit} to ${toWhere}${etaPart}.`; break;
    case AST.FF_GO: { const f = liveSlot(w, w.aTarget[a]!); job = f >= 0 ? `Rushing to the fire at ${where(w, f)}.` : 'Rushing to a fire.'; break; }
    case AST.FF_SPRAY: { const f = liveSlot(w, w.aTarget[a]!); job = f >= 0 ? `Spraying water on ${where(w, f)}.` : 'Spraying water on a fire.'; break; }
    case AST.REPAIR_GO: case AST.REPAIR_WORK: job = 'Repairing a cracked road.'; break;
    default: job = 'Working.';
  }
  const out: Omit<AgentInfo, 'kind' | 'key' | 'akind' | 'name' | 'x' | 'y'> = { job };
  if (target) out.target = target;
  if (eta !== undefined) out.etaSec = Math.round(eta);
  if (MOVING.has(st) && w.aTry[a]! >= 1) {
    const t = nearestTileOf(w, a);
    const onNet = net.isRoad(t) || nearestRoad(net, t & (MAP - 1), t >> 8, 10) >= 0;
    const waiting = onNet ? 'road blocked' : 'no road';
    out.detail = job;
    out.job = `Waiting: ${waiting}`;
    out.waiting = waiting;
    delete out.etaSec;
  }
  return out;
}

const PURPOSE_TEXT = ['Driving to work.', 'Driving home.', 'Out shopping.', 'Delivering goods.'] as const;

function vehicleInfo(sim: Sim, a: number): Omit<AgentInfo, 'kind' | 'key' | 'akind' | 'name' | 'x' | 'y'> {
  const w = sim.world, vi = a - RMAX, len = w.vLen[vi]!, k = w.aKind[a]!;
  const purpose = w.aCarry[a]! >> 2;
  const dst = liveSlot(w, w.aTarget[a]!);
  const slow = w.aState[a] === VST.SLOW;
  const out: Omit<AgentInfo, 'kind' | 'key' | 'akind' | 'name' | 'x' | 'y'> = { job: PURPOSE_TEXT[purpose] ?? 'On the road.' };
  if (len >= 2) {
    const base = vi * PATH_CAP;
    const route: number[] = [];
    for (let i = 0; i < len; i++) route.push(w.vPath[base + i]!);
    out.target = tileXY(route[len - 1]!);
    const speedOf = (cls: number): number => (FREE_SPEED[cls] ?? FREE_SPEED[1]!) * (KIND_SPEED[k] ?? 1) * (slow ? 0.4 : 1);
    const eta = pathSeconds(w, route, Math.min(w.aStep[a]!, len - 1), w.aFrac[a]!, speedOf);
    if (dst >= 0) out.job = `${out.job.slice(0, -1)} to ${where(w, dst)}, ${etaText(eta)}.`;
    out.etaSec = Math.round(eta);
  }
  if (slow) { out.waiting = 'traffic'; out.detail = out.job; out.job = 'Waiting: stuck in traffic'; delete out.etaSec; }
  return out;
}

function agentInfo(sim: Sim, key: number): AgentInfo | null {
  const w = sim.world;
  if (!Number.isInteger(key) || key < 0) return null;
  const a = key & 0xffff, gen = key >>> 16;
  if (a >= AMAX || w.aKind[a] === 0 || w.aGen[a] !== gen) return null;
  const k = w.aKind[a]!;
  const robot = a < RMAX;
  const role = robot ? `${ROBOT_ROLE[k] ?? 'Robot'} #${a + 1}` : `${VEHICLE_ROLE[k] ?? 'Vehicle'} #${a - RMAX + 1}`;
  const body = robot ? robotInfo(sim, a) : vehicleInfo(sim, a);
  if (canBeNamed(w, a)) {
    const jobs = w.aJobs[a]!, named = jobs >= NAMED_JOBS;
    return { kind: 'agent', key, akind: k, name: named ? botName(a, gen) : role, x: w.aX[a]!, y: w.aY[a]!, ...body, jobs, named, role };
  }
  return { kind: 'agent', key, akind: k, name: role, x: w.aX[a]!, y: w.aY[a]!, ...body };
}

/** Answer a RequestInfo: `ok: false` with a reason when the building is gone or the agent has left (or gone back into its depot). */
export function answerInfo(sim: Sim, m: RequestInfo): InfoMsg {
  const miss = (reason: string): InfoMsg => ({ type: 'info', id: m.id, ok: false, reason });
  if (m.kind === 'building') {
    const info = buildingInfo(sim, m.ref);
    return info ? { type: 'info', id: m.id, ok: true, info } : miss('gone');
  }
  if (m.kind === 'agent') {
    const info = agentInfo(sim, m.ref);
    return info ? { type: 'info', id: m.id, ok: true, info } : miss('gone');
  }
  return miss('invalid');
}
