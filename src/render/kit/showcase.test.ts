import { describe, expect, it } from 'vitest';
import { execute } from '../../sim/commands.ts';
import { createSim } from '../../sim/engine.ts';
import { BFLAG } from '../../sim/catalog.ts';
import { isRci } from '../../sim/catalog.ts';
import { planShowcase } from './showcase.ts';
import type { Command } from '../../sim/commands.ts';

describe('showcase plan', () => {
  it('fills a district on seed 42 with every RCI archetype and runs cleanly on a debug sim', () => {
    const sim = createSim(42, { debug: true });
    const w = sim.world;
    const plan = planShowcase({ terrain: w.terrain, height: w.height, waterDepth: w.waterDepth });
    expect(plan).not.toBeNull();
    const rejected: string[] = [];
    plan!.commands.forEach((body, i) => {
      const ok = execute(sim, { ...body, id: i + 1, tick: 0 } as Command);
      if (!ok) rejected.push(`${i}:${body.type}:${(sim.events[sim.events.length - 1] as { reason?: string }).reason}`);
    });
    expect(rejected).toEqual([]);
    const archs = new Set<number>();
    let constructing = 0, complete = 0;
    for (let s = 0; s < w.bArch.length; s++) {
      if (!w.bArch[s]) continue;
      if (isRci(w.bArch[s]!)) archs.add(w.bArch[s]!);
      if (w.bFlags[s]! & BFLAG.CONSTRUCTING) constructing++; else complete++;
    }
    expect(archs.size).toBe(27);
    expect(constructing).toBeGreaterThan(20);
    expect(complete).toBeGreaterThan(20);
    expect(w.bArch.filter((a) => a !== 0).length).toBe(plan!.buildings);
  });
});
