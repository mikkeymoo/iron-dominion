import { useEffect, useRef, useState } from 'react';
import type { SimClient } from '../sim/client.ts';
import { DIRECTIVES, DIRECTIVE_COUNT } from '../sim/directives.ts';
import type { DirectiveStats } from '../sim/protocol.ts';
import type { Settings } from '../platform/settings.ts';
import type { RenderMirror } from '../render/mirror.ts';
import { copyOf } from './directiveCopy.ts';
import { PLAIN_TOOL, findGrown, suggestSpot } from './directiveSpots.ts';
import type { ToolsRuntime } from './toolsStore.ts';

type Onboarding = Settings['onboarding'];

interface Props {
  stats: DirectiveStats;
  population: number;
  treasury: number;
  /** Dismissed and collapsed, persisted by the settings store (phones fold it to the chip until the player opens it). */
  state: Onboarding;
  onChange(next: Onboarding): void;
  client: SimClient;
  tools: ToolsRuntime;
  mirror: RenderMirror;
  /** Fly the camera to a tile. */
  glide(x: number, y: number): void;
  /** Open the Projects panel (the last directive points there). */
  onProjects(): void;
  /** A tool is about to be picked: close any floating panel. */
  onPick(): void;
  /** Phones fold the card away after "Show me", so the map stays visible. */
  collapseOnShow?: boolean;
}

/** How long the finished card stays before it dismisses itself. */
const DONE_MS = 5000;

const bitsSet = (mask: number): number => { let n = 0; for (let i = 0; i < DIRECTIVE_COUNT; i++) if (mask & (1 << i)) n++; return n; };
const usd = (n: number): string => `$${n.toLocaleString('en-US')}`;

/** UNIT-0's face: a hard-hatted bot that bobs and blinks (the motion stops under reduced motion). */
function Foreman() {
  return (
    <svg className="foreman" viewBox="0 0 40 40" width="40" height="40" aria-hidden="true" focusable="false">
      <line x1="20" y1="3" x2="20" y2="8" stroke="#9fb3c8" strokeWidth="2" strokeLinecap="round" />
      <circle cx="20" cy="3" r="2.2" fill="#ffb347" />
      <path d="M7 17c0-7 5.8-11 13-11s13 4 13 11z" fill="#ffb347" stroke="#c97a10" strokeWidth="1.5" />
      <rect x="4" y="16" width="32" height="3.5" rx="1.7" fill="#e8962a" />
      <rect x="7" y="19" width="26" height="15" rx="5" fill="#cfd8e3" stroke="#7f93a8" strokeWidth="1.5" />
      <rect x="10" y="22" width="20" height="7.5" rx="3.5" fill="#12202c" />
      <circle className="eye" cx="15.5" cy="25.7" r="2" fill="#6fe3ff" />
      <circle className="eye" cx="24.5" cy="25.7" r="2" fill="#6fe3ff" />
      <path d="M16 31.6c2.4 1.4 5.6 1.4 8 0" stroke="#7f93a8" strokeWidth="1.4" fill="none" strokeLinecap="round" />
    </svg>
  );
}

/**
 * UNIT-0, the foreman bot, giving one directive at a time (the new-city tutorial). Progress comes from the sim's Stats, rewards are
 * paid by the claimDirective command, and "Show me" flies the camera to a suggested spot with the right tool and ghost selected.
 */
export function DirectiveCard({ stats, population, treasury, state, onChange, client, tools, mirror, glide, onProjects, onPick, collapseOnShow = false }: Props) {
  const claimed = bitsSet(stats.claimed);
  let cur = -1;
  for (let i = 0; i < DIRECTIVE_COUNT; i++) if (!(stats.claimed & (1 << i))) { cur = i; break; }
  const all = cur < 0;
  const def = all ? undefined : DIRECTIVES[cur];
  const copy = def ? copyOf(def.id) : undefined;
  const have = all ? 0 : stats.have[cur] ?? 0;
  const met = !all && ((stats.done & (1 << cur)) !== 0 || have >= def!.need);

  const latest = useRef({ state, onChange });
  latest.current = { state, onChange };
  const sawIncomplete = useRef(false);
  if (!all) sawIncomplete.current = true;
  useEffect(() => {
    if (!all || !sawIncomplete.current || state.dismissed) return;
    const t = window.setTimeout(() => latest.current.onChange({ ...latest.current.state, dismissed: true }), DONE_MS);
    return () => window.clearTimeout(t);
  }, [all, state.dismissed]);

  const [claiming, setClaiming] = useState(-1);
  useEffect(() => { setClaiming(-1); }, [stats.claimed]);

  // The first home going up is the moment the game is about: nudge the camera to it once.
  const nudged = useRef(false);
  const glideRef = useRef(glide);
  glideRef.current = glide;
  const firstHome = def?.id === 'firstHome';
  useEffect(() => {
    if (!firstHome || nudged.current || state.dismissed) return;
    const site = findGrown(mirror.layers, 1);
    if (!site) return;
    nudged.current = true;
    glideRef.current(Math.floor(site.x + site.w / 2), Math.floor(site.y + site.h / 2));
  }, [firstHome, stats.have, mirror, state.dismissed]);

  if (state.dismissed) return null;

  const show = (): void => {
    if (!def) return;
    const spot = suggestSpot(def.id, mirror.layers, mirror.scalars);
    onPick();
    if (spot?.projects) { onProjects(); return; }
    const sel = spot?.sel ?? PLAIN_TOOL[def.id];
    if (sel) {
      tools.controller.select(sel);
      if (spot?.ghost) tools.controller.move(spot.ghost);
    }
    if (spot) glide(spot.x, spot.y);
    if (collapseOnShow) onChange({ ...state, collapsed: true });
  };
  const claim = (): void => {
    if (!def || claiming === cur) return;
    setClaiming(cur);
    client.command({ type: 'claimDirective', index: cur });
  };

  if (state.collapsed) {
    return (
      <button
        type="button" className={`directive-chip${met ? ' ready' : ''}`} data-panel="directive" data-testid="directive-chip"
        aria-label={all ? 'UNIT-0, all directives done. Tap to open.' : `UNIT-0, directive ${claimed + 1} of ${DIRECTIVE_COUNT}${met ? ', ready to claim' : ''}. Tap to open.`}
        onClick={() => onChange({ ...state, collapsed: false })}
      >
        <Foreman />
        <span>{all ? 'UNIT-0 done' : met ? 'UNIT-0 Claim!' : `UNIT-0 ${claimed + 1}/${DIRECTIVE_COUNT}`}</span>
      </button>
    );
  }

  const pct = def ? Math.min(100, Math.round((have / def.need) * 100)) : 100;
  return (
    <section className={`directive${met ? ' ready' : ''}`} data-panel="directive" data-testid="directive-card" data-index={cur} data-done={met} aria-label="UNIT-0 directive">
      <header>
        <Foreman />
        <div className="who">
          <h2>UNIT-0</h2>
          <span className="step" data-testid="directive-step">{all ? 'All directives done' : `Directive ${claimed + 1} of ${DIRECTIVE_COUNT}`}</span>
        </div>
        <button type="button" className="tb icon small" aria-label="Collapse UNIT-0" title="Collapse" data-testid="directive-collapse" onClick={() => onChange({ ...state, collapsed: true })}>–</button>
        <button type="button" className="tb icon small" aria-label="Dismiss UNIT-0" title="Dismiss" data-testid="directive-dismiss" onClick={() => onChange({ ...state, dismissed: true })}>×</button>
      </header>
      {def && copy ? (
        <>
          <p className="say" data-testid="directive-say"><strong>{copy.title}.</strong> {met ? copy.done : copy.say}</p>
          <div className="meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`${copy.title} progress`}><i style={{ width: `${pct}%` }} /></div>
          <p className="progress" data-testid="directive-progress">{copy.progress(have, def.need, { population, treasury })}</p>
          <div className="actions">
            {met ? (
              <button type="button" className="tb step-go claim" data-testid="directive-claim" disabled={claiming === cur} onClick={claim}>Claim {usd(def.reward)}</button>
            ) : (
              <button type="button" className="tb step-go" data-testid="directive-show" aria-label={`Show me: ${copy.title}`} onClick={show}>Show me</button>
            )}
            {!met && <span className="reward" data-testid="directive-reward">Reward {usd(def.reward)}</span>}
          </div>
        </>
      ) : (
        <p className="say" data-testid="directive-say">That is every directive, boss. The city is yours. I will be here if you need me.</p>
      )}
    </section>
  );
}
