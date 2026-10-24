// Where the photo-mode tour goes: the tallest finished buildings and the biggest building sites, read from the render mirror.
import { cachedModel, progressOf } from './instances.ts';
import { variantOf } from './kit/generate.ts';
import type { RenderMirror } from './mirror.ts';
import type { TourCandidate } from './cinematic.ts';

/** A site under construction scores as if it were this much taller, so a busy crane site makes the tour. */
const SITE_BONUS = 3;

export function tourCandidates(mirror: RenderMirror, ground: (x: number, z: number) => number): (TourCandidate & { radius: number })[] {
  const out: (TourCandidate & { radius: number })[] = [];
  const t = mirror.table;
  for (let slot = 0; slot < t.bArch.length; slot++) {
    if (!t.bArch[slot]) continue;
    const b = mirror.building(slot);
    if (!b) continue;
    const model = cachedModel(b.arch, variantOf(b.arch, b.x, b.y, 1));
    const cx = b.x + b.w / 2, cz = b.y + b.h / 2;
    const gy = ground(cx, cz);
    const building = progressOf(b.flags, b.prog) >= 1;
    const h = Math.max(1, model.height);
    out.push({ x: cx, z: cz, ty: gy + h * 0.5, score: h + b.w * b.h * 0.2 + (building ? 0 : SITE_BONUS), radius: Math.max(14, h * 2.4 + Math.max(b.w, b.h) * 2) });
  }
  return out;
}
