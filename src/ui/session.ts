import { BUILD_HASH } from '../sim/buildinfo.ts';
import { createSimClient, type ClientState, type SimClient } from '../sim/client.ts';
import type { Stats } from '../sim/protocol.ts';
import { AgentStore } from '../render/agentStore.ts';
import { RenderMirror } from '../render/mirror.ts';
import { ViewState } from '../render/viewState.ts';
import { createLifecycle, type Lifecycle } from '../platform/lifecycle.ts';
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
  getDb(): PlatformDb | undefined;
  onState(state: ClientState): void;
  onStats(s: Stats): void;
}

export function openSession(o: SessionOptions): Session {
  const mirror = new RenderMirror();
  const view = new ViewState();
  const agents = new AgentStore();
  const w = new Worker(new URL(`./sim-worker.js?v=${BUILD_HASH}`, document.baseURI));
  const tools = new ToolsRuntime({ world: mirror, submit: (body) => client.command(body), view });
  const why = new WhyStore({ requestInfo: (kind, ref) => client.requestInfo(kind, ref), mirror, view, tools });
  const client: SimClient = createSimClient(w, {
    seed: o.seed,
    debug: o.debug,
    disasters: o.disasters,
    haltAt: o.haltAt,
    hashEvery: HASH_EVERY,
    buildHash: BUILD_HASH,
    onState: (s) => o.onState(s),
    onPatch: (m) => { mirror.apply(m); },
    // The store copies what it needs, so the client hands the ping-pong buffers straight back to the worker.
    onAgents: (m) => { agents.ingest(m, performance.now()); return false; },
    // The mirror queues lightning strikes for the renderer; the tools runtime tracks command outcomes.
    onEvents: (m) => { mirror.apply(m); tools.handleEvents(m.events); sound.events(m.events); },
    onStats: (s) => {
      mirror.apply(s);
      why.stats(s);
      sound.stats(s);
      o.onStats(s);
    },
  });
  if (o.haltAt !== undefined) client.setSpeed('max');
  const service = createPlatformService({ getDb: () => o.getDb(), sim: client });
  const lifecycle = createLifecycle({
    now: () => Date.now(),
    pauseSim: () => client.pause(),
    resumeSim: () => client.resume(),
    setSimSpeed: (s) => client.setSpeed(s),
    requestSnapshot: () => client.requestSnapshot(),
    hasSlot: () => service.current !== null,
    write: (data, _why, opt) => service.writeSnapshot(data, opt),
  }, { initialSpeed: o.haltAt !== undefined ? 'max' : 1 });
  const sound = attachSessionAudio({ mirror, agents, tools, lifecycle });
  return { client, mirror, agents, tools, why, view, service, lifecycle, seed: o.seed, dispose: () => { sound.dispose(); why.dispose(); tools.dispose(); client.terminate(); } };
}

/** Manual Save (or Save as, with a name) through the lifecycle's single write queue. */
export async function saveSession(s: Session, asName?: string): Promise<Outcome<SaveInfo>> {
  const out = await s.lifecycle.saveNow('manual', asName);
  if (!out.ok) return fail(out.reason, out.message ?? '');
  if (!out.slot || out.tick === undefined || out.hash === undefined) return fail('unavailable', 'nothing was saved');
  return ok({ slot: out.slot, tick: out.tick, hash: out.hash });
}
