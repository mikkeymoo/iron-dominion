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

// Render checks run per backend on a fresh ?autostart page. Each returns a failure string or null.
const MAP = 256;
const RENDER_QUERY = (backend) => `?autostart=1&seed=42&backend=${backend}&governor=off&tier=low`;

async function decodeBands(page, png) {
  return page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const cv = new OffscreenCanvas(bmp.width, bmp.height);
    const g = cv.getContext('2d');
    g.drawImage(bmp, 0, 0);
    const stats = (x0, y0, w, h) => {
      const d = g.getImageData(x0, y0, w, h).data;
      let r = 0, gr = 0, b = 0, n = d.length / 4;
      const luma = new Float64Array(n);
      for (let i = 0; i < n; i++) { r += d[i * 4]; gr += d[i * 4 + 1]; b += d[i * 4 + 2]; luma[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]; }
      const mean = luma.reduce((a, v) => a + v, 0) / n;
      const sd = Math.sqrt(luma.reduce((a, v) => a + (v - mean) ** 2, 0) / n);
      return { r: r / n, g: gr / n, b: b / n, sd };
    };
    const W = bmp.width, H = bmp.height;
    return {
      top: stats(0, 0, W, Math.max(1, Math.floor(H * 0.06))),
      centre: stats(Math.floor(W * 0.35), Math.floor(H * 0.35), Math.floor(W * 0.3), Math.floor(H * 0.3)),
      size: [W, H],
    };
  }, png.toString('base64'));
}

const frames = (page) => page.evaluate(() => window.__iron?.render?.frames ?? 0);
const waitFrames = (page, n, timeout = 8000) => page.waitForFunction((target) => (window.__iron?.render?.frames ?? 0) >= target, n, { timeout }).then(() => true, () => false);

async function renderChecks(page, backend, opts) {
  const out = [];
  const add = (name, problem) => out.push([`${backend}: ${name}`, problem]);
  const up = await page.waitForFunction(() => window.__iron?.render?.ready === true, null, { timeout: 60000 }).then(() => true, () => false);
  if (!up) {
    const err = await page.locator('.game-error .detail').allTextContents().catch(() => []);
    add('renderer starts', `__iron.render never became ready${err.length ? `: ${err.join(' ')}` : ''}`);
    return out;
  }
  const f0 = await frames(page);
  const t0 = Date.now();
  const got = await waitFrames(page, f0 + 15, 5000);
  add('>= 15 frames within 5 s', got ? null : `only ${(await frames(page)) - f0} frames in ${Date.now() - t0} ms`);

  const info = await page.evaluate(() => { const r = window.__iron.render; return { backend: r.backend, tier: r.tier, adapter: r.adapter, software: r.software, drawCalls: r.drawCalls, triangles: r.triangles, budget: r.drawCallBudget }; });
  console.log(`         ${backend} adapter: ${info.adapter} (software=${info.software}), tier ${info.tier}, ${info.drawCalls} draw calls, ${info.triangles} triangles`);
  add('backend equals the request', info.backend === backend ? null : `asked for ${backend}, got ${info.backend}`);
  add('tier pinned by ?tier=low', info.tier === 'low' ? null : `tier ${info.tier}`);
  add('draw calls > 0, triangles > 10000, within tier budget', info.drawCalls > 0 && info.triangles > 10000 && info.drawCalls <= info.budget ? null : JSON.stringify(info));

  const size = await page.evaluate(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return { w: r.width, h: r.height }; });
  const centre = await page.evaluate(({ w, h }) => window.__iron.render.pickTile(w / 2, h / 2), size);
  add('pickTile at canvas centre is a tile on the map', centre && centre.x >= 0 && centre.y >= 0 && centre.x < MAP && centre.y < MAP ? null : `got ${JSON.stringify(centre)}`);

  await page.evaluate(() => window.__iron.render.resetCamera());
  const f1 = await frames(page);
  await waitFrames(page, f1 + 4, 5000);
  const reset = await page.evaluate(({ w, h }) => window.__iron.render.pickTile(w / 2, h / 2), size);
  add('after resetCamera, pickTile at centre is within 2 of (128,128)', reset && Math.abs(reset.x - 128) <= 2 && Math.abs(reset.y - 128) <= 2 ? null : `got ${JSON.stringify(reset)}`);

  await page.evaluate(() => window.__iron.render.resetCamera({ pitch: 0.3, dist: 80 }));
  const f1b = await frames(page);
  await waitFrames(page, f1b + 4, 5000);
  const png = await page.screenshot();
  if (opts.shots) await import('node:fs/promises').then((fs) => fs.writeFile(`${opts.shots}-${backend}.png`, png));
  const px = await decodeBands(page, png);
  add('top band is sky-like (blue channel highest)', px.top.b > px.top.r && px.top.b > px.top.g ? null : `top mean rgb ${px.top.r.toFixed(0)},${px.top.g.toFixed(0)},${px.top.b.toFixed(0)} in ${px.size}`);
  add('centre region is not uniform (luma stddev > 8)', px.centre.sd > 8 ? null : `stddev ${px.centre.sd.toFixed(2)}`);

  const perf = await page.locator('[data-testid="perf"]').innerText().catch(() => '');
  add('perf panel shows backend, fps, draw calls, triangles, sim tick', new RegExp(`backend\\s+${backend}`, 'i').test(perf.replace(/\n/g, ' ')) && /draw calls/.test(perf) && /triangles/.test(perf) && /sim tick/.test(perf) ? null : JSON.stringify(perf));

  if (opts.interact) {
    const before = await page.evaluate(() => ({ ...window.__iron.render.camera }));
    const box = await page.locator('canvas').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -400);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 60, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(300);
    await page.keyboard.up('KeyW');
    const after = await page.evaluate(() => ({ ...window.__iron.render.camera }));
    add('wheel zooms, drag pans, W moves the camera', after.dist < before.dist && Math.hypot(after.x - before.x, after.z - before.z) > 1 ? null : `before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
  }

  if (opts.loseDevice) {
    await page.evaluate(() => window.__iron.render.loseDevice());
    const back = await page.waitForFunction(() => { const r = window.__iron?.render; return r && r.deviceLosses === 1 && r.ready; }, null, { timeout: 30000 }).then(() => true, () => false);
    if (!back) add('recovers from device loss', 'renderer never came back');
    else {
      const f2 = await frames(page);
      await waitFrames(page, f2 + 10, 8000);
      const r = await page.evaluate(() => ({ canvases: window.__iron.render.canvasCount, drawCalls: window.__iron.render.drawCalls, triangles: window.__iron.render.triangles, frames: window.__iron.render.frames, backend: window.__iron.render.backend }));
      add('recovers from device loss on a fresh canvas and redraws terrain', r.canvases === 1 && r.frames >= f2 + 10 && r.drawCalls > 0 && r.triangles > 10000 && r.backend === backend ? null : JSON.stringify({ ...r, f2 }));
    }
  }
  return out;
}

const RENDER_LEGS = {
  desktop: [{ backend: 'webgl2', interact: true, loseDevice: true }, { backend: 'webgpu' }],
  phone: [{ backend: 'webgl2' }],
};

const browser = await chromium.launch({ ...(existsSync(CHROMIUM) ? { executablePath: CHROMIUM } : {}), args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-vulkan=swiftshader', '--enable-features=Vulkan'] });
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
    for (const leg of RENDER_LEGS[vp.name] ?? []) {
      const p = await open(RENDER_QUERY(leg.backend));
      for (const [name, problem] of await renderChecks(p, leg.backend, { ...leg, shots: process.env.SMOKE_SHOTS ? `${process.env.SMOKE_SHOTS}-${vp.name}` : undefined })) {
        console.log(`${vp.name.padEnd(8)} ${problem ? 'FAIL' : 'ok  '} ${name}${problem ? `: ${problem}` : ''}`);
        if (problem) failed++;
      }
      await p.close();
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
