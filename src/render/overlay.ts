import type { RenderMirror } from './mirror.ts';
import { overlayChecksum, overlayLayersOf, paintAll, paintChunk, type OverlayLayers } from './overlayPaint.ts';
import type { TerrainSlots } from './terrainMaterial.ts';
import type { OverlayMode } from './viewState.ts';

/**
 * Keeps the terrain's overlay texture in step with the chosen mode and the mirror: a full repaint when the mode changes, then
 * only the chunks the mirror reports dirty (overlay patches arrive about once a second, building and road edits at once).
 * While the mode is 'none' the dirty queue is still drained and nothing is painted.
 */
export class OverlayView {
  private readonly layers: OverlayLayers;
  private applied: OverlayMode | null = null;
  private sum: number | null = null;
  /** Texture uploads so far, for the debug hook. */
  uploads = 0;

  constructor(private readonly mirror: RenderMirror, private readonly slots: TerrainSlots) {
    this.layers = overlayLayersOf(mirror.layers);
  }

  update(mode: OverlayMode): void {
    const dirty = this.mirror.takeDirtyOverlay();
    const data = this.slots.overlayTexture.image.data as Uint8Array;
    let changed = false;
    if (mode !== this.applied) {
      if (mode === 'none') data.fill(0); else paintAll(mode, this.layers, data);
      this.applied = mode;
      changed = true;
    } else if (mode !== 'none' && dirty.length > 0) {
      for (const c of dirty) paintChunk(mode, this.layers, c, data);
      changed = true;
    }
    if (!changed) return;
    this.slots.overlayTexture.needsUpdate = true;
    this.slots.overlayMode.value = mode === 'none' ? 0 : 1;
    this.sum = null;
    this.uploads++;
  }

  get mode(): OverlayMode { return this.applied ?? 'none'; }

  /** Fingerprint of the painted texture; recomputed lazily after a change. */
  get checksum(): number {
    if (this.sum === null) this.sum = overlayChecksum(this.slots.overlayTexture.image.data as Uint8Array);
    return this.sum;
  }
}
