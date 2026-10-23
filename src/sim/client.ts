import type { CommandBody } from './commands.ts';
import {
  PROTOCOL_VERSION, type AgentsMsg, type EventsMsg, type FromWorker, type PathMsg, type Speed, type Stats, type ToWorker,
} from './protocol.ts';

export type ClientState = 'loading' | 'ready' | 'failed';

export interface ClientOptions {
  seed?: number;
  debug?: boolean;
  haltAt?: number;
  hashEvery?: number;
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
  returnAgents(m: AgentsMsg): void;
  terminate(): void;
}

/** Wraps a Worker (or any object with its shape): handshake, error plumbing, typed API. No DOM beyond Worker/console. */
export function createSimClient(worker: Worker, opt: ClientOptions = {}): SimClient {
  let state: ClientState = 'loading';
  let nextCmd = 1;
  let nextSnap = 1;
  const snaps = new Map<number, { res: (d: Uint8Array) => void; rej: (e: Error) => void }>();
  let nextPath = 1;
  const paths = new Map<number, { res: (m: PathMsg) => void; rej: (e: Error) => void }>();
  const rejectSnaps = (why: string): void => {
    for (const p of snaps.values()) p.rej(new Error(why));
    snaps.clear();
    for (const p of paths.values()) p.rej(new Error(why));
    paths.clear();
  };

  const setState = (s: ClientState, error?: string): void => {
    state = s;
    if (error) console.error(`[sim] ${error}`);
    if (s === 'failed') rejectSnaps(error ?? 'sim failed');
    opt.onState?.(s, error);
  };
  const send = (m: ToWorker, transfer: Transferable[] = []): void => worker.postMessage(m, transfer);

  worker.onmessage = (e: MessageEvent<FromWorker>) => {
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
    }
  };
  worker.onerror = (e) => setState('failed', `worker error: ${e.message || 'unknown'}`);
  worker.onmessageerror = () => setState('failed', 'worker message could not be deserialised');

  send({ type: 'hello', protocolVersion: PROTOCOL_VERSION, buildHash: opt.buildHash, seed: opt.seed, debug: opt.debug, haltAt: opt.haltAt, hashEvery: opt.hashEvery });

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
      const id = nextPath++;
      if (state === 'failed') return Promise.reject(new Error('sim failed'));
      return new Promise<PathMsg>((res, rej) => { paths.set(id, { res, rej }); send({ type: 'requestPath', id, from, to }); });
    },
    returnAgents: (m) => send({ type: 'agentsReturn', pos: m.pos, ids: m.ids }, [m.pos.buffer, m.ids.buffer]),
    terminate() {
      rejectSnaps('client terminated');
      worker.terminate();
    },
  };
}
