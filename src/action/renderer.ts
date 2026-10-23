import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { EDGES } from '../game/world';
import { BOT_DEFS, BOUNDS, CORE_PAD, CORE_RADIUS, PAD_RADIUS, type ActionState, type Bot, type BotKind, type Fx, type Pad, type PickupKind, type Team } from './sim';

export const TEAM_HEX: Record<Team, number> = {
  player: 0x7be8df, red: 0xff5468, amber: 0xffb43c, green: 0x9be06a, rogue: 0xb68cff, neutral: 0x75808b,
};
const SKY = 0x070b10;
const MAX_BOLTS = 900, MAX_ORBS = 500, MAX_MISSILES = 80, MAX_SHELLS = 60;

type Quality = 'high' | 'low';

/** CPU-driven point particles drawn in one call. */
class Particles {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private max: Float32Array;
  private base: Float32Array;
  private grav: Float32Array;
  private rgb: Float32Array;
  private next = 0;
  private uniforms: { uScale: { value: number } };

  constructor(private n: number, blending: THREE.Blending, private fadeAlpha: number) {
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(n * 3);
    this.col = new Float32Array(n * 4);
    this.size = new Float32Array(n);
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.max = new Float32Array(n).fill(1);
    this.base = new Float32Array(n);
    this.grav = new Float32Array(n);
    this.rgb = new Float32Array(n * 3);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('psize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.uniforms = { uScale: { value: 400 } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending,
      vertexShader: `attribute vec4 pcolor;attribute float psize;uniform float uScale;varying vec4 vC;
        void main(){vC=pcolor;vec4 mv=modelViewMatrix*vec4(position,1.0);gl_PointSize=psize*uScale/-mv.z;gl_Position=projectionMatrix*mv;}`,
      fragmentShader: `varying vec4 vC;void main(){float d=length(gl_PointCoord-0.5);float a=smoothstep(0.5,0.05,d);if(a<0.01)discard;gl_FragColor=vec4(vC.rgb,vC.a*a);}`,
    });
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
  }

  setScale(v: number) { this.uniforms.uScale.value = v; }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, color: THREE.Color, gravity = 0) {
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = life; this.max[i] = life; this.base[i] = size; this.grav[i] = gravity;
    this.rgb[i * 3] = color.r; this.rgb[i * 3 + 1] = color.g; this.rgb[i * 3 + 2] = color.b;
  }

  update(dt: number) {
    const drag = Math.exp(-2.2 * dt);
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) { this.size[i] = 0; this.col[i * 4 + 3] = 0; continue; }
      this.life[i] -= dt;
      const k = Math.max(0, this.life[i] / this.max[i]);
      this.vel[i * 3] *= drag; this.vel[i * 3 + 2] *= drag;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * drag - this.grav[i] * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] = Math.max(0.05, this.pos[i * 3 + 1] + this.vel[i * 3 + 1] * dt);
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] = this.base[i] * (this.fadeAlpha < 0 ? 1 + (1 - k) * 1.5 : 0.4 + 0.6 * k);
      this.col[i * 4] = this.rgb[i * 3]; this.col[i * 4 + 1] = this.rgb[i * 3 + 1]; this.col[i * 4 + 2] = this.rgb[i * 3 + 2];
      this.col[i * 4 + 3] = k * Math.abs(this.fadeAlpha);
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.pcolor.needsUpdate = true;
    g.attributes.psize.needsUpdate = true;
  }
}

interface BotView {
  group: THREE.Group;
  body: THREE.MeshStandardMaterial;
  legs: THREE.Object3D[];
  turret?: THREE.Object3D;
  phase: number;
}

interface Wave { mesh: THREE.Mesh; t: number; dur: number; scale: number }
interface Flash { light: THREE.PointLight; t: number; peak: number }

function labelTexture(text: string, color: string) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 96;
  const g = c.getContext('2d')!;
  g.font = '700 46px Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 8;
  g.strokeStyle = 'rgba(0,0,0,0.75)';
  g.strokeText(text.toUpperCase(), 256, 48);
  g.fillStyle = color;
  g.fillText(text.toUpperCase(), 256, 48);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function groundTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#1a242b';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 900; i++) {
    const v = 20 + Math.random() * 16;
    g.fillStyle = `rgb(${v},${v + 6},${v + 10})`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 2 + Math.random() * 4, 2 + Math.random() * 4);
  }
  g.strokeStyle = '#2a3d48';
  g.lineWidth = 3;
  g.strokeRect(0, 0, 256, 256);
  g.strokeStyle = '#22323c';
  g.lineWidth = 1;
  g.beginPath(); g.moveTo(128, 0); g.lineTo(128, 256); g.moveTo(0, 128); g.lineTo(256, 128); g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(BOUNDS.x * 2.4 / 16, BOUNDS.z * 2.4 / 16);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export class ArenaRenderer {
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(50, 1, 0.5, 600);
  private sun: THREE.DirectionalLight;
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private trauma = 0;
  private time = 0;
  private sparks: Particles;
  private smoke: Particles;
  private waves: Wave[] = [];
  private flashes: Flash[] = [];
  private bots = new Map<number, BotView>();
  private pickups = new Map<number, THREE.Object3D>();
  private pads: { pad: Pad; owner: Team; ring: THREE.Mesh; progress: THREE.Mesh; beam: THREE.Mesh; accent: THREE.MeshStandardMaterial; label: THREE.Sprite; turret?: THREE.Object3D; spinner?: THREE.Object3D }[] = [];
  private mech!: { root: THREE.Group; legs: THREE.Group; torso: THREE.Group; thighs: THREE.Object3D[]; shield: THREE.Mesh; body: THREE.MeshStandardMaterial; guns: THREE.Object3D[]; phase: number; recoil: number };
  private core!: { root: THREE.Group; heart: THREE.Mesh; rings: THREE.Object3D[]; shield: THREE.Mesh; mat: THREE.MeshStandardMaterial; crater: THREE.Mesh };
  private bolts: THREE.InstancedMesh;
  private orbs: THREE.InstancedMesh;
  private missiles: THREE.InstancedMesh;
  private shells: THREE.InstancedMesh;
  private markers: THREE.InstancedMesh;
  private markerMat: THREE.MeshBasicMaterial;
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();
  private teamColors = Object.fromEntries(Object.entries(TEAM_HEX).map(([k, v]) => [k, new THREE.Color(v)])) as Record<Team, THREE.Color>;
  private width = 1;
  private height = 1;
  private mechHit = 0;

  constructor(private container: HTMLElement, state: ActionState, private quality: Quality) {
    this.renderer = new THREE.WebGLRenderer({ antialias: quality === 'high', powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality === 'high' ? 1.75 : 1));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = quality === 'high' ? 1.15 : 1.45;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = quality === 'high';
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.className = 'arena-canvas';
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(SKY);
    this.scene.fog = new THREE.FogExp2(SKY, 0.0075);
    this.scene.add(new THREE.HemisphereLight(0x9cc4d4, 0x1a2228, quality === 'high' ? 1.3 : 2));
    this.sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
    this.sun.castShadow = quality === 'high';
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -45; sc.right = 45; sc.top = 45; sc.bottom = -45; sc.near = 1; sc.far = 160;
    this.sun.shadow.bias = -0.0008;
    this.scene.add(this.sun, this.sun.target);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(BOUNDS.x * 2.4, BOUNDS.z * 2.4),
      new THREE.MeshStandardMaterial({ map: groundTexture(), roughness: 0.92, metalness: 0.25 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    this.sparks = new Particles(quality === 'high' ? 3500 : 1800, THREE.AdditiveBlending, 1);
    this.smoke = new Particles(quality === 'high' ? 900 : 400, THREE.NormalBlending, -0.55);
    this.scene.add(this.smoke.points, this.sparks.points);

    for (let i = 0; i < 6; i++) {
      const light = new THREE.PointLight(0xffaa55, 0, 40, 1.6);
      this.scene.add(light);
      this.flashes.push({ light, t: 0, peak: 0 });
    }
    const ringGeo = new THREE.RingGeometry(0.85, 1, 48);
    for (let i = 0; i < 14; i++) {
      const mesh = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      this.scene.add(mesh);
      this.waves.push({ mesh, t: 1, dur: 1, scale: 1 });
    }

    const glow = (geo: THREE.BufferGeometry, n: number) => {
      const m = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ toneMapped: false }), n);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.setColorAt(0, new THREE.Color());
      m.frustumCulled = false;
      m.count = 0;
      this.scene.add(m);
      return m;
    };
    this.bolts = glow(new THREE.BoxGeometry(0.22, 0.22, 2.2), MAX_BOLTS);
    this.orbs = glow(new THREE.IcosahedronGeometry(0.6, 1), MAX_ORBS);
    this.missiles = glow(new THREE.CylinderGeometry(0.18, 0.28, 1.4, 6).rotateX(Math.PI / 2), MAX_MISSILES);
    this.shells = glow(new THREE.SphereGeometry(0.55, 10, 8), MAX_SHELLS);
    this.markerMat = new THREE.MeshBasicMaterial({ color: 0xff4040, transparent: true, opacity: 0.6, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
    this.markers = new THREE.InstancedMesh(new THREE.RingGeometry(0.8, 1, 40).rotateX(-Math.PI / 2), this.markerMat, MAX_SHELLS);
    this.markers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.markers.frustumCulled = false;
    this.markers.count = 0;
    this.scene.add(this.markers);

    this.buildWorld(state);
    this.buildMech();
    this.buildCore(state);

    if (quality === 'high') {
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.85, 0.45, 0.72));
      this.composer.addPass(new OutputPass());
    }
    this.resize();
    const m = state.mech;
    this.camLook.set(m.x, 0, m.z);
    this.camPos.set(m.x, 31, m.z + 22);
  }

  private std(color: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) {
    return new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.6, ...extra });
  }

  private mesh(geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0, cast = true) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = cast && this.quality === 'high';
    m.receiveShadow = this.quality === 'high';
    return m;
  }

  private buildWorld(state: ActionState) {
    const road = this.std(0x1a242c, { roughness: 0.8, metalness: 0.2 });
    const strip = new THREE.MeshBasicMaterial({ color: 0x1f5058, toneMapped: false });
    for (const [a, b] of EDGES) {
      const pa = state.pads[a], pb = state.pads[b];
      const len = Math.hypot(pb.x - pa.x, pb.z - pa.z);
      const ang = Math.atan2(pb.x - pa.x, pb.z - pa.z);
      const r = this.mesh(new THREE.BoxGeometry(5, 0.08, len), road, (pa.x + pb.x) / 2, 0.04, (pa.z + pb.z) / 2, false);
      r.rotation.y = ang;
      const st = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.1, len - PAD_RADIUS * 2), strip);
      st.position.copy(r.position).setY(0.06);
      st.rotation.y = ang;
      this.scene.add(r, st);
    }
    const rockMat = this.std(0x2b343b, { flatShading: true, roughness: 0.9, metalness: 0.15 });
    for (const k of state.rocks) {
      const rock = this.mesh(new THREE.DodecahedronGeometry(k.r, 0), rockMat, k.x, k.r * 0.45, k.z);
      rock.scale.y = 0.7 + ((k.x * 13 + k.z * 7) % 1 + 1) % 1 * 0.8;
      rock.rotation.set(k.x, k.z, 0);
      this.scene.add(rock);
    }
    // Fence posts glowing at the arena edge.
    const fence = new THREE.MeshBasicMaterial({ color: 0xff3355, toneMapped: false });
    const postGeo = new THREE.BoxGeometry(0.5, 3, 0.5);
    const posts = new THREE.InstancedMesh(postGeo, this.std(0x222b31), 200);
    const caps = new THREE.InstancedMesh(new THREE.BoxGeometry(0.6, 0.3, 0.6), fence, 200);
    let n = 0;
    const place = (x: number, z: number) => {
      this.dummy.position.set(x, 1.5, z); this.dummy.rotation.set(0, 0, 0); this.dummy.scale.set(1, 1, 1); this.dummy.updateMatrix();
      posts.setMatrixAt(n, this.dummy.matrix);
      this.dummy.position.y = 3.1; this.dummy.updateMatrix();
      caps.setMatrixAt(n, this.dummy.matrix);
      n++;
    };
    const ex = BOUNDS.x + 2, ez = BOUNDS.z + 2;
    for (let x = -ex; x <= ex && n < 200; x += 9) { place(x, -ez); place(x, ez); }
    for (let z = -ez + 9; z < ez && n < 200; z += 9) { place(-ex, z); place(ex, z); }
    posts.count = caps.count = n;
    this.scene.add(posts, caps);
    // Ruined skyline beyond the fence.
    const ruin = this.std(0x161e24, { roughness: 0.95 });
    const win = new THREE.MeshBasicMaterial({ color: 0x2d6f78, toneMapped: false });
    for (let i = 0; i < 70; i++) {
      const a = (i / 70) * Math.PI * 2;
      const rx = Math.sin(a) * (BOUNDS.x + 30 + (i * 37) % 40), rz = Math.cos(a) * (BOUNDS.z + 30 + (i * 53) % 40);
      const h = 8 + ((i * 29) % 30);
      const w = 6 + (i * 11) % 10;
      const t = this.mesh(new THREE.BoxGeometry(w, h, w), ruin, rx, h / 2, rz, false);
      t.rotation.y = a;
      this.scene.add(t);
      if (i % 3 === 0) { const l = new THREE.Mesh(new THREE.BoxGeometry(w + 0.1, 0.4, 0.6), win); l.position.set(rx, h * 0.7, rz); l.rotation.y = a; this.scene.add(l); }
    }
    const base = this.std(0x1d272e, { metalness: 0.8, roughness: 0.4 });
    const dark = this.std(0x0f1519, { metalness: 0.5 });
    for (const pad of state.pads) {
      if (pad.id === CORE_PAD) { this.addPadDecor(pad, null, null); continue; }
      const g = new THREE.Group();
      g.position.set(pad.x, 0, pad.z);
      g.add(this.mesh(new THREE.CylinderGeometry(PAD_RADIUS, PAD_RADIUS + 0.6, 0.45, 6), base, 0, 0.22, 0, false));
      g.add(this.mesh(new THREE.CylinderGeometry(PAD_RADIUS - 1.4, PAD_RADIUS - 1.4, 0.5, 6), dark, 0, 0.27, 0, false));
      const accent = new THREE.MeshStandardMaterial({ color: 0x0a0f12, emissive: TEAM_HEX[pad.owner], emissiveIntensity: 1.6, roughness: 0.4, metalness: 0.3 });
      let turret: THREE.Object3D | undefined, spinner: THREE.Object3D | undefined;
      const metal = this.std(0x3a4750);
      if (pad.kind === 'hq') {
        g.add(this.mesh(new THREE.BoxGeometry(7, 2.6, 7), metal, 0, 1.6, 0));
        g.add(this.mesh(new THREE.BoxGeometry(7.2, 0.35, 7.2), accent, 0, 2.6, 0));
        g.add(this.mesh(new THREE.CylinderGeometry(1.8, 2.3, 2.2, 8), metal, 0, 3.9, 0));
        turret = new THREE.Group();
        turret.position.y = 5.2;
        turret.add(this.mesh(new THREE.BoxGeometry(2.6, 1.2, 2.6), metal));
        turret.add(this.mesh(new THREE.BoxGeometry(0.35, 0.35, 3), dark, 0.5, 0.1, 1.6));
        turret.add(this.mesh(new THREE.BoxGeometry(0.35, 0.35, 3), dark, -0.5, 0.1, 1.6));
        turret.add(this.mesh(new THREE.BoxGeometry(1.6, 0.25, 0.2), accent, 0, 0.35, 1.35));
        g.add(turret);
        for (const [x, z] of [[3, 3], [-3, 3], [3, -3], [-3, -3]]) g.add(this.mesh(new THREE.CylinderGeometry(0.25, 0.25, 6, 6), metal, x * 1.6, 3, z * 1.6));
      } else if (pad.kind === 'factory') {
        g.add(this.mesh(new THREE.BoxGeometry(8, 3.4, 5), metal, 0, 1.9, -0.8));
        g.add(this.mesh(new THREE.BoxGeometry(8.1, 0.4, 0.3), accent, 0, 2.8, 1.75));
        g.add(this.mesh(new THREE.CylinderGeometry(0.7, 0.9, 5.5, 8), dark, -2.5, 5.3, -1.5));
        g.add(this.mesh(new THREE.CylinderGeometry(0.7, 0.9, 4.2, 8), dark, 2.4, 4.7, -1.5));
        g.add(this.mesh(new THREE.BoxGeometry(3, 2, 0.3), accent, 0, 1.2, 1.75));
      } else if (pad.kind === 'metal') {
        const ore = this.std(0x8aa0b3, { metalness: 0.9, roughness: 0.25, flatShading: true });
        for (let i = 0; i < 6; i++) {
          const a = i * 1.05, r = 1.2 + (i % 3) * 0.9, h = 2 + (i % 3);
          const c = this.mesh(new THREE.ConeGeometry(0.7 + (i % 2) * 0.3, h, 5), i % 2 ? ore : accent, Math.sin(a) * r, h / 2 + 0.4, Math.cos(a) * r);
          c.rotation.set(Math.sin(a) * 0.3, a, Math.cos(a) * 0.3);
          g.add(c);
        }
      } else if (pad.kind === 'energy') {
        g.add(this.mesh(new THREE.CylinderGeometry(0.4, 1.2, 5, 6), metal, 0, 2.7, 0));
        for (const a of [0, 2.1, 4.2]) {
          const leg = this.mesh(new THREE.BoxGeometry(0.3, 4.5, 0.3), dark, Math.sin(a) * 1.8, 2, Math.cos(a) * 1.8);
          leg.rotation.set(Math.cos(a) * 0.35, 0, -Math.sin(a) * 0.35);
          g.add(leg);
        }
        spinner = this.mesh(new THREE.OctahedronGeometry(1.3, 0), accent, 0, 6.6, 0);
        g.add(spinner);
      } else {
        g.add(this.mesh(new THREE.BoxGeometry(1.2, 3.5, 1.2), metal, 0, 2, 0));
        spinner = this.mesh(new THREE.BoxGeometry(1.4, 0.5, 1.4), accent, 0, 4, 0);
        g.add(spinner);
      }
      this.scene.add(g);
      this.addPadDecor(pad, accent, { turret, spinner });
    }
  }

  private addPadDecor(pad: Pad, accent: THREE.MeshStandardMaterial | null, parts: { turret?: THREE.Object3D; spinner?: THREE.Object3D } | null) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(PAD_RADIUS - 0.5, PAD_RADIUS + 0.15, 6, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: TEAM_HEX[pad.owner], toneMapped: false, transparent: true, opacity: 0.9 }));
    ring.rotation.y = Math.PI / 6;
    ring.position.set(pad.x, 0.5, pad.z);
    const progress = new THREE.Mesh(new THREE.RingGeometry(PAD_RADIUS + 0.6, PAD_RADIUS + 1.6, 64, 1, Math.PI / 2, -Math.PI * 2).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, transparent: true, opacity: 0.95, side: THREE.DoubleSide }));
    progress.position.set(pad.x, 0.12, pad.z);
    progress.geometry.setDrawRange(0, 0);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(PAD_RADIUS, PAD_RADIUS, 30, 6, 1, true), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
    beam.position.set(pad.x, 15, pad.z);
    beam.rotation.y = Math.PI / 6;
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(pad.name, '#dce8ea'), transparent: true, depthWrite: false, fog: true }));
    label.scale.set(10, 1.9, 1);
    label.position.set(pad.x, pad.id === CORE_PAD ? 16 : 10, pad.z + PAD_RADIUS);
    this.scene.add(ring, progress, beam, label);
    this.pads.push({ pad, owner: pad.owner, ring, progress, beam, accent: accent ?? new THREE.MeshStandardMaterial(), label, ...(parts ?? {}) });
  }

  private buildMech() {
    const root = new THREE.Group();
    const armor = this.std(0xc9d3d8, { metalness: 0.7, roughness: 0.35 });
    const dark = this.std(0x232c33, { metalness: 0.6 });
    const glow = new THREE.MeshStandardMaterial({ color: 0x0a1416, emissive: TEAM_HEX.player, emissiveIntensity: 2.4 });
    const legs = new THREE.Group();
    const thighs: THREE.Object3D[] = [];
    for (const side of [-1, 1]) {
      const hip = new THREE.Group();
      hip.position.set(side * 0.85, 2.3, 0);
      hip.add(this.mesh(new THREE.BoxGeometry(0.6, 1.4, 0.7), dark, 0, -0.6, 0));
      const knee = new THREE.Group();
      knee.position.set(0, -1.25, 0.1);
      knee.add(this.mesh(new THREE.BoxGeometry(0.55, 1.3, 0.6), armor, 0, -0.55, -0.1));
      knee.add(this.mesh(new THREE.BoxGeometry(0.8, 0.25, 1.3), dark, 0, -1.15, 0.1));
      hip.add(knee);
      legs.add(hip);
      thighs.push(hip);
    }
    legs.add(this.mesh(new THREE.BoxGeometry(1.9, 0.5, 0.9), dark, 0, 2.35, 0));
    const torso = new THREE.Group();
    torso.position.y = 2.7;
    torso.add(this.mesh(new THREE.BoxGeometry(2.3, 1.3, 1.8), armor, 0, 0.6, 0));
    torso.add(this.mesh(new THREE.BoxGeometry(1.4, 0.35, 0.2), glow, 0, 0.85, 0.92));
    torso.add(this.mesh(new THREE.BoxGeometry(2.35, 0.12, 1.85), glow, 0, 0.12, 0));
    const guns: THREE.Object3D[] = [];
    for (const side of [-1, 1]) {
      const arm = new THREE.Group();
      arm.position.set(side * 1.45, 0.5, 0);
      arm.add(this.mesh(new THREE.BoxGeometry(0.7, 0.8, 1.1), dark));
      arm.add(this.mesh(new THREE.CylinderGeometry(0.2, 0.24, 1.8, 8).rotateX(Math.PI / 2), dark, 0, -0.1, 1.3));
      arm.add(this.mesh(new THREE.BoxGeometry(0.3, 0.12, 0.6), glow, 0, 0.3, 0.6));
      torso.add(arm);
      guns.push(arm);
      const pod = this.mesh(new THREE.BoxGeometry(0.8, 0.6, 1), armor, side * 0.85, 1.55, -0.3);
      pod.add(this.mesh(new THREE.BoxGeometry(0.6, 0.4, 0.05), glow, 0, 0, 0.52));
      torso.add(pod);
    }
    const shield = new THREE.Mesh(new THREE.SphereGeometry(2.8, 24, 16), new THREE.MeshBasicMaterial({ color: TEAM_HEX.player, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    shield.position.y = 2.2;
    root.add(legs, torso, shield);
    this.scene.add(root);
    this.mech = { root, legs, torso, thighs, shield, body: armor, guns, phase: 0, recoil: 0 };
  }

  private buildCore(state: ActionState) {
    const c = state.core;
    const root = new THREE.Group();
    root.position.set(c.x, 0, c.z);
    const metal = this.std(0x2a2233, { metalness: 0.85, roughness: 0.3 });
    root.add(this.mesh(new THREE.CylinderGeometry(CORE_RADIUS + 1.5, CORE_RADIUS + 3, 1.2, 8), metal, 0, 0.6, 0));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const spike = this.mesh(new THREE.ConeGeometry(0.9, 7, 5), metal, Math.sin(a) * (CORE_RADIUS + 1), 3.5, Math.cos(a) * (CORE_RADIUS + 1));
      spike.rotation.set(Math.cos(a) * 0.25, 0, -Math.sin(a) * 0.25);
      root.add(spike);
    }
    const mat = new THREE.MeshStandardMaterial({ color: 0x1c0f2e, emissive: TEAM_HEX.rogue, emissiveIntensity: 1.6, flatShading: true, metalness: 0.4, roughness: 0.3 });
    const heart = this.mesh(new THREE.IcosahedronGeometry(3.6, 1), mat, 0, 7, 0);
    root.add(heart);
    const rings: THREE.Object3D[] = [];
    for (let i = 0; i < 3; i++) {
      const r = new THREE.Mesh(new THREE.TorusGeometry(5 + i * 0.9, 0.18, 6, 48), new THREE.MeshBasicMaterial({ color: TEAM_HEX.rogue, toneMapped: false }));
      r.position.y = 7;
      root.add(r);
      rings.push(r);
    }
    const shield = new THREE.Mesh(new THREE.IcosahedronGeometry(CORE_RADIUS + 1, 2), new THREE.MeshBasicMaterial({ color: 0x8a6cff, wireframe: true, transparent: true, opacity: 0.35, toneMapped: false }));
    shield.position.y = 6;
    root.add(shield);
    const crater = new THREE.Mesh(new THREE.CircleGeometry(CORE_RADIUS + 3, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x050307 }));
    crater.position.set(c.x, 0.03, c.z);
    crater.visible = false;
    this.scene.add(root, crater);
    this.core = { root, heart, rings, shield, mat, crater };
  }

  private makeBot(b: Bot): BotView {
    const tint = new THREE.Color(TEAM_HEX[b.team]);
    const body = new THREE.MeshStandardMaterial({ color: tint.clone().multiplyScalar(0.55).add(new THREE.Color(0x202428)), emissive: 0x000000, metalness: 0.6, roughness: 0.4 });
    const dark = this.std(0x1b2126);
    const eye = new THREE.MeshStandardMaterial({ color: 0x050505, emissive: TEAM_HEX[b.team], emissiveIntensity: 3 });
    const group = new THREE.Group();
    const legs: THREE.Object3D[] = [];
    let turret: THREE.Object3D | undefined;
    const kind: BotKind = b.kind;
    if (kind === 'scout') {
      const hull = this.mesh(new THREE.SphereGeometry(0.9, 12, 8), body, 0, 1.8, 0);
      hull.scale.set(1.2, 0.6, 1.4);
      group.add(hull);
      group.add(this.mesh(new THREE.BoxGeometry(2.8, 0.12, 0.6), dark, 0, 1.8, -0.2));
      group.add(this.mesh(new THREE.BoxGeometry(0.5, 0.2, 0.3), eye, 0, 1.95, 1.1));
      group.add(this.mesh(new THREE.BoxGeometry(0.15, 0.15, 1), dark, 0.4, 1.6, 0.9));
    } else if (kind === 'assault') {
      for (const side of [-1, 1]) {
        const hip = new THREE.Group();
        hip.position.set(side * 0.6, 1.6, 0);
        hip.add(this.mesh(new THREE.BoxGeometry(0.45, 1.6, 0.5), dark, 0, -0.75, 0));
        group.add(hip);
        legs.push(hip);
      }
      group.add(this.mesh(new THREE.BoxGeometry(1.8, 1.2, 1.4), body, 0, 2.2, 0));
      group.add(this.mesh(new THREE.BoxGeometry(1, 0.25, 0.1), eye, 0, 2.4, 0.72));
      group.add(this.mesh(new THREE.BoxGeometry(0.35, 0.35, 1.6), dark, 1.1, 2, 0.6));
      group.add(this.mesh(new THREE.BoxGeometry(0.35, 0.35, 1.6), dark, -1.1, 2, 0.6));
    } else if (kind === 'artillery') {
      group.add(this.mesh(new THREE.BoxGeometry(2.6, 0.9, 3.2), body, 0, 0.9, 0));
      group.add(this.mesh(new THREE.BoxGeometry(0.6, 0.8, 3.4), dark, 1.4, 0.5, 0));
      group.add(this.mesh(new THREE.BoxGeometry(0.6, 0.8, 3.4), dark, -1.4, 0.5, 0));
      turret = new THREE.Group();
      turret.position.y = 1.6;
      turret.add(this.mesh(new THREE.CylinderGeometry(0.9, 1.1, 0.7, 8), body));
      const barrel = this.mesh(new THREE.CylinderGeometry(0.2, 0.28, 3, 8), dark, 0, 0.7, 1.1);
      barrel.rotation.x = Math.PI / 3;
      turret.add(barrel);
      turret.add(this.mesh(new THREE.BoxGeometry(0.6, 0.15, 0.1), eye, 0, 0.2, 0.9));
      group.add(turret);
    } else {
      const shard = this.mesh(new THREE.OctahedronGeometry(1.2, 0), body, 0, 2.2, 0);
      shard.scale.y = 1.5;
      group.add(shard);
      const halo = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.08, 4, 24), eye);
      halo.position.y = 2.2;
      halo.rotation.x = Math.PI / 2;
      group.add(halo);
      legs.push(halo);
    }
    this.scene.add(group);
    return { group, body, legs, turret, phase: b.id };
  }

  private makePickup(kind: PickupKind) {
    const color = kind === 'repair' ? 0x6dff8a : kind === 'overdrive' ? 0xffa030 : 0x7be8df;
    const mat = new THREE.MeshBasicMaterial({ color, toneMapped: false });
    const g = new THREE.Group();
    if (kind === 'repair') { g.add(new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.45, 0.45), mat)); g.add(new THREE.Mesh(new THREE.BoxGeometry(0.45, 1.4, 0.45), mat)); }
    else if (kind === 'overdrive') g.add(new THREE.Mesh(new THREE.OctahedronGeometry(0.8, 0), mat));
    else g.add(new THREE.Mesh(new THREE.TorusGeometry(0.7, 0.2, 8, 20), mat));
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.1, 1.4, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, toneMapped: false }));
    ring.position.y = -1.3;
    g.add(ring);
    this.scene.add(g);
    return g;
  }

  /** Converts a screen point to a ground-plane position. */
  groundPoint(clientX: number, clientY: number) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hit = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.groundPlane, hit) ? { x: hit.x, z: hit.z } : null;
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.width = w; this.height = h;
    this.renderer.setSize(w, h, false);
    this.composer?.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const scale = (h * this.renderer.getPixelRatio()) / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
    this.sparks.setScale(scale);
    this.smoke.setScale(scale);
  }

  private flash(x: number, y: number, z: number, color: number, peak: number) {
    let f = this.flashes[0];
    for (const c of this.flashes) if (c.t <= 0) { f = c; break; } else if (c.t < f.t) f = c;
    f.light.position.set(x, y, z);
    f.light.color.setHex(color);
    f.t = 1; f.peak = peak;
  }

  private wave(x: number, z: number, color: Team | number, scale: number, dur: number) {
    const w = this.waves.find(v => v.t >= v.dur) ?? this.waves[0];
    w.t = 0; w.dur = dur; w.scale = scale;
    w.mesh.position.set(x, 0.3, z);
    (w.mesh.material as THREE.MeshBasicMaterial).color.setHex(typeof color === 'number' ? color : TEAM_HEX[color]);
    w.mesh.visible = true;
  }

  private explosion(x: number, z: number, size: number, team: Team) {
    const tc = this.teamColors[team];
    const hot = new THREE.Color(0xffd27a), white = new THREE.Color(0xffffff), smoke = new THREE.Color(0x1a1c1f);
    const n = Math.round(26 * size * (this.quality === 'high' ? 1.4 : 0.8));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, up = Math.random() * 14 * size, sp = (4 + Math.random() * 16) * Math.sqrt(size);
      const col = i % 3 === 0 ? tc : i % 3 === 1 ? hot : white;
      this.sparks.emit(x, 1.2, z, Math.sin(a) * sp, up, Math.cos(a) * sp, 0.4 + Math.random() * 0.6, 0.5 + Math.random() * 0.6 * size, col, 22);
    }
    for (let i = 0; i < 6 * size; i++) {
      const a = Math.random() * Math.PI * 2, sp = 2 + Math.random() * 4;
      this.sparks.emit(x, 1.5, z, Math.sin(a) * sp, 3 + Math.random() * 4, Math.cos(a) * sp, 0.25, 3.2 * size, hot, 0);
    }
    for (let i = 0; i < 5 * size; i++) {
      const a = Math.random() * Math.PI * 2, sp = 1 + Math.random() * 3;
      this.smoke.emit(x + Math.sin(a), 1 + Math.random() * 2, z + Math.cos(a), Math.sin(a) * sp, 2 + Math.random() * 3, Math.cos(a) * sp, 1.2 + Math.random() * 1.2, 2.5 * size, smoke, -1);
    }
    this.wave(x, z, team, 1.5 + size * 2.5, 0.4);
    this.flash(x, 3, z, 0xffa860, 18 * size);
  }

  private handleFx(fx: Fx[], state: ActionState) {
    const m = state.mech;
    for (const f of fx) {
      if (f.type === 'boom') {
        this.explosion(f.x, f.z, f.size, f.team);
        const d = Math.hypot(f.x - m.x, f.z - m.z);
        this.trauma = Math.min(1, this.trauma + Math.max(0, f.size * 0.35 - d / 80));
      } else if (f.type === 'muzzle') {
        const c = this.teamColors[f.team];
        const y = f.byMech ? 2.6 : 2;
        for (let i = 0; i < (f.byMech ? 3 : 2); i++) {
          const a = f.angle + (Math.random() - 0.5) * 0.7, sp = 8 + Math.random() * 10;
          this.sparks.emit(f.x, y, f.z, Math.sin(a) * sp, Math.random() * 3, Math.cos(a) * sp, 0.12, 0.5, c);
        }
        if (f.byMech) { this.mech.recoil = 1; this.sparks.emit(f.x, y, f.z, 0, 0, 0, 0.05, 1.6, this.color.setHex(0xe8ffff)); }
      } else if (f.type === 'hit') {
        const c = f.shield ? this.teamColors.rogue : this.teamColors[f.team];
        for (let i = 0; i < 5; i++) {
          const a = Math.random() * Math.PI * 2, sp = 4 + Math.random() * 8;
          this.sparks.emit(f.x, f.shield ? 5 : 2, f.z, Math.sin(a) * sp, Math.random() * 6, Math.cos(a) * sp, 0.25, 0.4, c, 15);
        }
      } else if (f.type === 'shake') {
        this.trauma = Math.min(1, this.trauma + f.amount);
      } else if (f.type === 'hurt') {
        this.mechHit = 0.12;
      } else if (f.type === 'capture') {
        const p = state.pads[f.pad];
        this.wave(p.x, p.z, f.team, PAD_RADIUS * 2.2, 0.9);
        const c = this.teamColors[f.team];
        for (let i = 0; i < 70; i++) {
          const a = Math.random() * Math.PI * 2, r = Math.random() * PAD_RADIUS;
          this.sparks.emit(p.x + Math.sin(a) * r, 0.5, p.z + Math.cos(a) * r, 0, 8 + Math.random() * 16, 0, 1 + Math.random(), 0.6, c, -2);
        }
        this.flash(p.x, 6, p.z, TEAM_HEX[f.team], 30);
      } else if (f.type === 'pickup') {
        this.wave(f.x, f.z, 0xffffff, 6, 0.4);
        for (let i = 0; i < 24; i++) {
          const a = Math.random() * Math.PI * 2;
          this.sparks.emit(f.x, 1.5, f.z, Math.sin(a) * 6, 4 + Math.random() * 6, Math.cos(a) * 6, 0.5, 0.5, this.color.setHex(0xffffff), 10);
        }
      } else if (f.type === 'dash') {
        const c = this.teamColors.player;
        for (let i = 0; i < 30; i++) this.sparks.emit(f.x + (Math.random() - 0.5) * 2, 0.5 + Math.random() * 3, f.z + (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 4, Math.random() * 2, (Math.random() - 0.5) * 4, 0.4, 0.7, c);
        this.wave(f.x, f.z, 'player', 5, 0.3);
      }
    }
  }

  render(state: ActionState, dt: number) {
    this.time += dt;
    this.handleFx(state.fx, state);
    this.syncPads(state, dt);
    this.syncMech(state, dt);
    this.syncCore(state, dt);
    this.syncBots(state, dt);
    this.syncShots(state);
    this.syncPickups(state);
    this.sparks.update(dt);
    this.smoke.update(dt);
    for (const w of this.waves) {
      if (w.t >= w.dur) { w.mesh.visible = false; continue; }
      w.t += dt;
      const k = Math.min(1, w.t / w.dur);
      const s = 0.5 + w.scale * (1 - (1 - k) ** 3);
      w.mesh.scale.set(s, s, s);
      (w.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - k) * 0.9;
    }
    for (const f of this.flashes) {
      f.t = Math.max(0, f.t - dt * 5);
      f.light.intensity = f.peak * f.t * f.t * 10;
    }
    this.updateCamera(state, dt);
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  private syncPads(state: ActionState, dt: number) {
    for (const v of this.pads) {
      const p = v.pad;
      if (v.owner !== p.owner) {
        v.owner = p.owner;
        (v.ring.material as THREE.MeshBasicMaterial).color.setHex(TEAM_HEX[p.owner]);
        v.accent.emissive.setHex(TEAM_HEX[p.owner]);
      }
      const prog = p.capture.team ? p.capture.progress / 100 : 0;
      v.progress.geometry.setDrawRange(0, Math.floor(64 * prog) * 6);
      if (p.capture.team) (v.progress.material as THREE.MeshBasicMaterial).color.setHex(TEAM_HEX[p.capture.team]);
      const bm = v.beam.material as THREE.MeshBasicMaterial;
      const target = prog > 0 ? 0.08 + 0.06 * Math.sin(this.time * 10) : 0;
      bm.opacity += (target - bm.opacity) * Math.min(1, dt * 6);
      if (p.capture.team) bm.color.setHex(TEAM_HEX[p.capture.team]);
      if (v.turret) {
        let d = p.turretAngle - v.turret.rotation.y;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        v.turret.rotation.y += d * Math.min(1, dt * 10);
      }
      if (v.spinner) { v.spinner.rotation.y += dt * 1.5; v.spinner.position.y += Math.sin(this.time * 2 + p.id) * dt * 0.6; }
    }
  }

  private syncMech(state: ActionState, dt: number) {
    const m = state.mech, v = this.mech;
    v.root.visible = m.alive;
    if (!m.alive) return;
    v.root.position.set(m.x, 0, m.z);
    const speed = Math.hypot(m.vx, m.vz);
    if (speed > 0.5) {
      const target = Math.atan2(m.vx, m.vz);
      let d = target - v.legs.rotation.y;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      v.legs.rotation.y += d * Math.min(1, dt * 12);
    }
    v.phase += dt * Math.min(speed, 18) * 0.7;
    const swing = Math.min(1, speed / 10) * 0.6;
    v.thighs[0].rotation.x = Math.sin(v.phase) * swing;
    v.thighs[1].rotation.x = -Math.sin(v.phase) * swing;
    v.root.position.y = Math.abs(Math.sin(v.phase)) * 0.15 * swing;
    v.torso.rotation.y = m.aim;
    v.recoil = Math.max(0, v.recoil - dt * 12);
    for (const g of v.guns) g.position.z = -0.25 * v.recoil;
    v.torso.rotation.x = m.dashTime > 0 ? 0.25 : 0;
    const sm = v.shield.material as THREE.MeshBasicMaterial;
    sm.opacity = m.shield > 0 ? 0.12 + 0.05 * Math.sin(this.time * 8) : m.invuln > 0 ? 0.08 : 0;
    this.mechHit -= dt;
    v.body.emissive.setHex(this.mechHit > 0 ? 0xff3030 : m.overdrive > 0 ? 0x553300 : 0x000000);
    v.root.visible = !(m.invuln > 0 && m.dashTime <= 0 && Math.floor(this.time * 20) % 2 === 0);
    if (m.dashTime > 0) this.sparks.emit(m.x, 1.5, m.z, 0, 1, 0, 0.3, 1.4, this.teamColors.player);
    if (m.overdrive > 0 && Math.random() < 0.5) this.sparks.emit(m.x + (Math.random() - 0.5) * 2, 3, m.z + (Math.random() - 0.5) * 2, 0, 4, 0, 0.4, 0.4, this.color.setHex(0xffa030));
    if (m.hp < m.maxHp * 0.3 && Math.random() < 0.3) this.smoke.emit(m.x, 3.5, m.z, 0, 3, 0, 1, 1.4, this.color.setHex(0x222222), -1);
  }

  private syncCore(state: ActionState, dt: number) {
    const c = state.core, v = this.core;
    v.root.visible = c.alive;
    v.crater.visible = !c.alive;
    if (!c.alive) return;
    v.heart.rotation.y += dt * (c.awake ? 1.5 : 0.3);
    v.heart.rotation.x += dt * 0.4;
    v.heart.position.y = 7 + Math.sin(this.time * 1.5) * 0.5;
    v.rings.forEach((r, i) => { r.rotation.x = this.time * (0.6 + i * 0.3); r.rotation.y = this.time * (0.4 - i * 0.25); });
    v.shield.visible = !c.awake;
    v.shield.rotation.y += dt * 0.2;
    const pulse = c.awake ? 2 + Math.sin(this.time * (c.hp < c.maxHp / 2 ? 14 : 6)) * 1 : 1;
    v.mat.emissiveIntensity = pulse;
    if (c.awake && Math.random() < 0.4) {
      const a = Math.random() * Math.PI * 2;
      this.sparks.emit(c.x + Math.sin(a) * 4, 7, c.z + Math.cos(a) * 4, Math.sin(a) * 2, 2, Math.cos(a) * 2, 0.6, 0.8, this.teamColors.rogue);
    }
  }

  private syncBots(state: ActionState, dt: number) {
    const seen = new Set<number>();
    for (const b of state.bots) {
      seen.add(b.id);
      let v = this.bots.get(b.id);
      if (!v) { v = this.makeBot(b); this.bots.set(b.id, v); }
      v.group.position.set(b.x, 0, b.z);
      const def = BOT_DEFS[b.kind];
      if (b.kind === 'artillery' && v.turret) {
        if (b.moving) v.group.rotation.y = b.angle; else v.turret.rotation.y = b.angle - v.group.rotation.y;
      } else {
        let d = b.angle - v.group.rotation.y;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        v.group.rotation.y += d * Math.min(1, dt * 10);
      }
      v.phase += dt * (b.moving ? def.speed * 0.9 : 2);
      if (b.kind === 'assault') { v.legs[0].rotation.x = Math.sin(v.phase) * 0.5 * +b.moving; v.legs[1].rotation.x = -Math.sin(v.phase) * 0.5 * +b.moving; }
      else if (b.kind === 'scout') { v.group.position.y = Math.sin(v.phase * 0.5) * 0.25; v.group.rotation.z = Math.sin(v.phase * 0.3) * 0.1; }
      else if (b.kind === 'sentinel') { v.group.position.y = Math.sin(v.phase * 0.4) * 0.4; v.legs[0].rotation.z += dt * 4; }
      v.body.emissive.setHex(b.flash > 0 ? 0xffffff : 0x000000);
      v.body.emissiveIntensity = b.flash > 0 ? 1.5 : 0;
      if (b.hp < b.maxHp * 0.4 && Math.random() < 0.08) this.smoke.emit(b.x, 2.5, b.z, 0, 2, 0, 0.8, 1, this.color.setHex(0x222222), -1);
    }
    for (const [id, v] of this.bots) {
      if (seen.has(id)) continue;
      this.scene.remove(v.group);
      v.group.traverse(o => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); } });
      this.bots.delete(id);
    }
  }

  private syncShots(state: ActionState) {
    let nb = 0, no = 0, nm = 0, ns = 0;
    const d = this.dummy;
    d.scale.set(1, 1, 1);
    for (const s of state.shots) {
      const a = Math.atan2(s.vx, s.vz);
      d.rotation.set(0, a, 0);
      d.position.set(s.x, s.y, s.z);
      if (s.kind === 'bolt' && nb < MAX_BOLTS) {
        d.updateMatrix();
        this.bolts.setMatrixAt(nb, d.matrix);
        this.color.copy(this.teamColors[s.team]).multiplyScalar(s.byMech ? 2.2 : 1.6);
        this.bolts.setColorAt(nb++, this.color);
      } else if (s.kind === 'orb' && no < MAX_ORBS) {
        const pulse = 1 + 0.2 * Math.sin(this.time * 20 + s.id);
        d.scale.set(pulse, pulse, pulse);
        d.updateMatrix();
        d.scale.set(1, 1, 1);
        this.orbs.setMatrixAt(no, d.matrix);
        this.color.copy(this.teamColors.rogue).multiplyScalar(2);
        this.orbs.setColorAt(no++, this.color);
      } else if (s.kind === 'missile' && nm < MAX_MISSILES) {
        d.updateMatrix();
        this.missiles.setMatrixAt(nm, d.matrix);
        this.missiles.setColorAt(nm++, this.color.setHex(0xfff2c0));
        this.sparks.emit(s.x - Math.sin(a) * 0.8, s.y, s.z - Math.cos(a) * 0.8, 0, 0, 0, 0.25, 0.7, this.color.setHex(0xff9a3c));
        if (Math.random() < 0.5) this.smoke.emit(s.x, s.y, s.z, 0, 0.5, 0, 0.7, 0.9, this.color.setHex(0x3a3a3a));
      } else if (s.kind === 'shell' && ns < MAX_SHELLS) {
        d.updateMatrix();
        this.shells.setMatrixAt(ns, d.matrix);
        this.shells.setColorAt(ns, this.color.copy(this.teamColors[s.team]).multiplyScalar(2));
        const u = Math.min(1, s.t / s.dur);
        d.position.set(s.tx, 0.15, s.tz);
        d.rotation.set(0, 0, 0);
        const r = s.aoe * (1.15 - 0.15 * u);
        d.scale.set(r, 1, r);
        d.updateMatrix();
        d.scale.set(1, 1, 1);
        this.markers.setMatrixAt(ns++, d.matrix);
        this.sparks.emit(s.x, s.y, s.z, 0, 0, 0, 0.2, 0.8, this.teamColors[s.team]);
      }
    }
    this.markerMat.opacity = 0.45 + 0.35 * Math.sin(this.time * 18);
    for (const [mesh, n] of [[this.bolts, nb], [this.orbs, no], [this.missiles, nm], [this.shells, ns], [this.markers, ns]] as const) {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  private syncPickups(state: ActionState) {
    const seen = new Set<number>();
    for (const p of state.pickups) {
      seen.add(p.id);
      let o = this.pickups.get(p.id);
      if (!o) { o = this.makePickup(p.kind); this.pickups.set(p.id, o); }
      o.position.set(p.x, 1.6 + Math.sin(this.time * 3 + p.id) * 0.3, p.z);
      o.rotation.y = this.time * 2;
      o.visible = p.life > 3 || Math.floor(this.time * 8) % 2 === 0;
    }
    for (const [id, o] of this.pickups) {
      if (seen.has(id)) continue;
      this.scene.remove(o);
      o.traverse(c => { if (c instanceof THREE.Mesh) { c.geometry.dispose(); (c.material as THREE.Material).dispose(); } });
      this.pickups.delete(id);
    }
  }

  private updateCamera(state: ActionState, dt: number) {
    const m = state.mech;
    const portrait = this.width < this.height;
    const height = portrait ? 44 : 31, back = portrait ? 24 : 22;
    const ax = Math.sin(m.aim) * (m.alive ? 5 : 0), az = Math.cos(m.aim) * (m.alive ? 5 : 0);
    const k = 1 - Math.exp(-5 * dt);
    this.camLook.x += (m.x + ax - this.camLook.x) * k;
    this.camLook.z += (m.z + az - this.camLook.z) * k;
    this.camPos.set(this.camLook.x, height, this.camLook.z + back);
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
    const shake = this.trauma * this.trauma;
    const t = this.time * 40;
    this.camera.position.set(
      this.camPos.x + Math.sin(t * 1.1) * shake * 1.6,
      this.camPos.y + Math.sin(t * 1.7) * shake * 1.2,
      this.camPos.z + Math.cos(t * 1.3) * shake * 1.6,
    );
    this.camera.lookAt(this.camLook.x, 0, this.camLook.z);
    this.camera.rotateZ(Math.sin(t * 0.9) * shake * 0.04);
    this.sun.position.set(this.camLook.x + 30, 60, this.camLook.z + 20);
    this.sun.target.position.set(this.camLook.x, 0, this.camLook.z);
  }

  dispose() {
    this.renderer.dispose();
    this.composer?.dispose();
    this.scene.traverse(o => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Points || o instanceof THREE.Sprite) {
        o.geometry?.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const mat of mats) { (mat as THREE.MeshBasicMaterial).map?.dispose(); mat.dispose(); }
      }
    });
    this.renderer.domElement.remove();
  }
}
