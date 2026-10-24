import { useEffect, useRef } from 'react';
import type { Settings } from '../platform/settings.ts';

/**
 * Focus mode hides the HUD, and it is a saved setting: a city opened later (a new game, a load, a retry) must not start inside it.
 * The game view is keyed per session, so this runs once as each session's view mounts.
 */
export function useLeaveFocusOnOpen(settings: Pick<Settings, 'focus'>, onSetting: (key: 'focus', value: boolean) => void): void {
  const first = useRef({ focus: settings.focus, onSetting });
  useEffect(() => { if (first.current.focus) first.current.onSetting('focus', false); }, []);
}
