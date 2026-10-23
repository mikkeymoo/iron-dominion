import { describe, expect, it } from 'vitest';
import { ARCH, BFLAG, rciId } from '../sim/catalog.ts';
import { execute, type Command, type CommandBody } from '../sim/commands.ts';
import { collectOutgoing, createSim } from '../sim/engine.ts';
import { CHUNKS, MAP, TERRAIN } from '../sim/layers.ts';
import { solveUtilities } from '../sim/utilities/index.ts';
import { chunkIdx } from '../sim/tiles.ts';
import type { Sim } from '../sim/world.ts';
import { RenderMirror } from './mirror.ts';

let id = 1;
const run = (sim: Sim, body: CommandBody): void => {
  sim.events = [];
  if (!execute(sim, { ...body, id: id++, tick: 0 } as Command)) throw new Error(`rejected: ${JSON.stringify(sim.events)}`);
};

function setup(): { sim: Sim; mirror: RenderMirror } {
  const sim = createSim(42, { debug: true });
  sim.world.terrain.fill(TERRAIN.GRASS);
  sim.world.height.fill(160);
  sim.world.waterDepth.fill(0);
  const mirror = new RenderMirror();
  for (const m of collectOutgoing(sim, { overlay: true })) mirror.apply(m);
  mirror.takeDirtyLines(); mirror.takeDirtyOverlay();
  return { sim, mirror };
}

const sync = (sim: Sim, mirror: RenderMirror): void => { for (const m of collectOutgoing(sim, { overlay: true })) mirror.apply(m); };

describe('mirror and utilities', () => {
  it('marks every chunk dirty for lines after a resync', () => {
    const sim = createSim(1);
    const mirror = new RenderMirror();
    for (const m of collectOutgoing(sim)) mirror.apply(m);
    expect(mirror.takeDirtyLines()).toHaveLength(CHUNKS * CHUNKS);
    expect(mirror.takeDirtyLines()).toEqual([]);
  });

  it('reports only the chunks whose line tiles changed, at once (no overlay throttle)', () => {
    const { sim, mirror } = setup();
    run(sim, { type: 'placeLine', kind: 'power', ax: 40, ay: 40, bx: 50, by: 40 });
    sync(sim, mirror);
    expect(mirror.layers.ugPower![40 * MAP + 45]).toBe(1);
    expect(mirror.takeDirtyLines()).toEqual([chunkIdx(40, 40), chunkIdx(48, 40)].sort((a, b) => a - b));
    run(sim, { type: 'placeLine', kind: 'water', ax: 100, ay: 100, bx: 100, by: 104 });
    sync(sim, mirror);
    expect(mirror.takeDirtyLines()).toEqual([chunkIdx(100, 100)]);
    expect(mirror.layers.ugWater![102 * MAP + 100]).toBe(1);
  });

  it('does not report a chunk whose lines are unchanged', () => {
    const { sim, mirror } = setup();
    run(sim, { type: 'placeLine', kind: 'power', ax: 40, ay: 40, bx: 44, by: 40 });
    sync(sim, mirror);
    mirror.takeDirtyLines();
    run(sim, { type: 'zone', x0: 41, y0: 50, x1: 42, y1: 51, zone: 1, density: 0 });
    run(sim, { type: 'placeRoad', ax: 36, ay: 60, bx: 44, by: 60, cls: 1 });
    sync(sim, mirror);
    expect(mirror.takeDirtyLines()).toEqual([]);
  });

  it('repaints the overlay chunk of a building whose outage flag flipped', () => {
    const { sim, mirror } = setup();
    run(sim, { type: 'placeBuilding', arch: ARCH.POWER_PLANT, x: 100, y: 100, rot: 0 });
    run(sim, { type: 'debugGrow', x: 120, y: 120, archetype: rciId(1, 0, 1), progress: 1 });
    sync(sim, mirror);
    mirror.takeDirtyOverlay();
    solveUtilities(sim);
    expect(sim.world.bFlags[sim.world.bId[120 * MAP + 120]! - 1]! & BFLAG.UNPOWERED).toBe(BFLAG.UNPOWERED);
    sync(sim, mirror);
    const flagged = mirror.table.bFlags[sim.world.bId[120 * MAP + 120]! - 1]!;
    expect(flagged & BFLAG.UNPOWERED).toBe(BFLAG.UNPOWERED);
    expect(mirror.takeDirtyOverlay()).toContain(chunkIdx(120, 120));
  });

  it('carries power and water coverage in the overlay patch', () => {
    const { sim, mirror } = setup();
    run(sim, { type: 'placeBuilding', arch: ARCH.POWER_PLANT, x: 100, y: 100, rot: 0 });
    run(sim, { type: 'placeLine', kind: 'power', ax: 104, ay: 102, bx: 110, by: 102 });
    solveUtilities(sim);
    sync(sim, mirror);
    expect(mirror.layers.powerOn![102 * MAP + 107]).toBe(1);
    expect(mirror.layers.powerOn![102 * MAP + 120]).toBe(0);
  });
});
