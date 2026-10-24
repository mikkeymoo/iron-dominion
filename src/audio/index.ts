// Audio director: reads the game's state (mirror, agents, tool events, lifecycle, the renderer's debug camera and fx) and drives
// the engine, sfx, ambience and music. It never touches the sim; the whole system is a listener.
import { AGENT_KIND, makeSample, type AgentStore } from '../render/agentStore.ts';
import type { RenderMirror } from '../render/mirror.ts';
import type { Lifecycle, LifecycleState } from '../platform/lifecycle.ts';
import type { Settings } from '../platform/settings.ts';
import { BFLAG } from '../sim/catalog.ts';
import { BMAX, S } from '../sim/layers.ts';
import type { Stats } from '../sim/protocol.ts';
import type { SimEvent } from '../sim/world.ts';
import type { ToolsRuntime } from '../ui/toolsStore.ts';
import { Ambience } from './ambience.ts';
import { AudioEngine, type EngineState, type PlayingEntry } from './engine.ts';
import { populationLevel, nightness, type AmbienceInput, type AmbienceWeights, type MixSettings } from './mix.ts';
import { MusicPlayer } from './musicPlayer.ts';
import { Sfx, type SfxName } from './sfx.ts';

export interface AudioSource {
  mirror: RenderMirror;
  agents: AgentStore;
  tools: ToolsRuntime;
  lifecycle: Lifecycle;
}

/** `window.__iron.audio`: live getters. `buses` are the target gains after mute, volumes and the pause duck. */
export interface AudioDebug {
  readonly state: EngineState;
  readonly buses: { master: number; music: number; ambience: number; sfx: number };
  readonly playing: PlayingEntry[];
  readonly weights: AmbienceWeights;
  readonly musicNotes: number;
  play(name: SfxName): boolean;
}

declare module '../render/debug.ts' {
  interface IronDebug { audio?: AudioDebug }
}

export const mixOf = (s: Settings): MixSettings => ({ muted: s.audio.muted, volume: s.audio.volume, ...s.soundMix });

const STEP_MS = 250;
const MUSIC_EVERY = 4;
const SCAN_EVERY = 2;
const EARSHOT_TILES = 45;
const SITE_TILES = 30;
const AGENT_TILES = 30;
const WEATHER_BY_NAME: Record<string, number> = { clear: 0, rain: 1, snow: 2, storm: 3 };
const SETS_COMMANDS = new Set(['placeRoad', 'placeBuilding', 'placeLine', 'zone', 'terraform']);

interface Scan { nearBuildings: number; nearSites: number; nearRobots: number; nearDrones: number }

export class AudioDirector {
  readonly engine: AudioEngine;
  readonly sfx: Sfx;
  readonly ambience: Ambience;
  private music: MusicPlayer;
  private src: AudioSource | null = null;
  private detachSrc: (() => void) | null = null;
  private active = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stepNo = 0;
  private scan: Scan = { nearBuildings: 0, nearSites: 0, nearRobots: 0, nearDrones: 0 };
  private readonly sample = makeSample(256);
  private lastMonth = -2;
  private lastInvalid = -1e9;
  private lastLightning = 0;
  private unbindGestures: (() => void) | null = null;

  constructor(engine = new AudioEngine(), seed = 0x1d0a) {
    this.engine = engine;
    this.sfx = new Sfx(engine);
    this.ambience = new Ambience(engine, seed);
    this.music = new MusicPlayer(engine, seed);
  }

  get debug(): AudioDebug {
    const d = this;
    return {
      get state() { return d.engine.state; },
      get buses() { const b = d.engine.busLevels; return { master: b.master, music: b.music, ambience: b.ambience, sfx: b.sfx }; },
      get playing() { return d.engine.playing; },
      get weights() { return d.ambience.weights; },
      get musicNotes() { return d.music.played; },
      play: (name) => d.sfx.play(name),
    };
  }

  /** Arm the autoplay unlock: the context is created and resumed on the first gesture, never before. */
  bindGestures(target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>): void {
    this.unbindGestures?.();
    this.unbindGestures = this.engine.bindGestures(target);
  }

  applySettings(s: MixSettings): void { this.engine.applySettings(s); }

  /** Ambience and music run only while the game screen is up. */
  setActive(on: boolean): void {
    this.active = on;
    this.sync();
  }

  private sync(): void {
    const run = this.active && this.src !== null;
    if (run && this.timer === null) this.timer = setInterval(() => this.step(), STEP_MS);
    else if (!run && this.timer !== null) { clearInterval(this.timer); this.timer = null; }
  }

  /** Follow one city session. Returns a disposer that only detaches if that session is still the current one. */
  attach(src: AudioSource): () => void {
    this.detachSrc?.();
    this.src = src;
    this.lastMonth = -2;
    this.lastLightning = 0;
    const offs: (() => void)[] = [];
    const ids = new Map<number, string>();
    const { tools, lifecycle } = src;
    offs.push(tools.controller.onAction((a) => {
      if (a.kind === 'submitted') ids.set(a.id, a.cmd.type);
      else this.invalid();
    }));
    offs.push(tools.onCommandEvent((e) => {
      if (e.type !== 'accepted' && e.type !== 'rejected') return;
      const type = ids.get(e.cmd);
      ids.delete(e.cmd);
      if (e.type === 'rejected') { this.invalid(); return; }
      if (type === 'bulldoze') this.sfx.play('bulldoze');
      else if (type !== undefined && SETS_COMMANDS.has(type)) this.sfx.play('place');
    }));
    let sel = tools.controller.sel;
    offs.push(tools.controller.subscribe(() => {
      const now = tools.controller.sel;
      if (now !== sel) { sel = now; if (now !== null) this.sfx.play('toolSelect'); }
    }));
    let lastToast = tools.toasts.reduce((m, t) => Math.max(m, t.id), 0);
    offs.push(tools.subscribe(() => {
      const top = tools.toasts.reduce((m, t) => Math.max(m, t.id), 0);
      if (top > lastToast) {
        lastToast = top;
        if (performance.now() - this.lastInvalid > 200) this.sfx.play('toast');
      }
    }));
    const onLifecycle = (s: Readonly<LifecycleState>): void => {
      void this.engine.setSuspended(!s.visible || s.awaitingResume);
      this.engine.setPaused(s.speed === 0);
    };
    onLifecycle(lifecycle.state);
    offs.push(lifecycle.subscribe(onLifecycle));
    if (typeof window !== 'undefined') {
      if (!this.unbindGestures) this.bindGestures(window);
      if (window.__iron) window.__iron.audio = this.debug;
    }
    this.sync();
    const detach = (): void => {
      if (this.detachSrc !== detach) return;
      for (const off of offs) off();
      this.src = null;
      this.detachSrc = null;
      this.sync();
    };
    this.detachSrc = detach;
    return detach;
  }

  isAttached(src: AudioSource): boolean { return this.src === src; }

  private invalid(): void {
    this.lastInvalid = performance.now();
    this.sfx.play('invalid');
  }

  /** Sim events: lightning becomes thunder after the sound-travel delay for its distance from the camera. */
  handleEvents(events: readonly SimEvent[]): void {
    const cam = window.__iron?.render?.camera;
    for (const e of events) {
      if (e.type !== 'lightning') continue;
      const dist = cam ? Math.hypot(e.x - cam.x, e.y - cam.z) : 40;
      this.ambience.thunder(dist);
    }
  }

  /** Stats: a budget month that closes in the black plays the coin chime. The first stats after attach only seed the counter. */
  handleStats(s: Stats): void {
    const m = s.lastMonth.month;
    if (this.lastMonth === -2) { this.lastMonth = m; return; }
    if (m > this.lastMonth) {
      this.lastMonth = m;
      if (s.lastMonth.net > 0) this.sfx.play('money');
    }
  }

  milestone(): void { this.sfx.play('milestone'); }

  private scanWorld(fx: number, fz: number): Scan {
    const src = this.src;
    const out: Scan = { nearBuildings: 0, nearSites: 0, nearRobots: 0, nearDrones: 0 };
    if (!src) return out;
    const t = src.mirror.table;
    for (let b = 0; b < BMAX; b++) {
      if (t.bArch[b] === 0) continue;
      const dx = t.bX[b]! - fx, dz = t.bY[b]! - fz;
      const d2 = dx * dx + dz * dz;
      if (d2 > EARSHOT_TILES * EARSHOT_TILES) continue;
      out.nearBuildings++;
      const f = t.bFlags[b]!;
      if ((f & BFLAG.CONSTRUCTING) !== 0 && d2 <= SITE_TILES * SITE_TILES) out.nearSites++;
    }
    const smp = src.agents.sample(performance.now(), this.sample, 256, fx, fz);
    for (let i = 0; i < smp.count; i++) {
      const dx = smp.pos[i * 3]! - fx, dz = smp.pos[i * 3 + 1]! - fz;
      if (dx * dx + dz * dz > AGENT_TILES * AGENT_TILES) continue;
      if (smp.kind[i] === AGENT_KIND.BUILDER) out.nearRobots++; else out.nearDrones++;
    }
    return out;
  }

  /** The ambience input for the current frame, from the mirror and the renderer's debug camera and fx. */
  readInput(): AmbienceInput | null {
    const src = this.src;
    if (!src) return null;
    const sc = src.mirror.scalars;
    const dbg = window.__iron?.render;
    const cam = dbg?.camera;
    const fx = dbg?.fx;
    const pinned = fx?.overrides.weather === true;
    const kind = fx ? (WEATHER_BY_NAME[fx.weather] ?? 0) : Math.round(sc[S.weather]!);
    const intensity = pinned ? (kind === 0 ? 0 : kind === 3 ? 1 : 0.85) : sc[S.weatherIntensity]!;
    if (this.stepNo % SCAN_EVERY === 0) this.scan = this.scanWorld(cam?.x ?? 128, cam?.z ?? 128);
    return {
      camDist: cam?.dist ?? 120, population: sc[S.population]!, weather: kind, weatherIntensity: intensity,
      dayFrac: fx?.dayFrac ?? sc[S.dayFrac]!, ...this.scan,
    };
  }

  private step(): void {
    this.stepNo++;
    if (!this.engine.live) return;
    const input = this.readInput();
    if (!input) return;
    this.ambience.update(input, STEP_MS / 1000);
    const fx = window.__iron?.render?.fx;
    if (fx?.overrides.weather) {
      if (fx.lightning > this.lastLightning) this.ambience.thunder(20 + (this.stepNo * 37) % 60);
      this.lastLightning = fx.lightning;
    }
    if (this.stepNo % MUSIC_EVERY === 0) this.music.tick({ size: populationLevel(input.population), night: nightness(input.dayFrac) });
  }

  dispose(): void {
    this.detachSrc?.();
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
    this.unbindGestures?.();
    this.unbindGestures = null;
    this.ambience.dispose();
    this.music.dispose();
    this.engine.dispose();
  }
}

let shared: AudioDirector | null = null;
export const audio = (): AudioDirector => (shared ??= new AudioDirector());

export interface SessionAudio {
  events(events: readonly SimEvent[]): void;
  stats(s: Stats): void;
  dispose(): void;
}

/** Hook for openSession: follow this session's tools and lifecycle, and take its sim events and stats. */
export function attachSessionAudio(src: AudioSource): SessionAudio {
  const a = audio();
  const detach = a.attach(src);
  return {
    events: (e) => { if (a.isAttached(src)) a.handleEvents(e); },
    stats: (s) => { if (a.isAttached(src)) a.handleStats(s); },
    dispose: detach,
  };
}
