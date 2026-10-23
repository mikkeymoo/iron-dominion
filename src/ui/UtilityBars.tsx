interface Net { supply: number; demand: number }

interface Props { power: Net; water: Net; unpowered: number; unwatered: number }

/** Share of demand the supply covers, 0..1; an idle network (no demand) counts as full when it produces anything. */
export const coverage = (n: Net): number => (n.demand <= 0 ? (n.supply > 0 ? 1 : 0) : Math.min(1, n.supply / n.demand));

export const utilityLevel = (n: Net): 'ok' | 'warn' | 'bad' => (n.demand <= 0 || n.supply >= n.demand ? 'ok' : n.supply > 0 ? 'warn' : 'bad');

function Bar({ id, label, unit, net, dark }: { id: string; label: string; unit: string; net: Net; dark: number }) {
  const level = utilityLevel(net);
  const pct = Math.round(coverage(net) * 100);
  const need = level === 'ok' ? '' : ` Demand is higher than supply${dark > 0 ? `, ${dark} building${dark === 1 ? ' is' : 's are'} without ${id === 'power' ? 'power' : 'water'}` : ''}.`;
  return (
    <div className={`util-bar ${level}`} role="img" aria-label={`${label} ${net.supply} of ${net.demand} ${unit} supplied.${need}`} title={`${label}: ${net.supply} supplied, ${net.demand} needed (${unit}).${need}`} data-testid={`util-${id}`} data-supply={net.supply} data-demand={net.demand} data-dark={dark}>
      <span className="util-label" aria-hidden="true">{label}</span>
      <div className="util-track"><div className="util-fill" style={{ width: `${pct}%` }} /></div>
      <span className="util-num" aria-hidden="true">{net.supply}/{net.demand}</span>
    </div>
  );
}

/**
 * Power and water supply against demand as two small bars. A bar goes amber when demand outruns supply (a brown-out has begun)
 * and red when nothing is supplied at all; the count of dark buildings sits beside it. Hidden until the city has either network.
 */
export function UtilityBars({ power, water, unpowered, unwatered }: Props) {
  const any = power.supply > 0 || power.demand > 0 || water.supply > 0 || water.demand > 0;
  if (!any) return null;
  return (
    <div className="util" role="group" aria-label="Power and water" data-testid="utilities">
      <Bar id="power" label="Power" unit="MW" net={power} dark={unpowered} />
      <Bar id="water" label="Water" unit="ML" net={water} dark={unwatered} />
      {(unpowered > 0 || unwatered > 0) && (
        <span className="util-warn" role="status" data-testid="util-warn">
          {unpowered > 0 && `${unpowered} without power`}
          {unpowered > 0 && unwatered > 0 && ', '}
          {unwatered > 0 && `${unwatered} without water`}
        </span>
      )}
    </div>
  );
}
