import { useEffect, useRef, useState } from 'react';
import type { Campaign, Command } from './types';
import { SimClock } from './lifecycle';
import { advance } from './engine';
import { saveCampaign } from './persistence';
import { tryCommand } from './simulation';

export function useCampaign(state: Campaign | null) {
 const clock=useRef(new SimClock());
 const [paused,setPaused]=useState(true);
 const [version,setVersion]=useState(0);
 const [error,setError]=useState('');
 const savedAt=useRef(0);
 const save=()=>{ if(!state)return; const r=saveCampaign(state);setError(r.ok?'':r.error||'Save failed. Export a backup.'); };
 const pause=()=>{clock.current.pause();setPaused(true);save();};
 const resume=()=>{if(document.hidden||state?.status!=='playing')return;clock.current.resume(performance.now());setPaused(false);};
 const command=(c:Command)=>{if(!state)return;const r=tryCommand(state,c);if(!r.ok)setError(r.error||'Command failed');else save();setVersion(v=>v+1);return r;};
 useEffect(()=>{
  clock.current.pause();setPaused(true);savedAt.current=state?.time||0;
  const hidden=()=>{clock.current.hide();setPaused(true);save();};
  document.addEventListener('visibilitychange',hidden);
  window.addEventListener('pagehide',hidden);
  const timer=window.setInterval(()=>{
   if(!state||document.hidden)return;
   const steps=clock.current.frame(performance.now());
   for(let i=0;i<steps;i++)advance(state,.1);
   if(state.status!=='playing'&&clock.current.running){clock.current.pause();setPaused(true);save();}
   if(steps){setVersion(v=>v+1);if(state.time-savedAt.current>=5){save();savedAt.current=state.time;}}
  },50);
  return()=>{clearInterval(timer);clock.current.pause();document.removeEventListener('visibilitychange',hidden);window.removeEventListener('pagehide',hidden);};
 },[state]);
 return {paused,version,error,setError,command,pause,resume,save};
}
