import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARCH } from '../sim/catalog.ts';
import type { CommandBody } from '../sim/commands.ts';
import { MAP, ROAD, S, TERRAIN } from '../sim/layers.ts';
import type { AgentInfo, BuildingInfo, InfoMsg, Issue } from '../sim/protocol.ts';
import { RenderMirror } from '../render/mirror.ts';
import { ViewState } from '../render/viewState.ts';
import { AdvisorChip, chipText } from './AdvisorChip';
import { GhostChips } from './GhostChips';
import { InfoCard } from './InfoCard';
import { ToolsRuntime } from './toolsStore.ts';
import { headlineAt, HEADLINE_MS, UNIT0_HEADLINES } from './unit0.ts';
import { WhyStore } from './whyStore.ts';

const issue = (over: Partial<Issue> = {}): Issue => ({ id: 'power', kind: 'power', category: 'utilities', severity: 66, count: 3, x: 110, y: 100, text: '3 buildings have no power: nearest gap is 5 tiles to the grid.', overlay: 'power', ...over });

const house: BuildingInfo = {
  kind: 'building', slot: 4, arch: 16, name: 'House', level: 1, maxLevel: 3, x: 110, y: 100, w: 1, h: 1, status: 'working', progress: 100, residents: 6, jobs: 0,
  thoughts: [
    { text: "No school nearby - can't level up.", tone: 'warn', overlay: 'education' },
    { text: 'Smog from the steel works.', tone: 'bad', overlay: 'pollution' },
    { text: 'Fully grown.', tone: 'good' },
  ],
};
const hauler: AgentInfo = { kind: 'agent', key: 0x10007, akind: 2, name: 'Hauler drone #8', job: 'Hauling 4 material to the house at (110, 100), ETA ~20 s.', x: 100.5, y: 104.5, etaSec: 20 };

function setup(info: BuildingInfo | AgentInfo | null = null, ok = true) {
  const mirror = new RenderMirror();
  mirror.layers.terrain!.fill(TERRAIN.GRASS);
  mirror.layers.height!.fill(160);
  const view = new ViewState();
  const submitted: CommandBody[] = [];
  const tools = new ToolsRuntime({ world: mirror, submit: (b) => { submitted.push(b); return submitted.length; }, view });
  const reply: InfoMsg = ok && info ? { type: 'info', id: 1, ok: true, info } : { type: 'info', id: 1, ok: false, reason: 'gone' };
  const requestInfo = vi.fn(async () => reply);
  const why = new WhyStore({ requestInfo, mirror, view, tools });
  return { mirror, view, tools, why, submitted, requestInfo };
}

const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

beforeEach(() => { vi.useRealTimers(); });
afterEach(() => vi.useRealTimers());

describe('advisor chip', () => {
  it('shows the top issue with its icon and a count badge', () => {
    const { why } = setup();
    why.stats({ issues: [issue(), issue({ id: 'noFire', kind: 'noFire', severity: 36, text: '6 buildings are outside any fire station\'s reach.' })] });
    render(<AdvisorChip why={why} onJump={vi.fn()} />);
    const chip = screen.getByTestId('advisor-chip');
    expect(chip.getAttribute('data-kind')).toBe('power');
    expect(screen.getByTestId('advisor-text').textContent).toBe('3 buildings have no power');
    expect(screen.getByTestId('advisor-count').textContent).toBe('2');
    expect(chip.querySelector('svg')).not.toBeNull();
    expect(chip.getAttribute('aria-label')).toContain('2 city problems');
  });

  it('opens a list on tap, and a row flies the camera to the issue and switches the overlay', () => {
    const { why, view } = setup();
    why.stats({ issues: [issue(), issue({ id: 'water', kind: 'water', overlay: 'water', x: 120, y: 100, severity: 60, count: 1, text: '1 building has no water: the nearest water is 2 tiles away, lay a pipe.' })] });
    const onJump = vi.fn();
    render(<AdvisorChip why={why} onJump={onJump} />);
    expect(screen.queryByTestId('advisor-list')).toBeNull();
    fireEvent.click(screen.getByTestId('advisor-chip'));
    const rows = within(screen.getByTestId('advisor-list')).getAllByTestId('advisor-issue');
    expect(rows.map((r) => r.getAttribute('data-kind'))).toEqual(['power', 'water']);
    fireEvent.click(rows[1]!);
    expect(onJump).toHaveBeenCalledWith(120, 100);
    expect(view.overlay).toBe('water');
    expect(screen.queryByTestId('advisor-list')).toBeNull();
  });

  it('opens the budget instead of flying for a money problem', () => {
    const { why, view } = setup();
    why.stats({ issues: [issue({ id: 'budget', kind: 'budget', overlay: 'none', text: 'The treasury is $500 in debt. 2 months until services fail.' })] });
    const onJump = vi.fn(), onBudget = vi.fn();
    render(<AdvisorChip why={why} onJump={onJump} onBudget={onBudget} />);
    fireEvent.click(screen.getByTestId('advisor-chip'));
    fireEvent.click(screen.getByTestId('advisor-issue'));
    expect(onBudget).toHaveBeenCalledTimes(1);
    expect(onJump).not.toHaveBeenCalled();
    expect(view.overlay).toBe('none');
  });

  it('is calm and rotates UNIT-0 headlines when nothing is wrong', () => {
    vi.useFakeTimers();
    let t = 5 * HEADLINE_MS;
    const { why } = setup();
    render(<AdvisorChip why={why} onJump={vi.fn()} now={() => t} />);
    expect(screen.getByTestId('advisor-chip').getAttribute('data-kind')).toBe('ok');
    expect(screen.queryByTestId('advisor-count')).toBeNull();
    expect(screen.getByTestId('advisor-text').textContent).toBe(headlineAt(5));
    expect(headlineAt(5)).toMatch(/^UNIT-0:/);
    t = 6 * HEADLINE_MS;
    act(() => { vi.advanceTimersByTime(HEADLINE_MS); });
    expect(screen.getByTestId('advisor-text').textContent).toBe(headlineAt(6));
    expect(headlineAt(6)).not.toBe(headlineAt(5));
    fireEvent.click(screen.getByTestId('advisor-chip'));
    expect(screen.getByTestId('advisor-ok').textContent).toBe(headlineAt(6));
    expect(new Set(UNIT0_HEADLINES).size).toBe(UNIT0_HEADLINES.length);
    expect(headlineAt(-1)).toBe(UNIT0_HEADLINES[UNIT0_HEADLINES.length - 1]);
  });

  it('mounts into the HUD slot when one exists, and into its own spot when none does', () => {
    const { why } = setup();
    const first = render(<><div data-slot="advisor" data-testid="slot" /><AdvisorChip why={why} onJump={vi.fn()} /></>);
    expect(within(screen.getByTestId('slot')).getByTestId('advisor-chip')).toBeTruthy();
    first.unmount();
    const second = render(<AdvisorChip why={why} onJump={vi.fn()} />);
    expect(second.container.querySelector('.advisor-fallback [data-testid="advisor-chip"]')).not.toBeNull();
  });

  it('shortens an issue to the first clause', () => {
    expect(chipText(issue())).toBe('3 buildings have no power');
    expect(chipText(issue({ text: 'A house is on fire. Fire cover there is 0%.' }))).toBe('A house is on fire');
  });

  it('only redraws when the list really changed', () => {
    const { why } = setup();
    let n = 0;
    why.subscribe(() => n++);
    why.stats({ issues: [issue()] });
    why.stats({ issues: [issue()] });
    expect(n).toBe(1);
    why.stats({ issues: [issue({ count: 4 })] });
    expect(n).toBe(2);
  });
});

describe('info card', () => {
  it('shows a tapped building: name, level, residents, its thoughts with their tone, and the quick actions', async () => {
    const { why, requestInfo } = setup(house);
    render(<InfoCard why={why} onJump={vi.fn()} />);
    expect(screen.queryByTestId('info-card')).toBeNull();
    act(() => why.tap({ kind: 'building', slot: 4, x: 110, y: 100 }));
    expect(screen.getByTestId('info-card').getAttribute('data-kind')).toBe('building');
    await flush();
    expect(requestInfo).toHaveBeenCalledWith('building', 4);
    expect(screen.getByTestId('info-name').textContent).toBe('House');
    const facts = screen.getByTestId('info-facts').textContent!;
    expect(facts).toContain('Level 1 of 3');
    expect(facts).toContain('6 residents');
    const items = within(screen.getByTestId('thoughts')).getAllByRole('listitem');
    expect(items.map((i) => i.getAttribute('data-tone'))).toEqual(['warn', 'bad', 'good']);
    expect(items[0]!.textContent).toContain("No school nearby - can't level up.");
    expect(screen.getByTestId('info-look')).toBeTruthy();
    expect(screen.getByTestId('info-bulldoze')).toBeTruthy();
  });

  it('shows a tapped Smelter\'s stock bars and its needs line', async () => {
    const smelter: BuildingInfo = {
      ...house, slot: 9, arch: ARCH.SMELTER, name: 'Smelter', level: 0, maxLevel: 0, residents: 0, thoughts: [{ text: 'Starved: waiting for ore from haulers.', tone: 'warn' }],
      stocks: [{ res: 0, role: 'in', have: 2, cap: 16 }, { res: 1, role: 'out', have: 6, cap: 40 }],
      needs: [{ text: 'Power', ok: true }, { text: 'Ore: 2 of 4 for a batch', ok: false }],
    };
    const { why } = setup(smelter);
    render(<InfoCard why={why} onJump={vi.fn()} />);
    act(() => why.tap({ kind: 'building', slot: 9, x: 112, y: 105 }));
    await flush();
    expect(screen.getAllByTestId('stock-bar')).toHaveLength(2);
    expect(screen.getByTestId('needs').textContent).toContain('Ore: 2 of 4 for a batch');
  });

  it('switches the overlay from a thought, flies to the building, and bulldozes it through the tool path', async () => {
    const { why, view, submitted, tools, mirror } = setup(house);
    mirror.layers.bId![100 * MAP + 110] = 5;
    mirror.scalars[S.treasury] = 1000;
    const onJump = vi.fn();
    render(<InfoCard why={why} onJump={onJump} />);
    act(() => why.tap({ kind: 'building', slot: 4, x: 110, y: 100 }));
    await flush();
    fireEvent.click(within(screen.getByTestId('thoughts')).getAllByText('Show')[0]!);
    expect(view.overlay).toBe('education');
    fireEvent.click(screen.getByTestId('info-look'));
    expect(onJump).toHaveBeenCalledWith(110, 100);
    fireEvent.click(screen.getByTestId('info-bulldoze'));
    expect(submitted).toEqual([{ type: 'bulldoze', x0: 110, y0: 100, x1: 110, y1: 100 }]);
    expect(tools.controller.sel, 'the tool is put away again').toBeNull();
    expect(screen.queryByTestId('info-card')).toBeNull();
  });

  it('shows what a tapped robot is doing and follows it on request', async () => {
    const { why, requestInfo } = setup(hauler);
    const onFollow = vi.fn(() => true);
    render(<InfoCard why={why} onJump={vi.fn()} onFollow={onFollow} />);
    act(() => why.tap({ kind: 'agent', key: 0x10007, akind: 2, x: 100.5, y: 104.5 }));
    await flush();
    expect(requestInfo).toHaveBeenCalledWith('agent', 0x10007);
    expect(screen.getByTestId('info-name').textContent).toBe('Hauler drone #8');
    expect(screen.getByTestId('agent-job').textContent).toBe('Hauling 4 material to the house at (110, 100), ETA ~20 s.');
    fireEvent.click(screen.getByTestId('info-follow'));
    expect(onFollow).toHaveBeenCalledWith(0x10007);
  });

  it('shows a waiting robot with its reason, and says so when it has gone', async () => {
    const waiting: AgentInfo = { ...hauler, job: 'Waiting: road blocked', waiting: 'road blocked', detail: hauler.job, etaSec: undefined };
    const { why } = setup(waiting);
    render(<InfoCard why={why} onJump={vi.fn()} />);
    act(() => why.tap({ kind: 'agent', key: 0x10007, akind: 2, x: 1, y: 1 }));
    await flush();
    expect(screen.getByTestId('agent-job').textContent).toBe('Waiting: road blocked');
    expect(screen.getByTestId('agent-detail').textContent).toContain('Hauling 4 material');
    const gone = setup(waiting, false);
    gone.why.tap({ kind: 'agent', key: 0x10007, akind: 2, x: 1, y: 1 });
    (gone.why as unknown as { info: AgentInfo }).info = waiting;
    await flush();
    expect(gone.why.gone).toBe(true);
  });

  it('refreshes while open, closes on Escape, on a tap on empty ground, and when a tool is picked', async () => {
    vi.useFakeTimers();
    const { why, requestInfo, tools } = setup(house);
    render(<InfoCard why={why} onJump={vi.fn()} />);
    act(() => why.tap({ kind: 'building', slot: 4, x: 110, y: 100 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(requestInfo.mock.calls.length).toBeGreaterThanOrEqual(3);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('info-card')).toBeNull();
    act(() => why.tap({ kind: 'building', slot: 4, x: 110, y: 100 }));
    act(() => why.tap({ kind: 'none' }));
    expect(screen.queryByTestId('info-card')).toBeNull();
    act(() => why.tap({ kind: 'building', slot: 4, x: 110, y: 100 }));
    act(() => tools.controller.select({ tool: 'road', cls: 1 }));
    expect(screen.queryByTestId('info-card')).toBeNull();
    const calls = requestInfo.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(requestInfo.mock.calls.length, 'no polling once closed').toBe(calls);
  });

  it('says it could not load the details when the info request fails, and recovers on the next answer', async () => {
    const { why, requestInfo } = setup(house);
    requestInfo.mockRejectedValueOnce(new Error('worker went away'));
    render(<InfoCard why={why} onJump={vi.fn()} />);
    act(() => why.tap({ kind: 'building', slot: 4, x: 110, y: 100 }));
    expect(screen.getByText('Asking the sim...')).toBeTruthy();
    await flush();
    expect(why.failed).toBe(true);
    expect(screen.getByTestId('info-error').textContent).toBe("Couldn't load details");
    expect(screen.queryByText('Asking the sim...')).toBeNull();
    fireEvent.click(screen.getByTestId('info-close'));
    expect(screen.queryByTestId('info-card')).toBeNull();
    expect(why.failed).toBe(false);
    act(() => why.tap({ kind: 'building', slot: 4, x: 110, y: 100 }));
    await flush();
    expect(why.failed).toBe(false);
    expect(screen.getByTestId('info-name').textContent).toBe('House');
  });

  it('drops the card when the building is gone', async () => {
    const { why } = setup(null, false);
    render(<InfoCard why={why} onJump={vi.fn()} />);
    act(() => why.tap({ kind: 'building', slot: 4, x: 110, y: 100 }));
    await flush();
    expect(screen.queryByTestId('info-card')).toBeNull();
  });
});

describe('depot work radius tint', () => {
  function depotCity() {
    const s = setup();
    const L = s.mirror.layers;
    for (let x = 90; x <= 150; x++) L.road![104 * MAP + x] = 1 | ROAD.E | ROAD.W;
    L.bArch![0] = ARCH.DEPOT; L.bX![0] = 98; L.bY![0] = 102; L.bW![0] = 2; L.bH![0] = 2;
    for (const y of [102, 103]) for (const x of [98, 99]) L.bId![y * MAP + x] = 1;
    return s;
  }
  const tinted = (m: RenderMirror, x: number, y: number): number => m.depotReach[y * MAP + x]!;

  it('tints the road distance from every depot while the depot tool is in hand, plus the ghost, and clears it afterwards', () => {
    const { why, view, mirror, tools } = depotCity();
    why.syncReach();
    expect(view.depotReach).toBe(false);
    expect(view.effectiveOverlay).toBe('none');
    tools.controller.select({ tool: 'service', arch: ARCH.DEPOT });
    tools.controller.move({ x: 140, y: 102 });
    why.syncReach();
    expect(view.depotReach).toBe(true);
    expect(view.effectiveOverlay).toBe('depotReach');
    expect(tinted(mirror, 98, 104), 'at the first depot door').toBe(255);
    expect(tinted(mirror, 120, 104), '22 road tiles out').toBeGreaterThan(60);
    expect(tinted(mirror, 120, 104)).toBeLessThan(255);
    expect(tinted(mirror, 140, 104), 'the ghost depot door').toBe(255);
    expect(tinted(mirror, 120, 120), 'off the road network').toBe(0);
    const version = mirror.depotReachVersion;
    why.syncReach();
    expect(mirror.depotReachVersion, 'unchanged inputs do not repaint').toBe(version);
    tools.controller.cancel();
    why.syncReach();
    expect(view.depotReach).toBe(false);
    expect(view.effectiveOverlay).toBe('none');
  });

  it('tints only the selected depot when its card is open, and stops beyond the work radius', async () => {
    const s = depotCity();
    const L = s.mirror.layers;
    L.bArch![1] = ARCH.DEPOT; L.bX![1] = 140; L.bY![1] = 102; L.bW![1] = 2; L.bH![1] = 2;
    const why = new WhyStore({ requestInfo: async () => ({ type: 'info', id: 1, ok: false }), mirror: s.mirror, view: s.view, tools: s.tools });
    why.selection = { kind: 'building', ref: 0, x: 98, y: 102 };
    why.syncReach();
    expect(s.view.depotReach).toBe(true);
    expect(tinted(s.mirror, 98, 104)).toBe(255);
    expect(tinted(s.mirror, 138, 104), '40 road tiles out').toBeGreaterThan(0);
    expect(tinted(s.mirror, 144, 104), 'the other depot is not drawn').toBe(0);
    why.selection = null;
    why.syncReach();
    expect(s.view.depotReach).toBe(false);
  });
});

describe('placement chips', () => {
  it('shows chips beside the ghost while a service is being placed, worst first, and none without a plan', () => {
    const { why, tools } = setup();
    render(<GhostChips why={why} />);
    expect(screen.queryByTestId('ghost-chips')).toBeNull();
    act(() => { tools.controller.select({ tool: 'service', arch: ARCH.FIRE_STATION }); tools.controller.move({ x: 100, y: 100 }); });
    const box = screen.getByTestId('ghost-chips');
    const chips = within(box).getAllByText(/./);
    expect(chips[0]!.getAttribute('data-tone')).toBe('bad');
    expect(chips[0]!.textContent).toBe('No road at its door: it covers nothing');
    act(() => tools.controller.cancel());
    expect(screen.queryByTestId('ghost-chips')).toBeNull();
  });
});

describe('view state', () => {
  it('keeps the depot tint out of the overlay list and under the underground view', () => {
    const v = new ViewState();
    v.setOverlay('power');
    v.setDepotReach(true);
    expect(v.effectiveOverlay).toBe('depotReach');
    v.setUnderground(true);
    expect(v.effectiveOverlay).toBe('water');
    v.setUnderground(false); v.setDepotReach(false);
    expect(v.effectiveOverlay).toBe('power');
  });
});
