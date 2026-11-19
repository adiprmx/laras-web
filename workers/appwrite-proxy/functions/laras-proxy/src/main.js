// Laras Web, proxy InnerTube player via Appwrite Cloud Functions.
//
// Cermin workers/render-proxy/server.js (byte-only forward), diadaptasi
// ke format Appwrite Functions (Node.js 22, ESM — package.json di
// direktori ini menyetel "type": "module" sesuai template resmi
// Appwrite): handler menerima context ({ req, res, log, error }) dan
// membalas via res.send(). TIDAK mengeksekusi base.js, TIDAK memecahkan
// cipher, TIDAK menyimpan data pengguna, TIDAK mencatat body
// request/response (log hanya status + ukuran + durasi, tanpa videoId).
//
// Batas (cermin proxy CF/Vercel/Render): body POST maks 1 MB, JSON
// youtubei maks 10 MB, timeout upstream 30 dtk, penjaga keras 28 dtk
// (eksekusi sinkron via domain Appwrite dibatasi 60 dtk; timeout
// fungsi diset 30 dtk saat create). Rate limit in-memory best-effort
// 60/menit per IP (tiap eksekusi fungsi bisa instance baru, jadi ini
// bukan pengganti rate limit D1 di proxy CF). CORS: hanya origin Laras.
//
// Rute (req.path dari domain fungsi):
//   GET  /healthz                 -> 200 {"status":"ok"}
//   POST /api/innertube/player    -> proxy ke youtubei/v1/player
//   POST /api/innertube/player?ping=1 -> 200 ping ok (diagnosis)
//   OPTIONS .../player            -> 204 preflight CORS
//   lainnya                       -> 404 envelope JSON
//
// Deploy: POST /v1/functions + POST /v1/functions/{id}/deployments
// (tar.gz berisi src/main.js + package.json ini), execute ["any"] agar
// domain fungsi bisa dipanggil publik. Lihat README.md di
// workers/appwrite-proxy/.

const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'; // kunci publik InnerTube
const UPSTREAM = 'https://www.youtube.com/youtubei/v1/player';
const MAX_BODY_BYTES = 1 * 1024 * 1024;
const RESPONSE_CAP_BYTES = 10 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 30000;
const GUARD_TIMEOUT_MS = 28000;
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
  const origin = (req.headers && (req.headers.origin || req.headers.Origin)) || '';
  const headers = { Vary: 'Origin' };
  if (ALLOWED_ORIGINS.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function jsonError(res, status, code, message, extraHeaders) {
  return res.json(
    { success: false, error: { code, message } },
    status,
    { 'Content-Type': 'application/json', ...extraHeaders },
  );
}

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

export default async ({ req, res, log, error }) => {
  const t0 = Date.now();
  const cors = corsHeaders(req);
  const path = req.path || '/';
  const method = (req.method || 'GET').toUpperCase();
  const query = req.query || {};

  if (path === '/healthz') {
    if (method !== 'GET' && method !== 'HEAD') {
      return jsonError(res, 405, 'METHOD_NOT_ALLOWED', 'Metode tidak diizinkan', cors);
    }
    return res.json({ status: 'ok' }, 200);
  }

  if (path !== '/api/innertube/player') {
    return jsonError(res, 404, 'NOT_FOUND', 'Endpoint tidak ditemukan', cors);
  }

  // Jalur diagnosis (?ping=1): balas langsung tanpa menyentuh YouTube.
  if (method === 'POST' && query.ping === '1') {
    return res.json({ success: true, ping: 'ok' }, 200, cors);
  }

  if (method === 'OPTIONS') {
    return res.send('', 204, {
      ...cors,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-YouTube-Client-Name, X-YouTube-Client-Version',
      'Access-Control-Max-Age': '86400',
    });
  }

  if (method !== 'POST') {
    return jsonError(res, 405, 'METHOD_NOT_ALLOWED', 'Metode tidak diizinkan', cors);
  }

  // Penjaga keras 28 dtk: fungsi WAJIB merespons apa pun yang terjadi
  // di upstream. Race antara pekerjaan utama dan timer; safeRes
  // memastikan hanya respons pertama yang terkirim (pemenang kedua
  // dibuang, bukan double-send).
  let settled = false;
  const safeRes = {
    json: (...args) => {
      if (settled) return null;
      settled = true;
      return res.json(...args);
    },
    send: (...args) => {
      if (settled) return null;
      settled = true;
      return res.send(...args);
    },
  };

  const guard = new Promise((resolve) => {
    setTimeout(() => {
      if (settled) return;
      log(JSON.stringify({ route: 'innertube/player', guard: 'hard-timeout-28s', ms: Date.now() - t0 }));
      resolve(jsonError(safeRes, 502, 'UPSTREAM_ERROR', 'Timeout ke upstream', cors));
    }, GUARD_TIMEOUT_MS);
  });

  const work = (async () => {
    const headers = req.headers || {};
    const forwarded = (headers['x-forwarded-for'] || headers['X-Forwarded-For'] || '').split(',')[0].trim();
    const ip = forwarded || headers['x-appwrite-client-ip'] || headers['X-Appwrite-Client-Ip'] || 'unknown';
    try {
      if (isRateLimited(ip)) {
        return safeRes.json(
          { success: false, error: { code: 'RATE_LIMITED', message: 'Terlalu banyak request, coba lagi sebentar' } },
          429,
          { 'Content-Type': 'application/json', 'Retry-After': '60', ...cors },
        );
      }
    } catch {
      // Fail-open.
    }

    // Body mentah dari runtime Appwrite (string). Bila kosong/tidak ada,
    // tolak sebagai body buruk — proxy byte-only tidak boleh mengarang body.
    const rawBody = typeof req.body === 'string' ? req.body : '';
    const bodyBytes = Buffer.from(rawBody, 'utf-8');
    if (bodyBytes.length === 0 || bodyBytes.length > MAX_BODY_BYTES) {
      return jsonError(
        safeRes,
        bodyBytes.length === 0 ? 400 : 413,
        bodyBytes.length === 0 ? 'BAD_BODY' : 'BODY_TOO_BIG',
        bodyBytes.length === 0 ? 'Body request kosong' : 'Body request melewati 1 MB',
        cors,
      );
    }

    const fwdHeaders = { 'Content-Type': 'application/json' };
    const clientName = headers['x-youtube-client-name'] || headers['X-YouTube-Client-Name'];
    const clientVersion = headers['x-youtube-client-version'] || headers['X-YouTube-Client-Version'];
    if (typeof clientName === 'string' && clientName) fwdHeaders['X-YouTube-Client-Name'] = clientName;
    if (typeof clientVersion === 'string' && clientVersion) fwdHeaders['X-YouTube-Client-Version'] = clientVersion;

    let upstream;
    try {
      upstream = await fetch(`${UPSTREAM}?key=${INNERTUBE_KEY}&prettyPrint=false`, {
        method: 'POST',
        headers: fwdHeaders,
        body: bodyBytes,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (err) {
      const timeout = err && err.name === 'TimeoutError';
      return jsonError(safeRes, 502, 'UPSTREAM_ERROR', timeout ? 'Timeout ke upstream' : 'Kesalahan proxy', cors);
    }

    const declared = Number(upstream.headers.get('Content-Length') || 0);
    if (declared > RESPONSE_CAP_BYTES) {
      return jsonError(safeRes, 502, 'UPSTREAM_TOO_BIG', 'Respons upstream melewati cap', cors);
    }
    const read = await readCapped(upstream.body, RESPONSE_CAP_BYTES);
    if (read.tooBig) {
      return jsonError(safeRes, 502, 'UPSTREAM_TOO_BIG', 'Respons upstream melewati cap', cors);
    }

    // Log operasional saja: status + ukuran + durasi. Tanpa videoId.
    log(JSON.stringify({
      route: 'innertube/player',
      upstreamStatus: upstream.status,
      bytes: read.bytes.length,
      ms: Date.now() - t0,
    }));

    return safeRes.send(Buffer.from(read.bytes).toString('utf-8'), upstream.status, {
      ...cors,
      'Content-Type': 'application/json',
    });
  })();

  return Promise.race([work, guard]);
};
