// Headless browser smoke test against the built dist/ folder.
// Serves dist/ on a local port, loads it at a desktop and a phone viewport, and fails on
// console errors, page errors, or any unmet check in CHECKS. Real-device frame rate and
// touch feel are out of reach here; this proves the build boots and renders.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = new URL('../dist/', import.meta.url).pathname;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const VIEWPORTS = [{ name: 'desktop', width: 1280, height: 760 }, { name: 'phone', width: 390, height: 844, isMobile: true, hasTouch: true }];

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

// Each check runs in the page after load and returns a failure string or null.
const CHECKS = [
  ['title rendered', async (page) => (await page.getByRole('heading', { name: 'Iron Dominion' }).count()) ? null : 'no title heading'],
  ['sim worker ready', async (page) => {
    await page.waitForSelector('[data-worker="ready"]', { timeout: 5000 }).catch(() => {});
    return (await page.locator('[data-worker="ready"]').count()) ? null : 'worker never reported ready';
  }],
];

const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
let failed = 0;
try {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.isMobile, hasTouch: vp.hasTouch });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(url, { waitUntil: 'load' });
    for (const [name, check] of CHECKS) {
      const problem = await check(page);
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
