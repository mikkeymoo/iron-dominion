import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARCH, rciId } from '../sim/catalog.ts';
import type { CommandBody } from '../sim/commands.ts';
import { S, TERRAIN } from '../sim/layers.ts';
import { tileIdx } from '../sim/tiles.ts';
import { allocWorld } from '../sim/world.ts';
import type { ToolWorld } from '../render/tools/controller.ts';
import { NO_DEPOT_HINT, reasonText, ToolsRuntime } from './toolsStore.ts';

afterEach(() => vi.useRealTimers());

function setup() {
  const w = allocWorld();
  w.terrain.fill(TERRAIN.GRASS);
  w.height.fill(160);
  for (let x = 90; x < 100; x++) for (let y = 90; y < 100; y++) w.terrain[tileIdx(x, y)] = TERRAIN.WATER;
  w.scalars[S.treasury] = 50000;
  const world: ToolWorld = { layers: w as unknown as Record<string, ArrayLike<number>>, scalars: w.scalars, tick: 0 };
  const sent: CommandBody[] = [];
  const rt = new ToolsRuntime({ world, submit: (b) => { sent.push(b); return sent.length + 100; } });
  return { rt, sent, w };
}

describe('no-depot nudge', () => {
  it('toasts a hint when a road or zone is drawn before any depot, once per burst', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100000);
    const { rt } = setup();
    rt.controller.select({ tool: 'road', cls: 1 });
    rt.controller.dragTiles({ x: 20, y: 20 }, { x: 28, y: 20 });
    expect(rt.toasts.map((t) => [t.text, t.tone])).toEqual([[NO_DEPOT_HINT, 'hint']]);
    expect(NO_DEPOT_HINT).toBe('Robots build your city. Place a Robot Depot first.');
    rt.controller.dragTiles({ x: 20, y: 22 }, { x: 28, y: 22 });
    expect(rt.toasts).toHaveLength(1);
    vi.advanceTimersByTime(21000);
    rt.controller.select({ tool: 'zone', zone: 1, density: 0 });
    rt.controller.dragTiles({ x: 20, y: 24 }, { x: 24, y: 26 });
    expect(rt.toasts.filter((t) => t.tone === 'hint')).toHaveLength(1);
  });

  it('stays quiet once a depot stands, and for tools that need none', () => {
    vi.useFakeTimers();
    const { rt, w } = setup();
    w.bArch[0] = ARCH.DEPOT;
    rt.controller.select({ tool: 'road', cls: 1 });
    rt.controller.dragTiles({ x: 20, y: 20 }, { x: 28, y: 20 });
    expect(rt.toasts).toEqual([]);
    w.bArch[0] = 0;
    rt.controller.select({ tool: 'service', arch: ARCH.DEPOT });
    rt.controller.dragTiles({ x: 40, y: 40 }, { x: 40, y: 40 });
    expect(rt.toasts).toEqual([]);
  });
});

describe('tools runtime events', () => {
  it('pushes the journal id on accepted, floats the cost, and keeps lastEvent', () => {
    vi.useFakeTimers();
    const { rt } = setup();
    rt.controller.select({ tool: 'service', arch: ARCH.DEPOT });
    const id = rt.controller.dragTiles({ x: 20, y: 20 }, { x: 20, y: 20 });
    expect(id).toBe(101);
    expect(rt.canUndo).toBe(false);
    rt.handleEvents([{ type: 'accepted', cmd: id, tick: 4, journal: 9 }]);
    expect(rt.canUndo).toBe(true);
    expect(rt.undo.top()).toMatchObject({ id: 9, cost: 500 });
    expect(rt.floats.map((f) => f.text)).toEqual(['-$500']);
    expect(rt.lastEvent).toMatchObject({ type: 'accepted', cmd: id });
    vi.advanceTimersByTime(2000);
    expect(rt.floats).toEqual([]);
  });

  it('does not push commands that carry no journal id, and ignores events for commands it did not send', () => {
    const { rt } = setup();
    rt.controller.select({ tool: 'terraform', mode: 'raise' });
    const id = rt.controller.dragTiles({ x: 20, y: 20 }, { x: 21, y: 21 });
    rt.handleEvents([{ type: 'accepted', cmd: id, tick: 4 }, { type: 'accepted', cmd: 999, tick: 4, journal: 3 }]);
    expect(rt.canUndo).toBe(false);
  });

  it('undoes the newest entry, pops it when accepted and floats the refund', () => {
    const { rt, sent } = setup();
    rt.controller.select({ tool: 'zone', zone: 1, density: 0 });
    const a = rt.controller.dragTiles({ x: 10, y: 10 }, { x: 12, y: 12 });
    rt.handleEvents([{ type: 'accepted', cmd: a, tick: 1, journal: 5 }]);
    const b = rt.controller.dragTiles({ x: 20, y: 10 }, { x: 22, y: 12 });
    rt.handleEvents([{ type: 'accepted', cmd: b, tick: 2, journal: 6 }]);
    expect(rt.undo.size).toBe(2);

    const u = rt.undoLast();
    expect(sent[sent.length - 1]).toEqual({ type: 'undo', target: 6 });
    expect(rt.undoLast(), 'the same entry is not undone twice while pending').not.toBe(u);
    expect(sent[sent.length - 1]).toEqual({ type: 'undo', target: 5 });
    rt.handleEvents([{ type: 'accepted', cmd: u, tick: 3 }]);
    expect(rt.undo.entries().map((e) => e.id)).toEqual([5]);
    expect(rt.floats.map((f) => f.text)).toContain('+$18');
  });

  it('disables undo after a consumed rejection and tells the player why', () => {
    const { rt } = setup();
    rt.controller.select({ tool: 'zone', zone: 1, density: 0 });
    const a = rt.controller.dragTiles({ x: 10, y: 10 }, { x: 12, y: 12 });
    rt.handleEvents([{ type: 'accepted', cmd: a, tick: 1, journal: 5 }]);
    expect(rt.canUndo).toBe(true);
    const u = rt.undoLast();
    expect(rt.canUndo, 'in flight').toBe(false);
    rt.handleEvents([{ type: 'rejected', cmd: u, tick: 2, reason: 'consumed' }]);
    expect(rt.canUndo).toBe(false);
    expect(rt.undo.size).toBe(0);
    expect(rt.toasts.filter((t) => t.tone !== 'hint').map((t) => t.text)).toEqual([reasonText('consumed')]);
    expect(rt.undoLast()).toBe(0);
  });

  it('shows a plain-words toast for a sim rejection and for a local refusal, and expires it', () => {
    vi.useFakeTimers();
    const { rt, sent } = setup();
    rt.controller.select({ tool: 'service', arch: ARCH.DEPOT });
    rt.controller.dragTiles({ x: 94, y: 94 }, { x: 94, y: 94 });
    expect(sent).toEqual([]);
    expect(rt.toasts).toHaveLength(1);
    expect(rt.toasts[0]!.text).toMatch(/water/);

    const id = rt.controller.dragTiles({ x: 30, y: 30 }, { x: 30, y: 30 });
    rt.handleEvents([{ type: 'rejected', cmd: id, tick: 3, reason: 'funds' }]);
    expect(rt.toasts.map((t) => t.text)).toContain('Not enough money for that.');
    expect(rt.lastEvent).toMatchObject({ type: 'rejected', reason: 'funds' });
    vi.advanceTimersByTime(5000);
    expect(rt.toasts).toEqual([]);
  });

  it('turns disaster events into toasts that carry a jump target and stay longer than a plain one', () => {
    vi.useFakeTimers();
    const { rt } = setup();
    const base = { type: 'disaster' as const, tick: 5, radius: 0, impactTick: 0 };
    rt.handleEvents([
      { ...base, kind: 'fire', phase: 'start', x: 40, y: 50, arch: rciId(3, 0, 1) },
      { ...base, kind: 'quake', phase: 'impact', x: 10, y: 11, radius: 14, arch: 0 },
      { ...base, kind: 'meteor', phase: 'start', x: 7, y: 8, arch: 0, impactTick: 30 },
      { ...base, kind: 'meteor', phase: 'impact', x: 7, y: 8, arch: 0, radius: 6 },
    ]);
    expect(rt.toasts.map((t) => t.text)).toEqual(['Fire at Industrial district!', 'Earthquake!', 'Meteor incoming!']);
    expect(rt.toasts.map((t) => t.jump)).toEqual([{ x: 40, y: 50 }, { x: 10, y: 11 }, { x: 7, y: 8 }]);
    vi.advanceTimersByTime(5000);
    expect(rt.toasts).toHaveLength(3);
    vi.advanceTimersByTime(8000);
    expect(rt.toasts).toEqual([]);
  });

  it('names a service building on fire, and sends the sandbox trigger with a plain refusal when nothing is near', () => {
    const { rt, sent } = setup();
    rt.handleEvents([{ type: 'disaster', tick: 1, kind: 'fire', phase: 'start', x: 1, y: 2, radius: 0, arch: ARCH.POWER_PLANT, impactTick: 0 }]);
    expect(rt.toasts[0]!.text).toBe('Fire at the power plant!');
    const id = rt.triggerDisaster('fire', 30, 31);
    expect(sent[sent.length - 1]).toEqual({ type: 'triggerDisaster', kind: 'fire', x: 30, y: 31 });
    rt.handleEvents([{ type: 'rejected', cmd: id, tick: 2, reason: 'noop' }]);
    expect(rt.toasts[rt.toasts.length - 1]!.text).toMatch(/no building to set alight/);
    const ok = rt.triggerDisaster('quake', 30, 31);
    const before = rt.toasts.length;
    rt.handleEvents([{ type: 'accepted', cmd: ok, tick: 3 }]);
    expect(rt.toasts.length).toBe(before);
    expect(rt.canUndo).toBe(false);
  });

  it('forgets the undo stack, pending commands and tool when a snapshot replaces the sim', () => {
    const { rt } = setup();
    rt.controller.select({ tool: 'zone', zone: 1, density: 0 });
    const a = rt.controller.dragTiles({ x: 10, y: 10 }, { x: 12, y: 12 });
    rt.handleEvents([{ type: 'accepted', cmd: a, tick: 1, journal: 5 }]);
    const b = rt.controller.dragTiles({ x: 20, y: 10 }, { x: 22, y: 12 });
    const u = rt.undoLast();
    expect(u).toBeGreaterThan(0);
    rt.reset();
    expect(rt.canUndo).toBe(false);
    expect(rt.undo.size).toBe(0);
    expect(rt.controller.sel).toBeNull();
    // Late events for pre-load commands change nothing.
    rt.handleEvents([{ type: 'accepted', cmd: b, tick: 2, journal: 9 }, { type: 'accepted', cmd: u, tick: 2 }]);
    expect(rt.undo.size).toBe(0);
    expect(rt.lastEvent).toBeNull();
    expect(rt.floats).toEqual([]);
  });

  it('exposes the debug API the smoke test drives', () => {
    const { rt, sent } = setup();
    const d = rt.debug;
    expect(d.select('service', { name: 'depot' })).toBe(true);
    expect(d.select('nope')).toBe(false);
    d.select('service', { name: 'depot' });
    expect(d.tileFor('depot', { x: 20, y: 20 })).toEqual({ x: 20, y: 20 });
    expect(d.tileFor('powerPlant', { x: 20, y: 20 })).toEqual({ x: 21, y: 21 });
    expect(d.dragTiles({ x: 20, y: 20 }, { x: 20, y: 20 })).toBeGreaterThan(0);
    expect(sent).toHaveLength(1);
    expect(d.treasury).toBe(50000);
    expect(d.peek('terrain', 95, 95)).toBe(TERRAIN.WATER);
    expect(d.findWater()).toBeTruthy();
    expect(d.findSite(10)).toBeTruthy();
  });
});
