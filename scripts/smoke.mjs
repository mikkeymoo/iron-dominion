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

// ---- U6 build tools checks (webgl2 low only) ----
// Costs below are the catalog's: depot 500, street 10 per tile on land, zone 2 per tile.
const BUILD_QUERY = '?autostart=1&seed=42&backend=webgl2&tier=low&governor=off';
const DEPOT_COST = 500, STREET_COST = 10, ZONE_COST = 2;
const until = (page, fn, arg, timeout = 20000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
const camOf = (page) => page.evaluate(() => ({ ...window.__iron.render.camera }));
// A page can report the renderer ready a moment before the first terrain resync reaches the mirror; until then findSite sees only water.
const siteWhenReady = async (page, size) => {
  await until(page, (n) => window.__iron.tools.findSite(n) !== null, size, 20000);
  return page.evaluate((n) => window.__iron.tools.findSite(n), size);
};

async function bootBuildPage(open, add) {
  const page = await open(BUILD_QUERY);
  const up = await until(page, () => { const r = window.__iron?.render; return !!(r && r.ready && r.drawCalls > 0 && r.triangles > 10000 && window.__iron.tools); }, null, 60000);
  if (!up) { add('city boots with tools', 'renderer or __iron.tools never ready'); await page.close(); return null; }
  // A depot with a road at its door makes robots, and they cost money; these checks are about exact tool costs, so the sim waits
  // (commands still run at once while paused). The robot checks below run their own, unpaused page.
  await page.locator('button[title="Pause (0)"]').click();
  const site = await siteWhenReady(page, 14);
  if (!site) { add('a flat 14x14 land site exists near the centre', 'findSite returned null'); await page.close(); return null; }
  await page.evaluate((s) => window.__iron.render.resetCamera({ x: s.x + 7, z: s.y + 7, dist: 45, pitch: 1.1 }), site);
  await waitFrames(page, (await frames(page)) + 6, 10000);
  return { page, site };
}

async function placeDepot(page, site, add, label) {
  const before = await page.evaluate(() => ({ inst: window.__iron.render.buildings.instances, money: window.__iron.tools.treasury }));
  const placed = await page.evaluate((s) => {
    const t = window.__iron.tools;
    t.select('service', { name: 'depot' });
    const id = t.dragTiles(t.tileFor('depot', { x: s.x + 2, y: s.y + 2 }), t.tileFor('depot', { x: s.x + 2, y: s.y + 2 }));
    return id;
  }, site);
  add(`${label}depot placed through tools.dragTiles (command sent)`, placed > 0 ? null : `dragTiles returned ${placed}; toasts ${JSON.stringify(await page.evaluate(() => window.__iron.tools.toasts))}`);
  if (!(placed > 0)) return null;
  const accepted = await until(page, (id) => { const e = window.__iron.tools.lastEvent; return !!e && e.cmd === id; }, placed);
  const ev = await page.evaluate(() => window.__iron.tools.lastEvent);
  add(`${label}sim accepts the depot`, accepted && ev.type === 'accepted' ? null : JSON.stringify(ev));
  const grew = await until(page, (n) => window.__iron.render.buildings.instances > n, before.inst);
  add(`${label}render.buildings.instances increases after the depot`, grew ? null : `still ${await page.evaluate(() => window.__iron.render.buildings.instances)} (was ${before.inst})`);
  const paid = await until(page, (v) => window.__iron.tools.treasury === v, before.money - DEPOT_COST);
  add(`${label}treasury drops by the depot's catalog cost ${DEPOT_COST}`, paid ? null : `treasury ${await page.evaluate(() => window.__iron.tools.treasury)}, want ${before.money - DEPOT_COST}`);
  return before.money - DEPOT_COST;
}

async function buildToolChecksDesktop(open) {
  const out = [];
  const add = (name, problem) => out.push([`build: ${name}`, problem]);
  const boot = await bootBuildPage(open, add);
  if (!boot) return out;
  const { page, site } = boot;
  const waitMoney = (v) => until(page, (x) => window.__iron.tools.treasury === x, v);

  let money = await placeDepot(page, site, add, '');
  if (money === null) { await page.close(); return out; }

  // Road: a straight street on the row just below the depot.
  const roadY = site.y + 4, x0 = site.x + 2, x1 = site.x + 9;
  const roadId = await page.evaluate(({ x0, x1, y }) => { const t = window.__iron.tools; t.select('road', { cls: 1 }); return t.dragTiles({ x: x0, y }, { x: x1, y }); }, { x0, x1, y: roadY });
  const roadOk = roadId > 0 && await until(page, (id) => window.__iron.tools.lastEvent?.cmd === id, roadId);
  const roaded = await until(page, ({ x0, x1, y }) => { for (let x = x0; x <= x1; x++) if ((window.__iron.tools.peek('road', x, y) & 7) === 0) return false; return true; }, { x0, x1, y: roadY });
  add('a dragged road line puts road tiles in the mirror', roadOk && roaded ? null : `command ${roadId}, mirror road ${roaded}`);
  money -= (x1 - x0 + 1) * STREET_COST;
  add('the road debits 10 per tile', await waitMoney(money) ? null : `treasury ${await page.evaluate(() => window.__iron.tools.treasury)}, want ${money}`);

  // Zone a rect below the road, then undo it.
  const zr = { x0: site.x + 2, y0: site.y + 6, x1: site.x + 9, y1: site.y + 10 };
  const zoneId = await page.evaluate((r) => { const t = window.__iron.tools; t.select('zone', { zone: 1, density: 0 }); return t.dragTiles({ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y1 }); }, zr);
  const zoneOk = zoneId > 0 && await until(page, (id) => window.__iron.tools.lastEvent?.cmd === id, zoneId);
  const zoned = await until(page, (r) => { for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) if (window.__iron.tools.peek('zone', x, y) !== 1) return false; return true; }, zr);
  add('a dragged zone rect sets the zone layer', zoneOk && zoned ? null : `command ${zoneId}, mirror zone ${zoned}`);
  const beforeZone = money;
  money -= (zr.x1 - zr.x0 + 1) * (zr.y1 - zr.y0 + 1) * ZONE_COST;
  add('the zone debits 2 per tile', await waitMoney(money) ? null : `treasury ${await page.evaluate(() => window.__iron.tools.treasury)}, want ${money}`);
  add('the undo stack holds the road and the zone (the depot too)', (await page.evaluate(() => window.__iron.tools.undoDepth)) === 3 ? null : `depth ${await page.evaluate(() => window.__iron.tools.undoDepth)}`);

  const undoId = await page.evaluate(() => window.__iron.tools.undo());
  const undoOk = undoId > 0 && await until(page, (id) => { const e = window.__iron.tools.lastEvent; return !!e && e.cmd === id && e.type === 'accepted'; }, undoId);
  const cleared = await until(page, (r) => { for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) if (window.__iron.tools.peek('zone', x, y) !== 0) return false; return true; }, zr);
  add('Undo accepted clears the zone', undoOk && cleared ? null : `undo ${undoId} ok ${undoOk}, cleared ${cleared}`);
  add('undo refunds the zone', await waitMoney(beforeZone) ? null : `treasury ${await page.evaluate(() => window.__iron.tools.treasury)}, want ${beforeZone}`);
  add('the zone leaves the undo stack', (await page.evaluate(() => window.__iron.tools.undoDepth)) === 2 ? null : `depth ${await page.evaluate(() => window.__iron.tools.undoDepth)}`);

  // A building on water is refused with a toast and costs nothing.
  const water = await page.evaluate(() => window.__iron.tools.findWater());
  if (!water) add('water tile exists for the rejection check', 'findWater returned null');
  else {
    const moneyBefore = await page.evaluate(() => window.__iron.tools.treasury);
    const sent = await page.evaluate((w) => { const t = window.__iron.tools; t.select('service', { name: 'depot' }); return t.dragTiles(t.tileFor('depot', w), t.tileFor('depot', w)); }, water);
    const toast = await page.locator('[data-testid="toast"]').first().waitFor({ timeout: 5000 }).then(() => true, () => false);
    const text = toast ? await page.locator('[data-testid="toast"]').first().innerText() : '';
    add('placing a building on water shows a rejection toast in plain words', toast && /water|ground/i.test(text) ? null : `toast "${text}"`);
    add('the refused placement sent no command', sent === 0 ? null : `command ${sent}`);
    await page.waitForTimeout(400);
    add('treasury is unchanged after the refused placement', (await page.evaluate(() => window.__iron.tools.treasury)) === moneyBefore ? null : `treasury ${await page.evaluate(() => window.__iron.tools.treasury)}, was ${moneyBefore}`);
  }

  // Pointer path: with a tool active a left-drag draws instead of panning, Escape abandons it, and with no tool the drag pans.
  await page.evaluate(() => { window.__iron.tools.cancel(); window.__iron.tools.select('zone', { zone: 2, density: 1 }); });
  const box = await page.locator('canvas').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const cam0 = await camOf(page);
  const ev0 = await page.evaluate(() => window.__iron.tools.lastEvent);
  const moneyBeforeDrag = await page.evaluate(() => window.__iron.tools.treasury);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 90, cy + 50, { steps: 6 });
  await waitFrames(page, (await frames(page)) + 3, 5000);
  const ghost = await page.evaluate(() => window.__iron.render.ghostTiles);
  const cam1 = await camOf(page);
  add('a tool drag paints the ghost and does not pan the camera', ghost > 0 && Math.hypot(cam1.x - cam0.x, cam1.z - cam0.z) < 0.01 ? null : `ghost tiles ${ghost}, camera moved ${Math.hypot(cam1.x - cam0.x, cam1.z - cam0.z).toFixed(3)}`);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await waitFrames(page, (await frames(page)) + 2, 5000);
  const ev1 = await page.evaluate(() => window.__iron.tools.lastEvent);
  await page.waitForTimeout(400);
  add('Escape during a drag abandons it without sending a command', JSON.stringify(ev1) === JSON.stringify(ev0) && (await page.evaluate(() => window.__iron.tools.treasury)) === moneyBeforeDrag ? null : `lastEvent ${JSON.stringify(ev1)}, treasury ${await page.evaluate(() => window.__iron.tools.treasury)} was ${moneyBeforeDrag}`);
  await page.evaluate(() => window.__iron.tools.cancel());
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 90, cy + 50, { steps: 6 });
  await page.mouse.up();
  const cam2 = await camOf(page);
  add('with the tool cancelled the same drag pans the camera again', Math.hypot(cam2.x - cam1.x, cam2.z - cam1.z) > 0.5 ? null : `camera moved ${Math.hypot(cam2.x - cam1.x, cam2.z - cam1.z).toFixed(3)}`);

  // Keyboard: B selects bulldoze, Ctrl+Z undoes the road.
  await page.keyboard.press('b');
  add('the B key selects the bulldoze tool', (await page.evaluate(() => window.__iron.tools.selected?.tool)) === 'bulldoze' ? null : JSON.stringify(await page.evaluate(() => window.__iron.tools.selected)));
  await page.keyboard.press('Escape');
  add('Escape with no drag clears the tool', (await page.evaluate(() => window.__iron.tools.selected)) === null ? null : 'tool still selected');
  await page.keyboard.press('Control+z');
  const undoneByKey = await until(page, () => window.__iron.tools.undoDepth === 1, null, 10000);
  add('Ctrl+Z undoes the newest undoable action (the road)', undoneByKey ? null : `undo depth ${await page.evaluate(() => window.__iron.tools.undoDepth)}`);

  // Building while paused: the command runs at once, the building appears, and the tick does not advance.
  await page.locator('button[title="Pause (0)"]').click();
  await page.waitForTimeout(600);
  const tickPaused = await tickOf(page);
  const instBefore = await page.evaluate(() => window.__iron.render.buildings.instances);
  const moneyPaused = await page.evaluate(() => window.__iron.tools.treasury);
  const pausedId = await page.evaluate((s) => {
    const t = window.__iron.tools;
    t.select('service', { name: 'depot' });
    const at = t.tileFor('depot', { x: s.x + 11, y: s.y + 2 });
    return t.dragTiles(at, at);
  }, site);
  const pausedOk = pausedId > 0 && await until(page, (id) => { const e = window.__iron.tools.lastEvent; return !!e && e.cmd === id && e.type === 'accepted'; }, pausedId, 10000);
  add('a depot placed while paused is accepted', pausedOk ? null : `command ${pausedId}, lastEvent ${JSON.stringify(await page.evaluate(() => window.__iron.tools.lastEvent))}`);
  add('the paused depot appears in the render', await until(page, (n) => window.__iron.render.buildings.instances > n, instBefore, 10000) ? null : 'instances did not increase');
  add('the paused depot is paid for', await waitMoney(moneyPaused - DEPOT_COST) ? null : `treasury ${await page.evaluate(() => window.__iron.tools.treasury)}`);
  await page.waitForTimeout(500);
  add('the tick did not advance while paused', (await tickOf(page)) === tickPaused ? null : `tick ${tickPaused} -> ${await tickOf(page)}`);
  await page.locator('button[title="1x (1)"]').click();
  await page.close();
  return out;
}

async function buildToolChecksPhone(open, ctx) {
  const out = [];
  const add = (name, problem) => out.push([`build: ${name}`, problem]);
  const boot = await bootBuildPage(open, add);
  if (!boot) return out;
  const { page, site } = boot;

  // Real touch events through CDP: one finger draws with the tool, a second finger hands the gesture to the camera.
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([id, x, y]) => ({ id, x, y })) });
  await page.evaluate(() => window.__iron.tools.select('zone', { zone: 1, density: 0 }));
  const box = await page.locator('canvas').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const cam0 = await camOf(page);
  const ev0 = await page.evaluate(() => window.__iron.tools.lastEvent);
  await touch('touchStart', [[1, cx, cy]]);
  await touch('touchMove', [[1, cx + 60, cy + 40]]);
  await waitFrames(page, (await frames(page)) + 3, 5000);
  const ghost = await page.evaluate(() => window.__iron.render.ghostTiles);
  const cam1 = await camOf(page);
  add('one-finger drag with a tool paints the ghost and leaves the camera alone', ghost > 0 && Math.hypot(cam1.x - cam0.x, cam1.z - cam0.z) < 0.01 ? null : `ghost tiles ${ghost}, camera moved ${Math.hypot(cam1.x - cam0.x, cam1.z - cam0.z).toFixed(3)}`);
  await touch('touchStart', [[1, cx + 60, cy + 40], [2, cx - 60, cy - 40]]);
  await touch('touchMove', [[1, cx + 120, cy + 80], [2, cx - 120, cy - 80]]);
  await waitFrames(page, (await frames(page)) + 3, 5000);
  const cam2 = await camOf(page);
  await touch('touchEnd', []);
  await waitFrames(page, (await frames(page)) + 2, 5000);
  add('a second finger switches to the camera (pinch zooms in)', cam2.dist < cam1.dist ? null : `dist ${cam1.dist} -> ${cam2.dist}`);
  const ev1 = await page.evaluate(() => window.__iron.tools.lastEvent);
  add('the cancelled draw sent no command', JSON.stringify(ev0) === JSON.stringify(ev1) ? null : JSON.stringify(ev1));
  await page.evaluate(() => window.__iron.tools.cancel());

  await page.evaluate((s) => window.__iron.render.resetCamera({ x: s.x + 7, z: s.y + 7, dist: 45, pitch: 1.1 }), site);
  await waitFrames(page, (await frames(page)) + 6, 10000);
  await placeDepot(page, site, add, 'phone ');
  await page.close();
  return out;
}
// ---- end U6 block ----

// ---- U7a road graph checks (desktop, webgl2 low, sim debug mode) ----
// Two street segments meeting at a corner give one connected network; bulldozing the middle splits it and bumps graphEpoch.
async function roadGraphChecks(open) {
  const out = [];
  const add = (name, problem) => out.push([`roads: ${name}`, problem]);
  const page = await open(`${BUILD_QUERY}&debug=1`);
  const up = await until(page, () => { const r = window.__iron?.render; return !!(r && r.ready && window.__iron.tools && window.__iron.roads); }, null, 60000);
  if (!up) { add('debug session boots with __iron.roads', 'renderer, tools or roads hook never ready'); await page.close(); return out; }
  const site = await siteWhenReady(page, 14);
  if (!site) { add('a flat 14x14 land site exists near the centre', 'findSite returned null'); await page.close(); return out; }
  const A = { x: site.x + 1, y: site.y + 2 }, B = { x: site.x + 8, y: site.y + 2 }, D = { x: site.x + 8, y: site.y + 9 }, M = { x: site.x + 4, y: site.y + 2 };
  const idx = (p) => p.y * MAP + p.x;

  const none = await page.evaluate((a) => window.__iron.roads.requestPath(a, a), A);
  add('a path query on bare ground is refused with no-road', !none.ok && none.reason === 'no-road' ? null : JSON.stringify(none));

  const drag = (from, to) => page.evaluate(({ from, to }) => { const t = window.__iron.tools; t.select('road', { cls: 1 }); return t.dragTiles(from, to); }, { from, to });
  const id1 = await drag(A, B), id2 = await drag(B, D);
  const accepted = id1 > 0 && id2 > 0 && await until(page, (id) => window.__iron.tools.lastEvent?.cmd === id && window.__iron.tools.lastEvent.type === 'accepted', id2);
  const laid = await until(page, ({ a, d }) => (window.__iron.tools.peek('road', a.x, a.y) & 7) !== 0 && (window.__iron.tools.peek('road', d.x, d.y) & 7) !== 0, { a: A, d: D });
  add('two dragged street segments are accepted and reach the mirror', accepted && laid ? null : `commands ${id1}, ${id2}; accepted ${accepted}; mirror ${laid}`);

  const p1 = await page.evaluate(({ a, d }) => window.__iron.roads.requestPath(a, d), { a: A, d: D });
  const epoch0 = p1.epoch;
  add('requestPath across the turn returns a non-empty path', p1.ok && p1.tiles.length === 15 ? null : JSON.stringify(p1));
  add('the path starts at the first tile and ends at the far end', p1.ok && p1.tiles[0] === idx(A) && p1.tiles[p1.tiles.length - 1] === idx(D) ? null : `ends ${p1.tiles?.[0]} .. ${p1.tiles?.[p1.tiles.length - 1]}, want ${idx(A)} .. ${idx(D)}`);
  add('the path turns at the corner tile', p1.ok && p1.tiles.includes(idx(B)) ? null : 'corner tile missing from the path');
  add('graphEpoch is above zero after roads were laid', epoch0 > 0 ? null : `graphEpoch ${epoch0}`);

  const bd = await page.evaluate((m) => { const t = window.__iron.tools; t.select('bulldoze'); return t.dragTiles(m, m); }, M);
  const cut = bd > 0 && await until(page, (m) => (window.__iron.tools.peek('road', m.x, m.y) & 7) === 0, M);
  add('bulldozing the middle tile removes it from the mirror', cut ? null : `bulldoze command ${bd}, tile cleared ${cut}`);
  const p2 = await page.evaluate(({ a, d }) => window.__iron.roads.requestPath(a, d), { a: A, d: D });
  add('graphEpoch (read from the path reply) increases after the bulldoze', p2.epoch > epoch0 ? null : `epoch ${p2.epoch}, was ${epoch0}`);
  const statsCaught = await until(page, (e) => window.__iron.roads.graphEpoch >= e, p2.epoch, 10000);
  add('the Stats graphEpoch catches up to the path reply epoch', statsCaught ? null : `stats ${await page.evaluate(() => window.__iron.roads.graphEpoch)}, want ${p2.epoch}`);
  add('the same path query now fails as unreachable', !p2.ok && p2.reason === 'unreachable' && p2.tiles.length === 0 ? null : JSON.stringify(p2));
  const p3 = await page.evaluate(({ b, d }) => window.__iron.roads.requestPath(b, d), { b: B, d: D });
  add('the intact segment still routes', p3.ok && p3.tiles.length === 8 ? null : JSON.stringify(p3));
  await page.close();
  return out;
}
// ---- end U7a block ----

// ---- U8 economy checks (desktop, webgl2 low, sim debug mode) ----
// A small road-side city of completed buildings (4 R, 2 C, 2 I) runs at max speed through several budget months. Catalog ids:
// R low L1 = 16, C low L1 = 25, I low L1 = 34. Residents 24, jobs 20 against a labour force of 12, so R demand starts near +0.24.
async function economyChecks(open) {
  const out = [];
  const add = (name, problem) => out.push([`economy: ${name}`, problem]);
  const page = await open(`${BUILD_QUERY}&debug=1`);
  const up = await until(page, () => { const r = window.__iron?.render; return !!(r && r.ready && window.__iron.tools && window.__iron.economy); }, null, 60000);
  if (!up) { add('debug session boots with __iron.economy', 'renderer, tools or economy hook never ready'); await page.close(); return out; }
  const site = await siteWhenReady(page, 24);
  if (!site) { add('a flat 24x24 land site exists near the centre', 'findSite returned null'); await page.close(); return out; }
  const sx = site.x, sy = site.y, roadY = sy + 8;
  const accepted = (id) => until(page, (i) => window.__iron.tools.lastEvent?.cmd === i && window.__iron.tools.lastEvent.type === 'accepted', id);
  const drag = (tool, opts, from, to) => page.evaluate(({ tool, opts, from, to }) => { const t = window.__iron.tools; t.select(tool, opts); return t.dragTiles(from, to); }, { tool, opts, from, to });

  const roadId = await drag('road', { cls: 1 }, { x: sx + 1, y: roadY }, { x: sx + 20, y: roadY });
  add('a street is laid through the tools', roadId > 0 && await accepted(roadId) ? null : `command ${roadId}`);
  const zones = [[1, sx + 2, sy + 4, sx + 9, sy + 7], [2, sx + 2, sy + 10, sx + 6, sy + 12], [3, sx + 10, sy + 10, sx + 14, sy + 12]];
  let zoneOk = true;
  for (const [zone, x0, y0, x1, y1] of zones) {
    const id = await drag('zone', { zone, density: 0 }, { x: x0, y: y0 }, { x: x1, y: y1 });
    zoneOk = zoneOk && id > 0 && await accepted(id);
  }
  add('R, C and I zones are painted through the tools', zoneOk ? null : 'a zone drag was not accepted');

  const grow = (x, y, archetype) => page.evaluate((b) => window.__iron.economy.command({ type: 'debugGrow', ...b, progress: 1 }), { x, y, archetype });
  for (const dx of [2, 4, 6, 8]) await grow(sx + dx, sy + 7, 16);
  for (const dx of [3, 5]) await grow(sx + dx, sy + 9, 25);
  for (const dx of [10, 12]) await grow(sx + dx, sy + 9, 34);
  const grown = await until(page, () => (window.__iron.economy.stats?.population ?? 0) === 24 && (window.__iron.economy.stats?.jobsC ?? 0) === 8 && (window.__iron.economy.stats?.jobsI ?? 0) === 12, null, 15000);
  add('completed R, C and I buildings give population 24 and 8 + 12 jobs', grown ? null : JSON.stringify(await page.evaluate(() => { const s = window.__iron.economy.stats; return s && { population: s.population, jobsC: s.jobsC, jobsI: s.jobsI }; })));

  const settled = await until(page, () => { const s = window.__iron.economy.stats; return !!s && s.rciDemand[0] > 0.15 && s.rciDemand[0] < 0.3; }, null, 30000);
  const before = await page.evaluate(() => window.__iron.economy.stats?.rciDemand ?? null);
  add('R demand settles near +0.24 with jobs available', settled ? null : `rciDemand ${JSON.stringify(before)}`);
  const bars = await page.evaluate(() => ['R', 'C', 'I'].map((k) => Number(document.querySelector(`[data-testid="demand-${k}"]`)?.getAttribute('data-demand'))));
  add('the top bar shows three demand bars in [-1, 1]', bars.length === 3 && bars.every((v) => Number.isFinite(v) && v >= -1 && v <= 1) ? null : JSON.stringify(bars));

  await page.locator('.speeds button', { hasText: 'Max' }).click();
  const monthsRan = await until(page, () => (window.__iron.economy.stats?.month ?? 0) >= 3, null, 120000);
  const m = await page.evaluate(() => ({ month: window.__iron.economy.stats?.month, tick: window.__iron.economy.stats?.tick, treasury: window.__iron.economy.stats?.treasury }));
  add('the budget month advances at max speed', monthsRan ? null : `month ${m.month} at tick ${m.tick}`);
  if (!monthsRan) { await page.close(); return out; }

  const all = await page.evaluate(() => window.__iron.economy.samples.map((s) => ({ month: s.month, treasury: s.treasury, net: s.lastMonth.net, demand: s.rciDemand, population: s.population })));
  add('population is above zero', all.some((s) => s.population > 0) ? null : 'population never rose');
  add('every sampled demand stays within [-1, 1]', all.every((s) => s.demand.every((d) => d >= -1 && d <= 1)) ? null : 'a demand left the range');
  let pair = null;
  for (let i = 1; i < all.length && !pair; i++) if (all[i].month === all[i - 1].month + 1 && all[i - 1].month >= 0) pair = [all[i - 1], all[i]];
  add('treasury moved by exactly the closed month net across a month boundary', pair && pair[1].treasury - pair[0].treasury === pair[1].net ? null : `pair ${JSON.stringify(pair)}`);
  const budget = await page.evaluate(() => window.__iron.economy.requestBudget());
  const rec = pair && budget.history.find((r) => r.month === pair[0].month);
  add('requestBudget history carries that same month net', rec && rec.net === pair[1].net && rec.treasury === pair[1].treasury ? null : `record ${JSON.stringify(rec)}, pair ${JSON.stringify(pair)}`);
  add('the budget has income and expenses, and the projected month is present', budget.history.length >= 2 && budget.history[0].income > 0 && budget.history[0].roads > 0 && budget.current.expenses > 0 ? null : JSON.stringify(budget.history[0]));
  add('the top bar shows the monthly net', (await page.locator('[data-testid="monthly-net"]').textContent())?.includes('/mo') ? null : 'monthly net missing');

  const coin = page.getByRole('button', { name: 'Budget', exact: true });
  const coinBox = await coin.boundingBox();
  add('the budget button is a 44px touch target', coinBox && coinBox.width >= 44 && coinBox.height >= 44 ? null : JSON.stringify(coinBox));
  await coin.click();
  const open2 = await until(page, () => !!document.querySelector('[data-testid="budget"]') && document.querySelectorAll('[data-testid="budget-row"]').length === 12, null, 10000);
  add('the Budget panel opens with a 12-row month table', open2 ? null : 'panel or rows missing');
  const filled = await until(page, () => [...document.querySelectorAll('[data-testid="budget-row"]')].filter((r) => r.querySelector('td')?.textContent !== '-').length >= 2, null, 10000);
  add('the table lists the closed months', filled ? null : 'fewer than two filled rows');
  add('the chart is labelled for assistive tech', /Income and expenses/.test((await page.locator('[data-testid="budget-chart"]').getAttribute('aria-label')) ?? '') ? null : 'chart aria-label missing');
  const slider = page.locator('[data-testid="tax-R"]');
  const sliderBox = await slider.boundingBox();
  add('the tax slider is at least 44px tall', sliderBox && sliderBox.height >= 44 ? null : JSON.stringify(sliderBox));

  const m0 = await page.evaluate(() => window.__iron.economy.stats.month);
  const dBefore = await page.evaluate(() => window.__iron.economy.stats.rciDemand[0]);
  await slider.focus();
  await page.keyboard.press('End');
  const taxed = await until(page, () => window.__iron.economy.stats?.taxRates[0] === 20, null, 10000);
  add('the R tax slider sets the rate to 20% in the sim', taxed ? null : `taxRates ${JSON.stringify(await page.evaluate(() => window.__iron.economy.stats?.taxRates))}`);
  const next = await until(page, (mm) => (window.__iron.economy.stats?.month ?? 0) >= mm + 2, m0, 120000);
  const dAfter = await page.evaluate(() => window.__iron.economy.stats.rciDemand[0]);
  add('R demand decreases over the next months after the tax rise', next && dAfter < dBefore - 0.1 ? null : `before ${dBefore}, after ${dAfter}, month ${m0} -> ${await page.evaluate(() => window.__iron.economy.stats.month)}`);
  add('the month projection reflects the new rate', (await page.evaluate(() => window.__iron.economy.requestBudget())).taxRates[0] === 20 ? null : 'taxRates not 20');
  await page.keyboard.press('Escape');
  add('Escape closes the Budget panel', await until(page, () => !document.querySelector('[data-testid="budget"]'), null, 5000) ? null : 'panel still open');
  await page.close();
  return out;
}
// ---- end U8 block ----

// ---- U9 utilities checks (desktop, webgl2 low, sim debug mode) ----
// A plant, a power line with houses along it and a pump with a pipe, all placed through __iron.tools. Houses are R low L1 (catalog id 16).
// Cutting the line must darken exactly the houses beyond the cut; the overlay modes must each paint a different terrain texture;
// the underground view must show the pipe and hide the buildings.
async function utilitiesChecks(open) {
  const out = [];
  const add = (name, problem) => out.push([`utilities: ${name}`, problem]);
  const page = await open(`${BUILD_QUERY}&debug=1`);
  const up = await until(page, () => { const r = window.__iron?.render; return !!(r && r.ready && window.__iron.tools && window.__iron.economy); }, null, 60000);
  if (!up) { add('debug session boots with tools and economy hooks', 'renderer, tools or economy hook never ready'); await page.close(); return out; }
  const site = await siteWhenReady(page, 24);
  if (!site) { add('a flat 24x24 land site exists near the centre', 'findSite returned null'); await page.close(); return out; }
  const sx = site.x, sy = site.y;
  await page.evaluate((s) => window.__iron.render.resetCamera({ x: s.x + 12, z: s.y + 8, dist: 36, pitch: 0.95, yaw: 0.35 }), site);
  const accepted = (id) => until(page, (i) => window.__iron.tools.lastEvent?.cmd === i && window.__iron.tools.lastEvent.type === 'accepted', id);
  const sel = (tool, opts) => page.evaluate(({ tool, opts }) => window.__iron.tools.select(tool, opts), { tool, opts });
  const drag = (from, to) => page.evaluate(({ from, to }) => window.__iron.tools.dragTiles(from, to), { from, to });
  const placeBuilding = async (name, x, y) => {
    await sel('service', { name });
    const t = await page.evaluate(({ name, x, y }) => window.__iron.tools.tileFor(name, { x, y }), { name, x, y });
    return drag(t, t);
  };
  const houses = () => page.evaluate(() => window.__iron.tools.buildings().filter((b) => b.arch === 16).map((b) => ({ x: b.x, y: b.y, powered: b.powered, watered: b.watered })).sort((a, b) => a.x - b.x));
  const darkXs = (h) => h.filter((b) => !b.powered).map((b) => b.x - sx);
  const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  const plantId = await placeBuilding('powerPlant', sx + 1, sy + 1);
  add('a power plant is placed through the tools and accepted', plantId > 0 && await accepted(plantId) ? null : `command ${plantId}`);
  await sel('line', { kind: 'power' });
  const lineId = await drag({ x: sx + 5, y: sy + 3 }, { x: sx + 21, y: sy + 3 });
  add('a power line is dragged from the plant to the far end and accepted', lineId > 0 && await accepted(lineId) ? null : `command ${lineId}`);
  const grow = (x, y) => page.evaluate((b) => window.__iron.economy.command({ type: 'debugGrow', ...b, progress: 1 }), { x, y, archetype: 16 });
  for (const [dx, dy] of [[5, 1], [8, 4], [12, 4], [17, 4], [21, 4]]) await grow(sx + dx, sy + dy);
  const lit = await until(page, () => { const h = window.__iron.tools.buildings().filter((b) => b.arch === 16); return h.length === 5 && h.every((b) => b.powered); }, null, 30000);
  add('houses beside the plant and along the line all report powered', lit ? null : JSON.stringify(await houses()));
  const stat = await until(page, () => { const s = window.__iron.economy.stats; return !!s && s.power.supply === 120 && s.power.demand === 5; }, null, 15000);
  add('Stats carry the power supply (120 MW plant) and demand (5 houses at 1 MW)', stat ? null : JSON.stringify(await page.evaluate(() => window.__iron.economy.stats?.power)));
  const hud = await until(page, () => { const e = document.querySelector('[data-testid="util-power"]'); return !!e && e.getAttribute('data-supply') === '120' && e.getAttribute('data-demand') === '5'; }, null, 15000);
  add('the HUD power bar shows 120 supplied of 5 needed', hud ? null : await page.evaluate(() => document.querySelector('[data-testid="utilities"]')?.outerHTML ?? 'no utility bars'));

  const lines = await until(page, () => window.__iron.render.lines.pylons > 0 && window.__iron.render.lines.spans > 0, null, 20000);
  const gl = await page.evaluate(() => ({ ...window.__iron.render.lines, dc: window.__iron.render.drawCalls, budget: window.__iron.render.drawCallBudget }));
  add('pylons and cable spans are built for the line, within the draw-call budget', lines && gl.pylons >= 6 && gl.dc <= gl.budget ? null : JSON.stringify(gl));

  const pumpId = await placeBuilding('waterPump', sx + 1, sy + 6);
  await sel('line', { kind: 'water' });
  const pipeId = await drag({ x: sx + 3, y: sy + 6 }, { x: sx + 21, y: sy + 6 });
  add('a water pump and a pipe are placed through the tools and accepted', pumpId > 0 && pipeId > 0 && await accepted(pipeId) ? null : `pump ${pumpId}, pipe ${pipeId}`);
  const wet = await until(page, () => { const h = window.__iron.tools.buildings().filter((b) => b.arch === 16); return h.length === 5 && h.filter((b) => b.watered).length === 4; }, null, 30000);
  add('the four houses within reach of the pipe are watered, the one five tiles away is not', wet ? null : JSON.stringify(await houses()));

  await sel('bulldoze');
  const cutId = await drag({ x: sx + 14, y: sy + 3 }, { x: sx + 14, y: sy + 3 });
  await page.evaluate(() => window.__iron.tools.cancel());
  const cut = await until(page, ({ x, y }) => window.__iron.tools.peek('ugPower', x, y) === 0, { x: sx + 14, y: sy + 3 }, 15000);
  add('bulldozing one line tile removes it from the mirror', cutId > 0 && cut ? null : `command ${cutId}, tile cleared ${cut}`);
  const dark = await until(page, (x0) => { const h = window.__iron.tools.buildings().filter((b) => b.arch === 16); return h.length === 5 && h.filter((b) => !b.powered).length === 2 && h.every((b) => (b.x - x0 >= 17) === !b.powered); }, sx, 30000);
  const h1 = await houses();
  add('exactly the two houses beyond the cut go unpowered; the three upstream stay lit', dark && sameList(darkXs(h1), [17, 21]) ? null : JSON.stringify(h1));
  const icons = await until(page, () => window.__iron.render.outageIcons >= 2, null, 15000);
  add('outage icons are drawn for the dark houses', icons ? null : `icons ${await page.evaluate(() => window.__iron.render.outageIcons)}`);
  const warn = await until(page, () => /2 without power/.test(document.querySelector('[data-testid="util-warn"]')?.textContent ?? ''), null, 15000);
  add('the HUD warns "2 without power"', warn ? null : await page.evaluate(() => document.querySelector('[data-testid="utilities"]')?.textContent ?? 'no utility bars'));

  await sel('line', { kind: 'power' });
  const fixId = await drag({ x: sx + 14, y: sy + 3 }, { x: sx + 14, y: sy + 3 });
  await page.evaluate(() => window.__iron.tools.cancel());
  const healed = await until(page, () => window.__iron.tools.buildings().filter((b) => b.arch === 16).every((b) => b.powered), null, 30000);
  add('relaying the cut tile restores power to every house', fixId > 0 && healed ? null : JSON.stringify(await houses()));

  // Overlay modes: each paints a different terrain texture (the page checksum), and the power overlay follows an edit within ~1 s.
  await page.locator('.speeds button', { hasText: 'Max' }).click();
  await until(page, () => (window.__iron.economy.stats?.tick ?? 0) > 400, null, 60000);
  const sums = {};
  let modeProblem = null;
  for (const m of ['none', 'power', 'water', 'landValue', 'pollution']) {
    await page.click(`[data-testid="overlay-${m}"]`);
    const ok = await until(page, (mm) => window.__iron.render.overlay.mode === mm, m, 10000);
    if (m === 'pollution') await until(page, (s) => window.__iron.render.overlay.checksum !== s, sums.none, 20000);
    sums[m] = await page.evaluate(() => window.__iron.render.overlay.checksum);
    if (!ok) modeProblem = `mode ${m} never applied`;
  }
  add('each overlay button switches the render overlay mode', modeProblem);
  add('none, power, water, land value and pollution paint five different overlay textures', new Set(Object.values(sums)).size === 5 ? null : JSON.stringify(sums));
  const pressed = await page.evaluate(() => document.querySelector('[data-testid="overlay-pollution"]').getAttribute('aria-pressed'));
  add('the selected overlay button is marked pressed', pressed === 'true' ? null : `aria-pressed ${pressed}`);
  await page.click('[data-testid="overlay-power"]');
  await until(page, () => window.__iron.render.overlay.mode === 'power', null, 5000);
  const before = await page.evaluate(() => window.__iron.render.overlay.checksum);
  await sel('bulldoze');
  await drag({ x: sx + 10, y: sy + 3 }, { x: sx + 10, y: sy + 3 });
  await page.evaluate(() => window.__iron.tools.cancel());
  const moved = await until(page, (b) => window.__iron.render.overlay.checksum !== b, before, 20000);
  add('the power overlay repaints after another line tile is cut', moved ? null : 'checksum unchanged');
  await page.click('[data-testid="overlay-none"]');

  // Underground view.
  await page.click('[data-testid="underground"]');
  const under = await until(page, () => { const u = window.__iron.render.underground; return u.on && u.cutaway && u.buildingsHidden && u.pipeSegments > 0 && u.pipeDraws > 0; }, null, 20000);
  add('the underground view cuts the terrain away, hides buildings and shows the pipe tubes', under ? null : JSON.stringify(await page.evaluate(() => window.__iron.render.underground)));
  const ugOverlay = await page.evaluate(() => window.__iron.render.overlay.mode);
  add('the underground view paints the water coverage tint', (await until(page, () => window.__iron.render.overlay.mode === 'water', null, 10000)) ? null : `overlay mode ${ugOverlay}`);
  await sel('bulldoze');
  const digId = await drag({ x: sx + 10, y: sy + 6 }, { x: sx + 10, y: sy + 6 });
  await page.evaluate(() => window.__iron.tools.cancel());
  const dug = await until(page, ({ x, y }) => window.__iron.tools.peek('ugWater', x, y) === 0 && window.__iron.tools.peek('ugWater', x + 1, y) === 1, { x: sx + 10, y: sy + 6 }, 15000);
  add('bulldozing underground digs up only that pipe tile', digId > 0 && dug ? null : `command ${digId}, dug ${dug}`);
  await page.click('[data-testid="underground"]');
  const surface = await until(page, () => { const u = window.__iron.render.underground; return !u.on && !u.cutaway && !u.buildingsHidden; }, null, 10000);
  add('leaving the underground view brings the surface back', surface ? null : JSON.stringify(await page.evaluate(() => window.__iron.render.underground)));
  await page.close();
  return out;
}
// ---- end U9 block ----

// ---- U7 robot workforce checks (webgl2 low; desktop and one phone leg) ----
// The key acceptance: no debug growth. A depot, a street grid and R/C/I zones placed through the build tools turn into
// buildings built by robots, which the page reports through __iron.sim.workforce and __iron.render.robots.
const ROBOT_QUERY = '?autostart=1&seed=42&backend=webgl2&tier=low&governor=off';
const ROBOT_LIMIT_MS = 150000;

async function workforceChecks(open, phone) {
  const out = [];
  const label = phone ? 'phone ' : '';
  const add = (name, problem) => out.push([`robots: ${label}${name}`, problem]);
  const page = await open(ROBOT_QUERY);
  const up = await until(page, () => { const r = window.__iron?.render; return !!(r && r.ready && r.drawCalls > 0 && window.__iron.tools); }, null, 120000);
  if (!up) { add('city boots with tools', 'renderer or __iron.tools never ready'); await page.close(); return out; }
  // The mirror's first Resync can land a moment after the renderer reports ready, so wait for a site instead of asking once.
  const site = await siteWhenReady(page, 14);
  if (!site) { add('a flat 14x14 land site exists', 'findSite returned null'); await page.close(); return out; }
  await page.evaluate((s) => window.__iron.render.resetCamera({ x: s.x + 6, z: s.y + 7, dist: 24, pitch: 0.75, yaw: 0.5 }), site);

  // Depot beside a street, a second street, and residential, commercial and industrial zones between and below them.
  const laid = await page.evaluate((s) => {
    const t = window.__iron.tools;
    const sent = [];
    const drag = (tool, opts, a, b) => { t.select(tool, opts); sent.push(t.dragTiles(a, b)); };
    drag('service', { name: 'depot' }, t.tileFor('depot', { x: s.x + 2, y: s.y + 2 }), t.tileFor('depot', { x: s.x + 2, y: s.y + 2 }));
    drag('road', { cls: 1 }, { x: s.x + 1, y: s.y + 4 }, { x: s.x + 12, y: s.y + 4 });
    drag('road', { cls: 1 }, { x: s.x + 1, y: s.y + 9 }, { x: s.x + 12, y: s.y + 9 });
    drag('road', { cls: 1 }, { x: s.x + 1, y: s.y + 4 }, { x: s.x + 1, y: s.y + 9 });
    drag('zone', { zone: 1, density: 0 }, { x: s.x + 2, y: s.y + 5 }, { x: s.x + 6, y: s.y + 8 });
    drag('zone', { zone: 2, density: 0 }, { x: s.x + 7, y: s.y + 5 }, { x: s.x + 11, y: s.y + 8 });
    drag('zone', { zone: 3, density: 0 }, { x: s.x + 2, y: s.y + 10 }, { x: s.x + 11, y: s.y + 12 });
    t.cancel();
    return sent;
  }, site);
  add('depot, roads and R/C/I zones sent through tools.dragTiles', laid.every((id) => id > 0) ? null : `command ids ${JSON.stringify(laid)}`);
  if (!laid.every((id) => id > 0)) { await page.close(); return out; }

  await page.getByRole('button', { name: 'Max' }).click();
  const t0 = Date.now();
  const sawRobots = await until(page, () => { const w = window.__iron.sim.workforce; return !!w && w.builders > 0 && w.haulers > 0; }, null, ROBOT_LIMIT_MS);
  const w1 = await page.evaluate(() => ({ ...window.__iron.sim.workforce }));
  add('the depot builds robots (sim workforce builders and haulers > 0)', sawRobots ? null : `workforce ${JSON.stringify(w1)}`);
  const drawn = await until(page, () => { const r = window.__iron.render.robots; return r.visible > 0 && r.builders + r.haulers > 0; }, null, ROBOT_LIMIT_MS);
  add('robots are drawn (__iron.render.robots.visible > 0)', drawn ? null : JSON.stringify(await page.evaluate(() => ({ ...window.__iron.render.robots }))));
  const job = await until(page, () => window.__iron.sim.workforce?.jobs > 0 && window.__iron.render.buildings.sites > 0, null, ROBOT_LIMIT_MS);
  add('a construction job starts and its site (foundation, scaffold) is instanced', job ? null : JSON.stringify(await page.evaluate(() => ({ w: window.__iron.sim.workforce, b: { ...window.__iron.render.buildings } }))));
  const hud = (await page.locator('[data-testid="workforce"]').innerText().catch(() => '')).replace(/\s+/g, ' ');
  add('the HUD shows the workforce readout', /Builders \d+\/\d+/.test(hud) && /Haulers \d+\/\d+/.test(hud) && /Jobs \d+/.test(hud) && /Material \d+/.test(hud) ? null : JSON.stringify(hud));

  // Follow a robot: the button toggles the chase camera, the camera moves with the robot, Escape (desktop) or a tap (phone) ends it.
  const active = await until(page, () => window.__iron.render.robots.visible > 0, null, ROBOT_LIMIT_MS);
  if (active) {
    // At Max the whole district finishes in a moment; 2x keeps robots working while the camera follows one.
    await page.getByRole('button', { name: '2x' }).click();
    await page.getByRole('button', { name: 'Follow a robot' }).click();
    const on = await until(page, () => window.__iron.render.following === true, null, 5000);
    add('Follow a robot starts the chase camera', on ? null : 'render.following never became true');
    if (on) {
      const a = await camOf(page);
      await page.waitForTimeout(1500);
      const b = await camOf(page);
      const moved = Math.hypot(b.x - a.x, b.z - a.z) + Math.abs(b.yaw - a.yaw);
      add('the camera moves with the robot at street level', b.dist < 4 && moved > 0.02 ? null : `dist ${b.dist}, moved ${moved.toFixed(4)}`);
      if (phone) {
        const box = await page.locator('canvas').boundingBox();
        await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      } else await page.keyboard.press('Escape');
      const off = await until(page, () => window.__iron.render.following === false, null, 5000);
      add(`${phone ? 'a tap' : 'Escape'} ends the follow camera`, off ? null : 'render.following stayed true');
    }
  } else add('Follow a robot starts the chase camera', 'no robot was drawn to follow');

  const built = await until(page, () => (window.__iron.sim.population ?? 0) > 0 || (window.__iron.sim.jobs ?? 0) > 0, null, ROBOT_LIMIT_MS);
  const end = await page.evaluate(() => ({ pop: window.__iron.sim.population, jobs: window.__iron.sim.jobs, w: window.__iron.sim.workforce, b: { ...window.__iron.render.buildings }, r: { ...window.__iron.render.robots }, tick: window.__iron.sim.tick }));
  console.log(`         ${label}robots: first completion after ${((Date.now() - t0) / 1000).toFixed(1)} s wall time, sim tick ${end.tick}, ${JSON.stringify(end.w)}, buildings ${JSON.stringify(end.b)}`);
  add('road + zone -> a building is completed by robots (population or jobs > 0)', built ? null : JSON.stringify(end));
  const sites = await until(page, () => window.__iron.render.buildings.instances + window.__iron.render.buildings.farInstances >= 2, null, 30000);
  add('finished buildings are instanced beside the depot', sites ? null : JSON.stringify(end.b));
  if (!phone) {
    await page.getByRole('button', { name: '1x' }).click();
    const sparks = await page.evaluate(() => window.__iron.render.robots.sparks);
    add('welding sparks were emitted at active sites', sparks > 0 ? null : `sparks ${sparks}`);
    out.push(...await disasterChecks(page, site));
  }
  await page.close();
  return out;
}
// ---- end U7 block ----

// ---- U12 disasters (runs on the finished U7 city, desktop only) ----
// The sandbox menu path (tools.disaster) goes through the same triggerDisaster command the HUD button sends.
async function disasterChecks(page, site) {
  const out = [];
  const add = (name, problem) => out.push([`disasters: ${name}`, problem]);
  const cx = site.x + 6, cy = site.y + 7;
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Settings' }).click();
  const sel = page.locator('[data-testid="disasters-setting"]');
  const was = await sel.inputValue().catch(() => '');
  await sel.selectOption('normal');
  const now = await sel.inputValue().catch(() => '');
  add('the Settings menu has a Disasters choice (Off / Rare / Normal), Rare by default', was === 'rare' && now === 'normal' ? null : `was ${was}, now ${now}`);
  await sel.selectOption('off');
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Trigger disaster...' }).click();
  const hasTriggers = (await page.locator('[data-testid="trigger-fire"], [data-testid="trigger-quake"], [data-testid="trigger-meteor"]').count()) === 3;
  add('the menu offers Fire, Earthquake and Meteor in the sandbox', hasTriggers ? null : 'trigger buttons missing');
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Close' }).click();

  await page.evaluate(({ x, y }) => window.__iron.tools.disaster('quake', x, y), { x: cx, y: cy });
  const shook = await until(page, () => window.__iron.render.fx.disasters.quakes >= 1, null, 20000);
  add('a sandbox earthquake reaches the renderer (camera shake effect) even with disasters set to Off', shook ? null : JSON.stringify(await page.evaluate(() => window.__iron.render.fx.disasters)));
  const quakeToast = await until(page, () => window.__iron.tools.toasts.includes('Earthquake!'), null, 10000);
  add('an "Earthquake!" toast appears', quakeToast ? null : JSON.stringify(await page.evaluate(() => window.__iron.tools.toasts)));
  const jumpBtn = page.locator('[data-testid="toast-jump"]').first();
  const toastWithJump = await jumpBtn.waitFor({ timeout: 5000 }).then(() => true, () => false);
  add('the toast has a "Jump to" button', toastWithJump ? null : 'no toast-jump button');
  if (toastWithJump) {
    await page.evaluate(() => window.__iron.render.resetCamera({ x: 5, z: 5, dist: 120 }));
    await jumpBtn.click();
    const cam = await camOf(page);
    add('Jump to flies the camera to the disaster', Math.hypot(cam.x - (cx + 0.5), cam.z - (cy + 0.5)) < 14 && cam.dist < 60 ? null : JSON.stringify(cam));
  }

  const before = await page.evaluate(({ x, y }) => window.__iron.tools.peek('height', x, y), { x: cx, y: cy });
  await page.evaluate(({ x, y }) => window.__iron.tools.disaster('meteor', x, y), { x: cx, y: cy });
  const landed = await until(page, () => window.__iron.render.fx.disasters.impacts >= 1, null, 30000);
  add('a meteor lands: streak, impact flash and shockwave are handled by the renderer', landed ? null : JSON.stringify(await page.evaluate(() => window.__iron.render.fx.disasters)));
  const crater = await until(page, ({ x, y, h }) => window.__iron.tools.peek('height', x, y) < h - 8, { x: cx, y: cy, h: before }, 10000);
  add('the impact lowers the terrain at the crater centre in the render mirror', crater ? null : `height ${before} -> ${await page.evaluate(({ x, y }) => window.__iron.tools.peek('height', x, y), { x: cx, y: cy })}`);
  return out;
}
// ---- end U12 block ----

const RENDER_LEGS = {
  desktop: [{ backend: 'webgl2', interact: true, loseDevice: true, fx: true, rain: true }, { backend: 'webgpu', showcaseTier: 'high', fx: true }],
  phone: [{ backend: 'webgl2' }],
};

const browser = await chromium.launch({ ...(existsSync(CHROMIUM) ? { executablePath: CHROMIUM } : {}), args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-vulkan=swiftshader', '--enable-features=Vulkan'] });
let failed = 0;
// SMOKE_ONLY=robots runs just the U7 workforce block, for iterating on it; the acceptance run leaves it unset.
const only = process.env.SMOKE_ONLY === 'robots';
// SMOKE_QUICK=1 (npm run smoke:quick) is the per-unit gate: desktop WebGL2 boot, render and the robots build loop.
// The full run (every viewport, backend, showcase, fx and feature block) is kept for the gate before publishing.
const quick = process.env.SMOKE_QUICK === '1';
try {
  for (const vp of quick ? VIEWPORTS.filter((v) => v.name === 'desktop') : VIEWPORTS) {
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
    for (const [name, check] of only ? [] : CHECKS) {
      const problem = await check(page, open);
      console.log(`${vp.name.padEnd(8)} ${problem ? 'FAIL' : 'ok  '} ${name}${problem ? `: ${problem}` : ''}`);
      if (problem) failed++;
    }
    const legs = only ? [] : quick ? [{ backend: 'webgl2' }] : RENDER_LEGS[vp.name] ?? [];
    for (const leg of legs) {
      const p = await open(RENDER_QUERY(leg.backend));
      for (const [name, problem] of await renderChecks(p, leg.backend, { ...leg, shots: process.env.SMOKE_SHOTS ? `${process.env.SMOKE_SHOTS}-${vp.name}` : undefined })) {
        console.log(`${vp.name.padEnd(8)} ${problem ? 'FAIL' : 'ok  '} ${name}${problem ? `: ${problem}` : ''}`);
        if (problem) failed++;
      }
      if (quick) { await p.close(); continue; }
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
    if (vp.name === 'desktop' && !only && !quick) {
      for (const [name, problem] of await persistenceChecks(open)) {
        console.log(`${vp.name.padEnd(8)} ${problem ? 'FAIL' : 'ok  '} ${name}${problem ? `: ${problem}` : ''}`);
        if (problem) failed++;
      }
    }
    const full = !only && !quick;
    const buildChecks = !full ? [] : vp.name === 'desktop' ? await buildToolChecksDesktop(open) : await buildToolChecksPhone(open, ctx);
    if (vp.name === 'desktop' && full) buildChecks.push(...await roadGraphChecks(open));
    if (vp.name === 'desktop' && full) buildChecks.push(...await economyChecks(open));
    if (vp.name === 'desktop' && full) buildChecks.push(...await utilitiesChecks(open));
    buildChecks.push(...await workforceChecks(open, vp.name === 'phone'));
    for (const [name, problem] of buildChecks) {
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
