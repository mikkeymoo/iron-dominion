import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lifecycle, LifecycleState } from '../platform/lifecycle.ts';
import { DEFAULT_SETTINGS } from '../platform/settings.ts';
import type { ToolWorld } from '../render/tools/controller.ts';
import { ViewState } from '../render/viewState.ts';
import { TERRAIN } from '../sim/layers.ts';
import { emptyServiceStats } from '../sim/services/coverage.ts';
import { allocWorld } from '../sim/world.ts';
import { pointer } from '../test/pointer';
import { Hud, NO_WORKFORCE, type HudStats } from './Hud';
import { Panel } from './Panel';
import { useOutsideDismiss, type PanelId } from './panels';
import { NO_FACTS } from './progress';
import { Tools } from './Tools';
import { ToolsRuntime } from './toolsStore.ts';

const stats: HudStats = {
  tick: 0, day: 3, dayFrac: 0.4, treasury: 48230, population: 1250, rciDemand: [0.5, 0, -0.5], taxRates: [9, 9, 9], month: 0, lastNet: 120, loans: [], debtMonths: 0,
  power: { supply: 0, demand: 0 }, water: { supply: 0, demand: 0 }, unpowered: 0, unwatered: 0, modelled: { power: false, water: false }, workforce: { ...NO_WORKFORCE, builders: 2 },
  services: emptyServiceStats(),
};

interface MapTaps { down: number; up: number }

/** GameView's panel wiring on a phone, with a div standing in for the map: it starts a tool on pointerdown and spends on pointerup. */
function Wiring({ rt, view, map }: { rt: ToolsRuntime; view: ViewState; map: MapTaps }) {
  const [panel, setPanel] = useState<PanelId | null>(null);
  const lc = { state: { speed: 1, visible: true, awaitingResume: false, activeMs: 0, saving: false, lastSavedAt: null, lastError: null } as LifecycleState, setSpeed: vi.fn(), subscribe: () => () => {} } as unknown as Lifecycle;
  const closeFloating = (): void => setPanel(null);
  useOutsideDismiss(panel !== null, closeFloating, closeFloating, true);
  return (
    <>
      <div data-testid="map" onPointerDown={() => { map.down++; }} onPointerUp={() => { map.up++; }} />
      <Hud
        lifecycle={lc} stats={stats} settings={DEFAULT_SETTINGS} notice="" budgetOpen={panel === 'budget'} onBudget={() => setPanel((p) => (p === 'budget' ? null : 'budget'))} onServices={vi.fn()}
        onSave={vi.fn()} onSaveAs={vi.fn()} onExport={vi.fn()} onSetting={vi.fn()} onQuit={vi.fn()} quitPrompt={null} onQuitSaveAs={vi.fn()} onQuitDiscard={vi.fn()} onQuitCancel={vi.fn()}
        layout="phone" facts={{ ...NO_FACTS, depots: 1 }} perfOn={false} onPerf={vi.fn()} panel={panel} onPanel={setPanel} topOpen onTopOpen={vi.fn()}
      />
      <Tools runtime={rt} view={view} layout="phone" hints={{ seen: [], mark: () => {} }} panel={panel} onPanel={setPanel} />
      {panel === 'budget' && <Panel id="budget" title="Budget" panelAttr="budget" testId="budget" onClose={() => setPanel(null)}><p>ledger</p></Panel>}
    </>
  );
}

function mount() {
  const w = allocWorld();
  w.terrain.fill(TERRAIN.GRASS);
  const world: ToolWorld = { layers: w as unknown as Record<string, ArrayLike<number>>, scalars: w.scalars, tick: 0 };
  const rt = new ToolsRuntime({ world, submit: () => 1 });
  const map: MapTaps = { down: 0, up: 0 };
  render(<Wiring rt={rt} view={new ViewState()} map={map} />);
  return { rt, map };
}

const tap = (el: Element): void => { pointer(el, 'down'); pointer(el, 'up'); fireEvent.click(el); };

beforeEach(() => {
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
});
afterEach(() => { delete (window as { matchMedia?: unknown }).matchMedia; });

/** Menu, then Budget, and the menu is still fading out under the new panel: its header sits where Budget's header is. */
function openBudgetFromMenu(): HTMLElement {
  tap(screen.getByTestId('menu-button'));
  tap(screen.getByRole('button', { name: 'Budget' }));
  expect(screen.queryByTestId('budget')).not.toBeNull();
  const menu = screen.getByTestId('menu');
  expect(menu.getAttribute('data-state')).toBe('closing');
  return menu;
}

describe('Budget opened from the menu drawer', () => {
  it('survives a tap on the header while the menu is still fading out', () => {
    mount();
    const menu = openBudgetFromMenu();
    tap(within(menu).getByText('Menu'));
    expect(screen.queryByTestId('budget')).not.toBeNull();
  });

  it('survives closes aimed at the fading menu: its Close row and its header chevron', () => {
    mount();
    const menu = openBudgetFromMenu();
    fireEvent.click(within(menu).getByRole('button', { name: 'Close' }));
    fireEvent.click(within(menu).getByRole('button', { name: 'Dismiss Menu' }));
    expect(screen.queryByTestId('budget')).not.toBeNull();
  });

  it('keeps the tap that closes it off the map and the selected tool (F4)', () => {
    const { rt, map } = mount();
    rt.controller.select({ tool: 'road', cls: 'street' } as never);
    const menu = openBudgetFromMenu();
    tap(within(menu).getByText('Menu'));
    expect(screen.queryByTestId('budget')).not.toBeNull();
    tap(screen.getByTestId('map'));
    expect(screen.queryByTestId('budget')).toBeNull();
    expect(map.down).toBe(0);
  });
});

describe('the phone perf panel', () => {
  it('is off by default on a phone, and with nothing floating a map tap reaches the map', () => {
    expect(DEFAULT_SETTINGS.showPerf).toBeNull();
    const { map } = mount();
    tap(screen.getByTestId('map'));
    expect(map.down).toBe(1);
    expect(map.up).toBe(1);
  });
});
