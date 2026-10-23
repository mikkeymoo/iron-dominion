import { describe, expect, it } from 'vitest';
import { AgentStore, makeSample } from './agentStore.ts';

const msg = (tick: number, agents: { slot: number; gen: number; x: number; z: number; yaw?: number; kind?: number; state?: number; carry?: number }[]) => ({
  tick, count: agents.length,
  pos: Float32Array.from(agents.flatMap((a) => [a.x, a.z, a.yaw ?? 0])),
  ids: Uint32Array.from(agents.flatMap((a) => [(a.slot | (a.gen << 16)) >>> 0, (a.kind ?? 1) | ((a.state ?? 1) << 8) | ((a.carry ?? 0) << 16)])),
});

describe('AgentStore', () => {
  it('interpolates between the last two tick snapshots', () => {
    const s = new AgentStore();
    s.ingest(msg(1, [{ slot: 3, gen: 0, x: 10, z: 10 }]), 1000);
    s.ingest(msg(2, [{ slot: 3, gen: 0, x: 11, z: 10 }]), 1100);
    const out = makeSample(8);
    s.sample(1100, out, 8);
    expect(out.pos[0]).toBeCloseTo(10, 5);
    s.sample(1150, out, 8);
    expect(out.pos[0]).toBeCloseTo(10.5, 1);
    s.sample(1300, out, 8);
    expect(out.pos[0]).toBeCloseTo(11, 5);
  });

  it('ignores repeated messages of the same tick for timing but keeps their agents', () => {
    const s = new AgentStore();
    s.ingest(msg(1, [{ slot: 1, gen: 0, x: 0, z: 0 }]), 0);
    s.ingest(msg(2, [{ slot: 1, gen: 0, x: 1, z: 0 }]), 100);
    s.ingest(msg(2, [{ slot: 1, gen: 0, x: 1, z: 0 }, { slot: 2, gen: 0, x: 5, z: 5 }]), 116);
    const out = makeSample(8);
    s.sample(116, out, 8);
    expect(out.count).toBe(2);
    expect(out.pos[0]).toBeGreaterThan(0.1);
    expect(out.pos[0]).toBeLessThan(0.3);
  });

  it('never slides a reused slot: a new generation snaps to its own position', () => {
    const s = new AgentStore();
    s.ingest(msg(1, [{ slot: 7, gen: 0, x: 10, z: 10 }]), 0);
    s.ingest(msg(2, [{ slot: 7, gen: 1, x: 12, z: 10 }]), 100);
    const out = makeSample(4);
    s.sample(100, out, 4);
    expect(out.pos[0]).toBe(12);
    expect(out.key[0]).toBe((7 | (1 << 16)) >>> 0);
  });

  it('snaps on a teleport and turns by the short way round', () => {
    const s = new AgentStore();
    s.ingest(msg(1, [{ slot: 1, gen: 0, x: 10, z: 10, yaw: 3 }, { slot: 2, gen: 0, x: 10, z: 10 }]), 0);
    s.ingest(msg(2, [{ slot: 1, gen: 0, x: 10, z: 10, yaw: -3 }, { slot: 2, gen: 0, x: 40, z: 10 }]), 100);
    const out = makeSample(4);
    s.sample(150, out, 4);
    expect(out.pos[3]).toBe(40);
    expect(Math.abs(Math.abs(out.pos[2]!) - Math.PI)).toBeLessThan(0.2);
  });

  it('unpacks kind, state and the carrying flag', () => {
    const s = new AgentStore();
    s.ingest(msg(1, [{ slot: 0, gen: 0, x: 1, z: 1, kind: 2, state: 5, carry: 1 }]), 0);
    const out = makeSample(2);
    s.sample(0, out, 2);
    expect([out.kind[0], out.state[0], out.carry[0]]).toEqual([2, 5, 1]);
    expect(s.counts()).toEqual({ builders: 0, haulers: 1 });
  });

  it('keeps the nearest agents when over the cap', () => {
    const s = new AgentStore();
    s.ingest(msg(1, [0, 1, 2, 3, 4].map((i) => ({ slot: i, gen: 0, x: 100 + i * 10, z: 100 }))), 0);
    const out = makeSample(2);
    s.sample(0, out, 2, 130, 100);
    expect(out.count).toBe(2);
    expect(new Set([out.pos[0], out.pos[3]])).toEqual(new Set([130, 120]));
  });

  it('poseOf follows one agent and returns null once it is gone', () => {
    const s = new AgentStore();
    const key = (4 | (2 << 16)) >>> 0;
    s.ingest(msg(1, [{ slot: 4, gen: 2, x: 3, z: 3 }]), 0);
    expect(s.poseOf(key, 0)).toMatchObject({ x: 3, z: 3 });
    s.ingest(msg(2, []), 100);
    expect(s.poseOf(key, 100)).toBeNull();
  });
});
