import { ARCH, CATALOG, archetype } from '../../sim/catalog.ts';
import type { CommandBody } from '../../sim/commands.ts';
import { footprintOf, type Estimate } from '../../sim/estimate.ts';
import { DMAX } from '../../sim/layers.ts';
import { isMega } from '../../sim/megaprojects.ts';

// Tool definitions, the drag-to-command mapping, the keyboard map and ghost tints. DOM-free and three-free so each piece is unit-tested.

export type Tile = { x: number; y: number };
export type ToolId = 'bulldoze' | 'road' | 'zone' | 'service' | 'terraform' | 'line' | 'district';
export type DistrictMode = 'paint' | 'erase';
export type TerraformMode = 'raise' | 'lower' | 'level';
export type LineKind = 'power' | 'water';

export type ToolSel =
  | { tool: 'bulldoze' }
  | { tool: 'road'; cls: 1 | 2 | 3 }
  | { tool: 'zone'; zone: 1 | 2 | 3; density: 0 | 1 | 2 }
  /** Any placeable building: services and utility buildings alike. */
  | { tool: 'service'; arch: number }
  | { tool: 'terraform'; mode: TerraformMode }
  /** Drag a power line (overhead) or a water pipe (underground) along the same L-shaped path as a road. */
  | { tool: 'line'; kind: LineKind }
  /** Paint land into district `district` (1..DMAX; an id with no land yet founds a new district) or erase it from every district. */
  | { tool: 'district'; mode: DistrictMode; district: number };

export const ROAD_NAMES = ['', 'street', 'avenue', 'highway'] as const;
export const ZONE_LABELS = ['', 'Residential', 'Commercial', 'Industrial'] as const;
export const DENSITY_LABELS = ['Low', 'Medium', 'High'] as const;
export const TERRAFORM_MODES: readonly TerraformMode[] = ['raise', 'lower', 'level'];
/** Every building the player can place, in catalog order (the `service` tool selects from this list). */
export const PLACEABLE = CATALOG.filter((a) => a.placeable);
/**
 * In the Utilities group of the tool sheet: power plants, solar farms, pumps and towers (and the fusion reactor, once its tier is
 * reached), and the Battery Bank, which sits on the grid but is not a producer (so it has no `utility` flag: the directives that
 * count power plants must not count it).
 */
export const isUtilityArch = (arch: number): boolean => archetype(arch)?.utility !== undefined || arch === ARCH.BATTERY_BANK;
/** Placeable buildings that are neither utilities nor megaprojects: the Services group in the tool sheet. */
export const SERVICES = PLACEABLE.filter((a) => !isUtilityArch(a.id) && !isMega(a.id));
export const UTILITY_BUILDINGS = PLACEABLE.filter((a) => isUtilityArch(a.id));
/** Megaprojects: started from the Projects panel, which selects the `service` tool with the project's archetype. */
export const PROJECTS = PLACEABLE.filter((a) => isMega(a.id));
export const LINE_NAMES: Record<LineKind, string> = { power: 'Power line', water: 'Water pipe' };

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

/**
 * The sim command a drag from `from` to `to` issues. With `under` (the underground view is on) bulldoze digs up pipes only;
 * the flag is left off the command otherwise so a surface bulldoze keeps its old shape.
 */
export function commandFor(sel: ToolSel, from: Tile, to: Tile, rot: number, under = false): CommandBody {
  switch (sel.tool) {
    case 'road': return { type: 'placeRoad', ...roadDragPath(from, to), cls: sel.cls };
    case 'line': return { type: 'placeLine', kind: sel.kind, ...roadDragPath(from, to) };
    case 'zone': return { type: 'zone', x0: from.x, y0: from.y, x1: to.x, y1: to.y, zone: sel.zone, density: sel.density };
    case 'bulldoze': return under ? { type: 'bulldoze', x0: from.x, y0: from.y, x1: to.x, y1: to.y, under: true } : { type: 'bulldoze', x0: from.x, y0: from.y, x1: to.x, y1: to.y };
    case 'terraform': return { type: 'terraform', mode: sel.mode, x0: from.x, y0: from.y, x1: to.x, y1: to.y };
    case 'district':
      return sel.mode === 'paint'
        ? { type: 'paintDistrict', district: sel.district, x0: from.x, y0: from.y, x1: to.x, y1: to.y }
        : { type: 'eraseDistrict', x0: from.x, y0: from.y, x1: to.x, y1: to.y };
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
    case 'line': { const k = String(opts.kind ?? 'power'); return k === 'power' || k === 'water' ? { tool, kind: k } : null; }
    case 'district': {
      const mode = String(opts.mode ?? 'paint'), id = num('district') ?? 1;
      return (mode === 'paint' || mode === 'erase') && Number.isInteger(id) && id >= 1 && id <= DMAX ? { tool, mode, district: id } : null;
    }
    case 'service': {
      const named = typeof opts.name === 'string' ? PLACEABLE.find((s) => s.name === opts.name) : undefined;
      const a = named ?? PLACEABLE.find((s) => s.id === num('arch')) ?? PLACEABLE.find((s) => s.id === ARCH.DEPOT);
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
 * R/C/I, Shift+Z cycles density), T terraform (cycles raise/lower/level), L power line, P water pipe, Ctrl/Cmd+Z undo, Escape cancel.
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
    case 'l': return { kind: 'select', sel: { tool: 'line', kind: 'power' } };
    case 'p': return { kind: 'select', sel: { tool: 'line', kind: 'water' } };
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
