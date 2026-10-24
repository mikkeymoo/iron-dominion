import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARCH } from '../sim/catalog.ts';
import { HAZ } from '../sim/layers.ts';
import type { HazardStats } from '../sim/protocol.ts';
import { ForecastUi } from './Forecast';
import { chipLabel, clockText, daylightLine, forecastLine, helpFor, rebuildLabel, unprepared } from './forecastCopy';
import { hazardToast } from './toolsStore.ts';

afterEach(cleanup);

const calm: HazardStats = {
  yearPos: 3.4, season: 0, daylight: 0.5, climate: 1, level: 1, mode: 2, forecast: null,
  kit: { rods: 0, batteries: 0, dampers: 0, domes: 0, charge: 0 }, ruins: 0, queued: 0, rebuildCost: 0,
};
const storm = (over: Partial<NonNullable<HazardStats['forecast']>> = {}): HazardStats => ({
  ...calm,
  forecast: { kind: HAZ.STORM, level: 1, active: false, startTick: 9000, startsIn: 4800, endsIn: 9600, lead: 4800, bonus: 0, prep: { applicable: true, ready: false, coverage: 0.2 }, ...over },
});

const mount = (hazards: HazardStats | undefined, extra: Partial<Parameters<typeof ForecastUi>[0]> = {}) => {
  const props = { onBuild: vi.fn(), onRebuildAll: vi.fn() };
  render(<ForecastUi hazards={hazards} tier={0} treasury={50000} {...props} {...extra} />);
  return props;
};

describe('forecast copy', () => {
  it('names the coming hazard and when', () => {
    expect(forecastLine({ kind: HAZ.STORM, active: false, startsIn: 4800 })).toBe('Storm season in 1 month');
    expect(forecastLine({ kind: HAZ.HEATWAVE, active: false, startsIn: 9600 })).toBe('Heatwave in 2 months');
    expect(forecastLine({ kind: HAZ.COLD_SNAP, active: false, startsIn: 600 })).toBe('Cold snap soon');
    expect(forecastLine({ kind: HAZ.METEOR_SHOWER, active: true, startsIn: 0 })).toBe('Meteor shower now');
    expect(chipLabel(calm)).toBe('Spring');
    expect(chipLabel(storm())).toBe('Storm season in 1 month');
  });

  it('writes the clock and the day length', () => {
    expect(clockText(0.25)).toBe('06:00');
    expect(clockText(0.5)).toBe('12:00');
    expect(daylightLine(0.5)).toBe('Sunrise 06:00, sunset 18:00');
    expect(daylightLine(0.4)).toBe('Sunrise 07:12, sunset 16:48');
  });

  it('knows when the city is unprepared and what helps', () => {
    expect(unprepared(calm)).toBe(false);
    expect(unprepared(storm())).toBe(true);
    expect(unprepared(storm({ prep: { applicable: true, ready: true, coverage: 1 } }))).toBe(false);
    expect(unprepared(storm({ prep: { applicable: false, ready: false, coverage: 0 } }))).toBe(false);
    const h = helpFor(storm().forecast!, 0)!;
    expect(h.arch).toBe(ARCH.LIGHTNING_ROD);
    expect(h.cost).toBe(600);
    expect(h.locked).toBe(false);
    expect(h.status).toBe('Not ready: 20% covered.');
    const dome = helpFor({ ...storm().forecast!, kind: HAZ.METEOR_SHOWER }, 2)!;
    expect(dome.arch).toBe(ARCH.SHIELD_DOME);
    expect(dome.locked).toBe(true);
    expect(rebuildLabel({ ruins: 3, queued: 0, rebuildCost: 1200 })).toBe('Rebuild all: 3 ruins, $1,200 (25% off)');
  });

  it('words the toasts', () => {
    expect(hazardToast({ type: 'forecast', tick: 100, kind: HAZ.STORM, startTick: 4900, level: 1 })).toEqual({ text: 'Forecast: Storm season in 1 month. Lightning Rods help.', tone: 'hint' });
    expect(hazardToast({ type: 'hazardStart', tick: 1, kind: HAZ.STORM, level: 1, prepared: true, applicable: true, coverage: 1, bonus: 2000 })).toEqual({ text: 'Ready for the storm: +$2,000', tone: 'good' });
    expect(hazardToast({ type: 'hazardStart', tick: 1, kind: HAZ.STORM, level: 1, prepared: false, applicable: true, coverage: 0, bonus: 0 })).toEqual({ text: 'Storm season has begun.' });
    expect(hazardToast({ type: 'hazardBlocked', tick: 1, by: 'dome', x: 1, y: 1 })?.text).toBe('The shield dome stopped a meteor.');
    expect(hazardToast({ type: 'rebuildAll', tick: 1, count: 1, cost: 113 })?.text).toBe('Rebuild all: 1 ruin ordered rebuilt for $113.');
  });
});

describe('ForecastUi', () => {
  it('renders nothing before the first stats', () => {
    mount(undefined);
    expect(screen.queryByTestId('forecast-chip')).toBeNull();
  });

  it('shows the season on the chip when nothing is forecast', () => {
    mount(calm);
    const chip = screen.getByTestId('forecast-chip');
    expect(chip.getAttribute('data-ready')).toBe('none');
    expect(screen.getByTestId('forecast-text').textContent).toBe('Spring');
  });

  it('shows the countdown, flags an unprepared city, and opens a card with what helps', () => {
    const { onBuild } = mount(storm());
    const chip = screen.getByTestId('forecast-chip');
    expect(screen.getByTestId('forecast-text').textContent).toBe('Storm season in 1 month');
    expect(chip.getAttribute('data-ready')).toBe('no');
    expect(chip.className).toContain('alert');
    expect(screen.queryByTestId('forecast-card')).toBeNull();
    fireEvent.click(chip);
    expect(screen.getByTestId('forecast-card')).toBeTruthy();
    expect(screen.getByTestId('forecast-season').textContent).toContain('Spring');
    expect(screen.getByTestId('forecast-hazard').getAttribute('data-kind')).toBe(String(HAZ.STORM));
    expect(screen.getByTestId('forecast-help').textContent).toContain('Lightning Rod');
    expect(screen.getByTestId('forecast-status').textContent).toBe('Not ready: 20% covered.');
    fireEvent.click(screen.getByTestId('forecast-build'));
    expect(onBuild).toHaveBeenCalledWith(ARCH.LIGHTNING_ROD);
    expect(screen.queryByTestId('forecast-card')).toBeNull();
  });

  it('turns calm once the city is ready, and says so on the card', () => {
    mount(storm({ prep: { applicable: true, ready: true, coverage: 0.9 } }));
    const chip = screen.getByTestId('forecast-chip');
    expect(chip.getAttribute('data-ready')).toBe('yes');
    expect(chip.className).not.toContain('alert');
    fireEvent.click(chip);
    expect(screen.getByTestId('forecast-status').textContent).toBe('Ready: 90% covered.');
  });

  it('lists the ruins and sends Rebuild all, disabled when the money is short', () => {
    const ruined = { ...calm, ruins: 4, rebuildCost: 900 };
    const { onRebuildAll } = mount(ruined);
    expect(screen.getByTestId('forecast-ruins').textContent).toBe('4');
    fireEvent.click(screen.getByTestId('forecast-chip'));
    expect(screen.getByTestId('forecast-recovery').textContent).toContain('Rebuild all: 4 ruins, $900 (25% off)');
    fireEvent.click(screen.getByTestId('forecast-rebuild'));
    expect(onRebuildAll).toHaveBeenCalledTimes(1);
    cleanup();
    mount(ruined, { treasury: 100 });
    fireEvent.click(screen.getByTestId('forecast-chip'));
    expect((screen.getByTestId('forecast-rebuild') as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables Build on a defence the city has not unlocked yet', () => {
    mount({ ...storm(), forecast: { ...storm().forecast!, kind: HAZ.METEOR_SHOWER } });
    fireEvent.click(screen.getByTestId('forecast-chip'));
    expect((screen.getByTestId('forecast-build') as HTMLButtonElement).disabled).toBe(true);
  });
});
