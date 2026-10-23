import {
  BackSide, DirectionalLight, HemisphereLight, Mesh, MeshBasicNodeMaterial, PerspectiveCamera, Scene, SphereGeometry,
  type WebGPURenderer,
} from 'three/webgpu';
import { color, mix, positionLocal, smoothstep } from 'three/tsl';
import { CAMERA, type Pose } from './camera.ts';
import { createPipeline, type Pipeline } from './pipeline.ts';
import type { RenderMirror } from './mirror.ts';
import { BuildingsView } from './buildings.ts';
import { TerrainView } from './terrain.ts';
import { TIER_TABLE, type Tier } from './tier.ts';

export const SKY_HORIZON = 0xb4d4f0;
const SUN_DIR = { x: 0.55, y: 0.8, z: 0.35 };
const SHADOW_RADIUS = 110;

function createSky(): Mesh {
  const m = new MeshBasicNodeMaterial();
  m.side = BackSide;
  m.depthWrite = false;
  m.fog = false;
  const up = positionLocal.normalize().y;
  const horizon = color(SKY_HORIZON);
  const zenith = color(0x3f7fd0);
  const below = color(0x9db8cf);
  m.colorNode = mix(mix(below, horizon, smoothstep(-0.35, 0, up)), zenith, smoothstep(0.02, 0.7, up));
  const sky = new Mesh(new SphereGeometry(900, 32, 16), m);
  sky.name = 'sky';
  sky.renderOrder = -1000;
  sky.frustumCulled = false;
  return sky;
}

/** Everything that lives in the three scene for one renderer. Rebuilt from the mirror after device loss. */
export class WorldScene {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(CAMERA.fovDeg, 1, 0.3, 2000);
  readonly terrain: TerrainView;
  readonly buildings: BuildingsView;
  readonly sun = new DirectionalLight(0xfff1d6, 2.6);
  readonly hemi = new HemisphereLight(0xa8ccf0, 0x7d6b50, 1.1);
  private readonly sky = createSky();
  private readonly pipeline: Pipeline;

  constructor(private readonly renderer: WebGPURenderer, mirror: RenderMirror) {
    const s = this.scene;
    s.add(this.sky, this.sun, this.sun.target, this.hemi);
    this.terrain = new TerrainView(mirror);
    s.add(this.terrain.group);
    this.buildings = new BuildingsView(mirror, this.terrain);
    s.add(this.buildings.group);
    this.sun.position.set(SUN_DIR.x, SUN_DIR.y, SUN_DIR.z).multiplyScalar(200);
    const sh = this.sun.shadow;
    sh.camera.left = -SHADOW_RADIUS; sh.camera.right = SHADOW_RADIUS; sh.camera.top = SHADOW_RADIUS; sh.camera.bottom = -SHADOW_RADIUS;
    sh.camera.near = 1; sh.camera.far = 500;
    sh.bias = -0.0004; sh.normalBias = 0.5;
    renderer.setClearColor(SKY_HORIZON, 1);
    this.pipeline = createPipeline(renderer, s, this.camera);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  applyTier(tier: Tier): void {
    const spec = TIER_TABLE[tier];
    const shadows = spec.shadows !== 'blob';
    this.renderer.shadowMap.enabled = shadows;
    this.sun.castShadow = shadows;
    if (shadows) {
      this.sun.shadow.mapSize.set(spec.shadowMapSize, spec.shadowMapSize);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.terrain.setShadows(shadows);
    this.buildings.setTier(tier);
  }

  applyPose(p: Pose): void {
    this.camera.position.set(p.px, p.py, p.pz);
    this.camera.lookAt(p.tx, p.ty, p.tz);
    this.sky.position.copy(this.camera.position);
    this.sun.target.position.set(p.tx, p.ty, p.tz);
    this.sun.position.set(p.tx + SUN_DIR.x * 200, p.ty + SUN_DIR.y * 200, p.tz + SUN_DIR.z * 200);
    this.sun.target.updateMatrixWorld();
  }

  render(): void { this.pipeline.render(); }

  async compile(): Promise<void> {
    await this.renderer.compileAsync(this.scene, this.camera);
  }

  dispose(): void {
    this.pipeline.dispose();
    this.buildings.dispose();
    this.terrain.dispose();
    this.sky.geometry.dispose();
    (this.sky.material as MeshBasicNodeMaterial).dispose();
  }
}
