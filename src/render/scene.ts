import { PerspectiveCamera, Scene, type WebGPURenderer } from 'three/webgpu';
import { CAMERA, type Pose } from './camera.ts';
import type { RenderMirror } from './mirror.ts';
import type { AgentStore } from './agentStore.ts';
import { BuildingsView } from './buildings.ts';
import { RobotsView } from './robots.ts';
import { TrafficView } from './traffic.ts';
import { Fx } from './fx/index.ts';
import { LinesView } from './lines.ts';
import { OutageIcons } from './outageIcons.ts';
import { OverlayView } from './overlay.ts';
import { TerrainView } from './terrain.ts';
import { TIER_TABLE, type Tier } from './tier.ts';
import type { ViewState } from './viewState.ts';

/** Everything that lives in the three scene for one renderer. Rebuilt from the mirror after device loss. */
export class WorldScene {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(CAMERA.fovDeg, 1, 0.3, 2000);
  readonly fx: Fx;
  readonly terrain: TerrainView;
  readonly buildings: BuildingsView;
  readonly lines: LinesView;
  readonly icons: OutageIcons;
  readonly overlay: OverlayView;
  private viewVersion = -1;
  private iconVersion = -1;
  private under = false;
  readonly robots: RobotsView;
  readonly traffic: TrafficView;
  private tier: Tier;

  constructor(private readonly renderer: WebGPURenderer, mirror: RenderMirror, search: string, tier: Tier, agents: AgentStore) {
    this.tier = tier;
    this.fx = new Fx(renderer, this.scene, this.camera, mirror, search, tier);
    this.terrain = new TerrainView(mirror, this.fx.water.material);
    this.scene.add(this.terrain.group);
    this.buildings = new BuildingsView(mirror, this.terrain);
    this.scene.add(this.buildings.group);
    this.lines = new LinesView(mirror);
    this.scene.add(this.lines.group);
    this.icons = new OutageIcons();
    this.scene.add(this.icons.mesh);
    this.overlay = new OverlayView(mirror, this.terrain.slots);
    this.robots = new RobotsView(agents, mirror, (kind, x, y, z, n) => this.fx.particles.emit(kind, x, y, z, n), tier);
    this.scene.add(this.robots.group);
    this.traffic = new TrafficView(agents, mirror);
    this.scene.add(this.traffic.group);
    this.fx.attach(this.terrain, this.buildings);
    renderer.setClearColor(0xb4d4f0, 1);
  }

  get underground(): boolean { return this.under; }

  /**
   * Per-frame utilities visuals: apply the view mode (overlay choice, underground cutaway), repaint the overlay texture from the
   * mirror, rebuild pylons, cables and pipes that changed, and refresh the outage icons.
   */
  updateUtilities(view: ViewState | undefined, nowSec: number, cameraDist: number): void {
    if (view && view.version !== this.viewVersion) {
      this.viewVersion = view.version;
      this.under = view.underground;
      this.terrain.setCutaway(this.under);
      this.lines.setUnderground(this.under);
      this.buildings.group.visible = !this.under;
      this.icons.setVisible(!this.under);
    }
    this.overlay.update(view?.effectiveOverlay ?? 'none');
    this.lines.update(nowSec);
    if (this.buildings.outageVersion !== this.iconVersion) {
      this.iconVersion = this.buildings.outageVersion;
      this.icons.setRecords(this.buildings.outages.values());
    }
    this.icons.tick(nowSec, cameraDist);
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

  /** Draw the interpolated vehicles near the camera focus: the tier's visible-agent cap minus the robots already drawn (call after updateRobots). */
  updateTraffic(nowMs: number, pose: Pose, dist: number): void {
    this.traffic.update(nowMs, pose.tx, pose.tz, TIER_TABLE[this.tier].visibleAgents - this.robots.snapshot.visible, dist);
  }

  render(): void { this.fx.render(); }

  async compile(): Promise<void> {
    await this.renderer.compileAsync(this.scene, this.camera);
  }

  dispose(): void {
    this.traffic.dispose();
    this.robots.dispose();
    this.fx.dispose();
    this.icons.dispose();
    this.lines.dispose();
    this.buildings.dispose();
    this.terrain.dispose();
  }
}
