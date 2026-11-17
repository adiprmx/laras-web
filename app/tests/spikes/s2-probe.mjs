// Probe spike S2 — vonis CORS final untuk fetch langsung dari origin browser.
// Dijalankan dengan: node tests/spikes/s2-probe.mjs
// Halaman asal: http://127.0.0.1:4173/ (vite preview, build P0 yang sudah ada).
// Semua fetch dilakukan di dalam page.evaluate, dari origin app yang nyata.

import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';

const ORIGIN = 'http://127.0.0.1:4173/';
const API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'; // kunci publik InnerTube
const VIDEO_ID = 'hhn-nGSuenM'; // lagu kanari: Semua Tentang Kita
const BASE_JS = 'https://www.youtube.com/s/player/ad8d59ae/player_ias.vflset/en_US/base.js';

const CLIENTS = [
  { name: 'WEB_REMIX', id: '67', version: '1.20261110.04.00', sts: 20768 },
  { name: 'MWEB', id: '2', version: '2.20260708.05.00', sts: 20768 },
  { name: 'ANDROID_VR', id: '14', version: '1.65.10', sts: 20768 },
];

const browser = await chromium.launch({
  // Chromium langsung ke proxy egress gagal (ERR_TUNNEL_CONNECTION_FAILED,
  // padahal CONNECT mentah berhasil). Jalur yang terbukti: relay CONNECT
  // lokal tests/spikes/connect-relay.py + abaikan error sertifikat (proxy
  // egress adalah MITM dengan CA "Hatch Sandbox Egress CA"). TLS tetap
  // end-to-end dari sisi perilaku CORS: header respons diteruskan utuh.
  proxy: { server: 'http://127.0.0.1:18081', bypass: 'localhost,127.0.0.1' },
});
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();
const consoleMsgs = [];
const netEvents = [];
page.on('console', (m) => { if (m.type() === 'error') consoleMsgs.push(m.text()); });
page.on('requestfailed', (r) => netEvents.push({ url: r.url(), failure: r.failure()?.errorText ?? null }));
page.on('response', (r) => {
  const u = r.url();
  if (u.includes('youtube.com') || u.includes('googlevideo') || u.includes('lrclib') || u.includes('githubusercontent')) {
    netEvents.push({ url: u, status: r.status(), acao: r.headers()['access-control-allow-origin'] ?? null });
  }
});

await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
console.log('origin halaman:', page.url());

const results = await page.evaluate(async ({ apiKey, videoId, baseJs, clients }) => {
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
  const withTimeout = (ms) => {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    return { signal: c.signal, done: () => clearTimeout(t) };
  };

  for (const c of clients) {
    await probe(`POST player ${c.name} (id ${c.id}, sts ${c.sts})`, async () => {
      const { signal, done } = withTimeout(30000);
      try {
        const res = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${apiKey}&prettyPrint=false`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-YouTube-Client-Name': c.id, 'X-YouTube-Client-Version': c.version },
          body: JSON.stringify({
            context: { client: { clientName: c.name, clientVersion: c.version, hl: 'id', gl: 'ID' } },
            videoId,
            playbackContext: { contentPlaybackContext: { signatureTimestamp: c.sts } },
          }),
          signal,
        });
        const text = await res.text();
        return { status: res.status, bytes: text.length, hasStreamingData: text.includes('streamingData') };
      } finally { done(); }
    });
  }

  await probe('GET base.js (mode cors, baca body)', async () => {
    const { signal, done } = withTimeout(90000);
    try {
      const res = await fetch(baseJs, { signal });
      const text = await res.text();
      return { status: res.status, bytes: text.length };
    } finally { done(); }
  });

  await probe('GET base.js (mode no-cors, opaque)', async () => {
    const { signal, done } = withTimeout(90000);
    try {
      const res = await fetch(baseJs, { mode: 'no-cors', signal });
      return { status: res.status, type: res.type };
    } finally { done(); }
  });

  await probe('KONTROL positif: GET lrclib.net/api/search', async () => {
    const { signal, done } = withTimeout(30000);
    try {
      const res = await fetch('https://lrclib.net/api/search?q=Semua%20Tentang%20Kita', { signal });
      const text = await res.text();
      return { status: res.status, bytes: text.length };
    } finally { done(); }
  });

  await probe('KONTROL positif: GET raw.githubusercontent.com player-config.json', async () => {
    const { signal, done } = withTimeout(30000);
    try {
      const res = await fetch('https://raw.githubusercontent.com/adiprmx/laras/config-v1/player-config.json', { signal });
      const text = await res.text();
      return { status: res.status, bytes: text.length, hasClients: text.includes('WEB_REMIX') };
    } finally { done(); }
  });

  return out;
}, { apiKey: API_KEY, videoId: VIDEO_ID, baseJs: BASE_JS, clients: CLIENTS });

await browser.close();

const report = { origin: ORIGIN, videoId: VIDEO_ID, baseJs: BASE_JS, at: new Date().toISOString(), results, consoleErrors: consoleMsgs, netEvents };
console.log(JSON.stringify(report, null, 2));
writeFileSync(new URL('./s2-result.json', import.meta.url), JSON.stringify(report, null, 2));
console.log('tersimpan: tests/spikes/s2-result.json');
