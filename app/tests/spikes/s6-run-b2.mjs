// Driver Tes B2 — googlevideo asli lewat SW varian VM (Range dibatasi 1 MiB).
// Dijalankan: node tests/spikes/s6-run-b2.mjs
import { chromium } from 'playwright-core';
import { writeFileSync, readFileSync } from 'node:fs';

const PAGE = 'http://127.0.0.1:4180/s6-page-vm.html';
const GV_URL = readFileSync('/tmp/gv251.txt', 'utf8').trim();
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
const netLog = [];
page.on('requestfailed', (r) => netLog.push({ url: r.url().slice(0, 100), failure: r.failure()?.errorText ?? null }));
page.on('response', (r) => {
  if (r.url().includes('googlevideo')) netLog.push({ url: r.url().slice(0, 100), status: r.status() });
});

await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
const reg = await page.evaluate(() => window.__s6.registerSw());
console.log('SW VM terdaftar:', JSON.stringify(reg));
await page.evaluate(() => window.__s6.clearCache());

const out = { at: new Date().toISOString(), sw: reg, urlHost: GV_URL.split('/')[2] };
out.playResult = await page.evaluate((u) => window.__s6.playUrl(u), GV_URL);
out.playOnline = await waitFor(page, () => {
  const s = window.__s6.audioState();
  return s.currentTime > 2 ? s : null;
}, 90000, 'putar googlevideo online sampai 2 dtk');
await sleep(5000);
out.stateAfterOnline = await page.evaluate(() => window.__s6.audioState());
out.cacheAfterOnline = await page.evaluate(() => window.__s6.inspectCache());
await page.evaluate(() => window.__s6.pause());

await context.setOffline(true);
console.log('mode offline aktif');
await page.evaluate((u) => window.__s6.playUrl(u), GV_URL);
out.playOffline = await waitFor(page, () => {
  const s = window.__s6.audioState();
  return s.currentTime > 1 ? s : null;
}, 30000, 'putar googlevideo offline dari cache');
out.seek20 = null;
if (out.playOffline.ok) {
  await page.evaluate(() => window.__s6.seekTo(20));
  out.seek20 = await waitFor(page, () => {
    const s = window.__s6.audioState();
    return s.currentTime > 21 ? s : null;
  }, 20000, 'seek offline ke 20 dtk lalu lanjut');
}
out.seek50 = null;
if (out.seek20 && out.seek20.ok) {
  await page.evaluate(() => window.__s6.seekTo(50));
  out.seek50 = await waitFor(page, () => {
    const s = window.__s6.audioState();
    return s.currentTime > 51 ? s : null;
  }, 20000, 'seek offline ke 50 dtk (ujung cache 1 MiB) lalu lanjut');
}
out.stateOfflineEnd = await page.evaluate(() => window.__s6.audioState());
await page.evaluate(() => window.__s6.pause());
await context.setOffline(false);
out.netLog = netLog;

await browser.close();
writeFileSync(new URL('./s6-result-b2.json', import.meta.url), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
console.log('tersimpan: tests/spikes/s6-result-b2.json');
