import { useEffect, useReducer, useState, type ReactNode } from 'react';
import { archetype, PIPE_COST, POWER_LINE_COST, ROAD_COST } from '../sim/catalog.ts';
import { WATER_REACH } from '../sim/utilities/tables.ts';
import { DENSITY_UNLOCK, ROAD_UNLOCK, TIERS } from '../sim/unlocks.ts';
import { isEditableTarget } from '../render/editable.ts';
import {
  DENSITY_LABELS, LINE_NAMES, ROAD_NAMES, SERVICES, TERRAFORM_MODES, UTILITY_BUILDINGS, ZONE_LABELS, keyAction, type LineKind, type ToolId, type ToolSel,
} from '../render/tools/toolSpec.ts';
import type { ViewState } from '../render/viewState.ts';
import { IconBulldoze, IconCancel, IconHammer, IconRoad, IconServices, IconTerraform, IconUndo, IconUtilities, IconViews, IconZone } from './icons';
import { useLayout, type Layout } from './layout';
import { AUTO_COLLAPSE_MS, PANEL_ATTR, useIdleTimer, useOutsideDismiss, usePresence, useSwipeDown, type PanelId } from './panels';
import { TOOL_HINTS } from './progress';
import { reasonText, type ToolsRuntime } from './toolsStore.ts';
import { ViewControls, useUndergroundKey } from './ViewControls';

type Group = ToolId | 'utilities';

const isUtilitySel = (s: ToolSel | null): boolean => s?.tool === 'line' || (s?.tool === 'service' && archetype(s.arch)?.utility !== undefined);
export const groupOf = (s: ToolSel | null): Group | null => (s === null ? null : isUtilitySel(s) ? 'utilities' : s.tool);

const CATEGORIES: { id: Group; label: string; key: string; start: ToolSel; icon: () => ReactNode }[] = [
  { id: 'bulldoze', label: 'Bulldoze', key: 'B', start: { tool: 'bulldoze' }, icon: IconBulldoze },
  { id: 'road', label: 'Road', key: 'R', start: { tool: 'road', cls: 1 }, icon: IconRoad },
  { id: 'zone', label: 'Zone', key: 'Z', start: { tool: 'zone', zone: 1, density: 0 }, icon: IconZone },
  { id: 'service', label: 'Services', key: '', start: { tool: 'service', arch: SERVICES[0]!.id }, icon: IconServices },
  { id: 'utilities', label: 'Utilities', key: 'L / P', start: { tool: 'line', kind: 'power' }, icon: IconUtilities },
  { id: 'terraform', label: 'Terraform', key: 'T', start: { tool: 'terraform', mode: 'raise' }, icon: IconTerraform },
];

const SERVICE_LABELS: Record<string, string> = {
  depot: 'Depot', powerPlant: 'Power plant', waterPump: 'Water pump', fireStation: 'Fire station', solarFarm: 'Solar farm',
  waterTower: 'Water tower', fusionReactor: 'Fusion reactor', policeStation: 'Police', clinic: 'Clinic', hospital: 'Hospital', school: 'School',
  university: 'University', parkSmall: 'Small park', parkLarge: 'Large park', repairBay: 'Repair bay',
  roboticsLab: 'Robotics lab',
};
const MODE_LABELS = { raise: 'Raise', lower: 'Lower', level: 'Level' } as const;
const LINE_COST: Record<LineKind, number> = { power: POWER_LINE_COST, water: PIPE_COST };
const HINT_MS = 5000;

const money = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;

export interface ToolHints {
  /** Hint ids already shown (persisted in settings). */
  seen: readonly string[];
  mark(id: string): void;
}

interface Props {
  runtime: ToolsRuntime; view: ViewState; hints?: ToolHints; layout?: Layout;
  /** The floating panel that is open, shared with the HUD so only one is open at a time. */
  panel?: PanelId | null;
  onPanel?(p: PanelId | null): void;
  /** Phones fold the tool bar back into its button after a few idle seconds (default true). */
  autoCollapse?: boolean;
  /** Flies the camera to a tile: the "Jump to" button on a disaster toast. */
  onJump?(x: number, y: number): void;
}

export function Tools({ runtime, view, hints, layout: forced, panel: panelProp, onPanel, autoCollapse = true, onJump }: Props) {
  const detected = useLayout();
  const layout = forced ?? detected;
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const phone = layout === 'phone';
  const [localPanel, setLocalPanel] = useState<PanelId | null>(null);
  const openPanel = panelProp !== undefined ? panelProp : localPanel;
  const setOpenPanel = onPanel ?? setLocalPanel;
  const viewsOpen = openPanel === 'views';
  const [toolOpen, setToolOpen] = useState(!phone);
  const [hint, setHint] = useState<string | null>(null);
  useEffect(() => runtime.subscribe(bump), [runtime]);
  useEffect(() => view.subscribe(bump), [view]);
  useUndergroundKey(view);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isEditableTarget(e.target)) return;
      const a = keyAction(e, runtime.controller.sel);
      if (!a) return;
      e.preventDefault();
      runtime.apply(a);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runtime]);

  const c = runtime.controller;
  const sel = c.sel;
  const plan = c.plan;
  const pick = (s: ToolSel): void => c.select(s);
  const group = groupOf(sel);
  const active = sel !== null;
  const open = !phone || toolOpen;
  const sheet = usePresence(open);
  const viewsPresence = usePresence(viewsOpen);
  const swipeViews = useSwipeDown(() => setOpenPanel(null));

  // A tool picked elsewhere (the checklist button) opens the bar; another panel opening folds an idle bar away.
  useEffect(() => { if (phone && active) setToolOpen(true); }, [phone, active]);
  useEffect(() => { if (phone && !active && openPanel !== null && openPanel !== 'views') setToolOpen(false); }, [phone, active, openPanel]);
  useEffect(() => { if (!phone) setToolOpen(true); }, [phone]);
  const collapse = (): void => { setOpenPanel(null); setToolOpen(false); };
  useOutsideDismiss(phone && toolOpen && !active, collapse, collapse);
  const touch = useIdleTimer(phone && toolOpen && !active && autoCollapse, AUTO_COLLAPSE_MS, collapse);

  useEffect(() => {
    if (!group || !hints || hints.seen.includes(group) || !TOOL_HINTS[group]) return;
    setHint(TOOL_HINTS[group]!);
    hints.mark(group);
    const t = window.setTimeout(() => setHint(null), HINT_MS);
    return () => { window.clearTimeout(t); setHint(null); };
  }, [group]); // eslint-disable-line react-hooks/exhaustive-deps

  const tier = runtime.tier;
  const lockTitle = (need: number): string | undefined => (tier < need ? `Locked: reach ${TIERS[need]!.name} (${TIERS[need]!.pop.toLocaleString('en-US')} people)` : undefined);
  const lockBadge = (need: number) => (tier < need ? <span className="lock" aria-label={`Locked until ${TIERS[need]!.name}`}>{'🔒'} {TIERS[need]!.name}</span> : null);

  const label = plan && plan.est.cost > 0 ? money(plan.est.cost) : '';
  const showCost = plan && (c.dragging || sel?.tool === 'service') && (label || plan.est.reason);
  const left = Math.max(8, Math.min(c.screen.x + 14, (typeof window === 'undefined' ? 400 : window.innerWidth) - 190));
  const top = Math.max(8, c.screen.y - 64);

  return (
    <>
      {showCost && plan && (
        <div className={`tool-cost${plan.est.reason ? ' bad' : ''}`} style={{ left, top }} data-testid="tool-cost">
          {label && <strong>{label}</strong>}
          {plan.est.reason && <span>{reasonText(plan.est.reason)}</span>}
        </div>
      )}
      <div className="tool-floats" aria-hidden="true">
        {runtime.floats.map((f) => (
          <span key={f.id} className={`tool-float${f.gain ? ' gain' : ''}`} style={{ left: f.x, top: Math.max(8, f.y - 40) }}>{f.text}</span>
        ))}
      </div>
      <div className="tool-toasts" role="status" aria-live="polite">
        {runtime.toasts.map((t) => (
          <div key={t.id} className={`tool-toast${t.tone === 'hint' ? ' hint' : ''}${t.good ? ' good' : ''}${t.alert ? ' alert' : ''}`} data-testid={t.tone === 'hint' ? 'hint-toast' : 'toast'}>
            <span>{t.text}</span>
            {t.jump && onJump && <button type="button" className="toast-jump" data-testid="toast-jump" onClick={() => onJump(t.jump!.x, t.jump!.y)}>Jump to</button>}
          </div>
        ))}
      </div>

      {phone && !toolOpen && (
        <button
          type="button" className="build-fab" {...{ [PANEL_ATTR]: 'fab' }} data-testid="build-fab" aria-label="Build tools" aria-expanded={false} title="Build tools"
          onClick={() => { setOpenPanel(null); setToolOpen(true); }}
        ><IconHammer /></button>
      )}
      {sheet.mounted && (
      <div className="toolsheet" data-layout={layout} data-state={sheet.state} {...{ [PANEL_ATTR]: 'tools' }} onPointerDown={touch}>
        {hint && <div className="tool-firsthint" role="status" data-testid="tool-hint">{hint}</div>}
        {viewsPresence.mounted && (
          <div className="views-pop" data-state={viewsPresence.state} {...swipeViews} role="dialog" aria-label="Views" data-testid="views-pop">
            <ViewControls view={view} keys={false} />
          </div>
        )}
        {sel && (
          <div className="optstrip" role="group" aria-label="Tool options" data-testid="optstrip">
            <button type="button" className="tb icon cancel" aria-label="Cancel" title="Cancel (Esc)" data-testid="cancel-tool" onClick={() => c.cancel()}><IconCancel /></button>
            {sel.tool === 'road' && ([1, 2, 3] as const).map((cls) => (
              <button key={cls} type="button" className="tb" disabled={tier < ROAD_UNLOCK[cls]!} aria-pressed={sel.cls === cls} title={lockTitle(ROAD_UNLOCK[cls]!)} onClick={() => pick({ tool: 'road', cls })}>
                {ROAD_NAMES[cls]} {money(ROAD_COST[cls]!)}{lockBadge(ROAD_UNLOCK[cls]!)}
              </button>
            ))}
            {sel.tool === 'zone' && (
              <>
                {([1, 2, 3] as const).map((zone) => (
                  <button key={zone} type="button" className="tb" aria-pressed={sel.zone === zone} onClick={() => pick({ ...sel, zone })}>{ZONE_LABELS[zone]}</button>
                ))}
                <span className="tool-gap" />
                {([0, 1, 2] as const).map((density) => (
                  <button key={density} type="button" className="tb" disabled={tier < DENSITY_UNLOCK[density]!} aria-pressed={sel.density === density} title={lockTitle(DENSITY_UNLOCK[density]!)} onClick={() => pick({ ...sel, density })}>{DENSITY_LABELS[density]}{lockBadge(DENSITY_UNLOCK[density]!)}</button>
                ))}
              </>
            )}
            {group === 'service' && sel.tool === 'service' && (
              <>
                {SERVICES.map((s) => (
                  <button key={s.id} type="button" className="tb" disabled={tier < (s.unlock ?? 0)} aria-pressed={sel.arch === s.id} title={lockTitle(s.unlock ?? 0)} onClick={() => pick({ tool: 'service', arch: s.id })}>
                    {SERVICE_LABELS[s.name] ?? s.name} {money(s.cost)}{lockBadge(s.unlock ?? 0)}
                  </button>
                ))}
                <button type="button" className="tb" onClick={() => c.rotate()} title="Rotate (R)">Rotate</button>
              </>
            )}
            {group === 'utilities' && (
              <>
                {(['power', 'water'] as const).map((kind) => (
                  <button
                    key={kind} type="button" className="tb" aria-pressed={sel.tool === 'line' && sel.kind === kind}
                    title={kind === 'power' ? 'Power line (L)' : 'Water pipe (P), laid underground'} onClick={() => pick({ tool: 'line', kind })}
                  >
                    {LINE_NAMES[kind]} {money(LINE_COST[kind])}/tile
                  </button>
                ))}
                <span className="tool-gap" />
                {UTILITY_BUILDINGS.map((s) => (
                  <button
                    key={s.id} type="button" className="tb" disabled={tier < (s.unlock ?? 0)} aria-pressed={sel.tool === 'service' && sel.arch === s.id}
                    title={lockTitle(s.unlock ?? 0)} onClick={() => pick({ tool: 'service', arch: s.id })}
                  >
                    {SERVICE_LABELS[s.name] ?? s.name} {money(s.cost)}{lockBadge(s.unlock ?? 0)}
                  </button>
                ))}
                {sel.tool === 'service' && <button type="button" className="tb" onClick={() => c.rotate()} title="Rotate (R)">Rotate</button>}
              </>
            )}
            {sel.tool === 'terraform' && TERRAFORM_MODES.map((mode) => (
              <button key={mode} type="button" className="tb" aria-pressed={sel.mode === mode} onClick={() => pick({ tool: 'terraform', mode })}>{MODE_LABELS[mode]}</button>
            ))}
            {sel.tool === 'bulldoze' && (
              <span className="tool-hint">{view.underground ? 'Underground: drag to dig up water pipes.' : 'Drag over roads, zones, power lines and buildings to clear them.'}</span>
            )}
            {sel.tool === 'line' && (
              <span className="tool-hint">{sel.kind === 'power' ? 'Power flows through lines and touching buildings, not roads.' : `Pipes run underground and serve buildings within ${WATER_REACH} tiles.`}</span>
            )}
          </div>
        )}
        <div className="toolbar" data-testid="toolbar" role="toolbar" aria-label="Build tools">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.id} type="button" className="tb tool" aria-pressed={group === cat.id} aria-label={cat.label} data-testid={`tool-${cat.id}`}
              title={cat.key ? `${cat.label} (${cat.key})` : cat.label}
              onClick={() => (group === cat.id ? c.cancel() : pick(cat.start))}
            >{cat.icon()}<span className="tl" aria-hidden="true">{cat.label}</span></button>
          ))}
          <button type="button" className="tb tool" aria-label="Undo" data-testid="tool-undo" disabled={!runtime.canUndo} title="Undo (Ctrl+Z)" onClick={() => runtime.undoLast()}><IconUndo /><span className="tl" aria-hidden="true">Undo</span></button>
          <button
            type="button" className="tb tool" aria-label="Views" aria-pressed={viewsOpen} aria-expanded={viewsOpen} aria-haspopup="dialog" data-testid="views-toggle"
            title="Views: overlays and underground (U)" onClick={() => setOpenPanel(viewsOpen ? null : 'views')}
          ><IconViews /><span className="tl" aria-hidden="true">Views</span></button>
        </div>
      </div>
      )}
    </>
  );
}
