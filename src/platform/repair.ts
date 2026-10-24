// Engine-start failures that a stale service worker, cache or half-deployed build can cause, and the way out of them:
// unregister this scope's workers, delete this scope's caches, reload past the HTTP cache.

export type FailureKind = 'updated' | 'worker' | 'other';

export interface Failure {
  kind: FailureKind;
  /** One readable sentence for the player. */
  reason: string;
  /** The raw message, for the expandable line. */
  detail: string;
  /** A build mismatch or worker load error that repairing the cache can fix. */
  repairable: boolean;
}

const CACHE_PREFIX = 'iron-dominion';
const GUARD_KEY = 'iron-dominion:auto-repair';

export function describeFailure(detail: string | undefined): Failure {
  const raw = detail?.trim() || 'no detail was reported';
  if (/build mismatch|protocol mismatch/i.test(raw)) return { kind: 'updated', reason: 'The game was updated while loading.', detail: raw, repairable: true };
  if (/worker error|could not be deserialised|failed to start worker|couldn't start the simulation worker/i.test(raw)) {
    return { kind: 'worker', reason: "Couldn't start the simulation worker.", detail: raw, repairable: true };
  }
  return { kind: 'other', reason: 'The simulation stopped unexpectedly.', detail: raw, repairable: false };
}

/** The scope this page's service worker is registered under: the folder holding the page, which is where sw.js is served from. */
export function scopeOf(baseURI: string): { url: string; path: string } {
  const u = new URL('./', baseURI);
  return { url: u.href, path: u.pathname };
}

export interface RepairEnv {
  baseURI: string;
  serviceWorker?: { getRegistrations(): Promise<ReadonlyArray<{ scope: string; unregister(): Promise<boolean> }>> };
  caches?: { keys(): Promise<string[]>; delete(name: string): Promise<boolean> };
  session?: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
  href: string;
  now(): number;
  navigate(url: string): void;
}

export function browserEnv(): RepairEnv {
  let session: RepairEnv['session'];
  try { session = window.sessionStorage; } catch { session = undefined; }
  return {
    baseURI: document.baseURI,
    serviceWorker: 'serviceWorker' in navigator ? navigator.serviceWorker : undefined,
    caches: typeof caches === 'undefined' ? undefined : caches,
    session,
    href: window.location.href,
    now: () => Date.now(),
    navigate: (url) => window.location.replace(url),
  };
}

/** The current page URL with a fresh `repair` query, so the HTML is fetched past the HTTP cache. */
export function bustedUrl(href: string, now: number): string {
  const u = new URL(href);
  u.searchParams.set('repair', String(now));
  return u.href;
}

/** Removes only this scope's registrations and caches: the root game and /next/ never touch each other's. */
export async function repairAndReload(env: RepairEnv = browserEnv()): Promise<void> {
  const scope = scopeOf(env.baseURI);
  try {
    for (const reg of (await env.serviceWorker?.getRegistrations()) ?? []) if (reg.scope === scope.url) await reg.unregister();
  } catch (e) { console.warn('[repair] could not unregister the service worker', e); }
  try {
    const prefix = `${CACHE_PREFIX}:${scope.path}:`;
    for (const key of (await env.caches?.keys()) ?? []) if (key.startsWith(prefix)) await env.caches!.delete(key);
  } catch (e) { console.warn('[repair] could not delete the caches', e); }
  env.navigate(bustedUrl(env.href, env.now()));
}

/** Repairs once per tab session for a repairable failure. Returns true when it started (the page is about to reload). */
export function autoRepairOnce(failure: Failure, env: RepairEnv = browserEnv()): boolean {
  if (!failure.repairable || !env.session) return false;
  try {
    if (env.session.getItem(GUARD_KEY)) return false;
    env.session.setItem(GUARD_KEY, String(env.now()));
  } catch { return false; }
  void repairAndReload(env);
  return true;
}

/** The engine started: a later failure may repair again. */
export function clearRepairGuard(env: Pick<RepairEnv, 'session'> = browserEnv()): void {
  try { env.session?.removeItem(GUARD_KEY); } catch { /* storage unavailable */ }
}
