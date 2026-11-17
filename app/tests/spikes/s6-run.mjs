// Driver spike S6 — Service Worker cache media opaque + Range.
// Dijalankan: node tests/spikes/s6-run.mjs [url-googlevideo-opsional]
// Prasyarat: s6-server.mjs jalan (port 4180/4181), relay CONNECT jalan.
import { chromium } from 'playwright-core';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const APP_ORIGIN = 'http://127.0.0.1:4180/';
const MEDIA_URL = 'http://127.0.0.1:4181/test-60s.wav';
const GV_URL = process.argv[2] || (existsSync('/tmp/gv251.txt') ? readFileSync('/tmp/gv251.txt', 'utf8').trim() : '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(page, fn, timeoutMs, label) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    last = await page.evaluate(fn);
    if (last) return { ok: true, ms: Date.now() - t0, value: last };
    await sleep(250);
  }
  return { ok: false, ms: Date.now() - t0, label, value: last };
}

const browser = await chromium.launch({
  proxy: { server: 'http://127.0.0.1:18081', bypass: 'localhost,127.0.0.1' },
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();
const errors = [];
const netLog = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('requestfailed', (r) => netLog.push({ url: r.url().slice(0, 120), failure: r.failure()?.errorText ?? null }));
page.on('response', (r) => {
  if (r.url().includes('googlevideo')) netLog.push({ url: r.url().slice(0, 120), status: r.status() });
});

await page.goto(APP_ORIGIN, { waitUntil: 'domcontentloaded' });
const reg = await page.evaluate(() => window.__s6.registerSw());
console.log('SW terdaftar:', JSON.stringify(reg));

const out = { at: new Date().toISOString(), sw: reg, tests: {}, errors };

// ---------- Tes A: file lokal lintas origin (tanpa CORS) ----------
console.log('\n== Tes A: WAV lokal lintas origin ==');
await page.evaluate(() => window.__s6.clearCache());
const a1 = { url: MEDIA_URL };
await page.evaluate((u) => window.__s6.playUrl(u), MEDIA_URL);
a1.playOnline = await waitFor(page, () => {
  const s = window.__s6.audioState();
  return s.currentTime > 2 ? s : null;
}, 30000, 'putar online sampai 2 dtk');
await sleep(3000); // beri waktu cache terisi
a1.stateAfterOnline = await page.evaluate(() => window.__s6.audioState());
a1.cacheAfterOnline = await page.evaluate(() => window.__s6.inspectCache());
await page.evaluate(() => window.__s6.pause());

await context.setOffline(true);
console.log('mode offline aktif (konteks browser)');
await page.evaluate((u) => window.__s6.playUrl(u), MEDIA_URL);
a1.playOffline = await waitFor(page, () => {
  const s = window.__s6.audioState();
  return s.currentTime > 1 ? s : null;
}, 30000, 'putar offline dari cache');
a1.seek30 = null;
if (a1.playOffline.ok) {
  await page.evaluate(() => window.__s6.seekTo(30));
  a1.seek30 = await waitFor(page, () => {
    const s = window.__s6.audioState();
    return s.currentTime > 31 ? s : null;
  }, 20000, 'seek offline ke 30 dtk lalu lanjut');
}
a1.seek55 = null;
if (a1.seek30 && a1.seek30.ok) {
  await page.evaluate(() => window.__s6.seekTo(55));
  a1.seek55 = await waitFor(page, () => {
    const s = window.__s6.audioState();
    return s.currentTime > 56 ? s : null;
  }, 20000, 'seek offline ke 55 dtk lalu lanjut');
}
a1.stateOfflineEnd = await page.evaluate(() => window.__s6.audioState());
await page.evaluate(() => window.__s6.pause());
await context.setOffline(false);
out.tests.A_lokal = a1;
console.log(JSON.stringify(a1, null, 2));

// ---------- Tes B0 (kontrol): googlevideo TANPA Service Worker ----------
// Konteks baru = storage terpisah = tanpa SW. Menjawab: apakah <audio>
// memang bisa memutar googlevideo di browser VM ini?
if (GV_URL) {
  console.log('\n== Tes B0 (kontrol): googlevideo tanpa SW ==');
  const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
  const page2 = await ctx2.newPage();
  const net2 = [];
  page2.on('requestfailed', (r) => net2.push({ url: r.url().slice(0, 120), failure: r.failure()?.errorText ?? null }));
  page2.on('response', (r) => {
    if (r.url().includes('googlevideo')) net2.push({ url: r.url().slice(0, 120), status: r.status() });
  });
  await page2.goto(APP_ORIGIN, { waitUntil: 'domcontentloaded' });
  const b0 = {};
  b0.playResult = await page2.evaluate((u) => window.__s6.playUrl(u), GV_URL);
  b0.playOnline = await waitFor(page2, () => {
    const s = window.__s6.audioState();
    return s.currentTime > 2 ? s : null;
  }, 60000, 'putar googlevideo tanpa SW sampai 2 dtk');
  await sleep(3000);
  b0.stateAfter = await page2.evaluate(() => window.__s6.audioState());
  b0.net = net2;
  out.tests.B0_googlevideo_tanpa_sw = b0;
  console.log(JSON.stringify(b0, null, 2));
  await ctx2.close();
}

// ---------- Tes B: URL googlevideo asli ----------
if (GV_URL) {
  console.log('\n== Tes B: googlevideo asli (itag 251) ==');
  const b = { urlHost: GV_URL.split('/')[2] };
  await page.evaluate(() => window.__s6.clearCache());
  b.playResult = await page.evaluate((u) => window.__s6.playUrl(u), GV_URL);
  b.playOnline = await waitFor(page, () => {
    const s = window.__s6.audioState();
    return s.currentTime > 2 ? s : null;
  }, 60000, 'putar googlevideo online sampai 2 dtk');
  await sleep(5000);
  b.stateAfterOnline = await page.evaluate(() => window.__s6.audioState());
  b.cacheAfterOnline = await page.evaluate(() => window.__s6.inspectCache());
  await page.evaluate(() => window.__s6.pause());

  await context.setOffline(true);
  await page.evaluate((u) => window.__s6.playUrl(u), GV_URL);
  b.playOffline = await waitFor(page, () => {
    const s = window.__s6.audioState();
    return s.currentTime > 1 ? s : null;
  }, 30000, 'putar googlevideo offline dari cache');
  b.seek20 = null;
  if (b.playOffline.ok) {
    await page.evaluate(() => window.__s6.seekTo(20));
    b.seek20 = await waitFor(page, () => {
      const s = window.__s6.audioState();
      return s.currentTime > 21 ? s : null;
    }, 20000, 'seek offline ke 20 dtk lalu lanjut');
  }
  b.stateOfflineEnd = await page.evaluate(() => window.__s6.audioState());
  await page.evaluate(() => window.__s6.pause());
  await context.setOffline(false);
  out.tests.B_googlevideo = b;
  console.log(JSON.stringify(b, null, 2));
} else {
  out.tests.B_googlevideo = { skipped: 'tidak ada URL googlevideo' };
}

await browser.close();
out.netLog = netLog;
out.errors = errors;
writeFileSync(new URL('./s6-result.json', import.meta.url), JSON.stringify(out, null, 2));
console.log('\ntersimpan: tests/spikes/s6-result.json');
console.log('page errors:', JSON.stringify(errors));
console.log('net log:', JSON.stringify(netLog));
