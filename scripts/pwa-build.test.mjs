import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
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
