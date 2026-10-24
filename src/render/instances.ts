// Turns the mirror's building table into packed instance data. Only dirty slots are rewritten (plus slots whose near/far
// class flips when the fine-detail set moves). Pure of three: buildings.ts uploads what these packers hold.
import { BFLAG, isRci } from '../sim/catalog.ts';
import { STYLES } from '../sim/districtTables.ts';
import { BMAX, ROAD } from '../sim/layers.ts';
import { chunkIdx } from '../sim/tiles.ts';
import { isMega, megaStages } from '../sim/megaprojects.ts';
import { FINISH, FOUNDATION_END, builtFraction, craneScale, craneVisible, scaffoldLifts, stageOf } from './kit/construction.ts';
import { generate, variantOf, type KitModel } from './kit/generate.ts';
import { hash32 } from './kit/geo.ts';
import { InstancePacker, MATRIX_STRIDE } from './instancePacker.ts';
import type { RenderMirror } from './mirror.ts';
import type { BuildingRec } from '../sim/protocol.ts';

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
export interface EmitterRec { kind: 'smoke' | 'dust' | 'debris' | 'fire' | 'spark'; x: number; y: number; z: number; rate: number }

/**
 * Where a building's status icon floats (tile units, above the roof) and the ground under it. Every standing building has one, whether
 * or not it shows an icon: render/statusIcons.ts picks which buildings need one, and tapping uses it to find a building by its roof.
 */
export interface IconAnchor { x: number; y: number; z: number; gy: number }
/** How far above the model's highest point the status icon floats. */
const ICON_LIFT = 0.3;

/** Virtual packer slots for the extra cranes of a megaproject (above every real building slot). */
export const MEGA_CRANES = 3;
export const extraCrane = (slot: number, i: number): number => BMAX + slot * MEGA_CRANES + i;
/** Dust rate ceiling for a megaproject site, and the tallest the outage icon floats over one (the Space Elevator's tether is far taller). */
const DUST_CAP = 36;
const MEGA_ICON_MAX = 6;

const SMOKE_RATE = 2.4;
const DEBRIS_RATE_PER_TILE = 1.1;
const DUST_RATE_PER_TILE = 1.6;
const FLAME_RATE = 7;
const FIRE_SMOKE_RATE = 5;
const EMBER_RATE = 2.2;
const RUIN_SMOKE_RATE = 0.7;
/** How dark a fully damaged building gets: tint is scaled by 1 - CHAR_DARKEN * damage^CHAR_CURVE. */
const CHAR_DARKEN = 0.8;
const CHAR_CURVE = 0.7;
/** iState.w: 0 normal, 1 unpowered, 2 on fire (flickering glow in the building material). */
const STATE_DARK = 1;
const STATE_BURNING = 2;

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
const NO_STYLE = [1, 1, 1] as const;

export class BuildingInstances {
  readonly near = new InstancePacker();
  readonly far = new InstancePacker();
  readonly site = new InstancePacker();
  readonly crane = new InstancePacker();
  /** Ruins of destroyed buildings, drawn instead of the building (shrinking while the robots clear them). */
  readonly rubble = new InstancePacker();
  /** Particle sources per building slot, rebuilt whenever the slot is written. */
  readonly emitters = new Map<number, EmitterRec[]>();
  /** Icon anchor of every standing building (not ruins), rebuilt whenever the slot is written; `anchorVersion` bumps on any change. */
  readonly anchors = new Map<number, IconAnchor>();
  anchorVersion = 0;
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
    // A megaproject is a landmark: it always draws as its full model, never as a far-LOD box.
    if (isMega(t.bArch[slot]!)) return 0;
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
    this.near.remove(slot); this.far.remove(slot); this.site.remove(slot); this.crane.remove(slot); this.rubble.remove(slot);
    for (let i = 0; i < MEGA_CRANES; i++) this.crane.remove(extraCrane(slot, i));
    this.cls.delete(slot);
    this.emitters.delete(slot);
    if (this.anchors.delete(slot)) this.anchorVersion++;
  }

  /** A destroyed building: rubble instead of the model. While robots clear it the heap shrinks with the demolition progress. */
  private writeRuin(slot: number, b: BuildingRec, gy: number, hsh: number, p: number, mat: Float32Array): void {
    const cx = b.x + b.w / 2, cz = b.y + b.h / 2;
    const clearing = (b.flags & BFLAG.DEMOLISHING) !== 0;
    composeMatrix(mat, cx, gy, cz, ((hsh >>> 20) & 3) * (Math.PI / 2), 1, clearing ? Math.max(0.06, p) : 1, 1);
    this.rubble.set(slot, `${Math.max(b.w, b.h)}:${(hsh >>> 4) & 3}`, { matrix: mat, tint: [1, 1, 1], state: [1, 0, 0, 0] });
    this.near.remove(slot); this.far.remove(slot); this.site.remove(slot); this.crane.remove(slot);
    for (let i = 0; i < MEGA_CRANES; i++) this.crane.remove(extraCrane(slot, i));
    if (this.anchors.delete(slot)) this.anchorVersion++;
    const area = Math.max(1, b.w * b.h);
    this.emitters.set(slot, [clearing
      ? { kind: 'dust', x: cx, y: gy + 0.05, z: cz, rate: DUST_RATE_PER_TILE * area * 0.6 }
      : { kind: 'smoke', x: cx, y: gy + 0.12, z: cz, rate: RUIN_SMOKE_RATE }]);
  }

  private write(slot: number): void {
    const m = this.d.mirror, b = m.building(slot);
    if (!b) { this.removeAll(slot); return; }
    const variants = this.variantCount;
    // A megaproject's variant is its stage model: the stage under construction, or the finished model once every stage is done.
    const mega = isMega(b.arch);
    const building = (b.flags & BFLAG.CONSTRUCTING) !== 0;
    const stages = megaStages(b.arch);
    const stage = mega ? (building ? Math.min(b.level, stages - 1) : stages) : 0;
    const variant = mega ? stage : variantOf(b.arch, b.x, b.y, variants);
    const model = this.model(b.arch, variant);
    let p = progressOf(b.flags, b.prog);
    if (mega && building) {
      // The construction clip reveals this stage's new geometry from the previous stage's top up to its own as the pass progresses.
      const base = stage > 0 ? this.model(b.arch, stage - 1).height : 0;
      const sp = Math.min(0.999, b.prog / 255);
      const f = Math.min(0.999, (base + (model.height - base) * sp) / Math.max(model.height, 1e-3));
      p = FOUNDATION_END + (FINISH - FOUNDATION_END) * f;
    }
    const cx = b.x + b.w / 2, cz = b.y + b.h / 2;
    const gy = this.d.ground(cx, cz);
    // A player-placed service keeps the rotation the player chose (the ghost shows it); grown RCI buildings face the road.
    const rot = isRci(b.arch) ? facingRot(m, b.x, b.y, b.w, b.h) : b.rot * (Math.PI / 2);
    const hsh = hash32(b.x, b.y, b.arch);
    const lit = (hsh & 1023) / 1023;
    const v = 1 + ((((hsh >>> 10) & 255) / 255) - 0.5) * 2 * TINT_VAR;
    const near = this.classify(slot) === 0;
    this.cls.set(slot, near ? 0 : 1);
    // A district's style colours the walls and roofs of every building inside it (and lights their trim), multiplying the per-building variation.
    const style = m.buildingStyle(b.x, b.y, b.w, b.h);
    const [dr, dg, db] = style >= 0 ? STYLES[style]!.tint : NO_STYLE;
    const mat = new Float32Array(MATRIX_STRIDE);

    if ((b.flags & BFLAG.RUBBLE) !== 0) { this.writeRuin(slot, b, gy, hsh, p, mat); return; }
    this.rubble.remove(slot);
    const burning = p >= 1 && (b.flags & BFLAG.BURNING) !== 0;
    const char = 1 - CHAR_DARKEN * Math.pow(Math.min(1, b.dmg / 255), CHAR_CURVE);

    const recs: EmitterRec[] = [];
    if (burning) {
      const area = Math.max(1, b.w * b.h), live = 1 - 0.5 * (1 - char) / CHAR_DARKEN;
      for (let i = 0; i < 3; i++) {
        const ox = (((hsh >>> (3 * i)) & 7) / 7 - 0.5) * 0.6 * b.w, oz = (((hsh >>> (3 * i + 9)) & 7) / 7 - 0.5) * 0.6 * b.h;
        recs.push({ kind: 'fire', x: cx + ox, y: gy + model.height * (0.3 + 0.14 * i), z: cz + oz, rate: FLAME_RATE * Math.sqrt(area) * live });
      }
      recs.push({ kind: 'smoke', x: cx, y: gy + model.height * 0.85, z: cz, rate: FIRE_SMOKE_RATE + 2 * area });
      recs.push({ kind: 'spark', x: cx, y: gy + model.height * 0.7, z: cz, rate: EMBER_RATE });
    }
    if (p >= 1) {
      const c = Math.cos(rot), s = Math.sin(rot);
      for (const [lx, ly, lz] of model.smoke) recs.push({ kind: 'smoke', x: cx + c * lx + s * lz, y: gy + ly, z: cz - s * lx + c * lz, rate: SMOKE_RATE });
    } else if (stageOf(p) !== 'complete') {
      recs.push({ kind: 'dust', x: cx, y: gy + 0.05, z: cz, rate: Math.min(DUST_CAP, DUST_RATE_PER_TILE * Math.max(1, b.w * b.h)) * (p > 0.04 ? 1 : 0.5) });
      // Robots tearing a building down throw debris from its roofline as it shrinks.
      if ((b.flags & BFLAG.DEMOLISHING) !== 0) recs.push({ kind: 'debris', x: cx, y: gy + 0.1 + model.height * builtFraction(p) * 0.8, z: cz, rate: DEBRIS_RATE_PER_TILE * Math.max(1, b.w * b.h) });
    }
    if (recs.length > 0) this.emitters.set(slot, recs); else this.emitters.delete(slot);

    // A finished building without power goes dark (state.w); one still being built does not.
    const dark = p >= 1 && (b.flags & BFLAG.UNPOWERED) !== 0;
    const top = gy + (mega ? Math.min(model.height, MEGA_ICON_MAX) : model.height) + ICON_LIFT;
    const had = this.anchors.get(slot);
    if (!had || had.x !== cx || had.y !== top || had.z !== cz || had.gy !== gy) {
      this.anchors.set(slot, { x: cx, y: top, z: cz, gy });
      this.anchorVersion++;
    }

    if (near) {
      composeMatrix(mat, cx, gy, cz, rot);
      const vc = v * char;
      this.near.set(slot, `${b.arch}:${variant}`, { matrix: mat, tint: [vc * dr, vc * dg, vc * db], state: [p, lit, model.height, burning ? STATE_BURNING : dark ? STATE_DARK : 0] });
      this.far.remove(slot);
    } else {
      const hh = Math.max(0.12, model.bodyHeight * Math.max(0.05, p >= 1 ? 1 : builtFraction(p)));
      const s = model.footprint * 0.9;
      composeMatrix(mat, cx, gy, cz, rot, s, hh, s);
      const w = model.wallColor, r = model.roofColor;
      this.far.set(slot, 'far', { matrix: mat, tint: [w[0] * v * char * dr, w[1] * v * char * dg, w[2] * v * char * db], state: [r[0] * char * dr, r[1] * char * dg, r[2] * char * db, 0] });
      this.near.remove(slot);
    }

    if (stageOf(p) !== 'complete' && near) {
      const lifts = scaffoldLifts(model.height);
      const sm = new Float32Array(MATRIX_STRIDE);
      composeMatrix(sm, cx, gy, cz, rot);
      this.site.set(slot, `${b.w}:${lifts}`, { matrix: sm, tint: [1, 1, 1], state: [p, 0, model.height, lifts * 0.3] });
    } else this.site.remove(slot);

    // Extra tower cranes at the other corners of a megaproject site: one per corner beyond the standard back-right one.
    for (let i = 0; i < MEGA_CRANES; i++) {
      const key = extraCrane(slot, i);
      if (mega && building) {
        const sc = craneScale(Math.min(model.height, 12));
        const cm = new Float32Array(MATRIX_STRIDE);
        const inset = 0.45 + 0.16 * sc, corner = i + 1;
        const lx = (corner & 1 ? -1 : 1) * (b.w / 2 - inset), lz = (corner & 2 ? 1 : -1) * (b.h / 2 - inset);
        const c = Math.cos(rot), s = Math.sin(rot);
        composeMatrix(cm, cx + lx * c + lz * s, gy, cz - lx * s + lz * c, ((hsh >>> (8 + i * 5)) & 1023) / 1023 * Math.PI * 2, sc, sc, sc);
        this.crane.set(key, 'crane', { matrix: cm, tint: [1, 1, 1], state: [1, 0, 0, 0] });
      } else this.crane.remove(key);
    }
    if ((mega ? building : craneVisible(p)) && near && model.height > 0.5) {
      const cm = new Float32Array(MATRIX_STRIDE);
      const sc = craneScale(mega ? Math.min(model.height, 12) : model.height);
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
