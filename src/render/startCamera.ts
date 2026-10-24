import type { TileRead } from '../sim/estimate.ts';
import { MAP } from '../sim/layers.ts';
import { findFlatSite } from './tools/sites.ts';

export interface StartPose { x: number; z: number; yaw: number; pitch: number; dist: number }

/** Neighbourhood zoom: close enough that roads and lots read on a phone, far enough to see a district. */
export const START_DIST = 52;
export const START_PITCH = 0.9;
export const START_YAW = 0.6;
const SITE = 16;

/**
 * Camera for a fresh city: neighbourhood zoom over the flat, free, buildable window nearest the map centre (the same finder the
 * smoke test and the build tools use), or the map centre when no window exists. Pure and deterministic in the layers.
 */
export function startCameraFor(read: TileRead): StartPose {
  const site = findFlatSite(read, SITE);
  const x = site ? site.x + SITE / 2 : MAP / 2;
  const z = site ? site.y + SITE / 2 : MAP / 2;
  return { x, z, yaw: START_YAW, pitch: START_PITCH, dist: START_DIST };
}
