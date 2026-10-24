import { useEffect, useReducer, type ReactNode } from 'react';
import type { RadialController } from '../render/radial.ts';
import { IconBulldoze, IconRoad, IconRobot, IconServices, IconTerraform, IconUtilities, IconZone } from './icons';
import { PANEL_ATTR } from './panels';

const svg = (children: ReactNode) => (
  <svg className="ico" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{children}</svg>
);
const IconInfo = () => svg(<><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>);
const IconUpgrade = () => svg(<><path d="M12 19V5M6 11l6-6 6 6" /><path d="M6 20h12" /></>);

const ICONS: Record<string, () => ReactNode> = {
  road: IconRoad, zone: IconZone, service: IconServices, utilities: IconUtilities, terraform: IconTerraform,
  bulldoze: IconBulldoze, info: IconInfo, upgrade: IconUpgrade, 'upgrade-road': IconUpgrade, follow: IconRobot,
};

/**
 * The radial menu a long press or right-click opens. It only draws the controller's state: input.ts moves the highlight and
 * picks on release while a finger is still down, and a tap on an item picks it afterwards. Escape closes it.
 */
export function RadialMenu({ controller }: { controller: RadialController }) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => controller.subscribe(bump), [controller]);
  const open = controller.state !== null;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') controller.close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, controller]);

  const s = controller.state;
  if (!s) return null;
  const { layout } = s;
  return (
    <div className="radial" role="menu" aria-label="Quick actions" data-testid="radial" data-source={s.source} {...{ [PANEL_ATTR]: 'radial' }}>
      <span className="radial-hub" style={{ left: layout.center.x, top: layout.center.y, width: layout.radius * 2, height: layout.radius * 2 }} aria-hidden="true" />
      <span className="radial-dot" style={{ left: layout.origin.x, top: layout.origin.y }} aria-hidden="true" />
      {s.items.map((item, i) => {
        const slot = layout.items[i]!;
        const Icon = ICONS[item.id];
        return (
          <button
            key={item.id} type="button" role="menuitem" className={`radial-item${i === s.hover ? ' hover' : ''}`} data-testid={`radial-${item.id}`} disabled={item.disabled}
            aria-label={item.label} style={{ left: slot.x, top: slot.y, width: layout.itemSize, height: layout.itemSize }} onClick={() => controller.pick(i)}
          >
            {Icon ? <Icon /> : null}
            <span className="radial-label" aria-hidden="true">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
