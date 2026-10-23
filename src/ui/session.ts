import { BUILD_HASH } from '../sim/buildinfo.ts';
import { createSimClient, type ClientState, type SimClient } from '../sim/client.ts';
import type { Stats } from '../sim/protocol.ts';
import { RenderMirror } from '../render/mirror.ts';
import { createLifecycle, type Lifecycle } from '../platform/lifecycle.ts';
import { createPlatformService, type LiveStats, type PlatformService } from '../platform/service.ts';
import type { PlatformDb } from '../platform/db.ts';

// Debug query: ?seed=42&haltAt=200 runs the sim from that seed and halts at tick 200, reporting the state hash.
// A halting run uses max speed. Without haltAt the worker still includes the hash in Stats every HASH_EVERY ticks.
export const HASH_EVERY = 100;

export interface Session {
  client: SimClient;
  mirror: RenderMirror;
  service: PlatformService;
  lifecycle: Lifecycle;
  seed: number;
  dispose(): void;
}

export interface SessionOptions {
  seed: number;
  haltAt?: number;
  getDb(): PlatformDb | undefined;
  onState(state: ClientState): void;
  onStats(s: Stats): void;
}

export function openSession(o: SessionOptions): Session {
  const mirror = new RenderMirror();
  const w = new Worker(new URL(`./sim-worker.js?v=${BUILD_HASH}`, document.baseURI));
  const live: LiveStats = { population: 0, treasury: 0, day: 0 };
  const client = createSimClient(w, {
    seed: o.seed,
    haltAt: o.haltAt,
    hashEvery: HASH_EVERY,
    buildHash: BUILD_HASH,
    onState: (s) => o.onState(s),
    onPatch: (m) => { mirror.apply(m); },
    onStats: (s) => {
      mirror.apply(s);
      live.population = s.population; live.treasury = s.treasury; live.day = s.day;
      o.onStats(s);
    },
  });
  if (o.haltAt !== undefined) client.setSpeed('max');
  const service = createPlatformService({ getDb: () => o.getDb(), sim: client, stats: () => live });
  const lifecycle = createLifecycle({
    now: () => Date.now(),
    pauseSim: () => client.pause(),
    resumeSim: () => client.resume(),
    setSimSpeed: (s) => client.setSpeed(s),
    requestSnapshot: () => client.requestSnapshot(),
    write: (data) => service.writeSnapshot(data),
  });
  return { client, mirror, service, lifecycle, seed: o.seed, dispose: () => client.terminate() };
}
