import { describe, expect, it } from 'vitest';
import { createSimClient } from './client.ts';
import { answerInfo } from './info.ts';
import { PROTOCOL_VERSION, type FromWorker, type InfoMsg, type ToWorker } from './protocol.ts';
import { AKIND } from './robots/constants.ts';
import { agents, depot, flatSim, road } from './robots/testkit.ts';
import { runTicks } from './testkit.ts';

/** A stand-in Worker that answers the handshake and runs requestInfo against a real sim, as the worker shell does. */
function fakeWorker(answer: (m: Extract<ToWorker, { type: 'requestInfo' }>) => InfoMsg | null) {
  const sent: ToWorker[] = [];
  const w = {
    onmessage: null as ((e: MessageEvent<FromWorker>) => void) | null,
    onerror: null, onmessageerror: null,
    postMessage(m: ToWorker) {
      sent.push(m);
      if (m.type === 'hello') queueMicrotask(() => w.onmessage?.({ data: { type: 'ready', protocolVersion: PROTOCOL_VERSION, hash: 0 } } as MessageEvent<FromWorker>));
      if (m.type === 'requestInfo') { const r = answer(m); if (r) queueMicrotask(() => w.onmessage?.({ data: r } as MessageEvent<FromWorker>)); }
    },
    terminate() {},
  };
  return { w: w as unknown as Worker, sent };
}

describe('requestInfo round trip', () => {
  it('resolves with the worker answer for the matching id, and matches concurrent requests by id', async () => {
    const sim = flatSim(42, true);
    road(sim, 96, 104, 130, 104);
    depot(sim, 98, 102);
    runTicks(sim, 100);
    const a = agents(sim, AKIND.BUILDER)[0]!;
    const key = (a | (sim.world.aGen[a]! << 16)) >>> 0;
    const { w, sent } = fakeWorker((m) => answerInfo(sim, m));
    const client = createSimClient(w);
    await Promise.resolve();
    const [robot, gone] = await Promise.all([client.requestInfo('agent', key), client.requestInfo('building', 4000)]);
    expect(robot.ok).toBe(true);
    expect(robot.info).toMatchObject({ kind: 'agent', akind: AKIND.BUILDER });
    expect(gone).toMatchObject({ ok: false, reason: 'gone' });
    const asked = sent.filter((m) => m.type === 'requestInfo');
    expect(asked).toHaveLength(2);
    expect(new Set(asked.map((m) => m.id)).size).toBe(2);
  });

  it('rejects before the sim is ready and when the sim fails', async () => {
    const { w } = fakeWorker(() => null);
    const client = createSimClient(w);
    await expect(client.requestInfo('building', 1)).rejects.toThrow(/not ready/);
    await Promise.resolve();
    const pending = client.requestInfo('building', 1);
    (w as unknown as { onmessage: (e: MessageEvent<FromWorker>) => void }).onmessage({ data: { type: 'error', message: 'boom' } } as MessageEvent<FromWorker>);
    await expect(pending).rejects.toThrow(/boom/);
  });
});
