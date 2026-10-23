import { useEffect, useState } from 'react';
import { createSimClient } from '../sim/client.ts';
import './app.css';

declare global {
  interface Window {
    __iron?: { sim: { tick: number; hash?: number; hashTick?: number } };
  }
}

// Debug query: ?seed=42&haltAt=200 runs the sim from that seed and halts at tick 200, reporting the state hash.
// A halting run uses max speed. Without haltAt the worker still includes the hash in Stats every HASH_EVERY ticks;
// window.__iron.sim.hashTick says which tick that hash belongs to.
const HASH_EVERY = 100;

export function App() {
  const [worker, setWorker] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let w: Worker | undefined;
    const iron: NonNullable<Window['__iron']> = { sim: { tick: 0 } };
    window.__iron = iron;
    try {
      const q = new URLSearchParams(window.location.search);
      const seed = q.has('seed') ? Number(q.get('seed')) : 1;
      const haltAt = q.has('haltAt') ? Number(q.get('haltAt')) : undefined;
      w = new Worker(new URL('./sim-worker.js', document.baseURI));
      const client = createSimClient(w, {
        seed,
        haltAt,
        hashEvery: HASH_EVERY,
        onState: (s) => setWorker(s),
        onStats: (s) => {
          iron.sim.tick = s.tick;
          if (s.hash !== undefined) { iron.sim.hash = s.hash; iron.sim.hashTick = s.tick; }
          setTick(s.tick);
        },
      });
      if (haltAt !== undefined) client.setSpeed('max');
    } catch (e) {
      console.error('[sim] failed to start worker', e);
      setWorker('failed');
    }
    return () => w?.terminate();
  }, []);

  return (
    <main className="title">
      <h1>Iron Dominion</h1>
      <p>Robots build your city.</p>
      <p className="status" data-worker={worker} data-tick={tick}>Engine: {worker}{worker === 'ready' ? ` (tick ${tick})` : ''}</p>
    </main>
  );
}
