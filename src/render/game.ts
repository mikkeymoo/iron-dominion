import { MAP } from '../sim/layers.ts';
import type { AgentStore } from './agentStore.ts';
import type { SimClient } from '../sim/client.ts';
import { CAMERA, CameraRig, pixelToNdc, rayFromPose } from './camera.ts';
import { celebrate, type CelebrateDeps } from './celebrate.ts';
import { CinematicPlayer, megaOrbit, pickTourStops, planTour, type Path } from './cinematic.ts';
import { cachedModel } from './instances.ts';
import { megaStages } from '../sim/megaprojects.ts';
import { createPhoto, type PhotoController } from './photo.ts';
import { tourCandidates } from './tourSites.ts';
import { blockGestureZoom, createRenderContext, parseBackend, type RenderContext } from './context.ts';
import type { RenderDebug } from './debug.ts';
import { surfaceHeight } from './heightfield.ts';
import { bindCameraInput } from './input.ts';
import type { RenderMirror } from './mirror.ts';
import { pickPoint, pickTile } from './picking.ts';
import { computeViewRect } from './viewrect.ts';
import { WorldScene } from './scene.ts';
import { planShowcase } from './kit/showcase.ts';
import { tileReadOf } from '../sim/estimate.ts';
import { startCameraFor } from './startCamera.ts';
import { AUTO_STORAGE_KEY, TIER_TABLE, createGovernor, readStoredTier, resolveTier, tierCap, type Governor, type Tier } from './tier.ts';
import type { ToolController } from './tools/controller.ts';
import { GhostView } from './tools/ghostView.ts';
import { createToolInput } from './tools/pointer.ts';
import { isOverlayMode, type ViewState } from './viewState.ts';

export interface GameDeps {
  host: HTMLElement;
  mirror: RenderMirror;
  client: SimClient;
  search: string;
  /** Build tools: when set, an active tool takes one-finger / left-button drags and the ghost preview is drawn. */
  tools?: ToolController;
  /** Overlay mode and underground view, set by the HUD. Without it the terrain shows no overlay and the surface view. */
  view?: ViewState;
  /** Interpolated robot positions fed by the sim's Agents messages. */
  agents: AgentStore;
  /** Called when the renderer cannot be recovered after a device loss. */
  onFatal: (message: string) => void;
  /** Called when the auto governor moves the tier (down or up), so the app can persist the settled tier. */
  onTier?: (tier: Tier) => void;
}

/** Phone-class device: a coarse pointer on a small screen, or any window 600 CSS px wide or less. */
function isPhoneDevice(): boolean {
  if (typeof window === 'undefined') return false;
  const small = Math.min(window.innerWidth, window.innerHeight);
  const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  return small <= 600 || (coarse && small <= 820);
}

export interface PerfSnapshot {
  backend: string;
  tier: Tier;
  adapter: string;
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  fineChunks: number;
  coarseSupers: number;
  buildings: { instances: number; farInstances: number; drawCalls: number };
  tick: number;
}

export interface Game {
  readonly debug: RenderDebug;
  /** Photo mode controller for the UI (settings, capture, saving). */
  readonly photo: PhotoController;
  /** Start the tour over the tallest buildings and busiest sites, or skip it when one is playing. Returns whether a tour started. */
  tour(): boolean;
  perf(): PerfSnapshot;
  dispose(): void;
}

const VIEW_RECT_MS = 250;
const FOLLOW_GRACE_MS = 6000;
const RESET = { x: MAP / 2, z: MAP / 2, yaw: 0, pitch: 1.1, dist: 60 } as const;

export async function startGame(deps: GameDeps): Promise<Game> {
  const { host, mirror, client } = deps;
  const q = new URLSearchParams(deps.search);
  const pref = parseBackend(q.get('backend'));
  const governorOn = q.get('governor') !== 'off';
  const heights = mirror.layers.height!;
  const rig = new CameraRig((x, z) => Math.max(0, surfaceHeight(heights, x, z)));
  rig.reset(MAP / 2, MAP / 2, 0.6, 0.62, 110);

  host.style.touchAction = 'none';
  host.style.position = 'absolute';
  host.style.inset = '0';
  const unblock = blockGestureZoom();

  let tier: Tier = 'low';
  let phone = false;
  let software = false;
  let disposed = false;
  let recovering = false;
  let deviceLosses = 0;
  let frames = 0, fps = 0, frameMs = 0, fpsFrames = 0, fpsT0 = 0;
  let drawCalls = 0, triangles = 0;
  let lastNow = 0, lastRectAt = 0, lastRectKey = '';
  let sawTerrain = false;
  let showcaseDone = false;
  let startDone = false;
  let appliedFactor = 1;
  let showcaseCamera: { x: number; z: number; yaw: number; pitch: number; dist: number } | undefined;
  const wantShowcase = q.get('showcase') === '1';
  let governor: Governor = createGovernor({ tier, enabled: false });
  let ctx!: RenderContext;
  let world!: WorldScene;
  let ghost: GhostView | undefined;

  const onLost = (message: string): void => { void recover(message); };
  // Creates a context and scene without touching the live ones, so a caller can discard them if it was disposed meanwhile.
  // `pickTier` runs once the adapter is known and before the scene exists, so every graph is built once for the final tier.
  const createParts = async (pickTier?: (c: RenderContext) => void): Promise<{ ctx: RenderContext; world: WorldScene; ghost?: GhostView }> => {
    const c = await createRenderContext({ container: host, backend: pref, tier: () => tier, onLost });
    try {
      pickTier?.(c);
      const w = new WorldScene(c.renderer, mirror, deps.search, tier, deps.agents);
      w.applyTier(tier);
      c.resize();
      w.setAspect(host.clientWidth / Math.max(1, host.clientHeight));
      const g = deps.tools ? new GhostView(heights) : undefined;
      if (g) w.scene.add(g.group);
      return { ctx: c, world: w, ghost: g };
    } catch (e) {
      try { c.dispose(); } catch { /* nothing else to release */ }
      throw e;
    }
  };
  let resolved!: ReturnType<typeof resolveTier>;
  const parts = await createParts((c) => {
    const store = typeof localStorage === 'undefined' ? undefined : localStorage;
    phone = isPhoneDevice();
    resolved = resolveTier(
      { backend: c.backend, software: c.software, phone }, q.get('tier'),
      readStoredTier(store), readStoredTier(store, AUTO_STORAGE_KEY),
    );
    tier = resolved.tier;
    software = c.software;
  });
  ctx = parts.ctx;
  world = parts.world;
  ghost = parts.ghost;
  sawTerrain = false;
  const newGovernor = (): Governor => {
    // A tier the player pinned (query or Settings) may exceed the automatic cap; auto and settled tiers may not.
    const chosen = resolved.source === 'query' || resolved.source === 'stored' ? resolved.tier : null;
    return createGovernor({ tier, cap: tierCap({ software, phone }, chosen), enabled: governorOn && resolved.source !== 'query' });
  };
  governor = newGovernor();
  ctx.setTier(tier);

  const groundAt = (px: number, py: number): { x: number; z: number } | null => {
    const w = host.clientWidth, h = host.clientHeight;
    const n = pixelToNdc(px, py, w, h);
    return pickPoint(rayFromPose(rig.pose(), world.camera.fov, w / h, n.nx, n.ny), mirror);
  };
  const pickAt = (px: number, py: number): { x: number; y: number } | null => {
    const w = host.clientWidth, h = host.clientHeight;
    const n = pixelToNdc(px, py, w, h);
    return pickTile(rayFromPose(rig.pose(), world.camera.fov, w / h, n.nx, n.ny), mirror);
  };
  const toolInput = deps.tools ? createToolInput(deps.tools, pickAt) : undefined;

  // Photo mode: the tools stand down (no drags, no ghost), the sim pause and the hidden HUD are the UI's job.
  const photo = createPhoto({
    viewSize: () => ({ w: host.clientWidth, h: host.clientHeight }),
    maxTexture: () => TIER_TABLE[tier].maxTextureSize,
    currentDayFrac: () => world.fx.dayFrac,
    baseFov: () => CAMERA.fovDeg,
    applyLook: (look, fov) => world.setPhotoLook(look, fov),
    renderAt(width, height, aspect, fovDeg) {
      ctx.renderer.setPixelRatio(1);
      ctx.renderer.setSize(width, height, false);
      world.camera.fov = fovDeg;
      world.setAspect(aspect);
      // Twice: temporal AA and AO read last frame's buffers, which are new at this size.
      world.render();
      world.render();
    },
    restore() {
      ctx.resize();
      world.camera.fov = photo.active ? photo.settings.fov : CAMERA.fovDeg;
      world.setAspect(host.clientWidth / Math.max(1, host.clientHeight));
      world.render();
    },
    encode: () => new Promise((resolve) => { ctx.canvas.toBlob((b) => resolve(b), 'image/png'); }),
  });

  // Cinematic camera: one path at a time, driven through the rig's script hook; a tap, wheel, or Escape skips it.
  const cinematic = new CinematicPlayer();
  const playPath = (path: Path, onEnd?: (completed: boolean) => void): void => {
    rig.stopFollow(); followKey = null;
    cinematic.play(path, onEnd);
    rig.script((dt) => cinematic.step(dt));
  };
  const tour = (): boolean => {
    if (cinematic.active) { cinematic.skip(); return false; }
    const stops = pickTourStops(tourCandidates(mirror, (x, z) => Math.max(0, surfaceHeight(heights, x, z))), 4, 24);
    playPath(planTour({ ...rig.state }, stops));
    return true;
  };

  const input = bindCameraInput({
    element: host, rig, groundAt,
    tool: toolInput ? { ...toolInput, active: () => !photo.active && toolInput.active() } : undefined,
  });

  // Follow-a-robot: chase a random active robot at street level; when it is gone pick another, and stop when none are left.
  let followKey: number | null = null;
  const pickRobot = (kind?: number): boolean => {
    const keys = deps.agents.activeKeys(kind);
    if (keys.length === 0) { followKey = null; return false; }
    followKey = keys[Math.floor(Math.random() * keys.length)]!;
    return true;
  };
  const follow = (on: boolean, kind?: number): boolean => {
    if (!on) { rig.stopFollow(); followKey = null; return false; }
    if (!pickRobot(kind)) return false;
    cinematic.skip();
    let last: { x: number; z: number; yaw: number } | null = null;
    let lostAt = 0;
    rig.followTarget(() => {
      const now = performance.now();
      let p = followKey === null ? null : deps.agents.poseOf(followKey, now);
      if (!p && pickRobot(kind)) p = deps.agents.poseOf(followKey!, now);
      if (p) { last = p; lostAt = 0; return p; }
      // Every robot is parked for the moment: hold the last view for a few seconds before giving the camera back.
      if (lostAt === 0) lostAt = now;
      return last && now - lostAt < FOLLOW_GRACE_MS ? last : null;
    });
    return true;
  };
  // Completion camera: orbits a finished megaproject for a few seconds; a tap or Escape ends it and gives the camera back where it was.
  const celebrations: CelebrateDeps = {
    emit: (kind, x, y, z, n, size, energy) => { world.fx.particles.emit(kind, x, y, z, n, size, energy); },
    ground: (x, z) => Math.max(0, surfaceHeight(heights, x, z)),
    focus: () => ({ x: rig.state.x, z: rig.state.z, dist: rig.state.dist }),
    finishedHeight: (arch) => cachedModel(arch, megaStages(arch)).height,
    startCinematic: (t) => {
      if (cinematic.active) return;
      const home = { ...rig.state };
      playPath(megaOrbit(home, t), (completed) => { if (!completed) { Object.assign(rig.state, home); rig.version++; } });
    },
  };
  // A tap or click anywhere on the view, or Escape, hands the camera back.
  const stopFollowing = (): void => { if (rig.following) follow(false); };
  const stopCamera = (): void => { stopFollowing(); cinematic.skip(); };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      const wasScripted = cinematic.active;
      stopCamera();
      if (!wasScripted && photo.active) photo.exit();
    } else if (e.key === 'F2' && !e.repeat) {
      e.preventDefault();
      if (photo.active) photo.exit(); else photo.enter();
    }
  };
  host.addEventListener('pointerdown', stopCamera, true);
  const skipCinematic = (): void => cinematic.skip();
  host.addEventListener('wheel', skipCinematic, true);
  window.addEventListener('keydown', onKey);

  const sendViewRect = (now: number): void => {
    const w = host.clientWidth, h = host.clientHeight;
    const key = `${rig.version}|${w}x${h}`;
    if (key === lastRectKey || now - lastRectAt < VIEW_RECT_MS) return;
    lastRectKey = key; lastRectAt = now;
    const r = computeViewRect(rig.pose(), world.camera.fov, w / Math.max(1, h), mirror, Math.min(400, rig.state.dist * 3));
    client.setViewRect(r.x0, r.y0, r.x1, r.y1);
  };

  const frame = (now: number): void => {
    if (disposed || recovering) return;
    const dtMs = lastNow ? now - lastNow : 16.7;
    lastNow = now;
    const dt = Math.min(0.1, dtMs / 1000);
    input.flush(dt);
    rig.step(dt);
    if (mirror.hasResync) celebrate(mirror.takeCelebrations(), celebrations);
    const pose = rig.pose();
    world.applyPose(pose);
    world.update(dt, now / 1000, pose, rig.state.dist, rig.state.pitch);
    world.updateRobots(dt, now, pose);
    world.updateTraffic(now, pose, rig.state.dist);

    if (mirror.hasResync) {
      world.terrain.update(rig.state.x, rig.state.z, TIER_TABLE[tier].fullDetailChunks);
      if (!sawTerrain && world.terrain.builds > 0) { sawTerrain = true; governor.noteWarmup(now); }
    }
    if (!startDone && mirror.hasResync) {
      startDone = true;
      const s = startCameraFor(tileReadOf(mirror.layers));
      rig.reset(s.x, s.z, s.yaw, s.pitch, s.dist);
    }
    if (wantShowcase && !showcaseDone && mirror.hasResync) {
      showcaseDone = true;
      const plan = planShowcase({ terrain: mirror.layers.terrain!, height: mirror.layers.height!, waterDepth: mirror.layers.waterDepth! });
      if (plan) {
        for (const cmd of plan.commands) client.command(cmd);
        const c = plan.camera;
        rig.reset(c.x, c.z, c.yaw, c.pitch, c.dist);
        showcaseCamera = c;
      } else console.warn('[showcase] no flat land window found');
    }
    world.buildings.update();
    world.updateUtilities(deps.view, now / 1000, rig.state.dist);
    if (deps.tools && ghost) { deps.tools.sync(); ghost.update(deps.tools); }

    if (ghost) ghost.group.visible = !photo.active;
    if (photo.active) world.icons.mesh.visible = false;
    world.render();
    const r = ctx.renderer.info.render;
    if (photo.capturing) { photo.service(); governor.noteWarmup(now); }
    drawCalls = r.drawCalls; triangles = r.triangles;
    frames++;
    frameMs = frameMs ? frameMs * 0.9 + dtMs * 0.1 : dtMs;
    fpsFrames++;
    if (now - fpsT0 >= 500) { fps = (fpsFrames * 1000) / (now - fpsT0); fpsFrames = 0; fpsT0 = now; }

    const moved = governor.frame(dtMs, now);
    if (moved) {
      tier = moved;
      ctx.setTier(tier);
      world.applyTier(tier);
      governor.noteWarmup(now);
      deps.onTier?.(tier);
    }
    if (governor.factor !== appliedFactor) {
      appliedFactor = governor.factor;
      ctx.setResolutionFactor(appliedFactor);
    }
    sendViewRect(now);
  };

  const start = async (): Promise<void> => {
    if (mirror.hasResync) world.terrain.update(rig.state.x, rig.state.z, TIER_TABLE[tier].fullDetailChunks);
    governor.noteWarmup(performance.now());
    const compiling = world;
    await compiling.compile().catch(() => undefined);
    if (disposed || recovering || compiling !== world) return;
    governor.noteWarmup(performance.now());
    ctx.renderer.setAnimationLoop(frame);
  };

  async function recover(message: string): Promise<void> {
    if (disposed || recovering) return;
    recovering = true;
    deviceLosses++;
    console.warn(`[render] device lost (${message}); rebuilding from the mirror`);
    try {
      ctx.renderer.setAnimationLoop(null);
      try { ghost?.dispose(); } catch { /* same */ }
      try { world.dispose(); } catch { /* the device is gone; the GPU objects went with it */ }
      try { ctx.dispose(); } catch { /* same */ }
      const parts = await createParts();
      if (disposed) { parts.ghost?.dispose(); parts.world.dispose(); parts.ctx.dispose(); return; }
      ctx = parts.ctx;
      world = parts.world;
      ghost = parts.ghost;
      sawTerrain = false;
      governor = newGovernor();
      ctx.setTier(tier);
      photo.set({});
      lastRectKey = '';
      recovering = false;
      await start();
    } catch (e) {
      recovering = false;
      if (!disposed) deps.onFatal(e instanceof Error ? e.message : String(e));
    }
  }

  const ro = new ResizeObserver(() => {
    if (disposed || recovering) return;
    ctx.resize();
    world.setAspect(host.clientWidth / Math.max(1, host.clientHeight));
  });
  ro.observe(host);

  const debug: RenderDebug = {
    get ready() { return frames > 0 && !recovering; },
    get backend() { return ctx.backend; },
    get tier() { return tier; },
    get adapter() { return ctx.adapterLabel; },
    get software() { return ctx.software; },
    get frames() { return frames; },
    get fps() { return fps; },
    get drawCalls() { return drawCalls; },
    get triangles() { return triangles; },
    get drawCallBudget() { return TIER_TABLE[tier].drawCallBudget; },
    get deviceLosses() { return deviceLosses; },
    get pixelRatio() { return ctx.renderer.getPixelRatio(); },
    get showcaseCamera() { return showcaseCamera; },
    get buildings() {
      const b = world.buildings.stats;
      return { instances: b.instances, farInstances: b.farInstances, sites: b.sites, cranes: b.cranes, drawCalls: b.drawCalls };
    },
    get fx() { return world.fx.debug; },
    get ghostTiles() { return ghost?.painted ?? 0; },
    get overlay() { return { mode: world.overlay.mode, checksum: world.overlay.checksum, uploads: world.overlay.uploads }; },
    get underground() {
      const l = world.lines.stats;
      return { on: world.underground, cutaway: world.terrain.cutaway, pipeSegments: l.pipeSegments, pipeDraws: l.pipeDraws, buildingsHidden: !world.buildings.group.visible };
    },
    get lines() {
      const l = world.lines.stats;
      return { pylons: l.pylons, spans: l.spans, pipeSegments: l.pipeSegments, drawCalls: l.cableDraws };
    },
    get outageIcons() { return world.icons.icons; },
    setOverlay(mode) { if (!deps.view || !isOverlayMode(mode)) return false; deps.view.setOverlay(mode); return true; },
    setUnderground(on) { deps.view?.setUnderground(on); },
    get canvasCount() { return host.querySelectorAll('canvas').length; },
    get camera() {
      const s = rig.state, p = rig.pose();
      return { x: s.x, z: s.z, ty: s.ty, yaw: s.yaw, pitch: s.pitch, dist: s.dist, px: p.px, py: p.py, pz: p.pz };
    },
    get robots() { return world.robots.snapshot; },
    get traffic() { return { ...world.traffic.snapshot, sample: (n: number) => world.traffic.samplePositions(n) }; },
    get following() { return rig.following; },
    follow,
    agentKinds: () => deps.agents.kinds(),
    photo: {
      get active() { return photo.active; },
      enter: () => photo.enter(),
      exit: () => photo.exit(),
      capture: () => photo.capture(),
    },
    cinematic: { get active() { return cinematic.active; }, tour, skip: () => cinematic.skip() },
    pickTile: pickAt,
    resetCamera(pose) { startDone = true; rig.reset(pose?.x ?? RESET.x, pose?.z ?? RESET.z, pose?.yaw ?? RESET.yaw, pose?.pitch ?? RESET.pitch, pose?.dist ?? RESET.dist); },
    loseDevice() {
      const gl = (ctx.renderer.backend as unknown as { gl?: WebGL2RenderingContext }).gl;
      const ext = gl?.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext(); else onLost('simulated');
    },
  };

  await start();

  return {
    debug,
    photo,
    tour,
    perf: () => ({
      backend: ctx.backend, tier, adapter: ctx.adapterLabel, fps, frameMs, drawCalls, triangles,
      fineChunks: world.terrain.stats.fineChunks, coarseSupers: world.terrain.stats.coarseSupers, tick: mirror.tick,
      buildings: (() => { const b = world.buildings.stats; return { instances: b.instances, farInstances: b.farInstances, drawCalls: b.drawCalls }; })(),
    }),
    dispose() {
      disposed = true;
      ro.disconnect();
      host.removeEventListener('pointerdown', stopCamera, true);
      host.removeEventListener('wheel', skipCinematic, true);
      photo.exit();
      window.removeEventListener('keydown', onKey);
      input.dispose();
      unblock();
      try { ctx.renderer.setAnimationLoop(null); ghost?.dispose(); world.dispose(); ctx.dispose(); } catch { /* already gone */ }
    },
  };
}
