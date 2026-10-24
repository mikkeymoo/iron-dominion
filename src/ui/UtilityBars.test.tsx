import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { UtilityBars, coverage, utilityLevel } from './UtilityBars';
import { ViewControls } from './ViewControls';
import { ViewState } from '../render/viewState.ts';
import { fireEvent } from '@testing-library/react';

describe('utility bars', () => {
  it('renders nothing before the city has either network', () => {
    const { container } = render(<UtilityBars power={{ supply: 0, demand: 5 }} water={{ supply: 0, demand: 5 }} unpowered={0} unwatered={0} modelled={{ power: false, water: false }} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows a bar only for a network the city has switched on', () => {
    render(<UtilityBars power={{ supply: 120, demand: 5 }} water={{ supply: 0, demand: 5 }} unpowered={0} unwatered={0} modelled={{ power: true, water: false }} />);
    expect(screen.queryByTestId('util-power')).not.toBeNull();
    expect(screen.queryByTestId('util-water')).toBeNull();
  });

  it('shows supply against demand and goes amber, then red, as the network falls short', () => {
    expect(utilityLevel({ supply: 120, demand: 100 })).toBe('ok');
    expect(utilityLevel({ supply: 60, demand: 100 })).toBe('warn');
    expect(utilityLevel({ supply: 0, demand: 5 })).toBe('bad');
    expect(utilityLevel({ supply: 0, demand: 0 })).toBe('ok');
    expect(coverage({ supply: 60, demand: 100 })).toBe(0.6);
    expect(coverage({ supply: 200, demand: 100 })).toBe(1);
    expect(coverage({ supply: 10, demand: 0 })).toBe(1);
    render(<UtilityBars power={{ supply: 120, demand: 245 }} water={{ supply: 80, demand: 40 }} unpowered={3} unwatered={0} modelled={{ power: true, water: true }} />);
    const power = screen.getByTestId('util-power'), water = screen.getByTestId('util-water');
    expect(power.className).toContain('warn');
    expect(water.className).toContain('ok');
    expect(power.getAttribute('data-supply')).toBe('120');
    expect(power.getAttribute('aria-label')).toMatch(/Power 120 of 245 MW.*3 buildings are without power/);
    expect(screen.getByTestId('util-warn').textContent).toBe('3 without power');
  });

  it('names both outages in the warning', () => {
    render(<UtilityBars power={{ supply: 0, demand: 9 }} water={{ supply: 0, demand: 9 }} unpowered={1} unwatered={2} modelled={{ power: true, water: true }} />);
    expect(screen.getByTestId('util-warn').textContent).toBe('1 without power, 2 without water');
    expect(screen.getByTestId('util-power').className).toContain('bad');
  });
});

describe('view controls', () => {
  it('switches the overlay and toggles the underground view, by button and by U', () => {
    const view = new ViewState();
    render(<ViewControls view={view} />);
    for (const [id, mode] of [['overlay-power', 'power'], ['overlay-water', 'water'], ['overlay-landValue', 'landValue'], ['overlay-pollution', 'pollution'], ['overlay-none', 'none']] as const) {
      fireEvent.click(screen.getByTestId(id));
      expect(view.overlay).toBe(mode);
      expect(screen.getByTestId(id).getAttribute('aria-pressed')).toBe('true');
    }
    fireEvent.click(screen.getByTestId('underground'));
    expect(view.underground).toBe(true);
    expect(screen.getByTestId('underground').getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(window, { key: 'u', repeat: true });
    expect(view.underground, 'a held key repeats without toggling').toBe(true);
    fireEvent.keyDown(window, { key: 'u' });
    expect(view.underground).toBe(false);
    expect(screen.getByTestId('underground').getAttribute('aria-pressed')).toBe('false');
  });
});
