// Water: one node material for the map's water meshes and an ocean ring that runs to the horizon.
//
//   waves      Gerstner sum in the vertex stage (mid and up; low scrolls normal maps only), plus a scrolling procedural
//              normal map at every tier. Normals are analytic per pixel.
//   colour     shallow turquoise to deep blue from the per-tile water depth, baked into a 256x256 RGBA8 info texture
//              together with the distance-to-shore field (computed on the CPU from the terrain layers on change).
//   foam       bands that follow the shore field, plus faint crest foam.
//   reflection low/mid: the sky function reflected about the wave normal.  high: reflector() planar reflection at 0.3 scale
//              (chosen over SSR: SSR cannot see the sky or anything off screen, which is most of what water shows).
//              ultra: 0.5 scale plus refraction distortion of the opaque scene behind the surface.
//   sun glint  falls out of the PBR specular of the key light through the wave normals.
import {
  BufferAttribute, BufferGeometry, DataTexture, DoubleSide, Group, LinearFilter, LinearMipmapLinearFilter, Mesh, MeshStandardNodeMaterial,
  RGBAFormat, RepeatWrapping, UnsignedByteType, type Node, type Scene,
} from 'three/webgpu';
import {
  abs, cameraPosition, clamp, cos, dot, exp, float, max, mix, normalize, positionLocal, positionWorld, pow, reflect, reflector, screenUV, sin,
  smoothstep, step, texture, time, transformNormalToView, vec2, vec3, vertexColor, viewportOpaqueMipTexture,
} from 'three/tsl';
import { CHUNK, CHUNKS, MAP } from '../../sim/layers.ts';
import { cornerHeight } from '../heightfield.ts';
import { withNeighbours } from '../terrainMesh.ts';
import type { RenderMirror } from '../mirror.ts';
import type { TierSpec } from '../tier.ts';
import { skyGradient } from './skyNode.ts';
import { WATER_RANGE, packWaterInfo, packWaterInfoRegion } from './shore.ts';
import { gerstnerWaves } from './waves.ts';

// TSL node graphs are built dynamically; the published typings reject most mixed-type chains, so graph code is loosely typed.
type N = any;

const PACK_INTERVAL_MS = 500;
/** Past this many dirty chunks (a resync) one full pack is cheaper than per-chunk regions. */
const FULL_REPACK_CHUNKS = 64;
const OCEAN_DEPTH = 8;
const SEA_LEVEL = 0;
const WALL_BOTTOM = -7;
const RING_OFFSETS = [0, 5, 20, 80, 320, 2600];

function waterNormalMap(size = 128): DataTexture {
  const h = new Float32Array(size * size);
  const comps: { kx: number; ky: number; a: number; p: number }[] = [];
  let s = 90210;
  const rnd = (): number => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  // Wave vectors avoid the lowest harmonics (they read as one repeating blob per texture tile) and weigh the rest evenly.
  for (let i = 0; i < 30; i++) {
    const kx = Math.round((rnd() - 0.5) * 2 * 14), ky = Math.round((rnd() - 0.5) * 2 * 14);
    const f = Math.hypot(kx, ky);
    if (f < 4 || f > 15) continue;
    comps.push({ kx, ky, a: 1 / Math.pow(f, 0.55), p: rnd() * Math.PI * 2 });
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0;
      for (const c of comps) v += c.a * Math.sin(((c.kx * x + c.ky * y) / size) * Math.PI * 2 + c.p);
      h[y * size + x] = v;
    }
  }
  const data = new Uint8Array(size * size * 4);
  const at = (x: number, y: number): number => h[((y + size) % size) * size + ((x + size) % size)]!;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 0.9, dy = (at(x, y + 1) - at(x, y - 1)) * 0.9;
      const l = Math.hypot(dx, dy, 1);
      const o = (y * size + x) * 4;
      data[o] = Math.round((-dx / l * 0.5 + 0.5) * 255);
      data[o + 1] = Math.round((-dy / l * 0.5 + 0.5) * 255);
      data[o + 2] = Math.round((1 / l * 0.5 + 0.5) * 255);
      data[o + 3] = 255;
    }
  }
  const t = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

/** Concentric rectangles around the map; each loop has 4 * MAP vertices so neighbouring loops stitch without cracks, and the innermost loop lands on the map's own tile corners. */
export function buildOceanRing(): BufferGeometry {
  const per = MAP;
  const loopVerts = per * 4;
  const pos = new Float32Array(RING_OFFSETS.length * loopVerts * 3);
  const idx: number[] = [];
  RING_OFFSETS.forEach((o, li) => {
    const lo = -o, hi = MAP + o;
    for (let k = 0; k < per; k++) {
      const t = k / per;
      const set = (side: number, x: number, z: number): void => {
        const v = (li * loopVerts + side * per + k) * 3;
        pos[v] = x; pos[v + 1] = SEA_LEVEL; pos[v + 2] = z;
      };
      set(0, lo + (hi - lo) * t, lo);
      set(1, hi, lo + (hi - lo) * t);
      set(2, hi - (hi - lo) * t, hi);
      set(3, lo, hi - (hi - lo) * t);
    }
  });
  for (let li = 0; li < RING_OFFSETS.length - 1; li++) {
    const a = li * loopVerts, b = (li + 1) * loopVerts;
    for (let v = 0; v < loopVerts; v++) {
      const n = (v + 1) % loopVerts;
      idx.push(a + v, b + v, a + n, a + n, b + v, b + n);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  const normals = new Float32Array(pos.length);
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
  g.setAttribute('normal', new BufferAttribute(normals, 3));
  // The water material fades alpha with the red channel (wetness); open ocean is fully wet.
  g.setAttribute('color', new BufferAttribute(new Float32Array(pos.length).fill(1), 3));
  g.setIndex(new BufferAttribute(Uint32Array.from(idx), 1));
  return g;
}

/** A cliff skirt around the map edge so land that meets the border does not hang in the sky above the ocean. */
export function buildEdgeWall(height: ArrayLike<number>): BufferGeometry {
  const pos: number[] = [], idx: number[] = [];
  const OUT = 0.03;
  const addEdge = (pt: (i: number) => [number, number], nx: number, nz: number): void => {
    const base = pos.length / 3;
    for (let i = 0; i <= MAP; i++) {
      const [x, z] = pt(i);
      const top = cornerHeight(height, Math.round(x), Math.round(z));
      pos.push(x + nx * OUT, top, z + nz * OUT, x + nx * OUT, WALL_BOTTOM, z + nz * OUT);
    }
    for (let i = 0; i < MAP; i++) {
      const a = base + i * 2, b = a + 2;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  };
  addEdge((i) => [i, 0], 0, -1);
  addEdge((i) => [i, MAP], 0, 1);
  addEdge((i) => [0, i], -1, 0);
  addEdge((i) => [MAP, i], 1, 0);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(Float32Array.from(pos), 3));
  const colors = new Float32Array((pos.length / 3) * 3);
  for (let v = 0; v < pos.length / 3; v++) {
    const top = v % 2 === 0;
    colors.set(top ? [0.26, 0.21, 0.16] : [0.05, 0.045, 0.04], v * 3);
  }
  g.setAttribute('color', new BufferAttribute(colors, 3));
  g.setIndex(new BufferAttribute(Uint32Array.from(idx), 1));
  g.computeVertexNormals();
  return g;
}

export class WaterSystem {
  readonly material = new MeshStandardNodeMaterial();
  readonly group = new Group();
  readonly info: DataTexture;
  private readonly normals = waterNormalMap();
  private readonly ocean: Mesh;
  private readonly wall: Mesh;
  private readonly wallMat = new MeshStandardNodeMaterial();
  private reflection: ReturnType<typeof reflector> | null = null;
  private seenVersion = -1;
  private readonly pending = new Set<number>();
  private packedAt = -1;
  private tierKey = '';
  mode: TierSpec['water'] = 'flat';
  get planar(): ReturnType<typeof reflector> | null { return this.reflection; }
  gerstnerWaves = 0;

  constructor(private readonly mirror: RenderMirror, private readonly scene: Scene) {
    const data = new Uint8Array(MAP * MAP * 4);
    this.info = new DataTexture(data, MAP, MAP, RGBAFormat, UnsignedByteType);
    this.info.minFilter = LinearFilter;
    this.info.magFilter = LinearFilter;
    this.info.generateMipmaps = false;
    this.info.flipY = false;
    this.info.needsUpdate = true;

    const m = this.material;
    m.transparent = true;
    m.depthWrite = false;
    m.metalness = 0;
    this.ocean = new Mesh(buildOceanRing(), m);
    this.ocean.name = 'ocean';
    this.ocean.frustumCulled = false;
    this.ocean.renderOrder = 2;
    this.wallMat.colorNode = vertexColor();
    this.wallMat.roughness = 0.95;
    this.wallMat.side = DoubleSide;
    this.wall = new Mesh(new BufferGeometry(), this.wallMat);
    this.wall.name = 'edgeWall';
    this.wall.frustumCulled = false;
    this.wall.visible = false;
    this.group.add(this.ocean, this.wall);
    this.group.name = 'water';
  }

  /** Re-pack the info texture and the cliff wall when the mirror's terrain changed. */
  sync(): void {
    if (!this.mirror.hasResync) return;
    if (this.mirror.terrainVersion !== this.seenVersion) {
      this.seenVersion = this.mirror.terrainVersion;
      for (const c of this.mirror.takeTerrainDirty()) this.pending.add(c);
    }
    if (this.pending.size === 0) return;
    // Edits can arrive every tick while terraforming; the texture upload and the wall rebuild wait for at most one per 500 ms.
    const now = performance.now();
    if (this.packedAt >= 0 && now - this.packedAt < PACK_INTERVAL_MS) return;
    this.packedAt = now;
    const L = this.mirror.layers;
    const data = this.info.image.data as Uint8Array;
    const dirty = [...this.pending];
    this.pending.clear();
    // Shore distance reaches up to WATER_RANGE tiles, so a changed chunk also changes its neighbours' texels.
    const region = withNeighbours(dirty, CHUNKS);
    if (region.size >= FULL_REPACK_CHUNKS) packWaterInfo(L.terrain!, L.waterDepth!, MAP, data);
    else {
      for (const c of region) {
        const x0 = (c % CHUNKS) * CHUNK, y0 = Math.floor(c / CHUNKS) * CHUNK;
        packWaterInfoRegion(L.terrain!, L.waterDepth!, MAP, data, x0, y0, x0 + CHUNK, y0 + CHUNK);
      }
    }
    this.info.needsUpdate = true;
    const border = dirty.some((c) => { const cx = c % CHUNKS, cy = Math.floor(c / CHUNKS); return cx === 0 || cy === 0 || cx === CHUNKS - 1 || cy === CHUNKS - 1; });
    if (border || !this.wall.visible) {
      this.wall.geometry.dispose();
      this.wall.geometry = buildEdgeWall(L.height!);
      this.wall.visible = true;
    }
  }

  /** Build (or rebuild in place) the node graph for a tier. The material object stays the same so meshes keep their reference. */
  applyTier(spec: TierSpec): void {
    const key = `${spec.water}|${spec.fx.gerstner}|${spec.fx.reflectionScale}|${spec.fx.foam}`;
    if (key === this.tierKey) return;
    this.tierKey = key;
    const m = this.material;
    const mode = spec.water;
    const waves = spec.fx.gerstner ? gerstnerWaves(mode === 'sky' ? 3 : 4) : [];
    this.mode = mode;
    this.gerstnerWaves = waves.length;

    if (this.reflection) {
      this.scene.remove(this.reflection.target);
      this.reflection.dispose();
      this.reflection = null;
    }
    const planar = spec.fx.reflectionScale > 0;
    if (planar) {
      const r = reflector({ resolutionScale: spec.fx.reflectionScale, bounces: false });
      r.target.rotateX(-Math.PI / 2);
      r.target.position.set(MAP / 2, SEA_LEVEL, MAP / 2);
      this.scene.add(r.target);
      this.reflection = r;
    }

    const infoTex = texture(this.info);
    const detailTex = texture(this.normals);

    // Depth and shore distance at an xz position, continuous across the map border into open ocean.
    const waterAt = (xz: N): { depth: N; shore: N; outside: N; open: N } => {
      const uv = clamp(xz.div(MAP), 0.0005, 0.9995);
      // Four bilinear taps half a texel off the point blend into a tent two tiles wide, so the shore field has no tile-sized
      // ridges between texel centres: foam and bank fades follow smooth curves below one tile.
      const o = 0.5 / MAP;
      const s = infoTex.sample(uv);
      const blurG: N = spec.fx.foam
        ? infoTex.sample(uv.add(vec2(o, o))).g.add(infoTex.sample(uv.add(vec2(-o, o))).g).add(infoTex.sample(uv.add(vec2(o, -o))).g).add(infoTex.sample(uv.add(vec2(-o, -o))).g).mul(0.25)
        : s.g;
      const dx = max(xz.x.negate(), xz.x.sub(MAP)).max(0);
      const dz = max(xz.y.negate(), xz.y.sub(MAP)).max(0);
      const outside = max(dx, dz);
      const ramp = smoothstep(0, 28, outside);
      const depth = mix(s.r.mul(WATER_RANGE), float(OCEAN_DEPTH), ramp).max(mix(float(0), float(3), step(0.5, outside)));
      const shore = mix(max(blurG.mul(WATER_RANGE).sub(0.2), 0), float(WATER_RANGE), ramp);
      const open = mix(s.b, float(1), ramp);
      return { depth, shore, outside, open };
    };

    // ---- vertex stage: Gerstner displacement, damped in shallows and far from the map ----
    if (waves.length > 0) {
      const p = positionLocal;
      const { depth, outside } = waterAt(p.xz);
      const damp = smoothstep(0.05, 1.4, depth).mul(float(1).sub(smoothstep(0, 70, outside)));
      let dy: N = float(0), dxs: N = float(0), dzs: N = float(0);
      for (const w of waves) {
        const th = p.x.mul(w.dx * w.k).add(p.z.mul(w.dz * w.k)).sub(time.mul(w.omega));
        dy = dy.add(sin(th).mul(w.amp));
        const c = cos(th).mul(w.amp * w.steep);
        dxs = dxs.add(c.mul(w.dx));
        dzs = dzs.add(c.mul(w.dz));
      }
      m.positionNode = vec3(p.x.add(dxs.mul(damp)), p.y.add(dy.mul(damp)), p.z.add(dzs.mul(damp)));
    } else m.positionNode = null;

    // ---- fragment stage ----
    const wp = positionWorld;
    const { depth, shore, outside, open } = waterAt(wp.xz);
    const camToFrag = cameraPosition.sub(wp);
    const dist = camToFrag.length();
    const V = normalize(camToFrag);
    // Fewer, softer ripples at grazing angles and far away: that is where a sharp normal field turns to white glitter.
    const grazing = float(0.5).add(V.y.abs().mul(0.5));
    const calm = float(1).sub(smoothstep(140, 800, dist)).mul(grazing);

    // Two layers rotated against each other so the texture's tiling never lines up into a lattice.
    const rot = (p: N, a: number): N => vec2(p.x.mul(Math.cos(a)).sub(p.y.mul(Math.sin(a))), p.x.mul(Math.sin(a)).add(p.y.mul(Math.cos(a))));
    const uv1 = rot(wp.xz, 0.5).mul(0.071).add(vec2(time.mul(0.011), time.mul(0.007)));
    const uv2 = rot(wp.xz, -0.83).mul(0.173).add(vec2(time.mul(-0.009), time.mul(0.013)));
    const d1 = detailTex.sample(uv1).xy.mul(2).sub(1), d2 = detailTex.sample(uv2).xy.mul(2).sub(1);
    const detail = d1.add(d2.mul(0.7)).mul(0.5).mul(calm);

    let gx: N = float(0), gz: N = float(0);
    const fade = float(1).sub(smoothstep(0, 70, outside).mul(0.5));
    for (const w of waves) {
      const th = wp.x.mul(w.dx * w.k).add(wp.z.mul(w.dz * w.k)).sub(time.mul(w.omega));
      const c = cos(th).mul(w.amp * w.k);
      gx = gx.add(c.mul(w.dx));
      gz = gz.add(c.mul(w.dz));
    }
    const sharp = calm.mul(fade).mul(2.4);
    const nW = normalize(vec3(detail.x.mul(0.55).sub(gx.mul(sharp)), float(1), detail.y.mul(0.55).sub(gz.mul(sharp))));
    m.normalNode = transformNormalToView(nW);

    // Rivers are one or two tiles wide: marked 0.5 in the info texture's blue channel (lakes and sea 1). They get a richer body
    // colour and an alpha that fades out before the tile edge, so a narrow river reads as a soft channel, not pale tile-shaped patches.
    // Per-corner wetness from the water mesh (1 on the ocean ring): a smooth curve through the shoreline, finer than a tile.
    const wetMask = smoothstep(0.12, 0.5, vertexColor().r);
    const river = step(open, 0.6);
    const depthMix = float(1).sub(exp(depth.mul(-0.42))).max(river.mul(0.62));
    const shallowC = vec3(0.05, 0.4, 0.62), deepC = vec3(0.01, 0.08, 0.34);
    const waterC = mix(shallowC, deepC, depthMix);

    const F0 = 0.025;
    const fres = float(F0).add(float(1 - F0).mul(pow(float(1).sub(dot(nW, V).max(0)), 5))).mul(0.92).add(0.03);
    const R = reflect(V.negate(), nW);
    const skyRefl = skyGradient(vec3(R.x, R.y.abs(), R.z));
    let reflRGB: N = skyRefl;
    if (this.reflection) {
      const refl = this.reflection;
      const level = float(1).sub(smoothstep(0.15, 0.7, abs(wp.y.sub(SEA_LEVEL))));
      const planarRGB = (refl as N).sample((refl as N).uvNode.add(vec2(nW.x, nW.z).mul(0.045))).rgb;
      reflRGB = mix(skyRefl, planarRGB, level);
    }

    // Shore foam: bands that follow the field, wobbled by the detail noise.
    const wobble = detail.x.add(detail.y).mul(0.5);
    const band = float(0.7).add(wobble.mul(0.4));
    const edge = float(1).sub(smoothstep(0.0, band, shore.add(wobble.mul(0.2))));
    const stripes = sin(shore.mul(9).sub(time.mul(1.3)).add(wobble.mul(5))).mul(0.5).add(0.5);
    const openness = smoothstep(0.4, 0.9, open).mul(0.8).add(0.2);
    const foamShore = edge.mul(mix(float(0.45), float(1), stripes)).mul(openness).mul(float(1).sub(smoothstep(0, 40, outside)));
    const foam = spec.fx.foam ? clamp(foamShore.mul(wetMask), 0, 1) : float(0);

    let base: N = waterC;
    let emissive: N = reflRGB.mul(fres);
    const bankFade = mix(smoothstep(0, 0.5, shore.add(0.12)), float(1), river).mul(wetMask);
    let alpha: N = mix(float(0.62), float(0.97), depthMix).mul(bankFade);
    if (mode === 'refract') {
      const bend = vec2(nW.x, nW.z).mul(0.05).mul(float(1).sub(depthMix.mul(0.6)));
      const behind = (viewportOpaqueMipTexture(screenUV.add(bend)) as N).rgb;
      const absorb = exp(depth.mul(vec3(0.5, 0.2, 0.1)).negate());
      emissive = emissive.add(behind.mul(absorb).mul(float(1).sub(fres)).mul(float(1).sub(depthMix.mul(0.8))));
      base = waterC.mul(depthMix);
      alpha = max(float(0.95).mul(mix(smoothstep(0, 0.4, shore.add(0.12)), float(1), river)).mul(wetMask), foam);
    }
    m.colorNode = mix(base, vec3(1, 1, 1), foam.mul(0.9));
    m.emissiveNode = emissive.mul(float(1).sub(foam));
    m.roughnessNode = mix(float(0.07), float(0.8), foam);
    m.opacityNode = max(alpha, foam.mul(0.95));
    m.needsUpdate = true;

    // Edge wall: only visible where land meets the border.
    this.wallMat.needsUpdate = true;
  }

  /** Keep the planar reflection target glued to sea level under the camera's view. */
  update(): void {
    this.reflection?.target.updateMatrixWorld();
  }

  dispose(): void {
    if (this.reflection) { this.scene.remove(this.reflection.target); this.reflection.dispose(); }
    this.ocean.geometry.dispose();
    this.wall.geometry.dispose();
    this.material.dispose();
    this.wallMat.dispose();
    this.info.dispose();
    this.normals.dispose();
  }
}
