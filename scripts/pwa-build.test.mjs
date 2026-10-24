import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { cacheName, cachePrefix, precacheList, renderServiceWorker, validateManifest } from './pwa-build.mjs';
import { renderIconPng } from './png.mjs';

const FILES = ['app.css', 'app.js', 'build.json', 'icon.svg', 'icons/icon-192.png', 'index.html', 'manifest.webmanifest', 'sim-worker.js', 'sw.js', '.nojekyll', 'app.js.map'];

describe('precacheList', () => {
  const list = precacheList(FILES, 'abc123');
  it('includes the app shell, the manifest and icons, sorted', () => {
    expect(list).toEqual(['./', './app.css', './app.js', './icon.svg', './icons/icon-192.png', './index.html', './manifest.webmanifest', './sim-worker.js?v=abc123']);
  });
  it('excludes the worker itself, build.json, dotfiles and source maps', () => {
    for (const f of ['./sw.js', './build.json', './.nojekyll', './app.js.map']) expect(list).not.toContain(f);
  });
  it('stores the sim worker under the versioned URL the app requests', () => {
    expect(list).toContain('./sim-worker.js?v=abc123');
    expect(list).not.toContain('./sim-worker.js');
  });
});

describe('cache naming', () => {
  it('keys by scope and build hash', () => {
    expect(cacheName('/iron-dominion/', 'h1')).toBe('iron-dominion:/iron-dominion/:h1');
    expect(cacheName('/iron-dominion/', 'h1')).not.toBe(cacheName('/iron-dominion/', 'h2'));
    expect(cacheName('/iron-dominion/', 'h1')).not.toBe(cacheName('/iron-dominion/next/', 'h1'));
  });
  it('the root scope prefix does not match the /next/ scope caches', () => {
    expect(cacheName('/iron-dominion/next/', 'h1').startsWith(cachePrefix('/iron-dominion/'))).toBe(false);
  });
});

describe('generated service worker', () => {
  const template = readFileSync('public/sw.js', 'utf8');
  const source = renderServiceWorker(template, 'hash9', ['./', './app.js']);

  it('refuses a template without placeholders', () => {
    expect(() => renderServiceWorker('nothing here', 'h', [])).toThrow();
  });

  function boot(scope, existingKeys) {
    const handlers = {};
    const opened = [];
    const deleted = [];
    const added = {};
    const caches = {
      open: async (name) => { opened.push(name); return { addAll: async (reqs) => { added[name] = reqs.map((r) => r.url); } }; },
      keys: async () => existingKeys,
      delete: async (k) => { deleted.push(k); return true; },
    };
    const self = {
      registration: { scope },
      location: new URL(scope),
      clients: { claim: async () => {} },
      addEventListener: (t, fn) => { handlers[t] = fn; },
      skipWaiting: () => { self.skipped = true; },
    };
    class Request { constructor(u) { this.url = u; } }
    vm.runInNewContext(source, { self, caches, URL, Request });
    const run = async (type, extra = {}) => { let p; handlers[type]({ waitUntil: (x) => { p = x; }, ...extra }); await p; };
    return { run, handlers, opened, deleted, added, self };
  }

  it('precaches into a cache named for its scope and hash', async () => {
    const sw = boot('https://x.test/iron-dominion/next/', []);
    await sw.run('install');
    expect(sw.opened).toEqual(['iron-dominion:/iron-dominion/next/:hash9']);
    expect(sw.added['iron-dominion:/iron-dominion/next/:hash9']).toEqual(['./', './app.js']);
  });

  it('activate deletes old caches of the same scope only', async () => {
    const sw = boot('https://x.test/iron-dominion/', [
      'iron-dominion:/iron-dominion/:old',
      'iron-dominion:/iron-dominion/:hash9',
      'iron-dominion:/iron-dominion/next/:old',
      'other-app:v1',
    ]);
    await sw.run('activate');
    expect(sw.deleted).toEqual(['iron-dominion:/iron-dominion/:old']);
  });

  it('only skips waiting when the page asks', () => {
    const sw = boot('https://x.test/iron-dominion/', []);
    sw.handlers.message({ data: { type: 'noise' } });
    expect(sw.self.skipped).toBeUndefined();
    sw.handlers.message({ data: { type: 'SKIP_WAITING' } });
    expect(sw.self.skipped).toBe(true);
  });
});

describe('service worker fetch handling', () => {
  const template = readFileSync('public/sw.js', 'utf8');
  const source = renderServiceWorker(template, 'hash9', ['./', './app.js']);
  const ORIGIN = 'https://x.test';

  class FakeResponse {
    constructor(body, ok = true) { this.body = body; this.ok = ok; this.type = 'basic'; }
    clone() { return new FakeResponse(this.body, this.ok); }
    static error() { const r = new FakeResponse('error', false); r.failed = true; return r; }
  }

  function boot(scope, { fetchImpl, cached = {} } = {}) {
    const handlers = {};
    const puts = [];
    const timers = [];
    const fetched = [];
    const cache = { put: async (k, v) => { puts.push([k, v.body]); } };
    const caches = {
      open: async () => cache,
      keys: async () => [],
      match: async (req, opt = {}) => {
        const key = typeof req === 'string' ? new URL(req, scope).href : req.url;
        if (cached[key]) return cached[key];
        if (opt.ignoreSearch) {
          const bare = key.split('?')[0];
          const k = Object.keys(cached).find((c) => c.split('?')[0] === bare);
          if (k) return cached[k];
        }
        return undefined;
      },
    };
    const self = {
      registration: { scope },
      location: new URL(scope),
      clients: { claim: async () => {} },
      addEventListener: (t, fn) => { handlers[t] = fn; },
    };
    class Request { constructor(u) { this.url = u; } }
    const inits = [];
    const fetch = (req, init) => { fetched.push(req.url); inits.push(init); return fetchImpl(req); };
    const ctx = {
      self, caches, URL, Request, Response: FakeResponse, fetch,
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout: () => {},
    };
    vm.runInNewContext(source, ctx);
    const request = (path, mode = 'cors') => ({ method: 'GET', url: ORIGIN + path, mode });
    const dispatch = async (req) => {
      let responded;
      const waits = [];
      handlers.fetch({ request: req, respondWith: (p) => { responded = p; }, waitUntil: (p) => { waits.push(p); } });
      return { handled: responded !== undefined, result: responded, waits };
    };
    return { dispatch, request, puts, timers, fetched, inits };
  }

  it('does not substitute the placeholders inside the template comment', () => {
    expect(source.split('\n')[0]).toContain('__BUILD_HASH__');
    expect(source).toContain('const HASH = "hash9";');
    expect(source).not.toContain("'__BUILD_HASH__'");
  });

  it('serves the cached shell when the network does not answer within the timeout', async () => {
    const shell = new FakeResponse('cached shell');
    const sw = boot('https://x.test/iron-dominion/', { fetchImpl: () => new Promise(() => {}), cached: { [ORIGIN + '/iron-dominion/']: shell } });
    const { handled, result } = await sw.dispatch(sw.request('/iron-dominion/', 'navigate'));
    expect(handled).toBe(true);
    await vi.waitFor(() => expect(sw.timers).toHaveLength(1));
    sw.timers[0]();
    expect(await result).toBe(shell);
  });

  it('serves the network answer and refreshes the cached shell when it arrives in time', async () => {
    const fresh = new FakeResponse('fresh shell');
    const sw = boot('https://x.test/iron-dominion/', { fetchImpl: async () => fresh, cached: { [ORIGIN + '/iron-dominion/']: new FakeResponse('old') } });
    const { result } = await sw.dispatch(sw.request('/iron-dominion/', 'navigate'));
    expect(await result).toBe(fresh);
    expect(sw.puts).toEqual([['./', 'fresh shell']]);
  });

  it('falls back to the cached shell when the network fails', async () => {
    const shell = new FakeResponse('cached shell');
    const sw = boot('https://x.test/iron-dominion/', { fetchImpl: async () => { throw new Error('offline'); }, cached: { [ORIGIN + '/iron-dominion/']: shell } });
    const { result } = await sw.dispatch(sw.request('/iron-dominion/', 'navigate'));
    expect(await result).toBe(shell);
  });

  it('never intercepts or caches a navigation to a nested scope', async () => {
    const sw = boot('https://x.test/iron-dominion/', { fetchImpl: async () => new FakeResponse('next shell') });
    const next = await sw.dispatch(sw.request('/iron-dominion/next/', 'navigate'));
    expect(next.handled).toBe(false);
    const deep = await sw.dispatch(sw.request('/iron-dominion/other.html', 'navigate'));
    expect(deep.handled).toBe(false);
    expect(sw.fetched).toEqual([]);
    expect(sw.puts).toEqual([]);
  });

  it('answers a sim worker request from its exact versioned cache entry', async () => {
    const worker = new FakeResponse('worker');
    const sw = boot('https://x.test/iron-dominion/', {
      fetchImpl: async () => new FakeResponse('network worker'),
      cached: { [ORIGIN + '/iron-dominion/sim-worker.js?v=hash9']: worker, [ORIGIN + '/iron-dominion/app.js']: new FakeResponse('app') },
    });
    expect(await (await sw.dispatch(sw.request('/iron-dominion/sim-worker.js?v=hash9'))).result).toBe(worker);
    expect(sw.fetched).toEqual([]);
    expect((await (await sw.dispatch(sw.request('/iron-dominion/app.js?x=1'))).result).body).toBe('app');
  });

  it('sends a sim worker request without an exact cache hit to the network uncached, never to another build cached worker or an error', async () => {
    const sw = boot('https://x.test/iron-dominion/', {
      fetchImpl: async () => new FakeResponse('network worker'),
      cached: { [ORIGIN + '/iron-dominion/sim-worker.js?v=old1']: new FakeResponse('old worker') },
    });
    for (const path of ['/iron-dominion/sim-worker.js?v=old1x', '/iron-dominion/sim-worker.js?v=hash9&r=123', '/iron-dominion/sim-worker.js']) {
      const res = await (await sw.dispatch(sw.request(path))).result;
      expect(res.body).toBe('network worker');
      expect(res.failed).toBeUndefined();
    }
    expect(sw.fetched).toHaveLength(3);
    expect(sw.inits).toEqual([{ cache: 'no-store' }, { cache: 'no-store' }, { cache: 'no-store' }]);
    expect(sw.puts).toEqual([]);
  });

  it('lets a network failure for the sim worker reach the page as a failed fetch', async () => {
    const sw = boot('https://x.test/iron-dominion/', { fetchImpl: async () => { throw new Error('offline'); } });
    const { result } = await sw.dispatch(sw.request('/iron-dominion/sim-worker.js?v=hash9'));
    await expect(result).rejects.toThrow('offline');
  });

  it('the root worker never intercepts, fetches or caches anything under the nested /next/ scope', async () => {
    const sw = boot('https://x.test/iron-dominion/', { fetchImpl: async () => new FakeResponse('x') });
    for (const path of ['/iron-dominion/next/app.js', '/iron-dominion/next/sim-worker.js?v=hash9', '/iron-dominion/next/icons/icon-192.png', '/iron-dominion/next/']) {
      expect((await sw.dispatch(sw.request(path))).handled).toBe(false);
    }
    const own = await sw.dispatch(sw.request('/iron-dominion/app.js'));
    expect(own.handled).toBe(true);
    await own.result;
    expect(sw.fetched).toEqual([ORIGIN + '/iron-dominion/app.js']);
  });

  it('the /next/ worker handles its own sim worker and assets', async () => {
    const hit = new FakeResponse('next worker');
    const sw = boot('https://x.test/iron-dominion/next/', {
      fetchImpl: async () => new FakeResponse('network'),
      cached: { [ORIGIN + '/iron-dominion/next/sim-worker.js?v=hash9']: hit },
    });
    expect(await (await sw.dispatch(sw.request('/iron-dominion/next/sim-worker.js?v=hash9'))).result).toBe(hit);
    expect((await sw.dispatch(sw.request('/iron-dominion/sim-worker.js?v=hash9'))).handled).toBe(false);
    expect((await sw.dispatch(sw.request('/iron-dominion/app.js'))).handled).toBe(false);
  });
});

describe('validateManifest', () => {
  const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8'));
  const dist = {
    'icons/icon-192.png': renderIconPng(192),
    'icons/icon-512.png': renderIconPng(512),
    'icons/icon-maskable-512.png': renderIconPng(512, { maskable: true }),
    'icon.svg': Buffer.from('<svg/>'),
  };
  const read = (p) => dist[p];

  it('accepts the shipped manifest against rendered icons', () => {
    expect(validateManifest(manifest, read)).toEqual([]);
  });
  it('reports missing fields, a missing icon file and a size mismatch', () => {
    const bad = { ...manifest, name: '', icons: manifest.icons.map((i) => (i.src.endsWith('icon-192.png') ? { ...i, sizes: '512x512' } : i)) };
    const problems = validateManifest(bad, (p) => (p === 'icons/icon-maskable-512.png' ? undefined : dist[p]));
    expect(problems).toContain('manifest.name is missing');
    expect(problems.some((p) => p.includes('icon-maskable-512.png is not in dist'))).toBe(true);
    expect(problems.some((p) => p.includes('icon-192.png is 192x192 but the manifest says 512x512'))).toBe(true);
  });
  it('requires relative start_url and scope so both base paths work', () => {
    expect(validateManifest({ ...manifest, start_url: '/' }, read)).toContain('manifest.start_url must be "./" so it works under any base path');
  });
});
