import type { CommandBody } from './commands.ts';
import type { ScenarioChoice } from './scenarios.ts';
import {
  PROTOCOL_VERSION, type AgentsMsg, type BudgetMsg, type EventsMsg, type FromWorker, type InfoKind, type InfoMsg, type PathMsg, type Speed, type Stats,
  type ToWorker,
} from './protocol.ts';

const PATH_TIMEOUT_MS = 10000;

export type ClientState = 'loading' | 'ready' | 'failed';

export interface ClientOptions {
  seed?: number;
  debug?: boolean;
  haltAt?: number;
  hashEvery?: number;
  /** The Disasters setting the city opens with (0 off, 1 rare, 2 normal). */
  disasters?: number;
  /** Open a scenario or daily/weekly challenge instead of a sandbox city; the scenario's own seed replaces `seed`. */
  scenario?: ScenarioChoice;
  buildHash?: string;
  onState?: (state: ClientState, error?: string) => void;
  onStats?: (s: Stats) => void;
  onEvents?: (e: EventsMsg) => void;
  /** Resync, ChunkPatch and OverlayPatch go here (feed a RenderMirror). */
  onPatch?: (m: FromWorker) => void;
  /** Return true to keep the buffers; then call `returnAgents(msg)` when done reading them. */
  onAgents?: (m: AgentsMsg) => boolean | void;
}

export interface SimClient {
  readonly state: ClientState;
  command(body: CommandBody): number;
  setSpeed(speed: Speed): void;
  pause(): void;
  resume(): void;
  setViewRect(x0: number, y0: number, x1: number, y1: number): void;
  requestResync(): void;
  requestHash(): void;
  requestSnapshot(): Promise<Uint8Array>;
  loadSnapshot(data: Uint8Array): void;
  /** Debug sessions only: the worker answers every request, with `ok: false` and a reason when it cannot. */
  requestPath(from: { x: number; y: number }, to: { x: number; y: number }): Promise<PathMsg>;
  /** The 12-month budget history, the running month's projection, loans and tax rates. */
  requestBudget(): Promise<BudgetMsg>;
  /** What a building (ref = slot) or a robot or vehicle (ref = its agent key) is thinking; `ok: false` when it is gone. Read-only. */
  requestInfo(kind: InfoKind, ref: number): Promise<InfoMsg>;
  returnAgents(m: AgentsMsg): void;
  terminate(): void;
}

/** Makes the Worker. Attempt 0 is the first try; attempt 1 is the single retry after a load failure, which should use a cache-busting URL. */
export type WorkerFactory = (attempt: number) => Worker;

/**
 * Wraps a Worker (or any object with its shape): handshake, error plumbing, typed API. No DOM beyond Worker/console.
 * Given a factory, a worker that errors before sending any message (a load failure) is replaced once before the client fails.
 */
export function createSimClient(source: Worker | WorkerFactory, opt: ClientOptions = {}): SimClient {
  const factory = typeof source === 'function' ? source : undefined;
  let worker: Worker = typeof source === 'function' ? source(0) : source;
  let heard = false;
  let retried = false;
  const early: ToWorker[] = [];
  let state: ClientState = 'loading';
  let nextCmd = 1;
  let nextSnap = 1;
  const snaps = new Map<number, { res: (d: Uint8Array) => void; rej: (e: Error) => void }>();
  let nextPath = 1;
  const paths = new Map<number, { res: (m: PathMsg) => void; rej: (e: Error) => void }>();
  let nextBudget = 1;
  const budgets = new Map<number, { res: (m: BudgetMsg) => void; rej: (e: Error) => void }>();
  let nextInfo = 1;
  const infos = new Map<number, { res: (m: InfoMsg) => void; rej: (e: Error) => void }>();
  const rejectSnaps = (why: string): void => {
    for (const p of infos.values()) p.rej(new Error(why));
    infos.clear();
    for (const p of snaps.values()) p.rej(new Error(why));
    snaps.clear();
    for (const p of paths.values()) p.rej(new Error(why));
    paths.clear();
    for (const p of budgets.values()) p.rej(new Error(why));
    budgets.clear();
  };

  const setState = (s: ClientState, error?: string): void => {
    state = s;
    if (error) console.error(`[sim] ${error}`);
    if (s === 'failed') rejectSnaps(error ?? 'sim failed');
    opt.onState?.(s, error);
  };
  const send = (m: ToWorker, transfer: Transferable[] = []): void => {
    if (!heard && factory && !retried && transfer.length === 0) early.push(m);
    worker.postMessage(m, transfer);
  };

  const onMessage = (e: MessageEvent<FromWorker>): void => {
    heard = true;
    early.length = 0;
    const m = e.data;
    switch (m.type) {
      case 'ready':
        if (m.protocolVersion !== PROTOCOL_VERSION) setState('failed', `protocol mismatch: worker ${m.protocolVersion}, client ${PROTOCOL_VERSION}`);
        else setState('ready');
        break;
      case 'error': setState('failed', m.message); break;
      case 'resync': case 'chunkPatch': case 'overlayPatch': opt.onPatch?.(m); break;
      case 'agents':
        if (opt.onAgents?.(m) !== true) send({ type: 'agentsReturn', pos: m.pos, ids: m.ids }, [m.pos.buffer, m.ids.buffer]);
        break;
      case 'events': opt.onEvents?.(m); break;
      case 'stats': opt.onStats?.(m); break;
      case 'snapshot': snaps.get(m.id)?.res(m.data); snaps.delete(m.id); break;
      case 'path': paths.get(m.id)?.res(m); paths.delete(m.id); break;
      case 'budget': budgets.get(m.id)?.res(m); budgets.delete(m.id); break;
      case 'info': infos.get(m.id)?.res(m); infos.delete(m.id); break;
    }
  };
  const onError = (e: ErrorEvent): void => {
    if (!heard && factory && !retried) {
      retried = true;
      console.warn(`[sim] worker failed to load (${e.message || 'unknown'}); retrying once`);
      const resend = early.splice(0);
      worker.terminate();
      try { worker = factory(1); } catch (err) { setState('failed', `worker error: ${err instanceof Error ? err.message : String(err)}`); return; }
      wire(worker);
      for (const m of resend) worker.postMessage(m);
      return;
    }
    setState('failed', `worker error: ${e.message || 'unknown'}`);
  };
  const wire = (w: Worker): void => {
    w.onmessage = onMessage;
    w.onerror = onError;
    w.onmessageerror = () => setState('failed', 'worker message could not be deserialised');
  };
  wire(worker);

  send({ type: 'hello', protocolVersion: PROTOCOL_VERSION, buildHash: opt.buildHash, seed: opt.seed, debug: opt.debug, haltAt: opt.haltAt, hashEvery: opt.hashEvery, disasters: opt.disasters, scenario: opt.scenario });

  return {
    get state() { return state; },
    command(body) {
      const id = nextCmd++;
      send({ type: 'command', cmd: { ...body, id, tick: 0 } });
      return id;
    },
    setSpeed: (speed) => send({ type: 'setSpeed', speed }),
    pause: () => send({ type: 'pause' }),
    resume: () => send({ type: 'resume' }),
    setViewRect: (x0, y0, x1, y1) => send({ type: 'viewRect', x0, y0, x1, y1 }),
    requestResync: () => send({ type: 'requestResync' }),
    requestHash: () => send({ type: 'requestHash' }),
    requestSnapshot() {
      const id = nextSnap++;
      if (state === 'failed') return Promise.reject(new Error('sim failed'));
      return new Promise<Uint8Array>((res, rej) => { snaps.set(id, { res, rej }); send({ type: 'requestSnapshot', id }); });
    },
    loadSnapshot: (data) => send({ type: 'loadSnapshot', data }, [data.buffer]),
    requestPath(from, to) {
      if (state !== 'ready') return Promise.reject(new Error(state === 'failed' ? 'sim failed' : 'sim not ready'));
      const id = nextPath++;
      return new Promise<PathMsg>((res, rej) => {
        const timer = setTimeout(() => { paths.delete(id); rej(new Error('path request timed out')); }, PATH_TIMEOUT_MS);
        paths.set(id, { res: (m) => { clearTimeout(timer); res(m); }, rej: (e) => { clearTimeout(timer); rej(e); } });
        send({ type: 'requestPath', id, from, to });
      });
    },
    requestBudget() {
      if (state !== 'ready') return Promise.reject(new Error(state === 'failed' ? 'sim failed' : 'sim not ready'));
      const id = nextBudget++;
      return new Promise<BudgetMsg>((res, rej) => {
        const timer = setTimeout(() => { budgets.delete(id); rej(new Error('budget request timed out')); }, PATH_TIMEOUT_MS);
        budgets.set(id, { res: (m) => { clearTimeout(timer); res(m); }, rej: (e) => { clearTimeout(timer); rej(e); } });
        send({ type: 'requestBudget', id });
      });
    },
    requestInfo(kind, ref) {
      if (state !== 'ready') return Promise.reject(new Error(state === 'failed' ? 'sim failed' : 'sim not ready'));
      const id = nextInfo++;
      return new Promise<InfoMsg>((res, rej) => {
        const timer = setTimeout(() => { infos.delete(id); rej(new Error('info request timed out')); }, PATH_TIMEOUT_MS);
        infos.set(id, { res: (m) => { clearTimeout(timer); res(m); }, rej: (e) => { clearTimeout(timer); rej(e); } });
        send({ type: 'requestInfo', id, kind, ref });
      });
    },
    returnAgents: (m) => send({ type: 'agentsReturn', pos: m.pos, ids: m.ids }, [m.pos.buffer, m.ids.buffer]),
    terminate() {
      rejectSnaps('client terminated');
      worker.terminate();
    },
  };
}
