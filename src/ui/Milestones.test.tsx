import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARCH } from '../sim/catalog.ts';
import type { CommandBody } from '../sim/commands.ts';
import { S, TERRAIN } from '../sim/layers.ts';
import { MEGA, MEGA_ARCHS, megaStages } from '../sim/megaprojects.ts';
import type { MilestoneStats, ProjectStatus } from '../sim/protocol.ts';
import { allocWorld } from '../sim/world.ts';
import type { ToolWorld } from '../render/tools/controller.ts';
import { ViewState } from '../render/viewState.ts';
import { Banner, MilestonesPanel } from './Milestones';
import { Tools } from './Tools';
import { BANNER_MS, ToolsRuntime } from './toolsStore.ts';

afterEach(() => { cleanup(); vi.useRealTimers(); });

function setup(tier = 0) {
  const w = allocWorld();
  w.terrain.fill(TERRAIN.GRASS);
  w.height.fill(160);
  w.scalars[S.treasury] = 1_000_000;
  w.scalars[S.tier] = tier;
  const world: ToolWorld = { layers: w as unknown as Record<string, ArrayLike<number>>, scalars: w.scalars, tick: 0 };
  const sent: CommandBody[] = [];
  const rt = new ToolsRuntime({ world, submit: (b) => { sent.push(b); return sent.length + 100; } });
  return { rt, w, sent };
}

const ok = (have: number, need: number) => ({ have, need, ok: have >= need });
const project = (arch: number, over: Partial<ProjectStatus> = {}): ProjectStatus => {
  const r = MEGA[arch]!.req;
  return { arch, state: 'none', stage: 0, stages: megaStages(arch), progress: 0, everBuilt: false, req: { pop: ok(r.pop, r.pop), power: ok(r.power, r.power), water: ok(r.water, r.water) }, met: true, ...over };
};
const stats = (tier: number, projects: ProjectStatus[]): MilestoneStats => ({ tier, nextAt: tier < 5 ? [500, 2000, 8000, 25000, 80000][tier]! : null, projects, victory: false });

describe('milestones panel', () => {
  it('shows the tier, progress to the next one, and what each tier unlocks', () => {
    const { rt } = setup(2);
    render(<MilestonesPanel stats={stats(2, MEGA_ARCHS.map((a) => project(a)))} population={5000} runtime={rt} onClose={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'Milestones and projects' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Town' })).toBeTruthy();
    const bar = screen.getByRole('progressbar', { name: 'Progress to the next milestone' });
    expect(bar.getAttribute('aria-valuenow')).toBe(String(Math.round(((5000 - 2000) / (8000 - 2000)) * 100)));
    expect(screen.getByTestId('tier-0').className).toContain('reached');
    expect(screen.getByTestId('tier-2').className).toContain('reached');
    expect(screen.getByTestId('tier-3').className).not.toContain('reached');
    expect(screen.getByTestId('tier-2').textContent).toMatch(/Avenue roads, Highway roads/);
    expect(screen.getByTestId('tier-3').textContent).toMatch(/High density zoning, Fusion reactor/);
    expect(screen.getByTestId('tier-4').textContent).toMatch(/Fusion Spire, Arcology, Mech Arena/);
    expect(screen.getByTestId('tier-5').textContent).toMatch(/Space Elevator/);
  });

  it('fills the bar at the top tier', () => {
    const { rt } = setup(5);
    render(<MilestonesPanel stats={stats(5, MEGA_ARCHS.map((a) => project(a)))} population={90000} runtime={rt} onClose={() => {}} />);
    expect(screen.getByRole('progressbar', { name: 'Progress to the next milestone' }).getAttribute('aria-valuenow')).toBe('100');
    expect(screen.getByText(/highest milestone reached/)).toBeTruthy();
  });

  it('lists each project by state: locked, requirements, building with its stage, complete', () => {
    const { rt } = setup(4);
    const unmet = project(ARCH.ARCOLOGY, { met: false, req: { pop: ok(30000, 30000), power: ok(20, 150), water: ok(220, 220) } });
    const building = project(ARCH.MECH_ARENA, { state: 'building', stage: 1, progress: 0.5 });
    const done = project(ARCH.FUSION_SPIRE, { state: 'done', stage: 3, progress: 1 });
    render(<MilestonesPanel stats={stats(4, [done, unmet, building, project(ARCH.SPACE_ELEVATOR)])} population={30000} runtime={rt} onClose={() => {}} />);
    expect(screen.getByTestId('project-fusionSpire').textContent).toMatch(/Complete/);
    expect(screen.getByTestId('project-mechArena').textContent).toMatch(/Stage 2 of 3: Stands/);
    expect(screen.getByRole('progressbar', { name: 'Mech Arena progress' }).getAttribute('aria-valuenow')).toBe('50');
    const arc = screen.getByTestId('project-arcology');
    expect(arc.textContent).toMatch(/Spare power.*20 \/ 150 MW/);
    expect((arc.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('project-spaceElevator').textContent).toMatch(/Unlocks at Megalopolis \(80,000 people\)/);
    expect(screen.getByTestId('project-spaceElevator').querySelector('button')).toBeNull();
  });

  it('enters the placement tool for a project when Start is pressed, and closes', () => {
    const { rt } = setup(4);
    const onClose = vi.fn();
    render(<MilestonesPanel stats={stats(4, MEGA_ARCHS.map((a) => project(a)))} population={30000} runtime={rt} onClose={onClose} />);
    const start = screen.getByTestId('project-arcology').querySelector('button') as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    fireEvent.click(start);
    expect(rt.controller.sel).toEqual({ tool: 'service', arch: ARCH.ARCOLOGY });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('announcements', () => {
  it('toasts a milestone as a celebration with its bonus, and a finished stage', () => {
    const { rt } = setup();
    rt.handleEvents([{ type: 'milestone', tick: 1, tier: 3, bonus: 15000 }]);
    expect(rt.toasts[0]).toMatchObject({ text: 'City reached! +$15,000 bonus', good: true });
    rt.handleEvents([{ type: 'megaStage', tick: 2, arch: ARCH.ARCOLOGY, slot: 0, stage: 1, stages: 4, x: 1, y: 1, w: 7, h: 7 }]);
    expect(rt.toasts[1]).toMatchObject({ text: 'Arcology: Lower terraces done (2/4)', good: true });
  });

  it('banners "Space Elevator complete!" and the victory, then clears them', () => {
    vi.useFakeTimers();
    const { rt } = setup();
    render(<Banner runtime={rt} />);
    expect(screen.queryByTestId('banner')).toBeNull();
    act(() => { rt.handleEvents([{ type: 'megaComplete', tick: 9, arch: ARCH.SPACE_ELEVATOR, slot: 0, x: 1, y: 1, w: 6, h: 6 }]); });
    expect(screen.getByTestId('banner').textContent).toBe('Space Elevator complete!');
    act(() => { rt.handleEvents([{ type: 'victory', tick: 9 }]); });
    expect(screen.getByTestId('banner').className).toContain('victory');
    act(() => { vi.advanceTimersByTime(BANNER_MS + 10); });
    expect(screen.queryByTestId('banner')).toBeNull();
  });
});

describe('tool sheet locks', () => {
  const sheet = (tier: number) => {
    const s = setup(tier);
    s.rt.controller.select({ tool: 'road', cls: 1 });
    render(<Tools runtime={s.rt} view={new ViewState()} />);
    return s;
  };

  it('shows locked road classes disabled with a lock badge and the tier needed, and opens them at the tier', () => {
    sheet(1);
    const avenue = screen.getByRole('button', { name: /avenue/i }) as HTMLButtonElement;
    expect(avenue.disabled).toBe(true);
    expect(avenue.textContent).toMatch(/Town/);
    expect(avenue.title).toMatch(/Locked: reach Town \(2,000 people\)/);
    expect((screen.getByRole('button', { name: /street/i }) as HTMLButtonElement).disabled).toBe(false);
    cleanup();
    sheet(2);
    expect((screen.getByRole('button', { name: /avenue/i }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/Town/)).toBeNull();
  });

  it('locks high density zoning until City', () => {
    const s = setup(2);
    s.rt.controller.select({ tool: 'zone', zone: 1, density: 0 });
    render(<Tools runtime={s.rt} view={new ViewState()} />);
    const high = screen.getByRole('button', { name: /high/i }) as HTMLButtonElement;
    expect(high.disabled).toBe(true);
    expect(high.textContent).toMatch(/City/);
    expect((screen.getByRole('button', { name: /medium/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('locks the fusion reactor in the utilities group until City', () => {
    const s = setup(2);
    s.rt.controller.select({ tool: 'line', kind: 'power' });
    render(<Tools runtime={s.rt} view={new ViewState()} />);
    const reactor = screen.getByRole('button', { name: /fusion reactor/i }) as HTMLButtonElement;
    expect(reactor.disabled).toBe(true);
    expect(reactor.textContent).toMatch(/City/);
  });
});
