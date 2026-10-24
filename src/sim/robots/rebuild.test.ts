import { afterEach, describe, expect, it, vi } from 'vitest';
import { BFLAG, rciId } from '../catalog.ts';
import { step } from '../engine.ts';
import { BMAX, MAP, S } from '../layers.ts';
import { JOB, canLevelUp, startLevelUp } from './index.ts';
import { depot, flatSim, road, run, zone } from './testkit.ts';

vi.setConfig({ testTimeout: 120000 });
afterEach(() => new Promise<void>((r) => { setTimeout(r, 0); }));

/** Debug city: street along y = 104 with the depot north of it and one finished R-low level-1 house at (100,105). */
function houseTown() {
  const sim = flatSim(42, true);
  road(sim, 96, 104, 130, 104);
  depot(sim, 98, 102);
  expect(run(sim, { type: 'debugGrow', x: 100, y: 105, archetype: rciId(1, 0, 1), progress: 1 })).toBe(true);
  return sim;
}

/** Hold the economy inputs the director reads: demand and land value are recomputed by the economy, so set them before each tick. */
function holdEconomy(sim: ReturnType<typeof flatSim>, demandR: number, landValue: number): void {
  sim.world.scalars[S.demandR] = demandR;
  sim.world.landValue.fill(landValue);
}

describe('level-up and demolition jobs', () => {
  it('rebuilds a finished building as the next level: scaffold around it, progress up, level 2 at the end', () => {
    const sim = houseTown();
    // A home grows only with a working shop within 20 tiles.
    expect(run(sim, { type: 'debugGrow', x: 110, y: 105, archetype: rciId(2, 0, 1), progress: 1 })).toBe(true);
    const w = sim.world;
    const slot = w.bId[105 * MAP + 100]! - 1;
    const progress: number[] = [];
    let sawKind = 0;
    for (let t = 0; t < 4000 && !(w.bLevel[slot] === 2 && (w.bFlags[slot]! & BFLAG.CONSTRUCTING) === 0); t++) {
      holdEconomy(sim, 0.9, 200);
      step(sim);
      if (w.jKind[slot] === JOB.LEVEL) sawKind = JOB.LEVEL;
      if ((w.bFlags[slot]! & BFLAG.CONSTRUCTING) !== 0) progress.push(w.bProg[slot]!);
    }
    expect(sawKind).toBe(JOB.LEVEL);
    expect(w.bArch[slot]).toBe(rciId(1, 0, 2));
    expect(w.bLevel[slot]).toBe(2);
    expect(w.bFlags[slot]! & BFLAG.CONSTRUCTING).toBe(0);
    expect(w.bProg[slot]).toBe(255);
    expect(progress.length).toBeGreaterThan(20);
    expect(progress[0]).toBeLessThan(10);
    for (let k = 1; k < progress.length; k++) expect(progress[k]!).toBeGreaterThanOrEqual(progress[k - 1]!);
  });

  it('claims the zoned tiles a larger footprint needs, and only those', () => {
    const sim = houseTown();
    const w = sim.world;
    const slot = w.bId[105 * MAP + 100]! - 1;
    // Level 2 keeps the 1x1 footprint; level 3 of a low-density lot is 2x2 and needs the three neighbours zoned R low.
    zone(sim, 101, 105, 101, 106, 1, 0);
    zone(sim, 100, 106, 100, 106, 1, 0);
    w.bArch[slot] = rciId(1, 0, 2); w.bLevel[slot] = 2;
    expect(w.bW[slot]).toBe(1);
    // Started by hand: left to the director, new houses would be built on the zoned neighbours before the level-up could claim them.
    expect(canLevelUp(sim, slot, rciId(1, 0, 3))).toBe(true);
    expect(startLevelUp(sim, slot, rciId(1, 0, 3), 104 * MAP + 100)).toBe(true);
    for (let t = 0; t < 6000 && !(w.bLevel[slot] === 3 && (w.bFlags[slot]! & BFLAG.CONSTRUCTING) === 0); t++) {
      holdEconomy(sim, 0.9, 200);
      step(sim);
    }
    expect(w.bArch[slot]).toBe(rciId(1, 0, 3));
    expect([w.bW[slot], w.bH[slot]]).toEqual([2, 2]);
    for (const [x, y] of [[100, 105], [101, 105], [100, 106], [101, 106]]) expect(w.bId[y! * MAP + x!]).toBe(slot + 1);
    expect(w.bId[107 * MAP + 100]).toBe(0);
    expect(w.bId[105 * MAP + 102]).toBe(0);
  });

  it('skips a level-up whose larger footprint is blocked', () => {
    const sim = houseTown();
    const w = sim.world;
    const slot = w.bId[105 * MAP + 100]! - 1;
    w.bArch[slot] = rciId(1, 0, 2); w.bLevel[slot] = 2;
    for (let t = 0; t < 600; t++) { holdEconomy(sim, 0.9, 200); step(sim); }
    expect(w.bLevel[slot]).toBe(2);
    expect(w.jKind[slot]).toBe(0);
  });

  it('tears down an abandoned building: progress runs down to nothing and the slot is freed', () => {
    const sim = houseTown();
    const w = sim.world;
    const slot = w.bId[105 * MAP + 100]! - 1;
    w.bAband[slot] = 250;
    w.bFlags[slot] = BFLAG.ABANDONED;
    const progress: number[] = [];
    let demolishing = false;
    for (let t = 0; t < 3000 && w.bArch[slot] !== 0; t++) {
      holdEconomy(sim, -0.9, 0);
      w.bFlags[slot] = w.bArch[slot] !== 0 ? w.bFlags[slot]! | BFLAG.ABANDONED : 0;
      step(sim);
      if (w.bArch[slot] !== 0 && (w.bFlags[slot]! & BFLAG.DEMOLISHING) !== 0) { demolishing = true; progress.push(w.bProg[slot]!); }
    }
    expect(demolishing).toBe(true);
    expect(w.bArch[slot]).toBe(0);
    expect(w.bId[105 * MAP + 100]).toBe(0);
    expect(progress[0]).toBeGreaterThan(200);
    for (let k = 1; k < progress.length; k++) expect(progress[k]!).toBeLessThanOrEqual(progress[k - 1]!);
    let free = 0;
    for (let s = 0; s < BMAX; s++) if (w.jKind[s] !== 0) free++;
    expect(free).toBe(0);
  });
});
