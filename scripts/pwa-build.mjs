// Pure build-time helpers for the PWA: precache list, cache naming, service worker rendering, manifest validation.
// build.mjs does the file I/O; everything here takes plain data so Vitest can exercise it.
import { readPngSize } from './png.mjs';

export const CACHE_PREFIX = 'iron-dominion';
const NEVER_PRECACHE = new Set(['sw.js', 'build.json', '.nojekyll']);

/** Cache name for one build served from one scope. Caches are per origin, so the scope keeps /iron-dominion/ and /iron-dominion/next/ apart. */
export function cacheName(scopePath, hash) {
  return `${CACHE_PREFIX}:${scopePath}:${hash}`;
}

/** Prefix shared by every build's cache for one scope; the activate step deletes those that are not the current name. */
export function cachePrefix(scopePath) {
  return `${CACHE_PREFIX}:${scopePath}:`;
}

/**
 * Relative URLs (relative to the service worker) to precache, from the list of files in dist/ (forward-slash paths).
 * The sim worker is requested with ?v=<hash>, so it is stored under that exact URL.
 */
export function precacheList(distFiles, hash) {
  const urls = new Set(['./']);
  for (const f of distFiles) {
    if (NEVER_PRECACHE.has(f) || f.endsWith('.map')) continue;
    urls.add(f === 'sim-worker.js' ? `./sim-worker.js?v=${hash}` : `./${f}`);
  }
  return [...urls].sort();
}

/** Fills the placeholders in public/sw.js. */
export function renderServiceWorker(template, hash, urls) {
  if (!template.includes("'__BUILD_HASH__'") || !template.includes('"__PRECACHE__"')) throw new Error('sw template is missing its placeholders');
  return template.replace("'__BUILD_HASH__'", () => JSON.stringify(hash)).replace('"__PRECACHE__"', () => JSON.stringify(urls));
}

const REQUIRED_STRINGS = ['name', 'short_name', 'description', 'start_url', 'scope', 'display', 'background_color', 'theme_color'];

/**
 * Problems with a parsed manifest. `readDistFile(relPath)` returns the file's bytes or undefined; icon sizes are checked
 * against the PNG header so a stale or missing icon fails the build.
 */
export function validateManifest(m, readDistFile) {
  const problems = [];
  for (const k of REQUIRED_STRINGS) if (typeof m[k] !== 'string' || !m[k]) problems.push(`manifest.${k} is missing`);
  if (m.start_url !== './') problems.push('manifest.start_url must be "./" so it works under any base path');
  if (m.scope !== './') problems.push('manifest.scope must be "./" so it works under any base path');
  if (!['fullscreen', 'standalone', 'minimal-ui', 'browser'].includes(m.display)) problems.push(`manifest.display "${m.display}" is not valid`);
  const icons = Array.isArray(m.icons) ? m.icons : [];
  const pngs = icons.filter((i) => i.type === 'image/png');
  const want = (size, purpose) => pngs.some((i) => i.sizes === `${size}x${size}` && (i.purpose ?? 'any').split(' ').includes(purpose));
  if (!want(192, 'any')) problems.push('manifest needs a 192x192 png icon');
  if (!want(512, 'any')) problems.push('manifest needs a 512x512 png icon');
  if (!pngs.some((i) => (i.purpose ?? '').split(' ').includes('maskable'))) problems.push('manifest needs a maskable png icon');
  for (const i of icons) {
    if (typeof i.src !== 'string' || !i.src.startsWith('./')) { problems.push(`icon src "${i.src}" must be relative (./...)`); continue; }
    const bytes = readDistFile(i.src.slice(2));
    if (!bytes) { problems.push(`icon ${i.src} is not in dist`); continue; }
    if (i.type !== 'image/png') continue;
    const size = readPngSize(bytes);
    if (!size) { problems.push(`icon ${i.src} is not a valid png`); continue; }
    if (i.sizes !== `${size.width}x${size.height}`) problems.push(`icon ${i.src} is ${size.width}x${size.height} but the manifest says ${i.sizes}`);
  }
  return problems;
}
