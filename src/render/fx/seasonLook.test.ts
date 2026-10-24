import { describe, expect, it } from 'vitest';
import { DayClock, sunDirection } from './skyClock.ts';
import { SEASON_LABELS, SeasonClock, YEAR, parseSeasonParam, scaleSun, seasonIndex, seasonLook, sunTimes, warpDayFrac, wrapYear, yearDelta } from './seasonLook.ts';

describe('seasonLook', () => {
  it('names the four seasons six days apart and wraps the year', () => {
    expect([0, 5.9, 6, 11.9, 12, 17.9, 18, 23.9].map(seasonIndex)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
    expect(seasonLook(15).name).toBe('Autumn');
    expect(seasonLook(24.5).name).toBe('Spring');
    expect(seasonLook(-1).name).toBe('Winter');
    expect(SEASON_LABELS).toHaveLength(4);
    expect(wrapYear(YEAR)).toBe(0);
  });

  it('opens on a green spring: no snow, no bare trees, no autumn colour, neutral ground', () => {
    const l = seasonLook(0);
    expect([l.autumn, l.bare, l.snow, l.dry]).toEqual([0, 0, 0, 0]);
    expect(l.tint).toEqual([1, 1, 1]);
    expect(l.daylight).toBeCloseTo(0.5, 12);
    expect(l.sunScale).toBeCloseTo(1, 12);
  });

  it('turns the leaves in autumn, strips the trees and lays snow in winter, then thaws', () => {
    const autumn = seasonLook(15), winter = seasonLook(20), thaw = seasonLook(23.5);
    expect(autumn.autumn).toBeGreaterThan(0.95);
    expect(autumn.bare).toBe(0);
    expect(winter.bare).toBe(1);
    expect(winter.snow).toBe(1);
    expect(winter.autumn).toBe(0);
    expect(thaw.snow).toBeLessThan(0.3);
    expect(thaw.bare).toBeLessThan(0.3);
    expect(seasonLook(9).snow).toBe(0);
    expect(seasonLook(9).bare).toBe(0);
    expect(seasonLook(9).dry).toBeLessThan(seasonLook(13).dry);
  });

  it('has the longest day in midsummer and the shortest in midwinter', () => {
    const d = (p: number): number => seasonLook(p).daylight;
    expect(d(6)).toBeGreaterThan(0.59);
    expect(d(18)).toBeLessThan(0.41);
    expect(d(6)).toBeGreaterThan(d(0));
    expect(d(0)).toBeGreaterThan(d(18));
    expect(seasonLook(6).sunScale).toBeGreaterThan(seasonLook(18).sunScale);
  });

  it('is continuous around the year, including across its end', () => {
    for (let i = 0; i < 2400; i++) {
      const a = seasonLook(i / 100), b = seasonLook((i + 1) / 100);
      expect(Math.abs(a.daylight - b.daylight)).toBeLessThan(0.01);
      expect(Math.abs(a.autumn - b.autumn)).toBeLessThan(0.08);
      expect(Math.abs(a.bare - b.bare)).toBeLessThan(0.08);
      expect(Math.abs(a.snow - b.snow)).toBeLessThan(0.08);
      expect(Math.abs(a.dry - b.dry)).toBeLessThan(0.08);
      for (let c = 0; c < 3; c++) expect(Math.abs(a.tint[c]! - b.tint[c]!)).toBeLessThan(0.04);
    }
    const end = seasonLook(23.999), start = seasonLook(0);
    expect(end.snow).toBeCloseTo(start.snow, 2);
    expect(end.bare).toBeCloseTo(start.bare, 2);
    expect(end.tint[0]).toBeCloseTo(start.tint[0], 2);
  });

  it('survives garbage input', () => {
    expect(seasonLook(Number.NaN).pos).toBe(0);
    expect(seasonLook(Infinity).pos).toBe(0);
  });
});

describe('day length', () => {
  it('leaves the equinox clock alone', () => {
    for (const f of [0, 0.1, 0.25, 0.4, 0.5, 0.7, 0.75, 0.9]) expect(warpDayFrac(f, 0.5)).toBeCloseTo(f, 12);
  });

  it('puts sunrise and sunset at the season\'s times', () => {
    for (const daylight of [0.4, 0.45, 0.55, 0.6]) {
      const { rise, set } = sunTimes(daylight);
      expect(sunDirection(warpDayFrac(rise, daylight))[1]).toBeCloseTo(0, 6);
      expect(sunDirection(warpDayFrac(set, daylight))[1]).toBeCloseTo(0, 6);
      expect(sunDirection(warpDayFrac(0.5, daylight))[1]).toBeGreaterThan(0.6);
      expect(sunDirection(warpDayFrac(rise + 0.01, daylight))[1]).toBeGreaterThan(0);
      expect(sunDirection(warpDayFrac(rise - 0.01, daylight))[1]).toBeLessThan(0);
      expect(sunDirection(warpDayFrac(0, daylight))[1]).toBeLessThan(0);
    }
  });

  it('is monotonic and continuous over the whole day', () => {
    for (const daylight of [0.4, 0.5, 0.6]) {
      let prev = warpDayFrac(0, daylight);
      let wraps = 0;
      for (let i = 1; i <= 2000; i++) {
        const cur = warpDayFrac(i / 2000, daylight);
        let d = cur - prev;
        if (d < -0.5) { wraps++; d += 1; }
        expect(d).toBeGreaterThanOrEqual(-1e-12);
        expect(d).toBeLessThan(0.01);
        prev = cur;
      }
      expect(wraps).toBe(1);
    }
  });

  it('shortens a winter day and lengthens a summer one', () => {
    const up = (daylight: number): number => { let n = 0; for (let i = 0; i < 1000; i++) if (sunDirection(warpDayFrac(i / 1000, daylight))[1] > 0) n++; return n / 1000; };
    expect(up(0.4)).toBeCloseTo(0.4, 1);
    expect(up(0.6)).toBeCloseTo(0.6, 1);
  });

  it('scales only the day side of the sun and keeps a unit vector', () => {
    const low = scaleSun([0.3, 0.8, 0.5], 0.8), high = scaleSun([0.3, 0.8, 0.5], 1.15);
    expect(low[1]).toBeLessThan(high[1]);
    expect(Math.hypot(...low)).toBeCloseTo(1, 12);
    expect(scaleSun([0.3, -0.5, 0.2], 0.5)[1]).toBeCloseTo(-0.5 / Math.hypot(0.3, -0.5, 0.2), 12);
  });
});

describe('SeasonClock', () => {
  it('takes the short way round the year', () => {
    expect(yearDelta(23, 1)).toBeCloseTo(2, 12);
    expect(yearDelta(1, 23)).toBeCloseTo(-2, 12);
    const c = new SeasonClock(23.5);
    c.step(0.5, 0.2);
    expect(c.value).toBeGreaterThan(23.5);
  });

  it('eases and caps its rate so a fast sim sweeps the year instead of flashing it', () => {
    const c = new SeasonClock(0, 2, 3);
    c.step(10, 1);
    expect(c.value).toBeLessThanOrEqual(2 + 1e-9);
    for (let i = 0; i < 400; i++) c.step(10, 0.1);
    expect(c.value).toBeCloseTo(10, 3);
    c.snap(30);
    expect(c.value).toBeCloseTo(6, 12);
    expect(c.step(1, 0)).toBeCloseTo(6, 12);
  });

  it('chases a day clock the same way (shared shape with DayClock)', () => {
    const d = new DayClock(0.9);
    d.step(0.1, 0.5);
    expect(d.value).toBeGreaterThan(0.9);
  });
});

describe('?season=', () => {
  it('reads names and numbers', () => {
    expect(parseSeasonParam('autumn')).toBe(15);
    expect(parseSeasonParam('FALL')).toBe(15);
    expect(parseSeasonParam('winter')).toBe(20);
    expect(parseSeasonParam('spring')).toBe(3);
    expect(parseSeasonParam('summer')).toBe(9);
    expect(parseSeasonParam('25.5')).toBeCloseTo(1.5, 12);
    expect(parseSeasonParam('monsoon')).toBeNull();
    expect(parseSeasonParam('')).toBeNull();
    expect(parseSeasonParam(null)).toBeNull();
  });
});
