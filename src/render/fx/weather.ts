// Weather visuals. Rain and snow are vertex-shader particles: every drop's position is a closed-form function of time and
// a static per-drop random vector, wrapped into a box that tiles around the camera focus. No per-frame simulation, no
// compute, no ping-pong buffers, so WebGL2 and WebGPU behave identically and each drop trivially "writes only itself".
// Lightning is a procedural camera-facing ribbon plus a sky/ambient flash envelope.
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedBufferGeometry,
  Mesh, MeshBasicNodeMaterial, type Camera,
} from 'three/webgpu';
import { attribute, cameraPosition, float, floor, fract, positionGeometry, positionWorld, smoothstep, time, uniform, vec3, vec4 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { TierSpec } from '../tier.ts';
import { fxU } from './uniforms.ts';
import {
  CLEAR_STATE, FLASH_SECONDS, boltPoints, flashEnvelope, stepWeather, weatherTargets, type WeatherState,
} from './weatherMap.ts';

// TSL node graphs are built dynamically; the published typings reject most mixed-type chains, so graph code is loosely typed.
type N = any;

const RAIN_HEIGHT = 70;
const BOLT_SEGMENTS = 16;

function randomAttribute(count: number, seed: number): InstancedBufferAttribute {
  const a = new Float32Array(count * 4);
  let s = seed >>> 0;
  for (let i = 0; i < a.length; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; a[i] = s / 4294967296; }
  return new InstancedBufferAttribute(a, 4);
}

function quad(y0: number, y1: number): BufferGeometry {
  const g = new InstancedBufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, y0, 0, 0.5, y0, 0, 0.5, y1, 0, -0.5, y1, 0]), 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

const wrapBox = (v: N, box: N): N => v.sub(box.mul(floor(v.div(box))));

export class WeatherFx {
  readonly group = new Group();
  state: WeatherState = { ...CLEAR_STATE };
  private readonly rainAlpha = uniform(0);
  private readonly snowAlpha = uniform(0);
  private readonly rain: Mesh;
  private readonly snow: Mesh;
  private readonly bolt: Mesh;
  private readonly boltPos: Float32Array;
  private readonly boltAlphaU = uniform(0);
  private maxDrops = 0;
  private strikeAt = -10;
  private strikeCount = 0;
  private nextSynthetic = 0;

  constructor(spec: TierSpec) {
    const rainMat = new MeshBasicNodeMaterial();
    rainMat.transparent = true; rainMat.depthWrite = false; rainMat.fog = false;
    const snowMat = new MeshBasicNodeMaterial();
    snowMat.transparent = true; snowMat.depthWrite = false; snowMat.fog = false;

    const box = fxU.weatherBox, center = fxU.weatherCenter;
    const drop = (rnd: N, fall: N, sway: N): { pos: N; fade: N } => {
      const phase = rnd.y.add(time.mul(fall).div(RAIN_HEIGHT));
      const y = float(RAIN_HEIGHT).mul(float(1).sub(fract(phase)));
      const slant = fxU.wind.mul(float(RAIN_HEIGHT).sub(y));
      const ux = wrapBox(rnd.x.mul(box).add(slant).add(sway.x).sub(center.x).add(box.mul(0.5)), box);
      const uz = wrapBox(rnd.z.mul(box).add(sway.y).sub(center.z).add(box.mul(0.5)), box);
      const edge = float(1).sub(smoothstep(0.36, 0.5, ux.div(box).sub(0.5).abs())).mul(float(1).sub(smoothstep(0.36, 0.5, uz.div(box).sub(0.5).abs())));
      const vert = smoothstep(0, 6, y).mul(float(1).sub(smoothstep(RAIN_HEIGHT - 8, RAIN_HEIGHT, y)));
      return { pos: vec3(center.x.add(ux).sub(box.mul(0.5)), center.y.sub(8).add(y), center.z.add(uz).sub(box.mul(0.5))), fade: edge.mul(vert) };
    };

    const rr = attribute('iRand', 'vec4');
    const rainFall = rr.w.mul(10).add(34);
    const rd = drop(rr, rainFall, vec3(0, 0, 0).xy);
    const rw = fxU.dropScale.mul(0.03), rl = fxU.dropScale.mul(1.2);
    rainMat.positionNode = rd.pos.add(vec3(fxU.cameraRight).mul(positionGeometry.x.mul(rw))).add(vec3(0, 1, 0).mul(positionGeometry.y.mul(rl)));
    rainMat.colorNode = vec4(vec3(0.74, 0.82, 0.96).mul(fxU.ambient.mul(0.8).add(0.2)), 1);
    // Drops close to the lens would be metres-long streaks on screen, so they fade out near the camera.
    const nearFade = smoothstep(4, 18, positionWorld.sub(cameraPosition).length());
    rainMat.opacityNode = rd.fade.mul(nearFade).mul(this.rainAlpha).mul(float(0.26).add(rr.z.mul(0.18)));

    const sw = attribute('iRand', 'vec4');
    const snowFall = sw.w.mul(1.6).add(2.0);
    const sway = vec3(time.mul(0.9).add(sw.y.mul(40)).sin().mul(0.7), time.mul(0.7).add(sw.x.mul(33)).cos().mul(0.7), 0).xy;
    const sd = drop(sw, snowFall, sway);
    const size = fxU.dropScale.mul(sw.w.mul(0.06).add(0.07));
    snowMat.positionNode = sd.pos.add(vec3(fxU.cameraRight).mul(positionGeometry.x.mul(size))).add(vec3(fxU.cameraUp).mul(positionGeometry.y.mul(size)));
    const r = positionGeometry.xy.mul(2).length();
    snowMat.colorNode = vec4(vec3(0.95, 0.97, 1).mul(fxU.ambient.mul(0.85).add(0.15)), 1);
    snowMat.opacityNode = smoothstep(1.0, 0.35, r).mul(sd.fade).mul(this.snowAlpha).mul(0.9);

    this.rain = new Mesh(quad(0, 1), rainMat);
    this.snow = new Mesh(quad(-0.5, 0.5), snowMat);
    for (const m of [this.rain, this.snow]) { m.frustumCulled = false; m.visible = false; m.renderOrder = 10; }
    this.rain.name = 'rain';
    this.snow.name = 'snow';

    const boltGeom = new BufferGeometry();
    this.boltPos = new Float32Array((BOLT_SEGMENTS + 1) * 4 * 3);
    const boltAlpha = new Float32Array((BOLT_SEGMENTS + 1) * 4);
    for (let i = 0; i <= BOLT_SEGMENTS; i++) { boltAlpha.set([1, 1, 0.22, 0.22], i * 4); }
    const bi: number[] = [];
    for (let i = 0; i < BOLT_SEGMENTS; i++) {
      for (const base of [0, 2]) {
        const a = i * 4 + base, b = (i + 1) * 4 + base;
        bi.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
    const pa = new BufferAttribute(this.boltPos, 3);
    pa.setUsage(DynamicDrawUsage);
    boltGeom.setAttribute('position', pa);
    boltGeom.setAttribute('a', new BufferAttribute(boltAlpha, 1));
    boltGeom.setIndex(bi);
    const boltMat = new MeshBasicNodeMaterial();
    boltMat.transparent = true; boltMat.depthWrite = false; boltMat.fog = false; boltMat.blending = AdditiveBlending;
    boltMat.side = 2;
    boltMat.colorNode = vec4(vec3(0.82, 0.88, 1).mul(7), 1);
    boltMat.opacityNode = attribute('a', 'float').mul(this.boltAlphaU);
    this.bolt = new Mesh(boltGeom, boltMat);
    this.bolt.frustumCulled = false;
    this.bolt.visible = false;
    this.bolt.renderOrder = 11;
    this.bolt.name = 'bolt';

    this.group.add(this.rain, this.snow, this.bolt);
    this.group.name = 'weather';
    this.applyTier(spec);
  }

  applyTier(spec: TierSpec): void {
    const n = spec.fx.weatherDrops;
    this.bolt.userData.enabled = spec.fx.lightningBolt;
    if (n === this.maxDrops) return;
    this.maxDrops = n;
    for (const [mesh, seed] of [[this.rain, 7771], [this.snow, 1331]] as const) {
      const old = mesh.geometry as InstancedBufferGeometry;
      old.dispose();
      const g = mesh === this.rain ? quad(0, 1) : quad(-0.5, 0.5);
      g.setAttribute('iRand', randomAttribute(n, seed));
      (g as InstancedBufferGeometry).instanceCount = 0;
      mesh.geometry = g;
    }
  }

  get liveRain(): number { return this.rain.visible ? (this.rain.geometry as InstancedBufferGeometry).instanceCount : 0; }
  get liveSnow(): number { return this.snow.visible ? (this.snow.geometry as InstancedBufferGeometry).instanceCount : 0; }
  get flash(): number { return flashEnvelope(this.sinceStrike); }
  private sinceStrike = 99;
  get lightningStrikes(): number { return this.strikeCount; }

  /** Advance the smoothed weather state; returns the lightning flash envelope. */
  update(dt: number, nowSec: number, kind: number, intensity: number, focus: { x: number; y: number; z: number }, camDist: number, camera: Camera): number {
    this.state = stepWeather(this.state, weatherTargets(kind, intensity), dt);
    const s = this.state;
    this.sinceStrike = nowSec - this.strikeAt;

    fxU.weatherCenter.value.set(focus.x, focus.y, focus.z);
    fxU.weatherBox.value = Math.min(170, Math.max(44, camDist * 1.5));
    fxU.dropScale.value = Math.min(3.2, Math.max(0.7, camDist / 55));
    fxU.wind.value = s.wind;
    camera.updateMatrixWorld();
    const e = camera.matrixWorld.elements;
    fxU.cameraRight.value.set(e[0]!, e[1]!, e[2]!).normalize();
    fxU.cameraUp.value.set(e[4]!, e[5]!, e[6]!).normalize();

    const rainN = Math.floor(this.maxDrops * s.rain), snowN = Math.floor(this.maxDrops * s.snow);
    this.rain.visible = rainN > 0;
    this.snow.visible = snowN > 0;
    (this.rain.geometry as InstancedBufferGeometry).instanceCount = rainN;
    (this.snow.geometry as InstancedBufferGeometry).instanceCount = snowN;
    this.rainAlpha.value = Math.min(1, 0.35 + s.rain * 0.9);
    this.snowAlpha.value = Math.min(1, 0.4 + s.snow * 0.8);

    const flash = flashEnvelope(this.sinceStrike);
    this.bolt.visible = this.bolt.userData.enabled === true && this.sinceStrike >= 0 && this.sinceStrike < FLASH_SECONDS;
    this.boltAlphaU.value = flash;
    return flash;
  }

  /** Strike at a world position; builds the ribbon facing the camera. */
  strike(x: number, z: number, groundY: number, camera: Camera, nowSec: number): void {
    this.strikeAt = nowSec;
    this.sinceStrike = 0;
    this.strikeCount++;
    const pts = boltPoints(x, z, groundY, groundY + 62, BOLT_SEGMENTS, this.strikeCount * 7919 + 13);
    camera.updateMatrixWorld();
    const e = camera.matrixWorld.elements;
    let rx = e[0]!, ry = e[1]!, rz = e[2]!;
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl; ry /= rl; rz /= rl;
    for (let i = 0; i <= BOLT_SEGMENTS; i++) {
      const taper = 0.25 + 0.75 * (1 - i / BOLT_SEGMENTS) ** 0.5;
      const core = 0.16 * taper, halo = 0.7 * taper;
      const px = pts[i * 3]!, py = pts[i * 3 + 1]!, pz = pts[i * 3 + 2]!;
      const set = (slot: number, w: number, sign: number): void => {
        const o = (i * 4 + slot) * 3;
        this.boltPos[o] = px + rx * w * sign; this.boltPos[o + 1] = py + ry * w * sign; this.boltPos[o + 2] = pz + rz * w * sign;
      };
      set(0, core, -1); set(1, core, 1); set(2, halo, -1); set(3, halo, 1);
    }
    (this.bolt.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
  }

  /** Pinned-storm stand-in for sim lightning events: a strike every 3 to 8 s near the focus. Returns true when one is due. */
  syntheticDue(nowSec: number): boolean {
    if (nowSec < this.nextSynthetic) return false;
    this.nextSynthetic = nowSec + 3 + ((this.strikeCount * 2654435761) % 5000) / 1000;
    return true;
  }

  dispose(): void {
    for (const m of [this.rain, this.snow, this.bolt]) {
      m.geometry.dispose();
      (m.material as MeshBasicNodeMaterial).dispose();
    }
  }
}
