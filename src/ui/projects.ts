import { ARCH, archetype } from '../sim/catalog.ts';
import { megaOf } from '../sim/megaprojects.ts';
import { ROAD_NAMES, DENSITY_LABELS } from '../render/tools/toolSpec.ts';
import type { UnlockItem } from '../sim/unlocks.ts';

/** Display names for the buildings the milestones panel names (megaprojects and the fusion reactor). */
export const BUILDING_LABELS: Record<number, string> = {
  [ARCH.FUSION_REACTOR]: 'Fusion reactor',
  [ARCH.FUSION_SPIRE]: 'Fusion Spire',
  [ARCH.ARCOLOGY]: 'Arcology',
  [ARCH.MECH_ARENA]: 'Mech Arena',
  [ARCH.SPACE_ELEVATOR]: 'Space Elevator',
};

const words = (name: string): string => { const s = name.replace(/([A-Z])/g, ' $1').toLowerCase(); return s[0]!.toUpperCase() + s.slice(1); };
export const projectLabel = (arch: number): string => BUILDING_LABELS[arch] ?? words(archetype(arch)?.name ?? 'project');

/** One line on what a finished project gives the city. */
export function projectBlurb(arch: number): string {
  const m = megaOf(arch);
  if (!m) return '';
  const parts: string[] = [];
  if (m.mw > 0) parts.push(`${m.mw.toLocaleString('en-US')} MW of power`);
  if (m.aura.value > 0) parts.push('raises land value nearby');
  if (m.residents > 0) parts.push(`homes for ${m.residents.toLocaleString('en-US')} residents`);
  if (m.visitors > 0) parts.push('draws tourists, lifting commercial demand');
  if (m.income > 0) parts.push(`$${m.income.toLocaleString('en-US')} a month`);
  if (arch === ARCH.SPACE_ELEVATOR) parts.push('completing it wins the game');
  return parts.join(', ');
}

export function unlockText(u: UnlockItem): string {
  if (u.kind === 'road') return `${ROAD_NAMES[u.id]![0]!.toUpperCase()}${ROAD_NAMES[u.id]!.slice(1)} roads`;
  if (u.kind === 'density') return `${DENSITY_LABELS[u.id]} density zoning`;
  return projectLabel(u.id);
}

export const money = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;
