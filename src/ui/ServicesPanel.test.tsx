import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { emptyServiceStats } from '../sim/services/coverage.ts';
import { ServicesPanel } from './ServicesPanel';

describe('services panel', () => {
  it('shows coverage per service and the indices, and closes', () => {
    const stats = emptyServiceStats();
    stats.fire = { buildings: 2, working: 1, capacity: 3000, population: 4000, served: 3000, pct: 75 };
    stats.crimeIndex = 42; stats.parks = 3;
    const onClose = vi.fn();
    render(<ServicesPanel stats={stats} onClose={onClose} />);
    const row = screen.getByTestId('services-fire');
    expect(row.textContent).toContain('1/2');
    expect(row.textContent).toContain('75%');
    expect(screen.getByTestId('services-police').textContent).toContain('0%');
    expect(screen.getByTestId('services-crime').textContent).toBe('42');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
