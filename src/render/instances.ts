// Turns the mirror's building table into packed instance data. Only dirty slots are rewritten (plus slots whose near/far
// class flips when the fine-detail set moves). Pure of three: buildings.ts uploads what these packers hold.
import { BFLAG, isRci } from '../sim/catalog.ts';
import { BMAX, ROAD } from '../sim/layers.ts';
import { chunkIdx } from '../sim/tiles.ts';
import { builtFraction, craneScale, craneVisible, scaffoldLifts, stageOf } from './kit/construction.ts';
import { generate, variantOf, type KitModel } from './kit/generate.ts';
import { hash32 } from './kit/geo.ts';
import { InstancePacker, MATRIX_STRIDE } from './instancePacker.ts';
import type { RenderMirror } from './mirror.ts';

export interface FineSet {
  has(chunk: number): boolean;
  /** Changes whenever the set of fine chunks changes. */
  version(): number;
}

export interface InstanceDeps {
  mirror: RenderMirror;
  fine: FineSet;
  /** Ground height under a footprint centre (tile units). */
  ground(x: number, z: number): number;
  /** Active variants per archetype (tier dependent). */
  variants(): number;
  getModel?(arch: number, variant: number): KitModel;
}

export interface InstanceStats { near: number; far: number; sites: number; cranes: number }

/** A continuous particle source anchored to a building: stack smoke on finished industry, dust on a building site. */
export interface EmitterRec { kind: 'smoke' | 'dust'; x: number; y: number; z: number; rate: number }

const SMOKE_RATE = 2.4;
const DUST_RATE_PER_TILE = 1.6;

const modelCache = new Map<string, KitModel>();
export function cachedModel(arch: number, variant: number): KitModel {
  const k = `${arch}:${variant}`;
  let m = modelCache.get(k);
  if (!m) { m = generate(arch, variant); modelCache.set(k, m); }
  return m;
}

/** Column-major 4x4: translate, rotate about Y by `rot` (front +z -> (sin, cos)), then scale. */
export function composeMatrix(out: Float32Array | number[], tx: number, ty: number, tz: number, rot: number, sx = 1, sy = 1, sz = 1): void {
  const c = Math.cos(rot), s = Math.sin(rot);
  out[0] = sx * c; out[1] = 0; out[2] = -sx * s; out[3] = 0;
  out[4] = 0; out[5] = sy; out[6] = 0; out[7] = 0;
  out[8] = sz * s; out[9] = 0; out[10] = sz * c; out[11] = 0;
  out[12] = tx; out[13] = ty; out[14] = tz; out[15] = 1;
}

/** Progress 0..1 of a building: complete unless the CONSTRUCTING flag is set. */
export const progressOf = (flags: number, prog: number): number => ((flags & BFLAG.CONSTRUCTING) !== 0 ? Math.min(0.999, prog / 255) : 1);

/**
 * Rotation (about Y) that turns a model's +z front toward the nearest road. Scans up to three tiles out from each side;
 * ties go south, east, north, west.
 */
export function facingRot(mirror: RenderMirror, x: number, y: number, w: number, h: number): number {
  const road = mirror.layers.road!;
  const hasRoad = (tx: number, ty: number): boolean => tx >= 0 && ty >= 0 && tx < 256 && ty < 256 && (road[ty * 256 + tx]! & ROAD.CLASS_MASK) !== 0;
  const dist = (side: number): number => {
    for (let d = 1; d <= 3; d++) {
      for (let k = 0; k < (side === 0 || side === 2 ? w : h); k++) {
        const tx = side === 0 ? x + k : side === 1 ? x + w - 1 + d : side === 2 ? x + k : x - d;
        const ty = side === 0 ? y + h - 1 + d : side === 1 ? y + k : side === 2 ? y - d : y + k;
        if (hasRoad(tx, ty)) return d;
      }
    }
    return 99;
  };
  // sides: 0 south (+z), 1 east (+x), 2 north (-z), 3 west (-x); rotation = side * 90 degrees.
  let best = 0, bestD = 99;
  for (let s = 0; s < 4; s++) { const d = dist(s); if (d < bestD) { bestD = d; best = s; } }
  return best * (Math.PI / 2);
}

const TINT_VAR = 0.1;

export class BuildingInstances {
  readonly near = new InstancePacker();
  readonly far = new InstancePacker();
  readonly site = new InstancePacker();
  readonly crane = new InstancePacker();
  /** Particle sources per building slot, rebuilt whenever the slot is written. */
  readonly emitters = new Map<number, EmitterRec[]>();
  private pending = new Set<number>();
  private cls = new Map<number, 0 | 1>();
  private fineVersion = -1;
  private variantCount = -1;
  private readonly model: (arch: number, variant: number) => KitModel;
  /** Slots written in the last sync, for tests and stats. */
  lastWritten: number[] = [];

  constructor(private readonly d: InstanceDeps) {
    this.model = d.getModel ?? cachedModel;
  }

  get stats(): InstanceStats {
    return { near: this.near.total, far: this.far.total, sites: this.site.total, cranes: this.crane.total };
  }

  private occupied(): number[] {
    const a = this.d.mirror.table.bArch, out: number[] = [];
    for (let s = 0; s < BMAX; s++) if (a[s]) out.push(s);
    return out;
  }

  private classify(slot: number): 0 | 1 {
    const t = this.d.mirror.table;
    return this.d.fine.has(chunkIdx(t.bX[slot]!, t.bY[slot]!)) ? 0 : 1;
  }

  /**
   * Queue every building for a rewrite (variant count change). Existing instances stay in their old batches, so they keep
   * drawing until the rewrite replaces them, within the sync budget: no empty frame while variants swap.
   */
  requeueAll(): void {
    for (const s of this.occupied()) this.pending.add(s);
  }

  /** Process dirty slots, stopping once `budgetMs` elapsed. Returns the number of slots still pending. */
  sync(budgetMs = Infinity): number {
    const variants = this.d.variants();
    if (variants !== this.variantCount) { this.variantCount = variants; this.requeueAll(); }
    for (const s of this.d.mirror.takeDirtyBuildings()) this.pending.add(s);
    const fv = this.d.fine.version();
    if (fv !== this.fineVersion) {
      this.fineVersion = fv;
      for (const s of this.occupied()) if (this.cls.get(s) !== this.classify(s)) this.pending.add(s);
    }
    this.lastWritten = [];
    const t0 = performance.now();
    for (const s of [...this.pending].sort((a, b) => a - b)) {
      if (performance.now() - t0 > budgetMs) break;
      this.pending.delete(s);
      this.write(s);
      this.lastWritten.push(s);
    }
    return this.pending.size;
  }

  private removeAll(slot: number): void {
    this.near.remove(slot); this.far.remove(slot); this.site.remove(slot); this.crane.remove(slot);
    this.cls.delete(slot);
    this.emitters.delete(slot);
  }

  private write(slot: number): void {
    const m = this.d.mirror, b = m.building(slot);
    if (!b) { this.removeAll(slot); return; }
    const variants = this.variantCount;
    const variant = variantOf(b.arch, b.x, b.y, variants);
    const model = this.model(b.arch, variant);
    const p = progressOf(b.flags, b.prog);
    const cx = b.x + b.w / 2, cz = b.y + b.h / 2;
    const gy = this.d.ground(cx, cz);
    // A player-placed service keeps the rotation the player chose (the ghost shows it); grown RCI buildings face the road.
    const rot = isRci(b.arch) ? facingRot(m, b.x, b.y, b.w, b.h) : b.rot * (Math.PI / 2);
    const hsh = hash32(b.x, b.y, b.arch);
    const lit = (hsh & 1023) / 1023;
    const v = 1 + ((((hsh >>> 10) & 255) / 255) - 0.5) * 2 * TINT_VAR;
    const near = this.classify(slot) === 0;
    this.cls.set(slot, near ? 0 : 1);
    const mat = new Float32Array(MATRIX_STRIDE);

    const recs: EmitterRec[] = [];
    if (p >= 1) {
      const c = Math.cos(rot), s = Math.sin(rot);
      for (const [lx, ly, lz] of model.smoke) recs.push({ kind: 'smoke', x: cx + c * lx + s * lz, y: gy + ly, z: cz - s * lx + c * lz, rate: SMOKE_RATE });
    } else if (stageOf(p) !== 'complete') {
      recs.push({ kind: 'dust', x: cx, y: gy + 0.05, z: cz, rate: DUST_RATE_PER_TILE * Math.max(1, b.w * b.h) * (p > 0.04 ? 1 : 0.5) });
    }
    if (recs.length > 0) this.emitters.set(slot, recs); else this.emitters.delete(slot);

    if (near) {
      composeMatrix(mat, cx, gy, cz, rot);
      this.near.set(slot, `${b.arch}:${variant}`, { matrix: mat, tint: [v, v, v], state: [p, lit, model.height, 0] });
      this.far.remove(slot);
    } else {
      const hh = Math.max(0.12, model.bodyHeight * Math.max(0.05, p >= 1 ? 1 : builtFraction(p)));
      const s = model.footprint * 0.9;
      composeMatrix(mat, cx, gy, cz, rot, s, hh, s);
      const w = model.wallColor, r = model.roofColor;
      this.far.set(slot, 'far', { matrix: mat, tint: [w[0] * v, w[1] * v, w[2] * v], state: [r[0], r[1], r[2], 0] });
      this.near.remove(slot);
    }

    if (stageOf(p) !== 'complete' && near) {
      const lifts = scaffoldLifts(model.height);
      const sm = new Float32Array(MATRIX_STRIDE);
      composeMatrix(sm, cx, gy, cz, rot);
      this.site.set(slot, `${b.w}:${lifts}`, { matrix: sm, tint: [1, 1, 1], state: [p, 0, model.height, lifts * 0.3] });
    } else this.site.remove(slot);

    if (craneVisible(p) && near && model.height > 0.5) {
      const cm = new Float32Array(MATRIX_STRIDE);
      const sc = craneScale(model.height);
      const ang = ((hsh >>> 18) & 1023) / 1023 * Math.PI * 2;
      // Mast at the back-right corner of the footprint (model +z is the street side), inside the site fence.
      const inset = 0.15 + 0.16 * sc;
      const lx = b.w / 2 - inset, lz = -(b.h / 2 - inset);
      const c = Math.cos(rot), s = Math.sin(rot);
      composeMatrix(cm, cx + lx * c + lz * s, gy, cz - lx * s + lz * c, ang, sc, sc, sc);
      this.crane.set(slot, 'crane', { matrix: cm, tint: [1, 1, 1], state: [1, 0, 0, 0] });
    } else this.crane.remove(slot);
  }
}
