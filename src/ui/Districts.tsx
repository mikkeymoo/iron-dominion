import { useEffect, useRef, useState, useSyncExternalStore, type MutableRefObject } from 'react';
import type { SimClient } from '../sim/client.ts';
import { DISTRICT_EDICTS, NAME_MAX, NAME_POOL, STYLES } from '../sim/districtTables.ts';
import { DMAX } from '../sim/layers.ts';
import type { DistrictStat } from '../sim/protocol.ts';
import type { Game } from '../render/game.ts';
import type { RenderMirror } from '../render/mirror.ts';
import type { ToolSel } from '../render/tools/toolSpec.ts';
import type { ToolsRuntime } from './toolsStore.ts';
import { Panel } from './Panel';
import './districts.css';

// Districts UI, self-contained: the chips beside the District tool, the District panel (name, style, edict, stats) and the floating names.

// ---- The district the panel and the tool are working on ----
const picked = { id: 0, listeners: new Set<() => void>() };
export function pickDistrict(id: number): void {
  if (picked.id === id) return;
  picked.id = id;
  for (const fn of picked.listeners) fn();
}
const subscribePicked = (fn: () => void): (() => void) => { picked.listeners.add(fn); return () => { picked.listeners.delete(fn); }; };
export const usePickedDistrict = (): number => useSyncExternalStore(subscribePicked, () => picked.id, () => 0);

const money = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;
const signed = (n: number): string => `${n > 0 ? '+' : n < 0 ? '-' : ''}${Math.abs(n)}`;

/** Lowest district id with no land, or 0 when all DMAX are used. */
export function freeDistrictId(districts: readonly DistrictStat[]): number {
  for (let id = 1; id <= DMAX; id++) if (!districts.some((d) => d.id === id)) return id;
  return 0;
}

/** The generated name nobody is using, or the first one when all are taken. */
export function unusedPool(districts: readonly DistrictStat[]): number {
  const used = new Set(districts.map((d) => d.name));
  const free = NAME_POOL.findIndex((n) => !used.has(n));
  return free < 0 ? 0 : free;
}

/** The selection the Districts button starts with: the district being worked on, else a new one. */
export function districtStart(districts: readonly DistrictStat[]): ToolSel {
  const id = districts.some((d) => d.id === picked.id) ? picked.id : freeDistrictId(districts) || 1;
  pickDistrict(id);
  return { tool: 'district', mode: 'paint', district: id };
}

const Swatch =({ style }: { style: number }) => <span className="dist-swatch" style={{ background: STYLES[style]?.css }} aria-hidden="true" />;

interface StripProps {
  runtime: ToolsRuntime;
  /** Opens the District panel on the district being painted. */
  onManage(): void;
}

/** The District tool's options: paint or erase, a chip per district, a New district button and a way into the panel. */
export function DistrictToolStrip({ runtime, onManage }: StripProps) {
  const c = runtime.controller;
  const sel = c.sel;
  if (!sel || sel.tool !== 'district') return null;
  const districts = runtime.districts;
  const free = freeDistrictId(districts);
  const founding = sel.mode === 'paint' && !districts.some((d) => d.id === sel.district);
  const choose = (district: number): void => { pickDistrict(district); c.select({ tool: 'district', mode: 'paint', district }); };
  return (
    <>
      <button type="button" className="tb" data-testid="district-paint" aria-pressed={sel.mode === 'paint'} onClick={() => c.select({ ...sel, mode: 'paint' })}>Paint</button>
      <button type="button" className="tb" data-testid="district-erase" aria-pressed={sel.mode === 'erase'} onClick={() => c.select({ ...sel, mode: 'erase' })}>Erase</button>
      <span className="tool-gap" />
      {districts.map((d) => (
        <button key={d.id} type="button" className="tb dist-chip" data-testid={`district-chip-${d.id}`} aria-pressed={sel.mode === 'paint' && sel.district === d.id} onClick={() => choose(d.id)}>
          <Swatch style={d.style} />{d.name}
        </button>
      ))}
      <button type="button" className="tb" data-testid="district-new" disabled={free === 0} aria-pressed={founding} title={free === 0 ? `A city holds at most ${DMAX} districts` : 'Paint a new district'} onClick={() => choose(free)}>New district</button>
      {districts.length > 0 && <button type="button" className="tb" data-testid="district-manage" onClick={() => { if (sel.mode === 'paint' && districts.some((d) => d.id === sel.district)) pickDistrict(sel.district); onManage(); }}>Edit districts</button>}
      <span className="tool-hint">{sel.mode === 'paint' ? 'Drag over land to paint it into the district. Edicts and styles apply inside it.' : 'Drag over land to take it out of its district.'}</span>
    </>
  );
}

interface PanelProps {
  districts: readonly DistrictStat[];
  client: Pick<SimClient, 'command'>;
  onClose(): void;
  /** Flies the camera to a tile. */
  onShow?(x: number, y: number): void;
}

/** One district at a time: its name, style and edict, and what it holds. */
export function DistrictPanel({ districts, client, onClose, onShow }: PanelProps) {
  const pick = usePickedDistrict();
  const d = districts.find((x) => x.id === pick) ?? districts[0];
  const [draft, setDraft] = useState('');
  useEffect(() => { setDraft(d?.name ?? ''); }, [d?.id, d?.name]);
  const total = districts.reduce((sum, x) => sum + x.cost, 0);
  const rename = (): void => {
    const name = draft.trim();
    if (d && name !== '' && name !== d.name) client.command({ type: 'renameDistrict', district: d.id, name });
  };
  return (
    <Panel id="districts" title="Districts" className="budget fw-panel dist-panel" panelAttr="districts" testId="district-panel" onClose={onClose}>
      {!d ? (
        <p className="hint" data-testid="district-empty">No districts yet. Pick the Districts tool in the build dock, then New district, and drag over land.</p>
      ) : (
        <>
          <div className="dist-tabs" role="tablist" aria-label="Districts">
            {districts.map((x) => (
              <button key={x.id} type="button" role="tab" className="tb dist-chip" data-testid={`district-tab-${x.id}`} aria-selected={x.id === d.id} aria-pressed={x.id === d.id} onClick={() => pickDistrict(x.id)}>
                <Swatch style={x.style} />{x.name}
              </button>
            ))}
          </div>
          <form className="dist-name" onSubmit={(e) => { e.preventDefault(); rename(); }}>
            <label htmlFor="district-name">Name</label>
            <input id="district-name" data-testid="district-name" value={draft} maxLength={NAME_MAX} autoComplete="off" onChange={(e) => setDraft(e.target.value)} onBlur={rename} />
            <button type="submit" className="tb" data-testid="district-rename" disabled={draft.trim() === '' || draft.trim() === d.name}>Rename</button>
            <button type="button" className="tb" data-testid="district-shuffle" onClick={() => client.command({ type: 'renameDistrict', district: d.id, pool: unusedPool(districts) })}>New name</button>
          </form>
          <dl className="dist-stats" data-testid="district-stats">
            <dt>Land</dt><dd data-testid="district-tiles">{d.tiles.toLocaleString('en-US')} tiles</dd>
            <dt>Population</dt><dd data-testid="district-pop">{d.population.toLocaleString('en-US')}</dd>
            <dt>Jobs</dt><dd data-testid="district-jobs">{d.jobs.toLocaleString('en-US')}</dd>
            <dt>Land value</dt><dd data-testid="district-lv">{d.landValue}</dd>
            <dt>Approval</dt><dd data-testid="district-approval" title="Points this district's homes pull the city's approval above or below the average">{signed(d.approval)} pts</dd>
            <dt>Edict cost</dt><dd data-testid="district-cost">{d.cost > 0 ? `${money(d.cost)} a month` : 'None'}</dd>
          </dl>
          <h3 className="dist-h">Style</h3>
          <div className="dist-styles" role="group" aria-label="Style">
            {STYLES.map((s) => (
              <button key={s.id} type="button" className="tb dist-style" data-testid={`district-style-${s.id}`} aria-pressed={d.style === s.id} onClick={() => client.command({ type: 'setDistrictStyle', district: d.id, style: s.id })}>
                <Swatch style={s.id} />{s.name}
              </button>
            ))}
          </div>
          <h3 className="dist-h">Edict</h3>
          <ul className="fw-edicts dist-edicts">
            {DISTRICT_EDICTS.map((e) => (
              <li key={e.id} className="fw-edict" data-testid={`district-edict-${e.id}`} data-active={d.edict === e.id}>
                <div className="fw-node-head">
                  <strong>{e.name}</strong>
                  <span className="fw-cost">{e.cost > 0 ? `${money(e.cost)} a month` : 'No fee'}</span>
                </div>
                <p>{e.blurb}</p>
                {e.effects.length > 0 && <ul className="fw-effects">{e.effects.map((x) => <li key={x.text} className={x.good ? 'up' : 'down'}>{x.text}</li>)}</ul>}
                <button type="button" className="tb wide" data-testid={`district-edict-set-${e.id}`} aria-pressed={d.edict === e.id} disabled={d.edict === e.id}
                  onClick={() => client.command({ type: 'setDistrictEdict', district: d.id, edict: e.id })}>
                  {d.edict === e.id ? (e.id === 0 ? 'No edict' : 'Enacted') : e.id === 0 ? 'Repeal' : 'Enact'}
                </button>
              </li>
            ))}
          </ul>
          <p className="fw-rp" data-testid="district-total">{districts.length} {districts.length === 1 ? 'district' : 'districts'}, {money(total)} a month in edicts</p>
          {onShow && <button type="button" className="tb wide" data-testid="district-show" onClick={() => onShow(d.cx, d.cy)}>Show on the map</button>}
        </>
      )}
    </Panel>
  );
}

/** Camera distances (tiles) between which district names float: close enough to read, far enough not to crowd a street. */
export const LABEL_NEAR = 16;
export const LABEL_FAR = 170;
const LABEL_FADE = 0.2;
const LABEL_MS = 100;

/** How opaque a label is at camera distance `dist`: 0 outside [LABEL_NEAR, LABEL_FAR], fading in and out over the first and last LABEL_FADE of the range. */
export function labelOpacity(dist: number): number {
  if (dist < LABEL_NEAR || dist > LABEL_FAR) return 0;
  const t = (dist - LABEL_NEAR) / (LABEL_FAR - LABEL_NEAR);
  return Math.min(1, t / LABEL_FADE, (1 - t) / LABEL_FADE);
}

interface LabelProps {
  districts: readonly DistrictStat[];
  game: MutableRefObject<Game | null>;
  mirror: RenderMirror;
}

/**
 * The names of the districts, floating over their centres at mid zoom. DOM text positioned by projection ten times a second, so there is no text atlas
 * to build and nothing to draw on a phone's GPU; it hides at far zoom and when the centre is off screen or behind the camera.
 */
export function DistrictLabels({ districts, game, mirror }: LabelProps) {
  const els = useRef(new Map<number, HTMLDivElement>());
  const live = useRef(districts);
  live.current = districts;
  useEffect(() => {
    const tick = (): void => {
      const dbg = game.current?.debug;
      const host = document.querySelector('.game-host');
      for (const d of live.current) {
        const el = els.current.get(d.id);
        if (!el) continue;
        let show = false;
        if (dbg && host) {
          const opacity = labelOpacity(dbg.camera.dist);
          const p = opacity > 0 ? dbg.project(d.cx + 0.5, Math.max(0, mirror.heightAt(d.cx, d.cy)) + 2, d.cy + 0.5) : null;
          if (p && p.px >= 0 && p.py >= 0 && p.px <= host.clientWidth && p.py <= host.clientHeight) {
            el.style.transform = `translate(${Math.round(p.px)}px, ${Math.round(p.py)}px) translate(-50%, -50%)`;
            el.style.opacity = String(opacity);
            show = true;
          }
        }
        el.hidden = !show;
      }
    };
    tick();
    const id = window.setInterval(tick, LABEL_MS);
    return () => window.clearInterval(id);
  }, [game, mirror]);
  return (
    <div className="district-labels" aria-hidden="true" data-testid="district-labels">
      {districts.map((d) => (
        <div
          key={d.id} hidden className="district-label" data-testid={`district-label-${d.id}`} data-district={d.id} style={{ color: STYLES[d.style]?.css }}
          ref={(el) => { if (el) els.current.set(d.id, el); else els.current.delete(d.id); }}
        >{d.name}</div>
      ))}
    </div>
  );
}
