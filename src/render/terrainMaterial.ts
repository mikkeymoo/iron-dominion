import { DataTexture, MeshStandardNodeMaterial, NearestFilter, Vector4, type Texture } from 'three/webgpu';
import {
  cameraPosition, float, max, mix, normalWorld, normalize, positionView, positionWorld, pow, reflect, smoothstep, step, texture, time, uniform, vec2, vec3, vec4, vertexColor,
} from 'three/tsl';
import { MAP } from '../sim/layers.ts';
import { WATER_RANGE } from './fx/shore.ts';
import { bumpNormal, cloudLight, noiseAt, toneShift, triplanarNoise, writeReflection } from './fx/gfxNodes.ts';
import { dryGrass } from './fx/seasonNodes.ts';
import { skyGradient } from './fx/skyNode.ts';
import { fxU } from './fx/uniforms.ts';
import type { GfxSpec } from './tier.ts';

// TSL node graphs are built dynamically; the published typings reject most mixed-type chains, so graph code is loosely typed.
type N = any;

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

/** Sky colour mirrored in a flat wet surface: the dome gradient along the reflected view ray, weighted by Fresnel. */
function wetSkyGlint(wp: N, n: N, mask: N): N {
  const v = normalize(cameraPosition.sub(wp));
  const r = reflect(v.negate(), n);
  const fres = float(0.04).add(float(0.96).mul(pow(float(1).sub(n.dot(v).max(0)), 5)));
  return skyGradient(vec3(r.x, r.y.abs(), r.z)).mul(fres.mul(1.6).add(0.05)).mul(mask);
}

/** Wide, soft puddle mask: noise basins where rain collects, on level ground only. */
function puddleMask(wp: N, n: N): N {
  const basin = noiseAt(wp.xz.mul(1 / 46).add(vec2(0.37, 0.11))).r.mul(0.7).add(noiseAt(wp.xz.mul(1 / 13)).g.mul(0.3));
  const flat = smoothstep(0.8, 0.95, n.y);
  return smoothstep(0.5, 0.64, basin).mul(flat).mul(smoothstep(0.35, 0.9, fxU.wet)).mul(float(1).sub(fxU.snow));
}

export function createTerrainMaterial(waterInfo: Texture): { material: MeshStandardNodeMaterial; slots: TerrainSlots; configure: (g: GfxSpec) => void } {
  const overlayTexture = dataTexture();
  const zoneTexture = dataTexture();
  const overlayMode = uniform(OVERLAY.OFF);
  const overlayOpacity = uniform(0.7);
  const selectionRect = uniform(new Vector4(0, 0, -1, -1));
  const selectionTint = uniform(new Vector4(1, 1, 1, 0));
  const cutawayAlpha = uniform(1);

  const material = new MeshStandardNodeMaterial();
  material.metalness = 0;

  const configure = (g: GfxSpec): void => {
    const wp3 = positionWorld;
    const wp = wp3.xz;
    const tileUv = wp.div(MAP);
    const nw = normalWorld.normalize();

    const zone = texture(zoneTexture, tileUv);
    const overlay = texture(overlayTexture, tileUv);
    const inRect = step(selectionRect.x, wp.x).mul(step(wp.x, selectionRect.z)).mul(step(selectionRect.y, wp.y)).mul(step(wp.y, selectionRect.w));

    let c: N = vertexColor().rgb;
    let normalNode: N | null = null;
    let rockMix: N = float(0);

    if (g.terrainDetail !== 'off') {
      const full = g.terrainDetail === 'full';
      const dist = positionView.length();
      const close = float(1).sub(smoothstep(24, 150, dist));
      const nBig = noiseAt(wp.div(160)).r;
      const nMid = noiseAt(wp.div(28)).r;
      const nFine = noiseAt(wp.div(12)).g;
      const vary = float(0.6).add(nBig.mul(0.42)).add(nMid.mul(0.36)).add(nFine.sub(0.5).mul(0.42).mul(close));
      const sandy = smoothstep(0.7, 1.15, c.r.div(c.g.add(0.002))).mul(float(1).sub(smoothstep(0.6, 0.85, c.b.div(c.g.add(0.002)))));
      const grassy = float(1).sub(sandy);
      c = toneShift(c, nBig.mul(0.8).add(nMid.mul(0.2))).mul(mix(vary, vary.mul(0.5).add(0.5), sandy));
      // Sand takes a fine grain that is only visible up close; grass takes streaks that hint at blades under the tufts.
      c = c.mul(float(1).add(nFine.sub(0.5).mul(0.5).mul(close).mul(sandy)));

      const slope = float(1).sub(smoothstep(0.62, 0.86, nw.y));
      rockMix = slope;
      const ridged = full ? triplanarNoise(wp3, nw, 1 / 7, 'a') : noiseAt(wp.div(7)).a;
      const ridgedFine = full ? triplanarNoise(wp3, nw, 1 / 2.1, 'a') : noiseAt(wp.div(2.1)).a;
      const strata = ridged.mul(0.65).add(ridgedFine.mul(0.35).mul(close.mul(0.7).add(0.3)));
      const rockCol = mix(vec3(0.2, 0.185, 0.165), vec3(0.42, 0.395, 0.36), strata);
      c = mix(c, rockCol, slope.mul(0.92));

      if (full) {
        const grain = nMid.mul(0.55).add(nFine.mul(0.45));
        const height = mix(grain.mul(0.5).mul(grassy.mul(0.7).add(0.3)), strata.mul(2.2), slope).mul(close.mul(0.75).add(0.25));
        normalNode = bumpNormal(height, float(0.34));
      }
    }

    // Seasons: the grass dries to straw toward winter and the whole ground takes the year's tint (fresh, warm, orange, cold).
    c = dryGrass(c, fxU.dry.mul(0.55)).mul(fxU.seasonTint);

    if (g.cloudShadows) c = c.mul(cloudLight(wp));

    if (g.caustics) {
      // Light webs on the sea and river floor: two scrolling layers of the caustic channel, strongest in shallows, gone in deep water.
      const info = texture(waterInfo, wp.div(MAP).clamp(0.0005, 0.9995));
      const depth = info.r.mul(WATER_RANGE);
      const under = smoothstep(0.015, 0.1, depth);
      const shallow = float(1).sub(smoothstep(0.7, 6.5, depth));
      const t = time;
      const c1 = noiseAt(wp.mul(0.062).add(vec2(t.mul(0.017), t.mul(0.011)))).b;
      const c2 = noiseAt(vec2(wp.x.mul(0.047).sub(wp.y.mul(0.031)), wp.x.mul(0.031).add(wp.y.mul(0.047))).add(vec2(t.mul(-0.013), t.mul(0.019)))).b;
      const web = pow(max(c1.mul(c2).mul(2.2), c1.mul(0.35).add(c2.mul(0.35))), 1.6).clamp(0, 1);
      const sun = fxU.sunDir.y.max(0).mul(float(1).sub(fxU.overcast.mul(0.85)));
      c = c.add(vec3(0.42, 0.78, 1.0).mul(web).mul(under).mul(shallow).mul(sun).mul(1.15));
    }

    const zoneMix = c;
    c = mix(zoneMix, zone.rgb, zone.a);
    // Underground view (cutawayAlpha < 1): cool, darker ground so the glowing pipes and the coverage tint carry the picture.
    c = mix(c, vec3(0.05, 0.1, 0.17), cutawayAlpha.oneMinus().mul(1.1));
    c = mix(c, overlay.rgb, overlay.a.mul(overlayOpacity).mul(step(0.5, overlayMode)));
    c = mix(c, selectionTint.rgb, inRect.mul(selectionTint.a));

    // Weather: wet ground darkens and shines, snow whitens upward faces.
    const flat = smoothstep(0.5, 0.85, normalWorld.y);
    const snowAmt = fxU.snow.mul(flat);
    c = c.mul(float(1).sub(fxU.wet.mul(0.3)));
    c = mix(c, vec3(0.92, 0.94, 0.98), snowAmt.mul(0.92));

    let rough: N = mix(float(0.95), float(0.5), fxU.wet.mul(float(1).sub(snowAmt)));
    let emissive: N | null = null;
    let reflective: N = float(0);
    if (g.puddles) {
      const p = puddleMask(wp3, nw).mul(float(1).sub(rockMix));
      c = c.mul(float(1).sub(p.mul(0.42)));
      rough = mix(rough, float(0.04), p);
      emissive = wetSkyGlint(wp3, nw, p);
      reflective = p;
    }
    if (g.ssr === 'full') reflective = max(reflective, fxU.wet.mul(0.35).mul(flat).mul(float(1).sub(snowAmt)));

    const colour: N = vec4(c, 1);
    material.colorNode = g.ssr !== 'off' ? writeReflection(colour, reflective, rough) : colour;
    material.opacityNode = cutawayAlpha;
    material.roughnessNode = rough;
    material.normalNode = normalNode;
    material.emissiveNode = emissive;
    material.needsUpdate = true;
  };

  configure({ terrainDetail: 'off', cloudShadows: false, caustics: false, puddles: false, ssr: 'off' } as GfxSpec);

  return {
    material,
    slots: {
      overlayTexture, overlayMode, overlayOpacity, zoneTexture, selectionRect, selectionTint, cutawayAlpha,
    },
    configure,
  };
}

export function createRoadMaterial(): { material: MeshStandardNodeMaterial; configure: (g: GfxSpec) => void } {
  const m = new MeshStandardNodeMaterial();
  m.metalness = 0;
  m.polygonOffset = true;
  m.polygonOffsetFactor = -2;
  m.polygonOffsetUnits = -2;
  const configure = (g: GfxSpec): void => {
    // Asphalt darkens and turns glossy in the wet; traffic keeps snow thinner on roads than on the ground.
    const flat = smoothstep(0.5, 0.85, normalWorld.y);
    const snowAmt = fxU.snow.mul(flat).mul(0.55);
    const wp3 = positionWorld;
    const nw = normalWorld.normalize();
    let base: N = vertexColor().rgb;
    if (g.terrainDetail !== 'off') {
      // Asphalt grain and patched repairs.
      const grain = noiseAt(wp3.xz.div(3.1)).g, patch = noiseAt(wp3.xz.div(41)).r;
      base = base.mul(float(0.82).add(grain.mul(0.3)).add(patch.sub(0.5).mul(0.26)));
    }
    if (g.cloudShadows) base = base.mul(cloudLight(wp3.xz));
    let c: N = mix(base.mul(float(1).sub(fxU.wet.mul(0.4))), vec3(0.9, 0.92, 0.96), snowAmt);
    let rough: N = mix(float(0.92), float(0.28), fxU.wet.mul(float(1).sub(snowAmt)));
    let emissive: N | null = null;
    let puddleOnRoad: N | null = null;
    if (g.puddles) {
      // Water collects in the lanes: ruts along the road, wide basins, mirror smooth with a sky glint.
      const rut = noiseAt(wp3.xz.mul(0.09)).r.mul(0.55).add(noiseAt(wp3.xz.mul(0.37)).g.mul(0.45));
      const p = smoothstep(0.46, 0.6, rut).mul(smoothstep(0.25, 0.8, fxU.wet)).mul(float(1).sub(snowAmt)).mul(smoothstep(0.85, 0.97, nw.y));
      c = c.mul(float(1).sub(p.mul(0.5)));
      rough = mix(rough, float(0.03), p);
      puddleOnRoad = p;
      emissive = wetSkyGlint(wp3, nw, p.max(fxU.wet.mul(0.3).mul(float(1).sub(snowAmt))));
    }
    // Screen-space reflections: wet asphalt and puddles mirror the street (mask = how reflective, 0 = not at all).
    const sheen: N = fxU.wet.mul(0.55).mul(float(1).sub(snowAmt));
    m.colorNode = g.ssr !== 'off' ? writeReflection(c, puddleOnRoad ? sheen.max(puddleOnRoad) : sheen, rough) : c;
    m.roughnessNode = rough;
    m.emissiveNode = emissive;
    m.needsUpdate = true;
  };
  configure({ terrainDetail: 'off', cloudShadows: false, puddles: false, ssr: 'off' } as GfxSpec);
  return { material: m, configure };
}
