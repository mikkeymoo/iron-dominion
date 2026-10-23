import { useEffect, useReducer } from 'react';
import { ROAD_COST } from '../sim/catalog.ts';
import { isEditableTarget } from '../render/editable.ts';
import {
  DENSITY_LABELS, ROAD_NAMES, SERVICES, TERRAFORM_MODES, ZONE_LABELS, keyAction, type ToolId, type ToolSel,
} from '../render/tools/toolSpec.ts';
import { reasonText, type ToolsRuntime } from './toolsStore.ts';

const CATEGORIES: { id: ToolId; label: string; key: string; start: ToolSel }[] = [
  { id: 'bulldoze', label: 'Bulldoze', key: 'B', start: { tool: 'bulldoze' } },
  { id: 'road', label: 'Road', key: 'R', start: { tool: 'road', cls: 1 } },
  { id: 'zone', label: 'Zone', key: 'Z', start: { tool: 'zone', zone: 1, density: 0 } },
  { id: 'service', label: 'Services', key: '', start: { tool: 'service', arch: SERVICES[0]!.id } },
  { id: 'terraform', label: 'Terraform', key: 'T', start: { tool: 'terraform', mode: 'raise' } },
];

const SERVICE_LABELS: Record<string, string> = { depot: 'Depot', powerPlant: 'Power plant', waterPump: 'Water pump', fireStation: 'Fire station' };
const MODE_LABELS = { raise: 'Raise', lower: 'Lower', level: 'Level' } as const;

const money = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;

export function Tools({ runtime }: { runtime: ToolsRuntime }) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => runtime.subscribe(bump), [runtime]);

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
        {runtime.toasts.map((t) => <div key={t.id} className="tool-toast" data-testid="toast">{t.text}</div>)}
      </div>

      <div className="toolsheet" role="toolbar" aria-label="Build tools">
        {sel && (
          <div className="tool-row tool-options" role="group" aria-label="Tool options">
            {sel.tool === 'road' && ([1, 2, 3] as const).map((cls) => (
              <button key={cls} type="button" className="tb" aria-pressed={sel.cls === cls} onClick={() => pick({ tool: 'road', cls })}>
                {ROAD_NAMES[cls]} {money(ROAD_COST[cls]!)}
              </button>
            ))}
            {sel.tool === 'zone' && (
              <>
                {([1, 2, 3] as const).map((zone) => (
                  <button key={zone} type="button" className="tb" aria-pressed={sel.zone === zone} onClick={() => pick({ ...sel, zone })}>{ZONE_LABELS[zone]}</button>
                ))}
                <span className="tool-gap" />
                {([0, 1, 2] as const).map((density) => (
                  <button key={density} type="button" className="tb" aria-pressed={sel.density === density} onClick={() => pick({ ...sel, density })}>{DENSITY_LABELS[density]}</button>
                ))}
              </>
            )}
            {sel.tool === 'service' && (
              <>
                {SERVICES.map((s) => (
                  <button key={s.id} type="button" className="tb" aria-pressed={sel.arch === s.id} onClick={() => pick({ tool: 'service', arch: s.id })}>
                    {SERVICE_LABELS[s.name] ?? s.name} {money(s.cost)}
                  </button>
                ))}
                <button type="button" className="tb" onClick={() => c.rotate()} title="Rotate (R)">Rotate</button>
              </>
            )}
            {sel.tool === 'terraform' && TERRAFORM_MODES.map((mode) => (
              <button key={mode} type="button" className="tb" aria-pressed={sel.mode === mode} onClick={() => pick({ tool: 'terraform', mode })}>{MODE_LABELS[mode]}</button>
            ))}
            {sel.tool === 'bulldoze' && <span className="tool-hint">Drag over roads, zones and buildings to clear them.</span>}
          </div>
        )}
        <div className="tool-row" role="group" aria-label="Tools">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.id} type="button" className="tb" aria-pressed={sel?.tool === cat.id}
              title={cat.key ? `${cat.label} (${cat.key})` : cat.label}
              onClick={() => (sel?.tool === cat.id ? c.cancel() : pick(cat.start))}
            >{cat.label}</button>
          ))}
          <button type="button" className="tb" disabled={!runtime.canUndo} title="Undo (Ctrl+Z)" onClick={() => runtime.undoLast()}>Undo</button>
          <button type="button" className="tb" disabled={!sel} title="Cancel (Esc)" onClick={() => c.cancel()}>Cancel</button>
        </div>
      </div>
    </>
  );
}
