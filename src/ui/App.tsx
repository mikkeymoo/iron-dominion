import { useEffect, useRef, useState } from 'react';
import { BUILD_HASH } from '../sim/buildinfo.ts';
import { createSimClient, type SimClient } from '../sim/client.ts';
import { RenderMirror } from '../render/mirror.ts';
import type { IronDebug } from '../render/debug.ts';
import { GameView } from './GameView';
import './app.css';

// Debug query: ?seed=42&haltAt=200 runs the sim from that seed and halts at tick 200, reporting the state hash.
// A halting run uses max speed. Without haltAt the worker still includes the hash in Stats every HASH_EVERY ticks;
// window.__iron.sim.hashTick says which tick that hash belongs to. ?autostart=1 skips the title screen.
const HASH_EVERY = 100;

interface Session { client: SimClient; mirror: RenderMirror }

export function App() {
  const [worker, setWorker] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [tick, setTick] = useState(0);
  const [view, setView] = useState<'title' | 'game'>(() => (new URLSearchParams(window.location.search).get('autostart') === '1' ? 'game' : 'title'));
  const session = useRef<Session | null>(null);
  const [live, setLive] = useState<Session | null>(null);

  useEffect(() => {
    let w: Worker | undefined;
    const iron: IronDebug = { sim: { tick: 0 } };
    window.__iron = iron;
    try {
      const q = new URLSearchParams(window.location.search);
      const seed = q.has('seed') ? Number(q.get('seed')) : 1;
      const haltAt = q.has('haltAt') ? Number(q.get('haltAt')) : undefined;
      const debug = q.get('debug') === '1' || q.get('showcase') === '1';
      const mirror = new RenderMirror();
      w = new Worker(new URL(`./sim-worker.js?v=${BUILD_HASH}`, document.baseURI));
      const client = createSimClient(w, {
        seed,
        debug,
        haltAt,
        hashEvery: HASH_EVERY,
        buildHash: BUILD_HASH,
        onState: (s) => setWorker(s),
        onPatch: (m) => { mirror.apply(m); },
        onStats: (s) => {
          mirror.apply(s);
          iron.sim.tick = s.tick;
          if (s.hash !== undefined) { iron.sim.hash = s.hash; iron.sim.hashTick = s.tick; }
          setTick(s.tick);
        },
      });
      if (haltAt !== undefined) client.setSpeed('max');
      session.current = { client, mirror };
      setLive(session.current);
    } catch (e) {
      console.error('[sim] failed to start worker', e);
      setWorker('failed');
    }
    return () => w?.terminate();
  }, []);

  if (view === 'game' && live) {
    return <GameView client={live.client} mirror={live.mirror} tick={tick} worker={worker} onExit={() => setView('title')} />;
  }

  return (
    <main className="title">
      <h1>Iron Dominion</h1>
      <p>Robots build your city.</p>
      <button className="primary" type="button" disabled={worker === 'failed'} onClick={() => setView('game')}>New city</button>
      <p className="status" data-worker={worker} data-tick={tick}>Engine: {worker}{worker === 'ready' ? ` (tick ${tick})` : ''}</p>
    </main>
  );
}
