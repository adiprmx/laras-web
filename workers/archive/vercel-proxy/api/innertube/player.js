// Laras Web — proxy InnerTube player via Vercel (egress kedua).
//
// Peran: jalan keluar kedua bila egress Cloudflare Workers ditolak
// YouTube (playability LOGIN_REQUIRED). Pola sama dengan
// workers/proxy (Cloudflare): byte-only forward — teruskan body +
// header client, kembalikan status + body apa adanya. Fungsi ini
// TIDAK mengeksekusi base.js, TIDAK memecahkan cipher, TIDAK
// menyimpan data pengguna, TIDAK mencatat body request/response
// (hanya status + ukuran + durasi di log, tanpa videoId).
//
// Batas (cermin proxy CF): body POST maks 1 MB, JSON youtubei
// maks 10 MB, timeout upstream 30 dtk, rate limit 60/menit per IP.
// Rate limit di sini in-memory per instance serverless
// (best-effort; tiap instance punya hitungannya sendiri) —
// bukan pengganti rate limit D1 di proxy CF. Fail-open: bila
// hitungan gagal, request diizinkan.
// CORS: hanya origin Laras (bukan `*`).
//
// Deploy: POST /v13/deployments via API (lihat README.md di
// direktori ini). JANGAN deploy dengan `vercel` CLI dari workdir
// app — proyek ini proyek Vercel TERPISAH (laras-proxy-vercel).

const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'; // kunci publik InnerTube
const UPSTREAM = 'https://www.youtube.com/youtubei/v1/player';
const MAX_BODY_BYTES = 1 * 1024 * 1024;
const RESPONSE_CAP_BYTES = 10 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 30000;
const RATE_PER_MIN = 60;
const RATE_WINDOW_MS = 60 * 1000;

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

module.exports = async (req, res) => {
  const t0 = Date.now();
  const cors = corsHeaders(req);

  // Jalur diagnosis (?ping=1): balas langsung tanpa menyentuh
  // YouTube — membedakan "transport macet" dari "upstream macet".
  // Tanpa body/secret; dipakai probe deploy, bukan jalur produksi.
  if (req.method === 'POST' && req.url && req.url.includes('ping=1')) {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, ping: 'ok' }));
    return;
  }

  // Penjaga keras: fungsi WAJIB merespons dalam 28 dtk apa pun yang
  // terjadi di upstream (maxDuration fungsi 30 dtk). Tanpa ini,
  // fetch yang menggantung (mis. body stream upstream tidak pernah
  // selesai) membuat client menunggu sampai timeout-nya sendiri.
  let responded = false;
  const guard = setTimeout(() => {
    if (responded) return;
    responded = true;
    console.log(JSON.stringify({ route: 'innertube/player', guard: 'hard-timeout-28s', ms: Date.now() - t0 }));
    try {
      jsonError(res, 502, 'UPSTREAM_ERROR', 'Timeout ke upstream', cors);
    } catch {
      /* soket sudah tertutup */
    }
  }, 28000);
  const finish = () => {
    responded = true;
    clearTimeout(guard);
  };

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

  // Vercel Node runtime mem-parse body JSON otomatis (req.body
  // object). Teruskan apa adanya dengan serialisasi ulang — urutan
  // kunci JSON dipertahankan, isi tidak diperiksa/diubah.
  let bodyBytes;
  try {
    const raw = req.body;
    if (raw === undefined || raw === null) {
      bodyBytes = Buffer.alloc(0);
    } else if (Buffer.isBuffer(raw)) {
      bodyBytes = raw;
    } else if (typeof raw === 'string') {
      bodyBytes = Buffer.from(raw, 'utf8');
    } else {
      bodyBytes = Buffer.from(JSON.stringify(raw), 'utf8');
    }
  } catch {
    jsonError(res, 400, 'BAD_BODY', 'Body request tidak bisa dibaca', cors);
    finish();
    return;
  }
  if (bodyBytes.length > MAX_BODY_BYTES) {
    jsonError(res, 413, 'BODY_TOO_BIG', 'Body request melewati 1 MB', cors);
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
};
