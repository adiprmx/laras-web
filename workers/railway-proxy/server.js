// Laras Web, proxy InnerTube player via Railway (egress P2b).
//
// Peran: jalan keluar P2b bila egress Cloudflare Workers dan
// Vercel sama-sama ditolak YouTube (playability LOGIN_REQUIRED).
// Pola sama dengan workers/proxy (Cloudflare) dan
// workers/vercel-proxy: byte-only forward, teruskan body +
// header client, kembalikan status + body apa adanya. Server ini
// TIDAK mengeksekusi base.js, TIDAK memecahkan cipher, TIDAK
// menyimpan data pengguna, TIDAK mencatat body request/response
// (hanya status + ukuran + durasi di log, tanpa videoId).
//
// Tanpa dependensi: hanya modul `http` bawaan Node. Tidak ada
// `npm install` (buildCommand di render.yaml adalah no-op),
// jadi build tidak bisa gagal karena registry dan cold start
// hanya waktu boot Node.
//
// Batas (cermin proxy CF/Vercel): body POST maks 1 MB, JSON
// youtubei maks 10 MB, timeout upstream 30 dtk, rate limit
// 60/menit per IP (in-memory, best-effort, bukan pengganti rate
// limit D1 di proxy CF). Fail-open: bila hitungan gagal, request
// diizinkan. CORS: hanya origin Laras (bukan `*`).
//
// Penjaga keras 28 dtk (pelajaran Vercel 19 Nov 2026: hanya
// AbortSignal.timeout saja tidak cukup, 6/6 POST menggantung):
// server WAJIB merespons dalam 28 dtk apa pun yang terjadi di
// upstream. Batas 28 dtk ini murni kebijakan Laras,
// bukan batas platform.
//
// Rute:
//   GET  /healthz                 -> 200 {"status":"ok"} (health
//                                     check + keep-alive)
//   POST /api/innertube/player    -> proxy ke youtubei/v1/player
//   POST /api/innertube/player?ping=1 -> 200 ping ok (diagnosis,
//                                     tanpa menyentuh YouTube)
//   OPTIONS .../player            -> 204 preflight CORS
//   lainnya                       -> 404 envelope JSON
//
// Deploy: service `laras-proxy-railway` (Trial/Free), via browser,
// lihat README.md di direktori ini. JANGAN deploy dari workdir
// ini dengan CLI lain.

'use strict';

const http = require('node:http');

const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'; // kunci publik InnerTube
const UPSTREAM = 'https://www.youtube.com/youtubei/v1/player';
const MAX_BODY_BYTES = 1 * 1024 * 1024;
const RESPONSE_CAP_BYTES = 10 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 30000;
const GUARD_TIMEOUT_MS = 28000;
const RATE_PER_MIN = 60;
const RATE_WINDOW_MS = 60 * 1000;
// Railway menyuntik PORT; 10000 adalah fallback bila tidak ada.
const PORT = Number(process.env.PORT || 10000);

const ALLOWED_ORIGINS = new Set([
  'https://laras.adipmusic.my.id',
  'https://laras-web.pages.dev',
  'https://preview.laras-web.pages.dev',
]);

// Rate limit in-memory: ip -> { count, windowStart }.
const rateBuckets = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.windowStart >= RATE_WINDOW_MS) {
    rateBuckets.set(ip, { count: 1, windowStart: now });
    // Bersihkan bucket kadaluwarsa sesekali (tanpa timer global).
    if (rateBuckets.size > 10000) {
      for (const [key, value] of rateBuckets) {
        if (now - value.windowStart >= RATE_WINDOW_MS) rateBuckets.delete(key);
      }
    }
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_PER_MIN;
}

function corsHeaders(req) {
  const origin = req.headers.origin || '';
  const headers = { Vary: 'Origin' };
  if (ALLOWED_ORIGINS.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function jsonError(res, status, code, message, extraHeaders) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...extraHeaders,
  });
  res.end(JSON.stringify({ success: false, error: { code, message } }));
}

// Baca body request Node (stream) dengan cap: kembalikan
// { tooBig: true } bila melewati cap, TANPA mem-buffer seluruh
// body (stream dihancurkan begitu cap terlampaui).
function readRequestBody(req, capBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      resolve(result);
    };
    req.on('data', (chunk) => {
      if (done) return;
      total += chunk.length;
      if (total > capBytes) {
        try {
          req.destroy();
        } catch {
          /* abaikan */
        }
        finish({ tooBig: true });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      finish({ tooBig: false, bytes: Buffer.concat(chunks, total) });
    });
    req.on('error', (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

// Baca body respons upstream dengan cap, tanpa mem-buffer seluruh
// body bila melewati cap (stream dibatalkan begitu cap terlampaui).
async function readCapped(body, capBytes) {
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > capBytes) {
      try {
        await reader.cancel();
      } catch {
        /* abaikan */
      }
      return { tooBig: true };
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return { tooBig: false, bytes: out };
}

async function handle(req, res) {
  const t0 = Date.now();
  const cors = corsHeaders(req);

  let url;
  try {
    url = new URL(req.url || '/', 'http://localhost');
  } catch {
    jsonError(res, 400, 'BAD_URL', 'URL request tidak valid', cors);
    return;
  }
  const pathname = url.pathname;

  // Health check + target keep-alive
  // mencegah tidur 15 menit di tier gratis). Tanpa CORS khusus:
  // pemanggilnya bukan browser.
  if (pathname === '/healthz') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      jsonError(res, 405, 'METHOD_NOT_ALLOWED', 'Metode tidak diizinkan', cors);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (pathname !== '/api/innertube/player') {
    jsonError(res, 404, 'NOT_FOUND', 'Endpoint tidak ditemukan', cors);
    return;
  }

  // Jalur diagnosis (?ping=1): balas langsung tanpa menyentuh
  // YouTube, membedakan "transport macet" dari "upstream macet".
  // Tanpa body/secret; dipakai probe deploy, bukan jalur produksi.
  if (req.method === 'POST' && url.searchParams.get('ping') === '1') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, ping: 'ok' }));
    return;
  }

  // Penjaga keras: server WAJIB merespons dalam 28 dtk apa pun yang
  // terjadi di upstream. Tanpa ini, fetch yang menggantung (mis.
  // body stream upstream tidak pernah selesai) membuat client
  // menunggu sampai timeout-nya sendiri.
  let responded = false;
  const guard = setTimeout(() => {
    if (responded) return;
    responded = true;
    console.log(JSON.stringify({
      route: 'innertube/player',
      guard: 'hard-timeout-28s',
      ms: Date.now() - t0,
    }));
    try {
      jsonError(res, 502, 'UPSTREAM_ERROR', 'Timeout ke upstream', cors);
    } catch {
      /* soket sudah tertutup */
    }
  }, GUARD_TIMEOUT_MS);
  const finish = () => {
    responded = true;
    clearTimeout(guard);
  };
  // Client pergi di tengah jalan: jangan buang 502 ke soket mati.
  res.on('close', () => clearTimeout(guard));

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...cors,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-YouTube-Client-Name, X-YouTube-Client-Version',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    finish();
    return;
  }

  if (req.method !== 'POST') {
    jsonError(res, 405, 'METHOD_NOT_ALLOWED', 'Metode tidak diizinkan', cors);
    finish();
    return;
  }

  // Railway berada di balik load balancer: IP client asli ada di
  // X-Forwarded-For (entri pertama).
  const forwarded = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = forwarded || req.socket?.remoteAddress || 'unknown';
  try {
    if (isRateLimited(ip)) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60', ...cors });
      res.end(JSON.stringify({
        success: false,
        error: { code: 'RATE_LIMITED', message: 'Terlalu banyak request, coba lagi sebentar' },
      }));
      finish();
      return;
    }
  } catch {
    // Fail-open: hitungan rate limit gagal = request diizinkan.
  }

  // Penolakan cepat dari Content-Length yang dideklarasikan,
  // sebelum membaca stream (pola proxy CF, Red 1 S1).
  const declaredLen = Number(req.headers['content-length'] || 0);
  if (declaredLen > MAX_BODY_BYTES) {
    jsonError(res, 413, 'BODY_TOO_BIG', 'Body request melewati 1 MB', cors);
    finish();
    return;
  }

  let bodyBytes;
  try {
    const read = await readRequestBody(req, MAX_BODY_BYTES);
    if (read.tooBig) {
      jsonError(res, 413, 'BODY_TOO_BIG', 'Body request melewati 1 MB', cors);
      finish();
      return;
    }
    bodyBytes = read.bytes;
  } catch {
    jsonError(res, 400, 'BAD_BODY', 'Body request tidak bisa dibaca', cors);
    finish();
    return;
  }

  const headers = { 'Content-Type': 'application/json' };
  const clientName = req.headers['x-youtube-client-name'];
  const clientVersion = req.headers['x-youtube-client-version'];
  if (typeof clientName === 'string' && clientName) {
    headers['X-YouTube-Client-Name'] = clientName;
  }
  if (typeof clientVersion === 'string' && clientVersion) {
    headers['X-YouTube-Client-Version'] = clientVersion;
  }

  let upstream;
  try {
    upstream = await fetch(`${UPSTREAM}?key=${INNERTUBE_KEY}&prettyPrint=false`, {
      method: 'POST',
      headers,
      body: bodyBytes,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    const timeout = err && err.name === 'TimeoutError';
    jsonError(
      res,
      502,
      'UPSTREAM_ERROR',
      timeout ? 'Timeout ke upstream' : 'Kesalahan proxy',
      cors,
    );
    finish();
    return;
  }

  const declared = Number(upstream.headers.get('Content-Length') || 0);
  if (declared > RESPONSE_CAP_BYTES) {
    jsonError(res, 502, 'UPSTREAM_TOO_BIG', 'Respons upstream melewati cap', cors);
    finish();
    return;
  }
  const read = await readCapped(upstream.body, RESPONSE_CAP_BYTES);
  if (read.tooBig) {
    jsonError(res, 502, 'UPSTREAM_TOO_BIG', 'Respons upstream melewati cap', cors);
    finish();
    return;
  }

  // Log operasional saja: status + ukuran + durasi. Tanpa videoId,
  // tanpa body, tanpa URL stream.
  console.log(JSON.stringify({
    route: 'innertube/player',
    upstreamStatus: upstream.status,
    bytes: read.bytes.length,
    ms: Date.now() - t0,
  }));

  res.writeHead(upstream.status, {
    ...cors,
    'Content-Type': 'application/json',
  });
  res.end(Buffer.from(read.bytes));
  finish();
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.log(JSON.stringify({
      route: 'unhandled',
      error: err && err.name ? err.name : 'unknown',
    }));
    try {
      if (!res.headersSent) {
        jsonError(res, 502, 'UPSTREAM_ERROR', 'Kesalahan proxy', corsHeaders(req));
      }
    } catch {
      /* soket sudah tertutup */
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({ service: 'laras-proxy-railway', port: PORT, status: 'listening' }));
});
