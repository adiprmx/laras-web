// Baca header x-proxy-cpu-ms dari DALAM browser (membutuhkan
// Access-Control-Expose-Headers yang ditambahkan di deploy ke-2).
// Dijalankan: node tests/spikes/s7-cpu-browser.mjs
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';

const ORIGIN = 'http://127.0.0.1:4173/';
const PROXY = 'https://laras-proxy-spike.hiroohengkerr.workers.dev';

const browser = await chromium.launch({
  proxy: { server: 'http://127.0.0.1:18081', bypass: 'localhost,127.0.0.1' },
});
const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });

const results = await page.evaluate(async (proxy) => {
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
  await probe('OPTIONS preflight (baca header CPU)', async () => {
    const res = await fetch(`${proxy}/api/innertube/player`, { method: 'OPTIONS', signal: AbortSignal.timeout(60000) });
    return { status: res.status, cpuMs: res.headers.get('x-proxy-cpu-ms') };
  });
  await probe('GET rute tidak dikenal 404 (baca header CPU)', async () => {
    const res = await fetch(`${proxy}/api/tidak-ada`, { signal: AbortSignal.timeout(60000) });
    const data = await res.json();
    return { status: res.status, code: data.error?.code ?? null, cpuMs: res.headers.get('x-proxy-cpu-ms') };
  });
  await probe('GET player-script (baca header CPU)', async () => {
    const res = await fetch(`${proxy}/api/player-script?hash=ad8d59ae`, { signal: AbortSignal.timeout(90000) });
    const text = await res.text();
    return { status: res.status, bytes: text.length, cpuMs: res.headers.get('x-proxy-cpu-ms') };
  });
  return out;
}, PROXY);

await browser.close();
const report = { origin: ORIGIN, proxy: PROXY, at: new Date().toISOString(), results };
console.log(JSON.stringify(report, null, 2));
writeFileSync(new URL('./s7-cpu-browser-result.json', import.meta.url), JSON.stringify(report, null, 2));
console.log('tersimpan: tests/spikes/s7-cpu-browser-result.json');
