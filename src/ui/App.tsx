import { useEffect, useState } from 'react';
import './app.css';

export function App() {
  const [worker, setWorker] = useState<'loading' | 'ready' | 'failed'>('loading');

  useEffect(() => {
    let w: Worker | undefined;
    try {
      w = new Worker(new URL('./sim-worker.js', document.baseURI));
      w.onmessage = (e) => { if (e.data?.type === 'ready') setWorker('ready'); };
      w.onerror = () => setWorker('failed');
      w.postMessage({ type: 'hello' });
    } catch {
      setWorker('failed');
    }
    return () => w?.terminate();
  }, []);

  return (
    <main className="title">
      <h1>Iron Dominion</h1>
      <p>Robots build your city.</p>
      <p className="status" data-worker={worker}>Engine: {worker}</p>
    </main>
  );
}
