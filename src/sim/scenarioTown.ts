import { ARCH, archetype, rciId } from './catalog.ts';
import { fixRoad, reserveBuilding } from './commands.ts';
import { D, F, MAP, MAX_LOANS, S, ZONE, isWaterTerrain, type World } from './layers.ts';
import { DEFAULT_TAX, LOAN_BP, LOAN_TIERS } from './economy/tables.ts';
import { mods } from './firmware.ts';
import { AKIND, BUILDERS_PER_DEPOT, DEPOT_START_STOCK, HAULERS_PER_DEPOT } from './robots/constants.ts';
import { refOf, spawnAgent } from './robots/pool.ts';
import { initScenarioLayer } from './scenarioRun.ts';
import { withFloor } from './disasters/tables.ts';
import type { ScenarioSpec, TownKind } from './scenarios.ts';
import { STARTER_BUILDERS, STARTER_HAULERS, placeStarter, starterSite } from './starter.ts';
import { tileIdx } from './tiles.ts';
import type { Sim } from './world.ts';

// Opening a scenario: the layer, the treasury and loans, the modifiers' side effects on the opening state, and the starting kit or a
// pre-built town. Runs once inside createSim, never on a loaded snapshot.

const PITCH = 6;
/** Tiles of levelled ground kept around a town, and the blend beyond it. */
const MARGIN = 2;
const BLEND = 3;

interface Block { x: number; y: number; zone: number }
interface Layout {
  w: number;
  h: number;
  /** Density (0..2) and level (1..3) of the buildings. */
  density: number;
  level: number;
  /** Road segments, each horizontal or vertical, in offsets from the town's top-left. */
  roads: [number, number, number, number][];
  blocks: Block[];
}

const CYCLE = [ZONE.R, ZONE.R, ZONE.C, ZONE.I];

function district(x0: number, y0: number, cols: number, rows: number, zoneOf: (bx: number, by: number) => number): Pick<Layout, 'roads' | 'blocks'> {
  const roads: Layout['roads'] = [];
  for (let r = 0; r <= rows; r++) roads.push([x0, y0 + r * PITCH, x0 + cols * PITCH, y0 + r * PITCH]);
  for (let c = 0; c <= cols; c++) roads.push([x0 + c * PITCH, y0, x0 + c * PITCH, y0 + rows * PITCH]);
  const blocks: Block[] = [];
  for (let by = 0; by < rows; by++) for (let bx = 0; bx < cols; bx++) blocks.push({ x: x0 + bx * PITCH + 1, y: y0 + by * PITCH + 1, zone: zoneOf(bx, by) });
  return { roads, blocks };
}

/** A grid town of cols x rows blocks; zones cycle R, R, C, I. */
function gridLayout(cols: number, rows: number): Layout {
  const d = district(0, 0, cols, rows, (bx, by) => CYCLE[(bx * 3 + by) % 4]!);
  return { w: cols * PITCH + 1, h: rows * PITCH + 1, density: 1, level: 2, ...d };
}

const GAP = 12;
const JAM_COLS = 3;
const JAM_ROWS = 4;

/** Homes in the west and jobs in the east, joined by one street across a gap: every commute funnels into it. */
function jamLayout(): Layout {
  const west = district(0, 0, JAM_COLS, JAM_ROWS, () => ZONE.R);
  const x1 = JAM_COLS * PITCH + GAP;
  const east = district(x1, 0, JAM_COLS, JAM_ROWS, (bx, by) => ((bx + by) % 2 === 0 ? ZONE.C : ZONE.I));
  const link: Layout['roads'][number] = [JAM_COLS * PITCH, 2 * PITCH, x1, 2 * PITCH];
  return {
    w: x1 + JAM_COLS * PITCH + 1, h: JAM_ROWS * PITCH + 1, density: 2, level: 3,
    roads: [...west.roads, ...east.roads, link], blocks: [...west.blocks, ...east.blocks],
  };
}

const SIZES: Record<TownKind, [number, number][]> = {
  small: [[5, 4], [4, 3], [3, 3]],
  debt: [[4, 3], [3, 3]],
  big: [[10, 8], [8, 6], [6, 5], [4, 3]],
  jam: [],
};

function layoutsFor(kind: TownKind): Layout[] {
  if (kind === 'jam') return [jamLayout()];
  return SIZES[kind].map(([c, r]) => gridLayout(c, r));
}

/** Flatten the ground under a town to its mean height and blend the ground around it, so the grid sits on a plateau. */
function levelPlateau(w: World, x0: number, y0: number, x1: number, y1: number): void {
  let sum = 0, n = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { sum += w.height[tileIdx(x, y)]!; n++; }
  const target = Math.round(sum / n);
  for (let y = Math.max(0, y0 - BLEND); y <= Math.min(MAP - 1, y1 + BLEND); y++) {
    for (let x = Math.max(0, x0 - BLEND); x <= Math.min(MAP - 1, x1 + BLEND); x++) {
      const i = tileIdx(x, y);
      const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0, dy = y < y0 ? y0 - y : y > y1 ? y - y1 : 0;
      const inside = dx === 0 && dy === 0;
      if (!inside && (isWaterTerrain(w.terrain[i]!) || w.waterDepth[i]! > 0)) continue;
      const t = inside ? 1 : Math.max(0, 1 - Math.hypot(dx, dy) / (BLEND + 1));
      w.height[i] = Math.round(w.height[i]! + (target - w.height[i]!) * t * t * (3 - 2 * t));
    }
  }
}

/** Pre-built town of finished buildings with a depot and its crew; returns false when the map has no flat dry window big enough. */
export function placeTown(sim: Sim, kind: TownKind): boolean {
  const w = sim.world;
  for (const layout of layoutsFor(kind)) {
    const pad = 2 * MARGIN;
    const site = starterSite(w, layout.w + pad, layout.h + pad);
    if (!site) continue;
    const ox = site.x + MARGIN, oy = site.y + MARGIN;
    levelPlateau(w, ox - MARGIN, oy - MARGIN, ox + layout.w - 1 + MARGIN, oy + layout.h - 1 + MARGIN);
    const touched: number[] = [];
    for (const [ax, ay, bx, by] of layout.roads) {
      for (let y = Math.min(ay, by); y <= Math.max(ay, by); y++) for (let x = Math.min(ax, bx); x <= Math.max(ax, bx); x++) {
        const i = tileIdx(ox + x, oy + y);
        w.road[i] = 1;
        w.zone[i] = 0;
        touched.push(i);
      }
    }
    for (const i of touched) fixRoad(w, i % MAP, (i / MAP) | 0);
    layout.blocks.forEach((b, n) => {
      const bx = ox + b.x, by = oy + b.y;
      for (let y = by; y < by + PITCH - 1; y++) for (let x = bx; x < bx + PITCH - 1; x++) w.zone[tileIdx(x, y)] = b.zone | (layout.density << 2);
      if (n === 0) {
        const slot = reserveBuilding(sim, archetype(ARCH.DEPOT)!, bx, by, 0, 0, 0);
        if (slot < 0) return;
        w.bAux[slot] = 1;
        w.bStock[slot] = DEPOT_START_STOCK;
        const m = mods(w), ref = refOf(w, slot);
        const builders = Math.ceil((STARTER_BUILDERS * m.buildersPerDepot) / BUILDERS_PER_DEPOT), haulers = Math.ceil((STARTER_HAULERS * m.haulersPerDepot) / HAULERS_PER_DEPOT);
        for (let k = 0; k < builders; k++) spawnAgent(w, AKIND.BUILDER, ref, bx + 1, by + 1);
        for (let k = 0; k < haulers; k++) spawnAgent(w, AKIND.HAULER, ref, bx + 1, by + 1);
        return;
      }
      reserveBuilding(sim, archetype(rciId(b.zone, layout.density, layout.level))!, bx, by, layout.level, 255, 0);
    });
    return true;
  }
  return false;
}

/** Open a scenario on a freshly generated world: layer, money, debts, tier, research, then the starting kit or town. */
export function setupScenario(sim: Sim, spec: ScenarioSpec): void {
  const w = sim.world, s = w.scalars;
  initScenarioLayer(w, spec);
  const m = mods(w);
  s[S.treasury] = spec.cash;
  s[S.tier] = Math.max(s[S.tier]!, spec.tier);
  w.firmware[F.RP] = spec.rp;
  w.firmware[F.EARNED] = spec.rp;
  const cap = Math.min(DEFAULT_TAX, m.taxCap);
  s[S.taxR] = cap; s[S.taxC] = cap; s[S.taxI] = cap;
  w.disaster[D.MODE] = withFloor(w.disaster[D.MODE]!, m.disasterFloor);
  spec.loans.slice(0, MAX_LOANS).forEach((tier, slot) => { w.loanAmt[slot] = LOAN_TIERS[tier]!; w.loanBp[slot] = LOAN_BP[tier]!; });
  if (spec.start === 'starter') {
    placeStarter(sim, {
      builders: Math.ceil((STARTER_BUILDERS * m.buildersPerDepot) / BUILDERS_PER_DEPOT),
      haulers: Math.ceil((STARTER_HAULERS * m.haulersPerDepot) / HAULERS_PER_DEPOT),
    });
  }
  if (spec.town) placeTown(sim, spec.town);
}
