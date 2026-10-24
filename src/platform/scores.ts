import type { PlatformDb } from './db.ts';

// Personal bests for scenarios and daily/weekly challenges, kept locally in the `settings` store of the platform database (one row per
// id under the key `score:<id>`). Nothing leaves the device. A scenario's id is its slug ("first-light"); a challenge's is "daily-20261024".

export interface ScoreRecord {
  stars: number;
  score: number;
  /** Epoch ms of the run that set the record. */
  at: number;
  /** Runs finished (won or failed) under this id. */
  plays: number;
}

const PREFIX = 'score:';
export const scoreKey = (id: string): string => `${PREFIX}${id}`;

export const isScoreRecord = (v: unknown): v is ScoreRecord => {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return Number.isFinite(r.stars) && Number.isFinite(r.score) && Number.isFinite(r.at) && Number.isFinite(r.plays);
};

/** Every stored record by id. An unavailable store reads as empty. */
export async function loadScores(db: PlatformDb | undefined): Promise<Record<string, ScoreRecord>> {
  const out: Record<string, ScoreRecord> = {};
  if (!db) return out;
  const r = await db.allSettings();
  if (!r.ok) return out;
  for (const [key, value] of Object.entries(r.value)) if (key.startsWith(PREFIX) && isScoreRecord(value)) out[key.slice(PREFIX.length)] = value;
  return out;
}

export interface ScoreUpdate { record: ScoreRecord; improved: boolean; saved: boolean }

/** A result beats a record on score, then stars. */
export const beats = (score: number, stars: number, old: ScoreRecord | undefined): boolean =>
  old === undefined || score > old.score || (score === old.score && stars > old.stars);

/**
 * Fold one finished run into the stored record: the plays count always rises, the stars and score only when the run beats the best.
 * `saved` is false when the store is unavailable; the returned record is still what the screen should show.
 */
export async function recordScore(db: PlatformDb | undefined, id: string, result: { stars: number; score: number }, now: number, known?: ScoreRecord): Promise<ScoreUpdate> {
  let old = known;
  if (db && !old) {
    const r = await db.getSetting(scoreKey(id));
    if (r.ok && isScoreRecord(r.value)) old = r.value;
  }
  const improved = beats(result.score, result.stars, old);
  const record: ScoreRecord = improved ? { stars: result.stars, score: result.score, at: now, plays: (old?.plays ?? 0) + 1 } : { ...old!, plays: old!.plays + 1 };
  const saved = db ? (await db.setSetting(scoreKey(id), record)).ok : false;
  return { record, improved, saved };
}
