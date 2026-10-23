import { DataTexture, MeshStandardNodeMaterial, NearestFilter, Vector4 } from 'three/webgpu';
import { float, mix, normalWorld, positionWorld, smoothstep, step, texture, uniform, vec3, vec4, vertexColor } from 'three/tsl';
import { MAP } from '../sim/layers.ts';
import { fxU } from './fx/uniforms.ts';

export const OVERLAY = { OFF: 0, ON: 1 } as const;

/** Controls for the terrain shader. Slots exist now so later units (overlays, build tools, cutaway) only write data. */
export interface TerrainSlots {
  /** 256x256 RGBA8 heatmap; written by U11. */
  overlayTexture: DataTexture;
  overlayMode: { value: number };
  overlayOpacity: { value: number };
  /** Zone wash: rgb = tint, a = strength. Written by the terrain view from the zone layer. */
  zoneTexture: DataTexture;
  /** Ghost / selection rect in tile units (x0, y0, x1, y1); x1 < x0 means none. */
  selectionRect: { value: Vector4 };
  selectionTint: { value: Vector4 };
  cutawayAlpha: { value: number };
}

function dataTexture(): DataTexture {
  const t = new DataTexture(new Uint8Array(MAP * MAP * 4), MAP, MAP);
  t.magFilter = NearestFilter;
  t.minFilter = NearestFilter;
  t.generateMipmaps = false;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

export function createTerrainMaterial(): { material: MeshStandardNodeMaterial; slots: TerrainSlots } {
  const overlayTexture = dataTexture();
  const zoneTexture = dataTexture();
  const overlayMode = uniform(OVERLAY.OFF);
  const overlayOpacity = uniform(0.7);
  const selectionRect = uniform(new Vector4(0, 0, -1, -1));
  const selectionTint = uniform(new Vector4(1, 1, 1, 0));
  const cutawayAlpha = uniform(1);

  const wp = positionWorld.xz;
  const tileUv = wp.div(MAP);

  const zone = texture(zoneTexture, tileUv);
  const overlay = texture(overlayTexture, tileUv);
  const inRect = step(selectionRect.x, wp.x).mul(step(wp.x, selectionRect.z)).mul(step(selectionRect.y, wp.y)).mul(step(wp.y, selectionRect.w));

  let c = vertexColor().rgb;
  c = mix(c, zone.rgb, zone.a);
  // Underground view (cutawayAlpha < 1): cool, darker ground so the glowing pipes and the coverage tint carry the picture.
  c = mix(c, vec3(0.05, 0.1, 0.17), cutawayAlpha.oneMinus().mul(1.1));
  c = mix(c, overlay.rgb, overlay.a.mul(overlayOpacity).mul(step(0.5, overlayMode)));
  c = mix(c, selectionTint.rgb, inRect.mul(selectionTint.a));

  // Weather: wet ground darkens and shines, snow whitens upward faces.
  const flat = smoothstep(0.5, 0.85, normalWorld.y);
  const snowAmt = fxU.snow.mul(flat);
  c = c.mul(float(1).sub(fxU.wet.mul(0.3)));
  c = mix(c, vec3(0.92, 0.94, 0.98), snowAmt.mul(0.92));

  const material = new MeshStandardNodeMaterial();
  material.colorNode = vec4(c, 1);
  material.opacityNode = cutawayAlpha;
  material.roughnessNode = mix(float(0.95), float(0.5), fxU.wet.mul(float(1).sub(snowAmt)));
  material.metalness = 0;

  return {
    material,
    slots: {
      overlayTexture, overlayMode, overlayOpacity, zoneTexture, selectionRect, selectionTint, cutawayAlpha,
    },
  };
}

export function createRoadMaterial(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  // Asphalt darkens and turns glossy in the wet; traffic keeps snow thinner on roads than on the ground.
  const flat = smoothstep(0.5, 0.85, normalWorld.y);
  const snowAmt = fxU.snow.mul(flat).mul(0.55);
  m.colorNode = mix(vertexColor().rgb.mul(float(1).sub(fxU.wet.mul(0.4))), vec3(0.9, 0.92, 0.96), snowAmt);
  m.roughnessNode = mix(float(0.92), float(0.28), fxU.wet.mul(float(1).sub(snowAmt)));
  m.metalness = 0;
  m.polygonOffset = true;
  m.polygonOffsetFactor = -2;
  m.polygonOffsetUnits = -2;
  return m;
}
