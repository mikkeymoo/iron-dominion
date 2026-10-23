import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SlotMeta } from '../platform/db.ts';
import { Title } from './Title';

const slot = (id: string, name: string, updated: number): SlotMeta => ({ id, name, created: 1, updated, population: 1500, treasury: 9000, day: 12, byteSize: 250_000 });

const setup = (slots: SlotMeta[]) => {
  const fns = { onNew: vi.fn(), onLoad: vi.fn(), onDelete: vi.fn(), onImport: vi.fn() };
  render(<Title worker="ready" tick={5} slots={slots} storageOk message="" {...fns} />);
  return fns;
};

describe('Title', () => {
  it('disables Continue and Load with no saves', () => {
    setup([]);
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Load' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Continue loads the first (latest) slot', () => {
    const f = setup([slot('b', 'Newer', 2), slot('a', 'Older', 1)]);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(f.onLoad).toHaveBeenCalledWith('b');
  });

  it('lists slot metadata and asks before deleting', () => {
    const f = setup([slot('a', 'Alpha', 1)]);
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    expect(screen.getByText(/Day 12 - Pop 1,500/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Alpha' }));
    expect(f.onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Alpha?' }));
    expect(f.onDelete).toHaveBeenCalledWith('a');
  });

  it('starts a new city with a name and an optional seed', () => {
    const f = setup([]);
    fireEvent.click(screen.getByRole('button', { name: 'New city' }));
    fireEvent.change(screen.getByLabelText('City name'), { target: { value: 'Ironton' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(f.onNew).toHaveBeenCalledWith('Ironton', undefined);
    fireEvent.change(screen.getByLabelText('Seed (optional)'), { target: { value: '42' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(f.onNew).toHaveBeenLastCalledWith('Ironton', 42);
  });

  it('blocks a non-integer seed', () => {
    setup([]);
    fireEvent.click(screen.getByRole('button', { name: 'New city' }));
    fireEvent.change(screen.getByLabelText('Seed (optional)'), { target: { value: 'abc' } });
    expect((screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
