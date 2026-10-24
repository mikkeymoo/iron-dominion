import type { ReactNode } from 'react';
import type { IssueKind } from '../sim/protocol.ts';

// Inline SVG icons for the advisor chip and the info card (24x24, stroked with currentColor), like ui/icons.tsx.
function Svg({ children }: { children: ReactNode }) {
  return (
    <svg className="ico" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

const ICONS: Record<IssueKind | 'ok', () => ReactNode> = {
  ok: () => <Svg><circle cx="12" cy="12" r="9" /><path d="M8.5 14.5c1 1.5 2.2 2.2 3.5 2.2s2.5-.7 3.5-2.2M9 9.5h.01M15 9.5h.01" /></Svg>,
  fire: () => <Svg><path d="M12 3c1 4 5 5.5 5 10a5 5 0 01-10 0c0-2 1-3 2-4 .3 1.5 1 2 2 2 0-3-.5-5 1-8z" /></Svg>,
  budget: () => <Svg><circle cx="12" cy="12" r="9" /><path d="M14.5 9.5c-.5-1-1.5-1.5-2.5-1.5-1.5 0-2.5.8-2.5 2s1 1.7 2.5 2 2.5.8 2.5 2-1 2-2.5 2c-1 0-2-.5-2.5-1.5M12 6.5V8m0 8v1.5" /></Svg>,
  depot: () => <Svg><rect x="5" y="8" width="14" height="11" rx="2" /><path d="M12 8V4M9 13h.01M15 13h.01M9.5 16.5h5" /><circle cx="12" cy="3.5" r="1" /></Svg>,
  power: () => <Svg><path d="M13 3L5 13.5h6L10 21l9-11h-6.5z" /></Svg>,
  water: () => <Svg><path d="M12 3s6 6.5 6 11a6 6 0 01-12 0c0-4.5 6-11 6-11z" /></Svg>,
  stuck: () => <Svg><circle cx="12" cy="12" r="9" /><path d="M8 8l8 8M16 8l-8 8" /></Svg>,
  jobs: () => <Svg><path d="M14 4l6 6-3 3-6-6z" /><path d="M12 8L4 16l4 4 8-8" /></Svg>,
  commute: () => <Svg><path d="M4 16V11l2-4h12l2 4v5z" /><path d="M4 16h16M7 19v-3M17 19v-3" /><circle cx="8" cy="13" r=".6" /><circle cx="16" cy="13" r=".6" /></Svg>,
  crime: () => <Svg><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" /><path d="M12 8v5M12 16h.01" /></Svg>,
  noFire: () => <Svg><path d="M12 3c1 4 5 5.5 5 10a5 5 0 01-10 0c0-2 1-3 2-4 .3 1.5 1 2 2 2 0-3-.5-5 1-8z" /><path d="M4 4l16 16" /></Svg>,
  noLand: () => <Svg><rect x="4" y="4" width="7" height="7" rx="1" /><rect x="13" y="4" width="7" height="7" rx="1" /><rect x="4" y="13" width="7" height="7" rx="1" /><path d="M13 16.5h7M16.5 13v7" /></Svg>,
  abandoned: () => <Svg><path d="M4 20V10l8-6 8 6v10z" /><path d="M9 11l6 6M15 11l-6 6" /></Svg>,
  resource: () => <Svg><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M4 7.5l8 4.5 8-4.5M12 12v9" /></Svg>,
  needs: () => <Svg><path d="M4 11l8-7 8 7v9H4z" /><path d="M12 10v4M12 17h.01" /></Svg>,
  request: () => <Svg><path d="M6 3h9l4 4v14H6z" /><path d="M15 3v4h4M9 12h7M9 16h5" /></Svg>,
  approval: () => <Svg><circle cx="12" cy="12" r="9" /><path d="M8.5 16.5c1-1.5 2.2-2.2 3.5-2.2s2.5.7 3.5 2.2M9 9.5h.01M15 9.5h.01" /></Svg>,
};

export function IssueIcon({ kind }: { kind: IssueKind | 'ok' }) {
  return <>{ICONS[kind]()}</>;
}
