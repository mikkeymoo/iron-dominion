import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { RenderMirror } from '../render/mirror.ts';
import type { SimClient } from '../sim/client.ts';
import { archLabel, capitalise } from '../sim/labels.ts';
import type { BlueprintStat } from '../sim/protocol.ts';
import { Panel } from './Panel';
import './blueprints.css';

// The build queue: blueprints the player planned, in the order the robots take them. Each row can be pinned to the front ("Next"),
// nudged up or down, dragged by its pin to any place in the list, jumped to on the map, or cancelled. Nothing is paid until a robot starts one.

const POLL_MS = 200;

export const etaText = (sec: number): string => (sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`);
const money = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;

interface Props { mirror: RenderMirror; client: SimClient; onJump?(x: number, y: number): void }

export function BlueprintQueue({ mirror, client, onJump }: Props) {
  const [list, setList] = useState<readonly BlueprintStat[]>(mirror.blueprints);
  const seen = useRef(mirror.blueprintVersion);
  const [drag, setDrag] = useState<{ slot: number; over: number } | null>(null);
  useEffect(() => {
    const id = window.setInterval(() => {
      if (seen.current === mirror.blueprintVersion) return;
      seen.current = mirror.blueprintVersion;
      setList(mirror.blueprints);
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [mirror]);

  const move = (slot: number, to: number): void => { client.command({ type: 'moveBlueprint', slot, to }); };
  const cancel = (slot: number): void => { client.command({ type: 'cancelBlueprint', slot }); };

  const rowUnder = (x: number, y: number): number => {
    const el = document.elementFromPoint(x, y)?.closest('[data-bp-order]');
    return el instanceof HTMLElement ? Number(el.dataset.bpOrder) : -1;
  };
  const pinDown = (b: BlueprintStat) => (e: ReactPointerEvent<HTMLElement>): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDrag({ slot: b.slot, over: b.order });
  };
  const pinMove = (e: ReactPointerEvent<HTMLElement>): void => {
    if (!drag) return;
    const over = rowUnder(e.clientX, e.clientY);
    if (over >= 0 && over !== drag.over) setDrag({ slot: drag.slot, over });
  };
  const pinUp = (b: BlueprintStat) => (e: ReactPointerEvent<HTMLElement>): void => {
    if (!drag) return;
    const over = rowUnder(e.clientX, e.clientY);
    setDrag(null);
    if (over >= 0 && over !== b.order) move(b.slot, over);
  };

  if (list.length === 0) return null;
  return (
    <Panel id="blueprints" kind="card" title={`Build queue (${list.length})`} className="bp-queue" testId="bp-queue" panelAttr="blueprints" autoFocus={false}>
      <p className="bp-note">Planned buildings cost nothing until the robots start them. The top one goes first.</p>
      <ol className="bp-list" data-testid="bp-list">
        {list.map((b) => (
          <li
            key={b.slot} className="bp-row" data-testid="bp-row" data-slot={b.slot} data-bp-order={b.order} data-first={b.order === 0}
            data-over={drag !== null && drag.over === b.order && drag.slot !== b.slot} data-dragging={drag?.slot === b.slot}
          >
            <button
              type="button" className="bp-pin" data-testid="bp-pin" aria-label={`Drag ${capitalise(archLabel(b.arch))} to reorder`} title="Drag to reorder"
              onPointerDown={pinDown(b)} onPointerMove={pinMove} onPointerUp={pinUp(b)} onPointerCancel={() => setDrag(null)}
            >{b.order + 1}</button>
            <button type="button" className="bp-name" data-testid="bp-name" title="Show on the map" onClick={() => onJump?.(b.x, b.y)}>
              <strong>{capitalise(archLabel(b.arch))}</strong>
              <span className="bp-meta">{money(b.cost)} · ~{etaText(b.etaSec)}</span>
            </button>
            <span className="bp-acts">
              <button type="button" className="tb bp-next" data-testid="bp-next" disabled={b.order === 0} aria-label={`Build ${archLabel(b.arch)} next`} onClick={() => move(b.slot, 0)}>Next</button>
              <button type="button" className="tb bp-up" data-testid="bp-up" disabled={b.order === 0} aria-label="Move up" onClick={() => move(b.slot, b.order - 1)}>{'▲'}</button>
              <button type="button" className="tb bp-down" data-testid="bp-down" disabled={b.order === list.length - 1} aria-label="Move down" onClick={() => move(b.slot, b.order + 1)}>{'▼'}</button>
              <button type="button" className="tb bp-cancel" data-testid="bp-cancel" aria-label={`Cancel ${archLabel(b.arch)}`} onClick={() => cancel(b.slot)}>{'✕'}</button>
            </span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}
