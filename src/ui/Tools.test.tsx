import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TERRAIN } from '../sim/layers.ts';
import { allocWorld } from '../sim/world.ts';
import type { ToolWorld } from '../render/tools/controller.ts';
import { ViewState } from '../render/viewState.ts';
import { Tools, groupOf } from './Tools';
import { ToolsRuntime } from './toolsStore.ts';

afterEach(() => vi.useRealTimers());

function mount(layout: 'phone' | 'desktop', seen: string[] = [], expand = true, extra: Partial<Parameters<typeof Tools>[0]> = {}) {
  const w = allocWorld();
  w.terrain.fill(TERRAIN.GRASS);
  const world: ToolWorld = { layers: w as unknown as Record<string, ArrayLike<number>>, scalars: w.scalars, tick: 0 };
  const rt = new ToolsRuntime({ world, submit: () => 1 });
  const view = new ViewState();
  const marked: string[] = [];
  const out = render(<Tools runtime={rt} view={view} layout={layout} hints={{ seen, mark: (id) => marked.push(id) }} {...extra} />);
  if (layout === 'phone' && expand) fireEvent.click(screen.getByTestId('build-fab'));
  return { rt, view, marked, ...out };
}

const barNames = (): string[] => within(screen.getByTestId('toolbar')).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? '');

describe('icon tool bar', () => {
  it('is one row of Bulldoze, Road, Zone, Services, Utilities, Terraform, Undo and Views, each with an accessible name and an SVG icon', () => {
    mount('phone');
    expect(barNames()).toEqual(['Bulldoze', 'Road', 'Zone', 'Services', 'Utilities', 'Terraform', 'Undo', 'Views']);
    for (const b of within(screen.getByTestId('toolbar')).getAllByRole('button')) expect(b.querySelector('svg')).not.toBeNull();
  });

  it('is the same row on a desktop, with the text labels still present for sighted users', () => {
    mount('desktop');
    expect(barNames()).toHaveLength(8);
    expect(screen.getByTestId('tool-road').textContent).toBe('Road');
  });

  it('shows Cancel and the options strip only while a tool is active', () => {
    const { rt } = mount('phone');
    expect(screen.queryByTestId('cancel-tool')).toBeNull();
    expect(screen.queryByTestId('optstrip')).toBeNull();
    fireEvent.click(screen.getByTestId('tool-zone'));
    const strip = screen.getByTestId('optstrip');
    expect(within(strip).getByRole('button', { name: 'Cancel' })).toBeTruthy();
    for (const n of ['Residential', 'Commercial', 'Industrial', 'Low', 'Medium']) expect(within(strip).getByRole('button', { name: n })).toBeTruthy();
    expect(within(strip).getByRole('button', { name: /^High/ })).toBeTruthy();
    fireEvent.click(within(strip).getByRole('button', { name: 'Cancel' }));
    expect(rt.controller.sel).toBeNull();
    expect(screen.queryByTestId('optstrip')).toBeNull();
  });

  it('opens the Services options with the depot first, and toggles a tool off with a second tap', () => {
    const { rt } = mount('phone');
    fireEvent.click(screen.getByTestId('tool-service'));
    expect(within(screen.getByTestId('optstrip')).getByRole('button', { name: /Depot \$500/ })).toBeTruthy();
    expect(groupOf(rt.controller.sel)).toBe('service');
    fireEvent.click(screen.getByTestId('tool-service'));
    expect(rt.controller.sel).toBeNull();
  });

  it('groups power and water lines with the utility buildings', () => {
    mount('phone');
    fireEvent.click(screen.getByTestId('tool-utilities'));
    const strip = screen.getByTestId('optstrip');
    expect(within(strip).getByRole('button', { name: /Power line/ })).toBeTruthy();
    expect(within(strip).getByRole('button', { name: /Water pipe/ })).toBeTruthy();
    expect(within(strip).getByRole('button', { name: /Power plant/ })).toBeTruthy();
    expect(within(strip).getByRole('button', { name: /Water pump/ })).toBeTruthy();
  });

  it('keeps the overlay and underground controls in a Views popover', () => {
    const { view } = mount('phone');
    expect(screen.queryByTestId('overlay-power')).toBeNull();
    fireEvent.click(screen.getByTestId('views-toggle'));
    expect(screen.getByTestId('views-pop')).toBeTruthy();
    fireEvent.click(screen.getByTestId('overlay-power'));
    expect(view.overlay).toBe('power');
    fireEvent.click(screen.getByTestId('underground'));
    expect(view.underground).toBe(true);
    fireEvent.click(screen.getByTestId('views-toggle'));
    expect(screen.queryByTestId('views-pop')).toBeNull();
  });

  it('toggles the underground view with U whether or not the popover is open', () => {
    const { view } = mount('phone');
    fireEvent.keyDown(window, { key: 'u' });
    expect(view.underground).toBe(true);
    fireEvent.click(screen.getByTestId('views-toggle'));
    fireEvent.keyDown(window, { key: 'u' });
    expect(view.underground).toBe(false);
  });
});

describe('collapsible tool bar', () => {
  it('starts as a single build button on a phone and opens the icon row when tapped', () => {
    mount('phone', [], false);
    expect(screen.getByTestId('build-fab').getAttribute('aria-label')).toBe('Build tools');
    expect(screen.queryByTestId('toolbar')).toBeNull();
    fireEvent.click(screen.getByTestId('build-fab'));
    expect(screen.getByTestId('toolbar')).toBeTruthy();
    expect(screen.queryByTestId('build-fab')).toBeNull();
  });

  it('is always open on a desktop, with no build button', () => {
    mount('desktop');
    expect(screen.getByTestId('toolbar')).toBeTruthy();
    expect(screen.queryByTestId('build-fab')).toBeNull();
  });

  it('folds back into the button after 4 idle seconds, and a tap on the bar restarts the wait', () => {
    vi.useFakeTimers();
    mount('phone');
    act(() => { vi.advanceTimersByTime(3000); });
    fireEvent.pointerDown(screen.getByTestId('toolbar'));
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByTestId('toolbar')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1100); });
    expect(screen.queryByTestId('toolbar')).toBeNull();
    expect(screen.getByTestId('build-fab')).toBeTruthy();
  });

  it('stays open while a tool is active, and starts the idle wait once it is cancelled', () => {
    vi.useFakeTimers();
    const { rt } = mount('phone');
    fireEvent.click(screen.getByTestId('tool-road'));
    act(() => { vi.advanceTimersByTime(30000); });
    expect(screen.getByTestId('toolbar')).toBeTruthy();
    act(() => { rt.controller.cancel(); });
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByTestId('toolbar')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1500); });
    expect(screen.queryByTestId('toolbar')).toBeNull();
  });

  it('does not fold on its own when auto-collapse is off', () => {
    vi.useFakeTimers();
    mount('phone', [], true, { autoCollapse: false });
    act(() => { vi.advanceTimersByTime(60000); });
    expect(screen.getByTestId('toolbar')).toBeTruthy();
  });

  it('folds on a tap outside every panel, but not on a tap inside the bar', () => {
    mount('phone');
    fireEvent.pointerDown(screen.getByTestId('tool-road'));
    expect(screen.getByTestId('toolbar')).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId('toolbar')).toBeNull();
  });

  it('keeps the bar open on an outside tap while a tool is active (the tap draws)', () => {
    mount('phone');
    fireEvent.click(screen.getByTestId('tool-zone'));
    fireEvent.pointerDown(document.body);
    expect(screen.getByTestId('toolbar')).toBeTruthy();
  });

  it('opens by itself when a tool is picked from elsewhere (the checklist button)', () => {
    const { rt } = mount('phone', [], false);
    act(() => { rt.controller.select({ tool: 'service', arch: 1 }); });
    expect(screen.getByTestId('toolbar')).toBeTruthy();
    expect(screen.getByTestId('optstrip')).toBeTruthy();
  });

  it('folds an idle bar away when another panel opens, but not for its own Views popover', () => {
    const { rerender, rt, view } = mount('phone', [], true, { panel: null });
    rerender(<Tools runtime={rt} view={view} layout="phone" panel="views" />);
    expect(screen.getByTestId('toolbar')).toBeTruthy();
    rerender(<Tools runtime={rt} view={view} layout="phone" panel="menu" />);
    expect(screen.queryByTestId('toolbar')).toBeNull();
  });

  it('closes the Views popover on Escape and on a swipe down, through the shared panel state', () => {
    const onPanel = vi.fn();
    mount('phone', [], true, { panel: 'views', onPanel });
    fireEvent.pointerDown(screen.getByTestId('views-pop'), { clientX: 100, clientY: 100 });
    fireEvent.pointerUp(screen.getByTestId('views-pop'), { clientX: 104, clientY: 220 });
    expect(onPanel).toHaveBeenCalledWith(null);
  });
});

describe('first-use tool hints', () => {
  it('shows one line the first time a tool is picked, marks it seen, and hides it after a few seconds', () => {
    vi.useFakeTimers();
    const { marked } = mount('phone');
    fireEvent.click(screen.getByTestId('tool-road'));
    expect(screen.getByTestId('tool-hint').textContent).toMatch(/Drag to draw a road/);
    expect(marked).toEqual(['road']);
    act(() => { vi.advanceTimersByTime(5100); });
    expect(screen.queryByTestId('tool-hint')).toBeNull();
  });

  it('stays quiet for a tool whose hint was already seen', () => {
    mount('phone', ['road']);
    fireEvent.click(screen.getByTestId('tool-road'));
    expect(screen.queryByTestId('tool-hint')).toBeNull();
  });

  it('drops the hint when the tool is cancelled', () => {
    mount('phone');
    fireEvent.click(screen.getByTestId('tool-zone'));
    expect(screen.getByTestId('tool-hint')).toBeTruthy();
    fireEvent.click(screen.getByTestId('cancel-tool'));
    expect(screen.queryByTestId('tool-hint')).toBeNull();
  });
});
