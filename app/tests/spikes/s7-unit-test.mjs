// Uji deterministik penjaga Worker proxy (S7) di Node: impor modul
// Worker asli, stub fetch upstream, lalu panggil handler langsung.
// Membuktikan LOGIKA rate limit + cap tanpa noise jaringan/isolate
// Cloudflare (pelengkap uji burst live, bukan penggantinya).
// Dijalankan: node tests/spikes/s7-unit-test.mjs
import { writeFileSync } from 'node:fs';

const ENV = { ALLOWED_ORIGINS: 'https://laras.adipmusic.my.id,http://127.0.0.1:4173' };
const IP = '203.0.113.7';
const BASE = 'https://laras-proxy-spike.hiroohengkerr.workers.dev';

// Stub upstream: youtubei -> 200 JSON kecil; googlevideo -> 206 1 KB;
// base.js -> 200 teks 100 KB.
let upstreamCalls = 0;
globalThis.fetch = async (url, init) => {
  upstreamCalls++;
  const u = String(url);
  if (u.includes('/youtubei/v1/')) {
    return new Response(JSON.stringify({ playabilityStatus: { status: 'OK' } }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }
  if (u.includes('base.js')) {
    return new Response('var _yt_player={};' + 'x'.repeat(100000), {
      status: 200, headers: { 'Content-Type': 'text/javascript' },
    });
  }
  if (u.includes('googlevideo.com')) {
    return new Response('a'.repeat(1024), {
      status: 206,
      headers: { 'Content-Type': 'audio/webm', 'Content-Length': '1024', 'Content-Range': 'bytes 0-1023/4808098' },
    });
  }
  return new Response('not found', { status: 404 });
};

const worker = (await import('../../../workers/proxy/src/index.js')).default;

function req(path, { method = 'GET', body = null, headers = {} } = {}) {
  return new Request(BASE + path, {
    method,
    headers: { 'CF-Connecting-IP': IP, Origin: 'http://127.0.0.1:4173', ...headers },
    body,
  });
}

const results = [];
function rec(label, got, expect, extra = {}) {
  const pass = got === expect;
  results.push({ label, status: got, expect, pass, ...extra });
  console.log(`${pass ? 'LULUS' : 'GAGAL'} ${label}: ${got} (harap ${expect})${extra.note ? ` ${extra.note}` : ''}`);
}

// 1. Rate limit InnerTube: 70 POST cepat, harap 60 lolos + 10 ditolak 429.
{
  const codes = [];
  let retryAfter = null;
  let first429 = null;
  for (let i = 1; i <= 70; i++) {
    const res = await worker.fetch(req('/api/innertube/player', {
      method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' },
    }), ENV);
    await res.text();
    codes.push(res.status);
    if (res.status === 429 && first429 === null) {
      first429 = i;
      retryAfter = res.headers.get('Retry-After');
    }
  }
  const n200 = codes.filter((c) => c === 200).length;
  const n429 = codes.filter((c) => c === 429).length;
  rec('Rate limit InnerTube: 60 lolos dari 70', n200, 60, { note: `429=${n429}, 429 pertama=#${first429}, Retry-After=${retryAfter}` });
  rec('Rate limit InnerTube: 10 ditolak 429', n429, 10);
  rec('Rate limit InnerTube: 429 pertama di #61', first429, 61);
  rec('Rate limit InnerTube: Retry-After 60 dtk', retryAfter, '60');
}

// 2. Rate limit media: 12 GET Range cepat, harap 10 lolos + 2 ditolak 429.
// (IP sama, tapi bucket media terpisah dari bucket innertube.)
{
  const codes = [];
  let first429 = null;
  for (let i = 1; i <= 12; i++) {
    const res = await worker.fetch(req('/api/media?u=' + encodeURIComponent('https://rr1---sn-xxxx.googlevideo.com/videoplayback?x=1'), {
      headers: { Range: 'bytes=0-1023' },
    }), ENV);
    await res.text();
    codes.push(res.status);
    if (res.status === 429 && first429 === null) first429 = i;
  }
  const n206 = codes.filter((c) => c === 206).length;
  const n429 = codes.filter((c) => c === 429).length;
  rec('Rate limit media: 10 lolos dari 12', n206, 10, { note: `429=${n429}, 429 pertama=#${first429}` });
  rec('Rate limit media: 2 ditolak 429', n429, 2);
  rec('Rate limit media: 429 pertama di #11', first429, 11);
}

// 3. Cap body POST > 1 MB -> 413 (pakai IP lain agar bebas rate limit).
{
  const big = 'x'.repeat(1024 * 1024 + 7);
  const r = new Request(BASE + '/api/innertube/player', {
    method: 'POST',
    headers: { 'CF-Connecting-IP': '203.0.113.8', Origin: 'http://127.0.0.1:4173', 'Content-Type': 'application/json' },
    body: JSON.stringify({ x: big }),
  });
  const res = await worker.fetch(r, ENV);
  const data = await res.json();
  rec('Cap body POST 1 MB + 7 byte -> 413', res.status, 413, { note: `code=${data.error?.code}` });
}

// 4. Gerbang host media + hash player (IP lain).
{
  const r1 = await worker.fetch(req('/api/media?u=' + encodeURIComponent('https://example.com/a.webm'), { headers: { 'CF-Connecting-IP': '203.0.113.9' } }), ENV);
  await r1.text();
  rec('Gerbang host media example.com -> 403', r1.status, 403);
  const r2 = await worker.fetch(req('/api/player-script?hash=00000000', { headers: { 'CF-Connecting-IP': '203.0.113.9' } }), ENV);
  await r2.text();
  rec('Gerbang hash player 00000000 -> 403', r2.status, 403);
  const r3 = await worker.fetch(req('/api/player-script?hash=ad8d59ae', { headers: { 'CF-Connecting-IP': '203.0.113.9' } }), ENV);
  const t3 = await r3.text();
  rec('Hash player ad8d59ae lolos -> 200', r3.status, 200, { note: `byte=${t3.length}` });
}

// 5. Header CPU hadir di semua respons (sampel: 404 + OPTIONS).
{
  const r1 = await worker.fetch(req('/api/tidak-ada'), ENV);
  await r1.text();
  const cpu1 = r1.headers.get('x-proxy-cpu-ms');
  const r2 = await worker.fetch(req('/api/innertube/player', { method: 'OPTIONS' }), ENV);
  await r2.text();
  const cpu2 = r2.headers.get('x-proxy-cpu-ms');
  const ok = cpu1 !== null && cpu2 !== null && Number(cpu1) < 10 && Number(cpu2) < 10;
  results.push({ label: 'Header x-proxy-cpu-ms < 10 ms (404 + OPTIONS)', cpu_404_ms: cpu1, cpu_options_ms: cpu2, pass: ok });
  console.log(`${ok ? 'LULUS' : 'GAGAL'} Header CPU: 404=${cpu1} ms, OPTIONS=${cpu2} ms (batas 10 ms)`);
}

const passed = results.filter((r) => r.pass).length;
const report = {
  at: new Date().toISOString(),
  worker: 'workers/proxy/src/index.js (modul asli, fetch upstream di-stub)',
  upstream_calls: upstreamCalls,
  results,
  passed,
  total: results.length,
};
writeFileSync(new URL('./s7-unit-result.json', import.meta.url), JSON.stringify(report, null, 2));
console.log(`\n${passed}/${results.length} cek lolos; tersimpan: tests/spikes/s7-unit-result.json`);
if (passed !== results.length) process.exit(1);
