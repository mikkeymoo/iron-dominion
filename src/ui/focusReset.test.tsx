import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useLeaveFocusOnOpen } from './focusReset.ts';

describe('leaving focus mode when a session opens', () => {
  it('turns a saved focus mode off once as the new session mounts', () => {
    const onSetting = vi.fn();
    const { rerender } = renderHook(({ focus }) => useLeaveFocusOnOpen({ focus }, onSetting), { initialProps: { focus: true } });
    expect(onSetting).toHaveBeenCalledTimes(1);
    expect(onSetting).toHaveBeenCalledWith('focus', false);
    rerender({ focus: true });
    expect(onSetting, 'turning it on again inside the session is the player\'s choice').toHaveBeenCalledTimes(1);
  });

  it('leaves a session that opens without focus mode alone, and does not fight a later switch on', () => {
    const onSetting = vi.fn();
    const { rerender } = renderHook(({ focus }) => useLeaveFocusOnOpen({ focus }, onSetting), { initialProps: { focus: false } });
    rerender({ focus: true });
    expect(onSetting).not.toHaveBeenCalled();
  });
});
