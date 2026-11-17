// Uji rate limit S7 — VERSI NODE (tidak jalan di VM ini: fetch Node tidak
// bisa keluar lewat proxy egress MITM; semua request timeout 30 dtk).
// Jalur yang terbukti: curl paralel/serial dari shell. File ini disimpan
// sebagai dokumentasi percobaan, bukan jalur uji utama.
import { writeFileSync } from 'node:fs';

const TARGET = 'https://laras-proxy-spike.hiroohengkerr.workers.dev/api/innertube/player';
const N = 70;
const CONC = 20;

async function one(i) {
  const t0 = Date.now();
  try {
    const r = await fetch(TARGET, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(30000),
    });
    await r.text();
    return { i, status: r.status, ms: Date.now() - t0, retryAfter: r.headers.get('Retry-After') };
  } catch (e) {
    return { i, status: 'ERR', ms: Date.now() - t0, error: String(e).slice(0, 80) };
  }
}

const t0 = Date.now();
const results = [];
for (let start = 0; start < N; start += CONC) {
  const batch = [];
  for (let i = start; i < Math.min(start + CONC, N); i++) batch.push(one(i + 1));
  results.push(...(await Promise.all(batch)));
  console.log(`batch ${start + 1}-${Math.min(start + CONC, N)} selesai (${Date.now() - t0} ms)`);
}
const totalMs = Date.now() - t0;
const dist = {};
for (const r of results) dist[r.status] = (dist[r.status] || 0) + 1;
const first429 = results.find((r) => r.status === 429);
console.log('total:', totalMs, 'ms untuk', N, 'request');
console.log('distribusi:', JSON.stringify(dist));
console.log('429 pertama:', first429 ? `#${first429.i} Retry-After=${first429.retryAfter}` : 'tidak ada');
console.log('detail:', JSON.stringify(results.map((r) => `${r.i}:${r.status}`).join(' ')));
writeFileSync(new URL('./s7-ratelimit-result.json', import.meta.url), JSON.stringify({ totalMs, dist, first429, results }, null, 2));
console.log('tersimpan: tests/spikes/s7-ratelimit-result.json');
