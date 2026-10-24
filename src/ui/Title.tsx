import { useRef, useState } from 'react';
import type { SlotMeta } from '../platform/db.ts';
import { isOldVersion } from '../platform/save.ts';
import type { ScoreRecord } from '../platform/scores.ts';
import type { ScenarioChoice } from '../sim/scenarios.ts';
import { Challenges, Scenarios } from './Scenarios';

interface Props {
  worker: 'loading' | 'ready' | 'failed';
  tick: number;
  slots: SlotMeta[];
  storageOk: boolean;
  message: string;
  onNew(name: string, seed: number | undefined): void;
  onLoad(id: string): void;
  onDelete(id: string): void;
  onImport(file: File): void;
  /** Personal bests by scenario slug or challenge id (platform/scores.ts). */
  scores?: Readonly<Record<string, ScoreRecord>>;
  /** Start a scenario or a daily/weekly challenge. */
  onScenario?(choice: ScenarioChoice): void;
  /** The clock the daily and weekly challenges read; tests pass a fixed one. */
  now?(): Date;
}

const NO_SCORES: Readonly<Record<string, ScoreRecord>> = {};

const when = (t: number): string => new Date(t).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
const kb = (n: number): string => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function Title({ worker, tick, slots, storageOk, message, onNew, onLoad, onDelete, onImport, scores = NO_SCORES, onScenario, now }: Props) {
  const [screen, setScreen] = useState<'main' | 'scenarios' | 'challenges'>('main');
  const [form, setForm] = useState(false);
  const [list, setList] = useState(false);
  const [name, setName] = useState('');
  const [seed, setSeed] = useState('');
  const [confirm, setConfirm] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const down = worker === 'failed';
  const seedValue = seed.trim() === '' ? undefined : Number(seed);
  const seedBad = seedValue !== undefined && !Number.isInteger(seedValue);
  const latest = slots.find((s) => !isOldVersion(s.protocol));

  return (
    <main className="title">
      <h1>Iron Dominion</h1>
      <p>Robots build your city.</p>

      {screen === 'scenarios' && <Scenarios scores={scores} disabled={down} onPlay={(c) => onScenario?.(c)} onBack={() => setScreen('main')} />}
      {screen === 'challenges' && <Challenges scores={scores} disabled={down} now={now} onPlay={(c) => onScenario?.(c)} onBack={() => setScreen('main')} />}

      {screen === 'main' && !form && (
        <div className="title-actions">
          <button className="primary" type="button" disabled={down} onClick={() => { setForm(true); setList(false); }}>New city</button>
          <button className="primary" type="button" disabled={down} onClick={() => { setScreen('scenarios'); setList(false); }}>Scenarios</button>
          <button className="primary" type="button" disabled={down} onClick={() => { setScreen('challenges'); setList(false); }}>Daily / Weekly</button>
          <button className="primary" type="button" disabled={down || latest === undefined} onClick={() => onLoad(latest!.id)}>Continue</button>
          <button className="primary" type="button" disabled={down || slots.length === 0} aria-expanded={list} onClick={() => setList((v) => !v)}>Load</button>
          <button className="primary" type="button" disabled={down} onClick={() => file.current?.click()}>Import file</button>
          <input ref={file} type="file" accept=".irondominion,application/octet-stream" hidden data-testid="import-input" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onImport(f); }} />
        </div>
      )}

      {screen === 'main' && form && (
        <form className="newcity" onSubmit={(e) => { e.preventDefault(); if (!seedBad) onNew(name, seedValue); }}>
          <label>City name<input value={name} maxLength={40} placeholder="Untitled city" autoFocus onChange={(e) => setName(e.target.value)} /></label>
          <label>Seed (optional)<input value={seed} inputMode="numeric" placeholder="random" aria-invalid={seedBad} onChange={(e) => setSeed(e.target.value)} /></label>
          <div className="title-actions">
            <button className="primary" type="submit" disabled={down || seedBad}>Start</button>
            <button className="primary" type="button" onClick={() => setForm(false)}>Cancel</button>
          </div>
        </form>
      )}

      {screen === 'main' && list && !form && (
        <ul className="slots" aria-label="Saved cities">
          {slots.map((s) => {
            const old = isOldVersion(s.protocol);
            return (
            <li key={s.id} className={old ? 'slot-old' : undefined} data-old={old || undefined}>
              <div className="slot-info">
                <strong>{s.name}{old && <em className="slot-tag"> (old version)</em>}</strong>
                <span>Day {s.day} - Pop {Math.round(s.population).toLocaleString('en-US')} - ${Math.round(s.treasury).toLocaleString('en-US')}</span>
                <span className="dim">{when(s.updated)} - {kb(s.byteSize)}</span>
              </div>
              {confirm === s.id ? (
                <div className="slot-actions">
                  <button type="button" className="primary danger" onClick={() => { setConfirm(null); onDelete(s.id); }}>Delete {s.name}?</button>
                  <button type="button" className="primary" onClick={() => setConfirm(null)}>Keep</button>
                </div>
              ) : (
                <div className="slot-actions">
                  <button type="button" className="primary" disabled={old} title={old ? 'Made by an older version of the game' : undefined} onClick={() => onLoad(s.id)} aria-label={`Load ${s.name}`}>Load</button>
                  <button type="button" className="primary" onClick={() => setConfirm(s.id)} aria-label={`Delete ${s.name}`}>Delete</button>
                </div>
              )}
            </li>
            );
          })}
        </ul>
      )}

      {!storageOk && <p className="notice" role="status">Saving is unavailable in this browser. You can still play.</p>}
      {message && <p className="notice" role="alert" data-testid="title-message">{message}</p>}
      <p className="status" data-worker={worker} data-tick={tick}>Engine: {worker}{worker === 'ready' ? ` (tick ${tick})` : ''}</p>
    </main>
  );
}
