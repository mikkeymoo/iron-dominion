import { useCallback, useEffect, useRef, useState } from 'react';
import type { IronDebug } from '../render/debug.ts';
import '../platform/debug.ts';
import './toolsStore.ts';
import './roadsDebug.ts';
import { StatsRing } from './economyDebug.ts';
import type { ClientState } from '../sim/client.ts';
import { DEFAULT_TAX } from '../sim/economy/tables.ts';
import { emptyServiceStats } from '../sim/services/coverage.ts';
import { openPlatformDb, type PlatformDb, type SlotMeta } from '../platform/db.ts';
import { DEFAULT_SETTINGS, disasterModeOf, haltDisasterMode, loadSettings, saveSetting, type Settings } from '../platform/settings.ts';
import { readFileBytes } from '../platform/save.ts';
import { loadScores, recordScore, type ScoreRecord, type ScoreUpdate } from '../platform/scores.ts';
import { keyLabel, kindOfId, nextScenario, scenarioById, specFor, type ScenarioChoice } from '../sim/scenarios.ts';
import { scoreId } from './scenarioText.ts';
import { GameView } from './GameView';
import { NO_WORKFORCE, failText, type HudStats } from './Hud';
import { openSession, saveSession, type Session } from './session.ts';
import { Title } from './Title';
import './app.css';

// ?autostart=1 skips the title screen with an unsaved city; add &slot=<id> to load that slot instead.
// ?seed=42&haltAt=200 is the determinism debug path (see session.ts).
const ZERO: HudStats = {
  tick: 0, day: 0, dayFrac: 0, treasury: 0, population: 0, rciDemand: [0, 0, 0], taxRates: [DEFAULT_TAX, DEFAULT_TAX, DEFAULT_TAX], month: 0, lastNet: 0, loans: [], debtMonths: 0, workforce: NO_WORKFORCE,
  power: { supply: 0, demand: 0 }, water: { supply: 0, demand: 0 }, unpowered: 0, unwatered: 0, modelled: { power: false, water: false },
  services: emptyServiceStats(),
};
const SAMPLE_CAP = 2000;
const isDebug = (): boolean => query().get('debug') === '1' || query().get('showcase') === '1';

const query = (): URLSearchParams => new URLSearchParams(window.location.search);

export function App() {
  const [worker, setWorker] = useState<ClientState>('loading');
  const [hud, setHud] = useState<HudStats>(ZERO);
  const [view, setView] = useState<'title' | 'game'>(() => (query().get('autostart') === '1' ? 'game' : 'title'));
  const [live, setLive] = useState<Session | null>(null);
  const [platformReady, setPlatformReady] = useState(false);
  const [slots, setSlots] = useState<SlotMeta[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [titleMessage, setTitleMessage] = useState('');
  const [notice, setNotice] = useState('');
  const [quitPrompt, setQuitPrompt] = useState<string | null>(null);
  const [scores, setScores] = useState<Record<string, ScoreRecord>>({});
  const [result, setResult] = useState<ScoreUpdate | null>(null);
  // Bumps with every session so the game view (and its results screen) starts fresh on a retry.
  const [sessionN, setSessionN] = useState(0);
  const scoresRef = useRef(scores);
  scoresRef.current = scores;
  // The session whose scenario was seen playing: only a scenario that ends in front of the player is scored.
  const watched = useRef<{ session: Session | null; playing: boolean; recorded: boolean }>({ session: null, playing: false, recorded: false });
  const db = useRef<PlatformDb | undefined>(undefined);
  const current = useRef<Session | null>(null);
  const iron = useRef<IronDebug | null>(null);
  const graphEpoch = useRef(0);
  const samplesRef = useRef<StatsRing | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // The Disasters setting reaches the sim as a command, so it is part of the deterministic state and a save keeps it.
  useEffect(() => {
    if (live && worker === 'ready' && !query().has('haltAt')) live.client.command({ type: 'setDisasters', mode: disasterModeOf(settings.disasters) });
  }, [live, worker, settings.disasters]);

  const refreshSlots = useCallback(async (): Promise<void> => {
    const r = await db.current?.listSlots();
    if (r?.ok) setSlots(r.value);
  }, []);

  const attach = useCallback((s: Session): void => {
    current.current?.dispose();
    current.current = s;
    watched.current = { session: s, playing: false, recorded: false };
    setResult(null);
    setSessionN((n) => n + 1);
    setLive(s);
    const dbg = iron.current;
    if (dbg) {
      dbg.sim = { tick: 0 };
      dbg.tools = s.tools.debug;
      graphEpoch.current = 0;
      delete dbg.economy;
      samplesRef.current = null;
      if (isDebug()) {
        const ring = new StatsRing(SAMPLE_CAP);
        samplesRef.current = ring;
        dbg.economy = {
          command: (body) => s.client.command(body),
          requestBudget: () => s.client.requestBudget(),
          get stats() { return ring.last; },
          get samples() { return ring.toArray(); },
        };
      }
      dbg.roads = {
        get graphEpoch() { return graphEpoch.current; },
        requestPath: (from, to) => s.client.requestPath(from, to),
      };
      dbg.platform = {
        save: () => saveSession(s),
        load: (id) => loadInto(s, id),
        slots: () => s.service.slots(),
        get lastSaveHash() { return s.service.lastSaveHash; },
        get lastSaveTick() { return s.service.lastSaveTick; },
      };
    }
  }, []);

  const open = useCallback((seed: number, haltAt?: number, scenario?: ScenarioChoice): Session => {
    setWorker('loading');
    setHud(ZERO);
    const s = openSession({
      seed, haltAt, scenario, getDb: () => db.current,
      disasters: haltAt !== undefined ? haltDisasterMode(query().get('disasters')) : disasterModeOf(settingsRef.current.disasters),
      debug: query().get('debug') === '1' || query().get('showcase') === '1',
      onState: (st) => { if (current.current === s || current.current === null) setWorker(st); },
      onStats: (st) => {
        if (current.current !== s) return;
        graphEpoch.current = st.graphEpoch;
        const dbg = iron.current;
        if (dbg) {
          dbg.sim.tick = st.tick;
          dbg.sim.workforce = st.workforce;
          dbg.sim.traffic = st.traffic;
          dbg.sim.population = st.population;
          dbg.sim.jobs = st.jobsC + st.jobsI;
          dbg.sim.firmware = st.firmware;
          if (st.hash !== undefined) { dbg.sim.hash = st.hash; dbg.sim.hashTick = st.tick; }
        }
        samplesRef.current?.push(st);
        setHud({
          tick: st.tick, day: st.day, dayFrac: st.dayFrac, treasury: st.treasury, population: st.population,
          rciDemand: st.rciDemand, taxRates: st.taxRates, month: st.month, lastNet: st.lastMonth.net, loans: st.loans, debtMonths: st.debtMonths, workforce: st.workforce, traffic: st.traffic,
          power: st.power, water: st.water, unpowered: st.unpowered, unwatered: st.unwatered, modelled: st.modelled, services: st.services, milestone: st.milestone, directives: st.directives, firmware: st.firmware, scenario: st.scenario,
        });
      },
    });
    return s;
  }, []);

  async function loadInto(s: Session, id: string): Promise<Awaited<ReturnType<Session['service']['load']>>> {
    const r = await s.service.load(id);
    if (r.ok) {
      s.tools.reset();
      s.lifecycle.cacheSnapshot(r.value.snapshot);
      s.lifecycle.holdForResume();
      // The save carries the mode it was made with; the player's setting wins.
      s.client.command({ type: 'setDisasters', mode: disasterModeOf(settingsRef.current.disasters) });
    }
    return r;
  }

  useEffect(() => {
    let cancelled = false;
    const dbg: IronDebug = { sim: { tick: 0 } };
    window.__iron = dbg;
    iron.current = dbg;
    const q = query();
    let first: Session | undefined;
    try {
      first = open(q.has('seed') ? Number(q.get('seed')) : 1, q.has('haltAt') ? Number(q.get('haltAt')) : undefined);
      attach(first);
    } catch (e) {
      console.error('[sim] failed to start worker', e);
      setWorker('failed');
    }
    void (async () => {
      const opened = await openPlatformDb();
      if (cancelled) { if (opened.ok) opened.value.close(); return; }
      db.current = opened.ok ? opened.value : undefined;
      const loaded = await loadSettings(db.current, typeof localStorage === 'undefined' ? undefined : localStorage);
      if (cancelled) return;
      setSettings(loaded);
      setScores(await loadScores(db.current));
      if (cancelled) return;
      await refreshSlots();
      const slotId = q.get('slot');
      if (first && q.get('autostart') === '1' && slotId) {
        const r = await loadInto(first, slotId);
        if (!r.ok) setNotice(`Could not load that save: ${failText(r.reason, r.message)}`);
      }
      if (!cancelled) setPlatformReady(true);
    })();
    return () => { cancelled = true; current.current?.dispose(); current.current = null; db.current?.close(); };
  }, [open, attach, refreshSlots]);

  const enterGame = useCallback(async (start: (s: Session) => Promise<boolean>, seed: number, scenario?: ScenarioChoice): Promise<void> => {
    setTitleMessage('');
    setNotice('');
    let s: Session;
    try { s = open(seed, undefined, scenario); } catch (e) { console.error('[sim] failed to start worker', e); setWorker('failed'); return; }
    attach(s);
    if (await start(s)) setView('game');
    else {
      const idle = open(query().has('seed') ? Number(query().get('seed')) : 1);
      attach(idle);
    }
  }, [open, attach]);

  const onNew = useCallback((name: string, seed: number | undefined): void => {
    const chosen = seed ?? Math.floor(Math.random() * 0xffffffff);
    void enterGame(async (s) => { s.service.startNew(name); return true; }, chosen);
  }, [enterGame]);

  const onScenario = useCallback((choice: ScenarioChoice): void => {
    const spec = specFor(choice.id, choice.key);
    if (!spec) return;
    const kind = kindOfId(choice.id);
    const name = kind ? `${kind === 'daily' ? 'Daily' : 'Weekly'} ${keyLabel(kind, choice.key ?? 0)}` : scenarioById(choice.id)?.name ?? 'Scenario';
    void enterGame(async (s) => { s.service.startNew(name); return true; }, spec.seed, choice);
  }, [enterGame]);

  const onLoad = useCallback((id: string): void => {
    void enterGame(async (s) => {
      const r = await loadInto(s, id);
      if (!r.ok) setTitleMessage(`Could not load that save: ${failText(r.reason, r.message)}`);
      return r.ok;
    }, 1);
  }, [enterGame]);

  const onDelete = useCallback((id: string): void => {
    void (async () => {
      const r = await db.current?.deleteSlot(id);
      if (r && !r.ok) setTitleMessage(`Could not delete: ${failText(r.reason, r.message)}`);
      await refreshSlots();
    })();
  }, [refreshSlots]);

  const onImport = useCallback((file: File): void => {
    void (async () => {
      const s = current.current;
      if (!s) return;
      const r = await s.service.importBytes(await readFileBytes(file));
      setTitleMessage(r.ok ? `Imported "${r.value.name}".` : `Import failed: ${failText(r.reason, r.message)}`);
      await refreshSlots();
    })();
  }, [refreshSlots]);

  const flashNotice = (text: string): void => {
    setNotice(text);
    window.setTimeout(() => setNotice((n) => (n === text ? '' : n)), 4000);
  };

  const onSave = useCallback((): void => {
    const s = current.current;
    if (!s) return;
    void saveSession(s).then((r) => flashNotice(r.ok ? 'Saved' : failText(r.reason, r.message)));
  }, []);

  const onSaveAs = useCallback((name: string): void => {
    const s = current.current;
    if (!s) return;
    void saveSession(s, name).then((r) => flashNotice(r.ok ? `Saved as "${r.value.slot.name}"` : failText(r.reason, r.message)));
  }, []);

  const onExport = useCallback((): void => {
    const s = current.current;
    if (!s) return;
    void s.service.exportCurrent().then((r) => { if (!r.ok) flashNotice(failText(r.reason, r.message)); });
  }, []);

  const onSetting = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]): void => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    void saveSetting(db.current, typeof localStorage === 'undefined' ? undefined : localStorage, key, value);
  }, []);

  const leave = useCallback(async (): Promise<void> => {
    setQuitPrompt(null);
    await refreshSlots();
    const q = query();
    attach(open(q.has('seed') ? Number(q.get('seed')) : 1));
    setView('title');
  }, [open, attach, refreshSlots]);

  // Leaving never discards silently: a failed or impossible save opens the quit dialog instead.
  const onQuit = useCallback((): void => {
    void (async () => {
      const s = current.current;
      if (!s) { await leave(); return; }
      if (!s.service.current) { setQuitPrompt('This city has not been saved.'); return; }
      const out = await s.lifecycle.saveNow('manual');
      if (out.ok) await leave();
      else setQuitPrompt(`Saving failed: ${failText(out.reason, out.message)}`);
    })();
  }, [leave]);

  const onQuitSaveAs = useCallback((name: string): void => {
    void (async () => {
      const s = current.current;
      if (!s) return;
      const r = await saveSession(s, name);
      if (r.ok) await leave();
      else setQuitPrompt(`Saving failed: ${failText(r.reason, r.message)}`);
    })();
  }, [leave]);

  useEffect(() => {
    const sc = hud.scenario, w = watched.current;
    if (!sc || !live || w.session !== live) return;
    if (sc.state === 0) { w.playing = true; return; }
    if (!w.playing || w.recorded) return;
    w.recorded = true;
    const id = scoreId(sc);
    void recordScore(db.current, id, { stars: sc.stars, score: sc.score }, Date.now(), scoresRef.current[id]).then((u) => {
      if (watched.current.session !== live) return;
      setScores((p) => ({ ...p, [id]: u.record }));
      setResult(u);
    });
  }, [hud.scenario, live]);

  const onRetry = useCallback((): void => {
    const sc = hud.scenario;
    if (sc) onScenario({ id: sc.id, key: sc.key || undefined });
  }, [hud.scenario, onScenario]);

  const onNextScenario = useCallback((): void => {
    const sc = hud.scenario;
    const next = sc ? nextScenario(sc.id) : undefined;
    if (next) onScenario({ id: next.id });
  }, [hud.scenario, onScenario]);

  if (view === 'game' && live && platformReady) {
    const next = hud.scenario && !kindOfId(hud.scenario.id) ? nextScenario(hud.scenario.id) : undefined;
    return (
      <GameView
        key={sessionN}
        scenario={{ result, nextName: next?.name, onRetry, onNext: onNextScenario, onBack: () => { void leave(); } }}
        client={live.client} mirror={live.mirror} agents={live.agents} tools={live.tools} why={live.why} view={live.view} lifecycle={live.lifecycle} stats={hud} settings={settings} notice={notice}
        tick={hud.tick} worker={worker} onExit={onQuit}
        quitPrompt={quitPrompt} onQuitSaveAs={onQuitSaveAs} onQuitDiscard={() => { void leave(); }} onQuitCancel={() => setQuitPrompt(null)} onSave={onSave} onSaveAs={onSaveAs} onExport={onExport} onSetting={onSetting}
      />
    );
  }

  return (
    <Title
      worker={worker} tick={hud.tick} slots={slots} storageOk={platformReady ? db.current !== undefined : true} message={titleMessage}
      onNew={onNew} onLoad={onLoad} onDelete={onDelete} onImport={onImport} scores={scores} onScenario={onScenario}
    />
  );
}
