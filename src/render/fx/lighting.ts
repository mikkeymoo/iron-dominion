// Key light (sun by day, moon by night), hemisphere ambient and the per-tier shadow rig.
//   low  : no shadow map (the building kit carries baked vertex AO)
//   mid  : one 1024 map, an orthographic box fitted to the view and snapped to its own texel grid
//   high : CSMShadowNode, 3 cascades at 2048;  ultra: 4 cascades at 4096
// One light serves both the sun and the moon: at the hand-over both intensities are zero, so it never pops, and a
// moonlit city still casts shadows.
import { DirectionalLight, HemisphereLight, Vector3, type Scene, type WebGPURenderer } from 'three/webgpu';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { SHADOW_CASCADES, type TierSpec } from '../tier.ts';
import type { SkyLook } from './palette.ts';

/** Lowest elevation (sine) the key light is allowed to shine from, so dawn shadows stay inside the map and off the grazing-angle cliff. */
const MIN_LIGHT_ELEV = 0.2;
const LIGHT_DISTANCE = 220;
const CSM_FAR = 260;

type Mode = 'none' | 'view' | 'csm';

export class Lighting {
  readonly hemi = new HemisphereLight(0xa8ccf0, 0x7d6b50, 1.1);
  light!: DirectionalLight;
  private csm: CSMShadowNode | null = null;
  private mode: Mode = 'none';
  private cascades = 0;
  private mapSize = 0;
  private readonly keyDir = new Vector3(0, 1, 0);
  private fitRadius = 100;

  constructor(private readonly scene: Scene, private readonly renderer: WebGPURenderer) {
    this.light = this.makeLight();
    scene.add(this.hemi, this.light, this.light.target);
  }

  private makeLight(): DirectionalLight {
    const l = new DirectionalLight(0xfff1d6, 2.6);
    l.name = 'key';
    l.castShadow = false;
    return l;
  }

  get shadowMode(): Mode { return this.mode; }
  get cascadeCount(): number { return this.cascades; }

  applyTier(spec: TierSpec): void {
    const cascades = SHADOW_CASCADES[spec.shadows];
    const mode: Mode = cascades === 0 ? 'none' : cascades === 1 ? 'view' : 'csm';
    if (mode === this.mode && cascades === this.cascades && spec.shadowMapSize === this.mapSize) return;
    // A different shadow node graph needs a different light object: the old one's compiled materials never see the change.
    const old = this.light;
    this.csm?.dispose();
    this.csm = null;
    old.shadow.map?.dispose();
    this.scene.remove(old, old.target);
    old.dispose();
    const l = this.makeLight();
    this.light = l;
    this.mode = mode;
    this.cascades = cascades;
    this.mapSize = spec.shadowMapSize;
    // The fresh light has the default shadow camera box, so the fitted radius must be recomputed.
    this.fitRadius = -1;
    this.renderer.shadowMap.enabled = mode !== 'none';
    l.castShadow = mode !== 'none';
    if (mode !== 'none') {
      const sh = l.shadow;
      sh.mapSize.set(spec.shadowMapSize, spec.shadowMapSize);
      sh.bias = -0.0002;
      sh.normalBias = mode === 'csm' ? 0.08 : 0.35;
      sh.camera.near = 1;
      sh.camera.far = mode === 'csm' ? 700 : 520;
    }
    this.scene.add(l, l.target);
    if (mode === 'csm') {
      this.csm = new CSMShadowNode(l, { cascades, maxFar: CSM_FAR, mode: 'practical', lightMargin: 160 });
      l.shadow.shadowNode = this.csm;
    }
  }

  /** Call after the camera aspect or projection changes. */
  onProjectionChange(): void {
    // The node learns its camera on first use (_init); before that there is nothing to refit.
    if (this.csm?.camera) this.csm.updateFrustums();
  }

  /**
   * @param focus the camera target on the ground, @param camDist the orbit distance (sizes the fitted shadow box)
   * @param sun / moon unit directions toward each body
   */
  update(look: SkyLook, sun: [number, number, number], moon: [number, number, number], focus: Vector3, camDist: number): void {
    const useSun = look.sunIntensity > 0.001 || look.moonIntensity <= 0.001;
    const src = useSun ? sun : moon;
    const k = this.keyDir.set(src[0], src[1], src[2]);
    if (k.y < MIN_LIGHT_ELEV) {
      const h = Math.hypot(k.x, k.z) || 1;
      const s = Math.sqrt(1 - MIN_LIGHT_ELEV * MIN_LIGHT_ELEV) / h;
      k.set(k.x * s, MIN_LIGHT_ELEV, k.z * s);
    }
    const l = this.light;
    if (useSun) {
      l.color.setRGB(look.sunColor[0], look.sunColor[1], look.sunColor[2]);
      l.intensity = look.sunIntensity;
    } else {
      l.color.setRGB(look.moonColor[0], look.moonColor[1], look.moonColor[2]);
      l.intensity = look.moonIntensity;
    }

    let tx = focus.x, ty = focus.y, tz = focus.z;
    if (this.mode === 'view') {
      // Fit the box to what the camera sees (snapped to 16 tiles so it does not breathe while zooming), then snap the
      // centre to the shadow texel grid in light space so a pan does not shimmer.
      const want = Math.min(130, Math.max(36, Math.ceil((camDist * 0.95) / 16) * 16));
      const sh = l.shadow;
      if (want !== this.fitRadius) {
        this.fitRadius = want;
        sh.camera.left = -want; sh.camera.right = want; sh.camera.top = want; sh.camera.bottom = -want;
        sh.camera.updateProjectionMatrix();
      }
      const texel = (2 * this.fitRadius) / this.mapSize;
      const fx = -k.x, fy = -k.y, fz = -k.z;
      let rx = fy * 0 - fz * 1, ry = fz * 0 - fx * 0, rz = fx * 1 - fy * 0;
      const rl = Math.hypot(rx, ry, rz) || 1;
      rx /= rl; ry /= rl; rz /= rl;
      const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
      const pr = tx * rx + ty * ry + tz * rz, pu = tx * ux + ty * uy + tz * uz;
      const dr = Math.round(pr / texel) * texel - pr, du = Math.round(pu / texel) * texel - pu;
      tx += rx * dr + ux * du; ty += ry * dr + uy * du; tz += rz * dr + uz * du;
    }
    l.target.position.set(tx, ty, tz);
    l.position.set(tx + k.x * LIGHT_DISTANCE, ty + k.y * LIGHT_DISTANCE, tz + k.z * LIGHT_DISTANCE);
    l.target.updateMatrixWorld();

    // Sky probe: the upper hemisphere borrows the horizon glow near sunrise and sunset, and by day the lower one takes a green bounce
    // off the grass, so shaded walls and tree undersides are not a neutral grey.
    const day = 1 - look.night;
    const warm = Math.min(1, Math.max(0, (look.glow[0] - 0.7) * 0.5)) * day * 0.22;
    const bounce = 0.32 * day;
    this.hemi.color.setRGB(look.hemiSky[0] + look.glow[0] * warm, look.hemiSky[1] + look.glow[1] * warm * 0.7, look.hemiSky[2] + look.glow[2] * warm * 0.4);
    this.hemi.groundColor.setRGB(
      look.hemiGround[0] + (0.2 - look.hemiGround[0]) * bounce, look.hemiGround[1] + (0.3 - look.hemiGround[1]) * bounce, look.hemiGround[2] + (0.11 - look.hemiGround[2]) * bounce,
    );
    this.hemi.intensity = look.hemiIntensity;
  }

  dispose(): void {
    this.csm?.dispose();
    this.light.shadow.map?.dispose();
    this.scene.remove(this.light, this.light.target, this.hemi);
    this.light.dispose();
  }
}
