import { describe, expect, it } from 'vitest';
import { ARCH } from './catalog.ts';
import type { Command } from './commands.ts';
import { apply, createSim, drainCommands, stateHash, step, tickOf } from './engine.ts';
import { findLandWindow, runTicks } from './testkit.ts';

describe('applying commands while paused', () => {
  const cmds = (x: number, y: number): Command[] => [
    { id: 1, tick: 0, type: 'placeRoad', ax: x, ay: y, bx: x + 6, by: y, cls: 1 },
    { id: 2, tick: 0, type: 'placeBuilding', arch: ARCH.DEPOT, x, y: y + 2, rot: 1 },
    { id: 3, tick: 0, type: 'zone', x0: x, y0: y + 5, x1: x + 3, y1: y + 7, zone: 1, density: 0 },
  ];

  it('runs the command now without advancing the tick, and emits its event', () => {
    const sim = createSim(42);
    runTicks(sim, 5);
    const { x, y } = findLandWindow(sim.world, 16);
    for (const c of cmds(x, y)) apply(sim, c);
    drainCommands(sim);
    expect(tickOf(sim)).toBe(5);
    expect(sim.events.filter((e) => e.type === 'accepted')).toHaveLength(3);
    expect(sim.queue).toHaveLength(0);
  });

  it('gives the same hash as applying the same commands and stepping', () => {
    const a = createSim(42), b = createSim(42);
    runTicks(a, 5); runTicks(b, 5);
    const { x, y } = findLandWindow(a.world, 16);
    for (const c of cmds(x, y)) { apply(a, c); apply(b, c); }
    step(a);
    drainCommands(b);
    step(b);
    expect(stateHash(b)).toBe(stateHash(a));
    runTicks(a, 50); runTicks(b, 50);
    expect(stateHash(b)).toBe(stateHash(a));
  });

  it('leaves commands stamped for a later tick queued', () => {
    const sim = createSim(42);
    const { x, y } = findLandWindow(sim.world, 16);
    apply(sim, { id: 1, tick: 9, type: 'zone', x0: x, y0: y, x1: x + 1, y1: y + 1, zone: 1, density: 0 });
    drainCommands(sim);
    expect(sim.queue).toHaveLength(1);
    expect(sim.events).toHaveLength(0);
  });
});
