/** Service kinds. FIRE..EDU spread along the road network (roadFlow); PARK and REPAIR cover a plain disc of tiles. */
export const SVC = { NONE: 0, FIRE: 1, POLICE: 2, HEALTH: 3, EDU: 4, PARK: 5, REPAIR: 6 } as const;

export interface ServiceSpec {
  kind: number;
  /** Road kinds: coverage reach in road tiles from the building's access road. Park and repair: disc radius in tiles. */
  radius: number;
  /** People (residents, or jobs for fire and police) the building can serve at once; 0 for park and repair, which have no limit. */
  capacity: number;
}

export interface Archetype {
  id: number;
  name: string;
  w: number;
  h: number;
  cost: number;
  /** False for RCI archetypes: the growth system (U7) creates them, the player cannot place them. */
  placeable: boolean;
  /** RCI only: zone type 1 R, 2 C, 3 I (the ZONE values), density 0 low .. 2 high, level 1..3. */
  zone?: number;
  density?: number;
  level?: number;
  /** Monthly upkeep charged to the budget (service and utility buildings; RCI pay none). */
  upkeep?: number;
  /** Pollution units emitted per pollution pass by a non-RCI building (economy/overlays.ts). */
  pollution?: number;
  /** Utility buildings: which network they belong to. The tool sheet groups them under Utilities. */
  utility?: 'power' | 'water';
  /** City services: what the building covers and how many people it can serve (services/tables.ts derives the lookup tables from this). */
  service?: ServiceSpec;
  /** Population tier (unlocks.ts TIERS index) the city must have reached before this can be placed; placeBuilding and its estimate refuse with `locked` until then. */
  unlock?: number;
}

export const ARCH = {
  DEPOT: 1, POWER_PLANT: 2, WATER_PUMP: 3, FIRE_STATION: 4, SOLAR_FARM: 5, WATER_TOWER: 6, FUSION_REACTOR: 7,
  POLICE: 8, CLINIC: 9, HOSPITAL: 10, SCHOOL: 11, UNIVERSITY: 12, PARK_SMALL: 13, PARK_LARGE: 14, REPAIR_BAY: 15,
  /** Megaprojects (megaprojects.ts): ids sit after the 27 RCI archetypes so the RCI range stays contiguous. */
  FUSION_SPIRE: 43, ARCOLOGY: 44, MECH_ARENA: 45, SPACE_ELEVATOR: 46,
} as const;

/**
 * RCI archetype ids are stable and never renumbered: ids 1-15 are services and utilities, 16-42 are the 27 grown
 * buildings. id = RCI_BASE + (zone - 1) * 9 + density * 3 + (level - 1), so R low L1 is 16 and I high L3 is 42.
 */
export const RCI_BASE = 16;
export const RCI_COUNT = 27;
export const ZONE_NAMES = ['', 'res', 'com', 'ind'] as const;
export const DENSITY_NAMES = ['low', 'med', 'high'] as const;

export const rciId = (zone: number, density: number, level: number): number => RCI_BASE + (zone - 1) * 9 + density * 3 + (level - 1);
export const isRci = (id: number): boolean => id >= RCI_BASE && id < RCI_BASE + RCI_COUNT;

/** Footprint edge in tiles by [density][level - 1]: low 1/1/2, medium 2/2/3, high 2/3/3. */
const FOOTPRINT = [[1, 1, 2], [2, 2, 3], [2, 3, 3]] as const;
export const rciFootprint = (density: number, level: number): number => FOOTPRINT[density]![level - 1]!;

/** bFlags bit 0: the building is under construction and bProg (0..255) is the progress. Unset means complete. */
export const BFLAG = {
  CONSTRUCTING: 1,
  /** Set by the economy when a completed RCI building has sat in very low desirability with negative demand; U7 decays or demolishes it. */
  ABANDONED: 2,
  /** Set with CONSTRUCTING while robots tear a building down: bProg runs from 255 down to 0, then the slot is freed. */
  DEMOLISHING: 4,
  /**
   * Outage bits are set by the utilities solve (utilities/solve.ts) and mean "this consumer is not served". They are inverted
   * on purpose: a new or legacy building has flags 0 and so counts as served until a solve says otherwise.
   */
  UNPOWERED: 16,
  UNWATERED: 32,
  /** On fire (sim/disasters): bHeat is the fire's heat and bDmg grows each fire step until it burns out or the building is destroyed. */
  BURNING: 64,
  /** Destroyed by a disaster (bDmg 255), always set together with ABANDONED so the economy ignores it and the robots tear the ruin down. */
  RUBBLE: 128,
} as const;

const rciArchetypes = (): Archetype[] => {
  const out: Archetype[] = [];
  for (let zone = 1; zone <= 3; zone++) for (let density = 0; density <= 2; density++) for (let level = 1; level <= 3; level++) {
    const f = rciFootprint(density, level);
    out.push({
      id: rciId(zone, density, level), name: `${ZONE_NAMES[zone]}-${DENSITY_NAMES[density]}-l${level}`, w: f, h: f, cost: 0,
      placeable: false, zone, density, level,
    });
  }
  return out;
};

export const CATALOG: readonly Archetype[] = [
  { id: ARCH.DEPOT, name: 'depot', w: 2, h: 2, cost: 500, placeable: true, upkeep: 20 },
  { id: ARCH.POWER_PLANT, name: 'powerPlant', w: 4, h: 4, cost: 3000, placeable: true, upkeep: 120, pollution: 200, utility: 'power' },
  { id: ARCH.WATER_PUMP, name: 'waterPump', w: 2, h: 2, cost: 800, placeable: true, upkeep: 30, utility: 'water' },
  { id: ARCH.FIRE_STATION, name: 'fireStation', w: 3, h: 3, cost: 1200, placeable: true, upkeep: 60, service: { kind: SVC.FIRE, radius: 24, capacity: 3000 } },
  { id: ARCH.SOLAR_FARM, name: 'solarFarm', w: 4, h: 4, cost: 2400, placeable: true, upkeep: 50, utility: 'power' },
  { id: ARCH.WATER_TOWER, name: 'waterTower', w: 2, h: 2, cost: 900, placeable: true, upkeep: 25, utility: 'water' },
  { id: ARCH.FUSION_REACTOR, name: 'fusionReactor', w: 4, h: 4, cost: 12000, placeable: true, upkeep: 260, utility: 'power', unlock: 3 },
  { id: ARCH.POLICE, name: 'policeStation', w: 3, h: 3, cost: 1500, placeable: true, upkeep: 70, service: { kind: SVC.POLICE, radius: 22, capacity: 2500 } },
  { id: ARCH.CLINIC, name: 'clinic', w: 2, h: 2, cost: 900, placeable: true, upkeep: 45, service: { kind: SVC.HEALTH, radius: 18, capacity: 1500 } },
  { id: ARCH.HOSPITAL, name: 'hospital', w: 4, h: 4, cost: 6000, placeable: true, upkeep: 220, service: { kind: SVC.HEALTH, radius: 32, capacity: 8000 } },
  { id: ARCH.SCHOOL, name: 'school', w: 3, h: 3, cost: 1400, placeable: true, upkeep: 55, service: { kind: SVC.EDU, radius: 20, capacity: 2000 } },
  { id: ARCH.UNIVERSITY, name: 'university', w: 4, h: 4, cost: 7000, placeable: true, upkeep: 260, service: { kind: SVC.EDU, radius: 34, capacity: 9000 } },
  { id: ARCH.PARK_SMALL, name: 'parkSmall', w: 2, h: 2, cost: 300, placeable: true, upkeep: 6, service: { kind: SVC.PARK, radius: 6, capacity: 0 } },
  { id: ARCH.PARK_LARGE, name: 'parkLarge', w: 4, h: 4, cost: 1400, placeable: true, upkeep: 24, service: { kind: SVC.PARK, radius: 12, capacity: 0 } },
  { id: ARCH.REPAIR_BAY, name: 'repairBay', w: 2, h: 2, cost: 700, placeable: true, upkeep: 30, service: { kind: SVC.REPAIR, radius: 12, capacity: 0 } },
  { id: ARCH.FUSION_SPIRE, name: 'fusionSpire', w: 5, h: 5, cost: 60000, placeable: true, upkeep: 900, unlock: 4 },
  { id: ARCH.ARCOLOGY, name: 'arcology', w: 7, h: 7, cost: 120000, placeable: true, upkeep: 700, unlock: 4 },
  { id: ARCH.MECH_ARENA, name: 'mechArena', w: 6, h: 6, cost: 80000, placeable: true, upkeep: 600, unlock: 4 },
  { id: ARCH.SPACE_ELEVATOR, name: 'spaceElevator', w: 6, h: 6, cost: 400000, placeable: true, upkeep: 2500, unlock: 5 },
  ...rciArchetypes(),
];

export const archetype = (id: number): Archetype | undefined => CATALOG.find((a) => a.id === id);

export const ROAD_COST = [0, 10, 25, 60] as const;
export const BRIDGE_EXTRA = 40;
export const ZONE_COST = 2;
/** Per tile laid: an overhead power line or an underground water pipe. Tiles that already carry one cost nothing. */
export const POWER_LINE_COST = 8;
export const PIPE_COST = 6;
export const BULLDOZE_COST = 1;

/** One raise or lower step is 1/4 tile of height (4 height units); leveling rounds each tile's change up to whole steps for cost. */
export const TERRAFORM_STEP = 4;
export const TERRAFORM_COST = 6;
export const MAX_TERRAFORM_TILES = 1024;
/** Land stays above sea level and below the tallest peak the generator can make. */
export const HEIGHT_MIN = 1;
export const HEIGHT_MAX = 48 * 16;
