import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARCH } from '../sim/catalog.ts';
import { TERRAIN } from '../sim/layers.ts';
import { allocWorld } from '../sim/world.ts';
import type { ToolWorld } from '../render/tools/controller.ts';
import { ViewState } from '../render/viewState.ts';
import { Tools } from './Tools';
import { ToolsRuntime } from './toolsStore.ts';

afterEach(() => vi.useRealTimers());

function mount() {
  const w = allocWorld();
  w.terrain.fill(TERRAIN.GRASS);
  const world: ToolWorld = { layers: w as unknown as Record<string, ArrayLike<number>>, scalars: w.scalars, tick: 0 };
  const rt = new ToolsRuntime({ world, submit: () => 1 });
  render(<Tools runtime={rt} view={new ViewState()} layout="desktop" />);
  return rt;
}

describe('Plan toggle in the tool options', () => {
  it('shows for buildings the robots can build, flips the controller, and stays off for depots and projects', () => {
    const rt = mount();
    expect(screen.queryByTestId('plan-toggle')).toBeNull();
    act(() => rt.controller.select({ tool: 'service', arch: ARCH.CLINIC }));
    const toggle = screen.getByTestId('plan-toggle');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(rt.controller.planning).toBe(true);
    expect(screen.getByTestId('plan-toggle').getAttribute('aria-pressed')).toBe('true');
    act(() => rt.controller.select({ tool: 'service', arch: ARCH.POWER_PLANT }));
    expect(screen.getByTestId('plan-toggle').getAttribute('aria-pressed')).toBe('true');
    act(() => rt.controller.select({ tool: 'service', arch: ARCH.DEPOT }));
    expect(screen.queryByTestId('plan-toggle')).toBeNull();
    act(() => rt.controller.select({ tool: 'service', arch: ARCH.FUSION_SPIRE }));
    expect(screen.queryByTestId('plan-toggle')).toBeNull();
    act(() => rt.controller.select({ tool: 'road', cls: 1 }));
    expect(screen.queryByTestId('plan-toggle')).toBeNull();
  });
});

describe('blueprint events', () => {
  it('tells the player when the robots start a blueprint and when one is dropped without a charge', () => {
    vi.useFakeTimers();
    const rt = mount();
    act(() => rt.handleEvents([{ type: 'blueprintStarted', tick: 5, arch: ARCH.CLINIC, slot: 3, x: 10, y: 10, cost: 900 }]));
    expect(rt.toasts.map((t) => t.text)).toEqual(['The robots started the clinic: $900 paid.']);
    act(() => rt.handleEvents([{ type: 'blueprintSkipped', tick: 9, arch: ARCH.SCHOOL, x: 20, y: 20, reason: 'blocked' }]));
    const dropped = rt.toasts[1]!.text;
    expect(dropped).toContain('school');
    expect(dropped).toContain('Something is already in the way.');
    expect(dropped).toContain('Nothing was paid.');
  });
});
