// Atmosphere and post-processing manager: owns the sky, lights, water, weather, particles, streetlights and the post chain,
// and drives them once a frame from the sim clock and weather (read from the mirror) or from the ?time= / ?weather= debug overrides.
import { FogExp2, Vector3, type PerspectiveCamera, type Scene, type WebGPURenderer } from 'three/webgpu';
import { S, WEATHER } from '../../sim/layers.ts';
import type { Pose } from '../camera.ts';
import { surfaceHeight } from '../heightfield.ts';
import type { BuildingsView } from '../buildings.ts';
import type { EmitterRec } from '../instances.ts';
import type { RenderMirror } from '../mirror.ts';
import { TIER_TABLE, type Tier } from '../tier.ts';
import type { TerrainView } from '../terrain.ts';
import { Lamps } from './lamps.ts';
import { Lighting } from './lighting.ts';
import { skyLook, smoothstep } from './palette.ts';
import { ParticleSystem, type ParticleKind } from './particles.ts';
import { createPost, type Post } from './post.ts';
import { accumulate } from './ring.ts';
import { DayClock, moonDirection, sunDirection } from './skyClock.ts';
import { SkyDome } from './sky.ts';
import { focalRange, tiltStrength } from './tilt.ts';
import { fxU } from './uniforms.ts';
import { WaterSystem } from './water.ts';
import { WeatherFx } from './weather.ts';
import { parseWeatherParam, weatherName } from './weatherMap.ts';

/** Clear-sky exp2 fog density: nothing at city distances, full fade into the sky by ~1000 tiles. */
const BASE_FOG = 0.0015;
const MAX_EMIT_PER_FRAME = 240;
/** A skipped emitter makes up at most this much time when it is next serviced. */
const MAX_CATCHUP_S = 0.5;

export interface FxDebug {
  readonly dayFrac: number;
  readonly weather: string;
  readonly sunDir: [number, number, number];
  readonly postPasses: string[];
  readonly shadows: { mode: string; cascades: number; mapSize: number };
  readonly water: { mode: string; waves: number; planar: boolean };
  readonly particles: { live: number; budget: number; emitted: number; rain: number; snow: number };
  readonly lamps: number;
  readonly lightning: number;
  readonly exposure: number;
  readonly overrides: { time: boolean; weather: boolean };
  emit(kind: ParticleKind, x: number, y: number, z: number, count: number): number;
}

export class Fx {
  readonly sky: SkyDome;
  readonly lighting: Lighting;
  readonly water: WaterSystem;
  readonly weather: WeatherFx;
  readonly particles: ParticleSystem;
  readonly lamps: Lamps;
  private post!: Post;
  private readonly fog = new FogExp2(0xb4d4f0, BASE_FOG);
  private readonly clock = new DayClock(0.4);
  private readonly timeOverride: number | null;
  private readonly weatherOverride: { kind: number; intensity: number } | null;
  private readonly nightOverride: number | null;
  private tier: Tier;
  private terrain: TerrainView | null = null;
  private buildings: BuildingsView | null = null;
  private snapped = false;
  private nowSec = 0;
  private sun: [number, number, number] = [0, 1, 0];
  private exposure = 1;
  private emitStart = 0;
  private readonly inRange: EmitterRec[] = [];
  private readonly carry = new WeakMap<EmitterRec, { carry: number; t: number }>();
  private readonly focus = new Vector3();
  private readonly tmp = new Vector3();
  private readonly fwd = new Vector3();
  private aspect = 1.6;

  constructor(
    private readonly renderer: WebGPURenderer, private readonly scene: Scene, private readonly camera: PerspectiveCamera,
    private readonly mirror: RenderMirror, search: string, tier: Tier,
  ) {
    this.tier = tier;
    const q = new URLSearchParams(search);
    const t = q.get('time');
    this.timeOverride = t !== null && t !== '' && Number.isFinite(Number(t)) ? Number(t) - Math.floor(Number(t)) : null;
    this.weatherOverride = parseWeatherParam(q.get('weather'));
    const n = q.get('night');
    this.nightOverride = n !== null && n !== '' && Number.isFinite(Number(n)) ? Math.min(1, Math.max(0, Number(n))) : null;

    const spec = TIER_TABLE[this.tier];
    scene.fog = this.fog;
    this.sky = new SkyDome(spec);
    this.lighting = new Lighting(scene, renderer);
    this.water = new WaterSystem(mirror, scene);
    this.weather = new WeatherFx(spec);
    this.particles = new ParticleSystem(spec);
    this.lamps = new Lamps(mirror, spec);
    scene.add(this.sky.mesh, this.water.group, this.weather.group, this.particles.group, this.lamps.group);
    // The sky, weather, particles and lamps were just built for this tier; the rig, the water graph and the post chain are built once here.
    this.lighting.applyTier(spec);
    this.water.applyTier(spec);
    this.installReflectionGuard();
    this.post = createPost(renderer, scene, camera, spec);
  }

  /** Called once the terrain and buildings views exist. */
  attach(terrain: TerrainView, buildings: BuildingsView): void {
    this.terrain = terrain;
    this.buildings = buildings;
  }

  private install(spec: (typeof TIER_TABLE)[Tier]): void {
    this.lighting.applyTier(spec);
    this.water.applyTier(spec);
    this.sky.applyTier(spec);
    this.weather.applyTier(spec);
    this.particles.applyTier(spec);
    this.lamps.applyTier(spec);
    this.installReflectionGuard();
  }

  /**
   * The planar reflection renders the scene again from a mirrored camera. Shadow maps update once per camera per frame, so
   * without this guard every cascade would be rendered a second time for the reflection; it reuses the map the main view just drew.
   */
  private installReflectionGuard(): void {
    const refl = this.water.planar;
    if (!refl) return;
    const base = refl.reflector as unknown as { updateBefore: (f: unknown) => unknown; __guarded?: boolean };
    if (base.__guarded) return;
    const orig = base.updateBefore.bind(base);
    base.__guarded = true;
    base.updateBefore = (frame: unknown) => {
      const shadows = this.shadowObjects();
      const saved = shadows.map((s) => s.autoUpdate);
      for (const s of shadows) s.autoUpdate = false;
      try { return orig(frame); } finally { shadows.forEach((s, i) => { s.autoUpdate = saved[i]!; }); }
    };
  }

  private shadowObjects(): { autoUpdate: boolean }[] {
    const out: { autoUpdate: boolean }[] = [this.lighting.light.shadow];
    const csm = (this.lighting as unknown as { csm: { lights: { shadow: { autoUpdate: boolean } }[] } | null }).csm;
    if (csm) for (const l of csm.lights) out.push(l.shadow);
    return out;
  }

  applyTier(tier: Tier): void {
    if (tier === this.tier) return;
    this.tier = tier;
    const spec = TIER_TABLE[tier];
    this.install(spec);
    this.post.dispose();
    this.post = createPost(this.renderer, this.scene, this.camera, spec);
  }

  setAspect(aspect: number): void {
    this.aspect = aspect;
    this.lighting.onProjectionChange();
  }

  get dayFrac(): number { return this.clock.value; }

  private targetDayFrac(): number {
    if (this.timeOverride !== null) return this.timeOverride;
    return this.mirror.hasResync ? this.mirror.scalars[S.dayFrac]! : 0.4;
  }

  update(dt: number, nowSec: number, pose: Pose, camDist: number, pitch: number): void {
    this.nowSec = nowSec;
    const spec = TIER_TABLE[this.tier];

    const target = this.targetDayFrac();
    if (!this.snapped && (this.timeOverride !== null || this.mirror.hasResync)) { this.clock.snap(target); this.snapped = true; }
    this.clock.step(target, dt);

    const kind = this.weatherOverride ? this.weatherOverride.kind : Math.round(this.mirror.scalars[S.weather]!);
    const intensity = this.weatherOverride ? this.weatherOverride.intensity : this.mirror.scalars[S.weatherIntensity]!;
    this.focus.set(pose.tx, pose.ty, pose.tz);
    const flash = this.weather.update(dt, nowSec, kind, intensity, this.focus, camDist, this.camera);

    // A pinned weather owns the sky: sim strikes are dropped, and a pinned storm makes its own.
    const strikes = this.mirror.takeLightning();
    const last = strikes[strikes.length - 1];
    if (this.weatherOverride) {
      if (this.weatherOverride.kind === WEATHER.STORM && this.weather.syntheticDue(nowSec)) {
        const a = nowSec * 12.9898, r = 18 + ((Math.sin(a) * 43758.5453) % 1 + 1) % 1 * 40;
        const x = pose.tx + Math.cos(a) * r, z = pose.tz + Math.sin(a) * r;
        this.weather.strike(x, z, this.groundAt(x, z), this.camera, nowSec);
      }
    } else if (last && this.mirror.hasResync) {
      const x = last.x + 0.5, z = last.y + 0.5;
      this.weather.strike(x, z, this.groundAt(x, z), this.camera, nowSec);
    }

    const sun = sunDirection(this.clock.value), moon = moonDirection(this.clock.value);
    this.sun = sun;
    const st = this.weather.state;
    const look = skyLook(sun[1], moon[1], st.overcast, flash);
    this.sky.apply(look, { sun, moon }, flash);
    if (this.nightOverride !== null) fxU.night.value = this.nightOverride;
    const dayness = smoothstep(-0.12, 0.2, sun[1]);
    fxU.sunDisc.value = smoothstep(-0.045, 0.03, sun[1]) * (1 - st.overcast * 0.92);
    fxU.moonDisc.value = smoothstep(0, 0.12, moon[1]) * (1 - dayness) * (1 - st.overcast * 0.85);
    fxU.overcast.value = st.overcast;
    fxU.wet.value = st.wet;
    fxU.snow.value = st.snowCover;
    fxU.cloudCover.value = 0.3 + st.overcast * 0.62;
    fxU.cloudLit.value.setRGB(
      look.sunColor[0] * look.sunIntensity * 0.2 + look.hemiSky[0] * look.hemiIntensity * 0.42,
      look.sunColor[1] * look.sunIntensity * 0.2 + look.hemiSky[1] * look.hemiIntensity * 0.42,
      look.sunColor[2] * look.sunIntensity * 0.2 + look.hemiSky[2] * look.hemiIntensity * 0.42,
    );
    fxU.cloudShade.value.setRGB(look.hemiSky[0] * look.hemiIntensity * 0.3 + look.horizon[0] * 0.1, look.hemiSky[1] * look.hemiIntensity * 0.3 + look.horizon[1] * 0.1, look.hemiSky[2] * look.hemiIntensity * 0.3 + look.horizon[2] * 0.12);

    this.fog.color.setRGB(look.fogColor[0], look.fogColor[1], look.fogColor[2]);
    this.fog.density = BASE_FOG * st.fogMul;
    this.exposure = look.exposure * (1 - st.overcast * 0.2);
    this.renderer.toneMappingExposure = this.exposure;

    this.sky.follow(this.camera.position);
    this.lighting.update(look, sun, moon, this.focus, camDist);
    this.water.sync();
    this.water.update();
    this.lamps.update(pose.tx, pose.tz);
    this.emitContinuous(dt, pose, camDist, spec.fx.emitters);
    this.particles.update(dt);

    // Sun for the shaft pass: projected into screen uv, visible only when it is in front of the camera and above the horizon.
    const cam = this.camera;
    this.tmp.set(cam.position.x + sun[0] * 800, cam.position.y + sun[1] * 800, cam.position.z + sun[2] * 800).project(cam);
    const fwd = cam.getWorldDirection(this.fwd);
    const facing = fwd.x * sun[0] + fwd.y * sun[1] + fwd.z * sun[2];
    const shafts = smoothstep(0.05, 0.4, facing) * smoothstep(-0.02, 0.2, sun[1]) * (1 - st.overcast) * (1 - flash);
    this.post.setParams({
      tilt: tiltStrength(camDist, pitch),
      sunUv: [this.tmp.x * 0.5 + 0.5, this.tmp.y * 0.5 + 0.5],
      shafts,
      sunColor: [look.sunColor[0], look.sunColor[1], look.sunColor[2]],
      focusDist: camDist,
      focalRange: focalRange(camDist),
      aspect: this.aspect,
      night: look.night,
      overcast: st.overcast,
    });
  }

  private groundAt(x: number, z: number): number {
    const h = this.mirror.layers.height;
    return h ? Math.max(0, surfaceHeight(h, x, z)) : 0;
  }

  /** Service the stack-smoke and site-dust emitters near the camera focus, up to the tier's emitter count. */
  private emitContinuous(dt: number, pose: Pose, camDist: number, budget: number): void {
    const b = this.buildings;
    if (!b || budget <= 0 || dt <= 0) return;
    const nowSec = this.nowSec;
    const range = Math.min(260, Math.max(50, camDist * 1.6));
    const r2 = range * range;
    // Range first, so an emitter in range always gets its full rate; only when more are in range than the budget allows does a
    // rotating window skip some, and a skipped emitter catches up (bounded) the next time it is serviced.
    const inRange = this.inRange;
    inRange.length = 0;
    for (const recs of b.emitters.values()) {
      for (const rec of recs) {
        const dx = rec.x - pose.tx, dz = rec.z - pose.tz;
        if (dx * dx + dz * dz <= r2) inRange.push(rec);
      }
    }
    const n = inRange.length;
    if (n === 0) return;
    const count = Math.min(n, budget);
    if (n > budget) this.emitStart = (this.emitStart + budget) % n; else this.emitStart = 0;
    let emitted = 0;
    for (let k = 0; k < count && emitted < MAX_EMIT_PER_FRAME; k++) {
      const rec = inRange[(this.emitStart + k) % n]!;
      const s = this.carry.get(rec);
      const since = s ? Math.min(MAX_CATCHUP_S, Math.max(dt, nowSec - s.t)) : dt;
      const a = accumulate(s ? s.carry : Math.random(), rec.rate, since);
      this.carry.set(rec, { carry: a.carry, t: nowSec });
      const spread = rec.kind === 'dust' ? 0.45 : 0;
      for (let i = 0; i < a.emit && emitted < MAX_EMIT_PER_FRAME; i++, emitted++) {
        this.particles.emit(rec.kind, rec.x + (Math.random() - 0.5) * spread, rec.y, rec.z + (Math.random() - 0.5) * spread, 1);
      }
    }
  }

  render(): void { this.post.render(); }

  get debug(): FxDebug {
    const self = this;
    return {
      get dayFrac() { return self.clock.value; },
      get weather() { return weatherName(self.weatherOverride ? self.weatherOverride.kind : Math.round(self.mirror.scalars[S.weather]!)); },
      get sunDir() { return [...self.sun] as [number, number, number]; },
      get postPasses() { return [...self.post.passes]; },
      get shadows() { return { mode: self.lighting.shadowMode, cascades: self.lighting.cascadeCount, mapSize: TIER_TABLE[self.tier].shadowMapSize }; },
      get water() { return { mode: self.water.mode, waves: self.water.gerstnerWaves, planar: TIER_TABLE[self.tier].fx.reflectionScale > 0 }; },
      get particles() {
        const s = self.particles.stats;
        return { live: s.live + self.weather.liveRain + self.weather.liveSnow, budget: TIER_TABLE[self.tier].particleBudget, emitted: s.emitted, rain: self.weather.liveRain, snow: self.weather.liveSnow };
      },
      get lamps() { return self.lamps.count; },
      get lightning() { return self.weather.lightningStrikes; },
      get exposure() { return self.exposure; },
      get overrides() { return { time: self.timeOverride !== null, weather: self.weatherOverride !== null }; },
      emit: (kind, x, y, z, count) => self.particles.emit(kind, x, y, z, count),
    };
  }

  dispose(): void {
    this.post.dispose();
    this.lamps.dispose();
    this.particles.dispose();
    this.weather.dispose();
    this.water.dispose();
    this.lighting.dispose();
    this.sky.dispose();
    this.scene.fog = null;
  }
}
