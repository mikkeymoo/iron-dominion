import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen, act } from '@testing-library/react';

const renders: unknown[] = [];
vi.mock('./renderer', () => ({
  TEAM_HEX: { player: 0x7be8df, red: 0xff5468, amber: 0xffb43c, green: 0x9be06a, rogue: 0xb68cff, neutral: 0x75808b },
  ArenaRenderer: class {
    render(s: unknown) { renders.push(s); }
    resize() {}
    dispose() {}
    groundPoint() { return null; }
  },
}));
vi.mock('./audio', () => ({
  ArenaAudio: class { unlock() {} setMuted() {} suspend() {} resume() {} dispose() {} play() {} },
}));

import { ActionGame } from './ActionGame';

describe('3D action shell', () => {
  it('briefs, deploys, pauses on hide and resumes only on request', async () => {
    const exit = vi.fn();
    render(<ActionGame onExit={exit} />);
    expect(screen.getByText(/Drop into the shattered front/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Deploy' }));
    expect(screen.getByRole('meter', { name: 'Hull' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Missile salvo' })).toBeTruthy();

    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Quit to title' }));
    expect(exit).toHaveBeenCalled();
  });

  it('shows a fallback when WebGL cannot start', async () => {
    const mod = await import('./renderer');
    const spy = vi.spyOn(mod, 'ArenaRenderer').mockImplementation(() => { throw new Error('no webgl'); });
    render(<ActionGame onExit={() => {}} />);
    expect(screen.getByText('Graphics offline')).toBeTruthy();
    spy.mockRestore();
  });
});
