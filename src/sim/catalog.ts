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
}

export const ARCH = { DEPOT: 1, POWER_PLANT: 2, WATER_PUMP: 3, FIRE_STATION: 4 } as const;

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
export const BFLAG = { CONSTRUCTING: 1 } as const;

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
  { id: ARCH.DEPOT, name: 'depot', w: 2, h: 2, cost: 500, placeable: true },
  { id: ARCH.POWER_PLANT, name: 'powerPlant', w: 4, h: 4, cost: 3000, placeable: true },
  { id: ARCH.WATER_PUMP, name: 'waterPump', w: 2, h: 2, cost: 800, placeable: true },
  { id: ARCH.FIRE_STATION, name: 'fireStation', w: 3, h: 3, cost: 1200, placeable: true },
  ...rciArchetypes(),
];

export const archetype = (id: number): Archetype | undefined => CATALOG.find((a) => a.id === id);

export const ROAD_COST = [0, 10, 25, 60] as const;
export const BRIDGE_EXTRA = 40;
export const ZONE_COST = 2;
export const BULLDOZE_COST = 1;

/** One raise or lower step is 1/4 tile of height (4 height units); leveling rounds each tile's change up to whole steps for cost. */
export const TERRAFORM_STEP = 4;
export const TERRAFORM_COST = 6;
export const MAX_TERRAFORM_TILES = 1024;
/** Land stays above sea level and below the tallest peak the generator can make. */
export const HEIGHT_MIN = 1;
export const HEIGHT_MAX = 48 * 16;
