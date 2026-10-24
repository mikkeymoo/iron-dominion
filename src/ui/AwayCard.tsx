import { useEffect, useReducer } from 'react';
import type { SimClient } from '../sim/client.ts';
import { GROUP_NAMES } from '../sim/council/tables.ts';
import { DIRECTIVES, DIRECTIVE_COUNT } from '../sim/directives.ts';
import type { CouncilStats, DirectiveStats, Issue } from '../sim/protocol.ts';
import type { RenderMirror } from '../render/mirror.ts';
import type { AwayStore } from './away.ts';
import { copyOf } from './directiveCopy.ts';
import { PLAIN_TOOL, suggestSpot } from './directiveSpots.ts';
import { Panel } from './Panel';
import { PANEL_ATTR } from './panels';
import type { ToolsRuntime } from './toolsStore.ts';
import type { WhyStore } from './whyStore.ts';
import './away.css';

interface Props {
  away: AwayStore;
  why: WhyStore;
  directives?: DirectiveStats;
  council?: CouncilStats;
  population: number;
  treasury: number;
  client: Pick<SimClient, 'command'>;
  tools: ToolsRuntime;
  mirror: RenderMirror;
  /** Fly the camera to a tile. */
  glide(x: number, y: number): void;
  /** Open the Projects panel (the last directives point there). */
  onProjects(): void;
  /** City-wide money problems open the budget instead of flying anywhere. */
  onBudget(): void;
}

const MAX_PROBLEMS = 3;
const usd = (n: number): string => `$${n.toLocaleString('en-US')}`;

/** The first directive whose reward is not yet paid, or -1 when all are. */
const nextDirective = (d: DirectiveStats): number => {
  for (let i = 0; i < DIRECTIVE_COUNT; i++) if (!(d.claimed & (1 << i))) return i;
  return -1;
};

/**
 * "While you were away": a compact card for a resumed city or a page that was hidden for a while. What happened in the last stretch of play
 * (from the journal), the advisor's current problems, and the next directive and council request, each with a Show me.
 */
export function AwayCard({ away, why, directives, council, population, treasury, client, tools, mirror, glide, onProjects, onBudget }: Props) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => away.subscribe(bump), [away]);
  useEffect(() => why.subscribe(bump), [why]);
  const summary = away.summary;
  if (!summary) return null;

  const problems = why.issues.slice(0, MAX_PROBLEMS);
  const cur = directives ? nextDirective(directives) : -1;
  const def = cur >= 0 ? DIRECTIVES[cur] : undefined;
  const copy = def ? copyOf(def.id) : undefined;
  const met = !!directives && cur >= 0 && ((directives.done & (1 << cur)) !== 0 || (directives.have[cur] ?? 0) >= def!.need);
  const request = council ? [...council.requests].sort((a, b) => a.ticksLeft - b.ticksLeft)[0] : undefined;

  const showProblem = (i: Issue): void => {
    if (i.kind === 'budget') onBudget(); else glide(i.x, i.y);
    why.view.setOverlay(i.overlay);
  };
  const showDirective = (): void => {
    if (!def) return;
    const spot = suggestSpot(def.id, mirror.layers, mirror.scalars);
    if (spot?.projects) { onProjects(); return; }
    const sel = spot?.sel ?? PLAIN_TOOL[def.id];
    if (sel) {
      tools.controller.select(sel);
      if (spot?.ghost) tools.controller.move(spot.ghost);
    }
    if (spot) glide(spot.x, spot.y);
  };

  return (
    <aside className="away" {...{ [PANEL_ATTR]: 'away' }} data-testid="away-card" data-reason={away.reason ?? undefined} aria-label="While you were away">
      <Panel id="away" kind="card" title="While you were away" className="away-panel" remember={false} onClose={() => away.close()} testId="away-panel">
        <h3>Last {summary.minutes} {summary.minutes === 1 ? 'minute' : 'minutes'} of play</h3>
        {summary.lines.length === 0
          ? <p className="hint" data-testid="away-quiet">A quiet stretch: nothing to report.</p>
          : <ul className="away-lines" data-testid="away-lines">{summary.lines.map((l, i) => <li key={`${l.kind}:${i}`} data-kind={l.kind}>{l.text}</li>)}</ul>}

        <h3>Problems now</h3>
        {problems.length === 0
          ? <p className="hint" data-testid="away-clear">No problems right now.</p>
          : (
            <ul className="away-list" data-testid="away-problems">
              {problems.map((i) => (
                <li key={i.id} data-kind={i.kind}>
                  <span>{i.text}</span>
                  <button type="button" className="tb" data-testid="away-problem-show" onClick={() => showProblem(i)}>Show</button>
                </li>
              ))}
            </ul>
          )}

        {(copy || request) && <h3>Next</h3>}
        {(copy || request) && (
          <ul className="away-list" data-testid="away-next">
            {copy && def && (
              <li data-kind="directive">
                <span><strong>{copy.title}.</strong> {met ? 'Ready to claim.' : copy.progress(directives?.have[cur] ?? 0, def.need, { population, treasury })}</span>
                {met
                  ? <button type="button" className="tb" data-testid="away-claim" onClick={() => client.command({ type: 'claimDirective', index: cur })}>Claim {usd(def.reward)}</button>
                  : <button type="button" className="tb" data-testid="away-directive-show" onClick={showDirective}>Show me</button>}
              </li>
            )}
            {request && (
              <li data-kind="request">
                <span><strong>{GROUP_NAMES[request.group] ?? 'Citizens'}:</strong> {request.text}</span>
                <button type="button" className="tb" data-testid="away-request-show" onClick={() => { glide(request.x, request.y); why.view.setOverlay(request.overlay); }}>Show me</button>
              </li>
            )}
          </ul>
        )}
      </Panel>
    </aside>
  );
}
