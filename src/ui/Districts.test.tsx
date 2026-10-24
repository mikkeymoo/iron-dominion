import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandBody } from '../sim/commands.ts';
import { DISTRICT_EDICTS, NAME_POOL, STYLES } from '../sim/districtTables.ts';
import type { DistrictStat } from '../sim/protocol.ts';
import { TERRAIN } from '../sim/layers.ts';
import { allocWorld } from '../sim/world.ts';
import type { ToolWorld } from '../render/tools/controller.ts';
import { RenderMirror } from '../render/mirror.ts';
import { ViewState } from '../render/viewState.ts';
import type { Game } from '../render/game.ts';
import { DistrictLabels, DistrictPanel, freeDistrictId, pickDistrict, unusedPool } from './Districts';
import { Tools } from './Tools';
import { ToolsRuntime } from './toolsStore.ts';

afterEach(() => { cleanup(); pickDistrict(0); vi.useRealTimers(); });

const stat = (id: number, over: Partial<DistrictStat> = {}): DistrictStat => ({
  id, name: NAME_POOL[id - 1]!, style: id - 1, edict: 0, tiles: 120, cx: 60, cy: 70, x0: 50, y0: 60, x1: 70, y1: 80, population: 340, jobs: 95, landValue: 88, approval: -1.4, cost: 0, ...over,
});
function client() {
  const sent: CommandBody[] = [];
  return { sent, command: (b: CommandBody) => { sent.push(b); return sent.length; } };
}

describe('DistrictPanel', () => {
  it('explains how to start when there are no districts', () => {
    render(<DistrictPanel districts={[]} client={client()} onClose={() => {}} />);
    expect(screen.getByTestId('district-empty').textContent).toContain('Districts tool');
  });

  it('shows the name, the stats and the edict cost of the district picked, and switches with its tabs', () => {
    const districts = [stat(1, { edict: 1, cost: 120 }), stat(2, { population: 1200, jobs: 15, approval: 2.5 })];
    render(<DistrictPanel districts={districts} client={client()} onClose={() => {}} />);
    expect((screen.getByTestId('district-name') as HTMLInputElement).value).toBe('Rustbelt');
    expect(screen.getByTestId('district-tiles').textContent).toBe('120 tiles');
    expect(screen.getByTestId('district-pop').textContent).toBe('340');
    expect(screen.getByTestId('district-jobs').textContent).toBe('95');
    expect(screen.getByTestId('district-lv').textContent).toBe('88');
    expect(screen.getByTestId('district-approval').textContent).toBe('-1.4 pts');
    expect(screen.getByTestId('district-cost').textContent).toBe('$120 a month');
    expect(screen.getByTestId('district-total').textContent).toBe('2 districts, $120 a month in edicts');
    fireEvent.click(screen.getByTestId('district-tab-2'));
    expect((screen.getByTestId('district-name') as HTMLInputElement).value).toBe('Neon Quarter');
    expect(screen.getByTestId('district-pop').textContent).toBe('1,200');
    expect(screen.getByTestId('district-approval').textContent).toBe('+2.5 pts');
    expect(screen.getByTestId('district-cost').textContent).toBe('None');
  });

  it('sends rename, new-name, style and edict commands for the district shown', () => {
    const c = client();
    render(<DistrictPanel districts={[stat(1), stat(2)]} client={c} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('district-tab-2'));
    const input = screen.getByTestId('district-name') as HTMLInputElement;
    expect(input.maxLength).toBe(20);
    expect((screen.getByTestId('district-rename') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'Old Docks' } });
    fireEvent.click(screen.getByTestId('district-rename'));
    expect(c.sent.at(-1)).toEqual({ type: 'renameDistrict', district: 2, name: 'Old Docks' });
    fireEvent.click(screen.getByTestId('district-shuffle'));
    expect(c.sent.at(-1)).toEqual({ type: 'renameDistrict', district: 2, pool: 2 });
    fireEvent.click(screen.getByTestId('district-style-5'));
    expect(c.sent.at(-1)).toEqual({ type: 'setDistrictStyle', district: 2, style: 5 });
    for (const e of DISTRICT_EDICTS.slice(1)) {
      fireEvent.click(screen.getByTestId(`district-edict-set-${e.id}`));
      expect(c.sent.at(-1)).toEqual({ type: 'setDistrictEdict', district: 2, edict: e.id });
    }
  });

  it('lists the six edicts with price and effects, marks the enacted one and offers every style', () => {
    render(<DistrictPanel districts={[stat(1, { edict: 4, style: 3, cost: 100 })]} client={client()} onClose={() => {}} />);
    expect(DISTRICT_EDICTS).toHaveLength(7);
    for (const e of DISTRICT_EDICTS) expect(screen.getByTestId(`district-edict-${e.id}`)).toBeTruthy();
    const green = screen.getByTestId('district-edict-4');
    expect(green.dataset.active).toBe('true');
    expect(green.textContent).toContain('Green Belt');
    expect(green.textContent).toContain('$100 a month');
    expect(green.textContent).toContain('no new industrial buildings');
    expect((screen.getByTestId('district-edict-set-4') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('district-edict-set-0').textContent).toBe('Repeal');
    expect(screen.getByTestId('district-edict-1').textContent).toContain('$120 a month');
    for (const s of STYLES) expect(screen.getByTestId(`district-style-${s.id}`)).toBeTruthy();
    expect(screen.getByTestId('district-style-3').getAttribute('aria-pressed')).toBe('true');
  });

  it('flies to the district and closes on request', () => {
    const onShow = vi.fn(), onClose = vi.fn();
    render(<DistrictPanel districts={[stat(1)]} client={client()} onClose={onClose} onShow={onShow} />);
    fireEvent.click(screen.getByTestId('district-show'));
    expect(onShow).toHaveBeenCalledWith(60, 70);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('District tool in the build dock', () => {
  function mount(districts: DistrictStat[]) {
    const w = allocWorld();
    w.terrain.fill(TERRAIN.GRASS);
    const sent: CommandBody[] = [];
    const world: ToolWorld = { layers: w as unknown as Record<string, ArrayLike<number>>, scalars: w.scalars, tick: 0, districts };
    const rt = new ToolsRuntime({ world, submit: (b) => { sent.push(b); return sent.length; } });
    const onPanel = vi.fn();
    render(<Tools runtime={rt} view={new ViewState()} layout="desktop" onPanel={onPanel} panel={null} />);
    return { rt, sent, onPanel };
  }

  it('starts on a new district when there are none and offers paint and erase', () => {
    const { rt } = mount([]);
    fireEvent.click(screen.getByTestId('tool-district'));
    expect(rt.controller.sel).toEqual({ tool: 'district', mode: 'paint', district: 1 });
    const strip = within(screen.getByTestId('optstrip'));
    expect(strip.getByTestId('district-paint').getAttribute('aria-pressed')).toBe('true');
    expect(strip.getByTestId('district-new').getAttribute('aria-pressed')).toBe('true');
    expect(strip.queryByTestId('district-manage')).toBeNull();
    fireEvent.click(strip.getByTestId('district-erase'));
    expect(rt.controller.sel).toEqual({ tool: 'district', mode: 'erase', district: 1 });
  });

  it('shows a chip per district, paints into the one chosen, and a drag sends the paint command', () => {
    const { rt, sent, onPanel } = mount([stat(1), stat(2)]);
    fireEvent.click(screen.getByTestId('tool-district'));
    expect(rt.controller.sel, 'with districts but none picked, the tool starts on a new one').toEqual({ tool: 'district', mode: 'paint', district: 3 });
    fireEvent.click(screen.getByTestId('district-chip-2'));
    expect(rt.controller.sel).toEqual({ tool: 'district', mode: 'paint', district: 2 });
    expect(screen.getByTestId('district-chip-2').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('district-chip-1').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('district-chip-1').textContent).toBe('Rustbelt');
    act(() => { rt.controller.dragTiles({ x: 10, y: 10 }, { x: 14, y: 12 }); });
    expect(sent).toEqual([{ type: 'paintDistrict', district: 2, x0: 10, y0: 10, x1: 14, y1: 12 }]);
    fireEvent.click(screen.getByTestId('district-new'));
    expect(rt.controller.sel).toEqual({ tool: 'district', mode: 'paint', district: 3 });
    fireEvent.click(screen.getByTestId('district-manage'));
    expect(onPanel).toHaveBeenCalledWith('districts');
  });

  it('helps pick the next id and the next unused name', () => {
    expect(freeDistrictId([])).toBe(1);
    expect(freeDistrictId([stat(1), stat(3)])).toBe(2);
    expect(freeDistrictId(Array.from({ length: 16 }, (_, i) => stat(i + 1)))).toBe(0);
    expect(unusedPool([stat(1), stat(2)])).toBe(2);
    expect(unusedPool([stat(2, { name: 'Rustbelt' })])).toBe(1);
  });
});

describe('DistrictLabels', () => {
  const fakeGame = (dist: number, at: { px: number; py: number } | null) =>
    ({ current: { debug: { camera: { dist }, project: () => at } } }) as unknown as { current: Game | null };

  it('floats each name at its projected centre at mid zoom, in the style colour', () => {
    const host = document.createElement('div');
    host.className = 'game-host';
    Object.defineProperty(host, 'clientWidth', { value: 1280 });
    Object.defineProperty(host, 'clientHeight', { value: 760 });
    document.body.appendChild(host);
    render(<DistrictLabels districts={[stat(1), stat(2, { style: 2 })]} game={fakeGame(60, { px: 400, py: 300 })} mirror={new RenderMirror()} />);
    const el = screen.getByTestId('district-label-1');
    expect(el.textContent).toBe('Rustbelt');
    expect(el.hidden).toBe(false);
    expect(el.style.transform).toContain('translate(400px, 300px)');
    expect(el.style.opacity).toBe('1');
    expect(screen.getByTestId('district-label-2').style.color).not.toBe('');
    host.remove();
  });

  it('hides at far zoom, when the centre is off screen or behind the camera, and when the game is not up', () => {
    const host = document.createElement('div');
    host.className = 'game-host';
    Object.defineProperty(host, 'clientWidth', { value: 1280 });
    Object.defineProperty(host, 'clientHeight', { value: 760 });
    document.body.appendChild(host);
    const hidden = (game: { current: Game | null }): boolean => {
      cleanup();
      render(<DistrictLabels districts={[stat(1)]} game={game} mirror={new RenderMirror()} />);
      return screen.getByTestId('district-label-1').hidden;
    };
    expect(hidden(fakeGame(300, { px: 400, py: 300 }))).toBe(true);
    expect(hidden(fakeGame(60, null))).toBe(true);
    expect(hidden(fakeGame(60, { px: -20, py: 300 }))).toBe(true);
    expect(hidden(fakeGame(60, { px: 400, py: 900 }))).toBe(true);
    expect(hidden({ current: null })).toBe(true);
    expect(hidden(fakeGame(60, { px: 400, py: 300 }))).toBe(false);
    host.remove();
  });
});
