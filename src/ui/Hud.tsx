import { useEffect, useRef, useState } from 'react';
import type { CouncilStats, DirectiveStats, FirmwareStats, HazardStats, LoanInfo, MilestoneStats, ScenarioStats, ServiceStats, Speed, TrafficStats, Workforce } from '../sim/protocol.ts';
import { TIERS } from '../sim/unlocks.ts';
import { ApprovalChip } from './Council';
import { DemandBars } from './DemandBars';
import { ResourceChips } from './ChainUi';
import { FirmwareMenuRows } from './FirmwarePanels';
import { UtilityBars } from './UtilityBars';
import { InstallMenuItem } from './PwaUi';
import type { Lifecycle, LifecycleState } from '../platform/lifecycle.ts';
import { DEFAULT_SETTINGS, DISASTER_MODES, HANDEDNESS, TIER_OVERRIDES, type DisastersSetting, type Handedness, type Settings, type TierOverride } from '../platform/settings.ts';
import type { SandboxDisaster } from './toolsStore.ts';
import type { FailReason } from '../platform/db.ts';
import { isEditableTarget } from '../render/editable.ts';
import { SoundSettings, SpeakerToggle } from '../audio/ui.tsx';
import { IconChevron, IconMenu, IconPause, IconPlay, IconRobot } from './icons';
import { nextSpeed, speedLabel, topBarControls, useLayout, type Layout, type TopControl } from './layout';
import { Panel, useHeaderGestures } from './Panel';
import { PANEL_ATTR, usePresence, type PanelId } from './panels';
import { NO_FACTS, type CityFacts } from './progress';

export const SPEEDS: { speed: Speed; label: string; key: string }[] = [
  { speed: 0, label: 'Pause', key: '0' },
  { speed: 1, label: '1x', key: '1' },
  { speed: 2, label: '2x', key: '2' },
  { speed: 4, label: '4x', key: '3' },
  { speed: 'max', label: 'Max', key: '4' },
];

/** What each Disasters setting does, shown under the choice. Off stops new ones; the sandbox menu still works in every mode. */
export const DISASTER_HINTS: Record<DisastersSetting, string> = {
  off: 'No fires, storms, quakes or meteors. The sandbox menu still works.',
  gentle: 'Forecasts only, with half the damage, no meteors and a low ceiling on how strong they grow.',
  rare: 'Hazards are forecast a month or two ahead and come now and then, plus the odd fire. They grow with the city.',
  normal: 'Hazards come often and fires start more easily. They grow with the city.',
  hard: 'Relentless: hazards come back to back, hit harder and fires are common. They grow with the city.',
};

export const failText = (reason: FailReason, message?: string): string => {
  switch (reason) {
    case 'quota': return 'Browser storage is full. Export the city to a file to keep it.';
    case 'blocked': return 'Storage is blocked by another tab. Close other Iron Dominion tabs and retry.';
    case 'unavailable': return `Saving is not available${message ? ` (${message})` : ''}.`;
    case 'corrupt': return message ?? 'That save is damaged.';
  }
};

export interface HudStats {
  tick: number; day: number; dayFrac: number; treasury: number; population: number;
  /** [R, C, I] demand in [-1, 1]. */
  rciDemand: [number, number, number];
  /** [R, C, I] tax percent. */
  taxRates: [number, number, number];
  month: number;
  /** Net of the last closed budget month; 0 before the first closes. */
  lastNet: number;
  loans: LoanInfo[];
  debtMonths: number;
  /** MW and ML produced and drawn at the last utilities solve. */
  power: { supply: number; demand: number };
  water: { supply: number; demand: number };
  /** Finished buildings without power or water. */
  unpowered: number;
  unwatered: number;
  modelled: { power: boolean; water: boolean };
  workforce: Workforce;
  traffic?: TrafficStats;
  services: ServiceStats;
  /** Population tier and megaproject status from the newest Stats message. */
  milestone?: MilestoneStats;
  /** UNIT-0 directive progress from the newest Stats message. */
  directives?: DirectiveStats;
  /** Research points, owned firmware, active edicts and depot modules from the newest Stats message. */
  firmware?: FirmwareStats;
  /** The season, the hazard forecast, the defences and the ruins from the newest Stats message. */
  hazards?: HazardStats;
  /** Approval, council requests and festivals from the newest Stats message. */
  council?: CouncilStats;
  /** Goal progress of a scenario or challenge city; null or absent in the sandbox. */
  scenario?: ScenarioStats | null;
}

export const NO_WORKFORCE: Workforce = { builders: 0, haulers: 0, activeBuilders: 0, activeHaulers: 0, jobs: 0, stock: 0, alloy: 0, parts: 0 };

interface Props {
  lifecycle: Lifecycle;
  stats: HudStats;
  settings: Settings;
  notice: string;
  budgetOpen: boolean;
  onBudget(): void;
  /** Opens the Services panel (menu entry). */
  onServices(): void;
  /** Opens the milestones and projects panel (a Menu row); absent while the 3D view is not running. */
  onProjects?(): void;
  /** Chase-camera state and toggle; absent while the 3D view is not running. */
  follow?: { active: boolean; toggle(): void };
  /** Photo mode and the city tour, from the menu; absent while the 3D view is not running. */
  photo?: { enter(): void; tour(): void };
  /** Photo mode is open: the speed and pause keys are left to it. */
  photoActive?: boolean;
  onSave(): void;
  onSaveAs(name: string): void;
  onExport(): void;
  onSetting<K extends keyof Settings>(key: K, value: Settings[K]): void;
  /** Sandbox menu: start a fire, quake or meteor at the middle of the view. Absent while the 3D view is not running. */
  onTrigger?(kind: SandboxDisaster): void;
  onQuit(): void;
  /** Set when leaving could not save: the player picks what happens to the city. */
  quitPrompt: string | null;
  onQuitSaveAs(name: string): void;
  onQuitDiscard(): void;
  onQuitCancel(): void;
  /** What the player has built; drives the "No depot" warning. */
  facts?: CityFacts;
  /** Performance panel visibility and its setter (the menu holds the toggle). */
  perfOn?: boolean;
  onPerf?(on: boolean): void;
  /** Force a layout instead of reading the window width. */
  layout?: Layout;
  /** The graphics tier the renderer is running now. */
  activeTier?: string;
  /** The floating panel that is open (menu and status are drawn here), and the setter that keeps it to one at a time. */
  panel?: PanelId | null;
  onPanel?(p: PanelId | null): void;
  /** A phone's top bar: expanded (true) or the minimal strip. Ignored on desktop. */
  topOpen?: boolean;
  onTopOpen?(open: boolean): void;
}

const clock = (f: number): string => {
  const mins = Math.floor((((f % 1) + 1) % 1) * 24 * 60);
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
};

const usd = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;

function WorkforceReadout({ w, depots }: { w: Workforce; depots: number }) {
  return (
    <div className={`workforce${depots === 0 ? ' warn' : ''}`} data-testid="workforce" title="Builder bots and hauler drones: working now / total, jobs in progress, material in stock">
      {depots === 0 && <span className="no-depot" role="status" data-testid="no-depot">No depot</span>}
      <span>Builders {w.activeBuilders}/{w.builders}</span>
      <span>Haulers {w.activeHaulers}/{w.haulers}</span>
      <span>Jobs {w.jobs}</span>
      <ResourceChips workforce={w} />
    </div>
  );
}

function TrafficReadout({ t }: { t?: TrafficStats }) {
  if (!t) return null;
  return (
    <div className="traffic" data-testid="traffic" title="Vehicles on the road, how much traffic slows them below free flow, and the share of recent commutes that could not finish in time or find a route">
      <span>Vehicles {t.vehicles}</span>
      <span>Congestion {Math.round(t.congestion * 100)}%</span>
      <span>Failed commutes {t.failedPct}%</span>
    </div>
  );
}

export function Hud({
  lifecycle, stats, settings, notice, budgetOpen, onBudget, onServices, onProjects, follow, photo, photoActive = false, onTrigger, onSave, onSaveAs, onExport, onSetting, onQuit, quitPrompt, onQuitSaveAs, onQuitDiscard, onQuitCancel,
  facts = NO_FACTS, perfOn = false, onPerf, layout: forced, activeTier, panel: panelProp, onPanel, topOpen: topOpenProp, onTopOpen,
}: Props) {
  const detected = useLayout();
  const layout = forced ?? detected;
  const phone = layout === 'phone';
  const [lc, setLc] = useState<LifecycleState>({ ...lifecycle.state });
  const [localPanel, setLocalPanel] = useState<PanelId | null>(null);
  const [localTop, setLocalTop] = useState(topOpenProp ?? true);
  const openPanel = panelProp !== undefined ? panelProp : localPanel;
  const setOpenPanel = onPanel ?? setLocalPanel;
  const topOpen = !phone || (onTopOpen ? (topOpenProp ?? true) : localTop);
  const setTopOpen = (open: boolean): void => {
    if (onTopOpen) onTopOpen(open); else setLocalTop(open);
    if (!open && (openPanel === 'menu' || openPanel === 'status')) setOpenPanel(null);
  };
  const focus = settings.focus;
  const menu = openPanel === 'menu' && !focus;
  const status = openPanel === 'status' && !focus;
  const menuPresence = usePresence(menu);
  const statusPresence = usePresence(phone && status);
  const extraPresence = usePresence(phone && topOpen);
  const readoutGestures = useHeaderGestures((g) => setTopOpen(g === 'tap' ? !topOpen : g === 'swipeUp'));
  const [mode, setMode] = useState<'main' | 'saveAs' | 'settings' | 'sandbox'>('main');
  const [name, setName] = useState('');
  const [quitName, setQuitName] = useState('');
  const lastRunning = useRef<Speed>(1);

  useEffect(() => {
    setLc({ ...lifecycle.state });
    return lifecycle.subscribe((s) => setLc({ ...s }));
  }, [lifecycle]);

  useEffect(() => { if (lc.speed !== 0) lastRunning.current = lc.speed; }, [lc.speed]);

  useEffect(() => {
    if (photoActive) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey || isEditableTarget(e.target)) return;
      const hit = SPEEDS.find((s) => s.key === e.key);
      if (hit) { e.preventDefault(); lifecycle.setSpeed(hit.speed); return; }
      if (e.key === ' ' && (e.target as HTMLElement | null)?.tagName !== 'BUTTON') {
        e.preventDefault();
        lifecycle.setSpeed(lifecycle.state.speed === 0 ? lastRunning.current : 0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lifecycle, photoActive]);

  useEffect(() => { if (!menu) setMode('main'); }, [menu]);
  const closeMenu = (): void => { if (openPanel === 'menu') setOpenPanel(null); };
  const bar = topBarControls(layout, topOpen);
  const has = (c: TopControl): boolean => bar.includes(c);
  const paused = lc.speed === 0;
  const alert = facts.depots === 0 || stats.unpowered > 0 || stats.unwatered > 0;
  const noticeText = notice || (lc.lastError ? failText(lc.lastError) : '');

  const rciEl = <DemandBars demand={stats.rciDemand} />;
  const approvalEl = stats.council ? <ApprovalChip council={stats.council} open={openPanel === 'council'} onClick={() => setOpenPanel(openPanel === 'council' ? null : 'council')} /> : null;
  const statusEl = (
    <button
      type="button" className={`tb icon status-chip${alert ? ' alert' : ''}`} data-testid="status-chip" aria-expanded={status} aria-haspopup="dialog"
      aria-label={alert ? 'City status, needs attention' : 'City status'} title="City status" onClick={() => setOpenPanel(status ? null : 'status')}
    ><IconRobot /></button>
  );
  const menuEl = (
    <button
      type="button" className={`tb${phone ? ' icon' : ' wide'}`} data-testid="menu-button" aria-label="Menu" aria-expanded={menu} aria-haspopup="dialog"
      onClick={() => setOpenPanel(menu ? null : 'menu')}
    >{phone ? <IconMenu /> : 'Menu'}</button>
  );

  return (
    <>
      {!focus && (
      <div className="topbar" data-layout={layout} data-open={topOpen} {...{ [PANEL_ATTR]: 'top' }} data-testid="topbar" role="toolbar" aria-label="Game controls">
        {has('playPause') && (
          <button
            type="button" className="tb icon" data-testid="playpause" aria-pressed={paused} aria-label={paused ? 'Play' : 'Pause'}
            title={paused ? 'Play' : 'Pause (0)'}
            onClick={() => lifecycle.setSpeed(paused ? lastRunning.current : 0)}
          >{paused ? <IconPlay /> : <IconPause />}</button>
        )}
        {has('speedCycle') && (
          <button
            type="button" className="tb speed-cycle" data-testid="speed-cycle" aria-label={`Speed ${speedLabel(paused ? lastRunning.current : lc.speed)}. Tap to change.`}
            title="Change speed" onClick={() => lifecycle.setSpeed(nextSpeed(paused ? lastRunning.current : lc.speed))}
          >{speedLabel(paused ? lastRunning.current : lc.speed)}</button>
        )}
        {has('speeds') && (
          <div className="speeds" role="group" aria-label="Game speed">
            {SPEEDS.map((s) => (
              <button key={s.label} type="button" className="tb" aria-pressed={lc.speed === s.speed} title={`${s.label} (${s.key})`} onClick={() => lifecycle.setSpeed(s.speed)}>{s.label === 'Pause' ? '⏸' : s.label}</button>
            ))}
          </div>
        )}
        <div className="readouts" data-testid="readouts" {...(phone ? readoutGestures : {})}>
          {has('clock') && <span>Day {stats.day} {clock(stats.dayFrac)}</span>}
          {has('money') && (
            <span className="money-row">
              <span className="money" data-testid="money">{usd(stats.treasury)}</span>
              {!phone && approvalEl}
            </span>
          )}
          {has('population') && <span className="pop" data-testid="population">Pop {Math.round(stats.population).toLocaleString('en-US')}</span>}
          {has('net') && (
            <span className={stats.lastNet < 0 ? 'net neg' : 'net'} data-testid="monthly-net" title="Net of the last budget month">
              {stats.lastNet < 0 ? '-' : '+'}${Math.abs(Math.round(stats.lastNet)).toLocaleString('en-US')}/mo
            </span>
          )}
        </div>
        {phone && has('money') && approvalEl}
        <div data-slot="advisor" />
        <div data-slot="forecast" />
        {has('workforce') && <WorkforceReadout w={stats.workforce} depots={facts.depots} />}
        {has('workforce') && <TrafficReadout t={stats.traffic} />}
        {!phone && has('rci') && rciEl}
        {has('utilities') && <UtilityBars power={stats.power} water={stats.water} unpowered={stats.unpowered} unwatered={stats.unwatered} modelled={stats.modelled} />}
        {has('follow') && follow && (
          <button type="button" className="tb wide" aria-pressed={follow.active} title="Chase a robot at street level (Esc or a tap to stop)" onClick={follow.toggle}>
            {follow.active ? 'Stop following' : 'Follow a robot'}
          </button>
        )}
        {has('budget') && <button type="button" className="tb coin" aria-label="Budget" aria-expanded={budgetOpen} aria-haspopup="dialog" title="Budget" onClick={onBudget}>$</button>}
        {has('save') && <button type="button" className="tb wide" onClick={onSave} disabled={lc.saving}>{lc.saving ? 'Saving' : 'Save'}</button>}
        {!phone && has('menu') && <SpeakerToggle settings={settings} onSetting={onSetting} />}
        {!phone && has('menu') && menuEl}
        {phone && extraPresence.mounted && (
          <div className="top-extra" data-state={extraPresence.state}>
            {rciEl}
            {statusEl}
            <SpeakerToggle settings={settings} onSetting={onSetting} />
            {menuEl}
          </div>
        )}
        {phone && (
          <button
            type="button" className="tb icon chevron" data-testid="topbar-chevron" data-open={topOpen} aria-expanded={topOpen}
            aria-label={topOpen ? 'Collapse top bar' : 'Expand top bar'} title={topOpen ? 'Collapse' : 'More'} onClick={() => setTopOpen(!topOpen)}
          ><IconChevron /></button>
        )}
        <span className="notice" role="status" aria-live="polite" data-testid="notice">{noticeText}</span>
      </div>
      )}

      {phone && statusPresence.mounted && (
        <Panel id="status" kind="popover" title="City status" className="menu status-pop" dataState={statusPresence.state} panelAttr="status" testId="status-pop" onClose={() => { if (openPanel === 'status') setOpenPanel(null); }}>
          <div className="status-line"><span>Day {stats.day} {clock(stats.dayFrac)}</span><span className={stats.lastNet < 0 ? 'net neg' : 'net'} data-testid="monthly-net" title="Net of the last budget month">{stats.lastNet < 0 ? '-' : '+'}${Math.abs(Math.round(stats.lastNet)).toLocaleString('en-US')}/mo</span></div>
          <WorkforceReadout w={stats.workforce} depots={facts.depots} />
          <TrafficReadout t={stats.traffic} />
          <UtilityBars power={stats.power} water={stats.water} unpowered={stats.unpowered} unwatered={stats.unwatered} modelled={stats.modelled} />
        </Panel>
      )}

      {menuPresence.mounted && (
        <Panel id="menu" kind="popover" title="Menu" className={`menu${phone ? ' menu-phone' : ''}`} dataState={menuPresence.state} panelAttr="menu" testId="menu" onClose={closeMenu}>
          {mode === 'main' && (
            <>
              <Panel id="menu-city" kind="section" title="City">
                {phone && <button type="button" className="tb row" aria-label="Budget" aria-expanded={budgetOpen} aria-haspopup="dialog" onClick={() => { closeMenu(); onBudget(); }}>Budget</button>}
                {phone && follow && (
                  <button type="button" className="tb row" aria-pressed={follow.active} onClick={() => { closeMenu(); follow.toggle(); }}>{follow.active ? 'Stop following' : 'Follow a robot'}</button>
                )}
                {phone && <button type="button" className="tb row" onClick={() => { onSave(); closeMenu(); }} disabled={lc.saving}>{lc.saving ? 'Saving' : 'Save'}</button>}
                <button type="button" className="tb row" data-testid="services-menu" onClick={() => { onServices(); }}>City services</button>
                {stats.council && <button type="button" className="tb row" data-testid="council-menu" onClick={() => setOpenPanel('council')}>Council ({stats.council.approval}% approval)</button>}
                {onProjects && <button type="button" className="tb row" data-testid="projects-menu" onClick={() => { onProjects(); }}>Milestones and projects ({TIERS[stats.milestone?.tier ?? 0]!.name})</button>}
                {onProjects && <FirmwareMenuRows stats={stats.firmware} onPanel={(p) => setOpenPanel(p)} />}
                <button type="button" className="tb row" onClick={() => { setName(''); setMode('saveAs'); }}>Save as...</button>
                <button type="button" className="tb row" onClick={() => { onExport(); closeMenu(); }}>Export to file</button>
              </Panel>
              <Panel id="menu-display" kind="section" title="Display">
                <label className="check">
                  <input type="checkbox" data-testid="perf-toggle" checked={perfOn} onChange={(e) => onPerf?.(e.target.checked)} />
                  Performance panel
                </label>
                <label className="check">
                  <input type="checkbox" data-testid="focus-toggle" checked={settings.focus} onChange={(e) => { onSetting('focus', e.target.checked); closeMenu(); }} />
                  Focus mode (hide the HUD)
                </label>
                {phone && (
                  <label className="check">
                    <input type="checkbox" data-testid="autocollapse-toggle" checked={settings.panels.autoCollapse} onChange={(e) => onSetting('panels', { ...settings.panels, autoCollapse: e.target.checked })} />
                    Auto-collapse the tool bar
                  </label>
                )}
                <button type="button" className="tb row" data-testid="restart-tutorial" onClick={() => { onSetting('onboarding', { ...DEFAULT_SETTINGS.onboarding }); closeMenu(); }}>Restart tutorial</button>
                {photo && <button type="button" className="tb row" data-testid="photo-menu" onClick={() => { closeMenu(); photo.enter(); }}>Photo mode (F2)</button>}
                {photo && <button type="button" className="tb row" data-testid="tour-menu" onClick={() => { closeMenu(); photo.tour(); }}>City tour</button>}
              </Panel>
              <button type="button" className="tb row" onClick={() => setMode('settings')}>Settings</button>
              {onTrigger && <button type="button" className="tb row" data-testid="sandbox-menu" onClick={() => setMode('sandbox')}>Trigger disaster...</button>}
              <InstallMenuItem />
              <button type="button" className="tb row" onClick={() => { closeMenu(); onQuit(); }}>Quit to title (saves)</button>
              <button type="button" className="tb row" onClick={closeMenu}>Close</button>
            </>
          )}
          {mode === 'saveAs' && (
            <form onSubmit={(e) => { e.preventDefault(); onSaveAs(name); closeMenu(); }}>
              <label>Slot name<input value={name} maxLength={40} autoFocus onChange={(e) => setName(e.target.value)} /></label>
              <button type="submit" className="tb row">Save</button>
              <button type="button" className="tb row" onClick={() => setMode('main')}>Back</button>
            </form>
          )}
          {mode === 'settings' && (
            <div className="settings">
              <Panel id="settings-graphics" kind="section" title="Graphics">
                <label>Graphics tier
                  <select value={settings.tier} data-testid="tier-select" onChange={(e) => onSetting('tier', e.target.value as TierOverride)}>
                    {TIER_OVERRIDES.map((t) => <option key={t} value={t}>{t === 'auto' ? `Auto${activeTier ? ` (${activeTier})` : ''}` : t}</option>)}
                  </select>
                </label>
                {activeTier && <p className="hint" data-testid="tier-now">Running at {activeTier}{settings.tier === 'auto' ? ' (auto: the game raises or lowers it to keep the frame rate up)' : ' (pinned)'}.</p>}
                <p className="hint">A pinned tier takes effect the next time a city starts.</p>
              </Panel>
              <Panel id="settings-gameplay" kind="section" title="Gameplay">
                <label>Disasters
                  <select value={settings.disasters} data-testid="disasters-setting" onChange={(e) => onSetting('disasters', e.target.value as DisastersSetting)}>
                    {DISASTER_MODES.map((m) => <option key={m} value={m}>{m[0]!.toUpperCase() + m.slice(1)}</option>)}
                  </select>
                </label>
                <p className="hint" data-testid="disasters-hint">{DISASTER_HINTS[settings.disasters]}</p>
              </Panel>
              <Panel id="settings-controls" kind="section" title="Controls">
                <label>Handedness
                  <select value={settings.handedness} data-testid="handedness-select" onChange={(e) => onSetting('handedness', e.target.value as Handedness)}>
                    {HANDEDNESS.map((h) => <option key={h} value={h}>{h === 'right' ? 'Right' : 'Left'}</option>)}
                  </select>
                </label>
                <p className="hint">Puts the build button and tool bar on the side of your thumb.</p>
              </Panel>
              <Panel id="settings-sound" kind="section" title="Sound">
                <SoundSettings settings={settings} onSetting={onSetting} />
              </Panel>
              <button type="button" className="tb row" onClick={() => setMode('main')}>Back</button>
            </div>
          )}
          {mode === 'sandbox' && onTrigger && (
            <div className="settings">
              <p className="hint">Strikes the middle of the view. Works in every disaster setting.</p>
              <button type="button" className="tb row" data-testid="trigger-fire" onClick={() => { onTrigger('fire'); closeMenu(); }}>Start a fire</button>
              <button type="button" className="tb row" data-testid="trigger-quake" onClick={() => { onTrigger('quake'); closeMenu(); }}>Earthquake</button>
              <button type="button" className="tb row" data-testid="trigger-meteor" onClick={() => { onTrigger('meteor'); closeMenu(); }}>Meteor strike</button>
              <button type="button" className="tb row" onClick={() => setMode('main')}>Back</button>
            </div>
          )}
        </Panel>
      )}

      {quitPrompt !== null && (
        <div className="resume" role="alertdialog" aria-label="Leave without saving?">
          <h2>Leave this city?</h2>
          <p>{quitPrompt}</p>
          <form className="newcity" onSubmit={(e) => { e.preventDefault(); onQuitSaveAs(quitName); }}>
            <label>Save as<input value={quitName} maxLength={40} placeholder="Untitled city" onChange={(e) => setQuitName(e.target.value)} /></label>
            <button type="submit" className="primary">Save as</button>
          </form>
          <button type="button" className="primary" onClick={onExport}>Export to file</button>
          <button type="button" className="primary danger" onClick={onQuitDiscard}>Quit without saving</button>
          <button type="button" className="primary" onClick={onQuitCancel}>Cancel</button>
        </div>
      )}

      {lc.awaitingResume && quitPrompt === null && (
        <div className="resume" role="dialog" aria-label="Paused">
          <h2>Paused</h2>
          <p>The city waits for you.</p>
          <button type="button" className="primary" autoFocus onClick={() => lifecycle.resume()}>Resume</button>
        </div>
      )}
    </>
  );
}
