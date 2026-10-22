import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCampaign } from './world';
import { SAVE_KEY, parseSave } from './persistence';
import { useCampaign } from './useCampaign';

afterEach(()=>{vi.useRealTimers();localStorage.clear();});
describe('campaign lifecycle integration',()=>{
 it('saves production commands and only resumes on explicit request',()=>{
  const s=createCampaign(1); const {result}=renderHook(()=>useCampaign(s));
  expect(result.current.paused).toBe(true);
  act(()=>result.current.command({type:'recruit',regionId:0,unit:'assault'}));
  expect(parseSave(localStorage.getItem(SAVE_KEY)!).regions[0].queue).toHaveLength(1);
  act(()=>result.current.resume()); expect(result.current.paused).toBe(false);
  act(()=>document.dispatchEvent(new Event('visibilitychange')));
  expect(result.current.paused).toBe(true);
 });
 it('hiding and returning adds no simulation time until resume',()=>{
  vi.useFakeTimers(); const s=createCampaign(1); const {result}=renderHook(()=>useCampaign(s));
  act(()=>result.current.resume()); act(()=>vi.advanceTimersByTime(1000));
  const before=s.time; expect(before).toBeGreaterThan(0);
  act(()=>document.dispatchEvent(new Event('visibilitychange')));
  act(()=>vi.advanceTimersByTime(600000)); expect(s.time).toBe(before);
  act(()=>result.current.resume()); act(()=>vi.advanceTimersByTime(100));
  expect(s.time-before).toBeCloseTo(.1);
 });
});
