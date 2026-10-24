import type { ReactNode } from 'react';

// Inline SVG icons (24x24, stroked with currentColor), so the HUD has no icon-font or image dependency.
function Svg({ children }: { children: ReactNode }) {
  return (
    <svg className="ico" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export const IconBulldoze = () => <Svg><path d="M3 17h13M5 17V9h7l2 4h2v4" /><path d="M16 12l5-4M21 8v6" /><circle cx="7" cy="19" r="1.6" /><circle cx="13" cy="19" r="1.6" /></Svg>;
export const IconRoad = () => <Svg><path d="M8 3L4 21M16 3l4 18" /><path d="M12 5v2.5M12 11v2.5M12 17v2.5" /></Svg>;
export const IconZone = () => <Svg><rect x="4" y="4" width="7" height="7" rx="1" /><rect x="13" y="4" width="7" height="7" rx="1" /><rect x="4" y="13" width="7" height="7" rx="1" /><path d="M13 16.5h7M16.5 13v7" /></Svg>;
export const IconServices = () => <Svg><path d="M4 20V10l8-6 8 6v10z" /><path d="M12 9v6M9 12h6" /></Svg>;
export const IconUtilities = () => <Svg><path d="M13 3L5 13.5h6L10 21l9-11h-6.5z" /></Svg>;
export const IconTerraform = () => <Svg><path d="M2 19l6-9 4 5 3-4 7 8z" /><path d="M12 3v4M10 5l2-2 2 2" /></Svg>;
export const IconUndo = () => <Svg><path d="M9 7L4 12l5 5" /><path d="M4 12h10a6 6 0 010 8h-3" /></Svg>;
export const IconViews = () => <Svg><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></Svg>;
export const IconCancel = () => <Svg><path d="M6 6l12 12M18 6L6 18" /></Svg>;
export const IconChevron = () => <Svg><path d="M6 9l6 6 6-6" /></Svg>;
export const IconHammer = () => <Svg><path d="M14 4l6 6-3 3-6-6z" /><path d="M12 8L4 16l4 4 8-8" /><path d="M5 21h6" /></Svg>;
export const IconMenu = () => <Svg><path d="M4 7h16M4 12h16M4 17h16" /></Svg>;
export const IconPlay = () => <Svg><path d="M8 5v14l11-7z" /></Svg>;
export const IconPause = () => <Svg><path d="M8 5v14M16 5v14" /></Svg>;
export const IconRobot = () => <Svg><rect x="5" y="8" width="14" height="11" rx="2" /><path d="M12 8V4M9 13h.01M15 13h.01M9.5 16.5h5" /><circle cx="12" cy="3.5" r="1" /></Svg>;
