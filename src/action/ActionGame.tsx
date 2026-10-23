import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  createAction, stepAction, objective, padsOwned, rivalHqStatus, playerMods,
  BOUNDS, MAX_LIVES, MAX_MISSILES, TEAM_NAMES, type ActionInput, type ActionState, type Tone,
} from './sim';
import { ArenaRenderer, TEAM_HEX } from './renderer';
import { ArenaAudio } from './audio';
import './arena.css';

type Phase = 'briefing' | 'playing' | 'paused' | 'over';
type Quality = 'high' | 'low';
interface Stick { id: number; ox: number; oy: number; x: number; y: number }
interface Callout { id: number; text: string; tone: Tone; until: number }

const BEST_KEY = 'iron-dominion-action-best';
const PREFS_KEY = 'iron-dominion-action-prefs';
const STICK_R = 56;

function readStore<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? { ...fallback, ...JSON.parse(v) } : fallback; } catch { return fallback; }
}
function writeStore(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked: keep playing */ }
}
const isTouch = () => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
const hex = (n: number) => '#' + n.toString(16).padStart(6, '0');

function snapshot(s: ActionState) {
  const m = s.mech;
  return {
    hp: m.hp, maxHp: m.maxHp, shield: m.shield, lives: m.lives, alive: m.alive, respawn: m.respawn,
    missiles: m.missiles, charge: m.missileCharge, dashReady: m.dashCd <= 0, overdrive: m.overdrive,
    score: s.score, kills: s.kills, combo: s.combo, bestCombo: s.bestCombo, time: s.time, status: s.status,
    owned: padsOwned(s, 'player'), hqs: rivalHqStatus(s), mods: playerMods(s),
    core: { hp: s.core.hp, maxHp: s.core.maxHp, awake: s.core.awake, alive: s.core.alive },
    objective: objective(s),
  };
}
type Hud = ReturnType<typeof snapshot>;

export function ActionGame({ onExit }: { onExit: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const minimap = useRef<HTMLCanvasElement>(null);
  const vignette = useRef<HTMLDivElement>(null);
  const state = useRef<ActionState>(createAction(Date.now() | 0));
  const arena = useRef<ArenaRenderer | null>(null);
  const audio = useRef(new ArenaAudio());
  const phaseRef = useRef<Phase>('briefing');
  const keys = useRef(new Set<string>());
  const mouse = useRef<{ x: number; y: number; down: boolean; active: boolean }>({ x: 0, y: 0, down: false, active: false });
  const edges = useRef({ dash: false, missile: false });
  const moveStick = useRef<Stick | null>(null);
  const aimStick = useRef<Stick | null>(null);
  const slowmo = useRef(0);
  const [phase, setPhaseState] = useState<Phase>('briefing');
  const [hud, setHud] = useState<Hud>(() => snapshot(state.current));
  const [callouts, setCallouts] = useState<Callout[]>([]);
  const [sticks, setSticks] = useState<{ move: Stick | null; aim: Stick | null }>({ move: null, aim: null });
  const [prefs, setPrefs] = useState(() => readStore(PREFS_KEY, { muted: false, quality: (isTouch() ? 'low' : 'high') as Quality }));
  const [best, setBest] = useState(() => readStore(BEST_KEY, { score: 0 }).score);
  const [error, setError] = useState('');
  const [round, setRound] = useState(0);
  const touch = useRef(isTouch());

  const setPhase = (p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
    if (p === 'playing') audio.current.resume(); else audio.current.suspend();
  };

  useEffect(() => { audio.current.setMuted(prefs.muted); writeStore(PREFS_KEY, prefs); }, [prefs]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    try {
      arena.current = new ArenaRenderer(el, state.current, prefs.quality);
      setError('');
    } catch {
      setError('3D graphics could not start. Your browser or device may have WebGL turned off.');
      return;
    }
    const onResize = () => arena.current?.resize();
    window.addEventListener('resize', onResize);
    let raf = 0, last = performance.now(), hudAt = 0, overAt = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const r = arena.current;
      if (!r) return;
      let dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      const s = state.current;
      const live = phaseRef.current === 'playing';
      if (!live) dt = phaseRef.current === 'over' ? dt : 0;
      if (slowmo.current > 0) { slowmo.current -= dt; dt *= 0.3; }
      if (live) stepAction(s, readInput(), dt);
      edges.current.dash = edges.current.missile = false;
      for (const f of s.fx) {
        if (f.type === 'slowmo') slowmo.current = f.seconds;
        else if (f.type === 'hurt' && vignette.current) {
          vignette.current.style.transition = 'none';
          vignette.current.style.opacity = '1';
          requestAnimationFrame(() => { if (vignette.current) { vignette.current.style.transition = 'opacity .45s'; vignette.current.style.opacity = '0'; } });
        }
      }
      const calls = s.fx.filter(f => f.type === 'announce');
      if (calls.length) {
        setCallouts(c => [...c, ...calls.map((f, i) => ({ id: now + i, text: f.type === 'announce' ? f.text : '', tone: f.type === 'announce' ? f.tone : 'info' as Tone, until: now + 2600 }))].slice(-3));
      }
      audio.current.play(s.fx, s.mech.x, s.mech.z);
      r.render(s, dt);
      s.fx.length = 0;
      if (now - hudAt > 100) {
        hudAt = now;
        setHud(snapshot(s));
        setCallouts(c => c.some(x => x.until < now) ? c.filter(x => x.until >= now) : c);
        drawMinimap(minimap.current, s);
      }
      if (s.status !== 'playing' && phaseRef.current === 'playing') { phaseRef.current = 'over'; overAt = now; }
      if (phaseRef.current === 'over' && overAt && now - overAt > 2200) {
        overAt = 0;
        setPhase('over');
        setBest(b => { const nb = Math.max(b, s.score); writeStore(BEST_KEY, { score: nb }); return nb; });
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      arena.current?.dispose();
      arena.current = null;
    };
    // The renderer rebuilds when graphics quality changes or a new round starts.
  }, [prefs.quality, round]);

  useEffect(() => {
    const hide = () => { if (phaseRef.current === 'playing') setPhase('paused'); keys.current.clear(); mouse.current.down = false; };
    const vis = () => { if (document.hidden) hide(); };
    const down = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === 'escape' || k === 'p') {
        if (phaseRef.current === 'playing') setPhase('paused');
        else if (phaseRef.current === 'paused') setPhase('playing');
        return;
      }
      if (phaseRef.current !== 'playing') return;
      if ([' ', 'shift', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault();
      if ((k === ' ' || k === 'shift') && !e.repeat) edges.current.dash = true;
      if ((k === 'e' || k === 'q') && !e.repeat) edges.current.missile = true;
      keys.current.add(k);
    };
    const up = (e: KeyboardEvent) => keys.current.delete(e.key.toLowerCase());
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('blur', hide);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      document.removeEventListener('visibilitychange', vis);
      window.removeEventListener('blur', hide);
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  useEffect(() => () => audio.current.dispose(), []);

  function readInput(): ActionInput {
    const k = keys.current;
    let mx = (k.has('d') || k.has('arrowright') ? 1 : 0) - (k.has('a') || k.has('arrowleft') ? 1 : 0);
    let mz = (k.has('s') || k.has('arrowdown') ? 1 : 0) - (k.has('w') || k.has('arrowup') ? 1 : 0);
    const ms = moveStick.current;
    if (ms) { mx = (ms.x - ms.ox) / STICK_R; mz = (ms.y - ms.oy) / STICK_R; }
    let ax = 0, az = 0, fire = mouse.current.down;
    const as = aimStick.current;
    if (as) {
      const dx = as.x - as.ox, dy = as.y - as.oy;
      if (Math.hypot(dx, dy) > 12) { ax = dx; az = dy; fire = true; }
    } else if (mouse.current.active && arena.current) {
      const p = arena.current.groundPoint(mouse.current.x, mouse.current.y);
      const m = state.current.mech;
      if (p) { ax = p.x - m.x; az = p.z - m.z; }
    }
    return { moveX: mx, moveZ: mz, aimX: ax, aimZ: az, fire, dash: edges.current.dash, missile: edges.current.missile, autoAim: touch.current && !as };
  }

  const start = () => {
    audio.current.unlock();
    setPhase('playing');
  };
  const restart = () => {
    state.current = createAction(Date.now() | 0);
    slowmo.current = 0;
    setCallouts([]);
    setHud(snapshot(state.current));
    setRound(r => r + 1);
    audio.current.unlock();
    setPhase('playing');
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (phaseRef.current !== 'playing') return;
    if (e.pointerType === 'mouse') {
      if (e.button === 2) edges.current.missile = true;
      else mouse.current.down = true;
      return;
    }
    touch.current = true;
    const stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    if (e.clientX < window.innerWidth / 2) { if (!moveStick.current) moveStick.current = stick; }
    else if (!aimStick.current) aimStick.current = stick;
    setSticks({ move: moveStick.current, aim: aimStick.current });
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse') { mouse.current.x = e.clientX; mouse.current.y = e.clientY; mouse.current.active = true; return; }
    for (const ref of [moveStick, aimStick]) {
      const st = ref.current;
      if (!st || st.id !== e.pointerId) continue;
      let dx = e.clientX - st.ox, dy = e.clientY - st.oy;
      const d = Math.hypot(dx, dy);
      if (d > STICK_R) { dx *= STICK_R / d; dy *= STICK_R / d; }
      ref.current = { ...st, x: st.ox + dx, y: st.oy + dy };
    }
    setSticks({ move: moveStick.current, aim: aimStick.current });
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse') { mouse.current.down = false; return; }
    if (moveStick.current?.id === e.pointerId) moveStick.current = null;
    if (aimStick.current?.id === e.pointerId) aimStick.current = null;
    setSticks({ move: moveStick.current, aim: aimStick.current });
  };
  const press = (which: 'dash' | 'missile') => (e: ReactPointerEvent) => { e.stopPropagation(); edges.current[which] = true; };

  const h = hud;
  const mins = Math.floor(h.time / 60), secs = String(Math.floor(h.time % 60)).padStart(2, '0');
  return <main className="arena">
    <div className="arena-host" ref={host} aria-label="3D battlefield" />
    <div className="hurt-vignette" ref={vignette} aria-hidden="true" />
    {error && <div className="arena-card"><span className="eyebrow">SYSTEM FAULT</span><h2>Graphics offline</h2><p>{error}</p><button className="primary wide" onClick={onExit}>Back to title</button></div>}
    {!error && <>
      <div className="arena-input" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onContextMenu={e => e.preventDefault()} />
      {phase !== 'briefing' && <>
        <header className="arena-top">
          <div className="vitals">
            <div className="lives" aria-label={`${h.lives} lives`}>{Array.from({ length: MAX_LIVES }, (_, i) => <i key={i} className={i < h.lives ? 'on' : ''} />)}</div>
            <div className="bar hp" role="meter" aria-label="Hull" aria-valuenow={Math.ceil(h.hp)} aria-valuemin={0} aria-valuemax={h.maxHp}><span style={{ width: `${(h.hp / h.maxHp) * 100}%` }} />{h.shield > 0 && <em style={{ width: `${Math.min(100, (h.shield / h.maxHp) * 100)}%` }} />}<b>{Math.ceil(h.hp)}</b></div>
            <div className="mods">DMG +{Math.round((h.mods.damage - 1) * 100)}% · RECHARGE +{Math.round((h.mods.recharge - 1) * 100)}%{h.overdrive > 0 && <strong> · OVERDRIVE {Math.ceil(h.overdrive)}s</strong>}</div>
          </div>
          <div className="scoreboard">
            <b>{h.score.toLocaleString()}</b>
            <small>{h.kills} KILLS · {mins}:{secs}</small>
            {h.combo > 1 && <span className="combo" key={h.combo}>×{Math.min(10, h.combo)} COMBO</span>}
          </div>
          <button className="icon arena-pause" aria-label="Pause" onClick={() => setPhase('paused')}>Ⅱ</button>
        </header>
        <div className="objective">
          <span>{h.objective}</span>
          <div className="hq-row">
            <small>{h.owned}/18 REGIONS</small>
            {h.hqs.map(q => <i key={q.team} title={`${TEAM_NAMES[q.team]} HQ`} style={{ borderColor: hex(TEAM_HEX[q.team]), background: q.captured ? hex(TEAM_HEX.player) : 'transparent' }} />)}
            <i title="Rogue Core" className="core-pip" style={{ borderColor: hex(TEAM_HEX.rogue), background: h.core.alive ? 'transparent' : hex(TEAM_HEX.player) }} />
          </div>
        </div>
        {h.core.awake && h.core.alive && <div className="boss-bar"><span>ROGUE CORE</span><div><i style={{ width: `${(h.core.hp / h.core.maxHp) * 100}%` }} /></div></div>}
        <canvas className="minimap" ref={minimap} width={108} height={148} aria-label="Minimap" />
        <div className="callouts" aria-live="polite">{callouts.map(c => <div key={c.id} className={`callout ${c.tone}`}>{c.text}</div>)}</div>
        {!h.alive && h.lives > 0 && phase === 'playing' && <div className="respawn">REDEPLOYING IN {Math.max(0, Math.ceil(h.respawn))}</div>}
        <div className="abilities">
          <button className={`ability dash ${h.dashReady ? 'ready' : ''}`} aria-label="Dash" onPointerDown={press('dash')}><b>⇥</b><small>DASH</small></button>
          <button className={`ability missile ${h.missiles ? 'ready' : ''}`} aria-label="Missile salvo" onPointerDown={press('missile')}>
            <b>✸</b><small>MISSILES</small>
            <span className="pips">{Array.from({ length: MAX_MISSILES }, (_, i) => <i key={i} className={i < h.missiles ? 'on' : i === h.missiles ? 'charging' : ''} style={i === h.missiles ? { ['--p' as string]: `${h.charge * 100}%` } : undefined} />)}</span>
          </button>
        </div>
        {sticks.move && <div className="stick" style={{ left: sticks.move.ox, top: sticks.move.oy }}><i style={{ transform: `translate(${sticks.move.x - sticks.move.ox}px,${sticks.move.y - sticks.move.oy}px)` }} /></div>}
        {sticks.aim && <div className="stick aim" style={{ left: sticks.aim.ox, top: sticks.aim.oy }}><i style={{ transform: `translate(${sticks.aim.x - sticks.aim.ox}px,${sticks.aim.y - sticks.aim.oy}px)` }} /></div>}
      </>}
      {phase === 'briefing' && <div className="arena-card briefing">
        <span className="eyebrow">MISSION BRIEFING / PILOT ONLINE</span>
        <h2>Drop into the shattered front.</h2>
        <p>Pilot the Dominion war mech. Stand on regions to capture them, blast rival machines, seize all three enemy HQs and destroy the Rogue Core.</p>
        <ul className="controls">
          <li><b>{touch.current ? 'Left thumb' : 'WASD'}</b>Move</li>
          <li><b>{touch.current ? 'Right thumb' : 'Mouse'}</b>{touch.current ? 'Aim & fire (auto-aims when idle)' : 'Aim, hold click to fire'}</li>
          <li><b>{touch.current ? 'Dash' : 'Space'}</b>Dash through fire</li>
          <li><b>{touch.current ? 'Missiles' : 'E / right-click'}</b>Homing missile salvo</li>
        </ul>
        <p className="fine">Metal regions boost damage. Energy regions speed up missiles. Factories send allied robots. Your HQ repairs you.</p>
        <button className="primary wide" onClick={start} aria-label="Deploy">Deploy <span>→</span></button>
        <button className="wide" onClick={onExit}>Back to title</button>
      </div>}
      {phase === 'paused' && <div className="arena-card">
        <span className="eyebrow">COMBAT PAUSED</span>
        <h2>Holding position.</h2>
        <p>Time is frozen. Resume when you are ready.</p>
        <button className="primary wide" onClick={() => setPhase('playing')} aria-label="Resume">Resume →</button>
        <button className="wide" onClick={() => setPrefs(p => ({ ...p, muted: !p.muted }))}>Sound: {prefs.muted ? 'Off' : 'On'}</button>
        <button className="wide" onClick={() => setPrefs(p => ({ ...p, quality: p.quality === 'high' ? 'low' : 'high' }))}>Graphics: {prefs.quality === 'high' ? 'High (bloom, shadows)' : 'Low (faster)'}</button>
        <button className="wide" onClick={restart}>Restart mission</button>
        <button className="wide" onClick={onExit}>Quit to title</button>
      </div>}
      {phase === 'over' && <div className="arena-card">
        <span className="eyebrow">{h.status === 'victory' ? 'MISSION COMPLETE' : 'MISSION FAILED'}</span>
        <h2>{h.status === 'victory' ? 'Total dominion.' : 'The front has fallen.'}</h2>
        <div className="intel-grid">
          <div><b>{h.score.toLocaleString()}</b><small>SCORE</small></div>
          <div><b>{best.toLocaleString()}</b><small>BEST</small></div>
          <div><b>{h.kills}</b><small>KILLS</small></div>
          <div><b>×{h.bestCombo}</b><small>BEST COMBO</small></div>
        </div>
        <button className="primary wide" onClick={restart}>Play again →</button>
        <button className="wide" onClick={onExit}>Back to title</button>
      </div>}
    </>}
  </main>;
}

function drawMinimap(c: HTMLCanvasElement | null, s: ActionState) {
  const g = c?.getContext('2d');
  if (!c || !g) return;
  const sx = c.width / (BOUNDS.x * 2), sz = c.height / (BOUNDS.z * 2);
  const px = (x: number) => (x + BOUNDS.x) * sx, pz = (z: number) => (z + BOUNDS.z) * sz;
  g.clearRect(0, 0, c.width, c.height);
  g.fillStyle = 'rgba(7,11,16,0.78)';
  g.fillRect(0, 0, c.width, c.height);
  for (const p of s.pads) {
    g.fillStyle = hex(TEAM_HEX[p.owner]);
    g.globalAlpha = 0.85;
    g.beginPath(); g.arc(px(p.x), pz(p.z), p.kind === 'hq' || p.kind === 'core' ? 5 : 3.5, 0, Math.PI * 2); g.fill();
  }
  g.globalAlpha = 1;
  for (const b of s.bots) { g.fillStyle = hex(TEAM_HEX[b.team]); g.fillRect(px(b.x) - 1, pz(b.z) - 1, 2, 2); }
  const m = s.mech;
  if (m.alive) {
    g.save();
    g.translate(px(m.x), pz(m.z));
    g.rotate(-m.aim + Math.PI);
    g.fillStyle = '#ffffff';
    g.beginPath(); g.moveTo(0, -5); g.lineTo(4, 4); g.lineTo(-4, 4); g.closePath(); g.fill();
    g.restore();
  }
}
