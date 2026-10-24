import { describe, expect, it } from 'vitest';
import { packLook } from '../sim/robots/names.ts';
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
    expect(s.counts()).toEqual({ builders: 0, haulers: 1, fighters: 0 });
  });

  it('keeps the nearest agents when over the cap', () => {
    const s = new AgentStore();
    s.ingest(msg(1, [0, 1, 2, 3, 4].map((i) => ({ slot: i, gen: 0, x: 100 + i * 10, z: 100 }))), 0);
    const out = makeSample(2);
    s.sample(0, out, 2, 130, 100);
    expect(out.count).toBe(2);
    expect(new Set([out.pos[0], out.pos[3]])).toEqual(new Set([130, 120]));
  });

  it('keeps robots and vehicles apart: a group sample, the robot counts and the active keys never mix them', () => {
    const s = new AgentStore();
    s.ingest(msg(1, [
      { slot: 1, gen: 0, x: 1, z: 1, kind: 1 }, { slot: 2, gen: 0, x: 2, z: 1, kind: 2 },
      { slot: 4100, gen: 0, x: 3, z: 1, kind: 3, state: 10 }, { slot: 4101, gen: 0, x: 4, z: 1, kind: 5, state: 11 }, { slot: 4102, gen: 0, x: 5, z: 1, kind: 4, state: 10 },
    ]), 0);
    const out = makeSample(8);
    expect(s.sample(0, out, 8, 0, 0, 'vehicles').count).toBe(3);
    expect(Array.from(out.kind.slice(0, 3))).toEqual([3, 5, 4]);
    expect(Array.from(out.state.slice(0, 3))).toEqual([10, 11, 10]);
    expect(s.sample(0, out, 8, 0, 0, 'robots').count).toBe(2);
    expect(Array.from(out.kind.slice(0, 2))).toEqual([1, 2]);
    expect(s.counts()).toEqual({ builders: 1, haulers: 1, fighters: 0 });
    expect(s.vehicleCount()).toBe(3);
    expect(s.activeKeys()).toHaveLength(2);
    expect(s.activeKeys(5)).toEqual([4101]);
  });

  it('caps each group on its own and keeps the nearest, breaking ties by arrival order', () => {
    const s = new AgentStore();
    const robots = [0, 1, 2].map((i) => ({ slot: i, gen: 0, x: 10 + i, z: 0, kind: 1 }));
    const cars = [0, 1, 2, 3, 4, 5].map((i) => ({ slot: 4096 + i, gen: 0, x: i < 3 ? 20 : 50 + i, z: 0, kind: 3, state: 10 }));
    s.ingest(msg(1, [...robots, ...cars]), 0);
    const out = makeSample(4);
    expect(s.sample(0, out, 2, 20, 0, 'vehicles').count).toBe(2);
    // Three cars tie at the focus; the first two in message order win.
    expect(Array.from(out.key.slice(0, 2))).toEqual([4096, 4097]);
    expect(s.sample(0, out, 2, 0, 0, 'robots').count).toBe(2);
    expect(s.sample(0, out, 0, 0, 0, 'vehicles').count).toBe(0);
  });

  it('does not blend two snapshots more than a few ticks apart, so a fast-forwarded vehicle never cuts a corner', () => {
    const s = new AgentStore();
    s.ingest(msg(100, [{ slot: 4100, gen: 0, x: 10, z: 10, kind: 3, state: 10 }]), 0);
    s.ingest(msg(160, [{ slot: 4100, gen: 0, x: 13, z: 12, kind: 3, state: 10 }]), 16);
    const out = makeSample(2);
    s.sample(24, out, 2);
    expect([out.pos[0], out.pos[1]]).toEqual([13, 12]);
    s.ingest(msg(161, [{ slot: 4100, gen: 0, x: 13.2, z: 12, kind: 3, state: 10 }]), 116);
    s.sample(166, out, 2);
    expect(out.pos[0]).toBeGreaterThan(13);
    expect(out.pos[0]).toBeLessThan(13.2);
  });

  it('still draws every vehicle at its latest position when each message is far more than a few ticks after the last', () => {
    const s = new AgentStore();
    const car = (slot: number, x: number) => ({ slot, gen: 0, x, z: 5, kind: 3, state: 10 });
    s.ingest(msg(100, [car(4100, 10)]), 0);
    s.ingest(msg(400, [car(4101, 30), car(4102, 31)]), 50);
    s.ingest(msg(900, [car(4103, 40)]), 100);
    const out = makeSample(4);
    for (const now of [100, 130, 400]) {
      expect(s.sample(now, out, 4, 0, 0, 'vehicles').count).toBe(1);
      expect([out.pos[0], out.pos[1]]).toEqual([40, 5]);
    }
    expect(s.vehicleCount()).toBe(1);
  });

  it('poseOf follows one agent and returns null once it is gone', () => {
    const s = new AgentStore();
    const key = (4 | (2 << 16)) >>> 0;
    s.ingest(msg(1, [{ slot: 4, gen: 2, x: 3, z: 3 }]), 0);
    expect(s.poseOf(key, 0)).toMatchObject({ x: 3, z: 3 });
    s.ingest(msg(2, []), 100);
    expect(s.poseOf(key, 100)).toBeNull();
  });

  it('hands the renderer the depot paint and the hat from the high bits of the agent word, and keeps carry apart from them', () => {
    const s = new AgentStore();
    const m = msg(1, [{ slot: 1, gen: 0, x: 1, z: 1, kind: 2, state: 5, carry: 3 }, { slot: 2, gen: 0, x: 2, z: 2 }]);
    m.ids[1] = (m.ids[1]! | packLook(4, 2)) >>> 0;
    s.ingest(m, 0);
    const out = makeSample(4);
    s.sample(0, out, 4);
    expect(Array.from(out.kind.slice(0, 2))).toEqual([2, 1]);
    expect(Array.from(out.carry.slice(0, 2))).toEqual([3, 0]);
    expect(Array.from(out.livery.slice(0, 2))).toEqual([4, 0]);
    expect(Array.from(out.hat.slice(0, 2))).toEqual([2, 0]);
  });
});
