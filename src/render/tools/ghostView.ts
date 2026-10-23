import {
  BufferAttribute, BufferGeometry, DoubleSide, DynamicDrawUsage, Group, Mesh, MeshBasicNodeMaterial, Vector4,
} from 'three/webgpu';
import { mix, normalWorld, uniform, vec4, vertexColor } from 'three/tsl';
import { archetype } from '../../sim/catalog.ts';
import { footprintOf } from '../../sim/estimate.ts';
import { MAP } from '../../sim/layers.ts';
import { surfaceHeight, type HeightLayer } from '../heightfield.ts';
import { cachedModel } from '../instances.ts';
import { mergeParts } from '../kit/generate.ts';
import type { ToolController } from './controller.ts';
import { MAX_GHOST_TILES, overlayIndices, writeTileQuad } from './ghostGeometry.ts';
import { ghostTints } from './toolSpec.ts';

function overlayGeometry(): BufferGeometry {
  const g = new BufferGeometry();
  const p = new BufferAttribute(new Float32Array(MAX_GHOST_TILES * 4 * 3), 3), cl = new BufferAttribute(new Float32Array(MAX_GHOST_TILES * 4 * 4), 4);
  p.setUsage(DynamicDrawUsage); cl.setUsage(DynamicDrawUsage);
  g.setAttribute('position', p);
  g.setAttribute('color', cl);
  g.setIndex(new BufferAttribute(overlayIndices(), 1));
  g.setDrawRange(0, 0);
  return g;
}

/**
 * The build ghost: a translucent tile overlay (green valid, red invalid, grey no-op) hugging the heightfield, plus for building
 * placement a translucent copy of the kit model on the footprint. It only reads the controller and the mirror height grid.
 */
export class GhostView {
  readonly group = new Group();
  private readonly overlay: Mesh;
  private readonly overlayMat = new MeshBasicNodeMaterial();
  private readonly model: Mesh;
  private readonly modelMat = new MeshBasicNodeMaterial();
  private readonly modelTint = uniform(new Vector4(0.2, 0.85, 0.35, 1));
  private readonly modelGeometry = new Map<number, BufferGeometry>();
  private lastVersion = -1;
  /** Tiles painted in the last update, for tests and stats. */
  painted = 0;

  constructor(private readonly heights: HeightLayer) {
    this.group.name = 'ghost';
    this.overlayMat.colorNode = vertexColor();
    this.overlayMat.transparent = true;
    this.overlayMat.depthWrite = false;
    this.overlayMat.side = DoubleSide;
    this.overlayMat.polygonOffset = true;
    this.overlayMat.polygonOffsetFactor = -3;
    this.overlayMat.polygonOffsetUnits = -3;
    this.overlay = new Mesh(overlayGeometry(), this.overlayMat);
    this.overlay.frustumCulled = false;
    this.overlay.renderOrder = 20;
    this.overlay.visible = false;

    const shade = normalWorld.y.mul(0.3).add(0.7);
    this.modelMat.colorNode = vec4(mix(vertexColor().rgb, this.modelTint.rgb, 0.4).mul(shade), 0.62);
    this.modelMat.transparent = true;
    this.modelMat.depthWrite = false;
    this.model = new Mesh(undefined, this.modelMat);
    this.model.frustumCulled = false;
    this.model.renderOrder = 21;
    this.model.visible = false;
    this.group.add(this.overlay, this.model);
  }

  private geometryFor(arch: number): BufferGeometry {
    let g = this.modelGeometry.get(arch);
    if (!g) {
      const m = mergeParts(cachedModel(arch, 0).parts);
      g = new BufferGeometry();
      const n = m.ao.length, color = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) { color[i * 4] = m.colors[i * 3]!; color[i * 4 + 1] = m.colors[i * 3 + 1]!; color[i * 4 + 2] = m.colors[i * 3 + 2]!; color[i * 4 + 3] = m.ao[i]!; }
      g.setAttribute('position', new BufferAttribute(m.positions, 3));
      g.setAttribute('normal', new BufferAttribute(m.normals, 3));
      g.setAttribute('color', new BufferAttribute(color, 4));
      g.setIndex(new BufferAttribute(m.indices, 1));
      this.modelGeometry.set(arch, g);
    }
    return g;
  }

  /** Call once per frame; does nothing unless the controller changed. */
  update(c: ToolController): void {
    if (c.version === this.lastVersion) return;
    this.lastVersion = c.version;
    const plan = c.plan;
    if (!plan || !c.sel) { this.overlay.visible = false; this.model.visible = false; this.painted = 0; return; }

    const tints = ghostTints(plan.est);
    const geo = this.overlay.geometry;
    const pos = geo.getAttribute('position') as BufferAttribute, col = geo.getAttribute('color') as BufferAttribute;
    let n = 0;
    for (const [list, tint] of [[plan.est.validTiles, tints.valid], [plan.est.invalidTiles, tints.invalid]] as const) {
      for (const i of list) {
        if (n >= MAX_GHOST_TILES) break;
        writeTileQuad(pos.array as Float32Array, col.array as Float32Array, n++, i % MAP, (i / MAP) | 0, this.heights, tint);
      }
    }
    this.painted = n;
    pos.needsUpdate = true; col.needsUpdate = true;
    geo.setDrawRange(0, n * 6);
    this.overlay.visible = n > 0;

    const cmd = plan.cmd;
    const a = cmd.type === 'placeBuilding' ? archetype(cmd.arch) : undefined;
    if (cmd.type !== 'placeBuilding' || !a) { this.model.visible = false; return; }
    const { w, h } = footprintOf(a, cmd.rot);
    const cx = cmd.x + w / 2, cz = cmd.y + h / 2;
    const gy = surfaceHeight(this.heights, cx, cz);
    this.model.geometry = this.geometryFor(cmd.arch);
    this.model.position.set(cx, gy, cz);
    this.model.rotation.y = cmd.rot * (Math.PI / 2);
    const t = plan.est.reason ? tints.invalid : tints.valid;
    this.modelTint.value.set(t[0], t[1], t[2], 1);
    this.model.visible = true;
  }

  dispose(): void {
    this.overlay.geometry.dispose();
    this.overlayMat.dispose();
    for (const g of this.modelGeometry.values()) g.dispose();
    this.modelGeometry.clear();
    this.modelMat.dispose();
  }
}
