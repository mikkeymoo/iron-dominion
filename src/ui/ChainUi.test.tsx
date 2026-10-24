import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ARCH } from '../sim/catalog.ts';
import type { BuildingInfo } from '../sim/protocol.ts';
import { BuildingChain, ResourceChips } from './ChainUi';

const base: BuildingInfo = {
  kind: 'building', slot: 7, arch: ARCH.SMELTER, name: 'Smelter', level: 0, maxLevel: 0, x: 112, y: 105, w: 3, h: 3, status: 'working', progress: 100, residents: 0, jobs: 0,
  thoughts: [],
};
const workforce = { builders: 0, haulers: 0, activeBuilders: 0, activeHaulers: 0, jobs: 0, stock: 1234, alloy: 56, parts: 7 };

describe('ResourceChips', () => {
  it('shows one chip per resource, in order, with the units on hand', () => {
    render(<ResourceChips workforce={workforce} />);
    const chips = screen.getAllByTestId('res-chip');
    expect(chips.map((c) => c.getAttribute('data-res'))).toEqual(['0', '1', '2']);
    expect(chips.map((c) => c.textContent)).toEqual(['Ore1,234', 'Alloy56', 'Components7']);
    expect(chips.every((c) => c.querySelector('.res-dot') !== null)).toBe(true);
  });
});

describe('BuildingChain', () => {
  it('draws a gauge per stock and a checklist per need', () => {
    const info: BuildingInfo = {
      ...base,
      stocks: [{ res: 0, role: 'in', have: 8, cap: 16 }, { res: 1, role: 'out', have: 40, cap: 40 }],
      needs: [{ text: 'Power', ok: true }, { text: 'Ore: 2 of 4 for a batch', ok: false }],
    };
    render(<BuildingChain info={info} />);
    const bars = screen.getAllByTestId('stock-bar');
    expect(bars.map((b) => b.getAttribute('data-role'))).toEqual(['in', 'out']);
    expect(within(bars[0]!).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('8');
    expect((bars[0]!.querySelector('.stock-fill') as HTMLElement).style.width).toBe('50%');
    expect((bars[1]!.querySelector('.stock-fill') as HTMLElement).style.width).toBe('100%');
    const items = within(screen.getByTestId('needs')).getAllByRole('listitem');
    expect(items.map((i) => i.getAttribute('data-ok'))).toEqual(['true', 'false']);
    expect(items[1]!.textContent).toContain('Ore: 2 of 4 for a batch');
  });

  it('titles a grown building\'s checklist as what it needs to grow, and renders nothing for a building without either', () => {
    const { rerender, container } = render(<BuildingChain info={{ ...base, maxLevel: 3, level: 1, needs: [{ text: 'A working shop within 20 tiles', ok: false }] }} />);
    expect(screen.getByRole('group', { name: 'Needs to grow' })).toBeTruthy();
    rerender(<BuildingChain info={base} />);
    expect(container.textContent).toBe('');
  });
});
