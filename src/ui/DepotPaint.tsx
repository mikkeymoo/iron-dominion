import { LIVERIES } from '../sim/robots/livery.ts';
import { Panel } from './Panel';
import './away.css';

export interface DepotPaintControls {
  set(slot: number, livery: number): void;
}

interface Props {
  slot: number;
  /** The scheme the depot wears now. */
  livery: number;
  controls: DepotPaintControls;
}

/** Six paint schemes for a depot; its builders and hauler drones wear the scheme of their home depot. Rendered inside the depot's info card. */
export function DepotPaint({ slot, livery, controls }: Props) {
  return (
    <section className="depot-paint" aria-label="Depot paint" data-testid="depot-paint">
      <Panel id="depot-paint" kind="section" title="Paint">
        <div className="paint-swatches" role="group" aria-label="Paint scheme">
          {LIVERIES.map((l) => (
            <button
              key={l.id} type="button" className="paint-swatch" data-testid={`paint-${l.id}`} aria-pressed={livery === l.id} aria-label={l.name} title={l.name}
              style={{ ['--paint' as string]: `#${l.hex.toString(16).padStart(6, '0')}` }} onClick={() => { if (livery !== l.id) controls.set(slot, l.id); }}
            />
          ))}
        </div>
        <p className="paint-name" data-testid="paint-name">{LIVERIES[livery]?.name ?? LIVERIES[0]!.name}. Its bots wear this.</p>
      </Panel>
    </section>
  );
}
