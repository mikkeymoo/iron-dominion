import { useState } from 'react';
import type { ScoreRecord } from '../platform/scores.ts';
import {
  TABS, TAB_NAMES, challengeId, challengeSpec, keyLabel, keyOf, modNames, scenariosIn, type ChallengeKind, type ScenarioChoice, type ScenarioSpec,
} from '../sim/scenarios.ts';
import { Panel } from './Panel';
import { goalLine, monthsText, starsText } from './scenarioText.ts';
import './scenario.css';

type Scores = Readonly<Record<string, ScoreRecord>>;

interface ScenariosProps {
  scores: Scores;
  disabled?: boolean;
  onPlay(choice: ScenarioChoice): void;
  onBack(): void;
}

function Mods({ mask }: { mask: number }) {
  const names = modNames(mask);
  if (names.length === 0) return null;
  return <ul className="scn-mods" aria-label="Modifiers">{names.map((n) => <li key={n}>{n}</li>)}</ul>;
}

/** The Scenarios screen of the title: three tabs of cards with the stars earned, the goal, the modifiers and a Play button. */
export function Scenarios({ scores, disabled = false, onPlay, onBack }: ScenariosProps) {
  const [tab, setTab] = useState<(typeof TABS)[number]>('beginner');
  return (
    <Panel id="scenarios" title="Scenarios" kind="card" remember={false} className="scn" testId="scenarios-panel" panelAttr="scenarios" onClose={onBack} closeText="Back" escape="close">
      <div className="scn-tabs" role="tablist" aria-label="Difficulty">
        {TABS.map((t) => (
          <button key={t} type="button" role="tab" id={`scn-tab-${t}`} aria-selected={tab === t} aria-controls="scn-cards" className="tb" data-testid={`scn-tab-${t}`} onClick={() => setTab(t)}>{TAB_NAMES[t]}</button>
        ))}
      </div>
      <ul className="scn-cards" id="scn-cards" role="tabpanel" aria-labelledby={`scn-tab-${tab}`}>
        {scenariosIn(tab).map((s) => {
          const best = scores[s.slug];
          return (
            <li key={s.slug} className="scn-card" data-testid={`scn-${s.slug}`}>
              <div className="scn-head">
                <h3>{s.name}</h3>
                <span className="scn-stars" data-stars={best?.stars ?? 0} role="img" aria-label={`${best?.stars ?? 0} of 3 stars earned`}>{starsText(best?.stars ?? 0)}</span>
              </div>
              <p>{s.blurb}</p>
              <p className="dim">{goalLine(s.goal, s.t)}. {monthsText(s.months)}.</p>
              <Mods mask={s.mods} />
              <button type="button" className="primary" disabled={disabled} aria-label={`Play ${s.name}`} data-testid={`scn-play-${s.slug}`} onClick={() => onPlay({ id: s.id })}>Play</button>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

interface ChallengesProps {
  scores: Scores;
  disabled?: boolean;
  /** The clock; tests pass a fixed one. */
  now?(): Date;
  onPlay(choice: ScenarioChoice): void;
  onBack(): void;
}

const KINDS: readonly ChallengeKind[] = ['daily', 'weekly'];

function ChallengeCard({ kind, spec, best, disabled, onPlay }: { kind: ChallengeKind; spec: ScenarioSpec; best?: ScoreRecord; disabled: boolean; onPlay(): void }) {
  const label = kind === 'daily' ? 'Daily' : 'Weekly';
  return (
    <li className="scn-card" data-testid={`challenge-${kind}`}>
      <div className="scn-head">
        <h3>{label} challenge</h3>
        <span className="dim">{keyLabel(kind, spec.key)}</span>
      </div>
      <p>{goalLine(spec.goal, spec.t)}. {monthsText(spec.months)}.</p>
      <Mods mask={spec.mods} />
      <p className="scn-best" data-testid={`challenge-best-${kind}`}>
        {best ? <>Best: {starsText(best.stars)} - {best.score.toLocaleString('en-US')} points ({best.plays} {best.plays === 1 ? 'run' : 'runs'})</> : 'No best yet'}
      </p>
      <button type="button" className="primary" disabled={disabled} aria-label={`Play ${label.toLowerCase()} challenge`} data-testid={`challenge-play-${kind}`} onClick={onPlay}>Play</button>
    </li>
  );
}

/** Today's daily and this week's challenge: a fixed map, two or three modifiers and a short goal, the same for everyone on that UTC date. */
export function Challenges({ scores, disabled = false, now = () => new Date(), onPlay, onBack }: ChallengesProps) {
  const today = now();
  return (
    <Panel id="challenges" title="Daily / Weekly" kind="card" remember={false} className="scn" testId="challenges-panel" panelAttr="challenges" onClose={onBack} closeText="Back" escape="close">
      <ul className="scn-cards">
        {KINDS.map((kind) => {
          const key = keyOf(kind, today);
          return <ChallengeCard key={kind} kind={kind} spec={challengeSpec(kind, key)} best={scores[challengeId(kind, key)]} disabled={disabled} onPlay={() => onPlay({ id: challengeSpec(kind, key).id, key })} />;
        })}
      </ul>
      <p className="hint">Both reset by the UTC date. Your best scores stay on this device.</p>
    </Panel>
  );
}
