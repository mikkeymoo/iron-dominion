// Sky dome mesh. A hand-rolled TSL dome (see skyNode.ts) instead of three's SkyMesh: its radiance cannot be read back on the
// CPU, so fog, hemisphere light and the water reflection could not match the horizon it paints, and its cloud loop is
// too heavy for the low tier. The dome's palette, the fog colour and the hemisphere light all come from palette.ts.
import { BackSide, Color, Mesh, MeshBasicNodeMaterial, SphereGeometry, type Vector3 } from 'three/webgpu';
import { normalize, positionLocal, vec4 } from 'three/tsl';
import type { TierSpec } from '../tier.ts';
import type { SkyLook } from './palette.ts';
import { skyDome } from './skyNode.ts';
import { fxU } from './uniforms.ts';

export interface SkyDirs { sun: [number, number, number]; moon: [number, number, number] }

export class SkyDome {
  readonly mesh: Mesh;
  private material: MeshBasicNodeMaterial;
  private key: string;

  constructor(spec: TierSpec) {
    this.key = SkyDome.keyOf(spec);
    this.material = SkyDome.makeMaterial(spec);
    this.mesh = new Mesh(new SphereGeometry(900, 32, 16), this.material);
    this.mesh.name = 'sky';
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
  }

  private static keyOf(spec: TierSpec): string { return `${spec.fx.clouds}|${spec.fx.stars}|${spec.gfx.clouds}|${spec.gfx.cloudSteps}`; }

  private static makeMaterial(spec: TierSpec): MeshBasicNodeMaterial {
    const m = new MeshBasicNodeMaterial();
    m.side = BackSide;
    m.depthWrite = false;
    m.fog = false;
    m.colorNode = vec4(skyDome(normalize(positionLocal), { clouds: spec.fx.clouds, stars: spec.fx.stars, mode: spec.gfx.clouds, steps: spec.gfx.cloudSteps }), 1);
    return m;
  }

  /** Rebuild the material when a tier change alters the dome's node graph. */
  applyTier(spec: TierSpec): void {
    const key = SkyDome.keyOf(spec);
    if (key === this.key) return;
    this.key = key;
    this.material.dispose();
    this.material = SkyDome.makeMaterial(spec);
    this.mesh.material = this.material;
  }

  follow(camera: Vector3): void { this.mesh.position.copy(camera); }

  /** Push a palette sample and the sun/moon directions into the shared uniforms. */
  apply(look: SkyLook, dirs: SkyDirs, flash: number): void {
    const set = (u: { value: Color }, c: [number, number, number]): void => { u.value.setRGB(c[0], c[1], c[2]); };
    set(fxU.skyZenith, look.zenith);
    set(fxU.skyHorizon, look.horizon);
    set(fxU.skyGlow, look.glow);
    set(fxU.sunColor, look.sunColor);
    fxU.sunDir.value.set(dirs.sun[0], dirs.sun[1], dirs.sun[2]);
    fxU.moonDir.value.set(dirs.moon[0], dirs.moon[1], dirs.moon[2]);
    fxU.night.value = look.night;
    fxU.starAlpha.value = look.starAlpha;
    fxU.flash.value = flash;
    fxU.ambient.value = Math.min(1, 0.12 + look.hemiIntensity * 0.3 + (1 - look.night) * 0.4);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
