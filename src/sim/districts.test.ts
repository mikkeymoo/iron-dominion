import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARCH, rciId } from './catalog.ts';
import { execute, type Command, type CommandBody } from './commands.ts';
import {
  DEDICT, DEDICT_COUNT, DISTRICT_EDICTS, DISTRICT_MODS, DT, NAME_MAX, NAME_POOL, NEUTRAL_MODS, STYLES, STYLE_COUNT,
} from './districtTables.ts';
import {
  cleanName, districtMods, districtName, districtOfFootprint, districtStats, districtTileCounts, districtUpkeep, slotDistrictMods,
} from './districts.ts';
import { computeBudget, emissionOf, landValueAt } from './economy/index.ts';
import { growthCandidates } from './economy/lots.ts';
import { estimate, tileReadOf } from './estimate.ts';
import { createSim, restore, snapshot, stateHash } from './engine.ts';
import { hashWorld } from './hash.ts';
import { DMAX, DSTRIDE, MAP, REGISTRY, S, TERRAIN, TILES, ZONE } from './layers.ts';
import { AKIND, AST } from './robots/constants.ts';
import { materialSystem } from './robots/index.ts';
import { spawnAgent } from './robots/pool.ts';
import { startTrip, stepAgent } from './robots/move.ts';
import { roadsOf } from './roads/index.ts';
import { crimeOf } from './services/index.ts';
import { depot, flatSim, road, run, zone } from './robots/testkit.ts';
import { runTicks } from './testkit.ts';
import type { Sim } from './world.ts';

vi.setConfig({ testTimeout: 120000 });
afterEach(() => new Promise<void>((r) => { setTimeout(r, 0); }));

let nextId = 9000;
/** Run a command through the real executor; 'ok' or the rejection reason. The journal id of an undoable one is in `last.journal`. */
const last = { journal: 0 };
function tryCmd(sim: Sim, body: CommandBody): string {
  const before = sim.events.length;
  execute(sim, { ...body, id: nextId++, tick: 0 } as Command);
  const e = sim.events[before]!;
  last.journal = e.type === 'accepted' ? (e.journal ?? 0) : 0;
  return e.type === 'rejected' ? e.reason : 'ok';
}
const paint = (sim: Sim, district: number, x0: number, y0: number, x1: number, y1: number): string =>
  tryCmd(sim, { type: 'paintDistrict', district, x0, y0, x1, y1 });
const edict = (sim: Sim, district: number, e: number): void => { expect(tryCmd(sim, { type: 'setDistrictEdict', district, edict: e })).toBe('ok'); };
const at = (x: number, y: number): number => y * MAP + x;

describe('district tables', () => {
  it('has a layer per tile, a row per district, six edicts with a price and effect lines, and valid generated names', () => {
    const sim = createSim(1);
    expect(sim.world.district.length).toBe(TILES);
    expect(sim.world.districtTab.length).toBe(DMAX * DSTRIDE);
    expect(REGISTRY.find((l) => l.name === 'district')).toMatchObject({ render: true, dirty: 'geometry' });
    expect(REGISTRY.find((l) => l.name === 'districtTab')).toMatchObject({ render: false });
    expect(DEDICT_COUNT).toBe(7);
    expect(DISTRICT_EDICTS.map((e) => e.id)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(DISTRICT_MODS).toHaveLength(DEDICT_COUNT);
    for (const e of DISTRICT_EDICTS.slice(1)) { expect(e.cost).toBeGreaterThan(0); expect(e.effects.length).toBeGreaterThan(0); expect(DISTRICT_MODS[e.id]).not.toEqual(NEUTRAL_MODS); }
    expect(DISTRICT_EDICTS[0]!.cost).toBe(0);
    expect(NAME_POOL.length).toBeGreaterThanOrEqual(DMAX);
    for (const n of NAME_POOL) { expect(n.length).toBeLessThanOrEqual(NAME_MAX); expect(cleanName(n)).toBe(n); }
    expect(new Set(NAME_POOL).size).toBe(NAME_POOL.length);
    expect(NAME_POOL.slice(0, 3)).toEqual(['Rustbelt', 'Neon Quarter', 'Copperfield']);
    expect(new Set(STYLES.map((s) => s.name)).size).toBe(STYLE_COUNT);
    for (const s of STYLES) for (const c of [...s.tint, ...s.line]) expect(c).toBeGreaterThan(0);
  });

  it('keeps the six edict numbers on the cards equal to the multipliers the sim reads', () => {
    expect(DISTRICT_MODS[DEDICT.QUIET_ZONE]!.pollutionQ).toBe(128);
    expect(DISTRICT_MODS[DEDICT.QUIET_ZONE]!.income[1]).toBeCloseTo(0.85, 6);
    expect(DISTRICT_MODS[DEDICT.INDUSTRIAL_PARK]).toMatchObject({ industryOutput: 1.3, emission: 1.35 });
    expect(DISTRICT_MODS[DEDICT.HIGH_RISE]!.levelUpLv).toBe(30);
    expect(DISTRICT_MODS[DEDICT.GREEN_BELT]).toMatchObject({ landValue: 8, noIndustry: true });
    expect(DISTRICT_MODS[DEDICT.NIGHT_MARKET]).toMatchObject({ nightDemandC: 164, crime: 1.25 });
    expect(DISTRICT_MODS[DEDICT.ROBOT_PRIORITY]!.robotSpeed).toBeCloseTo(1.3, 6);
  });
});

describe('paintDistrict, eraseDistrict and undo', () => {
  it('founds a named district on its first tile, grows it, and the ghost estimate lists exactly the tiles the sim changes', () => {
    const sim = flatSim(3, true), w = sim.world;
    const body: CommandBody = { type: 'paintDistrict', district: 1, x0: 40, y0: 40, x1: 49, y1: 44 };
    const est = estimate(tileReadOf(w as never, w.scalars), body, w.scalars[S.treasury]);
    expect(est.reason).toBeUndefined();
    expect(est.cost).toBe(0);
    expect(est.validTiles).toHaveLength(50);
    expect(tryCmd(sim, body)).toBe('ok');
    expect(last.journal).toBeGreaterThan(0);
    for (const i of est.validTiles) expect(w.district[i]).toBe(1);
    expect(districtTileCounts(w)[1]).toBe(50);
    expect(districtName(w, 1)).toBe('Rustbelt');
    expect(w.districtTab[DT.STYLE]).toBe(0);
    expect(sim.dirty.geometry.size).toBeGreaterThan(0);
    expect(estimate(tileReadOf(w as never), body).reason).toBe('noop');
    expect(paint(sim, 2, 60, 40, 64, 44)).toBe('ok');
    expect(districtName(w, 2)).toBe('Neon Quarter');
    expect(paint(sim, 1, 50, 40, 52, 44)).toBe('ok');
    expect(districtTileCounts(w)[1]).toBe(65);
    expect(districtName(w, 1)).toBe('Rustbelt');
  });

  it('rejects water, bad ids, ragged rects and oversize drags, with the estimate saying the same', () => {
    const sim = flatSim(3, true), w = sim.world;
    for (let x = 30; x < 34; x++) w.terrain[at(x, 30)] = TERRAIN.WATER;
    const e = estimate(tileReadOf(w as never), { type: 'paintDistrict', district: 1, x0: 28, y0: 30, x1: 37, y1: 30 });
    expect(e.validTiles).toHaveLength(6);
    expect(e.invalidTiles).toHaveLength(4);
    expect(paint(sim, 1, 30, 30, 33, 30)).toBe('terrain');
    expect(paint(sim, 0, 1, 1, 2, 2)).toBe('invalid');
    expect(paint(sim, DMAX + 1, 1, 1, 2, 2)).toBe('invalid');
    expect(paint(sim, 1.5, 1, 1, 2, 2)).toBe('invalid');
    expect(paint(sim, 1, -1, 1, 2, 2)).toBe('bounds');
    expect(paint(sim, 1, 0, 0, 100, 100)).toBe('too-large');
    expect(tryCmd(sim, { type: 'eraseDistrict', x0: 1, y0: 1, x1: 3, y1: 3 })).toBe('noop');
    expect(w.district.every((d) => d === 0)).toBe(true);
  });

  it('erases tiles from any district, and a district with no tiles left is gone', () => {
    const sim = flatSim(3, true), w = sim.world;
    paint(sim, 1, 40, 40, 49, 49);
    paint(sim, 2, 50, 40, 59, 49);
    expect(districtStats(w).map((d) => d.id)).toEqual([1, 2]);
    expect(tryCmd(sim, { type: 'eraseDistrict', x0: 45, y0: 40, x1: 54, y1: 49 })).toBe('ok');
    expect(districtTileCounts(w)[1]).toBe(50);
    expect(districtTileCounts(w)[2]).toBe(50);
    expect(tryCmd(sim, { type: 'eraseDistrict', x0: 50, y0: 40, x1: 59, y1: 49 })).toBe('ok');
    expect(districtStats(w).map((d) => d.id)).toEqual([1]);
    expect(tryCmd(sim, { type: 'renameDistrict', district: 2, name: 'Gone' })).toBe('no-district');
  });

  it('undoes a paint and an erase through the journal, restoring the previous owners tile by tile', () => {
    const sim = flatSim(3, true), w = sim.world;
    paint(sim, 1, 40, 40, 49, 49);
    const before = w.district.slice();
    expect(paint(sim, 2, 45, 45, 54, 54)).toBe('ok');
    const painted = last.journal;
    expect(w.district[at(46, 46)]).toBe(2);
    expect(tryCmd(sim, { type: 'eraseDistrict', x0: 40, y0: 40, x1: 49, y1: 49 })).toBe('ok');
    const erased = last.journal;
    expect(w.district[at(41, 41)]).toBe(0);
    expect(tryCmd(sim, { type: 'undo', target: erased })).toBe('ok');
    expect(w.district[at(41, 41)]).toBe(1);
    expect(w.district[at(46, 46)]).toBe(2);
    expect(tryCmd(sim, { type: 'undo', target: painted })).toBe('ok');
    expect(Array.from(w.district)).toEqual(Array.from(before));
    expect(districtName(w, 1)).toBe('Rustbelt');
    expect(tryCmd(sim, { type: 'undo', target: painted })).toBe('not-undoable');
  });

  it('refuses to undo a paint once something else repainted the tiles', () => {
    const sim = flatSim(3, true);
    paint(sim, 1, 40, 40, 44, 44);
    const first = last.journal;
    paint(sim, 2, 42, 42, 46, 46);
    expect(tryCmd(sim, { type: 'undo', target: first })).toBe('consumed');
    expect(sim.world.district[at(40, 40)]).toBe(1);
  });
});

describe('renaming, edicts and styles', () => {
  it('stores a player name as bytes, trims it, and rejects empty, long or odd text', () => {
    const sim = flatSim(3, true), w = sim.world;
    paint(sim, 3, 20, 20, 24, 24);
    expect(tryCmd(sim, { type: 'renameDistrict', district: 3, name: '  Old   Docks & Co.  ' })).toBe('ok');
    expect(districtName(w, 3)).toBe('Old Docks & Co.');
    expect(tryCmd(sim, { type: 'renameDistrict', district: 3, name: '12345678901234567890' })).toBe('ok');
    expect(districtName(w, 3)).toBe('12345678901234567890');
    for (const bad of ['', '   ', '123456789012345678901', 'Café', '<b>', 'a\nb']) expect(tryCmd(sim, { type: 'renameDistrict', district: 3, name: bad }), JSON.stringify(bad)).toBe('invalid');
    expect(districtName(w, 3)).toBe('12345678901234567890');
    expect(tryCmd(sim, { type: 'renameDistrict', district: 3, pool: 5 })).toBe('ok');
    expect(districtName(w, 3)).toBe(NAME_POOL[5]);
    expect(tryCmd(sim, { type: 'renameDistrict', district: 3, pool: NAME_POOL.length })).toBe('invalid');
    expect(tryCmd(sim, { type: 'renameDistrict', district: 3 })).toBe('invalid');
    expect(tryCmd(sim, { type: 'renameDistrict', district: 9, name: 'Nope' })).toBe('no-district');
  });

  it('keeps style and edict across a rename, validates them, and a founded district skips names already in use', () => {
    const sim = flatSim(3, true), w = sim.world;
    paint(sim, 1, 20, 20, 24, 24);
    expect(tryCmd(sim, { type: 'setDistrictStyle', district: 1, style: 4 })).toBe('ok');
    edict(sim, 1, DEDICT.GREEN_BELT);
    tryCmd(sim, { type: 'renameDistrict', district: 1, name: 'Neon Quarter' });
    expect(w.districtTab[DT.STYLE]).toBe(4);
    expect(w.districtTab[DT.EDICT]).toBe(DEDICT.GREEN_BELT);
    paint(sim, 2, 30, 20, 34, 24);
    expect(districtName(w, 2)).toBe('Rustbelt');
    paint(sim, 3, 40, 20, 44, 24);
    expect(districtName(w, 3)).toBe('Copperfield');
    expect(tryCmd(sim, { type: 'setDistrictStyle', district: 1, style: STYLE_COUNT })).toBe('invalid');
    expect(tryCmd(sim, { type: 'setDistrictEdict', district: 1, edict: DEDICT_COUNT })).toBe('invalid');
    expect(tryCmd(sim, { type: 'setDistrictEdict', district: 1, edict: -1 })).toBe('invalid');
    expect(tryCmd(sim, { type: 'setDistrictEdict', district: 0, edict: 1 })).toBe('invalid');
    expect(tryCmd(sim, { type: 'setDistrictEdict', district: 12, edict: 1 })).toBe('no-district');
  });
});

describe('district edicts are scoped to their district', () => {
  /** Land value at tiles one step inside and one step outside the district's east edge (x = 59 | 60). */
  const lvPair = (sim: Sim): [number, number] => [landValueAt(sim.world, 59, 50), landValueAt(sim.world, 60, 50)];

  it('Green Belt adds land value inside and nowhere else; Quiet Zone softens only the district\'s smog', () => {
    const sim = flatSim(5, true), w = sim.world;
    w.pollution.fill(100);
    paint(sim, 1, 50, 45, 59, 55);
    const [in0, out0] = lvPair(sim);
    expect(in0).toBe(out0);
    edict(sim, 1, DEDICT.GREEN_BELT);
    const [in1, out1] = lvPair(sim);
    expect(in1 - in0).toBe(8);
    expect(out1).toBe(out0);
    edict(sim, 1, DEDICT.QUIET_ZONE);
    const [in2, out2] = lvPair(sim);
    expect(in2 - in0).toBe(25);
    expect(out2).toBe(out0);
    edict(sim, 1, DEDICT.NONE);
    expect(lvPair(sim)).toEqual([in0, out0]);
  });

  it('Industrial Park lifts output and smog of the industry inside it, and of none beside it', () => {
    const sim = flatSim(5, true), w = sim.world;
    expect(run(sim, { type: 'debugGrow', x: 80, y: 80, archetype: rciId(3, 0, 1), progress: 1 })).toBe(true);
    expect(run(sim, { type: 'debugGrow', x: 84, y: 80, archetype: rciId(3, 0, 1), progress: 1 })).toBe(true);
    const inside = w.bId[at(80, 80)]! - 1, outside = w.bId[at(84, 80)]! - 1;
    paint(sim, 1, 78, 78, 82, 82);
    const baseline = emissionOf(w, inside);
    expect(baseline).toBe(emissionOf(w, outside));
    edict(sim, 1, DEDICT.INDUSTRIAL_PARK);
    expect(emissionOf(w, inside)).toBe(Math.floor(baseline * 1.35));
    expect(emissionOf(w, outside)).toBe(baseline);
    const produced = (slot: number): number => {
      let sum = 0;
      for (let n = 1; n <= 80; n++) { w.bStock[slot] = 0; w.scalars[S.tick] = n * 40; materialSystem(sim); sum += w.bStock[slot]!; }
      return sum;
    };
    const a = produced(inside), b = produced(outside);
    expect(a / b).toBeGreaterThan(1.3 * 0.9);
    expect(a / b).toBeLessThan(1.3 * 1.1);
    expect(slotDistrictMods(w, inside).industryOutput).toBe(1.3);
    expect(slotDistrictMods(w, outside)).toBe(NEUTRAL_MODS);
  });

  it('Night Market raises crime in its district only', () => {
    const sim = flatSim(5, true), w = sim.world;
    expect(run(sim, { type: 'debugGrow', x: 80, y: 80, archetype: rciId(2, 1, 2), progress: 1 })).toBe(true);
    expect(run(sim, { type: 'debugGrow', x: 90, y: 80, archetype: rciId(2, 1, 2), progress: 1 })).toBe(true);
    const a = w.bId[at(80, 80)]! - 1, b = w.bId[at(90, 80)]! - 1;
    w.landValue.fill(0);
    paint(sim, 1, 78, 78, 83, 83);
    const base = crimeOf(w, a);
    expect(base).toBeGreaterThan(40);
    edict(sim, 1, DEDICT.NIGHT_MARKET);
    expect(crimeOf(w, a)).toBe(Math.floor(base * 1.25));
    expect(crimeOf(w, b)).toBe(base);
  });

  it('Quiet Zone cuts commercial income of shops inside it by 15%; residential and industrial income do not move', () => {
    const sim = flatSim(11, true), w = sim.world;
    const grow = (x: number, y: number, z: number, d: number, l: number): void => { expect(run(sim, { type: 'debugGrow', x, y, archetype: rciId(z, d, l), progress: 1 })).toBe(true); };
    for (let i = 0; i < 3; i++) { grow(60 + i * 4, 60, 1, 2, 3); grow(60 + i * 4, 70, 2, 2, 3); grow(60 + i * 4, 80, 3, 1, 2); }
    w.landValue.fill(120);
    const off = computeBudget(w, 0);
    expect(off.incomeC).toBeGreaterThan(300);
    paint(sim, 1, 60, 70, 62, 72);
    edict(sim, 1, DEDICT.QUIET_ZONE);
    const one = computeBudget(w, 0);
    expect(one.incomeR).toBe(off.incomeR);
    expect(one.incomeI).toBe(off.incomeI);
    expect(Math.abs((off.incomeC - one.incomeC) - 0.15 * off.incomeC / 3)).toBeLessThanOrEqual(3);
    paint(sim, 1, 60, 70, 70, 72);
    const all = computeBudget(w, 0);
    expect(Math.abs(all.incomeC - 0.85 * off.incomeC)).toBeLessThanOrEqual(3);
  });

  it('Green Belt stops new industry inside the district and leaves the lots beside it growing', () => {
    const sim = flatSim(7, true);
    road(sim, 96, 104, 130, 104);
    depot(sim, 98, 102);
    zone(sim, 100, 105, 119, 108, ZONE.I, 0);
    const xs = (): number[] => growthCandidates(sim, ZONE.I, 200).map((l) => l.x);
    expect(xs().some((x) => x < 110)).toBe(true);
    paint(sim, 1, 100, 105, 109, 108);
    expect(xs().some((x) => x < 110)).toBe(true);
    edict(sim, 1, DEDICT.GREEN_BELT);
    const after = xs();
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((x) => x >= 110)).toBe(true);
    edict(sim, 1, DEDICT.HIGH_RISE);
    expect(xs().some((x) => x < 110)).toBe(true);
  });

  it('High-Rise Permit and Night Market answer through the accessor only where the tile is painted', () => {
    const sim = flatSim(5, true), w = sim.world;
    paint(sim, 1, 50, 50, 59, 59);
    edict(sim, 1, DEDICT.HIGH_RISE);
    expect(districtMods(w, at(59, 59)).levelUpLv).toBe(30);
    expect(districtMods(w, at(60, 59)).levelUpLv).toBe(0);
    expect(districtMods(w, at(49, 50))).toBe(NEUTRAL_MODS);
    edict(sim, 1, DEDICT.NIGHT_MARKET);
    expect(districtMods(w, at(55, 55)).nightDemandC).toBe(164);
    expect(districtMods(w, at(55, 60)).nightDemandC).toBe(0);
    expect(districtOfFootprint(w.district, 56, 56, 2, 2)).toBe(1);
    expect(districtOfFootprint(w.district, 60, 56, 2, 2)).toBe(0);
  });

  it('Robot Priority speeds a hauler up only on the painted stretch of road', () => {
    const sim = flatSim(7, true), w = sim.world;
    road(sim, 20, 120, 220, 120);
    paint(sim, 1, 20, 119, 119, 121);
    edict(sim, 1, DEDICT.ROBOT_PRIORITY);
    const net = roadsOf(sim);
    const a = spawnAgent(w, AKIND.HAULER, 0, 20.5, 120.5);
    w.aState[a] = AST.HAUL;
    expect(startTrip(net, w, a, 120 * MAP + 20, 120 * MAP + 220)).toBe(true);
    let inD = 0, inN = 0, outD = 0, outN = 0;
    for (let t = 0; t < 4000 && w.aX[a]! < 215; t++) {
      w.scalars[S.tick]!++;
      const x0 = w.aX[a]!;
      stepAgent(net, w, a);
      const dx = w.aX[a]! - x0;
      if (x0 < 118) { inD += dx; inN++; } else if (x0 > 122) { outD += dx; outN++; }
    }
    expect(inN).toBeGreaterThan(100);
    expect(outN).toBeGreaterThan(100);
    expect(inD / inN / (outD / outN)).toBeGreaterThan(1.3 * 0.95);
    expect(inD / inN / (outD / outN)).toBeLessThan(1.3 * 1.05);
  });
});

describe('district upkeep and stats', () => {
  it('books the price of each live district\'s edict as a monthly service cost, and drops it when the district is gone', () => {
    const sim = flatSim(5, true), w = sim.world;
    const base = computeBudget(w, 0).services;
    paint(sim, 1, 50, 50, 59, 59);
    paint(sim, 2, 70, 50, 79, 59);
    expect(districtUpkeep(w)).toBe(0);
    edict(sim, 1, DEDICT.HIGH_RISE);
    edict(sim, 2, DEDICT.QUIET_ZONE);
    expect(districtUpkeep(w)).toBe(200 + 120);
    expect(computeBudget(w, 0).services - base).toBe(320);
    expect(tryCmd(sim, { type: 'eraseDistrict', x0: 70, y0: 50, x1: 79, y1: 59 })).toBe('ok');
    expect(computeBudget(w, 0).services - base).toBe(200);
    expect(districtStats(w).map((d) => d.cost)).toEqual([200]);
  });

  it('reports residents, jobs, land value, centroid and bounds of each district', () => {
    const sim = flatSim(5, true), w = sim.world;
    expect(run(sim, { type: 'debugGrow', x: 60, y: 60, archetype: rciId(1, 2, 3), progress: 1 })).toBe(true);
    expect(run(sim, { type: 'debugGrow', x: 66, y: 60, archetype: rciId(2, 1, 2), progress: 1 })).toBe(true);
    expect(run(sim, { type: 'debugGrow', x: 100, y: 60, archetype: rciId(2, 1, 2), progress: 1 })).toBe(true);
    w.landValue.fill(77);
    paint(sim, 4, 58, 58, 69, 63);
    const [d] = districtStats(w);
    expect(d).toMatchObject({ id: 4, tiles: 72, x0: 58, y0: 58, x1: 69, y1: 63, landValue: 77, edict: 0, cost: 0 });
    expect(d!.cx).toBe(64);
    expect(d!.cy).toBe(61);
    expect(d!.population).toBeGreaterThan(100);
    expect(d!.jobs).toBeGreaterThan(20);
    expect(typeof d!.approval).toBe('number');
  });

  it('the cache follows district commands at once and the ticks otherwise', () => {
    const sim = flatSim(5, true);
    paint(sim, 1, 50, 50, 54, 54);
    expect(districtStats(sim.world)[0]!.name).toBe('Rustbelt');
    tryCmd(sim, { type: 'renameDistrict', district: 1, name: 'Ironhold' });
    expect(districtStats(sim.world)[0]!.name).toBe('Ironhold');
  });
});

describe('determinism and saves', () => {
  const build = (): Sim => {
    const sim = flatSim(9, true);
    road(sim, 96, 104, 130, 104);
    depot(sim, 98, 102);
    zone(sim, 100, 105, 119, 108, ZONE.R, 0);
    paint(sim, 1, 98, 100, 125, 110);
    tryCmd(sim, { type: 'renameDistrict', district: 1, name: 'Old Docks' });
    edict(sim, 1, DEDICT.GREEN_BELT);
    paint(sim, 2, 130, 100, 140, 110);
    edict(sim, 2, DEDICT.ROBOT_PRIORITY);
    return sim;
  };

  it('two runs of the same commands hash alike, and the layers are in the hash', () => {
    const a = build(), b = build();
    runTicks(a, 400); runTicks(b, 400);
    expect(stateHash(a)).toBe(stateHash(b));
    const h = hashWorld(a.world);
    a.world.district[at(100, 100)] ^= 1;
    expect(hashWorld(a.world)).not.toBe(h);
    a.world.district[at(100, 100)] ^= 1;
    a.world.districtTab[DT.STYLE] ^= 1;
    expect(hashWorld(a.world)).not.toBe(h);
  });

  it('resumes from a snapshot: 200 + restore + 200 equals 400 straight, names and edicts intact', () => {
    const straight = build();
    runTicks(straight, 400);
    const first = build();
    runTicks(first, 200);
    const resumed = restore(snapshot(first));
    expect(districtName(resumed.world, 1)).toBe('Old Docks');
    expect(resumed.world.districtTab[DT.EDICT]).toBe(DEDICT.GREEN_BELT);
    expect(districtStats(resumed.world).map((d) => d.name)).toEqual(['Old Docks', 'Rustbelt']);
    runTicks(resumed, 200);
    expect(stateHash(resumed)).toBe(stateHash(straight));
  });

  it('a city that never paints a district plays exactly as before: the layers stay zero', () => {
    const sim = createSim(1);
    runTicks(sim, 50);
    expect(sim.world.district.every((d) => d === 0)).toBe(true);
    expect(sim.world.districtTab.every((d) => d === 0)).toBe(true);
    expect(districtStats(sim.world)).toEqual([]);
    expect(districtUpkeep(sim.world)).toBe(0);
  });
});
