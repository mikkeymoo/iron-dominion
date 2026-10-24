import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARCH } from '../sim/catalog.ts';
import { DEFAULT_SETTINGS } from '../platform/settings.ts';
import { Checklist } from './Checklist';
import { NO_FACTS, type CityFacts } from './progress';

afterEach(() => vi.useRealTimers());

const open = DEFAULT_SETTINGS.onboarding;
const withDepot: CityFacts = { ...NO_FACTS, depots: 1 };
const complete: CityFacts = { depots: 1, depotOnRoad: true, residentialOnRoad: true, workZoneOnRoad: true, powerPlants: 1, powerLines: 3, waterPumps: 1, pipes: 3 };

describe('starter checklist card', () => {
  it('renders six steps, none ticked, with the depot step as the one to do next', () => {
    render(<Checklist facts={NO_FACTS} state={open} onChange={vi.fn()} onPick={vi.fn()} />);
    expect(screen.getByTestId('checklist').textContent).toMatch(/Getting started 0\/6/);
    const steps = screen.getAllByTestId(/^checklist-step-/);
    expect(steps).toHaveLength(6);
    expect(steps.every((s) => s.getAttribute('data-done') === 'false')).toBe(true);
    expect(screen.getByTestId('checklist-step-depot').className).toBe('next');
    expect(screen.getByTestId('checklist-go-depot')).toBeTruthy();
    expect(screen.queryByTestId('checklist-go-road')).toBeNull();
  });

  it('ticks step 1 from the mirror state and moves the action to step 2', () => {
    const { rerender } = render(<Checklist facts={NO_FACTS} state={open} onChange={vi.fn()} onPick={vi.fn()} />);
    rerender(<Checklist facts={withDepot} state={open} onChange={vi.fn()} onPick={vi.fn()} />);
    expect(screen.getByTestId('checklist-step-depot').getAttribute('data-done')).toBe('true');
    expect(screen.getByTestId('checklist').textContent).toMatch(/Getting started 1\/6/);
    expect(screen.queryByTestId('checklist-go-depot')).toBeNull();
    expect(screen.getByTestId('checklist-go-road')).toBeTruthy();
  });

  it('jumps to Services > Depot from step 1', () => {
    const onPick = vi.fn();
    render(<Checklist facts={NO_FACTS} state={open} onChange={vi.fn()} onPick={onPick} />);
    fireEvent.click(screen.getByTestId('checklist-go-depot'));
    expect(onPick).toHaveBeenCalledWith({ tool: 'service', arch: ARCH.DEPOT });
  });

  it('folds itself away after a pick when asked to (phones)', () => {
    const onChange = vi.fn();
    render(<Checklist facts={NO_FACTS} state={open} onChange={onChange} onPick={vi.fn()} collapseOnPick />);
    fireEvent.click(screen.getByTestId('checklist-go-depot'));
    expect(onChange).toHaveBeenCalledWith({ ...open, collapsed: true });
  });

  it('collapses to a progress chip and reopens from it', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Checklist facts={withDepot} state={open} onChange={onChange} onPick={vi.fn()} />);
    fireEvent.click(screen.getByTestId('checklist-collapse'));
    expect(onChange).toHaveBeenLastCalledWith({ ...open, collapsed: true });
    rerender(<Checklist facts={withDepot} state={{ ...open, collapsed: true }} onChange={onChange} onPick={vi.fn()} />);
    expect(screen.queryByTestId('checklist')).toBeNull();
    expect(screen.getByTestId('checklist-chip').textContent).toBe('Getting started 1/6');
    fireEvent.click(screen.getByTestId('checklist-chip'));
    expect(onChange).toHaveBeenLastCalledWith({ ...open, collapsed: false });
  });

  it('dismisses, and renders nothing once dismissed', () => {
    const onChange = vi.fn();
    const { container, rerender } = render(<Checklist facts={NO_FACTS} state={open} onChange={onChange} onPick={vi.fn()} />);
    fireEvent.click(screen.getByTestId('checklist-dismiss'));
    expect(onChange).toHaveBeenLastCalledWith({ ...open, dismissed: true });
    rerender(<Checklist facts={NO_FACTS} state={{ ...open, dismissed: true }} onChange={onChange} onPick={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('dismisses itself a few seconds after the last step ticks', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const { rerender } = render(<Checklist facts={withDepot} state={open} onChange={onChange} onPick={vi.fn()} />);
    rerender(<Checklist facts={complete} state={open} onChange={onChange} onPick={vi.fn()} />);
    expect(screen.getByTestId('checklist').textContent).toMatch(/City is up and running/);
    expect(onChange).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(4100); });
    expect(onChange).toHaveBeenCalledWith({ ...open, dismissed: true });
  });

  it('never shows for a city that was already complete when it loaded, and does not spend the dismissal', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const { container } = render(<Checklist facts={complete} state={open} onChange={onChange} onPick={vi.fn()} />);
    expect(container.firstChild).toBeNull();
    act(() => { vi.advanceTimersByTime(10000); });
    expect(onChange).not.toHaveBeenCalled();
  });
});
