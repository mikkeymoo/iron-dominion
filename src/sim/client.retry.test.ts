import { describe, expect, it, vi } from 'vitest';
import { createSimClient, type ClientState } from './client.ts';
import { PROTOCOL_VERSION, type FromWorker, type ToWorker } from './protocol.ts';
import { workerUrl } from '../ui/session.ts';

function fakeWorker(id: number) {
  const sent: ToWorker[] = [];
  const w = {
    id, terminated: false,
    onmessage: null as ((e: MessageEvent<FromWorker>) => void) | null,
    onerror: null as ((e: ErrorEvent) => void) | null,
    onmessageerror: null as (() => void) | null,
    postMessage(m: ToWorker) { sent.push(m); },
    terminate() { w.terminated = true; },
    say(m: FromWorker) { w.onmessage?.({ data: m } as MessageEvent<FromWorker>); },
    crash(message = '') { w.onerror?.({ message } as ErrorEvent); },
  };
  return { w, sent };
}

function setup() {
  const made: ReturnType<typeof fakeWorker>[] = [];
  const attempts: number[] = [];
  const states: Array<[ClientState, string | undefined]> = [];
  const client = createSimClient((attempt) => { attempts.push(attempt); const f = fakeWorker(attempt); made.push(f); return f.w as unknown as Worker; }, { onState: (s, e) => states.push([s, e]) });
  return { client, made, attempts, states };
}

describe('worker load retry', () => {
  it('replaces a worker that errors before any message, resends the hello, and reaches ready', () => {
    const t = setup();
    t.client.setSpeed('max');
    t.made[0]!.w.crash('');
    expect(t.attempts).toEqual([0, 1]);
    expect(t.made[0]!.w.terminated).toBe(true);
    expect(t.client.state).toBe('loading');
    expect(t.made[1]!.sent.map((m) => m.type)).toEqual(['hello', 'setSpeed']);
    t.made[1]!.w.say({ type: 'ready', protocolVersion: PROTOCOL_VERSION, hash: 0 } as FromWorker);
    expect(t.client.state).toBe('ready');
    expect(t.states.map((s) => s[0])).toEqual(['ready']);
  });

  it('fails when the retry also errors, with the worker error as the detail', () => {
    const t = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    t.made[0]!.w.crash('');
    t.made[1]!.w.crash('boom');
    expect(t.attempts).toEqual([0, 1]);
    expect(t.client.state).toBe('failed');
    expect(t.states).toEqual([['failed', 'worker error: boom']]);
  });

  it('does not retry an error that arrives after the worker has spoken', () => {
    const t = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    t.made[0]!.w.say({ type: 'ready', protocolVersion: PROTOCOL_VERSION, hash: 0 } as FromWorker);
    t.made[0]!.w.crash('late');
    expect(t.attempts).toEqual([0]);
    expect(t.client.state).toBe('failed');
  });

  it('fails when the factory throws on the retry', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const states: Array<[ClientState, string | undefined]> = [];
    let n = 0;
    const first = fakeWorker(0);
    createSimClient(() => { if (n++ === 0) return first.w as unknown as Worker; throw new Error('SecurityError'); }, { onState: (s, e) => states.push([s, e]) });
    first.w.crash('');
    expect(states).toEqual([['failed', 'worker error: SecurityError']]);
  });

  it('a plain Worker (no factory) fails at once, as before', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fakeWorker(0);
    const states: ClientState[] = [];
    createSimClient(f.w as unknown as Worker, { onState: (s) => states.push(s) });
    f.w.crash('x');
    expect(states).toEqual(['failed']);
  });
});

describe('workerUrl', () => {
  it('uses the versioned URL first and adds a cache-busting query on the retry', () => {
    expect(workerUrl(0).search).toBe('?v=dev');
    const retry = workerUrl(1);
    expect(retry.pathname.endsWith('/sim-worker.js')).toBe(true);
    expect(retry.search).toMatch(/^\?v=dev&r=\d+$/);
  });
});
