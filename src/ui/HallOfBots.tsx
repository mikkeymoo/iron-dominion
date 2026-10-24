import type { NamedBot } from '../sim/protocol.ts';
import { NAMED_JOBS } from '../sim/robots/names.ts';
import { Panel } from './Panel';
import './away.css';

interface Props {
  bots: readonly NamedBot[] | undefined;
  /** Chase a bot by its agent key; false when it is gone. */
  onFollow(key: number): boolean;
  onClose(): void;
}

const ROLE: Record<number, string> = { 1: 'Builder bot', 2: 'Hauler drone' };

/** Every bot that has earned a name, busiest first, each with a Follow button. */
export function HallOfBots({ bots, onFollow, onClose }: Props) {
  const list = bots ?? [];
  return (
    <Panel id="bots" title="Hall of Bots" className="hall" panelAttr="bots" testId="hall-of-bots" onClose={onClose}>
      {list.length === 0
        ? <p className="hint" data-testid="hall-empty">No bot has earned a name yet. A builder or hauler drone earns one, and a hat, after {NAMED_JOBS} jobs.</p>
        : (
          <ul className="hall-list" data-testid="hall-list">
            {list.map((b) => (
              <li key={b.key} data-testid="hall-bot">
                <span className="who"><strong>{b.name}</strong><small>{ROLE[b.akind] ?? 'Bot'}, {b.jobs.toLocaleString('en-US')} jobs</small></span>
                <button type="button" className="tb" data-testid="hall-follow" aria-label={`Follow ${b.name}`} onClick={() => { if (onFollow(b.key)) onClose(); }}>Follow</button>
              </li>
            ))}
          </ul>
        )}
    </Panel>
  );
}
