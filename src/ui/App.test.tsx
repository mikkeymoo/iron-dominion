import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('App shell', () => {
  it('shows the title and reports a worker failure when Worker is unavailable', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Iron Dominion' })).toBeTruthy();
    expect(screen.getByText(/Engine: failed/)).toBeTruthy();
  });
});
