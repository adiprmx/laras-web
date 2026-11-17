// Ulang probe S7 player lewat proxy dari browser dengan timeout 90 dtk.
// Probe pertama (s7-browser-probe.mjs) timeout 30 dtk di jalur VM yang
// lambat; curl jalur yang sama butuh 19,4 dtk. Skrip ini hanya mengulang
// POST player + mengambil header x-proxy-cpu-ms untuk player-script juga.
// Dijalankan: node tests/spikes/s7-browser-retry.mjs
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
  await probe('POST player WEB_REMIX lewat proxy (timeout 90 dtk)', async () => {
    const res = await fetch(`${proxy}/api/innertube/player`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-YouTube-Client-Name': '67', 'X-YouTube-Client-Version': '1.20261110.04.00' },
      body: JSON.stringify({
        context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20261110.04.00', hl: 'id', gl: 'ID' } },
        videoId,
        playbackContext: { contentPlaybackContext: { signatureTimestamp: 20768 } },
      }),
      signal: AbortSignal.timeout(90000),
    });
    const data = await res.json();
    return { status: res.status, playability: data.playabilityStatus?.status ?? null, cpuMs: res.headers.get('x-proxy-cpu-ms'), acao: res.headers.get('Access-Control-Allow-Origin') };
  });
  await probe('POST player ANDROID_VR lewat proxy (timeout 90 dtk)', async () => {
    const res = await fetch(`${proxy}/api/innertube/player`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-YouTube-Client-Name': '14', 'X-YouTube-Client-Version': '1.65.10' },
      body: JSON.stringify({
        context: { client: { clientName: 'ANDROID_VR', clientVersion: '1.65.10', hl: 'id', gl: 'ID' } },
        videoId,
        playbackContext: { contentPlaybackContext: { signatureTimestamp: 20768 } },
      }),
      signal: AbortSignal.timeout(90000),
    });
    const data = await res.json();
    const sd = data.streamingData || {};
    return {
      status: res.status,
      playability: data.playabilityStatus?.status ?? null,
      adaptiveCount: (sd.adaptiveFormats || []).length,
      cpuMs: res.headers.get('x-proxy-cpu-ms'),
      acao: res.headers.get('Access-Control-Allow-Origin'),
    };
  });
  await probe('GET player-script lewat proxy (header CPU)', async () => {
    const res = await fetch(`${proxy}/api/player-script?hash=ad8d59ae`, { signal: AbortSignal.timeout(90000) });
    const text = await res.text();
    return { status: res.status, bytes: text.length, startsWithPlayer: text.startsWith('var _yt_player'), cpuMs: res.headers.get('x-proxy-cpu-ms'), acao: res.headers.get('Access-Control-Allow-Origin') };
  });
  return out;
}, { proxy: PROXY, videoId: VIDEO_ID });

await browser.close();
const report = { origin: ORIGIN, proxy: PROXY, at: new Date().toISOString(), results, consoleErrors };
console.log(JSON.stringify(report, null, 2));
writeFileSync(new URL('./s7-browser-result-retry.json', import.meta.url), JSON.stringify(report, null, 2));
console.log('tersimpan: tests/spikes/s7-browser-result-retry.json');
