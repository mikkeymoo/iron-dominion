import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const auto = vi.hoisted(() => vi.fn((_f: unknown) => false));
vi.mock('../platform/repair.ts', async (orig) => ({ ...(await orig<typeof import('../platform/repair.ts')>()), autoRepairOnce: auto }));

import { App } from './App';

describe('App shell', () => {
  it('shows the title and reports a worker failure when Worker is unavailable', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Iron Dominion' })).toBeTruthy();
    expect(screen.getByText(/Engine: failed/)).toBeTruthy();
  });

  it('says why the engine failed, offers a repair, and tries the automatic repair once per failure', () => {
    auto.mockClear();
    render(<App />);
    expect(screen.getByText("Couldn't start the simulation worker.")).toBeTruthy();
    expect(screen.getByText(/failed to start worker: .*Worker is not defined/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Repair and reload' })).toBeTruthy();
    expect(auto).toHaveBeenCalled();
    expect(auto.mock.calls[0]![0]).toMatchObject({ kind: 'worker', repairable: true });
  });

  it('offers a New city button that is disabled while the engine is down', () => {
    render(<App />);
    const button = screen.getByRole('button', { name: 'New city' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});
