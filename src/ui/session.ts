import { BUILD_HASH } from '../sim/buildinfo.ts';
import { createSimClient, type ClientState, type SimClient } from '../sim/client.ts';
import type { Stats } from '../sim/protocol.ts';
import type { ScenarioChoice } from '../sim/scenarios.ts';
import { AgentStore } from '../render/agentStore.ts';
import { RenderMirror } from '../render/mirror.ts';
import { ViewState } from '../render/viewState.ts';
import { Journal, awaySummary, type JournalData } from '../platform/journal.ts';
import { createLifecycle, type Lifecycle } from '../platform/lifecycle.ts';
import { AwayStore } from './away.ts';
import { PacingStore } from './pacing.ts';
import { createPlatformService, type PlatformService, type SaveInfo } from '../platform/service.ts';
import { fail, ok, type Outcome, type PlatformDb } from '../platform/db.ts';
import { ToolsRuntime } from './toolsStore.ts';
import { WhyStore } from './whyStore.ts';
import { attachSessionAudio } from '../audio/index.ts';

// Debug query: ?seed=42&haltAt=200 runs the sim from that seed and halts at tick 200, reporting the state hash.
// A halting run uses max speed. Without haltAt the worker still includes the hash in Stats every HASH_EVERY ticks.
export const HASH_EVERY = 100;

export interface Session {
  client: SimClient;
  mirror: RenderMirror;
  /** Interpolated robot positions from the sim's Agents messages. */
  agents: AgentStore;
  tools: ToolsRuntime;
  /** The advisor's issue list, the tapped building or robot, and the depot-radius tint (ui/whyStore.ts). */
  why: WhyStore;
  /** Overlay mode and underground view for this city. */
  view: ViewState;
  service: PlatformService;
  lifecycle: Lifecycle;
  /** What happened in this city, from the sim's events and stats; saved in the slot's header and read back by the "while you were away" card. */
  journal: Journal;
  /** Safe stopping points and crisis auto-pause (ui/pacing.ts). */
  pacing: PacingStore;
  /** The recap behind the "while you were away" card (ui/AwayCard.tsx). */
  away: AwayStore;
  seed: number;
  dispose(): void;
}

export interface SessionOptions {
  seed: number;
  haltAt?: number;
  /** Enables debug-only sim commands (debugGrow, debugLevel); set by ?debug=1 or ?showcase=1. */
  debug?: boolean;
  /** The Disasters setting the city opens with (0 off, 1 rare, 2 normal). */
  disasters?: number;
  /** Open this scenario or challenge instead of a sandbox city. */
  scenario?: ScenarioChoice;
  /** The "Pause on crises" setting, read when a crisis arrives. A halting debug run (haltAt) never auto-pauses. */
  pauseOnCrises?(): boolean;
  getDb(): PlatformDb | undefined;
  onState(state: ClientState, error?: string): void;
  onStats(s: Stats): void;
}

/** The retry URL differs from the first so a poisoned HTTP or service worker cache entry for the first cannot answer it. */
export function workerUrl(attempt: number): URL {
  return new URL(`./sim-worker.js?v=${BUILD_HASH}${attempt > 0 ? `&r=${Date.now()}` : ''}`, document.baseURI);
}

export function openSession(o: SessionOptions): Session {
  const mirror = new RenderMirror();
  const view = new ViewState();
  const agents = new AgentStore();
  const spawn = (attempt: number): Worker => new Worker(workerUrl(attempt));
  const tools = new ToolsRuntime({ world: mirror, submit: (body) => client.command(body), view });
  const why = new WhyStore({ requestInfo: (kind, ref) => client.requestInfo(kind, ref), mirror, view, tools });
  const client: SimClient = createSimClient(spawn, {
    seed: o.seed,
    debug: o.debug,
    disasters: o.disasters,
    scenario: o.scenario,
    haltAt: o.haltAt,
    hashEvery: HASH_EVERY,
    buildHash: BUILD_HASH,
    onState: (s, error) => o.onState(s, error),
    onPatch: (m) => { mirror.apply(m); },
    // The store copies what it needs, so the client hands the ping-pong buffers straight back to the worker.
    onAgents: (m) => { agents.ingest(m, performance.now()); return false; },
    // The mirror queues lightning strikes for the renderer; the tools runtime tracks command outcomes.
    onEvents: (m) => { mirror.apply(m); tools.handleEvents(m.events); sound.events(m.events); journal.record(m.events); pacing.events(m.events); },
    onStats: (s) => {
      mirror.apply(s);
      why.stats(s);
      sound.stats(s);
      journal.observe({ tick: s.tick, treasury: s.treasury, approval: s.council.approval, population: s.population });
      pacing.council(s.council);
      o.onStats(s);
    },
  });
  if (o.haltAt !== undefined) client.setSpeed('max');
  const journal = new Journal();
  const service = createPlatformService({ getDb: () => o.getDb(), sim: client, journal: () => journal.data() });
  const lifecycle = createLifecycle({
    now: () => Date.now(),
    pauseSim: () => client.pause(),
    resumeSim: () => client.resume(),
    setSimSpeed: (s) => client.setSpeed(s),
    requestSnapshot: () => client.requestSnapshot(),
    hasSlot: () => service.current !== null,
    write: (data, _why, opt) => service.writeSnapshot(data, opt),
  }, { initialSpeed: o.haltAt !== undefined ? 'max' : 1 });
  const pacing = new PacingStore({
    speed: () => lifecycle.state.speed,
    pause: () => lifecycle.setSpeed(0),
    enabled: () => o.haltAt === undefined && (o.pauseOnCrises?.() ?? true),
    safeStop: () => { lifecycle.safeStop(); },
  });
  const away = new AwayStore();
  // The sim is paused while the page is hidden, so a long absence has nothing newer than the last moments of play: the card recaps those.
  let seenReturn = 0;
  const unsubReturn = lifecycle.subscribe((st) => {
    if (!st.returned || st.returned.n === seenReturn) return;
    seenReturn = st.returned.n;
    away.open(awaySummary(journal.data()), 'return');
  });
  const sound = attachSessionAudio({ mirror, agents, tools, lifecycle });
  return {
    client, mirror, agents, tools, why, view, service, lifecycle, journal, pacing, away, seed: o.seed,
    dispose: () => { unsubReturn(); sound.dispose(); why.dispose(); tools.dispose(); pacing.dispose(); away.dispose(); client.terminate(); },
  };
}

/** A saved city was loaded into this session: take its journal and open the "while you were away" card on the last stretch of that play. */
export function noteResumed(s: Session, journal: JournalData | undefined): void {
  s.journal.load(journal);
  s.away.open(awaySummary(s.journal.data()), 'resume');
}

/** Manual Save (or Save as, with a name) through the lifecycle's single write queue. */
export async function saveSession(s: Session, asName?: string): Promise<Outcome<SaveInfo>> {
  const out = await s.lifecycle.saveNow('manual', asName);
  if (!out.ok) return fail(out.reason, out.message ?? '');
  if (!out.slot || out.tick === undefined || out.hash === undefined) return fail('unavailable', 'nothing was saved');
  return ok({ slot: out.slot, tick: out.tick, hash: out.hash });
}
