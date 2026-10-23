// Headless browser smoke test against the built dist/ folder.
// Serves dist/ on a local port, loads it at a desktop and a phone viewport, and fails on
// console errors, page errors, or any unmet check in CHECKS. Real-device frame rate and
// touch feel are out of reach here; this proves the build boots and renders.
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright-core';

const GOLDEN = JSON.parse(readFileSync(new URL('../src/sim/golden.json', import.meta.url), 'utf8'));
const CHROMIUM = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
const ROOT = new URL('../dist/', import.meta.url).pathname;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const VIEWPORTS = [{ name: 'desktop', width: 1280, height: 760 }, { name: 'phone', width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }];

const server = createServer(async (req, res) => {
  const path = normalize(join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    const file = (await stat(path)).isDirectory() ? join(path, 'index.html') : path;
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

// Each check runs in the page after load and returns a failure string or null. `open(query)` loads a second page.
const CHECKS = [
  ['title rendered', async (page) => (await page.getByRole('heading', { name: 'Iron Dominion' }).count()) ? null : 'no title heading'],
  ['sim worker ready', async (page) => {
    await page.waitForSelector('[data-worker="ready"]', { timeout: 5000 }).catch(() => {});
    return (await page.locator('[data-worker="ready"]').count()) ? null : 'worker never reported ready';
  }],
  ['sim ticking', async (page) => {
    await page.waitForFunction(() => (window.__iron?.sim?.tick ?? 0) > 0, null, { timeout: 5000 }).catch(() => {});
    const tick = await page.evaluate(() => window.__iron?.sim?.tick ?? 0);
    const attr = await page.locator('[data-worker="ready"]').getAttribute('data-tick');
    return tick > 0 && Number(attr) > 0 ? null : `tick ${tick}, data-tick ${attr}`;
  }],
  [`worker hash at seed ${GOLDEN.seed} tick ${GOLDEN.idle.ticks} equals the Vitest golden`, async (_page, open) => {
    const p = await open(`?seed=${GOLDEN.seed}&haltAt=${GOLDEN.idle.ticks}`);
    await p.waitForFunction((t) => window.__iron?.sim?.hashTick === t, GOLDEN.idle.ticks, { timeout: 15000 }).catch(() => {});
    const got = await p.evaluate(() => ({ ...window.__iron?.sim }));
    await p.close();
    return got.hashTick === GOLDEN.idle.ticks && got.hash === GOLDEN.idle.hash ? null : `got ${JSON.stringify(got)}, want hash ${GOLDEN.idle.hash} at tick ${GOLDEN.idle.ticks}`;
  }],
];

const browser = await chromium.launch({ ...(existsSync(CHROMIUM) ? { executablePath: CHROMIUM } : {}), args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
let failed = 0;
try {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.isMobile, hasTouch: vp.hasTouch, deviceScaleFactor: vp.deviceScaleFactor });
    const page = await ctx.newPage();
    const errors = [];
    const watch = (p) => {
      p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      p.on('pageerror', (e) => errors.push(String(e)));
      p.on('worker', (w) => w.on('console', (m) => { if (m.type() === 'error') errors.push(`[worker] ${m.text()}`); }));
    };
    watch(page);
    const open = async (query) => { const p = await ctx.newPage(); watch(p); await p.goto(url + query, { waitUntil: 'load' }); return p; };
    await page.goto(url, { waitUntil: 'load' });
    for (const [name, check] of CHECKS) {
      const problem = await check(page, open);
      console.log(`${vp.name.padEnd(8)} ${problem ? 'FAIL' : 'ok  '} ${name}${problem ? `: ${problem}` : ''}`);
      if (problem) failed++;
    }
    if (errors.length) { failed++; console.log(`${vp.name.padEnd(8)} FAIL console errors:\n  ${errors.join('\n  ')}`); }
    else console.log(`${vp.name.padEnd(8)} ok   no console errors`);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(failed ? `smoke: ${failed} failure(s)` : 'smoke: pass');
process.exit(failed ? 1 : 0);
