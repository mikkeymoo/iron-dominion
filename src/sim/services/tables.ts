import { BFLAG, CATALOG, SVC } from '../catalog.ts';

// Every balancing constant of the city services. Integer math only, like the economy.

export const ONE = 1024;

/** Each coverage pass runs once per SERVICE_PERIOD ticks; the passes are staggered over the period (see PHASE). */
export const SERVICE_PERIOD = 20;
export const PHASE = { FIRE: 0, DISC: 2, POLICE: 4, HEALTH: 8, EDU: 12, CRIME: 16 } as const;

/** Coverage (0..255) at the edge of a service's reach; it climbs linearly to 255 at the building's own access road. */
export const COV_EDGE = 40;
/** Chebyshev halo, in tiles, around a covered road tile that receives its coverage: a lot reaches the road it borders. */
export const COV_HALO = 2;
/** A building counts as covered by a service at this coverage or more. */
export const COVERED_MIN = 32;

// ---- Crime (0..255) ----
/** crime = ((255 - police coverage) * CRIME_POLICE_W + (255 - land value) * CRIME_POOR_W) >> 8, scaled by density. */
export const CRIME_POLICE_W = 168;
export const CRIME_POOR_W = 88;
/** Density scale (out of 256) by density row low, medium, high: crowded blocks breed more crime. */
export const CRIME_DENSITY = [150, 205, 256] as const;
export const CRIME_ABANDONED = 48;

// ---- Fire risk (0..255) ----
/** Flammability (out of 256) by zone R, C, I. */
export const FIRE_FLAMMABLE = [0, 140, 170, 256] as const;

// ---- Robot repair bay ----
/** A robot standing in a repair bay's disc moves REPAIR_BOOST_Q / ONE times as fast. */
export const REPAIR_BOOST_Q = 1280;

const kindOf = new Uint8Array(256);
const radiusOf = new Uint8Array(256);
const capacityOf = new Uint16Array(256);
for (const a of CATALOG) {
  if (!a.service) continue;
  kindOf[a.id] = a.service.kind; radiusOf[a.id] = a.service.radius; capacityOf[a.id] = a.service.capacity;
}

export const serviceKind = (arch: number): number => kindOf[arch] ?? SVC.NONE;
export const serviceRadius = (arch: number): number => radiusOf[arch] ?? 0;
export const serviceCapacity = (arch: number): number => capacityOf[arch] ?? 0;

/** Coverage at road distance d from a service of reach r: COV_EDGE at d = r, 255 at d = 0. */
export const falloff = (d: number, r: number): number => COV_EDGE + Math.floor(((255 - COV_EDGE) * (r - d)) / r);

/** A finished building that is neither dark nor dry. Utilities clear both bits for consumers of nothing, so this is exact. */
export const works = (flags: number): boolean => (flags & (BFLAG.CONSTRUCTING | BFLAG.DEMOLISHING | BFLAG.ABANDONED | BFLAG.UNPOWERED | BFLAG.UNWATERED)) === 0;
