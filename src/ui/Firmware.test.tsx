import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandBody } from '../sim/commands.ts';
import { EDICT, EDICTS, MAX_EDICTS, MODULE, NODE, RESEARCH_NODES } from '../sim/firmware.ts';
import type { BuildingInfo, FirmwareStats } from '../sim/protocol.ts';
import { DepotModules } from './DepotModules';
import { EdictsPanel, FirmwareMenuRows, ResearchPanel, effectText } from './FirmwarePanels';

afterEach(cleanup);

const bit = (...n: number[]): number => n.reduce((m, k) => m | (1 << k), 0);
const stats = (over: Partial<FirmwareStats> = {}): FirmwareStats => ({
  rp: 0, rpPerMonth: { population: 4, directives: 2, labs: 6, total: 12 }, labs: 1, research: 0, researchCount: 0, edicts: 0, edictsActive: 0, modules: [0, 0, 0, 0], ...over,
});
function client() {
  const sent: CommandBody[] = [];
  return { sent, command: (b: CommandBody) => { sent.push(b); return sent.length; } };
}

describe('ResearchPanel', () => {
  it('shows the points, the monthly income and all twelve nodes in three branches', () => {
    render(<ResearchPanel stats={stats({ rp: 75 })} client={client()} onClose={() => {}} />);
    expect(screen.getByTestId('research-points').textContent).toBe('75');
    expect(screen.getByTestId('research-income').textContent).toBe('+12 a month');
    expect(RESEARCH_NODES).toHaveLength(12);
    for (const n of RESEARCH_NODES) expect(screen.getByTestId(`node-${n.id}`).textContent).toContain(n.name);
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['Logistics branch', 'Construction branch', 'Civic branch']);
  });

  it('marks owned, ready, short and locked nodes and enables only the ones that can be bought', () => {
    render(<ResearchPanel stats={stats({ rp: 70, research: bit(NODE.HEAVY_LIFTERS) })} client={client()} onClose={() => {}} />);
    expect(screen.getByTestId(`node-${NODE.HEAVY_LIFTERS}`).dataset.state).toBe('owned');
    expect(screen.queryByTestId(`research-${NODE.HEAVY_LIFTERS}`)).toBeNull();
    expect(screen.getByTestId(`node-${NODE.ROTOR_UPGRADE}`).dataset.state).toBe('ready');
    expect(screen.getByTestId(`research-${NODE.ROTOR_UPGRADE}`)).toHaveProperty('disabled', false);
    expect(screen.getByTestId(`node-${NODE.QUICK_SET}`).dataset.state).toBe('ready');
    expect(screen.getByTestId(`node-${NODE.FLEET_SHARE}`).dataset.state).toBe('ready');
    expect(screen.getByTestId(`node-${NODE.DEPOT_FAB}`).dataset.state).toBe('locked');
    expect(screen.getByTestId(`research-${NODE.DEPOT_FAB}`)).toHaveProperty('disabled', true);
    expect(screen.getByTestId(`research-${NODE.DEPOT_FAB}`).textContent).toContain('Needs Rotor upgrade');
  });

  it('shows how many points a node is short, and keeps its button off', () => {
    render(<ResearchPanel stats={stats({ rp: 10 })} client={client()} onClose={() => {}} />);
    const b = screen.getByTestId(`research-${NODE.HEAVY_LIFTERS}`);
    expect(b).toHaveProperty('disabled', true);
    expect(b.textContent).toBe('20 RP short');
  });

  it('sends the research command for the node pressed, and closes on Escape', () => {
    const c = client(), onClose = vi.fn();
    render(<ResearchPanel stats={stats({ rp: 500 })} client={c} onClose={onClose} />);
    fireEvent.click(screen.getByTestId(`research-${NODE.QUICK_SET}`));
    expect(c.sent).toEqual([{ type: 'research', node: NODE.QUICK_SET }]);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('copes with a missing stats message (before the first one arrives)', () => {
    render(<ResearchPanel stats={undefined} client={client()} onClose={() => {}} />);
    expect(screen.getByTestId('research-points').textContent).toBe('0');
  });
});

describe('EdictsPanel', () => {
  it('lists all eight edicts with their upside, downside and cost in numbers', () => {
    render(<EdictsPanel stats={stats()} tier={5} client={client()} onClose={() => {}} />);
    expect(EDICTS).toHaveLength(8);
    for (const e of EDICTS) {
      const card = screen.getByTestId(`edict-${e.id}`);
      expect(card.textContent).toContain(e.name);
      for (const x of e.effects) expect(card.textContent).toContain(effectText(x));
      expect(card.textContent).toContain(e.cost > 0 ? `$${e.cost} a month` : 'No fee');
    }
    const night = screen.getByTestId(`edict-${EDICT.NIGHT_SHIFT}`);
    expect(night.querySelectorAll('.up')).toHaveLength(1);
    expect(night.querySelectorAll('.down')).toHaveLength(2);
    expect(night.textContent).toContain('+40% build speed at night');
    expect(night.textContent).toContain('-3 pts approval');
    expect(screen.getByTestId(`edict-${EDICT.CURFEW}`).textContent).toContain('-25% crime');
    expect(screen.getByTestId(`edict-${EDICT.CURFEW}`).textContent).toContain('-10% commercial income');
  });

  it('counts the active edicts and sends the toggle by edict number', () => {
    const c = client();
    const { rerender } = render(<EdictsPanel stats={stats()} tier={5} client={c} onClose={() => {}} />);
    expect(screen.getByTestId('edicts-count').textContent).toBe(`0 of ${MAX_EDICTS} active`);
    fireEvent.click(screen.getByTestId(`edict-toggle-${EDICT.TAX_HOLIDAY}`));
    expect(c.sent).toEqual([{ type: 'toggleEdict', edict: EDICT.TAX_HOLIDAY }]);
    rerender(<EdictsPanel stats={stats({ edicts: bit(EDICT.TAX_HOLIDAY), edictsActive: 1 })} tier={5} client={c} onClose={() => {}} />);
    expect(screen.getByTestId('edicts-count').textContent).toBe('1 of 4 active');
    expect(screen.getByTestId(`edict-${EDICT.TAX_HOLIDAY}`).dataset.active).toBe('true');
    expect(screen.getByTestId(`edict-toggle-${EDICT.TAX_HOLIDAY}`).textContent).toBe('Repeal');
  });

  it('greys out an edict the tier does not reach, and every inactive one once four are active', () => {
    const { rerender } = render(<EdictsPanel stats={stats()} tier={1} client={client()} onClose={() => {}} />);
    const locked = screen.getByTestId(`edict-toggle-${EDICT.GREEN_ROOFS}`);
    expect(locked).toHaveProperty('disabled', true);
    expect(locked.textContent).toBe('Unlocks at City');
    expect(screen.getByTestId(`edict-toggle-${EDICT.TAX_HOLIDAY}`)).toHaveProperty('disabled', false);
    const four = bit(EDICT.NIGHT_SHIFT, EDICT.OVERCLOCK, EDICT.CURFEW, EDICT.TAX_HOLIDAY);
    rerender(<EdictsPanel stats={stats({ edicts: four, edictsActive: 4 })} tier={5} client={client()} onClose={() => {}} />);
    expect(screen.getByTestId(`edict-toggle-${EDICT.RECYCLING}`)).toHaveProperty('disabled', true);
    expect(screen.getByTestId(`edict-toggle-${EDICT.RECYCLING}`).textContent).toBe('Four are active');
    expect(screen.getByTestId(`edict-toggle-${EDICT.CURFEW}`)).toHaveProperty('disabled', false);
  });
});

describe('effectText', () => {
  it('prints signs, percent, points, dollars and seconds', () => {
    expect(effectText({ key: 'a', label: 'x', value: 40, unit: '%', good: true })).toBe('+40% x');
    expect(effectText({ key: 'a', label: 'x', value: -25, unit: '%', good: true })).toBe('-25% x');
    expect(effectText({ key: 'a', label: 'x', value: 5, unit: 'pts', good: true })).toBe('+5 pts x');
    expect(effectText({ key: 'a', label: 'x', value: 2, unit: '$', good: false })).toBe('$2 x');
    expect(effectText({ key: 'a', label: 'x', value: 3, unit: 's', good: false })).toBe('3 s x');
    expect(effectText({ key: 'a', label: 'x', value: 0.4, unit: '%', good: false })).toBe('+0.4% x');
  });
});

describe('FirmwareMenuRows', () => {
  it('shows the points and the active edicts, and opens each panel', () => {
    const onPanel = vi.fn();
    render(<FirmwareMenuRows stats={stats({ rp: 1234, edictsActive: 2 })} onPanel={onPanel} />);
    expect(screen.getByTestId('research-menu').textContent).toBe('Research (1,234 RP)');
    expect(screen.getByTestId('edicts-menu').textContent).toBe('Edicts (2 of 4 active)');
    fireEvent.click(screen.getByTestId('research-menu'));
    fireEvent.click(screen.getByTestId('edicts-menu'));
    expect(onPanel.mock.calls).toEqual([['research'], ['edicts']]);
  });
});

describe('DepotModules', () => {
  const depot = (modules: [number, number], over: Partial<NonNullable<BuildingInfo['depot']>> = {}): NonNullable<BuildingInfo['depot']> =>
    ({ radius: 40, builders: 4, haulers: 4, stock: 40, builderCap: 4, haulerCap: 4, droneCap: 0, modules, ...over });

  it('shows the robot caps and a button per module in each of the two slots', () => {
    render(<DepotModules slot={3} depot={depot([MODULE.BUILDER_BAY, 0], { builderCap: 6, droneCap: 1 })} controls={{ treasury: 5000, set: () => {} }} />);
    expect(screen.getByTestId('depot-caps').textContent).toContain('Keeps 6 builders');
    expect(screen.getByTestId('depot-caps').textContent).toContain('1 fire drone');
    const slot0 = screen.getByTestId('module-slot-0');
    expect(within(slot0).getAllByRole('button')).toHaveLength(5);
    expect(screen.getByTestId(`module-0-${MODULE.BUILDER_BAY}`).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId(`module-1-${MODULE.NONE}`).getAttribute('aria-pressed')).toBe('true');
  });

  it('sends setDepotModule for the slot and module pressed, not for the one already fitted', () => {
    const set = vi.fn();
    render(<DepotModules slot={3} depot={depot([MODULE.BUILDER_BAY, 0])} controls={{ treasury: 5000, set }} />);
    fireEvent.click(screen.getByTestId(`module-0-${MODULE.BUILDER_BAY}`));
    expect(set).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId(`module-1-${MODULE.WORKSHOP}`));
    expect(set).toHaveBeenCalledWith(3, 1, MODULE.WORKSHOP);
    fireEvent.click(screen.getByTestId(`module-0-${MODULE.NONE}`));
    expect(set).toHaveBeenCalledWith(3, 0, MODULE.NONE);
  });

  it('disables a module the treasury cannot pay for, and shows the refund for clearing a slot', () => {
    render(<DepotModules slot={0} depot={depot([MODULE.WORKSHOP, 0])} controls={{ treasury: 100, set: () => {} }} />);
    expect(screen.getByTestId(`module-1-${MODULE.DRONE_NEST}`)).toHaveProperty('disabled', true);
    expect(screen.getByTestId(`module-0-${MODULE.NONE}`)).toHaveProperty('disabled', false);
    expect(screen.getByTestId(`module-0-${MODULE.NONE}`).textContent).toContain('refund $300');
  });
});
