// Probe S7 dari browser — menutup loop S2+S7: fetch langsung diblokir,
// fetch lewat Worker proxy berhasil dari origin app yang sama.
// Dijalankan: node tests/spikes/s7-browser-probe.mjs
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';

const ORIGIN = 'http://127.0.0.1:4173/';
const PROXY = 'https://laras-proxy-spike.hiroohengkerr.workers.dev';
const VIDEO_ID = 'hhn-nGSuenM';

const browser = await chromium.launch({
  proxy: { server: 'http://127.0.0.1:18081', bypass: 'localhost,127.0.0.1' },
});
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
console.log('origin halaman:', page.url());

const results = await page.evaluate(async ({ proxy, videoId }) => {
  const out = [];
  async function probe(label, fn) {
    const t0 = performance.now();
    try {
      const r = await fn();
      out.push({ label, ok: true, ms: Math.round(performance.now() - t0), ...r });
    } catch (e) {
      out.push({ label, ok: false, ms: Math.round(performance.now() - t0), errorName: e?.name ?? '?', errorMessage: String(e?.message ?? e) });
    }
  }
  await probe('POST player WEB_REMIX lewat proxy', async () => {
    const res = await fetch(`${proxy}/api/innertube/player`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-YouTube-Client-Name': '67', 'X-YouTube-Client-Version': '1.20261110.04.00' },
      body: JSON.stringify({
        context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20261110.04.00', hl: 'id', gl: 'ID' } },
        videoId,
        playbackContext: { contentPlaybackContext: { signatureTimestamp: 20768 } },
      }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json();
    return { status: res.status, playability: data.playabilityStatus?.status ?? null, cpuMs: res.headers.get('x-proxy-cpu-ms') };
  });
  await probe('GET player-script lewat proxy', async () => {
    const res = await fetch(`${proxy}/api/player-script?hash=ad8d59ae`, { signal: AbortSignal.timeout(90000) });
    const text = await res.text();
    return { status: res.status, bytes: text.length, startsWithPlayer: text.startsWith('var _yt_player') };
  });
  await probe('KONTROL: POST player LANGSUNG ke youtubei (harus gagal CORS)', async () => {
    const res = await fetch('https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20261110.04.00' } },
        videoId,
        playbackContext: { contentPlaybackContext: { signatureTimestamp: 20768 } },
      }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json();
    return { status: res.status, playability: data.playabilityStatus?.status ?? null };
  });
  return out;
}, { proxy: PROXY, videoId: VIDEO_ID });

await browser.close();
const report = { origin: ORIGIN, proxy: PROXY, at: new Date().toISOString(), results, consoleErrors };
console.log(JSON.stringify(report, null, 2));
writeFileSync(new URL('./s7-browser-result.json', import.meta.url), JSON.stringify(report, null, 2));
console.log('tersimpan: tests/spikes/s7-browser-result.json');
