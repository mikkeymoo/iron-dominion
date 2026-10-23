import { Color, DataTexture, MeshStandardNodeMaterial, NearestFilter, Vector4 } from 'three/webgpu';
import { mix, positionWorld, step, texture, uniform, vec4, vertexColor } from 'three/tsl';
import { MAP } from '../sim/layers.ts';

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
  c = mix(c, overlay.rgb, overlay.a.mul(overlayOpacity).mul(step(0.5, overlayMode)));
  c = mix(c, selectionTint.rgb, inRect.mul(selectionTint.a));

  const material = new MeshStandardNodeMaterial();
  material.colorNode = vec4(c, 1);
  material.opacityNode = cutawayAlpha;
  material.roughness = 0.95;
  material.metalness = 0;

  return {
    material,
    slots: {
      overlayTexture, overlayMode, overlayOpacity, zoneTexture, selectionRect, selectionTint, cutawayAlpha,
    },
  };
}

export function createWaterMaterial(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.color = new Color(0x2c7fb5);
  m.transparent = true;
  m.opacity = 0.72;
  m.roughness = 0.12;
  m.metalness = 0;
  m.depthWrite = false;
  return m;
}

export function createRoadMaterial(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.colorNode = vertexColor();
  m.roughness = 0.92;
  m.metalness = 0;
  m.polygonOffset = true;
  m.polygonOffsetFactor = -2;
  m.polygonOffsetUnits = -2;
  return m;
}
