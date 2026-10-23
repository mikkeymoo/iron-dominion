import { PerspectiveCamera, Scene, type WebGPURenderer } from 'three/webgpu';
import { CAMERA, type Pose } from './camera.ts';
import type { RenderMirror } from './mirror.ts';
import type { AgentStore } from './agentStore.ts';
import { BuildingsView } from './buildings.ts';
import { RobotsView } from './robots.ts';
import { Fx } from './fx/index.ts';
import { TerrainView } from './terrain.ts';
import { TIER_TABLE, type Tier } from './tier.ts';

/** Everything that lives in the three scene for one renderer. Rebuilt from the mirror after device loss. */
export class WorldScene {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(CAMERA.fovDeg, 1, 0.3, 2000);
  readonly fx: Fx;
  readonly terrain: TerrainView;
  readonly buildings: BuildingsView;
  readonly robots: RobotsView;
  private tier: Tier;

  constructor(private readonly renderer: WebGPURenderer, mirror: RenderMirror, search: string, tier: Tier, agents: AgentStore) {
    this.tier = tier;
    this.fx = new Fx(renderer, this.scene, this.camera, mirror, search, tier);
    this.terrain = new TerrainView(mirror, this.fx.water.material);
    this.scene.add(this.terrain.group);
    this.buildings = new BuildingsView(mirror, this.terrain);
    this.scene.add(this.buildings.group);
    this.robots = new RobotsView(agents, mirror, (kind, x, y, z, n) => this.fx.particles.emit(kind, x, y, z, n), tier);
    this.scene.add(this.robots.group);
    this.fx.attach(this.terrain, this.buildings);
    renderer.setClearColor(0xb4d4f0, 1);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.fx.setAspect(aspect);
  }

  applyTier(tier: Tier): void {
    const spec = TIER_TABLE[tier];
    this.fx.applyTier(tier);
    this.terrain.setShadows(spec.shadows !== 'blob');
    this.buildings.setTier(tier);
    this.robots.setTier(tier);
    this.tier = tier;
  }

  applyPose(p: Pose): void {
    this.camera.position.set(p.px, p.py, p.pz);
    this.camera.lookAt(p.tx, p.ty, p.tz);
    this.camera.updateMatrixWorld();
  }

  /** Per-frame atmosphere update: call after applyPose. */
  update(dt: number, nowSec: number, pose: Pose, dist: number, pitch: number): void {
    this.fx.update(dt, nowSec, pose, dist, pitch);
  }

  /** Draw the interpolated robots near the camera focus and their welding sparks (call after update, before render). */
  updateRobots(dt: number, nowMs: number, pose: Pose): void {
    this.robots.update(dt, nowMs, pose.tx, pose.tz, Math.floor(TIER_TABLE[this.tier].fx.emitters / 6));
  }

  render(): void { this.fx.render(); }

  async compile(): Promise<void> {
    await this.renderer.compileAsync(this.scene, this.camera);
  }

  dispose(): void {
    this.robots.dispose();
    this.fx.dispose();
    this.buildings.dispose();
    this.terrain.dispose();
  }
}
