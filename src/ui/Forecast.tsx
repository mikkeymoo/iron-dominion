import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { HazardStats } from '../sim/protocol.ts';
import { HAZARD_NAMES } from '../sim/disasters/hazardNames.ts';
import { SEASON_DAYS } from '../sim/seasons.ts';
import { useSlot } from './AdvisorChip';
import { HazardIcon, SeasonIcon } from './ForecastIcons';
import { chipLabel, daylightLine, daysLeftInSeason, forecastLine, hazardBlurb, helpFor, money, rebuildLabel, seasonDay, seasonName, unprepared } from './forecastCopy';
import { Panel } from './Panel';
import { PANEL_ATTR, useOutsideDismiss } from './panels';
import './forecast.css';

interface Props {
  /** From the newest Stats message; absent until the first one. */
  hazards: HazardStats | undefined;
  tier: number;
  treasury: number;
  /** Arm the placement tool for a building (the "Build" button on a defence). */
  onBuild(arch: number): void;
  /** Send the rebuildAll command. */
  onRebuildAll(): void;
}

/**
 * The forecast strip: a chip in the top bar (season icon and "Storm season in 1 month") that opens a Panel with the season, the
 * coming hazard, what helps against it and, after a disaster, the Rebuild all button.
 */
export function ForecastUi({ hazards, tier, treasury, onBuild, onRebuildAll }: Props) {
  const [open, setOpen] = useState(false);
  const slot = useSlot('forecast');
  useOutsideDismiss(open, () => setOpen(false), () => setOpen(false));
  if (!hazards) return null;
  const f = hazards.forecast;
  const bad = unprepared(hazards);
  const help = f ? helpFor(f, tier) : null;
  const ruins = hazards.ruins + hazards.queued;

  const chip = (
    <button
      type="button" className={`forecast-chip${bad ? ' alert' : ''}${f?.active ? ' active' : ''}`} data-testid="forecast-chip"
      data-season={hazards.season} data-kind={f?.kind ?? 0} data-ready={f ? (f.prep.applicable ? (f.prep.ready ? 'yes' : 'no') : 'na') : 'none'}
      aria-expanded={open} aria-haspopup="dialog" aria-label={`Forecast: ${chipLabel(hazards)}`} title={f ? hazardBlurb(f.kind) : `${seasonName(hazards)}, day ${seasonDay(hazards)} of ${SEASON_DAYS}`}
      onClick={() => setOpen((o) => !o)}
    >
      <SeasonIcon season={hazards.season} />
      <span className="forecast-text" data-testid="forecast-text">{chipLabel(hazards)}</span>
      {f && <HazardIcon kind={f.kind} />}
      {ruins > 0 && <span className="forecast-badge" data-testid="forecast-ruins" title="Ruins to rebuild">{ruins}</span>}
    </button>
  );

  const card = open && (
    <div className="forecast-pos" {...{ [PANEL_ATTR]: 'forecast' }}>
      <Panel id="forecast" kind="card" title="Forecast" className="forecast-card" testId="forecast-card" panelAttr="forecast" onClose={() => setOpen(false)} autoFocus={false}>
        <div className="forecast-body">
          <section className="forecast-season" data-testid="forecast-season">
            <SeasonIcon season={hazards.season} />
            <div>
              <strong>{seasonName(hazards)}</strong>
              <span> · day {seasonDay(hazards)} of {SEASON_DAYS}, {daysLeftInSeason(hazards)} left</span>
              <p className="forecast-sub">{daylightLine(hazards.daylight)}. Power use {Math.round(hazards.climate * 100)}% of normal.</p>
            </div>
          </section>

          {f ? (
            <section className={`forecast-hazard${bad ? ' bad' : ''}`} data-testid="forecast-hazard" data-kind={f.kind}>
              <header><HazardIcon kind={f.kind} /><strong>{forecastLine(f)}</strong><span className="forecast-level" title="Hazards grow with the city">Level {f.level}</span></header>
              <p>{hazardBlurb(f.kind)}</p>
              {help && (
                <div className="forecast-help" data-testid="forecast-help">
                  <p><strong>{help.name}</strong> ({money(help.cost)}). {help.text}</p>
                  <p className={`forecast-status ${f.prep.applicable ? (f.prep.ready ? 'ok' : 'warn') : ''}`} data-testid="forecast-status">{help.status}</p>
                  <button
                    type="button" className="tb row" data-testid="forecast-build" disabled={help.locked || treasury < help.cost}
                    title={help.locked ? 'Not unlocked yet. Grow the city to the next milestone.' : undefined} onClick={() => { setOpen(false); onBuild(help.arch); }}
                  >Build a {help.name.toLowerCase()}</button>
                </div>
              )}
              {f.bonus > 0 && <p className="forecast-bonus" data-testid="forecast-bonus">The city was ready: +{money(f.bonus)}.</p>}
            </section>
          ) : (
            <section className="forecast-hazard calm" data-testid="forecast-calm">
              <p>No hazard is forecast. The next one is announced one to two months before it arrives.</p>
              <p className="forecast-sub">{HAZARD_NAMES.slice(1).join(', ')}.</p>
            </section>
          )}

          <section className="forecast-kit" data-testid="forecast-kit">
            <span>Rods {hazards.kit.rods}</span><span>Batteries {hazards.kit.batteries}{hazards.kit.batteries > 0 ? ` (${Math.round(hazards.kit.charge * 100)}%)` : ''}</span>
            <span>Dampers {hazards.kit.dampers}</span><span>Domes {hazards.kit.domes}</span>
          </section>

          {ruins > 0 && (
            <section className="forecast-rebuild" data-testid="forecast-recovery">
              <p>{rebuildLabel(hazards)}</p>
              <button
                type="button" className="tb row" data-testid="forecast-rebuild" disabled={hazards.ruins === 0 || treasury < hazards.rebuildCost}
                title={treasury < hazards.rebuildCost ? 'Not enough money for that.' : 'Robots clear every ruin and build it again'} onClick={onRebuildAll}
              >Rebuild all</button>
            </section>
          )}
        </div>
      </Panel>
    </div>
  );

  const body = (
    <div className="forecast" {...{ [PANEL_ATTR]: 'forecast' }} data-testid="forecast">
      {chip}
    </div>
  );
  return (
    <>
      {slot ? createPortal(body, slot) : <div className="forecast-fallback">{body}</div>}
      {card}
    </>
  );
}
