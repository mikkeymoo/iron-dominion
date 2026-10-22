import type { Campaign } from "./types";

export const REGION_RADIUS = 46;

/** World positions for every squad; shared by renderer and hit-testing. */
export function squadPositions(s: Campaign): Map<number, { x: number; y: number }> {
  const out = new Map<number, { x: number; y: number }>();
  const slot = new Map<number, number>();
  for (const q of s.squads) {
    if (q.from !== null && q.to !== null) {
      const a = s.regions[q.from], b = s.regions[q.to];
      out.set(q.id, { x: a.x + (b.x - a.x) * q.t, y: a.y + (b.y - a.y) * q.t });
      continue;
    }
    const i = slot.get(q.at) ?? 0;
    slot.set(q.at, i + 1);
    const ring = Math.floor(i / 8);
    const ang = (i % 8) * (Math.PI / 4) + ring * 0.4 - Math.PI / 2;
    const rad = REGION_RADIUS + 14 + ring * 22;
    const r = s.regions[q.at];
    out.set(q.id, { x: r.x + Math.cos(ang) * rad, y: r.y + Math.sin(ang) * rad });
  }
  return out;
}
