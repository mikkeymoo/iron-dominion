import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RenderMirror } from '../render/mirror.ts';
import type { SimClient } from '../sim/client.ts';
import type { CommandBody } from '../sim/commands.ts';
import { ARCH } from '../sim/catalog.ts';
import type { BlueprintStat } from '../sim/protocol.ts';
import { BlueprintQueue, etaText } from './BlueprintQueue';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const bp = (slot: number, order: number, arch: number, cost: number, etaSec: number): BlueprintStat => ({ slot, order, arch, name: 'x', x: 10 + slot, y: 20, w: 2, h: 2, rot: 0, cost, etaSec });

function mount(list: BlueprintStat[]) {
  const mirror = new RenderMirror();
  mirror.blueprints = list;
  mirror.blueprintVersion = 1;
  const sent: CommandBody[] = [];
  const client = { command: (b: CommandBody) => { sent.push(b); return sent.length; } } as unknown as SimClient;
  const jumps: [number, number][] = [];
  render(<BlueprintQueue mirror={mirror} client={client} onJump={(x, y) => jumps.push([x, y])} />);
  const publish = (next: BlueprintStat[]): void => {
    mirror.blueprints = next;
    mirror.blueprintVersion++;
    act(() => { vi.advanceTimersByTime(300); });
  };
  return { mirror, sent, jumps, publish };
}

const rows = (): HTMLElement[] => screen.queryAllByTestId('bp-row');

describe('etaText', () => {
  it('reads seconds, then minutes and seconds', () => {
    expect([etaText(9), etaText(60), etaText(125)]).toEqual(['9s', '1m 00s', '2m 05s']);
  });
});

describe('BlueprintQueue', () => {
  it('renders nothing while the queue is empty', () => {
    mount([]);
    expect(screen.queryByTestId('bp-queue')).toBeNull();
  });

  it('lists each blueprint in queue order with its position, cost and estimate', () => {
    mount([bp(4, 0, ARCH.SCHOOL, 1400, 31), bp(7, 1, ARCH.CLINIC, 900, 52), bp(2, 2, ARCH.PARK_SMALL, 300, 74)]);
    expect(rows().map((r) => r.getAttribute('data-slot'))).toEqual(['4', '7', '2']);
    expect(within(rows()[0]!).getByTestId('bp-pin').textContent).toBe('1');
    expect(rows()[1]!.textContent).toContain('Clinic');
    expect(rows()[1]!.textContent).toContain('$900');
    expect(rows()[1]!.textContent).toContain('~52s');
    expect(rows()[0]!.getAttribute('data-first')).toBe('true');
    expect(screen.getByTestId('bp-queue').textContent).toContain('Build queue (3)');
  });

  it('sends Build next, up, down and cancel as commands, and disables the moves that cannot happen', () => {
    const { sent } = mount([bp(4, 0, ARCH.SCHOOL, 1400, 31), bp(7, 1, ARCH.CLINIC, 900, 52), bp(2, 2, ARCH.PARK_SMALL, 300, 74)]);
    const [first, middle, last] = rows() as [HTMLElement, HTMLElement, HTMLElement];
    expect((within(first).getByTestId('bp-next') as HTMLButtonElement).disabled).toBe(true);
    expect((within(first).getByTestId('bp-up') as HTMLButtonElement).disabled).toBe(true);
    expect((within(last).getByTestId('bp-down') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(last).getByTestId('bp-next'));
    fireEvent.click(within(middle).getByTestId('bp-up'));
    fireEvent.click(within(middle).getByTestId('bp-down'));
    fireEvent.click(within(middle).getByTestId('bp-cancel'));
    expect(sent).toEqual([
      { type: 'moveBlueprint', slot: 2, to: 0 }, { type: 'moveBlueprint', slot: 7, to: 0 }, { type: 'moveBlueprint', slot: 7, to: 2 }, { type: 'cancelBlueprint', slot: 7 },
    ]);
  });

  it('jumps to the site when the name is tapped', () => {
    const { jumps } = mount([bp(4, 0, ARCH.SCHOOL, 1400, 31)]);
    fireEvent.click(screen.getByTestId('bp-name'));
    expect(jumps).toEqual([[14, 20]]);
  });

  it('follows the mirror when the queue changes and goes away when it empties', () => {
    const { publish } = mount([bp(4, 0, ARCH.SCHOOL, 1400, 31), bp(7, 1, ARCH.CLINIC, 900, 52)]);
    publish([bp(7, 0, ARCH.CLINIC, 900, 21)]);
    expect(rows().map((r) => r.getAttribute('data-slot'))).toEqual(['7']);
    publish([]);
    expect(screen.queryByTestId('bp-queue')).toBeNull();
  });

  it('drags the pin of a row onto another row to move it there', () => {
    const { sent } = mount([bp(4, 0, ARCH.SCHOOL, 1400, 31), bp(7, 1, ARCH.CLINIC, 900, 52), bp(2, 2, ARCH.PARK_SMALL, 300, 74)]);
    const target = rows()[0]!;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => target;
    try {
      const pin = within(rows()[2]!).getByTestId('bp-pin');
      fireEvent.pointerDown(pin, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 300 });
      fireEvent.pointerMove(pin, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 });
      expect(rows()[0]!.getAttribute('data-over')).toBe('true');
      expect(rows()[2]!.getAttribute('data-dragging')).toBe('true');
      fireEvent.pointerUp(pin, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 });
    } finally { document.elementFromPoint = original; }
    expect(sent).toEqual([{ type: 'moveBlueprint', slot: 2, to: 0 }]);
  });
});
