import { MAP } from '../sim/layers.ts';
import type { AgentStore } from './agentStore.ts';
import type { SimClient } from '../sim/client.ts';
import { CameraRig, pixelToNdc, rayFromPose } from './camera.ts';
import { blockGestureZoom, createRenderContext, parseBackend, type RenderContext } from './context.ts';
import type { RenderDebug } from './debug.ts';
import { surfaceHeight } from './heightfield.ts';
import { bindCameraInput } from './input.ts';
import type { RenderMirror } from './mirror.ts';
import { pickPoint, pickTile } from './picking.ts';
import { computeViewRect } from './viewrect.ts';
import { WorldScene } from './scene.ts';
import { planShowcase } from './kit/showcase.ts';
import { TIER_TABLE, createGovernor, readStoredTier, resolveTier, type Governor, type Tier } from './tier.ts';
import type { ToolController } from './tools/controller.ts';
import { GhostView } from './tools/ghostView.ts';
import { createToolInput } from './tools/pointer.ts';

export interface GameDeps {
  host: HTMLElement;
  mirror: RenderMirror;
  client: SimClient;
  search: string;
  /** Build tools: when set, an active tool takes one-finger / left-button drags and the ghost preview is drawn. */
  tools?: ToolController;
  /** Interpolated robot positions fed by the sim's Agents messages. */
  agents: AgentStore;
  /** Called when the renderer cannot be recovered after a device loss. */
  onFatal: (message: string) => void;
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
  let disposed = false;
  let recovering = false;
  let deviceLosses = 0;
  let frames = 0, fps = 0, frameMs = 0, fpsFrames = 0, fpsT0 = 0;
  let drawCalls = 0, triangles = 0;
  let lastNow = 0, lastRectAt = 0, lastRectKey = '';
  let sawTerrain = false;
  let showcaseDone = false;
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
    resolved = resolveTier(
      { backend: c.backend, software: c.software }, q.get('tier'),
      readStoredTier(typeof localStorage === 'undefined' ? undefined : localStorage),
    );
    tier = resolved.tier;
  });
  ctx = parts.ctx;
  world = parts.world;
  ghost = parts.ghost;
  sawTerrain = false;
  governor = createGovernor({ tier, enabled: governorOn && resolved.source !== 'query' });
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
  const input = bindCameraInput({ element: host, rig, groundAt, tool: deps.tools ? createToolInput(deps.tools, pickAt) : undefined });

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
  // A tap or click anywhere on the view, or Escape, hands the camera back.
  const stopFollowing = (): void => { if (rig.following) follow(false); };
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') stopFollowing(); };
  host.addEventListener('pointerdown', stopFollowing, true);
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
    const pose = rig.pose();
    world.applyPose(pose);
    world.update(dt, now / 1000, pose, rig.state.dist, rig.state.pitch);
    world.updateRobots(dt, now, pose);

    if (mirror.hasResync) {
      world.terrain.update(rig.state.x, rig.state.z, TIER_TABLE[tier].fullDetailChunks);
      if (!sawTerrain && world.terrain.builds > 0) { sawTerrain = true; governor.noteWarmup(now); }
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
    mirror.takeDirtyOverlay();
    world.buildings.update();
    if (deps.tools && ghost) { deps.tools.sync(); ghost.update(deps.tools); }

    world.render();
    const r = ctx.renderer.info.render;
    drawCalls = r.drawCalls; triangles = r.triangles;
    frames++;
    frameMs = frameMs ? frameMs * 0.9 + dtMs * 0.1 : dtMs;
    fpsFrames++;
    if (now - fpsT0 >= 500) { fps = (fpsFrames * 1000) / (now - fpsT0); fpsFrames = 0; fpsT0 = now; }

    const dropped = governor.frame(dtMs, now);
    if (dropped) {
      tier = dropped;
      ctx.setTier(tier);
      world.applyTier(tier);
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
      governor = createGovernor({ tier, enabled: governorOn && resolved.source !== 'query' });
      ctx.setTier(tier);
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
    get showcaseCamera() { return showcaseCamera; },
    get buildings() {
      const b = world.buildings.stats;
      return { instances: b.instances, farInstances: b.farInstances, sites: b.sites, cranes: b.cranes, drawCalls: b.drawCalls };
    },
    get fx() { return world.fx.debug; },
    get ghostTiles() { return ghost?.painted ?? 0; },
    get canvasCount() { return host.querySelectorAll('canvas').length; },
    get camera() {
      const s = rig.state, p = rig.pose();
      return { x: s.x, z: s.z, ty: s.ty, yaw: s.yaw, pitch: s.pitch, dist: s.dist, px: p.px, py: p.py, pz: p.pz };
    },
    get robots() { return world.robots.snapshot; },
    get following() { return rig.following; },
    follow,
    pickTile: pickAt,
    resetCamera(pose) { rig.reset(pose?.x ?? RESET.x, pose?.z ?? RESET.z, pose?.yaw ?? RESET.yaw, pose?.pitch ?? RESET.pitch, pose?.dist ?? RESET.dist); },
    loseDevice() {
      const gl = (ctx.renderer.backend as unknown as { gl?: WebGL2RenderingContext }).gl;
      const ext = gl?.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext(); else onLost('simulated');
    },
  };

  await start();

  return {
    debug,
    perf: () => ({
      backend: ctx.backend, tier, adapter: ctx.adapterLabel, fps, frameMs, drawCalls, triangles,
      fineChunks: world.terrain.stats.fineChunks, coarseSupers: world.terrain.stats.coarseSupers, tick: mirror.tick,
      buildings: (() => { const b = world.buildings.stats; return { instances: b.instances, farInstances: b.farInstances, drawCalls: b.drawCalls }; })(),
    }),
    dispose() {
      disposed = true;
      ro.disconnect();
      host.removeEventListener('pointerdown', stopFollowing, true);
      window.removeEventListener('keydown', onKey);
      input.dispose();
      unblock();
      try { ctx.renderer.setAnimationLoop(null); ghost?.dispose(); world.dispose(); ctx.dispose(); } catch { /* already gone */ }
    },
  };
}
