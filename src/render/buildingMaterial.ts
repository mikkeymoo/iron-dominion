// Node materials for the building kit. All building geometry shares one material per draw type; per-vertex attributes carry
// slot / AO / window id, per-instance attributes carry tint, construction progress and the lit-window seed.
import {
  BufferGeometry, DataTexture, Float32BufferAttribute, LinearFilter, LinearMipmapLinearFilter, MeshStandardNodeMaterial, RGBAFormat,
  UnsignedByteType, type Node, type Texture,
} from 'three/webgpu';
import { attribute, clamp, float, hash, max, min, mix, normalGeometry, normalView, positionGeometry, positionWorld, step, texture, uniform, vec3, vertexColor } from 'three/tsl';
import { ATLAS_H, ATLAS_W, buildWindowAtlas } from './kit/atlas.ts';
import { FINISH, FOUNDATION_END, NO_CLIP, SCAFFOLD_LEAD } from './kit/construction.ts';

/** Shared with the future atmosphere unit: 0 = day, 1 = night. Drives lit windows and signs. */
export const buildingLight = { night: uniform(0) };

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

export function createBuildingMaterial(atlas: Texture): MeshStandardNodeMaterial {
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
  const lit = step(float(1).sub(LIT_FRACTION), litRand).mul(isGlass);
  const warmth = hash(seed.add(7919));
  const litColor = mix(vec3(1.0, 0.78, 0.45), vec3(0.75, 0.88, 1.0), step(0.8, warmth));

  const base = vertexColor().rgb;
  const solid = base.mul(mix(vec3(1, 1, 1), iTint, float(1).sub(isGlass)));
  const frame = vec3(0.2, 0.21, 0.23).mul(relief.mul(1.4).add(0.3));
  const day = mix(base.mul(1.15), litColor.mul(0.5), lit.mul(0.3).mul(buildingLight.night.oneMinus().mul(0.6).add(0.4)));
  const fresnel = float(1).sub(normalView.z.abs()).pow(2.2);
  const sky = mix(day, vec3(0.62, 0.78, 0.95), fresnel.mul(0.5).add(0.12).mul(buildingLight.night.oneMinus()));
  const glassCol = mix(frame, sky, pane);
  const albedo = mix(solid, glassCol, isGlass);

  const material = new MeshStandardNodeMaterial();
  material.colorNode = albedo.mul(ao.mul(0.55).add(0.45));
  material.aoNode = ao;
  material.emissiveNode = litColor.mul(pane).mul(glow).mul(lit).mul(buildingLight.night).mul(1.7)
    .add(base.mul(isAccent).mul(buildingLight.night.mul(1.3).add(0.12)));
  material.roughnessNode = mix(mix(float(0.86), float(0.42), isMetal), mix(float(0.55), float(0.12), pane), isGlass);
  material.metalnessNode = mix(mix(float(0), float(0.7), isMetal), pane.mul(0.25), isGlass);

  // Construction clip: floors exist up to builtFraction * height. Same constants as kit/construction.ts.
  const p = iState.x;
  const built = clamp(p.sub(FOUNDATION_END).div(FINISH - FOUNDATION_END), 0, 1);
  const clipY = mix(built.mul(iState.z), float(NO_CLIP), step(FINISH, p));
  material.maskNode = positionGeometry.y.lessThanEqual(clipY);
  return material;
}

/** Foundation slab, fence, scaffold (wid = 1, clipped with the rising floor) and the tower crane (progress = 1, no clip). */
export function createSiteMaterial(): MeshStandardNodeMaterial {
  const ao = vertexColor().a;
  const wid = attribute('wid', 'float');
  const iState = attribute('iState', 'vec4');
  const material = new MeshStandardNodeMaterial();
  material.colorNode = vertexColor().rgb.mul(ao.mul(0.5).add(0.5));
  material.aoNode = ao;
  material.roughness = 0.62;
  material.metalness = 0.35;
  const p = iState.x;
  const built = clamp(p.sub(FOUNDATION_END).div(FINISH - FOUNDATION_END), 0, 1);
  const rise = mix(built.mul(iState.z).add(SCAFFOLD_LEAD), iState.z.add(SCAFFOLD_LEAD), step(FINISH, p));
  const clipY = min(iState.w, rise);
  const isScaffold = step(0.5, wid);
  material.maskNode = positionGeometry.y.lessThanEqual(max(clipY, float(NO_CLIP).mul(float(1).sub(isScaffold))));
  return material;
}

/** Far LOD: unit boxes scaled per instance, wall colour on the sides, roof colour on top, floor banding for scale. */
export function createFarMaterial(): MeshStandardNodeMaterial {
  const iTint = attribute('iTint', 'vec3');
  const iState = attribute('iState', 'vec4');
  const material = new MeshStandardNodeMaterial();
  const top = step(0.5, normalGeometry.y);
  const band = step(0.5, positionWorld.y.mul(5.9).fract());
  const sideShade = mix(float(0.84), float(1), band).mul(positionGeometry.y.mul(0.3).add(0.7));
  material.colorNode = mix(iTint.mul(sideShade), iState.xyz.mul(0.95), top);
  material.roughness = 0.85;
  material.metalness = 0;
  return material;
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
