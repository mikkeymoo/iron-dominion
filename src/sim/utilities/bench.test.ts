import { describe, expect, it } from 'vitest';
import { ARCH, rciId } from '../catalog.ts';
import { execute, type Command, type CommandBody } from '../commands.ts';
import { createSim } from '../engine.ts';
import { MAP, TERRAIN } from '../layers.ts';
import { solveUtilities } from './index.ts';

// Non-gating cost report plus a loose ceiling: the solve runs every 5 ticks, so at 10 ticks/s it must stay far below a frame.

describe('utilities solve cost', () => {
  it('solves a dense city quickly', () => {
    const sim = createSim(42, { debug: true });
    sim.world.terrain.fill(TERRAIN.GRASS);
    sim.world.height.fill(160);
    sim.world.waterDepth.fill(0);
    let id = 1;
    const run = (body: CommandBody): void => { execute(sim, { ...body, id: id++, tick: 0 } as Command); };
    run({ type: 'placeBuilding', arch: ARCH.POWER_PLANT, x: 10, y: 10, rot: 0 });
    run({ type: 'placeBuilding', arch: ARCH.WATER_PUMP, x: 10, y: 20, rot: 0 });
    // A grid of power lines and pipes every 6 tiles, a building in every other cell.
    for (let k = 0; k < 40; k++) {
      run({ type: 'placeLine', kind: 'power', ax: 14, ay: 12 + k * 6, bx: 250, by: 12 + k * 6 });
      run({ type: 'placeLine', kind: 'water', ax: 14, ay: 14 + k * 6, bx: 250, by: 14 + k * 6 });
    }
    for (let k = 0; k < 40; k++) run({ type: 'placeLine', kind: 'power', ax: 14 + k * 6, ay: 12, bx: 14 + k * 6, by: 250 });
    let placed = 0;
    for (let y = 13; y < 250 && placed < 4000; y += 6) for (let x = 15; x < 250 && placed < 4000; x += 3) {
      execute(sim, { type: 'debugGrow', x, y, archetype: rciId(1, 0, 1), progress: 1, id: id++, tick: 0 });
      placed++;
    }
    solveUtilities(sim);
    const t0 = performance.now();
    const N = 50;
    for (let i = 0; i < N; i++) solveUtilities(sim);
    const ms = (performance.now() - t0) / N;
    console.log(`perf: utilities solve on ${sim.world.bArch.filter((a) => a !== 0).length} buildings and ${sim.world.ugPower.reduce((n, v) => n + v, 0)} power-line tiles: ${ms.toFixed(2)} ms per solve`);
    expect(ms).toBeLessThan(80);
    expect(sim.utils!.power.demand).toBeGreaterThan(0);
    expect(MAP).toBe(256);
  });
});
