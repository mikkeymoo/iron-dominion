export interface Archetype {
  id: number;
  name: string;
  w: number;
  h: number;
  cost: number;
}

export const ARCH = { DEPOT: 1, POWER_PLANT: 2, WATER_PUMP: 3, FIRE_STATION: 4 } as const;

export const CATALOG: readonly Archetype[] = [
  { id: ARCH.DEPOT, name: 'depot', w: 2, h: 2, cost: 500 },
  { id: ARCH.POWER_PLANT, name: 'powerPlant', w: 4, h: 4, cost: 3000 },
  { id: ARCH.WATER_PUMP, name: 'waterPump', w: 2, h: 2, cost: 800 },
  { id: ARCH.FIRE_STATION, name: 'fireStation', w: 3, h: 3, cost: 1200 },
];

export const archetype = (id: number): Archetype | undefined => CATALOG.find((a) => a.id === id);

export const ROAD_COST = [0, 10, 25, 60] as const;
export const BRIDGE_EXTRA = 40;
export const ZONE_COST = 2;
export const BULLDOZE_COST = 1;
