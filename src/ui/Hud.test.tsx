import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Lifecycle, LifecycleState } from '../platform/lifecycle.ts';
import { DEFAULT_SETTINGS } from '../platform/settings.ts';
import type { Speed } from '../sim/protocol.ts';
import { emptyServiceStats } from '../sim/services/coverage.ts';
import { gesture } from '../test/pointer';
import { Hud, NO_WORKFORCE, type HudStats } from './Hud';
import type { Layout } from './layout';
import { NO_FACTS } from './progress';

const stats: HudStats = {
  tick: 0, day: 3, dayFrac: 0.4, treasury: 48230, population: 1250, rciDemand: [0.5, 0, -0.5], taxRates: [9, 9, 9], month: 0, lastNet: 120, loans: [], debtMonths: 0,
  power: { supply: 0, demand: 0 }, water: { supply: 0, demand: 0 }, unpowered: 0, unwatered: 0, modelled: { power: false, water: false }, workforce: { ...NO_WORKFORCE, builders: 2 },
  services: emptyServiceStats(),
};

function fakeLifecycle(speed: Speed = 1) {
  const state: LifecycleState = { speed, visible: true, awaitingResume: false, activeMs: 0, saving: false, lastSavedAt: null, lastError: null };
  const setSpeed = vi.fn((s: Speed) => { state.speed = s; });
  const lc = { state, setSpeed, subscribe: () => () => {}, resume: vi.fn(), tick: vi.fn(), hide: vi.fn(), show: vi.fn(), cacheSnapshot: vi.fn(), holdForResume: vi.fn(), saveNow: vi.fn() } as unknown as Lifecycle;
  return { lc, setSpeed };
}

function mount(layout: Layout, over: Partial<Parameters<typeof Hud>[0]> = {}, speed: Speed = 1) {
  const { lc, setSpeed } = fakeLifecycle(speed);
  const calls = { save: vi.fn(), budget: vi.fn(), services: vi.fn(), follow: vi.fn(), setting: vi.fn(), perf: vi.fn(), quit: vi.fn() };
  const view = render(
    <Hud
      lifecycle={lc} stats={stats} settings={DEFAULT_SETTINGS} notice="" budgetOpen={false} onBudget={calls.budget} onServices={calls.services} follow={{ active: false, toggle: calls.follow }}
      onSave={calls.save} onSaveAs={vi.fn()} onExport={vi.fn()} onSetting={calls.setting} onQuit={calls.quit} quitPrompt={null} onQuitSaveAs={vi.fn()} onQuitDiscard={vi.fn()} onQuitCancel={vi.fn()}
      layout={layout} facts={{ ...NO_FACTS, depots: 1 }} perfOn={false} onPerf={calls.perf} {...over}
    />,
  );
  return { ...view, calls, setSpeed };
}

const bar = (): HTMLElement => screen.getByTestId('topbar');
const topNames = (): string[] => within(bar()).queryAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent ?? '');

describe('phone HUD', () => {
  it('draws one row: play/pause, a speed cycle, money, population, RCI bars, the status chip and the menu', () => {
    mount('phone');
    expect(bar().getAttribute('data-layout')).toBe('phone');
    expect(topNames()).toEqual(['Pause', 'Speed 1x. Tap to change.', 'City status', 'Sound on', 'Menu', 'Collapse top bar']);
    expect(screen.getByTestId('money').textContent).toBe('$48,230');
    expect(screen.getByTestId('population').textContent).toBe('Pop 1,250');
    expect(screen.getByTestId('demand')).toBeTruthy();
  });

  it('leaves Save, Budget, Follow, the speed buttons, the workforce readout and the utility bars out of the bar', () => {
    mount('phone');
    for (const name of ['Save', 'Budget', 'Follow a robot', 'Max', '4x']) expect(within(bar()).queryByRole('button', { name })).toBeNull();
    expect(screen.queryByTestId('workforce')).toBeNull();
    expect(screen.queryByTestId('utilities')).toBeNull();
    expect(screen.queryByTestId('monthly-net')).toBeNull();
  });

  it('cycles the speed 1x, 2x, 4x, Max on tap and toggles pause', () => {
    const { setSpeed } = mount('phone');
    fireEvent.click(screen.getByTestId('speed-cycle'));
    expect(setSpeed).toHaveBeenLastCalledWith(2);
    fireEvent.click(screen.getByTestId('playpause'));
    expect(setSpeed).toHaveBeenLastCalledWith(0);
  });

  it('wraps from Max back to 1x, and play resumes the last running speed', () => {
    const { setSpeed } = mount('phone', {}, 'max');
    fireEvent.click(screen.getByTestId('speed-cycle'));
    expect(setSpeed).toHaveBeenLastCalledWith(1);
  });

  it('shows Play while paused and resumes play on tap', () => {
    const { setSpeed } = mount('phone', {}, 0);
    expect(screen.getByTestId('playpause').getAttribute('aria-label')).toBe('Play');
    expect(screen.getByTestId('speed-cycle').textContent).toBe('1x');
    fireEvent.click(screen.getByTestId('playpause'));
    expect(setSpeed).toHaveBeenLastCalledWith(1);
  });

  it('moves Budget, Follow, Save and the performance toggle into the menu drawer', () => {
    const { calls } = mount('phone');
    expect(screen.queryByTestId('menu')).toBeNull();
    fireEvent.click(screen.getByTestId('menu-button'));
    const menu = screen.getByTestId('menu');
    for (const name of ['Budget', 'Follow a robot', 'Save', 'Export to file', 'Restart tutorial', 'Settings']) expect(within(menu).getByRole('button', { name })).toBeTruthy();
    expect(within(menu).getByTestId('perf-toggle')).toBeTruthy();
    fireEvent.click(within(menu).getByRole('button', { name: 'Follow a robot' }));
    expect(calls.follow).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('menu')).toBeNull();
    fireEvent.click(screen.getByTestId('menu-button'));
    fireEvent.click(within(screen.getByTestId('menu')).getByRole('button', { name: 'Budget' }));
    expect(calls.budget).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByTestId('menu-button'));
    fireEvent.click(within(screen.getByTestId('menu')).getByTestId('perf-toggle'));
    expect(calls.perf).toHaveBeenCalledWith(true);
  });

  it('holds the clock, the monthly net and the workforce readout in the status popover', () => {
    mount('phone');
    fireEvent.click(screen.getByTestId('status-chip'));
    const pop = screen.getByTestId('status-pop');
    expect(within(pop).getByTestId('workforce').textContent).toMatch(/Builders 0\/2/);
    expect(within(pop).getByTestId('monthly-net').textContent).toBe('+$120/mo');
    expect(pop.textContent).toMatch(/Day 3 09:3\d/);
  });

  it('warns "No depot" in the chip popover and flags the chip until a depot exists', () => {
    mount('phone', { facts: NO_FACTS });
    expect(screen.getByTestId('status-chip').className).toContain('alert');
    fireEvent.click(screen.getByTestId('status-chip'));
    expect(screen.getByTestId('no-depot').textContent).toBe('No depot');
    expect(screen.getByTestId('workforce').className).toContain('warn');
  });

  it('does not warn once a depot exists', () => {
    mount('phone', { facts: { ...NO_FACTS, depots: 1 } });
    expect(screen.getByTestId('status-chip').className).not.toContain('alert');
    fireEvent.click(screen.getByTestId('status-chip'));
    expect(screen.queryByTestId('no-depot')).toBeNull();
  });
});

describe('collapsible phone top bar', () => {
  it('shows only pause, speed, money, population, the advisor slot and a chevron when collapsed', () => {
    mount('phone', { topOpen: false, onTopOpen: vi.fn() });
    expect(topNames()).toEqual(['Pause', 'Speed 1x. Tap to change.', 'Expand top bar']);
    expect(screen.getByTestId('money')).toBeTruthy();
    expect(screen.getByTestId('population')).toBeTruthy();
    expect(bar().querySelector('[data-slot="advisor"]')).not.toBeNull();
    expect(screen.queryByTestId('demand')).toBeNull();
    expect(screen.queryByTestId('menu-button')).toBeNull();
    expect(screen.queryByTestId('status-chip')).toBeNull();
    expect(bar().getAttribute('data-open')).toBe('false');
  });

  it('asks to expand and collapse from the chevron, and keeps the remembered state', () => {
    const onTopOpen = vi.fn();
    mount('phone', { topOpen: false, onTopOpen });
    fireEvent.click(screen.getByTestId('topbar-chevron'));
    expect(onTopOpen).toHaveBeenLastCalledWith(true);
  });

  it('starts expanded and collapses on its own when no state is wired in', () => {
    mount('phone');
    expect(screen.getByTestId('menu-button')).toBeTruthy();
    fireEvent.click(screen.getByTestId('topbar-chevron'));
    expect(screen.queryByTestId('menu-button')).toBeNull();
    expect(screen.getByTestId('topbar-chevron').getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByTestId('topbar-chevron'));
    expect(screen.getByTestId('menu-button')).toBeTruthy();
  });

  it('closes the menu when the bar folds up, and only one of menu and status is open at a time', () => {
    mount('phone');
    fireEvent.click(screen.getByTestId('menu-button'));
    expect(screen.getByTestId('menu')).toBeTruthy();
    fireEvent.click(screen.getByTestId('status-chip'));
    expect(screen.queryByTestId('menu')).toBeNull();
    expect(screen.getByTestId('status-pop')).toBeTruthy();
    fireEvent.click(screen.getByTestId('topbar-chevron'));
    expect(screen.queryByTestId('status-pop')).toBeNull();
  });

  it('reports the open panel to the owner so a single panel is open across the HUD', () => {
    const onPanel = vi.fn();
    mount('phone', { panel: null, onPanel });
    fireEvent.click(screen.getByTestId('menu-button'));
    expect(onPanel).toHaveBeenLastCalledWith('menu');
    fireEvent.click(screen.getByTestId('status-chip'));
    expect(onPanel).toHaveBeenLastCalledWith('status');
  });

  it('never collapses on desktop, whatever the stored state', () => {
    mount('desktop', { topOpen: false, onTopOpen: vi.fn() });
    expect(screen.queryByTestId('topbar-chevron')).toBeNull();
    expect(screen.getByTestId('menu-button')).toBeTruthy();
  });

  it('shows the running tier next to Auto in the graphics setting', () => {
    mount('desktop', { activeTier: 'mid' });
    fireEvent.click(screen.getByTestId('menu-button'));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('option', { name: 'Auto (mid)' })).toBeTruthy();
    expect(screen.getByTestId('tier-now').textContent).toMatch(/Running at mid \(auto/);
  });
});

describe('desktop HUD', () => {
  it('keeps the full bar: every speed button, clock, net, workforce, Follow, Budget, Save and Menu', () => {
    mount('desktop');
    expect(bar().getAttribute('data-layout')).toBe('desktop');
    for (const name of ['1x', '2x', '4x', 'Max', 'Follow a robot', 'Budget', 'Save', 'Menu']) expect(within(bar()).getByRole('button', { name })).toBeTruthy();
    expect(screen.getByTestId('workforce').textContent).toMatch(/Builders 0\/2Haulers 0\/0Jobs 0ResourcesOre0Alloy0Components0/);
    expect(screen.getAllByTestId('res-chip').map((c) => c.getAttribute('data-res'))).toEqual(['0', '1', '2']);
    expect(screen.getByTestId('monthly-net').textContent).toBe('+$120/mo');
    expect(screen.queryByTestId('speed-cycle')).toBeNull();
    expect(screen.queryByTestId('status-chip')).toBeNull();
  });

  it('shows "No depot" beside the workforce numbers when there is no depot', () => {
    mount('desktop', { facts: NO_FACTS });
    expect(screen.getByTestId('no-depot').textContent).toBe('No depot');
    expect(screen.getByTestId('workforce').textContent).toMatch(/Builders/);
  });

  it('keeps pause on the speed group with the Pause (0) title the keyboard hint names', () => {
    const { setSpeed } = mount('desktop');
    fireEvent.click(bar().querySelector('button[title="Pause (0)"]')!);
    expect(setSpeed).toHaveBeenLastCalledWith(0);
  });

  it('keeps the menu free of the controls the bar already has', () => {
    mount('desktop');
    fireEvent.click(screen.getByTestId('menu-button'));
    const menu = screen.getByTestId('menu');
    expect(within(menu).queryByRole('button', { name: 'Budget' })).toBeNull();
    expect(within(menu).queryByRole('button', { name: 'Follow a robot' })).toBeNull();
    expect(within(menu).getByRole('button', { name: 'Save as...' })).toBeTruthy();
    expect(within(menu).getByTestId('perf-toggle')).toBeTruthy();
  });

  it('shows the status message under the bar, not as a row inside it', () => {
    mount('desktop', { notice: 'Saved' });
    expect(screen.getByTestId('notice').textContent).toBe('Saved');
    expect(screen.getByTestId('notice').className).toBe('notice');
  });
});

describe('focus mode and the grab headers', () => {
  it('hides the whole top bar in focus mode on both layouts', () => {
    for (const layout of ['phone', 'desktop'] as const) {
      const { unmount } = mount(layout, { settings: { ...DEFAULT_SETTINGS, focus: true } });
      expect(screen.queryByTestId('topbar')).toBeNull();
      unmount();
    }
  });

  it('turns focus mode on from the menu and closes the menu', () => {
    const { calls } = mount('phone');
    fireEvent.click(screen.getByTestId('menu-button'));
    fireEvent.click(screen.getByTestId('focus-toggle'));
    expect(calls.setting).toHaveBeenCalledWith('focus', true);
  });

  it('offers the handedness choice in settings', () => {
    const { calls } = mount('phone');
    fireEvent.click(screen.getByTestId('menu-button'));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.change(screen.getByTestId('handedness-select'), { target: { value: 'left' } });
    expect(calls.setting).toHaveBeenCalledWith('handedness', 'left');
  });

  it('closes the menu popover from its header and collapses a menu section from its chevron', () => {
    const onPanel = vi.fn();
    mount('phone', { panel: 'menu', onPanel });
    fireEvent.click(screen.getByRole('button', { name: 'Collapse City' }));
    expect(screen.getByRole('button', { name: 'Expand City' }).getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Menu' }));
    expect(onPanel).toHaveBeenCalledWith(null);
  });

  it('tapping the readouts expands and collapses the phone top bar', () => {
    const onTopOpen = vi.fn();
    mount('phone', { topOpen: false, onTopOpen });
    const r = screen.getByTestId('readouts');
    gesture(r, { x: 50, y: 20 });
    expect(onTopOpen).toHaveBeenLastCalledWith(true);
  });
});

describe('approval chip', () => {
  const council = { approval: 41, level: 'good' as const, target: 44, factors: [], requests: [], festivals: [], running: null, completed: 0, failed: 0 };

  it('sits beside the money on a desktop and opens the council panel', () => {
    const onPanel = vi.fn();
    mount('desktop', { stats: { ...stats, council }, panel: null, onPanel });
    const chip = screen.getByTestId('approval-chip');
    expect(screen.getByTestId('approval-value').textContent).toBe('41');
    expect(chip.parentElement).toBe(screen.getByTestId('money').parentElement);
    fireEvent.click(chip);
    expect(onPanel).toHaveBeenLastCalledWith('council');
  });

  it('is a 44 px strip item of its own on a phone, outside the stacked readouts, and closes the panel when open', () => {
    const onPanel = vi.fn();
    mount('phone', { stats: { ...stats, council }, panel: 'council', onPanel });
    const chip = screen.getByTestId('approval-chip');
    expect(chip.closest('[data-testid="readouts"]')).toBeNull();
    expect(bar().contains(chip)).toBe(true);
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(chip);
    expect(onPanel).toHaveBeenLastCalledWith(null);
  });

  it('is absent before the first Stats message and has a menu row once it arrives', () => {
    const { unmount } = mount('desktop');
    expect(screen.queryByTestId('approval-chip')).toBeNull();
    unmount();
    const onPanel = vi.fn();
    mount('desktop', { stats: { ...stats, council }, panel: 'menu', onPanel });
    fireEvent.click(screen.getByTestId('council-menu'));
    expect(onPanel).toHaveBeenLastCalledWith('council');
    expect(screen.getByTestId('council-menu').textContent).toBe('Council (41% approval)');
  });
});

describe('shared HUD behaviour', () => {
  it('resets the tips from the menu', () => {
    const { calls } = mount('phone');
    fireEvent.click(screen.getByTestId('menu-button'));
    fireEvent.click(screen.getByRole('button', { name: 'Restart tutorial' }));
    expect(calls.setting).toHaveBeenCalledWith('onboarding', { dismissed: false, collapsed: false, hintsSeen: [] });
  });
});
