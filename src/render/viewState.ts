// What the player is looking at, shared by the HUD (which sets it) and the renderer (which reads it). DOM-free and three-free.

import type { OVERLAY_MODE_TRAFFIC } from '../sim/traffic/constants.ts';

/** `depotReach` is never picked from the Views list: the depot tool and a selected depot switch it on through ViewState.depotReach. */
export type OverlayMode = 'none' | 'power' | 'water' | 'landValue' | 'pollution' | typeof OVERLAY_MODE_TRAFFIC | 'fire' | 'police' | 'health' | 'education' | 'crime' | 'parks' | 'depotReach';
export const OVERLAY_MODES: readonly OverlayMode[] = ['none', 'power', 'water', 'landValue', 'pollution', 'traffic', 'fire', 'police', 'health', 'education', 'crime', 'parks'];
export const OVERLAY_LABELS: Record<OverlayMode, string> = {
  none: 'None', power: 'Power', water: 'Water', landValue: 'Land value', pollution: 'Pollution', traffic: 'Traffic', fire: 'Fire', police: 'Police', health: 'Health',
  education: 'Education', crime: 'Crime', parks: 'Parks', depotReach: 'Depot reach',
};

export const isOverlayMode = (v: unknown): v is OverlayMode => typeof v === 'string' && (OVERLAY_MODES as readonly string[]).includes(v);

/**
 * One per city session. `version` bumps on every change so the render loop can compare a number per frame. The underground view
 * shows the water coverage tint whatever overlay is chosen, so the effective overlay is derived, not stored.
 */
export class ViewState {
  overlay: OverlayMode = 'none';
  underground = false;
  /** The depot tool is active or a depot is selected: the terrain shows the depot's road-distance work radius instead of the chosen overlay. */
  depotReach = false;
  version = 0;
  private readonly listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }

  private changed(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  setOverlay(mode: OverlayMode): void {
    if (mode === this.overlay) return;
    this.overlay = mode;
    this.changed();
  }

  setUnderground(on: boolean): void {
    if (on === this.underground) return;
    this.underground = on;
    this.changed();
  }

  toggleUnderground(): void { this.setUnderground(!this.underground); }

  setDepotReach(on: boolean): void {
    if (on === this.depotReach) return;
    this.depotReach = on;
    this.changed();
  }

  /** The overlay the terrain actually paints. */
  get effectiveOverlay(): OverlayMode { return this.underground ? 'water' : this.depotReach ? 'depotReach' : this.overlay; }
}
