/** Colour of a traffic overlay cell for a load heat 0..255: transparent where empty, green through amber to red. Returns [r, g, b, a] bytes. */
export function trafficRamp(heat: number): [number, number, number, number] {
  if (heat <= 0) return [0, 0, 0, 0];
  const t = Math.min(1, heat / 255);
  const r = Math.round(255 * Math.min(1, t * 2)), g = Math.round(255 * Math.min(1, 2 - t * 2));
  return [r, g, 40, Math.round(120 + 100 * t)];
}
