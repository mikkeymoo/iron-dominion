// What the player is looking at, shared by the HUD (which sets it) and the renderer (which reads it). DOM-free and three-free.

export type OverlayMode = 'none' | 'power' | 'water' | 'landValue' | 'pollution' | 'fire' | 'police' | 'health' | 'education' | 'crime' | 'parks';
export const OVERLAY_MODES: readonly OverlayMode[] = ['none', 'power', 'water', 'landValue', 'pollution', 'fire', 'police', 'health', 'education', 'crime', 'parks'];
export const OVERLAY_LABELS: Record<OverlayMode, string> = {
  none: 'None', power: 'Power', water: 'Water', landValue: 'Land value', pollution: 'Pollution', fire: 'Fire', police: 'Police', health: 'Health',
  education: 'Education', crime: 'Crime', parks: 'Parks',
};

export const isOverlayMode = (v: unknown): v is OverlayMode => typeof v === 'string' && (OVERLAY_MODES as readonly string[]).includes(v);

/**
 * One per city session. `version` bumps on every change so the render loop can compare a number per frame. The underground view
 * shows the water coverage tint whatever overlay is chosen, so the effective overlay is derived, not stored.
 */
export class ViewState {
  overlay: OverlayMode = 'none';
  underground = false;
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

  /** The overlay the terrain actually paints. */
  get effectiveOverlay(): OverlayMode { return this.underground ? 'water' : this.overlay; }
}
