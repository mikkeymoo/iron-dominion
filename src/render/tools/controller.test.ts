import { describe, expect, it } from 'vitest';
import { ARCH, CATALOG } from '../../sim/catalog.ts';
import type { CommandBody } from '../../sim/commands.ts';
import { MAP, S, TERRAIN } from '../../sim/layers.ts';
import { tileIdx } from '../../sim/tiles.ts';
import { allocWorld } from '../../sim/world.ts';
import { ToolController, type ToolAction, type ToolWorld } from './controller.ts';
import { findFlatSite, findWaterTile } from './sites.ts';
import { createToolInput } from './pointer.ts';
import { tileReadOf } from '../../sim/estimate.ts';

function setup(treasury = 100000) {
  const w = allocWorld();
  w.terrain.fill(TERRAIN.GRASS);
  w.height.fill(160);
  for (let y = 60; y < 70; y++) for (let x = 60; x < 70; x++) w.terrain[tileIdx(x, y)] = TERRAIN.WATER;
  w.scalars[S.treasury] = treasury;
  const world: ToolWorld = { layers: w as unknown as Record<string, ArrayLike<number>>, scalars: w.scalars, tick: 0 };
  const sent: CommandBody[] = [];
  const actions: ToolAction[] = [];
  const c = new ToolController({ world, submit: (b) => { sent.push(b); return sent.length; } });
  c.onAction((a) => actions.push(a));
  return { c, w, world, sent, actions };
}

describe('tool controller', () => {
  it('does nothing without a tool', () => {
    const { c, sent } = setup();
    expect(c.begin({ x: 5, y: 5 })).toBe(false);
    expect(c.dragTiles({ x: 5, y: 5 }, { x: 9, y: 9 })).toBe(0);
    expect(sent).toEqual([]);
  });

  it('plans while dragging and submits the command on release', () => {
    const { c, sent, actions } = setup();
    c.select({ tool: 'zone', zone: 1, density: 0 });
    expect(c.begin({ x: 10, y: 10 })).toBe(true);
    c.move({ x: 14, y: 12 });
    expect(c.plan?.est.cost).toBe(15 * 2);
    expect(c.plan?.est.validTiles).toHaveLength(15);
    expect(sent).toEqual([]);
    expect(c.end()).toBe(1);
    expect(sent).toEqual([{ type: 'zone', x0: 10, y0: 10, x1: 14, y1: 12, zone: 1, density: 0 }]);
    expect(actions).toMatchObject([{ kind: 'submitted', id: 1, cost: 30 }]);
    expect(c.dragging).toBe(false);
  });

  it('refuses locally, with the reason, a command the estimate says the sim would reject', () => {
    const { c, sent, actions } = setup();
    c.select({ tool: 'service', arch: ARCH.DEPOT });
    expect(c.dragTiles({ x: 64, y: 64 }, { x: 64, y: 64 })).toBe(0);
    expect(sent).toEqual([]);
    expect(actions).toMatchObject([{ kind: 'refused', reason: 'terrain' }]);

    const poor = setup(10);
    poor.c.select({ tool: 'service', arch: ARCH.POWER_PLANT });
    poor.c.dragTiles({ x: 20, y: 20 }, { x: 20, y: 20 });
    expect(poor.actions).toMatchObject([{ kind: 'refused', reason: 'funds' }]);
  });

  it('escape drops a drag first and then the tool; cancel drops both', () => {
    const { c, sent } = setup();
    c.select({ tool: 'bulldoze' });
    c.begin({ x: 3, y: 3 });
    c.move({ x: 8, y: 8 });
    c.escape();
    expect(c.dragging).toBe(false);
    expect(c.sel).toEqual({ tool: 'bulldoze' });
    expect(c.end()).toBe(0);
    c.escape();
    expect(c.sel).toBeNull();
    expect(c.plan).toBeNull();
    c.select({ tool: 'zone', zone: 2, density: 1 });
    c.begin({ x: 1, y: 1 });
    c.cancel();
    expect(c.sel).toBeNull();
    expect(sent).toEqual([]);
  });

  it('rotates a building ghost in quarter turns and only for the building tool', () => {
    const { c } = setup();
    c.select({ tool: 'bulldoze' });
    c.rotate();
    expect(c.rot).toBe(0);
    c.select({ tool: 'service', arch: ARCH.DEPOT });
    c.move({ x: 20, y: 20 });
    for (let i = 1; i <= 5; i++) { c.rotate(); expect(c.rot).toBe(i & 3); }
    expect(c.plan?.cmd).toMatchObject({ type: 'placeBuilding', rot: 1 });
  });

  it('shows a hover ghost for buildings and updates it when the pointer moves', () => {
    const { c } = setup();
    c.select({ tool: 'service', arch: ARCH.FIRE_STATION });
    const v0 = c.version;
    c.move({ x: 30, y: 30 });
    expect(c.plan?.est.validTiles).toHaveLength(9);
    expect(c.version).toBeGreaterThan(v0);
    const v1 = c.version;
    c.move({ x: 30, y: 30 });
    expect(c.version).toBe(v1);
  });

  it('re-estimates when the mirror moves on', () => {
    const { c, world, w } = setup();
    c.select({ tool: 'service', arch: ARCH.DEPOT });
    c.move({ x: 30, y: 30 });
    expect(c.plan?.est.reason).toBeUndefined();
    w.road[tileIdx(30, 30)] = 1;
    c.sync();
    expect(c.plan?.est.reason).toBeUndefined();
    world.tick = 5;
    c.sync();
    expect(c.plan?.est.reason).toBe('blocked');
  });

  it('routes pixel input through the same path as dragTiles', () => {
    const { c, sent } = setup();
    const picks = new Map([['0,0', { x: 40, y: 40 }], ['9,9', { x: 44, y: 41 }]]);
    const input = createToolInput(c, (px, py) => picks.get(`${px},${py}`) ?? null);
    expect(input.active()).toBe(false);
    c.select({ tool: 'bulldoze' });
    expect(input.active()).toBe(true);
    input.begin(0, 0);
    input.move(9, 9);
    input.move(1, 1);
    input.end();
    expect(sent).toEqual([]);
    c.select({ tool: 'zone', zone: 3, density: 2 });
    input.begin(0, 0);
    input.move(9, 9);
    input.end();
    expect(sent).toEqual([{ type: 'zone', x0: 40, y0: 40, x1: 44, y1: 41, zone: 3, density: 2 }]);
    input.begin(0, 0);
    input.cancelDrag();
    expect(c.dragging).toBe(false);
  });
});

describe('site helpers', () => {
  it('finds a free flat window and a water tile', () => {
    const { w } = setup();
    const v = tileReadOf(w as unknown as Record<string, ArrayLike<number>>);
    const site = findFlatSite(v, 14, { x: 128, y: 128 })!;
    expect(site).toBeTruthy();
    for (let y = site.y; y < site.y + 14; y++) for (let x = site.x; x < site.x + 14; x++) expect(w.terrain[tileIdx(x, y)]).toBe(TERRAIN.GRASS);
    const water = findWaterTile(v)!;
    expect(w.terrain[tileIdx(water.x, water.y)]).toBe(TERRAIN.WATER);
    expect(water.x).toBeLessThan(MAP);
    expect(CATALOG.find((a) => a.id === ARCH.DEPOT)!.w).toBe(2);
  });
});
