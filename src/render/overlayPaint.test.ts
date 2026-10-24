import { describe, expect, it } from 'vitest';
import { MAP, TERRAIN } from '../sim/layers.ts';
import { allocWorld } from '../sim/world.ts';
import { overlayChecksum, overlayLayersOf, paintAll, paintChunk, paintTile } from './overlayPaint.ts';
import { OVERLAY_MODES, ViewState, isOverlayMode, type OverlayMode } from './viewState.ts';

const at = (x: number, y: number): number => y * MAP + x;

/** Grass with a lake, a lit building, a dark building, a power line, a pipe, some pollution and a land value gradient. */
function city() {
  const w = allocWorld();
  w.terrain.fill(TERRAIN.GRASS);
  for (let y = 10; y < 14; y++) for (let x = 10; x < 14; x++) { w.terrain[at(x, y)] = TERRAIN.WATER; w.waterDepth[at(x, y)] = 16; }
  for (let i = 0; i < MAP * MAP; i++) w.landValue[i] = i % 256;
  w.bArch[0] = 2; w.bArch[1] = 16;
  w.bId[at(30, 30)] = 1; w.bId[at(32, 30)] = 2;
  // The solve writes 3 on the footprint of a building it did not serve; the painter reads nothing else for state.
  w.powerOn[at(30, 30)] = 1; w.powerOn[at(32, 30)] = 3; w.powerOn[at(31, 30)] = 1;
  w.waterOn[at(32, 30)] = 3;
  w.ugPower[at(31, 30)] = 1;
  w.waterOn[at(30, 30)] = 1; w.waterOn[at(40, 40)] = 1; w.waterOn[at(41, 40)] = 2;
  w.ugWater[at(42, 40)] = 1; w.waterOn[at(42, 40)] = 1;
  w.traffic[at(70, 70)] = 255; w.traffic[at(71, 70)] = 40; w.traffic[at(11, 12)] = 200;
  w.pollution[at(50, 50)] = 200; w.pollution[at(51, 50)] = 20; w.pollution[at(11, 11)] = 255;
  w.covFire[at(70, 70)] = 255; w.covFire[at(71, 70)] = 60; w.covPolice[at(72, 70)] = 255; w.covHealth[at(73, 70)] = 255; w.covEdu[at(74, 70)] = 255;
  w.covPark[at(75, 70)] = 255; w.crime[at(76, 70)] = 255; w.crime[at(77, 70)] = 40; w.covFire[at(11, 11)] = 255;
  return w;
}

const px = (out: Uint8Array, x: number, y: number): number[] => Array.from(out.subarray(at(x, y) * 4, at(x, y) * 4 + 4));

describe('overlay painter', () => {
  const w = city();
  const L = overlayLayersOf(w as unknown as Record<string, ArrayLike<number>>);
  const paint = (mode: OverlayMode): Uint8Array => { const out = new Uint8Array(MAP * MAP * 4); paintAll(mode, L, out); return out; };

  it('paints nothing for none', () => {
    expect(paint('none').every((v) => v === 0)).toBe(true);
  });

  it('power: a served building is yellow, an unpowered one red, a line bright, bare ground clear', () => {
    const out = paint('power');
    const served = px(out, 30, 30), dark = px(out, 32, 30), line = px(out, 31, 30), bare = px(out, 60, 60);
    expect(served[0]).toBe(255); expect(served[1]).toBeGreaterThan(190); expect(served[3]).toBeGreaterThan(100);
    expect(dark[0]).toBeGreaterThan(200); expect(dark[1]).toBeLessThan(80);
    expect(line[3]).toBeGreaterThan(served[3]!);
    expect(bare).toEqual([0, 0, 0, 0]);
  });

  it('water: coverage is blue, a short network orange, pipes bright, an unwatered building red, a lake clear', () => {
    const out = paint('water');
    const covered = px(out, 40, 40), short = px(out, 41, 40), pipe = px(out, 42, 40), dry = px(out, 32, 30), lake = px(out, 11, 11);
    expect(covered[2]).toBeGreaterThan(covered[0]!);
    expect(short[0]).toBeGreaterThan(short[2]!);
    expect(pipe[1]).toBeGreaterThan(200);
    expect(dry[0]).toBeGreaterThan(200); expect(dry[1]).toBeLessThan(80);
    expect(lake[3]).toBe(0);
  });

  it('land value ramps from red to green and skips water; pollution fades in with the value', () => {
    const lv = paint('landValue');
    expect(px(lv, 0, 0).slice(0, 3)).toEqual([178, 34, 52]);
    expect(px(lv, 255, 5)[1]).toBeGreaterThan(px(lv, 0, 5)[1]!);
    expect(px(lv, 11, 11)[3]).toBe(0);
    const pol = paint('pollution');
    expect(px(pol, 60, 60)[3]).toBe(0);
    expect(px(pol, 51, 50)[3]).toBeGreaterThan(0);
    expect(px(pol, 50, 50)[3]).toBeGreaterThan(px(pol, 51, 50)[3]!);
    expect(px(pol, 11, 11)[3], 'pollution over water is not painted').toBe(0);
  });

  it('traffic: busy tiles run green to red, empty tiles and water are clear', () => {
    const out = paint('traffic');
    const busy = px(out, 70, 70), light = px(out, 71, 70);
    expect(busy[0]).toBeGreaterThan(busy[1]!);
    expect(light[1]).toBeGreaterThan(light[0]!);
    expect(px(out, 72, 70)[3]).toBe(0);
    expect(px(out, 11, 12)[3], 'water is not painted').toBe(0);
  });

  it('coverage modes tint by strength, mark an unserved building red, skip water; crime ramps up', () => {
    const fire = paint('fire');
    expect(px(fire, 70, 70)[3]).toBeGreaterThan(px(fire, 71, 70)[3]!);
    expect(px(fire, 71, 70)[3]).toBeGreaterThan(0);
    expect(px(fire, 90, 90)[3]).toBe(0);
    expect(px(fire, 30, 30).slice(0, 3), 'a building with no fire coverage').toEqual([210, 64, 56]);
    expect(px(fire, 11, 11)[3], 'coverage over water is not painted').toBe(0);
    expect(px(paint('police'), 72, 70)[2]).toBeGreaterThan(200);
    expect(px(paint('health'), 73, 70)[1]).toBeGreaterThan(200);
    expect(px(paint('education'), 74, 70)[0]).toBeGreaterThan(150);
    const parks = paint('parks');
    expect(px(parks, 75, 70)[1]).toBeGreaterThan(190);
    expect(px(parks, 30, 30)[3], 'parks do not flag buildings').toBe(0);
    const crime = paint('crime');
    expect(px(crime, 76, 70)[3]).toBeGreaterThan(px(crime, 77, 70)[3]!);
    expect(px(crime, 78, 70)[3]).toBe(0);
  });

  it('gives every mode a different checksum, and the same mode the same one', () => {
    const sums = OVERLAY_MODES.map((m) => overlayChecksum(paint(m)));
    expect(new Set(sums).size).toBe(OVERLAY_MODES.length);
    expect(overlayChecksum(paint('power'))).toBe(sums[1]);
  });

  it('repainting only the dirty chunk equals a full repaint', () => {
    const world = city();
    const layers = overlayLayersOf(world as unknown as Record<string, ArrayLike<number>>);
    const out = new Uint8Array(MAP * MAP * 4);
    paintAll('power', layers, out);
    const before = overlayChecksum(out);
    world.powerOn[at(32, 30)] = 1;
    // (32, 30) lies in chunk (2, 1) = 1 * 16 + 2.
    paintChunk('power', layers, 1 * 16 + 2, out);
    const full = new Uint8Array(MAP * MAP * 4);
    paintAll('power', layers, full);
    expect(overlayChecksum(out)).toBe(overlayChecksum(full));
    expect(overlayChecksum(out)).not.toBe(before);
    paintTile('landValue', layers, at(5, 5), out);
    expect(px(out, 5, 5)[3]).toBe(175);
  });
});

describe('view state', () => {
  it('bumps the version on a real change only, notifies, and derives the effective overlay', () => {
    const v = new ViewState();
    const seen: number[] = [];
    const off = v.subscribe(() => seen.push(v.version));
    v.setOverlay('none');
    expect(v.version).toBe(0);
    v.setOverlay('power');
    v.setUnderground(true);
    v.setUnderground(true);
    expect(seen).toEqual([1, 2]);
    expect(v.effectiveOverlay).toBe('water');
    v.toggleUnderground();
    expect(v.effectiveOverlay).toBe('power');
    off();
    v.setOverlay('pollution');
    expect(seen).toEqual([1, 2, 3]);
    expect(isOverlayMode('landValue')).toBe(true);
    expect(isOverlayMode('traffic')).toBe(true);
    expect(isOverlayMode('crime')).toBe(false);
  });
});
