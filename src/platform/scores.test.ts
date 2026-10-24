import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { createPlatformDb, openIdbAdapter } from './db.ts';
import { DEFAULT_SETTINGS, loadSettings } from './settings.ts';
import { beats, isScoreRecord, loadScores, recordScore, scoreKey } from './scores.ts';

const fresh = async () => createPlatformDb(await openIdbAdapter(new IDBFactory()));

describe('personal bests', () => {
  it('stores a first result under score:<id> in the settings store', async () => {
    const db = await fresh();
    const out = await recordScore(db, 'first-light', { stars: 2, score: 2150 }, 100);
    expect(out).toEqual({ improved: true, saved: true, record: { stars: 2, score: 2150, at: 100, plays: 1 } });
    expect(await db.getSetting(scoreKey('first-light'))).toEqual({ ok: true, value: { stars: 2, score: 2150, at: 100, plays: 1 } });
    expect(await loadScores(db)).toEqual({ 'first-light': { stars: 2, score: 2150, at: 100, plays: 1 } });
  });

  it('keeps the best run, counts every run, and survives a reopen', async () => {
    const factory = new IDBFactory();
    const db = createPlatformDb(await openIdbAdapter(factory));
    await recordScore(db, 'daily-20261024', { stars: 2, score: 2100 }, 1);
    const worse = await recordScore(db, 'daily-20261024', { stars: 1, score: 1050 }, 2);
    expect(worse).toMatchObject({ improved: false, record: { stars: 2, score: 2100, at: 1, plays: 2 } });
    const better = await recordScore(db, 'daily-20261024', { stars: 3, score: 3040 }, 3);
    expect(better).toMatchObject({ improved: true, record: { stars: 3, score: 3040, at: 3, plays: 3 } });
    db.close();
    const again = createPlatformDb(await openIdbAdapter(factory));
    expect((await loadScores(again))['daily-20261024']).toMatchObject({ stars: 3, score: 3040, plays: 3 });
  });

  it('keeps each id apart and leaves ordinary settings alone', async () => {
    const db = await fresh();
    await recordScore(db, 'gridlock', { stars: 1, score: 1010 }, 1);
    await recordScore(db, 'weekly-202643', { stars: 3, score: 3000 }, 1);
    await db.setSetting('disasters', 'normal');
    expect(Object.keys(await loadScores(db)).sort()).toEqual(['gridlock', 'weekly-202643']);
    const settings = await loadSettings(db, undefined);
    expect(settings).toEqual({ ...DEFAULT_SETTINGS, disasters: 'normal' });
  });

  it('records a failed run as zero stars without beating a stored win', async () => {
    const db = await fresh();
    await recordScore(db, 'dry-spell', { stars: 0, score: 0 }, 1);
    expect(await recordScore(db, 'dry-spell', { stars: 1, score: 1040 }, 2)).toMatchObject({ improved: true, record: { stars: 1, plays: 2 } });
    expect(await recordScore(db, 'dry-spell', { stars: 0, score: 0 }, 3)).toMatchObject({ improved: false, record: { stars: 1, score: 1040, plays: 3 } });
  });

  it('ignores damaged rows', async () => {
    const db = await fresh();
    await db.setSetting(scoreKey('bad'), { stars: 'x' });
    await db.setSetting(scoreKey('good'), { stars: 1, score: 1000, at: 1, plays: 1 });
    expect(Object.keys(await loadScores(db))).toEqual(['good']);
    expect(isScoreRecord(null)).toBe(false);
    expect(isScoreRecord({ stars: 1, score: 2, at: 3 })).toBe(false);
  });

  it('works without a store: the result is still returned, flagged as not saved', async () => {
    expect(await loadScores(undefined)).toEqual({});
    const out = await recordScore(undefined, 'x', { stars: 2, score: 2000 }, 5, { stars: 1, score: 1000, at: 1, plays: 4 });
    expect(out).toEqual({ improved: true, saved: false, record: { stars: 2, score: 2000, at: 5, plays: 5 } });
  });

  it('beats on score, then on stars', () => {
    const old = { stars: 2, score: 2100, at: 1, plays: 1 };
    expect(beats(2101, 2, old)).toBe(true);
    expect(beats(2100, 2, old)).toBe(false);
    expect(beats(2100, 3, old)).toBe(true);
    expect(beats(0, 0, undefined)).toBe(true);
  });
});
