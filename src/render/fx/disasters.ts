// Transient disaster visuals: a meteor streak with a burning tail, the impact flash, an expanding shockwave ring, debris and smoke
// bursts, and camera shake for quakes and impacts. The crater itself is terrain the sim lowered; fires, char and rubble are building
// state drawn by the building views. Everything here is driven by sim events the mirror queues.
import { AdditiveBlending, DoubleSide, Group, IcosahedronGeometry, Mesh, MeshBasicNodeMaterial, RingGeometry } from 'three/webgpu';
import type { BlockedEvent, DisasterEvent } from '../mirror.ts';
import { flashAt, flightProgress, meteorAt, ringAt, shakeOffset, type Shake } from './disasterMath.ts';
import type { ParticleSystem } from './particles.ts';

const POOL = 4;
const METEOR_GIVE_UP_SECONDS = 30;
const RING_SECONDS = 1.8;
const FLASH_SECONDS = 0.7;
const MAX_SHAKES = 6;

interface Flight { from: [number, number, number]; to: [number, number, number]; t0: number; startTick: number; impactTick: number; u: number; landed: boolean }
interface Pulse { x: number; y: number; z: number; radius: number; t0: number }

export interface DisasterStats { meteors: number; rings: number; flashes: number; shakes: number; impacts: number; quakes: number; blocks: number }

export class DisasterFx {
  readonly group = new Group();
  private readonly flights: Flight[] = [];
  private readonly rings: Pulse[] = [];
  private readonly flashes: Pulse[] = [];
  private shakes: Shake[] = [];
  private readonly ringMeshes: Mesh[] = [];
  private readonly flashMeshes: Mesh[] = [];
  private readonly mats: MeshBasicNodeMaterial[] = [];
  private carry = 0;
  private impacts = 0;
  private quakes = 0;
  private blocks = 0;

  constructor(private readonly particles: ParticleSystem, private readonly ground: (x: number, z: number) => number) {
    this.group.name = 'disasters';
    const ringGeo = new RingGeometry(0.92, 1, 72).rotateX(-Math.PI / 2);
    const flashGeo = new IcosahedronGeometry(1, 2);
    for (let i = 0; i < POOL; i++) {
      const rm = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide, fog: false });
      rm.color.setRGB(1.6, 1.1, 0.7);
      const ring = new Mesh(ringGeo, rm);
      ring.visible = false; ring.frustumCulled = false; ring.renderOrder = 15;
      const fm = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending, fog: false });
      fm.color.setRGB(4, 2.6, 1.2);
      const flash = new Mesh(flashGeo, fm);
      flash.visible = false; flash.frustumCulled = false; flash.renderOrder = 16;
      this.mats.push(rm, fm);
      this.ringMeshes.push(ring); this.flashMeshes.push(flash);
      this.group.add(ring, flash);
    }
  }

  get stats(): DisasterStats {
    return { meteors: this.flights.length, rings: this.rings.length, flashes: this.flashes.length, shakes: this.shakes.length, impacts: this.impacts, quakes: this.quakes, blocks: this.blocks };
  }

  /** React to a sim disaster event. `nowSec` is the render clock. Fires need nothing here: they are building state. */
  handle(e: DisasterEvent, nowSec: number): void {
    const y = this.ground(e.x + 0.5, e.y + 0.5);
    if (e.kind === 'meteor' && e.phase === 'start') {
      // Comes in from the side the hash of the target picks, high and shallow so the streak crosses the screen.
      const a = ((e.x * 73 + e.y * 151) % 360) * (Math.PI / 180);
      this.flights.push({
        from: [e.x + 0.5 + Math.cos(a) * 70, y + 95, e.y + 0.5 + Math.sin(a) * 70], to: [e.x + 0.5, y, e.y + 0.5], t0: nowSec,
        startTick: e.tick, impactTick: e.impactTick, u: 0, landed: false,
      });
    } else if (e.kind === 'meteor') {
      for (const f of this.flights) f.landed = true;
      this.impacts++;
      this.pulse(this.rings, e, y, e.radius * 4, nowSec);
      this.pulse(this.flashes, e, y, e.radius * 0.9, nowSec);
      const cx = e.x + 0.5, cz = e.y + 0.5;
      this.particles.emit('debris', cx, y + 0.3, cz, 48);
      this.particles.emit('fire', cx, y + 0.3, cz, 44);
      this.particles.emit('spark', cx, y + 0.4, cz, 44);
      this.particles.emit('smoke', cx, y + 0.3, cz, 36);
      this.addShake(e.x, e.y, 1, 1.6, 60, nowSec);
    } else if (e.kind === 'quake') {
      this.quakes++;
      this.particles.emit('dust', e.x + 0.5, y + 0.1, e.y + 0.5, 40);
      this.addShake(e.x, e.y, 0.85, 2.8, e.radius * 5, nowSec);
    }
  }

  /** A Lightning Rod took a bolt (sparks and a small flash on the mast) or a Shield Dome stopped a meteor (a wide ring and sparks high over the field). */
  handleBlocked(e: BlockedEvent, nowSec: number): void {
    const y = this.ground(e.x + 0.5, e.y + 0.5);
    const cx = e.x + 0.5, cz = e.y + 0.5;
    if (e.by === 'rod') {
      this.pulse(this.flashes, e, y + 1.1, 0.9, nowSec);
      this.particles.emit('spark', cx, y + 1.2, cz, 28);
    } else {
      this.pulse(this.rings, e, y + 6, 11, nowSec);
      this.pulse(this.flashes, e, y + 6, 3.2, nowSec);
      this.particles.emit('spark', cx, y + 6, cz, 48);
    }
    this.blocks++;
  }

  private pulse(list: Pulse[], e: { x: number; y: number }, y: number, radius: number, nowSec: number): void {
    list.push({ x: e.x + 0.5, y, z: e.y + 0.5, radius, t0: nowSec });
    if (list.length > POOL) list.shift();
  }

  private addShake(x: number, z: number, amp: number, dur: number, reach: number, nowSec: number): void {
    this.shakes.push({ x, z, t0: nowSec, dur, amp, reach });
    if (this.shakes.length > MAX_SHAKES) this.shakes.shift();
  }

  /** Camera translation to add this frame (tile units). */
  shake(nowSec: number, focusX: number, focusZ: number, dist: number): [number, number, number] {
    return shakeOffset(this.shakes, nowSec, focusX, focusZ, dist);
  }

  /** `tick` is the sim tick the mirror last applied; the meteor streak follows it. */
  update(dt: number, nowSec: number, tick: number): void {
    this.shakes = this.shakes.filter((s) => nowSec - s.t0 < s.dur);
    this.carry += dt * 90;
    const n = Math.floor(this.carry);
    this.carry -= n;
    for (let i = this.flights.length - 1; i >= 0; i--) {
      const f = this.flights[i]!;
      // A paused or resynced sim can strand a flight whose impact never arrives; wall time is only the backstop.
      if (f.u >= 1 || nowSec - f.t0 > METEOR_GIVE_UP_SECONDS) { this.flights.splice(i, 1); continue; }
      f.u = flightProgress(f.u, dt, tick, f.startTick, f.impactTick, f.landed);
      const u = f.u;
      const [x, y, z] = meteorAt(f.from, f.to, u);
      const back = meteorAt(f.from, f.to, Math.max(0, u - 0.04));
      const dx = back[0] - x, dy = back[1] - y, dz = back[2] - z, len = Math.hypot(dx, dy, dz) || 1;
      // The head is a dense knot of flame; the tail is smoke and sparks thrown backwards along the path.
      this.particles.emit('fire', x, y, z, Math.max(1, Math.floor(n * 0.5)));
      this.particles.emitJet('smoke', x, y, z, dx / len, dy / len, dz / len, 5, 1.2, Math.max(1, Math.floor(n * 0.3)));
      this.particles.emitJet('spark', x, y, z, dx / len, dy / len, dz / len, 7, 2.5, Math.max(1, Math.floor(n * 0.25)));
    }
    for (let i = 0; i < POOL; i++) {
      const r = this.rings[i], ring = this.ringMeshes[i]!, rm = this.mats[i * 2]!;
      const u = r ? (nowSec - r.t0) / RING_SECONDS : 2;
      if (r && u < 1) {
        const s = ringAt(u, r.radius);
        ring.visible = true;
        ring.position.set(r.x, r.y + 0.2, r.z);
        ring.scale.setScalar(Math.max(0.01, s.radius));
        rm.opacity = s.opacity;
      } else ring.visible = false;
      const f = this.flashes[i], flash = this.flashMeshes[i]!, fm = this.mats[i * 2 + 1]!;
      const fu = f ? (nowSec - f.t0) / FLASH_SECONDS : 2;
      if (f && fu < 1) {
        const fs = flashAt(fu);
        flash.visible = true;
        flash.position.set(f.x, f.y + f.radius * 0.5, f.z);
        flash.scale.setScalar(Math.max(0.01, f.radius * fs.scale));
        fm.opacity = fs.opacity;
      } else flash.visible = false;
    }
    while (this.rings.length > 0 && nowSec - this.rings[0]!.t0 >= RING_SECONDS) this.rings.shift();
    while (this.flashes.length > 0 && nowSec - this.flashes[0]!.t0 >= FLASH_SECONDS) this.flashes.shift();
  }

  dispose(): void {
    this.ringMeshes[0]?.geometry.dispose();
    this.flashMeshes[0]?.geometry.dispose();
    for (const m of this.mats) m.dispose();
  }
}
