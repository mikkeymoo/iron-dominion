import type { MegaTarget } from './cinematic.ts';
import type { ParticleKind } from './fx/particles.ts';
import type { CelebrationEvent } from './mirror.ts';

// Turns the sim's milestone and megaproject events into particle bursts and the completion camera move. The deps are plain
// functions so the choices (what bursts, how much, when the cinematic starts) are unit-tested without a GPU.

export interface CelebrateDeps {
  emit(kind: ParticleKind, x: number, y: number, z: number, count: number, size: number, energy: number): void;
  /** Terrain height under a tile position. */
  ground(x: number, z: number): number;
  /** Where the camera looks (tile units) and how far away it is. */
  focus(): { x: number; z: number; dist: number };
  /** Height of the finished model of a megaproject archetype. */
  finishedHeight(arch: number): number;
  startCinematic(target: MegaTarget): void;
  /** A quick, skippable swoop in to a footprint and back (the first finished building). Absent in tests and when a camera move is already playing. */
  swoop?(target: MegaTarget): void;
}

/** A cheap cheer over the middle of the view: a few confetti fountains, `scale` 1 for a directive, less for a reward. */
function cheer(d: CelebrateDeps, kind: 'confetti' | 'spark', sources: number, each: number): void {
  const f = d.focus(), spread = Math.max(1.5, f.dist * 0.12), size = Math.max(1, f.dist * 0.04), energy = 1 + f.dist * 0.02;
  for (let i = 0; i < sources; i++) {
    const a = (i / sources) * Math.PI * 2, x = f.x + Math.cos(a) * spread, z = f.z + Math.sin(a) * spread;
    d.emit(kind, x, d.ground(x, z) + f.dist * 0.08, z, each, size, energy);
  }
}

/** Sparks and dust around a footprint edge: a stage finished. */
function stageBurst(d: CelebrateDeps, x: number, y: number, w: number, h: number, scale: number): void {
  const cx = x + w / 2, cz = y + h / 2, r = Math.max(w, h) / 2;
  const n = 12;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, px = cx + Math.cos(a) * r, pz = cz + Math.sin(a) * r;
    d.emit('spark', px, d.ground(px, pz) + 0.3, pz, Math.round(8 * scale), 2.4 * scale, 2.2);
    if (i % 3 === 0) d.emit('dust', px, d.ground(px, pz) + 0.1, pz, 6, 3, 1.6);
  }
}

export function celebrate(events: readonly CelebrationEvent[], d: CelebrateDeps): void {
  for (const e of events) {
    switch (e.type) {
      case 'megaStage': stageBurst(d, e.x, e.y, e.w, e.h, 1); break;
      case 'megaComplete': {
        const cx = e.x + e.w / 2, cz = e.y + e.h / 2, g = d.ground(cx, cz), height = d.finishedHeight(e.arch);
        stageBurst(d, e.x, e.y, e.w, e.h, 2);
        d.emit('spark', cx, g + Math.min(height, 14) * 0.5, cz, 160, 3, 5);
        d.emit('confetti', cx, g + Math.min(height, 14), cz, 140, 3, 3);
        d.startCinematic({ x: cx, z: cz, ground: g, height, size: Math.max(e.w, e.h) });
        break;
      }
      case 'milestone': {
        const f = d.focus(), spread = Math.max(2, f.dist * 0.22), size = Math.max(1, f.dist * 0.045), energy = 1 + f.dist * 0.025;
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2, x = f.x + Math.cos(a) * spread, z = f.z + Math.sin(a) * spread;
          d.emit('confetti', x, d.ground(x, z) + f.dist * 0.12, z, 28, size, energy);
        }
        break;
      }
      case 'directiveReady': cheer(d, 'confetti', 4, 20); break;
      case 'directiveClaimed': cheer(d, 'spark', 3, 14); break;
      case 'firstBuilding': {
        const cx = e.x + e.w / 2, cz = e.y + e.h / 2, g = d.ground(cx, cz);
        stageBurst(d, e.x, e.y, e.w, e.h, 1);
        d.emit('confetti', cx, g + 1.2, cz, 60, 1.4, 2.4);
        d.swoop?.({ x: cx, z: cz, ground: g, height: 2, size: Math.max(e.w, e.h) });
        break;
      }
      case 'victory': {
        const f = d.focus();
        for (let i = 0; i < 10; i++) {
          const a = (i / 10) * Math.PI * 2, x = f.x + Math.cos(a) * f.dist * 0.3, z = f.z + Math.sin(a) * f.dist * 0.3;
          d.emit('confetti', x, d.ground(x, z) + f.dist * 0.15, z, 30, Math.max(1, f.dist * 0.05), 1 + f.dist * 0.03);
        }
        break;
      }
    }
  }
}
