import { describe, expect, it } from 'vitest';
import { ARCH } from '../../sim/catalog.ts';
import { estimate, roadPath } from '../../sim/estimate.ts';
import { allocWorld } from '../../sim/world.ts';
import { MAP, S, TERRAIN } from '../../sim/layers.ts';
import { tileIdx } from '../../sim/tiles.ts';
import { MAX_GHOST_TILES, overlayIndices, writeTileQuad } from './ghostGeometry.ts';
import {
  buildingAnchor, commandFor, ghostTints, keyAction, PLACEABLE, PROJECTS, roadDragPath, selectionFrom, SERVICES, UTILITY_BUILDINGS, type ToolSel,
} from './toolSpec.ts';

const cells = (p: { ax: number; ay: number; bx: number; by: number }): [number, number][] => roadPath(p).map((i) => [i % MAP, (i / MAP) | 0]);

describe('road drag paths', () => {
  it('draws a straight horizontal or vertical line from the pressed tile', () => {
    expect(roadDragPath({ x: 10, y: 10 }, { x: 20, y: 10 })).toEqual({ ax: 10, ay: 10, bx: 20, by: 10 });
    expect(roadDragPath({ x: 10, y: 10 }, { x: 10, y: 3 })).toEqual({ ax: 10, ay: 10, bx: 10, by: 3 });
    expect(cells(roadDragPath({ x: 10, y: 10 }, { x: 13, y: 10 }))).toEqual([[10, 10], [11, 10], [12, 10], [13, 10]]);
  });

  it('snaps a nearly straight drag to its dominant axis', () => {
    expect(roadDragPath({ x: 10, y: 10 }, { x: 25, y: 12 })).toEqual({ ax: 10, ay: 10, bx: 25, by: 10 });
    expect(roadDragPath({ x: 10, y: 10 }, { x: 9, y: 30 })).toEqual({ ax: 10, ay: 10, bx: 10, by: 30 });
    expect(roadDragPath({ x: 10, y: 10 }, { x: 25, y: 13 }, 2)).not.toEqual({ ax: 10, ay: 10, bx: 25, by: 10 });
  });

  it('draws an L that runs the longer leg first, ending on the current tile', () => {
    const wide = roadDragPath({ x: 5, y: 5 }, { x: 15, y: 9 });
    const c = cells(wide);
    expect(c[0]).toEqual([5, 5]);
    expect(c).toContainEqual([15, 5]);
    expect(c[c.length - 1]).toEqual([15, 9]);

    const tall = roadDragPath({ x: 5, y: 5 }, { x: 9, y: 15 });
    const t = cells(tall);
    expect(t).toContainEqual([5, 15]);
    expect(t).toContainEqual([5, 5]);
    expect(t).toContainEqual([9, 15]);
    expect(new Set(t.map(([x, y]) => `${x},${y}`)).size).toBe(t.length);
  });

  it('covers the same tiles whichever way the player drags', () => {
    for (const [a, b] of [[{ x: 5, y: 5 }, { x: 15, y: 9 }], [{ x: 15, y: 9 }, { x: 5, y: 5 }], [{ x: 5, y: 5 }, { x: 9, y: 15 }]] as const) {
      const set = new Set(roadPath(roadDragPath(a, b)));
      expect(set.has(tileIdx(a.x, a.y)) && set.has(tileIdx(b.x, b.y))).toBe(true);
    }
  });
});

describe('commands from drags', () => {
  it('maps every tool to its sim command', () => {
    const a = { x: 4, y: 5 }, b = { x: 9, y: 8 };
    expect(commandFor({ tool: 'zone', zone: 2, density: 1 }, a, b, 0)).toEqual({ type: 'zone', x0: 4, y0: 5, x1: 9, y1: 8, zone: 2, density: 1 });
    expect(commandFor({ tool: 'bulldoze' }, a, b, 0)).toEqual({ type: 'bulldoze', x0: 4, y0: 5, x1: 9, y1: 8 });
    expect(commandFor({ tool: 'terraform', mode: 'level' }, a, b, 0)).toEqual({ type: 'terraform', mode: 'level', x0: 4, y0: 5, x1: 9, y1: 8 });
    expect(commandFor({ tool: 'road', cls: 2 }, a, b, 0)).toMatchObject({ type: 'placeRoad', cls: 2 });
  });

  it('centres a building on the pointer tile, using the last tile of the drag', () => {
    expect(buildingAnchor(ARCH.POWER_PLANT, 0, { x: 20, y: 20 })).toEqual({ x: 19, y: 19 });
    expect(buildingAnchor(ARCH.FIRE_STATION, 0, { x: 20, y: 20 })).toEqual({ x: 19, y: 19 });
    expect(buildingAnchor(ARCH.DEPOT, 0, { x: 20, y: 20 })).toEqual({ x: 20, y: 20 });
    expect(commandFor({ tool: 'service', arch: ARCH.DEPOT }, { x: 1, y: 1 }, { x: 30, y: 31 }, 3)).toEqual({ type: 'placeBuilding', arch: ARCH.DEPOT, x: 30, y: 31, rot: 3 });
  });

  it('builds selections from the debug form and rejects unknown ones', () => {
    expect(selectionFrom('service', { name: 'waterPump' })).toEqual({ tool: 'service', arch: ARCH.WATER_PUMP });
    expect(selectionFrom('service')).toEqual({ tool: 'service', arch: ARCH.DEPOT });
    expect(selectionFrom('road', { name: 'highway' })).toEqual({ tool: 'road', cls: 3 });
    expect(selectionFrom('zone', { zone: 3, density: 2 })).toEqual({ tool: 'zone', zone: 3, density: 2 });
    expect(selectionFrom('terraform', { mode: 'level' })).toEqual({ tool: 'terraform', mode: 'level' });
    expect(selectionFrom('zone', { zone: 9 })).toBeNull();
    expect(selectionFrom('teleport')).toBeNull();
    expect(SERVICES.map((s) => s.name)).toEqual([
      'depot', 'fireStation', 'policeStation', 'clinic', 'hospital', 'school', 'university', 'parkSmall', 'parkLarge', 'repairBay', 'roboticsLab', 'mine', 'smelter', 'factory',
      'lightningRod', 'seismicDamper', 'shieldDome',
    ]);
    // The Battery Bank sits with the utilities but is not a producer, so it has no `utility` flag (the directives count plants by it).
    expect(UTILITY_BUILDINGS.map((s) => s.name)).toEqual(['powerPlant', 'waterPump', 'solarFarm', 'waterTower', 'fusionReactor', 'batteryBank']);
    expect(PLACEABLE.map((s) => s.name)).toEqual([
      'depot', 'powerPlant', 'waterPump', 'fireStation', 'solarFarm', 'waterTower', 'fusionReactor', 'policeStation', 'clinic', 'hospital', 'school',
      'university', 'parkSmall', 'parkLarge', 'repairBay', 'fusionSpire', 'arcology', 'mechArena', 'spaceElevator', 'roboticsLab', 'mine', 'smelter', 'factory',
      'lightningRod', 'batteryBank', 'seismicDamper', 'shieldDome',
    ]);
    expect(PROJECTS.map((s) => s.name)).toEqual(['fusionSpire', 'arcology', 'mechArena', 'spaceElevator']);
    expect(selectionFrom('service', { name: 'arcology' })).toEqual({ tool: 'service', arch: ARCH.ARCOLOGY });
    expect(selectionFrom('service', { name: 'solarFarm' })).toEqual({ tool: 'service', arch: ARCH.SOLAR_FARM });
  });

  it('maps a power-line or pipe drag to placeLine along the road-style path', () => {
    expect(selectionFrom('line', { kind: 'power' })).toEqual({ tool: 'line', kind: 'power' });
    expect(selectionFrom('line', { kind: 'water' })).toEqual({ tool: 'line', kind: 'water' });
    expect(selectionFrom('line')).toEqual({ tool: 'line', kind: 'power' });
    expect(selectionFrom('line', { kind: 'steam' })).toBeNull();
    expect(commandFor({ tool: 'line', kind: 'water' }, { x: 5, y: 5 }, { x: 20, y: 6 }, 0)).toEqual({ type: 'placeLine', kind: 'water', ax: 5, ay: 5, bx: 20, by: 5 });
    expect(commandFor({ tool: 'line', kind: 'power' }, { x: 5, y: 5 }, { x: 15, y: 25 }, 0)).toEqual({ type: 'placeLine', kind: 'power', ...roadDragPath({ x: 5, y: 5 }, { x: 15, y: 25 }) });
  });

  it('bulldoze digs up pipes only while the underground view is on', () => {
    const from = { x: 1, y: 2 }, to = { x: 4, y: 6 };
    expect(commandFor({ tool: 'bulldoze' }, from, to, 0)).toEqual({ type: 'bulldoze', x0: 1, y0: 2, x1: 4, y1: 6 });
    expect(commandFor({ tool: 'bulldoze' }, from, to, 0, true)).toEqual({ type: 'bulldoze', x0: 1, y0: 2, x1: 4, y1: 6, under: true });
  });
});

describe('keyboard map', () => {
  const k = (key: string, extra: Partial<{ ctrlKey: boolean; shiftKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({ key, ...extra });

  it('selects tools with B, R, Z and T', () => {
    expect(keyAction(k('b'), null)).toEqual({ kind: 'select', sel: { tool: 'bulldoze' } });
    expect(keyAction(k('r'), null)).toEqual({ kind: 'select', sel: { tool: 'road', cls: 1 } });
    expect(keyAction(k('z'), null)).toEqual({ kind: 'select', sel: { tool: 'zone', zone: 1, density: 0 } });
    expect(keyAction(k('t'), null)).toEqual({ kind: 'select', sel: { tool: 'terraform', mode: 'raise' } });
    expect(keyAction(k('B'), null)).toEqual({ kind: 'select', sel: { tool: 'bulldoze' } });
  });

  it('selects the power line with L and the water pipe with P', () => {
    expect(keyAction(k('l'), null)).toEqual({ kind: 'select', sel: { tool: 'line', kind: 'power' } });
    expect(keyAction(k('P'), { tool: 'road', cls: 2 })).toEqual({ kind: 'select', sel: { tool: 'line', kind: 'water' } });
  });

  it('R rotates while placing a building and cycles road class on the road tool', () => {
    expect(keyAction(k('r'), { tool: 'service', arch: ARCH.DEPOT })).toEqual({ kind: 'rotate' });
    expect(keyAction(k('r'), { tool: 'road', cls: 1 })).toEqual({ kind: 'select', sel: { tool: 'road', cls: 2 } });
    expect(keyAction(k('r'), { tool: 'road', cls: 3 })).toEqual({ kind: 'select', sel: { tool: 'road', cls: 1 } });
  });

  it('Z cycles the zone type and Shift+Z the density; T cycles the terraform mode', () => {
    let sel: ToolSel | null = null;
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      const a = keyAction(k('z'), sel);
      sel = a?.kind === 'select' ? a.sel : sel;
      seen.push(sel?.tool === 'zone' ? sel.zone : -1);
    }
    expect(seen).toEqual([1, 2, 3, 1]);
    expect(keyAction(k('Z', { shiftKey: true }), { tool: 'zone', zone: 2, density: 2 })).toEqual({ kind: 'select', sel: { tool: 'zone', zone: 2, density: 0 } });
    const modes: string[] = [];
    let t: ToolSel | null = null;
    for (let i = 0; i < 4; i++) {
      const a = keyAction(k('t'), t);
      t = a?.kind === 'select' ? a.sel : t;
      modes.push(t?.tool === 'terraform' ? t.mode : '');
    }
    expect(modes).toEqual(['raise', 'lower', 'level', 'raise']);
  });

  it('maps Ctrl+Z and Cmd+Z to undo, Escape to cancel, and ignores other chords and keys', () => {
    expect(keyAction(k('z', { ctrlKey: true }), null)).toEqual({ kind: 'undo' });
    expect(keyAction(k('Z', { metaKey: true }), null)).toEqual({ kind: 'undo' });
    expect(keyAction(k('z', { ctrlKey: true, shiftKey: true }), null)).toBeNull();
    expect(keyAction(k('Escape'), { tool: 'bulldoze' })).toEqual({ kind: 'escape' });
    expect(keyAction(k('b', { ctrlKey: true }), null)).toBeNull();
    expect(keyAction(k('r', { altKey: true }), null)).toBeNull();
    expect(keyAction(k('w'), null)).toBeNull();
    expect(keyAction(k('1'), null)).toBeNull();
  });
});

describe('ghost tint selection', () => {
  const world = (() => {
    const w = allocWorld();
    w.terrain.fill(TERRAIN.GRASS);
    for (let x = 10; x < 14; x++) w.terrain[tileIdx(x, 10)] = TERRAIN.WATER;
    w.scalars[S.treasury] = 100000;
    return w;
  })();

  it('paints green for a command the sim accepts and red for the tiles that block it', () => {
    const ok = estimate(world, { type: 'zone', x0: 0, y0: 0, x1: 3, y1: 3, zone: 1, density: 0 }, 100000);
    expect(ok.reason).toBeUndefined();
    const t = ghostTints(ok);
    expect(t.valid[1]).toBeGreaterThan(t.valid[0]);
    expect(t.valid[1]).toBeGreaterThan(t.valid[2]);
    expect(t.invalid[0]).toBeGreaterThan(t.invalid[1]);
  });

  it('paints a refused command red even on its good tiles, and a no-op grey', () => {
    const blocked = estimate(world, { type: 'placeBuilding', arch: ARCH.DEPOT, x: 11, y: 9, rot: 0 }, 100000);
    expect(blocked.reason).toBe('terrain');
    expect(blocked.validTiles.length).toBeGreaterThan(0);
    expect(ghostTints(blocked).valid[0]).toBeGreaterThan(ghostTints(blocked).valid[1]);

    const broke = estimate(world, { type: 'placeBuilding', arch: ARCH.POWER_PLANT, x: 50, y: 50, rot: 0 }, 10);
    expect(broke.reason).toBe('funds');
    expect(ghostTints(broke).valid[0]).toBeGreaterThan(ghostTints(broke).valid[1]);

    const noop = estimate(world, { type: 'bulldoze', x0: 0, y0: 0, x1: 2, y1: 2 }, 100000);
    expect(noop.reason).toBe('noop');
    const g = ghostTints(noop).valid;
    expect(Math.abs(g[0] - g[1])).toBeLessThan(0.1);
    expect(Math.abs(g[1] - g[2])).toBeLessThan(0.1);
  });
});

describe('overlay buffers', () => {
  it('writes four corners hugging the height field, lifted slightly, with the tile colour', () => {
    const heights = new Int16Array(MAP * MAP).fill(32);
    const pos = new Float32Array(MAX_GHOST_TILES * 12), col = new Float32Array(MAX_GHOST_TILES * 16);
    writeTileQuad(pos, col, 3, 10, 20, heights, [0.1, 0.2, 0.3, 0.4]);
    const v = 3 * 12;
    expect([...pos.slice(v, v + 12)].map((n) => Math.round(n * 100) / 100)).toEqual([10, 2.07, 20, 11, 2.07, 20, 10, 2.07, 21, 11, 2.07, 21]);
    expect(Array.from(col.slice(3 * 16, 3 * 16 + 4)).map((n) => Math.round(n * 10) / 10)).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it('indexes every quad as two triangles over its own four vertices', () => {
    const idx = overlayIndices();
    expect(idx.length).toBe(MAX_GHOST_TILES * 6);
    expect([...idx.slice(6, 12)]).toEqual([4, 6, 7, 4, 7, 5]);
    expect(Math.max(...idx)).toBe(MAX_GHOST_TILES * 4 - 1);
  });
});
