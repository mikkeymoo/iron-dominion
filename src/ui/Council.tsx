import type { SimClient } from '../sim/client.ts';
import { FESTIVAL_MIN, GROUP_NAMES, HIGH, LOW, MONTH_TICKS } from '../sim/council/tables.ts';
import type { CouncilRequestStat, CouncilStats, FestivalStat, IssueOverlay } from '../sim/protocol.ts';
import { Panel } from './Panel';
import './council.css';

const usd = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;
/** A budget month is one game day. */
const days = (ticks: number): string => {
  const d = ticks / MONTH_TICKS;
  return d < 0.1 ? 'under a tenth of a day' : `${d.toFixed(1)} days`;
};

export const LEVEL_TEXT: Record<CouncilStats['level'], string> = { high: 'Delighted', good: 'Content', low: 'Unhappy', veryLow: 'Furious' };

const BLOCK_TEXT: Record<string, string> = {
  approval: `Needs approval above ${FESTIVAL_MIN}`,
  busy: 'A show is already running',
  night: 'After dark only',
  funds: 'Not enough money',
  'no-city': 'Build something to celebrate first',
};

/** A face that shows the mood; the colour comes from the chip's data-level. */
export function Face({ level }: { level: CouncilStats['level'] }) {
  const mouth = level === 'high' ? 'M8 13.5c1 3 7 3 8 0' : level === 'good' ? 'M8.5 14.5c1.2 1.5 5.8 1.5 7 0' : level === 'low' ? 'M8.5 16c1.5-1.1 5.5-1.1 7 0' : 'M8 17c1.5-2.4 6.5-2.4 8 0';
  return (
    <svg className="face" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9" />
      <path d={mouth} />
      <path d="M9 9.5h.01M15 9.5h.01" />
      {level === 'veryLow' && <path d="M7.5 7.5l3 1.2M16.5 7.5l-3 1.2" />}
    </svg>
  );
}

interface ChipProps { council: CouncilStats; open: boolean; onClick(): void }

/** Approval in the HUD strip, next to the money: a face, the number, coloured by band. Opens the Council panel. */
export function ApprovalChip({ council, open, onClick }: ChipProps) {
  const text = `Approval ${council.approval} percent, ${LEVEL_TEXT[council.level].toLowerCase()}`;
  return (
    <button
      type="button" className="approval-chip" data-level={council.level} data-testid="approval-chip" aria-expanded={open} aria-haspopup="dialog" aria-label={`${text}. Open the council`}
      title={`${text}. Tap for the council.`} onClick={onClick}
    >
      <Face level={council.level} />
      <span className="approval-num" data-testid="approval-value">{council.approval}</span>
    </button>
  );
}

interface PanelProps {
  stats: CouncilStats;
  client: Pick<SimClient, 'command'>;
  /** Fly the camera to a request and show its overlay. */
  onShow(x: number, y: number, overlay: IssueOverlay): void;
  onClose(): void;
}

function Meter({ s }: { s: CouncilStats }) {
  const pull = s.target - s.approval;
  return (
    <div className="council-meter" data-level={s.level} data-testid="council-meter">
      <Face level={s.level} />
      <strong data-testid="council-approval">{s.approval}</strong>
      <span className="council-level">{LEVEL_TEXT[s.level]}</span>
      <div className="council-bar" role="img" aria-label={`Approval ${s.approval} of 100`}>
        <i style={{ width: `${s.approval}%` }} />
        <b style={{ left: `${LOW}%` }} title={`Below ${LOW}: taxes are resisted and the robots slow down`} />
        <b style={{ left: `${HIGH}%` }} title={`Above ${HIGH}: more demand, and festivals open`} />
      </div>
      <span className="council-trend" data-testid="council-trend">{Math.abs(pull) < 1 ? 'Holding steady' : pull > 0 ? `Heading up, toward ${s.target}` : `Heading down, toward ${s.target}`}</span>
    </div>
  );
}

function Effects({ s }: { s: CouncilStats }) {
  const text = s.approval > HIGH ? `Above ${HIGH}: more homes and shops are wanted, and festivals are open.`
    : s.approval < LOW ? `Below ${LOW}: every zone pays less tax, growth slows and the robots build 5% slower.`
    : `Between ${LOW} and ${HIGH}: no bonus and no penalty.`;
  return <p className="hint" data-testid="council-effects">{text}</p>;
}

function Request({ r, client, onShow }: { r: CouncilRequestStat; client: PanelProps['client']; onShow: PanelProps['onShow'] }) {
  const reply = (accept: boolean): void => { client.command({ type: 'councilRespond', slot: r.slot, accept, request: r.id }); };
  const urgent = r.state === 'accepted' && r.ticksLeft < MONTH_TICKS;
  return (
    <li className="council-request" data-testid={`request-${r.slot}`} data-state={r.state} data-urgent={urgent} data-done={r.done}>
      <div className="fw-node-head">
        <strong>{GROUP_NAMES[r.group] ?? 'Citizens'}</strong>
        <span className="fw-cost" data-testid={`request-left-${r.slot}`}>{days(r.ticksLeft)} left</span>
      </div>
      <p className="council-text">{r.text}</p>
      {r.state === 'accepted' && <p className="council-progress" data-testid={`request-progress-${r.slot}`}>{r.progress}</p>}
      <p className="council-reward">
        Reward {usd(r.cash)}, +{r.approval} approval, +{r.rp} RP. Fail: -{r.penalty} approval.
      </p>
      <div className="council-actions">
        <button type="button" className="tb wide" data-testid={`request-show-${r.slot}`} onClick={() => onShow(r.x, r.y, r.overlay)}>Show me</button>
        {r.state === 'pending' && <button type="button" className="tb wide" data-testid={`request-accept-${r.slot}`} onClick={() => reply(true)}>Accept</button>}
        {r.state === 'pending' && <button type="button" className="tb wide" data-testid={`request-decline-${r.slot}`} onClick={() => reply(false)}>Decline (-1)</button>}
      </div>
    </li>
  );
}

function Festival({ f, client }: { f: FestivalStat; client: PanelProps['client'] }) {
  const why = f.blocked === 'cooldown' ? `Ready in ${days(f.cooldown)}` : f.blocked ? BLOCK_TEXT[f.blocked] ?? 'Not now' : '';
  return (
    <li className="council-festival" data-testid={`festival-${f.id}`} data-blocked={f.blocked ?? ''}>
      <div className="fw-node-head">
        <strong>{f.name}</strong>
        <span className="fw-cost">{usd(f.cost)}, +{f.approval} approval</span>
      </div>
      <button type="button" className="tb wide" data-testid={`festival-hold-${f.id}`} disabled={f.blocked !== undefined} onClick={() => client.command({ type: 'holdFestival', festival: f.id })}>
        {f.blocked ? why : `Hold ${f.name}`}
      </button>
    </li>
  );
}

/** Approval and what moves it, the council's open requests (Show me, Accept, Decline) and the festivals the city can afford. */
export function CouncilPanel({ stats, client, onShow, onClose }: PanelProps) {
  const moves = [...stats.factors].filter((f) => f.value !== 0).sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  return (
    <Panel id="council" title="Council" className="budget fw-panel council-panel" panelAttr="council" testId="council-panel" onClose={onClose}>
      <Meter s={stats} />
      <Effects s={stats} />
      <ul className="council-factors" data-testid="council-factors">
        {moves.length === 0 && <li className="hint">Nothing is moving approval yet.</li>}
        {moves.map((f) => <li key={f.key} className={f.value > 0 ? 'up' : 'down'}>{f.value > 0 ? '+' : ''}{f.value.toFixed(1)} {f.label}</li>)}
      </ul>
      <h3>Requests</h3>
      {stats.requests.length === 0
        ? <p className="hint" data-testid="council-empty">No open requests. A citizen group asks for something every two to four months, and at most two stay open.</p>
        : <ul className="council-list">{stats.requests.map((r) => <Request key={r.id} r={r} client={client} onShow={onShow} />)}</ul>}
      <h3>Festivals</h3>
      {stats.running && <p className="council-progress" data-testid="festival-running">{stats.festivals[stats.running.festival]?.name ?? 'A festival'} is on.</p>}
      <ul className="council-list">{stats.festivals.map((f) => <Festival key={f.id} f={f} client={client} />)}</ul>
      <p className="hint">Festivals need approval above {FESTIVAL_MIN}. Each lifts approval and shop demand for a while, then rests.</p>
    </Panel>
  );
}
