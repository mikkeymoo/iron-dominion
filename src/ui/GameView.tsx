import { useCallback, useEffect, useRef, useState } from 'react';
import type { SimClient } from '../sim/client.ts';
import { startGame, type Game, type PerfSnapshot } from '../render/game.ts';
import type { AgentStore } from '../render/agentStore.ts';
import type { RenderMirror } from '../render/mirror.ts';
import type { ViewState } from '../render/viewState.ts';
import type { Lifecycle } from '../platform/lifecycle.ts';
import { bindLifecycleDom } from '../platform/lifecycle.ts';
import type { Settings } from '../platform/settings.ts';
import { Budget } from './Budget';
import { Hud, type HudStats } from './Hud';
import { Checklist } from './Checklist';
import { useLayout } from './layout';
import { useOutsideDismiss, type PanelId } from './panels';
import { factsFromLayers, type CityFacts } from './progress';
import { Tools, type ToolHints } from './Tools';
import type { ToolsRuntime } from './toolsStore.ts';

interface Props {
  client: SimClient;
  mirror: RenderMirror;
  agents: AgentStore;
  tools: ToolsRuntime;
  view: ViewState;
  lifecycle: Lifecycle;
  stats: HudStats;
  settings: Settings;
  notice: string;
  tick: number;
  worker: 'loading' | 'ready' | 'failed';
  onExit: () => void;
  quitPrompt: string | null;
  onQuitSaveAs(name: string): void;
  onQuitDiscard(): void;
  onQuitCancel(): void;
  onSave(): void;
  onSaveAs(name: string): void;
  onExport(): void;
  onSetting<K extends keyof Settings>(key: K, value: Settings[K]): void;
}

type Phase = 'starting' | 'running' | 'failed';

export function GameView({ client, mirror, agents, tools, view, lifecycle, stats, settings, notice, tick, worker, onExit, quitPrompt, onQuitSaveAs, onQuitDiscard, onQuitCancel, onSave, onSaveAs, onExport, onSetting }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>('starting');
  const [error, setError] = useState('');
  const [perf, setPerf] = useState<PerfSnapshot | null>(null);
  const layout = useLayout();
  const [facts, setFacts] = useState<CityFacts | null>(null);
  const [panel, setPanel] = useState<PanelId | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const budgetOpen = panel === 'budget';
  const [following, setFollowing] = useState(false);
  const game = useRef<Game | null>(null);

  useEffect(() => {
    let cancelled = false;
    const el = host.current;
    if (!el) return;
    const fail = (message: string): void => { setError(message); setPhase('failed'); };
    startGame({ host: el, mirror, client, agents, tools: tools.controller, view, search: window.location.search, onFatal: fail, onTier: (t) => onSetting('autoTier', t) })
      .then((g) => {
        if (cancelled) { g.dispose(); return; }
        game.current = g;
        if (window.__iron) window.__iron.render = g.debug;
        setPhase('running');
      })
      .catch((e: unknown) => { if (!cancelled) fail(e instanceof Error ? e.message : String(e)); });
    return () => {
      cancelled = true;
      game.current?.dispose();
      game.current = null;
      if (window.__iron) delete window.__iron.render;
    };
  }, [client, mirror, agents, tools, view]);

  useEffect(() => {
    if (phase !== 'running') return;
    const id = window.setInterval(() => { const g = game.current; if (g) { setPerf(g.perf()); setFollowing(g.debug.following); } }, 250);
    return () => window.clearInterval(id);
  }, [phase]);

  useEffect(() => bindLifecycleDom(lifecycle, document, window), [lifecycle]);

  const perfOn = settings.showPerf ?? layout === 'desktop';
  const perfRef = useRef(perfOn);
  perfRef.current = perfOn;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === '`') onSetting('showPerf', !perfRef.current); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSetting]);

  useEffect(() => {
    const read = (): void => { if (mirror.hasResync) setFacts(factsFromLayers(mirror.layers)); };
    read();
    const id = window.setInterval(read, 500);
    return () => window.clearInterval(id);
  }, [mirror]);

  const onboarding = settings.onboarding;
  const setOnboarding = useCallback((next: typeof onboarding): void => onSetting('onboarding', next), [onSetting]);
  const phone = layout === 'phone';
  // A phone folds the checklist to its chip until the player opens it; the persisted state is what a desktop keeps.
  const listState = phone ? { ...onboarding, collapsed: !listOpen } : onboarding;
  const onList = (next: typeof onboarding): void => {
    if (!phone) { setOnboarding(next); return; }
    setListOpen(!next.collapsed);
    if (next.dismissed !== onboarding.dismissed) setOnboarding({ ...onboarding, dismissed: next.dismissed });
  };
  const closeFloating = (): void => {
    setPanel(null);
    if (phone) { setListOpen(false); if (perfOn) onSetting('showPerf', false); }
  };
  useOutsideDismiss(panel !== null || (phone && (listOpen || perfOn)), closeFloating, closeFloating);
  const setTopOpen = (open: boolean): void => onSetting('panels', { ...settings.panels, topOpen: open });
  const hints: ToolHints = {
    seen: onboarding.hintsSeen,
    mark: (id) => { if (!onboarding.hintsSeen.includes(id)) onSetting('onboarding', { ...onboarding, hintsSeen: [...onboarding.hintsSeen, id] }); },
  };

  return (
    <div className="game" data-render={phase} data-worker={worker}>
      <div className="game-host" ref={host} />
      {phase === 'failed' && (
        <div className="game-error" role="alert">
          <h2>The 3D view could not start</h2>
          <p>Iron Dominion needs WebGL2 or WebGPU. Try a current Chrome, Edge, Safari or Firefox, and check that hardware acceleration is on.</p>
          <p className="detail">{error}</p>
          <button className="primary" type="button" onClick={onExit}>Back to title</button>
        </div>
      )}
      {phase === 'starting' && <div className="game-loading">Loading the world...</div>}
      <div className="hud">
        <Hud lifecycle={lifecycle} stats={stats} settings={settings} notice={notice} budgetOpen={budgetOpen} onBudget={() => setPanel((p) => (p === 'budget' ? null : 'budget'))} follow={phase === 'running' ? { active: following, toggle: () => { const g = game.current; if (g) setFollowing(g.debug.follow(!g.debug.following)); } } : undefined} onSave={onSave} onSaveAs={onSaveAs} onExport={onExport} onSetting={onSetting} onQuit={onExit} quitPrompt={quitPrompt} onQuitSaveAs={onQuitSaveAs} onQuitDiscard={onQuitDiscard} onQuitCancel={onQuitCancel} facts={facts ?? undefined} perfOn={perfOn} onPerf={(on) => onSetting('showPerf', on)} layout={layout} activeTier={perf?.tier} panel={panel} onPanel={setPanel} topOpen={settings.panels.topOpen} onTopOpen={setTopOpen} />
        {phase === 'running' && facts && <Checklist facts={facts} state={listState} onChange={onList} onPick={(t) => { setPanel(null); tools.controller.select(t); }} collapseOnPick={phone} />}
        {phase === 'running' && <Tools runtime={tools} view={view} hints={hints} layout={layout} panel={panel} onPanel={setPanel} autoCollapse={settings.panels.autoCollapse} />}
        {budgetOpen && <Budget client={client} events={tools} stats={stats} onClose={() => setPanel(null)} />}
        {perfOn && perf && (
          <dl className="perf" data-testid="perf">
            <dt>backend</dt><dd>{perf.backend}</dd>
            <dt>tier</dt><dd>{perf.tier}</dd>
            <dt>fps</dt><dd>{perf.fps.toFixed(0)}</dd>
            <dt>draw calls</dt><dd>{perf.drawCalls}</dd>
            <dt>triangles</dt><dd>{perf.triangles.toLocaleString('en-US')}</dd>
            <dt>sim tick</dt><dd>{tick}</dd>
            <dt>buildings</dt><dd>{perf.buildings.instances} near / {perf.buildings.farInstances} far / {perf.buildings.drawCalls} draws</dd>
            <dt>chunks</dt><dd>{perf.fineChunks} fine / {perf.coarseSupers} far</dd>
          </dl>
        )}
      </div>
    </div>
  );
}
