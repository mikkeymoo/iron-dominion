// Node materials for the building kit. All building geometry shares one material per draw type; per-vertex attributes carry
// slot / AO / window id, per-instance attributes carry tint, construction progress and the lit-window seed.
import {
  BufferGeometry, DataTexture, Float32BufferAttribute, LinearFilter, LinearMipmapLinearFilter, MeshStandardNodeMaterial, RGBAFormat,
  UnsignedByteType, type Node, type Texture,
} from 'three/webgpu';
import {
  attribute, clamp, dFdx, dFdy, dot, exp, float, fract, hash, max, min, mix, normalGeometry, normalView, normalize, normalWorld, positionGeometry,
  positionView, positionWorld, sin, smoothstep, step, texture, time, vec2, vec3, vertexColor,
} from 'three/tsl';
import { cloudLight, writeReflection } from './fx/gfxNodes.ts';
import { fxU } from './fx/uniforms.ts';
import { ATLAS_COLS, ATLAS_H, ATLAS_ROWS, ATLAS_W, buildWindowAtlas } from './kit/atlas.ts';
import { PULSE_WID } from './kit/geo.ts';
import { FINISH, FOUNDATION_END, NO_CLIP, SCAFFOLD_LEAD } from './kit/construction.ts';
import type { GfxSpec } from './tier.ts';

// TSL node graphs are built dynamically; the published typings reject most mixed-type chains, so graph code is loosely typed.
type N = any;

/** 0 = day, 1 = night. Owned by the atmosphere unit (fx/uniforms.ts), which ramps it with the sun. Drives lit windows and signs. */
export const buildingLight = { night: fxU.night };

const snowOnTop = () => fxU.snow.mul(smoothstep(0.6, 0.9, normalWorld.y));

const LIT_FRACTION = 0.42;

export function createAtlasTexture(): DataTexture {
  const t = new DataTexture(buildWindowAtlas(), ATLAS_W, ATLAS_H, RGBAFormat, UnsignedByteType);
  t.generateMipmaps = true;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.flipY = false;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

const slotIs = (slot: Node<'float'>, k: number) => step(k - 0.5, slot).mul(step(slot, k + 0.5));

/**
 * Interior-mapped room behind a window pane: a ray from the eye through the pane is intersected with the box of a room whose back
 * wall sits `depth` pane-widths behind the glass. Walls, floor and ceiling take a per-room colour; a back-wall shelf and a floor
 * lamp patch vary by room. Tangent space comes from screen-space derivatives of the atlas uv, so no tangent attribute is needed.
 * `local` is the uv inside the atlas cell (0..1), `seed` a per-window random.
 */
function roomInterior(cellUv: N, local: N, seed: N): N {
  const dp1 = dFdx(positionView), dp2 = dFdy(positionView);
  const du1: N = dFdx(cellUv), du2: N = dFdy(cellUv);
  const tangent = normalize(dp1.mul(du2.y).sub(dp2.mul(du1.y)));
  const bitangent = normalize(dp2.mul(du1.x).sub(dp1.mul(du2.x)));
  const view = normalize(positionView.negate());
  const vts = vec3(dot(view, tangent), dot(view, bitangent), dot(view, normalView));
  const dir = normalize(vec3(vts.x.negate(), vts.y.negate(), vts.z.negate().min(-0.08)));
  const o = vec3(local.x.mul(2).sub(1), local.y.mul(2).sub(1), 0);
  const depth = float(0.8).add(hash(seed.add(3)).mul(0.9));
  const inv = dir.reciprocal();
  const tx = step(0, dir.x).mul(2).sub(1).sub(o.x).mul(inv.x);
  const ty = step(0, dir.y).mul(2).sub(1).sub(o.y).mul(inv.y);
  const tz = depth.negate().sub(o.z).mul(inv.z);
  const t = min(min(tx, ty), tz);
  const hit = o.add(dir.mul(t));
  const isBack = step(tz, min(tx, ty)), isFloor = step(ty, tx).mul(step(dir.y, 0)).mul(float(1).sub(isBack)), isCeil = step(ty, tx).mul(step(0, dir.y)).mul(float(1).sub(isBack));
  const hue = hash(seed.add(11));
  const wallA = mix(vec3(0.9, 0.78, 0.6), vec3(0.62, 0.74, 0.88), step(0.62, hue));
  const wallB = mix(vec3(0.82, 0.55, 0.5), vec3(0.6, 0.78, 0.6), step(0.5, hash(seed.add(17))));
  const wall = mix(wallA, wallB, step(0.7, hash(seed.add(19))));
  const shelf = step(0.55, hash(seed.add(23))).mul(step(hit.y, float(-0.15).add(hash(seed.add(29)).mul(0.5)))).mul(step(hit.x.sub(hash(seed.add(31)).sub(0.5).mul(1.2)).abs(), 0.4));
  const lamp = exp(hit.sub(vec3(hash(seed.add(37)).mul(1.4).sub(0.7), 0.7, float(-0.4))).length().mul(-2.6)).mul(step(0.5, hash(seed.add(41))));
  const back = wall.mul(float(1).sub(shelf.mul(0.55))).add(vec3(1, 0.85, 0.55).mul(lamp).mul(0.5));
  const floor = vec3(0.36, 0.26, 0.19).mul(0.9);
  const ceil = wall.mul(1.05);
  const side = wall.mul(0.62);
  let c: N = mix(side, back, isBack);
  c = mix(c, floor, isFloor);
  c = mix(c, ceil, isCeil);
  const falloff = exp(t.mul(-0.55));
  return c.mul(falloff.mul(0.75).add(0.35));
}

export function createBuildingMaterial(atlas: Texture): { material: MeshStandardNodeMaterial; configure: (g: GfxSpec) => void } {
  const material = new MeshStandardNodeMaterial();

  const configure = (g: GfxSpec): void => {
    const cellAttr = attribute('cell', 'vec4');
    const slot = cellAttr.w;
    const wid = cellAttr.z;
    const ao = vertexColor().a;
    const iTint = attribute('iTint', 'vec3');
    const iState = attribute('iState', 'vec4');

    const isGlass = slotIs(slot, 1), isMetal = slotIs(slot, 3), isAccent = slotIs(slot, 4);
    const cell = texture(atlas, cellAttr.xy);
    const pane = cell.r.mul(isGlass);
    const glow = cell.g.mul(isGlass);
    const relief = cell.b;

    const seed = wid.add(0.5).floor().add(iState.y.mul(1000).floor().mul(131));
    const litRand = hash(seed);
    // iState.w = 1 marks a finished building without power (utilities solve): its windows and signs go dark, day and night.
    // iState.w = 2 marks a building on fire: a flickering orange glow over the walls, on top of whatever its windows do.
    const dark = step(0.5, iState.w).mul(step(iState.w, 1.5));
    const burning = step(1.5, iState.w);
    const powered = float(1).sub(dark);
    const flicker = sin(fxU.time.mul(9).add(seed.mul(0.37))).mul(0.25).add(0.75);
    const varied = g.interiors !== 'off';
    // Evening fills the windows: more rooms are lit between dusk and midnight than before dawn, and each room has its own light.
    const litShare = varied ? float(LIT_FRACTION).add(fxU.night.mul(0.14)) : float(LIT_FRACTION);
    const lit = step(float(1).sub(litShare), litRand).mul(isGlass).mul(powered);
    const warmth = hash(seed.add(7919));
    let litColor: N = mix(vec3(1.0, 0.78, 0.45), vec3(0.75, 0.88, 1.0), step(0.8, warmth));
    let roomGain: N = float(1);
    if (varied) {
      // A few rooms glow with a television: blue-white, pulsing. Others run cold LED, tungsten or a dim lamp.
      const tv = step(0.9, hash(seed.add(101)));
      const tvPulse = sin(fxU.time.mul(hash(seed.add(103)).mul(4).add(3)).add(seed)).mul(0.3).add(0.7);
      litColor = mix(mix(litColor, vec3(1.0, 0.64, 0.32), step(0.55, hash(seed.add(107))).mul(0.45)), vec3(0.5, 0.66, 1.0), tv);
      const dim = hash(seed.add(109)).mul(0.9).add(0.35);
      // Curtains drawn over the top of some windows.
      const local = vec2(fract(cellAttr.x.mul(ATLAS_COLS)), fract(cellAttr.y.mul(ATLAS_ROWS)));
      const curtain = mix(float(1), smoothstep(0.25, 0.6, float(1).sub(local.y)).mul(0.65).add(0.35), step(0.72, hash(seed.add(113))));
      roomGain = dim.mul(curtain).mul(mix(float(1), tvPulse, tv));
      if (g.interiors === 'parallax') litColor = litColor.mul(roomInterior(cellAttr.xy, local, seed).mul(1.5));
    }

    const base = vertexColor().rgb;
    const solid = base.mul(mix(vec3(1, 1, 1), iTint, float(1).sub(isGlass)));
    const frame = vec3(0.2, 0.21, 0.23).mul(relief.mul(1.4).add(0.3));
    const day = mix(base.mul(1.15), litColor.mul(0.5), lit.mul(0.3).mul(buildingLight.night.oneMinus().mul(0.6).add(0.4)));
    const fresnel = float(1).sub(normalView.z.abs()).pow(2.2);
    const sky = mix(day, vec3(0.62, 0.78, 0.95), fresnel.mul(0.5).add(0.12).mul(buildingLight.night.oneMinus()));
    const glassCol = mix(frame, sky, pane);
    const albedo = mix(solid, glassCol, isGlass);

    let wall: N = mix(albedo.mul(ao.mul(0.55).add(0.45)), vec3(0.93, 0.95, 0.99), snowOnTop().mul(0.9));
    if (g.cloudShadows) wall = wall.mul(cloudLight(positionWorld.xz));
    material.colorNode = wall;
    material.aoNode = ao;
    // Accent surfaces tagged with a window id of PULSE_WID or more (megaproject plasma, beacons, scoreboards) glow day and night
    // and breathe: over 1.0 so the bloom pass picks them up.
    const pulse = step(PULSE_WID - 0.5, wid);
    const breathe = sin(time.mul(2.4)).mul(0.5).add(1.9);
    const accentGlow = mix(buildingLight.night.mul(1.3).add(0.12), breathe, pulse);
    material.emissiveNode = litColor.mul(pane).mul(glow).mul(lit).mul(buildingLight.night).mul(roomGain).mul(1.7)
      .add(base.mul(isAccent).mul(accentGlow).mul(powered.mul(0.92).add(0.08)))
      .add(vec3(1.0, 0.34, 0.07).mul(burning).mul(flicker).mul(float(0.6).sub(isGlass.mul(0.25))));
    const roughness = mix(mix(float(0.86), float(0.42), isMetal), mix(float(0.55), float(0.12), pane), isGlass);
    material.roughnessNode = roughness;
    material.metalnessNode = mix(mix(float(0), float(0.7), isMetal), pane.mul(0.25), isGlass);
    // Glass towers mirror the street in screen-space reflections, by day (when the sky and neighbours show in them) more than at night.
    if (g.ssr !== 'off') {
      const mask: N = pane.mul(float(0.85).sub(buildingLight.night.mul(0.4))).max(isMetal.mul(g.ssr === 'full' ? 0.4 : 0));
      material.colorNode = writeReflection(wall, mask, roughness);
    }

    // Construction clip: floors exist up to builtFraction * height. Same constants as kit/construction.ts.
    const p = iState.x;
    const built = clamp(p.sub(FOUNDATION_END).div(FINISH - FOUNDATION_END), 0, 1);
    const clipY = mix(built.mul(iState.z), float(NO_CLIP), step(FINISH, p));
    material.maskNode = positionGeometry.y.lessThanEqual(clipY);
    material.needsUpdate = true;
  };

  configure({ cloudShadows: false, interiors: 'off', ssr: 'off' } as GfxSpec);
  return { material, configure };
}

/** Foundation slab, fence, scaffold (wid = 1, clipped with the rising floor) and the tower crane (progress = 1, no clip). */
export function createSiteMaterial(): { material: MeshStandardNodeMaterial; configure: (g: GfxSpec) => void } {
  const ao = vertexColor().a;
  const wid = attribute('wid', 'float');
  const iState = attribute('iState', 'vec4');
  const material = new MeshStandardNodeMaterial();
  material.aoNode = ao;
  material.roughness = 0.62;
  material.metalness = 0.35;
  const p = iState.x;
  const built = clamp(p.sub(FOUNDATION_END).div(FINISH - FOUNDATION_END), 0, 1);
  const rise = mix(built.mul(iState.z).add(SCAFFOLD_LEAD), iState.z.add(SCAFFOLD_LEAD), step(FINISH, p));
  const clipY = min(iState.w, rise);
  const isScaffold = step(0.5, wid);
  material.maskNode = positionGeometry.y.lessThanEqual(max(clipY, float(NO_CLIP).mul(float(1).sub(isScaffold))));
  const configure = (g: GfxSpec): void => {
    const c: N = vertexColor().rgb.mul(ao.mul(0.5).add(0.5));
    material.colorNode = g.cloudShadows ? c.mul(cloudLight(positionWorld.xz)) : c;
    material.needsUpdate = true;
  };
  configure({ cloudShadows: false } as GfxSpec);
  return { material, configure };
}

/** Far LOD: unit boxes scaled per instance, wall colour on the sides, roof colour on top, floor banding for scale. */
export function createFarMaterial(): { material: MeshStandardNodeMaterial; configure: (g: GfxSpec) => void } {
  const iTint = attribute('iTint', 'vec3');
  const iState = attribute('iState', 'vec4');
  const material = new MeshStandardNodeMaterial();
  material.roughness = 0.85;
  material.metalness = 0;
  const configure = (g: GfxSpec): void => {
    const top = step(0.5, normalGeometry.y);
    const band = step(0.5, positionWorld.y.mul(5.9).fract());
    const sideShade = mix(float(0.84), float(1), band).mul(positionGeometry.y.mul(0.3).add(0.7));
    let c: N = mix(mix(iTint.mul(sideShade), iState.xyz.mul(0.95), top), vec3(0.93, 0.95, 0.99), top.mul(fxU.snow).mul(0.9));
    if (g.cloudShadows) c = c.mul(cloudLight(positionWorld.xz));
    material.colorNode = c;
    if (g.interiors !== 'off') {
      // Distant towers keep a lit-window grid after dark: one cell per floor and per 0.32 tiles along the face, lit at random per building.
      const alongX = step(0.5, normalGeometry.z.abs());
      const along = mix(positionWorld.z, positionWorld.x, alongX);
      const cellId = along.mul(3.1).floor().add(positionWorld.y.mul(5.9).floor().mul(57.0)).add(iTint.x.mul(913).floor().mul(7.0));
      const win = step(0.34, fract(along.mul(3.1))).mul(step(fract(along.mul(3.1)), 0.78)).mul(step(0.18, fract(positionWorld.y.mul(5.9)))).mul(step(fract(positionWorld.y.mul(5.9)), 0.7));
      const on = step(0.58, hash(cellId)).mul(float(1).sub(top));
      const tone = mix(vec3(1.0, 0.76, 0.42), vec3(0.74, 0.86, 1.0), step(0.82, hash(cellId.add(5))));
      material.emissiveNode = tone.mul(win).mul(on).mul(fxU.night).mul(0.85);
    } else material.emissiveNode = null;
    material.needsUpdate = true;
  };
  configure({ cloudShadows: false, interiors: 'off' } as GfxSpec);
  return { material, configure };
}

export function boxGeometry(): BufferGeometry {
  const g = new BufferGeometry();
  const P: number[] = [], N: number[] = [], I: number[] = [];
  const faces: [number[], number[]][] = [
    [[0, 0, 1], [-0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 1, 0.5, -0.5, 1, 0.5]],
    [[0, 0, -1], [0.5, 0, -0.5, -0.5, 0, -0.5, -0.5, 1, -0.5, 0.5, 1, -0.5]],
    [[1, 0, 0], [0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 1, -0.5, 0.5, 1, 0.5]],
    [[-1, 0, 0], [-0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 1, 0.5, -0.5, 1, -0.5]],
    [[0, 1, 0], [-0.5, 1, 0.5, 0.5, 1, 0.5, 0.5, 1, -0.5, -0.5, 1, -0.5]],
  ];
  for (const [n, v] of faces) {
    const o = P.length / 3;
    P.push(...v); for (let i = 0; i < 4; i++) N.push(...n);
    I.push(o, o + 1, o + 2, o, o + 2, o + 3);
  }
  g.setAttribute('position', new Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new Float32BufferAttribute(N, 3));
  g.setIndex(I);
  return g;
}
