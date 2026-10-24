import { useEffect, useRef, useState } from 'react';
import type { SimClient } from '../sim/client.ts';
import { startGame, type Game, type PerfSnapshot } from '../render/game.ts';
import type { AgentStore } from '../render/agentStore.ts';
import type { RenderMirror } from '../render/mirror.ts';
import type { ViewState } from '../render/viewState.ts';
import type { Lifecycle } from '../platform/lifecycle.ts';
import { bindLifecycleDom } from '../platform/lifecycle.ts';
import type { Settings } from '../platform/settings.ts';
import { SpeakerToggle } from '../audio/ui.tsx';
import { Budget } from './Budget';
import { Hud, type HudStats } from './Hud';
import { Tools } from './Tools';
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
  const [panel, setPanel] = useState(true);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [following, setFollowing] = useState(false);
  const game = useRef<Game | null>(null);

  useEffect(() => {
    let cancelled = false;
    const el = host.current;
    if (!el) return;
    const fail = (message: string): void => { setError(message); setPhase('failed'); };
    startGame({ host: el, mirror, client, agents, tools: tools.controller, view, search: window.location.search, onFatal: fail })
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === '`') setPanel((p) => !p); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
        <Hud lifecycle={lifecycle} stats={stats} settings={settings} notice={notice} budgetOpen={budgetOpen} onBudget={() => setBudgetOpen((o) => !o)} follow={phase === 'running' ? { active: following, toggle: () => { const g = game.current; if (g) setFollowing(g.debug.follow(!g.debug.following)); } } : undefined} onSave={onSave} onSaveAs={onSaveAs} onExport={onExport} onSetting={onSetting} onQuit={onExit} quitPrompt={quitPrompt} onQuitSaveAs={onQuitSaveAs} onQuitDiscard={onQuitDiscard} onQuitCancel={onQuitCancel} />
        {phase === 'running' && <Tools runtime={tools} view={view} />}
        {budgetOpen && <Budget client={client} events={tools} stats={stats} onClose={() => setBudgetOpen(false)} />}
        <SpeakerToggle settings={settings} onSetting={onSetting} />
        <button className="perf-toggle" type="button" aria-pressed={panel} onClick={() => setPanel((p) => !p)} title="Performance panel (`)">fps</button>
        {panel && perf && (
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
