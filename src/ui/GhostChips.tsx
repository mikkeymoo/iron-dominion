import { useEffect, useMemo, useReducer } from 'react';
import { ghostChips } from '../render/tools/ghostScore.ts';
import type { WhyStore } from './whyStore.ts';
import './why.css';

const CHIP_H = 26;

/** The "+12 land value / smog over 14 homes / +3 buildings with fire cover" chips above the pointer while a building or zone is being placed. */
export function GhostChips({ why }: { why: WhyStore }) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const runtime = why.tools, c = runtime.controller;
  useEffect(() => runtime.subscribe(bump), [runtime]);
  const plan = c.plan, sel = c.sel;
  const visible = plan !== null && (c.dragging || sel?.tool === 'service');
  const chips = useMemo(() => (visible ? ghostChips(why.mirror, plan) : []), [visible, plan, c.version, why.mirror.buildingVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  if (chips.length === 0) return null;
  const w = typeof window === 'undefined' ? 400 : window.innerWidth;
  const left = Math.max(8, Math.min(c.screen.x + 14, w - 220));
  const top = Math.max(72, c.screen.y - 70 - chips.length * CHIP_H);
  return (
    <div className="ghost-chips" style={{ left, top }} data-testid="ghost-chips" aria-hidden="true">
      {chips.map((chip) => <span key={chip.id} className={`ghost-chip ${chip.tone}`} data-tone={chip.tone} data-chip={chip.id}>{chip.text}</span>)}
    </div>
  );
}
