import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rciId } from '../sim/catalog.ts';
import type { SimClient } from '../sim/client.ts';
import type { CommandBody } from '../sim/commands.ts';
import { DIRECTIVES, DIRECTIVE_COUNT, directiveIndex } from '../sim/directives.ts';
import { createSim } from '../sim/engine.ts';
import type { DirectiveStats } from '../sim/protocol.ts';
import { DEFAULT_SETTINGS, type Settings } from '../platform/settings.ts';
import { RenderMirror } from '../render/mirror.ts';
import { DirectiveCard } from './DirectiveCard';
import { DIRECTIVE_COPY, copyGaps } from './directiveCopy.ts';
import { ToolsRuntime } from './toolsStore.ts';

afterEach(() => { cleanup(); vi.useRealTimers(); });

const zeros = (): number[] => DIRECTIVES.map(() => 0);
const stats = (claimed: number, done: number, have: number[] = zeros()): DirectiveStats => ({ claimed, done, have });
const bit = (id: string): number => 1 << directiveIndex(id);
const before = (id: string): number => bit(id) - 1;
const withHave = (id: string, n: number): number[] => { const h = zeros(); h[directiveIndex(id)] = n; return h; };

interface Options { stats?: DirectiveStats; state?: Settings['onboarding']; collapseOnShow?: boolean; home?: { x: number; y: number } }

function setup(over: Options = {}) {
  const sim = createSim(42, { starter: true });
  const mirror = new RenderMirror();
  for (const name of Object.keys(mirror.layers)) {
    const src = (sim.world as unknown as Record<string, ArrayLike<number>>)[name];
    if (src) (mirror.layers[name] as unknown as { set(a: ArrayLike<number>): void }).set(src);
  }
  mirror.scalars.set(sim.world.scalars);
  if (over.home) {
    const L = mirror.layers as Record<string, Uint8Array | Uint16Array>;
    L.bArch![7] = rciId(1, 0, 1); L.bX![7] = over.home.x; L.bY![7] = over.home.y; L.bW![7] = 1; L.bH![7] = 1;
  }
  const sent: CommandBody[] = [];
  const client = { command: (b: CommandBody) => { sent.push(b); return sent.length; } } as unknown as SimClient;
  const tools = new ToolsRuntime({ world: mirror, submit: () => 1 });
  const glide = vi.fn(), onProjects = vi.fn(), onPick = vi.fn(), onChange = vi.fn();
  const state = over.state ?? DEFAULT_SETTINGS.onboarding;
  const ui = (s: DirectiveStats, st: Settings['onboarding'] = state) => (
    <DirectiveCard stats={s} population={0} treasury={50000} state={st} onChange={onChange} client={client} tools={tools} mirror={mirror} glide={glide} onProjects={onProjects} onPick={onPick} collapseOnShow={over.collapseOnShow} />
  );
  const view = render(ui(over.stats ?? stats(0, 0)));
  return { ...view, ui, sent, tools, glide, onProjects, onPick, onChange };
}

describe('UNIT-0 copy', () => {
  it('has a line for every directive and none for a directive that does not exist', () => {
    expect(copyGaps()).toEqual({ missing: [], extra: [] });
  });

  it('keeps every line short and free of em dashes', () => {
    for (const [id, c] of Object.entries(DIRECTIVE_COPY)) {
      for (const text of [c.title, c.say, c.done, c.progress(1, 10, { population: 5, treasury: 100 })]) {
        expect(text, id).not.toMatch(/—/);
        expect(text.length, id).toBeLessThan(160);
      }
    }
  });
});

describe('the directive card', () => {
  it('opens on the first directive with UNIT-0 speaking, its progress and its reward', () => {
    setup({ stats: stats(0, 0, withHave('road', 4)) });
    expect(screen.getByRole('heading', { name: 'UNIT-0' })).toBeTruthy();
    expect(screen.getByTestId('directive-step').textContent).toBe(`Directive 1 of ${DIRECTIVE_COUNT}`);
    expect(screen.getByTestId('directive-say').textContent).toMatch(/foreman/);
    expect(screen.getByTestId('directive-progress').textContent).toBe('4 of 10 road tiles reach the depot');
    expect(screen.getByTestId('directive-reward').textContent).toBe('Reward $300');
    expect(screen.queryByTestId('directive-claim')).toBeNull();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('40');
  });

  it('moves to the next directive once the first reward is claimed', () => {
    setup({ stats: stats(bit('road'), bit('road')) });
    expect(screen.getByTestId('directive-card').getAttribute('data-index')).toBe(String(directiveIndex('residential')));
    expect(screen.getByTestId('directive-step').textContent).toBe(`Directive 2 of ${DIRECTIVE_COUNT}`);
  });

  it('offers a claim button for a met directive, sends claimDirective for it, and cannot be pressed twice', () => {
    const { sent, ui, rerender } = setup({ stats: stats(0, bit('road'), withHave('road', 10)) });
    const btn = screen.getByTestId('directive-claim') as HTMLButtonElement;
    expect(btn.textContent).toBe('Claim $300');
    expect(screen.queryByTestId('directive-show')).toBeNull();
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(sent).toEqual([{ type: 'claimDirective', index: 0 }]);
    expect(btn.disabled).toBe(true);
    rerender(ui(stats(1, 1)));
    expect(screen.queryByTestId('directive-claim')).toBeNull();
  });

  it('shows the directive as met from the progress alone, before the sim has latched it', () => {
    setup({ stats: stats(0, 0, withHave('road', 10)) });
    expect(screen.getByTestId('directive-claim')).toBeTruthy();
  });

  it('"Show me" selects the tool, puts the ghost at the suggested spot and flies the camera there', () => {
    const { tools, glide, onPick } = setup();
    fireEvent.click(screen.getByTestId('directive-show'));
    expect(onPick).toHaveBeenCalled();
    expect(tools.controller.sel).toEqual({ tool: 'road', cls: 1 });
    expect(tools.controller.plan?.cmd.type).toBe('placeRoad');
    expect(glide).toHaveBeenCalledTimes(1);
    const [x, y] = glide.mock.calls[0]!;
    expect(Math.hypot(x - 128, y - 128)).toBeLessThan(120);
  });

  it('"Show me" on the last directive opens the Projects panel instead of picking a tool', () => {
    const all = before('megaproject');
    const { onProjects, tools } = setup({ stats: stats(all, all) });
    fireEvent.click(screen.getByTestId('directive-show'));
    expect(onProjects).toHaveBeenCalled();
    expect(tools.controller.sel).toBeNull();
  });

  it('folds to a chip that shows the step, and opens again on a tap', () => {
    const { onChange } = setup({ state: { ...DEFAULT_SETTINGS.onboarding, collapsed: true } });
    const chip = screen.getByTestId('directive-chip');
    expect(chip.textContent).toBe(`UNIT-0 1/${DIRECTIVE_COUNT}`);
    fireEvent.click(chip);
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS.onboarding, collapsed: false });
  });

  it('tells a collapsed player a reward is waiting', () => {
    setup({ state: { ...DEFAULT_SETTINGS.onboarding, collapsed: true }, stats: stats(0, bit('road')) });
    expect(screen.getByTestId('directive-chip').textContent).toBe('UNIT-0 Claim!');
  });

  it('collapses and dismisses through the settings, and renders nothing once dismissed', () => {
    const { onChange, container, ui, rerender } = setup();
    fireEvent.click(screen.getByTestId('directive-collapse'));
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS.onboarding, collapsed: true });
    fireEvent.click(screen.getByTestId('directive-dismiss'));
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS.onboarding, dismissed: true });
    rerender(ui(stats(0, 0), { ...DEFAULT_SETTINGS.onboarding, dismissed: true }));
    expect(container.innerHTML).toBe('');
  });

  it('on a phone, "Show me" folds the card to its chip so the map stays visible', () => {
    const { onChange } = setup({ collapseOnShow: true });
    fireEvent.click(screen.getByTestId('directive-show'));
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS.onboarding, collapsed: true });
  });

  it('says goodbye when the last reward is paid, then dismisses itself', () => {
    vi.useFakeTimers();
    const s = setup({ stats: stats(0, 0) });
    const every = (1 << DIRECTIVE_COUNT) - 1;
    s.rerender(s.ui(stats(every, every)));
    expect(screen.getByTestId('directive-say').textContent).toMatch(/every directive/);
    expect(screen.getByTestId('directive-step').textContent).toBe('All directives done');
    act(() => { vi.advanceTimersByTime(6000); });
    expect(s.onChange).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS.onboarding, dismissed: true });
  });

  it('nudges the camera to the first home once, when its site appears', () => {
    const s = setup({ stats: stats(before('firstHome'), before('firstHome')), home: { x: 90, y: 91 } });
    expect(s.glide).toHaveBeenCalledTimes(1);
    expect(s.glide).toHaveBeenCalledWith(90, 91);
    s.rerender(s.ui(stats(before('firstHome'), before('firstHome'), withHave('road', 10))));
    expect(s.glide).toHaveBeenCalledTimes(1);
  });

  it('does not nudge while another directive is open, or when no home exists yet', () => {
    const a = setup({ home: { x: 90, y: 91 } });
    expect(a.glide).not.toHaveBeenCalled();
    cleanup();
    const b = setup({ stats: stats(before('firstHome'), before('firstHome')) });
    expect(b.glide).not.toHaveBeenCalled();
  });
});
