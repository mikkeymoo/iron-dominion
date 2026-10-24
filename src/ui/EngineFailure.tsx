import { describeFailure, repairAndReload } from '../platform/repair.ts';

interface Props {
  /** The raw failure message from the sim client or the renderer. */
  detail: string | undefined;
  /** Replaces the default repair action; tests pass a stub. */
  onRepair?(): void;
}

/** A readable reason, the raw detail on a tap, and the way out: clear this scope's service worker and caches, then reload. */
export function EngineFailure({ detail, onRepair }: Props) {
  const f = describeFailure(detail);
  return (
    <div className="engine-failure" role="alert" data-kind={f.kind}>
      <p className="reason">{f.reason}</p>
      <details className="detail">
        <summary>Details</summary>
        <code>{f.detail}</code>
      </details>
      <button className="primary" type="button" onClick={() => { if (onRepair) onRepair(); else void repairAndReload(); }}>Repair and reload</button>
    </div>
  );
}
