import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Journal, awaySummary } from '../platform/journal.ts';
import { RenderMirror } from '../render/mirror.ts';
import { ViewState } from '../render/viewState.ts';
import type { CommandBody } from '../sim/commands.ts';
import { DIRECTIVES } from '../sim/directives.ts';
import type { AgentInfo, BuildingInfo, CouncilRequestStat, CouncilStats, DirectiveStats, InfoMsg, Issue, NamedBot } from '../sim/protocol.ts';
import { LIVERIES } from '../sim/robots/livery.ts';
import { AwayCard } from './AwayCard';
import { AwayStore } from './away.ts';
import { DepotPaint } from './DepotPaint';
import { HallOfBots } from './HallOfBots';
import { InfoCard } from './InfoCard';
import { PacingStore } from './pacing.ts';
import { PacingUi } from './PacingUi';
import { noteResumed, type Session } from './session.ts';
import { ToolsRuntime } from './toolsStore.ts';
import { WhyStore } from './whyStore.ts';

const sample = (tick: number, treasury: number, approval: number) => ({ tick, treasury, approval, population: 10 });
const issue = (over: Partial<Issue> = {}): Issue => ({ id: 'power', kind: 'power', category: 'utilities', severity: 66, count: 3, x: 110, y: 100, text: '3 buildings have no power.', overlay: 'power', ...over });
const request = (over: Partial<CouncilRequestStat> = {}): CouncilRequestStat => ({
  slot: 0, id: 1, kind: 3, group: 1, state: 'pending', text: 'Add 20 commercial jobs.', x: 90, y: 100, have: 0, need: 20, progress: '0 of 20 jobs added', done: false,
  ticksLeft: 9600, cash: 800, approval: 5, rp: 2, penalty: 4, overlay: 'none', ...over,
});
const council = (requests: CouncilRequestStat[] = []): CouncilStats => ({ approval: 62, level: 'good', target: 62, factors: [], requests, festivals: [], running: null, completed: 0, failed: 0 });
const directives = (over: Partial<DirectiveStats> = {}): DirectiveStats => ({ done: 0, claimed: 0, have: DIRECTIVES.map(() => 0), ...over });

function setup() {
  const mirror = new RenderMirror();
  const view = new ViewState();
  const sent: CommandBody[] = [];
  const tools = new ToolsRuntime({ world: mirror, submit: (b) => { sent.push(b); return sent.length; }, view });
  const why = new WhyStore({ requestInfo: vi.fn(async (): Promise<InfoMsg> => ({ type: 'info', id: 1, ok: false, reason: 'gone' })), mirror, view, tools });
  const away = new AwayStore();
  const glide = vi.fn(), onProjects = vi.fn(), onBudget = vi.fn();
  const client = { command: (b: CommandBody) => { sent.push(b); return sent.length; } };
  return { mirror, view, tools, why, away, glide, onProjects, onBudget, client, sent };
}

function openAway(s: ReturnType<typeof setup>, props: { directives?: DirectiveStats; council?: CouncilStats } = {}, journal = new Journal()) {
  journal.observe(sample(0, 1000, 50));
  journal.record([{ type: 'buildingDone', tick: 100, arch: 16, x: 1, y: 1 }, { type: 'buildingDone', tick: 130, arch: 16, x: 1, y: 1 }]);
  journal.observe(sample(700, 1900, 52));
  s.away.open(awaySummary(journal.data()), 'resume');
  return render(
    <AwayCard
      away={s.away} why={s.why} directives={props.directives} council={props.council} population={10} treasury={1900} client={s.client} tools={s.tools}
      mirror={s.mirror} glide={s.glide} onProjects={s.onProjects} onBudget={s.onBudget}
    />,
  );
}

describe('away card', () => {
  it('stays out of the way until the session opens it', () => {
    const s = setup();
    render(<AwayCard away={s.away} why={s.why} population={0} treasury={0} client={s.client} tools={s.tools} mirror={s.mirror} glide={s.glide} onProjects={s.onProjects} onBudget={s.onBudget} />);
    expect(screen.queryByTestId('away-card')).toBeNull();
    act(() => s.away.open(awaySummary({ entries: [], samples: [] }), 'return'));
    expect(screen.getByTestId('away-card').getAttribute('data-reason')).toBe('return');
    expect(screen.getByTestId('away-quiet')).toBeTruthy();
  });

  it('lists what happened, the advisor problems and the next directive and request', () => {
    const s = setup();
    s.why.stats({ issues: [issue(), issue({ id: 'water', kind: 'water', overlay: 'water', x: 120, y: 90, text: '1 building has no water.' })] });
    openAway(s, { directives: directives(), council: council([request({ ticksLeft: 9000 }), request({ slot: 1, id: 2, ticksLeft: 3000, text: 'Add 5 homes.', x: 70, y: 60 })]) });
    const lines = within(screen.getByTestId('away-lines')).getAllByRole('listitem').map((li) => li.textContent);
    expect(lines).toEqual(['2 buildings finished', 'Treasury +$900', 'Approval 50% to 52%']);
    expect(within(screen.getByTestId('away-problems')).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['3 buildings have no power.Show', '1 building has no water.Show']);
    const next = within(screen.getByTestId('away-next')).getAllByRole('listitem');
    expect(next).toHaveLength(2);
    expect(next[0]!.textContent).toContain('Lay a road');
    expect(next[1]!.textContent).toContain('Add 5 homes.');
  });

  it('Show on a problem flies the camera there and switches the overlay; a money problem opens the budget', () => {
    const s = setup();
    s.why.stats({ issues: [issue(), issue({ id: 'budget', kind: 'budget', overlay: 'none', text: 'In debt.' })] });
    openAway(s);
    const rows = screen.getAllByTestId('away-problem-show');
    fireEvent.click(rows[0]!);
    expect(s.glide).toHaveBeenCalledWith(110, 100);
    expect(s.view.overlay).toBe('power');
    fireEvent.click(rows[1]!);
    expect(s.onBudget).toHaveBeenCalledTimes(1);
  });

  it('Show me on the request flies to it; Show me on the directive picks its tool', () => {
    const s = setup();
    openAway(s, { directives: directives(), council: council([request({ x: 91, y: 92, overlay: 'landValue' })]) });
    fireEvent.click(screen.getByTestId('away-request-show'));
    expect(s.glide).toHaveBeenCalledWith(91, 92);
    expect(s.view.overlay).toBe('landValue');
    fireEvent.click(screen.getByTestId('away-directive-show'));
    expect(s.tools.controller.sel).not.toBeNull();
  });

  it('offers to claim a directive that is already met', () => {
    const s = setup();
    openAway(s, { directives: directives({ done: 1 }) });
    expect(screen.queryByTestId('away-directive-show')).toBeNull();
    fireEvent.click(screen.getByTestId('away-claim'));
    expect(s.sent).toEqual([{ type: 'claimDirective', index: 0 }]);
  });

  it('says so when nothing is wrong, and closes from the panel header', () => {
    const s = setup();
    openAway(s, { directives: directives({ claimed: (1 << DIRECTIVES.length) - 1 }) });
    expect(screen.getByTestId('away-clear')).toBeTruthy();
    expect(screen.queryByTestId('away-next')).toBeNull();
    fireEvent.click(within(screen.getByTestId('away-panel')).getByRole('button', { name: 'Close' }));
    expect(screen.queryByTestId('away-card')).toBeNull();
    expect(s.away.summary).toBeNull();
  });
});

describe('resuming a saved city', () => {
  it('takes the journal the save carried and opens the card on the last stretch of that play', () => {
    const journal = new Journal();
    journal.observe(sample(0, 500, 50));
    journal.record([{ type: 'milestone', tick: 900, tier: 1, bonus: 0 }]);
    journal.observe(sample(1000, 700, 50));
    const s = { journal: new Journal(), away: new AwayStore() } as unknown as Session;
    noteResumed(s, journal.data());
    expect(s.away.reason).toBe('resume');
    expect(s.away.summary?.lines.map((l) => l.text)).toEqual(['Reached Settlement', 'Treasury +$200']);
    expect(s.journal.data()).toEqual(journal.data());
  });

  it('opens an empty card for a save from before the journal existed', () => {
    const s = { journal: new Journal(), away: new AwayStore() } as unknown as Session;
    s.journal.record([{ type: 'milestone', tick: 1, tier: 1, bonus: 0 }]);
    noteResumed(s, undefined);
    expect(s.away.summary?.lines).toEqual([]);
    expect(s.journal.data().entries).toEqual([]);
  });
});

describe('pacing toast', () => {
  const pacing = () => {
    const state = { speed: 'max' as const };
    return new PacingStore({ speed: () => state.speed, pause: vi.fn(), enabled: () => true, safeStop: vi.fn(), timer: { set: () => 0, clear: () => undefined } });
  };

  it('shows "Good place to save" with a Save button that saves and goes away', () => {
    const p = pacing();
    const onSave = vi.fn();
    render(<PacingUi pacing={p} onSave={onSave} onResume={vi.fn()} />);
    expect(screen.queryByTestId('pacing-toast')).toBeNull();
    act(() => p.events([{ type: 'directiveReady', tick: 1, index: 0 }]));
    expect(screen.getByTestId('pacing-toast').getAttribute('data-kind')).toBe('safe');
    expect(screen.getByRole('dialog', { name: 'Good place to save' })).toBeTruthy();
    fireEvent.click(screen.getByTestId('pacing-save'));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('pacing-toast')).toBeNull();
  });

  it('explains a crisis pause and offers Play', () => {
    const p = pacing();
    const onResume = vi.fn();
    render(<PacingUi pacing={p} onSave={vi.fn()} onResume={onResume} />);
    act(() => p.events([{ type: 'hazardStart', tick: 1, kind: 1, level: 1, prepared: false, applicable: true, coverage: 0, bonus: 0 }]));
    expect(screen.getByTestId('pacing-toast').getAttribute('data-kind')).toBe('crisis');
    expect(screen.getByTestId('pacing-detail').textContent).toBe('Storm season has begun');
    fireEvent.click(screen.getByTestId('pacing-resume'));
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('pacing-toast')).toBeNull();
  });
});

describe('Hall of Bots', () => {
  const bots: NamedBot[] = [{ key: 0x10007, akind: 2, name: 'Rivet-7', jobs: 212 }, { key: 0x30002, akind: 1, name: 'Sprocket', jobs: 104 }];

  it('lists named bots with their role and jobs, and Follow chases one and closes the panel', () => {
    const onFollow = vi.fn(() => true), onClose = vi.fn();
    render(<HallOfBots bots={bots} onFollow={onFollow} onClose={onClose} />);
    const rows = screen.getAllByTestId('hall-bot');
    expect(rows.map((r) => r.textContent)).toEqual(['Rivet-7Hauler drone, 212 jobsFollow', 'SprocketBuilder bot, 104 jobsFollow']);
    fireEvent.click(within(rows[1]!).getByTestId('hall-follow'));
    expect(onFollow).toHaveBeenCalledWith(0x30002);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the panel open when the bot is already gone, and explains an empty hall', () => {
    const onClose = vi.fn();
    const { rerender } = render(<HallOfBots bots={bots} onFollow={() => false} onClose={onClose} />);
    fireEvent.click(screen.getAllByTestId('hall-follow')[0]!);
    expect(onClose).not.toHaveBeenCalled();
    rerender(<HallOfBots bots={[]} onFollow={() => true} onClose={onClose} />);
    expect(screen.getByTestId('hall-empty').textContent).toContain('100 jobs');
  });
});

describe('depot paint', () => {
  it('shows six schemes with the current one pressed, and picking another sends it', () => {
    const set = vi.fn();
    render(<DepotPaint slot={4} livery={2} controls={{ set }} />);
    const buttons = within(screen.getByTestId('depot-paint')).getAllByRole('button').filter((b) => b.className.includes('paint-swatch'));
    expect(buttons).toHaveLength(6);
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true', 'false', 'false', 'false']);
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(LIVERIES.map((l) => l.name));
    fireEvent.click(buttons[2]!);
    expect(set).not.toHaveBeenCalled();
    fireEvent.click(buttons[5]!);
    expect(set).toHaveBeenCalledWith(4, 5);
    expect(screen.getByTestId('paint-name').textContent).toContain(LIVERIES[2]!.name);
  });
});

describe('info card for bots and depots', () => {
  const depot: BuildingInfo = {
    kind: 'building', slot: 4, arch: 1, name: 'Depot', level: 0, maxLevel: 0, x: 98, y: 102, w: 2, h: 2, status: 'working', progress: 100, residents: 0, jobs: 0, thoughts: [],
    depot: { radius: 40, builders: 4, haulers: 4, stock: 40, builderCap: 4, haulerCap: 4, droneCap: 0, modules: [0, 0], livery: 3 },
  };
  const agent = (over: Partial<AgentInfo> = {}): AgentInfo => ({ kind: 'agent', key: 0x10007, akind: 1, name: 'Builder bot #8', job: 'Resting in the depot.', x: 100.5, y: 104.5, jobs: 12, named: false, role: 'Builder bot #8', ...over });

  function card(info: BuildingInfo | AgentInfo, extra: Partial<Parameters<typeof InfoCard>[0]> = {}) {
    const s = setup();
    const why = new WhyStore({ requestInfo: vi.fn(async (): Promise<InfoMsg> => ({ type: 'info', id: 1, ok: true, info })), mirror: s.mirror, view: s.view, tools: s.tools });
    why.tap(info.kind === 'building' ? { kind: 'building', slot: info.slot, x: info.x, y: info.y } : { kind: 'agent', key: info.key, akind: info.akind, x: info.x, y: info.y });
    render(<InfoCard why={why} onJump={vi.fn()} {...extra} />);
    return act(async () => { await Promise.resolve(); await Promise.resolve(); });
  }

  it('a depot card carries the paint picker and sends setDepotLivery for its slot', async () => {
    const set = vi.fn();
    await card(depot, { paint: { set } });
    const picker = screen.getByTestId('depot-paint');
    expect(within(picker).getByTestId('paint-3').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(picker).getByTestId('paint-1'));
    expect(set).toHaveBeenCalledWith(4, 1);
  });

  it('has no paint picker without the control, or while the depot is still being built', async () => {
    await card({ ...depot, status: 'constructing' }, { paint: { set: vi.fn() } });
    expect(screen.queryByTestId('depot-paint')).toBeNull();
  });

  it('a named bot shows its name, role and job count with a Follow button', async () => {
    const onFollow = vi.fn(() => true);
    await card(agent({ name: 'Rivet-7', named: true, jobs: 134 }), { onFollow });
    expect(screen.getByTestId('info-name').textContent).toBe('Rivet-7');
    expect(screen.getByTestId('agent-jobs').textContent).toBe('Builder bot #8134 jobs done');
    fireEvent.click(screen.getByTestId('info-follow'));
    expect(onFollow).toHaveBeenCalledWith(0x10007);
  });

  it('a bot that has not earned a name says how far it has to go', async () => {
    await card(agent(), { onFollow: vi.fn() });
    expect(screen.getByTestId('info-name').textContent).toBe('Builder bot #8');
    expect(screen.getByTestId('agent-jobs').textContent).toBe('12 jobs doneEarns a name at 100');
  });
});
