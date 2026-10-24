import { archetype, BFLAG } from '../sim/catalog.ts';
import { ROAD } from '../sim/layers.ts';
import { tileIdx } from '../sim/tiles.ts';
import { ROAD_UNLOCK } from '../sim/unlocks.ts';
import type { RadialItem } from '../render/radial.ts';
import type { ToolController } from '../render/tools/controller.ts';
import { ROAD_NAMES, SERVICES, type Tile, type ToolSel } from '../render/tools/toolSpec.ts';
import { projectLabel } from './projects.ts';

export type RadialTarget =
  | { kind: 'land'; tile: Tile }
  | { kind: 'building'; tile: Tile; slot: number; arch: number }
  | { kind: 'road'; tile: Tile; cls: number };

export type RadialAction =
  | { kind: 'tool'; sel: ToolSel }
  | { kind: 'info' }
  | { kind: 'upgrade' }
  | { kind: 'bulldoze' }
  | { kind: 'follow' }
  | { kind: 'roadUpgrade'; cls: 1 | 2 | 3 };

export interface RadialEntry extends RadialItem { action: RadialAction }

type Layers = Record<string, ArrayLike<number>>;

/** What a press landed on: a building (including a site under construction) beats a road, which beats bare land. */
export function radialTargetAt(layers: Layers, tile: Tile): RadialTarget {
  const i = tileIdx(tile.x, tile.y);
  const id = layers.bId?.[i] ?? 0;
  if (id > 0) return { kind: 'building', tile, slot: id - 1, arch: layers.bArch?.[id - 1] ?? 0 };
  const cls = (layers.road?.[i] ?? 0) & ROAD.CLASS_MASK;
  if (cls > 0) return { kind: 'road', tile, cls };
  return { kind: 'land', tile };
}

export interface RadialContext {
  /** Population tier reached; gates the road upgrade. */
  tier: number;
  /** A building upgrade exists in the sim. None does yet, so the entry stays out of the menu until a caller says otherwise. */
  canUpgrade?: boolean;
  /** The 3D view is running, so Follow can start. */
  canFollow?: boolean;
}

const LAND: { id: string; label: string; sel: ToolSel }[] = [
  { id: 'road', label: 'Road', sel: { tool: 'road', cls: 1 } },
  { id: 'zone', label: 'Zone', sel: { tool: 'zone', zone: 1, density: 0 } },
  { id: 'service', label: 'Services', sel: { tool: 'service', arch: SERVICES[0]!.id } },
  { id: 'utilities', label: 'Utilities', sel: { tool: 'line', kind: 'power' } },
  { id: 'terraform', label: 'Terraform', sel: { tool: 'terraform', mode: 'raise' } },
];

/** The menu for a target: land offers the build tools, a building its actions, a road bulldoze and (once unlocked) a class upgrade. */
export function radialItemsFor(target: RadialTarget, ctx: RadialContext): RadialEntry[] {
  if (target.kind === 'land') return LAND.map((l) => ({ id: l.id, label: l.label, action: { kind: 'tool', sel: l.sel } }));
  if (target.kind === 'building') {
    const out: RadialEntry[] = [{ id: 'info', label: 'Info', action: { kind: 'info' } }];
    if (ctx.canUpgrade) out.push({ id: 'upgrade', label: 'Upgrade', action: { kind: 'upgrade' } });
    out.push({ id: 'bulldoze', label: 'Bulldoze', action: { kind: 'bulldoze' } });
    if (ctx.canFollow ?? true) out.push({ id: 'follow', label: 'Follow', action: { kind: 'follow' } });
    return out;
  }
  const out: RadialEntry[] = [{ id: 'bulldoze', label: 'Bulldoze', action: { kind: 'bulldoze' } }];
  const next = target.cls + 1;
  if (next <= 3 && ctx.tier >= (ROAD_UNLOCK[next] ?? Infinity)) out.push({ id: 'upgrade-road', label: `To ${ROAD_NAMES[next]}`, action: { kind: 'roadUpgrade', cls: next as 2 | 3 } });
  return out;
}

/** Clears one tile (a building's tile takes the whole building) through the controller's own drag path, then restores the tool the player had. */
export function bulldozeTile(c: ToolController, tile: Tile): number {
  const prev = c.sel;
  c.select({ tool: 'bulldoze' });
  const id = c.dragTiles(tile, tile);
  c.select(prev);
  return id;
}

/** One line about a building for the Info entry: its name, level and what is wrong with it, if anything. */
export function buildingInfoText(layers: Layers, slot: number): string {
  const arch = layers.bArch?.[slot] ?? 0;
  if (arch === 0) return 'Nothing here.';
  const flags = layers.bFlags?.[slot] ?? 0;
  const level = layers.bLevel?.[slot] ?? 0;
  const parts = [projectLabel(arch)];
  const spec = archetype(arch);
  if (level > 0 && spec) parts.push(`level ${level}`);
  if (flags & BFLAG.DEMOLISHING) parts.push('being demolished');
  else if (flags & BFLAG.CONSTRUCTING) parts.push(`under construction ${Math.round(((layers.bProg?.[slot] ?? 0) / 255) * 100)}%`);
  else if (flags & BFLAG.ABANDONED) parts.push('abandoned');
  if (flags & BFLAG.UNPOWERED) parts.push('no power');
  if (flags & BFLAG.UNWATERED) parts.push('no water');
  return parts.join(', ');
}
