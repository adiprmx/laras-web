// Pembuktian diferensiasi S6: putar byte itag 251 (Opus/WebM) ASLI dari
// googlevideo yang sudah terunduh ke disk lokal (media/gv251-first1m.webm,
// 1.048.576 byte, diunduh 14:40 WIB) lewat server lokal TANPA Service
// Worker. Bila berbunyi, format/codec TERBUKTI bisa diputar Chromium ini
// dan kegagalan kaki googlevideo S6 adalah lapisan jaringan, bukan format.
// Dijalankan: node tests/spikes/s6-format-proof.mjs (server s6 jalan dulu)
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';

const PAGE = 'http://127.0.0.1:4180/s6-page.html';
const WEBM = 'http://127.0.0.1:4181/gv251-first1m.webm';

const browser = await chromium.launch();
const page = await browser.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
const t0 = Date.now();
const playResult = await page.evaluate((url) => window.__s6.playUrl(url), WEBM);
// Tunggu sampai currentTime melewati 1 detik (maks 20 dtk).
let state = null;
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(500);
  state = await page.evaluate(() => window.__s6.audioState());
  if (state.currentTime > 1 && !state.paused) break;
  if (state.error) break;
}
const ms = Date.now() - t0;
await browser.close();
const report = {
  at: new Date().toISOString(),
  file: 'media/gv251-first1m.webm (1.048.576 byte pertama itag 251 dari googlevideo)',
  url: WEBM,
  serviceWorker: 'TIDAK dipakai (uji format murni)',
  playResult,
  ms,
  state,
  consoleErrors,
  verdict: state && !state.error && state.currentTime > 1 && state.readyState >= 3
    ? 'FORMAT TERBUKTI DIPUTAR'
    : 'FORMAT TIDAK TERBUKTI',
};
console.log(JSON.stringify(report, null, 2));
writeFileSync(new URL('./s6-format-proof.json', import.meta.url), JSON.stringify(report, null, 2));
console.log('tersimpan: tests/spikes/s6-format-proof.json');
