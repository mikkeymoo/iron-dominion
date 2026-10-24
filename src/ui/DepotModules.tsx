import { Panel } from './Panel';
import { MODULES, MODULE_REFUND } from '../sim/firmware.ts';
import type { BuildingInfo } from '../sim/protocol.ts';
import './firmware.css';

export interface DepotModuleControls {
  /** Credits in the treasury, so a module the city cannot pay for is greyed out. */
  treasury: number;
  set(slot: number, index: number, module: number): void;
}

interface Props {
  slot: number;
  depot: NonNullable<BuildingInfo['depot']>;
  controls: DepotModuleControls;
}

/** What swapping `from` for `to` costs the treasury (a refund is negative). */
const swapCost = (from: number, to: number): number => MODULES[to]!.cost - Math.floor(MODULES[from]!.cost * MODULE_REFUND);

/** The two module slots of a depot: pick what each holds. Rendered inside the depot's info card. */
export function DepotModules({ slot, depot, controls }: Props) {
  return (
    <section className="depot-modules" aria-label="Depot modules" data-testid="depot-modules">
      <Panel id="depot-modules" kind="section" title="Modules">
      <p className="info-facts" data-testid="depot-caps">
        <span>Keeps {depot.builderCap} builders</span>
        <span>{depot.haulerCap} haulers</span>
        {depot.droneCap > 0 && <span>{depot.droneCap} fire {depot.droneCap === 1 ? 'drone' : 'drones'}</span>}
      </p>
      {[0, 1].map((index) => {
        const held = depot.modules[index]!;
        return (
          <div key={index} className="module-slot" role="group" aria-label={`Slot ${index + 1}`} data-testid={`module-slot-${index}`}>
            {MODULES.map((m) => {
              const cost = swapCost(held, m.id);
              const pressed = held === m.id;
              return (
                <button
                  key={m.id} type="button" className="tb module" aria-pressed={pressed} data-testid={`module-${index}-${m.id}`}
                  disabled={!pressed && cost > controls.treasury} title={m.effect || 'Remove the module'}
                  onClick={() => { if (!pressed) controls.set(slot, index, m.id); }}
                >
                  <span>{m.name}</span>
                  {!pressed && m.id !== 0 && <small>${cost.toLocaleString('en-US')}</small>}
                  {!pressed && m.id === 0 && held !== 0 && <small>refund ${(-cost).toLocaleString('en-US')}</small>}
                </button>
              );
            })}
          </div>
        );
      })}
      </Panel>
    </section>
  );
}
