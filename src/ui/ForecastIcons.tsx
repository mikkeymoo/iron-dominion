import type { ReactNode } from 'react';

// Inline SVG icons for the forecast chip (24x24, stroked with currentColor), like ui/whyIcons.tsx: one per season and one per hazard.
function Svg({ children }: { children: ReactNode }) {
  return (
    <svg className="ico" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

const SEASONS: (() => ReactNode)[] = [
  // Spring: a sprout.
  () => <Svg><path d="M12 20v-8" /><path d="M12 12c0-3.5-2.5-5.5-6-5.5 0 3.5 2.5 5.5 6 5.5z" /><path d="M12 14c0-3 2-5 5.5-5 0 3-2 5-5.5 5z" /></Svg>,
  // Summer: a sun.
  () => <Svg><circle cx="12" cy="12" r="4" /><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8" /></Svg>,
  // Autumn: a leaf.
  () => <Svg><path d="M5 19c0-9 5-14 14-14 0 9-5 14-14 14z" /><path d="M5 19L14 10" /></Svg>,
  // Winter: a snowflake.
  () => <Svg><path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9" /><path d="M9.5 4.5L12 6.5l2.5-2M9.5 19.5L12 17.5l2.5 2" /></Svg>,
];

const HAZARDS: (() => ReactNode)[] = [
  () => null,
  // Storm: a bolt.
  () => <Svg><path d="M13 3L5 13.5h6L10 21l9-11h-6.5z" /></Svg>,
  // Heatwave: a thermometer.
  () => <Svg><path d="M10 14.5V5a2 2 0 014 0v9.5a4 4 0 11-4 0z" /><path d="M12 9v7" /></Svg>,
  // Cold snap: a snowflake.
  () => <Svg><path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9" /></Svg>,
  // Meteor: a rock with a tail.
  () => <Svg><circle cx="15.5" cy="15.5" r="4" /><path d="M12.5 12.5L4 4M13 9L7 3M9 13L3 7" /></Svg>,
  // Quakes: a crack.
  () => <Svg><path d="M3 12h4l2-5 3 10 2-7 2 4h5" /></Svg>,
];

export function SeasonIcon({ season }: { season: number }) {
  return <>{(SEASONS[season] ?? SEASONS[0]!)()}</>;
}

export function HazardIcon({ kind }: { kind: number }) {
  return <>{(HAZARDS[kind] ?? HAZARDS[0]!)()}</>;
}
