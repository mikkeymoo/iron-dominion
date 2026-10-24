import { ARCH, rciId } from '../catalog.ts';

// Kept apart from the disasters system so the HUD can name a fire without pulling the sim into the app bundle.

const ZONE_PLACE = ['', 'Residential district', 'Commercial district', 'Industrial district'] as const;
const ARCH_PLACE: Record<number, string> = {
  [ARCH.DEPOT]: 'the depot', [ARCH.POWER_PLANT]: 'the power plant', [ARCH.WATER_PUMP]: 'a water pump', [ARCH.FIRE_STATION]: 'the fire station',
  [ARCH.SOLAR_FARM]: 'the solar farm', [ARCH.WATER_TOWER]: 'a water tower', [ARCH.FUSION_REACTOR]: 'the fusion reactor',
};

/** Where a fire is, in words: the district type of a grown building, or the service building's name. */
export function placeName(arch: number): string {
  const zone = arch >= rciId(1, 0, 1) && arch <= rciId(3, 2, 3) ? Math.floor((arch - rciId(1, 0, 1)) / 9) + 1 : 0;
  return ZONE_PLACE[zone] || ARCH_PLACE[arch] || 'the city';
}
