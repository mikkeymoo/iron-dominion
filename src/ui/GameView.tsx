import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RadialHost } from '../render/input.ts';
import { RadialController, type RadialItem } from '../render/radial.ts';
import type { SimClient } from '../sim/client.ts';
import { startGame, type Game, type PerfSnapshot } from '../render/game.ts';
import type { AgentStore } from '../render/agentStore.ts';
import type { RenderMirror } from '../render/mirror.ts';
import type { ViewState } from '../render/viewState.ts';
import type { Lifecycle } from '../platform/lifecycle.ts';
import { bindLifecycleDom } from '../platform/lifecycle.ts';
import type { Settings } from '../platform/settings.ts';
import { AudioSync } from '../audio/ui.tsx';
import { AwayCard } from './AwayCard';
import type { AwayStore } from './away.ts';
import { BlueprintQueue } from './BlueprintQueue';
import { Budget } from './Budget';
import { CouncilPanel } from './Council';
import { Hud, type HudStats } from './Hud';
import { DirectiveCard } from './DirectiveCard';
import { DistrictLabels, DistrictPanel } from './Districts';
import { EdictsPanel, ResearchPanel } from './FirmwarePanels';
import { ForecastUi } from './Forecast';
import { GoalChip } from './GoalChip';
import { HallOfBots } from './HallOfBots';
import { PacingUi } from './PacingUi';
import type { PacingStore } from './pacing.ts';
import { Results } from './Results';
import type { ScoreUpdate } from '../platform/scores.ts';
import { useLayout } from './layout';
import { Banner, MilestonesPanel } from './Milestones';
import { PanelStateContext, type PanelStateStore } from './Panel';
import { useOutsideDismiss, type PanelId } from './panels';
import { PhotoMode } from './PhotoMode';
import { factsFromLayers, type CityFacts } from './progress';
import { RadialMenu } from './RadialMenu';
import { bulldozeTile, radialItemsFor, radialTargetAt, type RadialEntry, type RadialTarget } from './radialItems';
import { useLeaveFocusOnOpen } from './focusReset.ts';
import { ServicesPanel } from './ServicesPanel';
import { Tools, type ToolHints } from './Tools';
import type { SandboxDisaster, ToolsRuntime } from './toolsStore.ts';
import { WhyUi } from './WhyUi';
import type { WhyStore } from './whyStore.ts';

interface Props {
  client: SimClient;
  mirror: RenderMirror;
  agents: AgentStore;
  tools: ToolsRuntime;
  why: WhyStore;
  view: ViewState;
  lifecycle: Lifecycle;
  away: AwayStore;
  pacing: PacingStore;
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
  /** Scenario hooks: the stored record after this run, the next scenario's name, and what the results screen's buttons do. Absent in a sandbox city. */
  scenario?: { result: ScoreUpdate | null; nextName?: string; onRetry(): void; onNext(): void; onBack(): void };
}

type Phase = 'starting' | 'running' | 'failed';

export function GameView({ client, mirror, agents, tools, why, view, lifecycle, away, pacing, stats, settings, notice, tick, worker, onExit, quitPrompt, onQuitSaveAs, onQuitDiscard, onQuitCancel, onSave, onSaveAs, onExport, onSetting, scenario }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [resultsHidden, setResultsHidden] = useState(false);
  const [phase, setPhase] = useState<Phase>('starting');
  const [error, setError] = useState('');
  const [perf, setPerf] = useState<PerfSnapshot | null>(null);
  const layout = useLayout();
  const [facts, setFacts] = useState<CityFacts | null>(null);
  const [panel, setPanel] = useState<PanelId | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const budgetOpen = panel === 'budget';
  const servicesOpen = panel === 'services';
  const projectsOpen = panel === 'projects';
  const [following, setFollowing] = useState(false);
  const [photoOn, setPhotoOn] = useState(false);
  const [touring, setTouring] = useState(false);
  const game = useRef<Game | null>(null);
  const [perfHidden, setPerfHidden] = useState(false);
  const photoRef = useRef(false);
  photoRef.current = photoOn;
  const focus = settings.focus;
  useLeaveFocusOnOpen(settings, onSetting);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const runRadial = useCallback((entry: RadialEntry, target: RadialTarget): void => {
    const a = entry.action;
    switch (a.kind) {
      case 'tool': tools.controller.select(a.sel); break;
      case 'roadUpgrade':
        tools.controller.select({ tool: 'road', cls: a.cls });
        tools.toast('Drag along the road to upgrade it.', 'hint');
        break;
      case 'bulldoze': bulldozeTile(tools.controller, target.tile); break;
      case 'info': if (target.kind === 'building') why.tap({ kind: 'building', slot: target.slot, x: target.tile.x, y: target.tile.y }); break;
      case 'follow': { const g = game.current; if (g) setFollowing(g.debug.follow(true)); break; }
      case 'upgrade': break;
    }
  }, [tools, why]);
  const radial = useMemo(() => new RadialController<RadialTarget>(
    (item: RadialItem, target) => runRadial(item as RadialEntry, target),
    () => { const el = host.current; return { w: el?.clientWidth || window.innerWidth, h: el?.clientHeight || window.innerHeight }; },
  ), [runRadial]);
  const radialHost = useMemo<RadialHost>(() => ({
    isOpen: () => radial.isOpen,
    open: (px, py, source) => {
      const g = game.current;
      if (!g || photoRef.current) return false;
      const tile = g.debug.pickTile(px, py);
      if (!tile) return false;
      const layers = mirror.layers as unknown as Record<string, ArrayLike<number>>;
      const target = radialTargetAt(layers, tile);
      setPanel(null);
      return radial.open({ x: px, y: py }, radialItemsFor(target, { tier: tools.tier, canFollow: true }), target, source);
    },
    move: (x, y) => radial.move({ x, y }),
    release: (x, y) => { radial.release({ x, y }); },
    close: () => radial.close(),
  }), [radial, mirror, tools]);
  useEffect(() => { if (photoOn) radial.close(); }, [photoOn, radial]);
  useEffect(() => () => radial.close(), [radial]);

  useEffect(() => {
    let cancelled = false;
    let unsubPhoto: (() => void) | undefined;
    const el = host.current;
    if (!el) return;
    const fail = (message: string): void => { setError(message); setPhase('failed'); };
    startGame({ host: el, mirror, client, agents, tools: tools.controller, view, search: window.location.search, onFatal: fail, onTier: (t) => onSetting('autoTier', t), onTap: (t) => why.tap(t), radial: radialHost })
      .then((g) => {
        if (cancelled) { g.dispose(); return; }
        game.current = g;
        unsubPhoto = g.photo.subscribe(() => setPhotoOn(g.photo.active));
        if (window.__iron) window.__iron.render = g.debug;
        setPhase('running');
      })
      .catch((e: unknown) => { if (!cancelled) fail(e instanceof Error ? e.message : String(e)); });
    return () => {
      cancelled = true;
      unsubPhoto?.();
      game.current?.dispose();
      game.current = null;
      if (window.__iron) delete window.__iron.render;
    };
  }, [client, mirror, agents, tools, why, view, radialHost]);

  useEffect(() => {
    if (phase !== 'running') return;
    const id = window.setInterval(() => { const g = game.current; if (g) { setPerf(g.perf()); setFollowing(g.debug.following); setTouring(g.debug.cinematic.active); } }, 250);
    return () => window.clearInterval(id);
  }, [phase]);

  useEffect(() => bindLifecycleDom(lifecycle, document, window), [lifecycle]);

  const perfOn = (settings.showPerf ?? layout === 'desktop') && !perfHidden && !focus;
  const perfRef = useRef(perfOn);
  perfRef.current = perfOn;
  const setPerf2 = useCallback((on: boolean): void => { setPerfHidden(false); onSetting('showPerf', on); }, [onSetting]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === '`') setPerf2(!perfRef.current); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setPerf2]);

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
    if (phone) { setListOpen(false); if (perfOn) setPerfHidden(true); }
  };
  useEffect(() => { if (focus) { setPanel(null); setListOpen(false); } }, [focus]);
  useOutsideDismiss(panel !== null || (phone && (listOpen || perfOn)), closeFloating, closeFloating, true);
  const panelStore = useMemo<PanelStateStore>(() => ({
    collapsed: settings.panelStates,
    set: (id, collapsed) => onSetting('panelStates', { ...settingsRef.current.panelStates, [id]: collapsed }),
  }), [settings.panelStates, onSetting]);
  const setTopOpen = (open: boolean): void => onSetting('panels', { ...settings.panels, topOpen: open });
  const hints: ToolHints = {
    seen: onboarding.hintsSeen,
    mark: (id) => { if (!onboarding.hintsSeen.includes(id)) onSetting('onboarding', { ...onboarding, hintsSeen: [...onboarding.hintsSeen, id] }); },
  };

  const trigger = (kind: SandboxDisaster): void => {
    const cam = game.current?.debug.camera;
    if (cam) tools.triggerDisaster(kind, Math.floor(cam.x), Math.floor(cam.z));
  };
  const jump = (x: number, y: number): void => { game.current?.debug.jumpTo(x, y); };
  const followOne = (key: number): boolean => {
    const ok = game.current?.debug.followAgent(key) ?? false;
    if (ok) setFollowing(true);
    return ok;
  };

  return (
    <PanelStateContext.Provider value={panelStore}>
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
      {photoOn && game.current && <PhotoMode photo={game.current.photo} lifecycle={lifecycle} passes={game.current.debug.fx.postPasses} touring={touring} onTour={() => { game.current?.tour(); setTouring(!!game.current?.debug.cinematic.active); }} />}
      <div className="hud" data-layout={layout} data-hand={settings.handedness} data-focus={focus} hidden={photoOn}>
        <AudioSync settings={settings} />
        {phase === 'running' && stats.directives && !focus && <DirectiveCard stats={stats.directives} population={stats.population} treasury={stats.treasury} state={listState} onChange={onList} client={client} tools={tools} mirror={mirror} glide={(x, y) => game.current?.glideTo(x, y)} onProjects={() => setPanel('projects')} onPick={() => setPanel(null)} collapseOnShow={phone} />}
        <Hud photo={phase === 'running' ? { enter: () => game.current?.photo.enter(), tour: () => { game.current?.tour(); } } : undefined} photoActive={photoOn} lifecycle={lifecycle} stats={stats} settings={settings} notice={notice} budgetOpen={budgetOpen} onBudget={() => setPanel((p) => (p === 'budget' ? null : 'budget'))} onServices={() => setPanel((p) => (p === 'services' ? null : 'services'))} onProjects={phase === 'running' ? () => setPanel((p) => (p === 'projects' ? null : 'projects')) : undefined} follow={phase === 'running' ? { active: following, toggle: () => { const g = game.current; if (g) setFollowing(g.debug.follow(!g.debug.following)); } } : undefined} onSave={onSave} onSaveAs={onSaveAs} onExport={onExport} onSetting={onSetting} onTrigger={phase === 'running' ? trigger : undefined} onQuit={onExit} quitPrompt={quitPrompt} onQuitSaveAs={onQuitSaveAs} onQuitDiscard={onQuitDiscard} onQuitCancel={onQuitCancel} facts={facts ?? undefined} perfOn={perfOn} onPerf={setPerf2} layout={layout} activeTier={perf?.tier} panel={panel} onPanel={setPanel} topOpen={settings.panels.topOpen} onTopOpen={setTopOpen} />
        {phase === 'running' && <Tools runtime={tools} view={view} hints={hints} layout={layout} panel={panel} onPanel={setPanel} autoCollapse={settings.panels.autoCollapse} onJump={jump} handedness={settings.handedness} focus={focus} onFocus={(on) => onSetting('focus', on)} />}
        {phase === 'running' && !focus && <BlueprintQueue mirror={mirror} client={client} onJump={jump} />}
        {phase === 'running' && !focus && <ForecastUi hazards={stats.hazards} tier={stats.milestone?.tier ?? 0} treasury={stats.treasury} onBuild={(arch) => tools.controller.select({ tool: 'service', arch })} onRebuildAll={() => tools.rebuildAll()} />}
        {phase === 'running' && <WhyUi why={why} onJump={jump} onBudget={() => setPanel('budget')} onFollow={followOne} modules={{ treasury: stats.treasury, set: (slot, index, module) => client.command({ type: 'setDepotModule', slot, index, module }) }} paint={{ set: (slot, livery) => client.command({ type: 'setDepotLivery', slot, livery }) }} />}
        {phase === 'running' && <AwayCard away={away} why={why} directives={stats.directives} council={stats.council} population={stats.population} treasury={stats.treasury} client={client} tools={tools} mirror={mirror} glide={(x, y) => game.current?.glideTo(x, y)} onProjects={() => setPanel('projects')} onBudget={() => setPanel('budget')} />}
        {phase === 'running' && <PacingUi pacing={pacing} onSave={onSave} onResume={() => lifecycle.setSpeed(1)} />}
        {panel === 'bots' && <HallOfBots bots={stats.bots} onFollow={followOne} onClose={() => setPanel(null)} />}
        <RadialMenu controller={radial as RadialController} />
        {panel === 'research' && <ResearchPanel stats={stats.firmware} client={client} onClose={() => setPanel(null)} />}
        {panel === 'edicts' && <EdictsPanel stats={stats.firmware} tier={stats.milestone?.tier ?? 0} client={client} onClose={() => setPanel(null)} />}
        {panel === 'council' && stats.council && <CouncilPanel stats={stats.council} client={client} onShow={(x, y, overlay) => { setPanel(null); game.current?.glideTo(x, y); view.setOverlay(overlay); }} onClose={() => setPanel(null)} />}
        {panel === 'districts' && <DistrictPanel districts={stats.districts ?? []} client={client} onShow={(x, y) => game.current?.glideTo(x, y)} onClose={() => setPanel(null)} />}
        {phase === 'running' && !focus && stats.districts && stats.districts.length > 0 && <DistrictLabels districts={stats.districts} game={game} mirror={mirror} />}
        {budgetOpen && <Budget client={client} events={tools} stats={stats} onClose={() => setPanel(null)} />}
        {servicesOpen && <ServicesPanel stats={stats.services} onClose={() => setPanel(null)} />}
        {projectsOpen && <MilestonesPanel stats={stats.milestone} population={stats.population} runtime={tools} onClose={() => setPanel(null)} />}
        <Banner runtime={tools} />
        {phase === 'running' && stats.scenario && <GoalChip stats={stats.scenario} onFinish={() => client.command({ type: 'finishScenario' })} />}
        {stats.scenario && stats.scenario.state !== 0 && !resultsHidden && scenario && (
          <Results
            stats={stats.scenario} population={stats.population} treasury={stats.treasury} update={scenario.result} next={scenario.nextName}
            onRetry={scenario.onRetry} onNext={scenario.onNext} onKeepPlaying={() => setResultsHidden(true)} onBack={scenario.onBack}
          />
        )}
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
    </PanelStateContext.Provider>
  );
}
