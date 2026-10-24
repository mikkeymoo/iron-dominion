/// <reference lib="webworker" />
import { apply, collectOutgoing, drainCommands, createSim, packAgents, restore, snapshot, stateHash, step, tickOf } from './engine.ts';
import { BUILD_HASH } from './buildinfo.ts';
import { AMAX, S } from './layers.ts';
import { budgetMessage, econStats } from './economy/index.ts';
import { directiveStats } from './directives.ts';
import { milestoneStats } from './milestones.ts';
import { queryPath } from './roads/index.ts';
import { workforceOf } from './robots/index.ts';
import { serviceStats } from './services/index.ts';
import { trafficStats } from './traffic/index.ts';
import { utilStats } from './utilities/index.ts';
import { PROTOCOL_VERSION, type AgentsMsg, type FromWorker, type Speed, type Stats, type ToWorker } from './protocol.ts';
import type { Sim } from './world.ts';

// Thin shell around engine.ts: handshake, speed-scaled fixed ticks, coalesced posts, agent ping-pong.
const ctx = self as unknown as DedicatedWorkerGlobalScope;

const TICK_MS = 100;
const POST_MS = 16;
const MAX_SLICE_MS = 12;
const OVERLAY_MS = 1000;
const STATS_MS = 250;
const CATCHUP_TICKS = 8;

interface AgentBuf { pos: Float32Array; ids: Uint32Array }

let sim: Sim | undefined;
let speed: Speed = 1;
let paused = false;
let halted = false;
let haltAt = 0;
let hashEvery = 0;
let view: { x0: number; y0: number; x1: number; y1: number } | undefined;
let handshaken = false;
let fatal = false;
let acc = 0;
let last = 0;
let lastPost = 0;
let lastOverlay = 0;
let lastStats = 0;
let lastHashTick = -1;
let wantHash = false;
let tickMs = 0;
let skippedSends = 0;
let lastAgentCount = 0;
let lastAgentTick = -1;
let viewDirty = false;
let timer: ReturnType<typeof setTimeout> | undefined;
const freeAgentBufs: AgentBuf[] = [0, 1].map(() => ({ pos: new Float32Array(AMAX * 3), ids: new Uint32Array(AMAX * 2) }));

const post = (m: FromWorker, transfer: Transferable[] = []): void => ctx.postMessage(m, transfer);
const fail = (message: string): void => post({ type: 'error', message });

function transferablesOf(m: FromWorker): Transferable[] {
  const t: Transferable[] = [];
  if (m.type === 'resync' || m.type === 'chunkPatch' || m.type === 'overlayPatch') {
    for (const a of Object.values(m.layers)) t.push(a.buffer);
    if (m.type === 'resync') t.push(m.scalars.buffer);
  }
  return t;
}

function flush(now: number, force = false): void {
  if (!sim) return;
  if (!force && now - lastPost < POST_MS) return;
  lastPost = now;
  const overlay = now - lastOverlay >= OVERLAY_MS || force;
  if (overlay) lastOverlay = now;
  for (const m of collectOutgoing(sim, { overlay })) post(m, transferablesOf(m));

  // M1 coalescing: agents go out when the sim ticked or the view rect moved, not on every frame (thousands of vehicles per message).
  if (force || viewDirty || tickOf(sim) !== lastAgentTick) {
    const buf = freeAgentBufs.length > 0 ? freeAgentBufs.pop() : undefined;
    if (buf) {
      const count = packAgents(sim, buf.pos, buf.ids, view);
      if (count > 0 || lastAgentCount > 0) {
        const msg: AgentsMsg = { type: 'agents', tick: tickOf(sim), count, pos: buf.pos, ids: buf.ids };
        post(msg, [buf.pos.buffer, buf.ids.buffer]);
      } else freeAgentBufs.push(buf);
      lastAgentCount = count;
      lastAgentTick = tickOf(sim);
      viewDirty = false;
    } else if (lastAgentCount > 0) skippedSends++;
  }

  const hashDue = wantHash || (hashEvery > 0 && tickOf(sim) - lastHashTick >= hashEvery);
  if (force || hashDue || now - lastStats >= STATS_MS) {
    lastStats = now;
    const s = sim.world.scalars;
    const stats: Stats = {
      type: 'stats', tick: tickOf(sim), tickMs, skippedSends, halted,
      treasury: s[S.treasury]!, population: s[S.population]!, dayFrac: s[S.dayFrac]!, day: s[S.day]!,
      weather: s[S.weather]!, weatherIntensity: s[S.weatherIntensity]!, graphEpoch: s[S.graphEpoch]!,
      workforce: workforceOf(sim.world),
      traffic: trafficStats(sim.world),
      ...econStats(sim.world),
      ...utilStats(sim),
      ...serviceStats(sim),
      milestone: milestoneStats(sim.world),
      directives: directiveStats(sim.world),
    };
    if (hashDue) { stats.hash = stateHash(sim); lastHashTick = stats.tick; wantHash = false; }
    post(stats);
  }
}

function runSlice(now: number): void {
  if (!sim) return;
  const t0 = performance.now();
  let steps = 0;
  const canStep = (): boolean => haltAt === 0 || tickOf(sim!) < haltAt;
  if (speed === 'max') {
    while (canStep() && performance.now() - t0 < MAX_SLICE_MS) { step(sim); steps++; }
  } else {
    acc += (now - last) * speed;
    while (acc >= TICK_MS && steps < CATCHUP_TICKS && canStep()) { step(sim); acc -= TICK_MS; steps++; }
    if (steps === CATCHUP_TICKS) acc = 0;
  }
  if (!canStep()) { halted = true; paused = true; wantHash = true; }
  if (steps > 0) tickMs = (performance.now() - t0) / steps;
}

function loop(): void {
  timer = undefined;
  if (fatal) return;
  const now = performance.now();
  try {
    if (sim && !paused && !halted) runSlice(now);
    if (sim) flush(now, wantHash);
  } catch (e) {
    fatal = true;
    fail(`sim loop failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  last = now;
  timer = setTimeout(loop, speed === 'max' && !paused ? 0 : 8);
}

function startLoop(): void {
  last = performance.now();
  if (timer === undefined) timer = setTimeout(loop, 0);
}

ctx.onmessage = (e: MessageEvent<ToWorker>) => {
  try {
    const m = e.data;
    if (m.type === 'hello') {
      if (m.protocolVersion !== PROTOCOL_VERSION) {
        fail(`protocol mismatch: worker ${PROTOCOL_VERSION}, client ${m.protocolVersion}`);
        return;
      }
      if (m.buildHash !== undefined && m.buildHash !== BUILD_HASH) {
        fail(`build mismatch: worker ${BUILD_HASH}, app ${m.buildHash} (stale cache? reload the page)`);
        return;
      }
      sim = createSim(m.seed ?? 1, { debug: m.debug === true, disasters: m.disasters, starter: true });
      haltAt = m.haltAt ?? 0;
      hashEvery = m.hashEvery ?? 0;
      handshaken = true;
      post({ type: 'ready', protocolVersion: PROTOCOL_VERSION, hash: stateHash(sim) });
      flush(performance.now(), true);
      startLoop();
      return;
    }
    if (!handshaken || !sim || fatal) return;
    switch (m.type) {
      case 'command':
        apply(sim, m.cmd);
        // Players build while paused: run the command now (same tick, same order as the next step's first system) and
        // send the patch and events so the mirror and ghost update. A halted debug run keeps its tick-exact hash.
        if ((paused || speed === 0) && !halted) { drainCommands(sim); flush(performance.now(), true); }
        break;
      case 'requestResync': sim.resync = true; break;
      case 'agentsReturn': freeAgentBufs.push({ pos: m.pos, ids: m.ids }); break;
      case 'viewRect': view = { x0: m.x0, y0: m.y0, x1: m.x1, y1: m.y1 }; viewDirty = true; break;
      case 'setSpeed': speed = m.speed; acc = 0; break;
      case 'pause': paused = true; break;
      case 'resume': if (!halted) { paused = false; last = performance.now(); } break;
      case 'requestHash': wantHash = true; break;
      case 'requestPath': post(queryPath(sim, m.id, m.from, m.to)); break;
      case 'requestBudget': post(budgetMessage(sim.world, m.id)); break;
      case 'requestSnapshot': {
        const data = snapshot(sim);
        post({ type: 'snapshot', id: m.id, tick: tickOf(sim), data }, [data.buffer]);
        break;
      }
      case 'loadSnapshot':
        try {
          const next = restore(m.data);
          next.debug = sim.debug;
          const tick = tickOf(sim);
          const dropped = sim.queue.map((c) => ({ type: 'rejected' as const, cmd: c.id, tick, reason: 'superseded' }));
          next.events.push(...sim.events, ...dropped);
          sim = next;
          lastHashTick = -1;
          halted = false;
          acc = 0;
          lastAgentCount = 0;
          lastAgentTick = -1;
          flush(performance.now(), true);
        } catch (err) {
          fail(`snapshot rejected: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
    }
  } catch (err) {
    fail(`message failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};

ctx.onerror = (ev) => {
  fail(`worker error: ${typeof ev === 'string' ? ev : ev.message}`);
};
