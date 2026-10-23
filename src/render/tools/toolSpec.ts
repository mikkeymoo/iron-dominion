import { ARCH, CATALOG, archetype } from '../../sim/catalog.ts';
import type { CommandBody } from '../../sim/commands.ts';
import { footprintOf, type Estimate } from '../../sim/estimate.ts';

// Tool definitions, the drag-to-command mapping, the keyboard map and ghost tints. DOM-free and three-free so each piece is unit-tested.

export type Tile = { x: number; y: number };
export type ToolId = 'bulldoze' | 'road' | 'zone' | 'service' | 'terraform';
export type TerraformMode = 'raise' | 'lower' | 'level';

export type ToolSel =
  | { tool: 'bulldoze' }
  | { tool: 'road'; cls: 1 | 2 | 3 }
  | { tool: 'zone'; zone: 1 | 2 | 3; density: 0 | 1 | 2 }
  | { tool: 'service'; arch: number }
  | { tool: 'terraform'; mode: TerraformMode };

export const ROAD_NAMES = ['', 'street', 'avenue', 'highway'] as const;
export const ZONE_LABELS = ['', 'Residential', 'Commercial', 'Industrial'] as const;
export const DENSITY_LABELS = ['Low', 'Medium', 'High'] as const;
export const TERRAFORM_MODES: readonly TerraformMode[] = ['raise', 'lower', 'level'];
/** Services the player can place: every placeable catalog entry, in catalog order. */
export const SERVICES = CATALOG.filter((a) => a.placeable);

/** A drag within this many tiles of a straight line snaps to the line. */
export const AXIS_SNAP = 2;

/**
 * Road drag from `a` to `b` as the sim's placeRoad endpoints. The sim path runs along x first, so a drag that is wider than
 * tall maps straight through (corner at b.x, a.y) and a taller one swaps the endpoints (corner at a.x, b.y); either way the
 * L starts along the longer leg from where the player pressed.
 */
export function roadDragPath(a: Tile, b: Tile, snap = AXIS_SNAP): { ax: number; ay: number; bx: number; by: number } {
  const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
  if (Math.min(dx, dy) <= snap) {
    return dx >= dy ? { ax: a.x, ay: a.y, bx: b.x, by: a.y } : { ax: a.x, ay: a.y, bx: a.x, by: b.y };
  }
  return dx >= dy ? { ax: a.x, ay: a.y, bx: b.x, by: b.y } : { ax: b.x, ay: b.y, bx: a.x, by: a.y };
}

/** Top-left of a building footprint that has `tile` at its centre (the lower-left tile of an even edge). */
export function buildingAnchor(arch: number, rot: number, tile: Tile): Tile {
  const a = archetype(arch);
  if (!a) return tile;
  const { w, h } = footprintOf(a, rot);
  return { x: tile.x - ((w - 1) >> 1), y: tile.y - ((h - 1) >> 1) };
}

/** The sim command a drag from `from` to `to` issues. */
export function commandFor(sel: ToolSel, from: Tile, to: Tile, rot: number): CommandBody {
  switch (sel.tool) {
    case 'road': return { type: 'placeRoad', ...roadDragPath(from, to), cls: sel.cls };
    case 'zone': return { type: 'zone', x0: from.x, y0: from.y, x1: to.x, y1: to.y, zone: sel.zone, density: sel.density };
    case 'bulldoze': return { type: 'bulldoze', x0: from.x, y0: from.y, x1: to.x, y1: to.y };
    case 'terraform': return { type: 'terraform', mode: sel.mode, x0: from.x, y0: from.y, x1: to.x, y1: to.y };
    case 'service': {
      const at = buildingAnchor(sel.arch, rot, to);
      return { type: 'placeBuilding', arch: sel.arch, x: at.x, y: at.y, rot };
    }
  }
}

/** Selection from the `__iron.tools.select(name, opts)` form: `service` takes `name` (catalog name) or `arch`. */
export function selectionFrom(tool: string, opts: Record<string, unknown> = {}): ToolSel | null {
  const num = (k: string): number | undefined => (typeof opts[k] === 'number' ? (opts[k] as number) : undefined);
  switch (tool) {
    case 'bulldoze': return { tool };
    case 'road': { const c = num('cls') ?? (ROAD_NAMES as readonly string[]).indexOf(String(opts.name ?? 'street')); return c >= 1 && c <= 3 ? { tool, cls: c as 1 | 2 | 3 } : null; }
    case 'zone': {
      const zone = num('zone') ?? 1, density = num('density') ?? 0;
      return zone >= 1 && zone <= 3 && density >= 0 && density <= 2 ? { tool, zone: zone as 1 | 2 | 3, density: density as 0 | 1 | 2 } : null;
    }
    case 'terraform': { const m = String(opts.mode ?? 'raise') as TerraformMode; return TERRAFORM_MODES.includes(m) ? { tool, mode: m } : null; }
    case 'service': {
      const named = typeof opts.name === 'string' ? SERVICES.find((s) => s.name === opts.name) : undefined;
      const a = named ?? SERVICES.find((s) => s.id === num('arch')) ?? SERVICES.find((s) => s.id === ARCH.DEPOT);
      return a ? { tool, arch: a.id } : null;
    }
    default: return null;
  }
}

export type KeyAction = { kind: 'select'; sel: ToolSel } | { kind: 'rotate' } | { kind: 'undo' } | { kind: 'escape' };
export interface KeyLike { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean }

const next = <T,>(list: readonly T[], cur: T): T => list[(list.indexOf(cur) + 1) % list.length]!;

/**
 * B bulldoze, R road (rotate while placing a building, cycles street/avenue/highway while on road), Z zone (cycles
 * R/C/I, Shift+Z cycles density), T terraform (cycles raise/lower/level), Ctrl/Cmd+Z undo, Escape cancel.
 */
export function keyAction(e: KeyLike, cur: ToolSel | null): KeyAction | null {
  const k = e.key.toLowerCase();
  if (e.key === 'Escape') return { kind: 'escape' };
  if ((e.ctrlKey || e.metaKey) && !e.altKey && k === 'z' && !e.shiftKey) return { kind: 'undo' };
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  switch (k) {
    case 'b': return { kind: 'select', sel: { tool: 'bulldoze' } };
    case 'r':
      if (cur?.tool === 'service') return { kind: 'rotate' };
      return { kind: 'select', sel: { tool: 'road', cls: cur?.tool === 'road' ? (next([1, 2, 3] as const, cur.cls)) : 1 } };
    case 'z': {
      if (cur?.tool !== 'zone') return { kind: 'select', sel: { tool: 'zone', zone: 1, density: 0 } };
      return e.shiftKey
        ? { kind: 'select', sel: { tool: 'zone', zone: cur.zone, density: next([0, 1, 2] as const, cur.density) } }
        : { kind: 'select', sel: { tool: 'zone', zone: next([1, 2, 3] as const, cur.zone), density: cur.density } };
    }
    case 't': return { kind: 'select', sel: { tool: 'terraform', mode: cur?.tool === 'terraform' ? next(TERRAFORM_MODES, cur.mode) : 'raise' } };
    default: return null;
  }
}

export type Rgba = readonly [number, number, number, number];
export interface GhostTints { valid: Rgba; invalid: Rgba }

const GREEN: Rgba = [0.2, 0.85, 0.35, 0.45];
const RED: Rgba = [0.95, 0.2, 0.18, 0.55];
const RED_DIM: Rgba = [0.95, 0.2, 0.18, 0.3];
const GREY: Rgba = [0.7, 0.72, 0.75, 0.3];

/**
 * Tile colours for an estimate. A command the sim would refuse paints even its otherwise-fine tiles red; one that would do
 * nothing paints grey; otherwise good tiles are green and the tiles that get skipped or block it are red.
 */
export function ghostTints(est: Estimate): GhostTints {
  if (est.reason === 'noop') return { valid: GREY, invalid: RED };
  if (est.reason) return { valid: RED_DIM, invalid: RED };
  return { valid: GREEN, invalid: RED };
}
