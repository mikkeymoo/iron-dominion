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
// time=0.5 pins noon: a new game starts at 00:00, and the sky/terrain/colour checks below are daylight checks.
const RENDER_QUERY = (backend) => `?autostart=1&seed=42&backend=${backend}&governor=off&tier=low&time=0.5`;
const READY_MS = 240000;

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
      // Colour variance: summed per-channel variance, so hue differences count and not only brightness.
      let vr = 0, vg = 0, vb = 0;
      for (let i = 0; i < n; i++) { vr += (d[i * 4] - r / n) ** 2; vg += (d[i * 4 + 1] - gr / n) ** 2; vb += (d[i * 4 + 2] - b / n) ** 2; }
      return { r: r / n, g: gr / n, b: b / n, sd, cvar: (vr + vg + vb) / n };
    };
    const W = bmp.width, H = bmp.height;
    // `body` skips the HUD (toolbar on top, perf panel on the left) so a day/night comparison measures the world.
    const bx = Math.floor(W * 0.3), by = Math.floor(H * 0.12);
    return {
      top: stats(0, 0, W, Math.max(1, Math.floor(H * 0.06))),
      centre: stats(Math.floor(W * 0.35), Math.floor(H * 0.35), Math.floor(W * 0.3), Math.floor(H * 0.3)),
      body: stats(bx, by, W - bx, H - by),
      size: [W, H],
    };
  }, png.toString('base64'));
}

const frames = (page) => page.evaluate(() => window.__iron?.render?.frames ?? 0);
const waitFrames = (page, n, timeout = 8000) => page.waitForFunction((target) => (window.__iron?.render?.frames ?? 0) >= target, n, { timeout }).then(() => true, () => false);

async function renderChecks(page, backend, opts) {
  const out = [];
  const add = (name, problem) => out.push([`${backend}: ${name}`, problem]);
  const up = await page.waitForFunction(() => window.__iron?.render?.ready === true, null, { timeout: READY_MS }).then(() => true, () => false);
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

// U3 showcase: a district of every RCI archetype. `base` is a plain page on the same backend, used as the terrain-only baseline.
const SHOWCASE_FLOOR_TRIANGLES = 60000;
// Centre-region colour variance (sum of channel variances). Measured at the U3 gate: terrain only ~1400, showcase 4470-6415
// (webgl2 low, webgpu high, phone). The terrain-only baseline is re-measured live on the same pose; the showcase must beat it
// by 2x and clear this absolute floor, set just over half the lowest measured showcase value.
const SHOWCASE_MIN_CVAR = 2500;
const SHOWCASE_MIN_BUILDINGS = 90;

async function showcaseChecks(page, base, backend, label) {
  const out = [];
  const add = (name, problem) => out.push([`${backend}: showcase ${name}`, problem]);
  const up = await page.waitForFunction(() => window.__iron?.render?.ready === true, null, { timeout: READY_MS }).then(() => true, () => false);
  if (!up) { add('renderer starts', 'never ready'); return out; }
  const loaded = await page.waitForFunction((n) => { const b = window.__iron?.render?.buildings; return b && b.instances + b.farInstances >= n; }, SHOWCASE_MIN_BUILDINGS, { timeout: 120000 }).then(() => true, () => false);
  const f0 = await frames(page);
  await waitFrames(page, f0 + 6, 30000);
  const info = await page.evaluate(() => { const r = window.__iron.render; return { tier: r.tier, drawCalls: r.drawCalls, triangles: r.triangles, budget: r.drawCallBudget, b: { ...r.buildings }, cam: r.showcaseCamera }; });
  console.log(`         ${label} ${backend} showcase: tier ${info.tier}, ${info.drawCalls}/${info.budget} draw calls, ${info.triangles} triangles, buildings ${JSON.stringify(info.b)}`);
  add(`debug sim placed >= ${SHOWCASE_MIN_BUILDINGS} buildings`, loaded ? null : `only ${info.b.instances + info.b.farInstances}`);
  add('building instance count > 0 (near LOD)', info.b.instances > 0 ? null : JSON.stringify(info.b));
  add('construction sites and cranes are instanced', info.b.sites > 0 && info.b.cranes > 0 ? null : JSON.stringify(info.b));
  add('building draw calls > 0 and total within tier budget', info.b.drawCalls > 0 && info.drawCalls <= info.budget ? null : JSON.stringify(info));
  add(`triangles > ${SHOWCASE_FLOOR_TRIANGLES}`, info.triangles > SHOWCASE_FLOOR_TRIANGLES ? null : `triangles ${info.triangles}`);

  const png = await page.screenshot();
  if (process.env.SMOKE_SHOTS) await import('node:fs/promises').then((fs) => fs.writeFile(`${process.env.SMOKE_SHOTS}-${label}-${backend}-showcase.png`, png));
  const show = await decodeBands(page, png);
  let baseline = null;
  if (info.cam) {
    await base.evaluate((c) => window.__iron.render.resetCamera(c), info.cam);
    const b0 = await frames(base);
    await waitFrames(base, b0 + 6, 20000);
    baseline = await decodeBands(base, await base.screenshot());
  }
  console.log(`         ${label} ${backend} centre colour variance: showcase ${show.centre.cvar.toFixed(0)}, terrain only ${baseline ? baseline.centre.cvar.toFixed(0) : 'n/a'}`);
  add(`centre colour variance > ${SHOWCASE_MIN_CVAR} and above the terrain-only baseline`, show.centre.cvar > SHOWCASE_MIN_CVAR && (!baseline || show.centre.cvar > baseline.centre.cvar * 2) ? null : `showcase ${show.centre.cvar.toFixed(1)}, baseline ${baseline ? baseline.centre.cvar.toFixed(1) : 'n/a'}`);
  return out;
}
// ---- U4 atmosphere and post checks ----
// The expected effect chain and shadow rig per tier mirror TIER_TABLE in src/render/tier.ts; a mismatch means the chain
// built something other than what the table promises.
const EXPECTED_PASSES = {
  low: ['scene', 'bloom', 'grade'],
  mid: ['scene', 'tiltShift', 'bloom', 'grade'],
  high: ['scene', 'ao', 'tiltShift', 'godRays', 'bloom', 'fxaa', 'grade'],
  ultra: ['scene', 'ao', 'taa', 'tiltShift', 'dof', 'godRays', 'bloom', 'chromatic', 'grade'],
};
const EXPECTED_SHADOWS = { low: ['none', 0], mid: ['view', 1], high: ['csm', 3], ultra: ['csm', 4] };
const lumaOf = (s) => 0.2126 * s.r + 0.7152 * s.g + 0.0722 * s.b;
const fxInfo = (page) => page.evaluate(() => { const r = window.__iron.render; return { backend: r.backend, tier: r.tier, drawCalls: r.drawCalls, budget: r.drawCallBudget, fx: JSON.parse(JSON.stringify(r.fx)) }; });

async function readyShowcase(page) {
  const up = await page.waitForFunction(() => window.__iron?.render?.ready === true, null, { timeout: READY_MS }).then(() => true, () => false);
  if (!up) return false;
  await page.waitForFunction((n) => { const b = window.__iron?.render?.buildings; return b && b.instances + b.farInstances >= n; }, SHOWCASE_MIN_BUILDINGS, { timeout: READY_MS }).catch(() => {});
  const f0 = await frames(page);
  await waitFrames(page, f0 + 6, 60000);
  return true;
}

async function fxChecks(noon, open, leg, label) {
  const out = [];
  const tier = leg.showcaseTier ?? 'low';
  const add = (name, problem) => out.push([`${leg.backend}: fx ${tier} ${name}`, problem]);
  const query = (time, extra = '') => `${RENDER_QUERY(leg.backend)}&showcase=1${extra}`.replace('tier=low', `tier=${tier}`).replace('time=0.5', `time=${time}`);
  const shots = process.env.SMOKE_SHOTS;
  const save = async (suffix, png) => { if (shots) await import('node:fs/promises').then((fs) => fs.writeFile(`${shots}-${label}-${leg.backend}-${tier}-${suffix}.png`, png)); };

  const dayInfo = await fxInfo(noon);
  const dayPng = await noon.screenshot();
  await save('noon', dayPng);
  const day = await decodeBands(noon, dayPng);

  // Software rendering shares the CPU between every open page, so the noon page goes away before the night page loads.
  await noon.close();
  const night = await open(query(0.95));
  let nightInfo = null, nightLuma = NaN;
  if (await readyShowcase(night)) {
    nightInfo = await fxInfo(night);
    const nightPng = await night.screenshot();
    await save('night', nightPng);
    nightLuma = lumaOf((await decodeBands(night, nightPng)).body);
  }
  await night.close();
  const dayLuma = lumaOf(day.body);
  console.log(`         ${leg.backend} ${tier} fx: noon luma ${dayLuma.toFixed(1)}, night luma ${nightLuma.toFixed(1)}, passes [${dayInfo.fx.postPasses.join(', ')}], ${dayInfo.drawCalls}/${dayInfo.budget} draw calls at noon, ${nightInfo?.drawCalls ?? 'n/a'} at night, ${nightInfo?.fx.lamps ?? 0} streetlights, shadows ${JSON.stringify(dayInfo.fx.shadows)}, water ${JSON.stringify(dayInfo.fx.water)}`);

  add('?time=0.5 pins the displayed day fraction', Math.abs(dayInfo.fx.dayFrac - 0.5) < 0.01 && dayInfo.fx.overrides.time ? null : JSON.stringify(dayInfo.fx));
  add('noon mean luminance >= 2x night (?time=0.95)', nightInfo && dayLuma >= 2 * nightLuma ? null : `noon ${dayLuma.toFixed(1)}, night ${nightLuma.toFixed(1)}`);
  add('night pins dayFrac 0.95 and lights streetlights', nightInfo && Math.abs(nightInfo.fx.dayFrac - 0.95) < 0.01 && nightInfo.fx.lamps > 0 ? null : `night page ${nightInfo ? JSON.stringify(nightInfo.fx) : 'never became ready'}`);
  add('postPasses match the tier table', JSON.stringify(dayInfo.fx.postPasses) === JSON.stringify(EXPECTED_PASSES[tier]) ? null : `got ${JSON.stringify(dayInfo.fx.postPasses)}, want ${JSON.stringify(EXPECTED_PASSES[tier])}`);
  const [mode, cascades] = EXPECTED_SHADOWS[tier];
  add(`shadow rig is ${mode} with ${cascades} cascade(s)`, dayInfo.fx.shadows.mode === mode && dayInfo.fx.shadows.cascades === cascades ? null : JSON.stringify(dayInfo.fx.shadows));
  add('draw calls within the tier budget at noon and at night', dayInfo.drawCalls > 0 && dayInfo.drawCalls <= dayInfo.budget && nightInfo && nightInfo.drawCalls <= nightInfo.budget ? null : `noon ${dayInfo.drawCalls}, night ${nightInfo?.drawCalls}, budget ${dayInfo.budget}`);

  if (leg.rain) {
    const rain = await open(query(0.5, '&weather=rain'));
    if (await readyShowcase(rain)) {
      await rain.waitForFunction(() => window.__iron.render.fx.particles.rain > 0, null, { timeout: 60000 }).catch(() => {});
      const r = await fxInfo(rain);
      const png = await rain.screenshot();
      await save('rain', png);
      console.log(`         ${leg.backend} ${tier} fx rain: weather ${r.fx.weather}, particles ${JSON.stringify(r.fx.particles)}, ${r.drawCalls}/${r.budget} draw calls`);
      add('?weather=rain pins the visual weather', r.fx.weather === 'rain' && r.fx.overrides.weather ? null : JSON.stringify(r.fx));
      add('rain reports live particles > 0', r.fx.particles.live > 0 && r.fx.particles.rain > 0 ? null : JSON.stringify(r.fx.particles));
      add('rain draw calls within the tier budget', r.drawCalls <= r.budget ? null : `${r.drawCalls} > ${r.budget}`);
    } else add('rain page starts', 'renderer never ready');
    await rain.close();
  }
  return out;
}
// ---- end U4 block ----

// ---- U5 persistence and lifecycle checks (real IndexedDB, same browser context so storage survives the reload) ----
const PERSIST_QUERY = '?autostart=1&seed=42&backend=webgl2&tier=low&governor=off';
const tickOf = (page) => page.evaluate(() => window.__iron?.sim?.tick ?? 0);

async function persistenceChecks(open) {
  const out = [];
  const add = (name, problem) => out.push([`persist: ${name}`, problem]);
  const a = await open(PERSIST_QUERY);
  const reached = await a.waitForFunction(() => (window.__iron?.sim?.tick ?? 0) >= 50 && !!window.__iron?.platform, null, { timeout: 60000 }).then(() => true, () => false);
  if (!reached) { add('sim reaches tick 50', `tick ${await tickOf(a)}`); await a.close(); return out; }
  const saved = await a.evaluate(async () => {
    const r = await window.__iron.platform.save();
    return r.ok ? { ok: true, id: r.value.slot.id, tick: r.value.tick, hash: r.value.hash, lastHash: window.__iron.platform.lastSaveHash } : r;
  });
  add('save() stores the running city', saved.ok && saved.tick >= 50 && saved.hash === saved.lastHash ? null : JSON.stringify(saved));
  if (!saved.ok) { await a.close(); return out; }
  const listed = await a.evaluate(async (id) => { const r = await window.__iron.platform.slots(); return r.ok && r.value.some((s) => s.id === id); }, saved.id);
  add('slots() lists the saved slot', listed ? null : 'slot missing from list');
  await a.close();

  const b = await open(`${PERSIST_QUERY}&slot=${saved.id}`);
  const loaded = await b.waitForFunction((t) => window.__iron?.sim?.hashTick === t, saved.tick, { timeout: 60000 }).then(() => true, () => false);
  const got = await b.evaluate(() => ({ hash: window.__iron.sim.hash, hashTick: window.__iron.sim.hashTick }));
  add('reload with &slot= gives the saved hash at the saved tick', loaded && got.hash === saved.hash ? null : `got ${JSON.stringify(got)}, want hash ${saved.hash} at tick ${saved.tick}`);
  const overlay = await b.getByRole('button', { name: 'Resume' }).waitFor({ timeout: 15000 }).then(() => true, () => false);
  add('a loaded city waits behind the Resume overlay', overlay ? null : 'no Resume button');
  const held = await tickOf(b);
  await b.waitForTimeout(1200);
  add('a loaded city does not tick before Resume', (await tickOf(b)) === held ? null : `tick moved from ${held} to ${await tickOf(b)}`);
  await b.getByRole('button', { name: 'Resume' }).click();
  const ticking = await b.waitForFunction((t) => (window.__iron?.sim?.tick ?? 0) > t, held, { timeout: 15000 }).then(() => true, () => false);
  add('Resume restarts ticking', ticking ? null : `tick stayed at ${await tickOf(b)}`);

  const setVisibility = (state) => b.evaluate((st) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => st });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
  await setVisibility('hidden');
  await b.waitForTimeout(400);
  const frozen = await tickOf(b);
  await b.waitForTimeout(1500);
  add('hidden page stops the tick for 1.5 s', (await tickOf(b)) === frozen ? null : `tick moved from ${frozen} to ${await tickOf(b)}`);
  await setVisibility('visible');
  const shown = await b.getByRole('button', { name: 'Resume' }).waitFor({ timeout: 5000 }).then(() => true, () => false);
  add('returning shows the Resume overlay', shown ? null : 'no Resume button after returning');
  await b.waitForTimeout(600);
  add('returning does not resume by itself', (await tickOf(b)) === frozen ? null : `tick moved from ${frozen} to ${await tickOf(b)}`);
  await b.getByRole('button', { name: 'Resume' }).click();
  const again = await b.waitForFunction((t) => (window.__iron?.sim?.tick ?? 0) > t, frozen, { timeout: 15000 }).then(() => true, () => false);
  add('Resume after hide restarts ticking', again ? null : `tick stayed at ${await tickOf(b)}`);
  await b.close();
  return out;
}
// ---- end U5 block ----

const RENDER_LEGS = {
  desktop: [{ backend: 'webgl2', interact: true, loseDevice: true, fx: true, rain: true }, { backend: 'webgpu', showcaseTier: 'high', fx: true }],
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
      const sp = await open(`${RENDER_QUERY(leg.backend)}&showcase=1`.replace('tier=low', `tier=${leg.showcaseTier ?? 'low'}`));
      for (const [name, problem] of await showcaseChecks(sp, p, leg.backend, vp.name)) {
        console.log(`${vp.name.padEnd(8)} ${problem ? 'FAIL' : 'ok  '} ${name}${problem ? `: ${problem}` : ''}`);
        if (problem) failed++;
      }
      if (leg.fx) {
        await p.close();
        for (const [name, problem] of await fxChecks(sp, open, leg, vp.name)) {
          console.log(`${vp.name.padEnd(8)} ${problem ? 'FAIL' : 'ok  '} ${name}${problem ? `: ${problem}` : ''}`);
          if (problem) failed++;
        }
      }
      if (!sp.isClosed()) await sp.close();
      if (!p.isClosed()) await p.close();
    }
    if (vp.name === 'desktop') {
      for (const [name, problem] of await persistenceChecks(open)) {
        console.log(`${vp.name.padEnd(8)} ${problem ? 'FAIL' : 'ok  '} ${name}${problem ? `: ${problem}` : ''}`);
        if (problem) failed++;
      }
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
