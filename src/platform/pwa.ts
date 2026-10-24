// Service worker registration, the "update available" state machine and the install prompt. The worker itself is
// public/sw.js, rendered per build by build.mjs. Nothing here reloads a running game without saving first.

/**
 * `stale` is a tab whose page code is older than the worker now controlling it (another tab applied the update). It cannot be
 * dismissed: its next sim-worker request would otherwise pair old app code with a new worker. The `stale` flag on the
 * saving, reloading and error states remembers that, because no controllerchange will fire to reload this tab.
 */
export type UpdateState =
  | { kind: 'idle'; dismissed: boolean }
  | { kind: 'available' }
  | { kind: 'stale' }
  | { kind: 'saving'; stale?: true }
  | { kind: 'reloading'; stale?: true }
  | { kind: 'error'; message: string; stale?: true };

export type UpdateEvent =
  | { type: 'waiting' }
  | { type: 'controllerChanged' }
  | { type: 'dismiss' }
  | { type: 'reload' }
  | { type: 'saved' }
  | { type: 'saveFailed'; message: string };

export const INITIAL_UPDATE: UpdateState = { kind: 'idle', dismissed: false };

const staleOf = (s: { stale?: true }): { stale?: true } => (s.stale ? { stale: true } : {});

export function reduceUpdate(s: UpdateState, e: UpdateEvent): UpdateState {
  switch (e.type) {
    case 'waiting':
      return s.kind === 'idle' && !s.dismissed ? { kind: 'available' } : s;
    case 'controllerChanged':
      return s.kind === 'reloading' ? s : { kind: 'stale' };
    case 'dismiss':
      return s.kind === 'available' || (s.kind === 'error' && !s.stale) ? { kind: 'idle', dismissed: true } : s;
    case 'reload':
      if (s.kind === 'stale') return { kind: 'saving', stale: true };
      return s.kind === 'available' ? { kind: 'saving' } : s.kind === 'error' ? { kind: 'saving', ...staleOf(s) } : s;
    case 'saved':
      return s.kind === 'saving' ? { kind: 'reloading', ...staleOf(s) } : s;
    case 'saveFailed':
      return s.kind === 'saving' ? { kind: 'error', message: e.message, ...staleOf(s) } : s;
  }
}

export interface UpdateStore {
  get(): UpdateState;
  dispatch(e: UpdateEvent): void;
  subscribe(fn: () => void): () => void;
}

export function createUpdateStore(): UpdateStore {
  let state = INITIAL_UPDATE;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    dispatch(e) {
      const next = reduceUpdate(state, e);
      if (next === state) return;
      state = next;
      for (const fn of subs) fn();
    },
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
  };
}

export const updateStore = createUpdateStore();

let waitingWorker: ServiceWorker | null = null;

/**
 * Saves (when a city is open), then asks the waiting worker to take over; the page reloads once the new worker controls it.
 * `beforeReload` resolves to an error message when the save failed, which keeps the old page running.
 */
export async function applyUpdate(
  beforeReload: () => Promise<string | null>, store: UpdateStore = updateStore, reload: () => void = () => window.location.reload(),
): Promise<void> {
  store.dispatch({ type: 'reload' });
  if (store.get().kind !== 'saving') return;
  let failure: string | null;
  try { failure = await beforeReload(); } catch (e) { failure = e instanceof Error ? e.message : String(e); }
  if (failure !== null) { store.dispatch({ type: 'saveFailed', message: failure }); return; }
  store.dispatch({ type: 'saved' });
  const after = store.get();
  if (after.kind === 'reloading' && after.stale) { reload(); return; }
  waitingWorker?.postMessage({ type: 'SKIP_WAITING' });
}

/** Saves the open city through the existing platform path. A title-screen session has nothing to lose, so it is skipped. */
export async function saveOpenCity(): Promise<string | null> {
  if (!defaultEnv.cityOpen()) return null;
  const save = window.__iron?.platform?.save;
  if (!save) return null;
  const r = await save();
  return r.ok ? null : `Save failed: ${r.reason}`;
}

export interface PwaEnv {
  cityOpen(): boolean;
  reload(): void;
}

const defaultEnv: PwaEnv = { cityOpen: () => document.querySelector('.topbar') !== null, reload: () => window.location.reload() };

export function registerServiceWorker(nav: Pick<Navigator, 'serviceWorker'> = navigator, store: UpdateStore = updateStore, env: PwaEnv = defaultEnv): void {
  if (!('serviceWorker' in nav) || !nav.serviceWorker) return;
  const sw = nav.serviceWorker;
  // A first install claims the page without any old code to mismatch; only a page that already had a controller can go stale.
  const hadController = sw.controller !== null;
  const announce = (reg: ServiceWorkerRegistration): void => {
    // A first install has no controller; only an existing one makes a waiting worker an update.
    if (reg.waiting && sw.controller) { waitingWorker = reg.waiting; store.dispatch({ type: 'waiting' }); }
  };
  const start = (): void => {
    sw.register('./sw.js', { scope: './' }).then((reg) => {
      announce(reg);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => { if (w.state === 'installed') announce(reg); });
      });
    }).catch((e) => console.warn('[pwa] service worker registration failed', e));
  };
  let reloaded = false;
  sw.addEventListener('controllerchange', () => {
    if (reloaded) return;
    if (store.get().kind === 'reloading') { reloaded = true; env.reload(); return; }
    if (!hadController) return;
    // Another tab applied the update. With no city open there is nothing to lose; otherwise the player saves first.
    if (!env.cityOpen()) { reloaded = true; env.reload(); return; }
    store.dispatch({ type: 'controllerChanged' });
  });
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}

export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function isIosSafari(ua: string, maxTouchPoints = 0): boolean {
  const ios = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1);
  return ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
}

export function isStandalone(win: Window = window): boolean {
  return win.matchMedia?.('(display-mode: standalone)').matches === true
    || win.matchMedia?.('(display-mode: fullscreen)').matches === true
    || (win.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export type InstallState = { mode: 'none' } | { mode: 'prompt' } | { mode: 'ios-hint' };

export function installState(deferred: boolean, ios: boolean, standalone: boolean): InstallState {
  if (standalone) return { mode: 'none' };
  if (deferred) return { mode: 'prompt' };
  return ios ? { mode: 'ios-hint' } : { mode: 'none' };
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const installSubs = new Set<() => void>();
const notifyInstall = (): void => { for (const fn of installSubs) fn(); };

export function listenForInstall(win: Window = window): void {
  win.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e as BeforeInstallPromptEvent; notifyInstall(); });
  win.addEventListener('appinstalled', () => { deferredPrompt = null; notifyInstall(); });
}

export function currentInstallState(): InstallState {
  return installState(deferredPrompt !== null, isIosSafari(navigator.userAgent, navigator.maxTouchPoints), isStandalone());
}

export function subscribeInstall(fn: () => void): () => void {
  installSubs.add(fn);
  return () => { installSubs.delete(fn); };
}

export async function promptInstall(): Promise<void> {
  const p = deferredPrompt;
  if (!p) return;
  deferredPrompt = null;
  notifyInstall();
  await p.prompt();
  await p.userChoice;
}

/** Called once from main.tsx. */
export function startPwa(): void {
  listenForInstall();
  registerServiceWorker();
}
