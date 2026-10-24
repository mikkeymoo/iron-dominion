import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SlotMeta } from '../platform/db.ts';
import { PROTOCOL_VERSION } from '../sim/protocol.ts';
import { Title } from './Title';

const slot = (id: string, name: string, updated: number): SlotMeta => ({ id, name, created: 1, updated, population: 1500, treasury: 9000, day: 12, byteSize: 250_000 });

const setup = (slots: SlotMeta[]) => {
  const fns = { onNew: vi.fn(), onLoad: vi.fn(), onDelete: vi.fn(), onImport: vi.fn() };
  render(<Title worker="ready" tick={5} slots={slots} storageOk message="" {...fns} />);
  return fns;
};

describe('Title when the engine failed', () => {
  const failed = (workerError: string | undefined, onRepair = vi.fn()) => {
    render(<Title worker="failed" workerError={workerError} onRepair={onRepair} tick={0} slots={[]} storageOk message="" onNew={vi.fn()} onLoad={vi.fn()} onDelete={vi.fn()} onImport={vi.fn()} />);
    return onRepair;
  };

  it('shows a readable reason, the raw detail and a repair button', () => {
    const repair = failed('build mismatch: worker a, app b (stale cache? reload the page)');
    expect(screen.getByText(/Engine: failed/)).toBeTruthy();
    expect(screen.getByText('The game was updated while loading.')).toBeTruthy();
    expect(screen.getByText(/build mismatch: worker a, app b/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Repair and reload' }));
    expect(repair).toHaveBeenCalledTimes(1);
  });

  it('explains a worker start failure and a failure with no detail', () => {
    failed('worker error: unknown');
    expect(screen.getByText("Couldn't start the simulation worker.")).toBeTruthy();
  });

  it('shows no failure notice while the engine is fine', () => {
    setup([]);
    expect(screen.queryByRole('button', { name: 'Repair and reload' })).toBeNull();
  });
});

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

  it('greys out a slot from an older version, disables its Load, and Continue skips it', () => {
    const f = setup([{ ...slot('b', 'Newer', 2), protocol: PROTOCOL_VERSION - 1 }, { ...slot('a', 'Older', 1), protocol: PROTOCOL_VERSION }]);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(f.onLoad).toHaveBeenCalledWith('a');
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    expect(screen.getByText(/old version/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Load Newer' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Load Older' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Delete Newer' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('disables Continue when every save is from an older version', () => {
    setup([{ ...slot('b', 'Only', 2), protocol: PROTOCOL_VERSION - 1 }]);
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true);
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
