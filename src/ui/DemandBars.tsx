const ZONES = [
  { key: 'R', label: 'Residential', color: '#3fb950' },
  { key: 'C', label: 'Commercial', color: '#58a6ff' },
  { key: 'I', label: 'Industrial', color: '#e3a008' },
] as const;

interface Props { demand: readonly [number, number, number] }

/** Three vertical bars, one per zone: demand above the midline is wanted growth, below it is surplus. */
export function DemandBars({ demand }: Props) {
  return (
    <div className="demand" role="group" aria-label="Zone demand" data-testid="demand">
      {ZONES.map((z, k) => {
        const d = Math.max(-1, Math.min(1, demand[k]!));
        const pct = Math.round(d * 100);
        const half = `${Math.abs(d) * 50}%`;
        return (
          <div key={z.key} className="demand-bar" role="img" aria-label={`${z.label} demand ${pct} percent`} title={`${z.label} demand ${pct}%`} data-testid={`demand-${z.key}`} data-demand={d}>
            <div className="demand-track">
              <div className="demand-fill" style={d >= 0 ? { background: z.color, bottom: '50%', height: half } : { background: z.color, top: '50%', height: half, opacity: 0.55 }} />
            </div>
            <span aria-hidden="true">{z.key}</span>
          </div>
        );
      })}
    </div>
  );
}
