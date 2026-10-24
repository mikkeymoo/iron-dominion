import { RES_NAMES } from '../sim/robots/constants.ts';
import type { BuildingInfo, Workforce } from '../sim/protocol.ts';
import { Panel } from './Panel';
import './chain.css';

// Production-chain readouts: the HUD resource chips (Ore, Alloy, Components) and a building card's stock gauges and needs checklist.

const TITLES = ['Ore: held by depots, mines and industry', 'Alloy: made by smelters from ore', 'Components: made by factories from alloy'] as const;

/** Three chips, one per resource: a dot in the colour of its crate and the units on hand. */
export function ResourceChips({ workforce }: { workforce: Workforce }) {
  const counts = [workforce.stock, workforce.alloy, workforce.parts];
  return (
    <Panel id="resources" kind="section" title="Resources" className="res-chips" testId="resources" remember={false}>
      <div className="res-row">
        {counts.map((n, res) => (
          <span key={res} className="res-chip" data-res={res} data-testid="res-chip" title={TITLES[res]}>
            <i className="res-dot" aria-hidden="true" />
            <span className="res-name">{RES_NAMES[res]}</span>
            <b className="res-n">{n.toLocaleString('en-US')}</b>
          </span>
        ))}
      </div>
    </Panel>
  );
}

const ROLE_WORD = { in: 'input', out: 'output', stock: 'stock' } as const;

/** Stock gauges and the needs checklist of a Mine, Smelter, Factory or depot, and the level-up needs of a grown building. */
export function BuildingChain({ info }: { info: BuildingInfo }) {
  const { stocks, needs } = info;
  const levelUp = info.maxLevel > 0;
  return (
    <>
      {stocks && stocks.length > 0 && (
        <Panel id="chain-stocks" kind="section" title="Stock" remember={false}>
          <div className="stock-bars" data-testid="stock-bars">
            {stocks.map((b, i) => (
              <div key={`${b.res}:${b.role}:${i}`} className="stock-bar" data-res={b.res} data-role={b.role} data-testid="stock-bar">
                <span className="stock-label">{RES_NAMES[b.res]} {ROLE_WORD[b.role]}</span>
                <span className="stock-track" role="progressbar" aria-valuemin={0} aria-valuemax={b.cap} aria-valuenow={b.have} aria-label={`${RES_NAMES[b.res]} ${ROLE_WORD[b.role]}`}>
                  <span className="stock-fill" style={{ width: `${Math.min(100, Math.round((b.have * 100) / Math.max(1, b.cap)))}%` }} />
                </span>
                <span className="stock-n">{b.have}/{b.cap}</span>
              </div>
            ))}
          </div>
        </Panel>
      )}
      {needs && needs.length > 0 && (
        <Panel id="chain-needs" kind="section" title={levelUp ? 'Needs to grow' : 'Needs'} remember={false}>
          <ul className="needs" data-testid="needs">
            {needs.map((n) => (
              <li key={n.text} className={n.ok ? 'ok' : 'miss'} data-ok={n.ok}>
                <span className="need-mark" aria-hidden="true">{n.ok ? '✓' : '✗'}</span>
                <span>{n.text}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}
