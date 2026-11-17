// Laras Web — Worker proxy byte-only (SKELETON SPIKE S7).
//
// Peran: memindah byte antara browser dan YouTube/googlevideo karena
// fetch langsung dari browser diblokir CORS (vonis spike S2).
// Worker ini TIDAK mengeksekusi base.js, TIDAK memecahkan cipher,
// TIDAK menyimpan data pengguna, TIDAK mencatat body/URL stream.
// Pekerjaan CPU per request: validasi allowlist + parsing header saja.
//
// Batas yang ditegakkan (arsitektur.md §4.1):
//   JSON youtubei maks 10 MB, script player maks 8 MB,
//   body POST maks 1 MB, media streaming cap 100 MB per request.
// Rate limit di skeleton ini in-memory per isolate (best-effort);
// produksi WAJIB pindah ke D1 (KV tulis hanya 1.000/hari).
// Header x-proxy-cpu-ms adalah instrumen ukur spike: jumlah waktu
// segmen sinkron handler (validasi + bangun respons), di luar waktu
// tunggu jaringan upstream. Header ini dicabut di deployment produksi.

const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'; // kunci publik InnerTube
const YT_HOST = 'https://www.youtube.com';
const YTM_HOST = 'https://music.youtube.com';

const ROUTES = {
  '/api/innertube/player': { upstream: `${YT_HOST}/youtubei/v1/player`, timeoutMs: 30000, capBytes: 10 * 1024 * 1024, kind: 'innertube' },
  '/api/innertube/search': { upstream: `${YT_HOST}/youtubei/v1/search`, timeoutMs: 30000, capBytes: 10 * 1024 * 1024, kind: 'innertube' },
  '/api/innertube/browse': { upstream: `${YT_HOST}/youtubei/v1/browse`, timeoutMs: 30000, capBytes: 10 * 1024 * 1024, kind: 'innertube' },
  '/api/innertube/next': { upstream: `${YT_HOST}/youtubei/v1/next`, timeoutMs: 30000, capBytes: 10 * 1024 * 1024, kind: 'innertube' },
  '/api/innertube/suggestions': { upstream: `${YTM_HOST}/youtubei/v1/music/get_search_suggestions`, timeoutMs: 30000, capBytes: 10 * 1024 * 1024, kind: 'innertube' },
};

const MAX_BODY_BYTES = 1 * 1024 * 1024;
const PLAYER_SCRIPT_CAP = 8 * 1024 * 1024;
const PLAYER_SCRIPT_TIMEOUT_MS = 90000;
const MEDIA_CAP = 100 * 1024 * 1024;
const MEDIA_TIMEOUT_MS = 120000;
const RATE_INNERTUBE_PER_MIN = 60;
const RATE_MEDIA_PER_MIN = 10;

// Allowlist hash player (config-v1, 17 Nov 2026). Gerbang dicek SEBELUM
// fetch ke YouTube. Produksi membaca daftar ini dari config remote.
const PLAYER_HASHES = new Set(['fad7e4e9', 'ad8d59ae', 'b559f50c']);

// Rate limit in-memory per isolate: Map<ip, {count, windowStart}>.
// Best-effort; satu IP bisa tersebar ke beberapa isolate. Produksi: D1.
const buckets = new Map();
function rateLimited(ip, limit) {
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || now - b.windowStart >= 60000) {
    buckets.set(ip, { count: 1, windowStart: now });
    return false;
  }
  b.count += 1;
  return b.count > limit;
}

function corsHeaders(env, request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || 'https://laras.adipmusic.my.id')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const h = { 'Vary': 'Origin' };
  if (allowed.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function jsonError(status, code, message, extraHeaders = {}) {
  return new Response(JSON.stringify({ success: false, error: { code, message } }), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

// Baca body dengan cap: gagal 502 bila melewati cap.
async function readCapped(body, capBytes) {
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > capBytes) {
      try { await reader.cancel(); } catch { /* abaikan */ }
      return { tooBig: true };
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return { tooBig: false, bytes: out };
}

export default {
  async fetch(request, env) {
    const tStart = performance.now();
    let cpuMs = 0;
    const mark = (t0) => { cpuMs += performance.now() - t0; };
    const withCpu = (res) => {
      const h = new Headers(res.headers);
      h.set('x-proxy-cpu-ms', cpuMs.toFixed(3));
      // Spike saja: buka header ukur ke JS browser (tanpa ini nilainya
      // tidak terbaca dari fetch; dicabut bersama headernya di produksi).
      h.set('Access-Control-Expose-Headers', 'x-proxy-cpu-ms');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
    };

    try {
      let t0 = performance.now();
      const url = new URL(request.url);
      const cors = corsHeaders(env, request);
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

      if (request.method === 'OPTIONS') {
        mark(t0);
        return withCpu(new Response(null, {
          status: 204,
          headers: {
            ...cors,
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, X-YouTube-Client-Name, X-YouTube-Client-Version, Range',
            'Access-Control-Max-Age': '86400',
          },
        }));
      }

      // ---- /api/media: unduhan saja, Range passthrough, streaming ----
      if (url.pathname === '/api/media') {
        if (request.method !== 'GET') {
          mark(t0);
          return withCpu(jsonError(405, 'METHOD_NOT_ALLOWED', 'Metode tidak diizinkan', cors));
        }
        const target = url.searchParams.get('u');
        if (!target) {
          mark(t0);
          return withCpu(jsonError(400, 'MISSING_PARAM', 'Parameter u wajib diisi', cors));
        }
        let dest;
        try {
          dest = new URL(target);
        } catch {
          mark(t0);
          return withCpu(jsonError(400, 'BAD_URL', 'URL tujuan tidak valid', cors));
        }
        if (dest.protocol !== 'https:' || !dest.hostname.endsWith('.googlevideo.com')) {
          mark(t0);
          return withCpu(jsonError(403, 'HOST_NOT_ALLOWED', 'Host tujuan tidak diizinkan', cors));
        }
        if (rateLimited(`media:${ip}`, RATE_MEDIA_PER_MIN)) {
          mark(t0);
          const r = jsonError(429, 'RATE_LIMITED', 'Terlalu banyak unduhan, coba lagi sebentar', cors);
          r.headers.set('Retry-After', '60');
          return withCpu(r);
        }
        const headers = new Headers();
        const range = request.headers.get('Range');
        if (range) headers.set('Range', range);
        mark(t0);
        const upstream = await fetch(dest.href, {
          headers,
          signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS),
          redirect: 'follow',
        });
        t0 = performance.now();
        const declared = Number(upstream.headers.get('Content-Length') || 0);
        if (declared > MEDIA_CAP) {
          mark(t0);
          return withCpu(jsonError(502, 'UPSTREAM_TOO_BIG', 'Respons upstream melewati cap', cors));
        }
        // Streaming dengan penghitung byte: batalkan bila melewati cap.
        let sent = 0;
        const counting = new TransformStream({
          transform(chunk, controller) {
            sent += chunk.byteLength;
            if (sent > MEDIA_CAP) {
              controller.error(new Error('cap media terlampaui'));
              return;
            }
            controller.enqueue(chunk);
          },
        });
        const resHeaders = new Headers(cors);
        for (const name of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']) {
          const v = upstream.headers.get(name);
          if (v) resHeaders.set(name, v);
        }
        mark(t0);
        return withCpu(new Response(
          upstream.body ? upstream.body.pipeThrough(counting) : null,
          { status: upstream.status, headers: resHeaders },
        ));
      }

      // ---- /api/player-script: base.js, gerbang hash SEBELUM fetch ----
      if (url.pathname === '/api/player-script') {
        if (request.method !== 'GET') {
          mark(t0);
          return withCpu(jsonError(405, 'METHOD_NOT_ALLOWED', 'Metode tidak diizinkan', cors));
        }
        const hash = url.searchParams.get('hash') || '';
        if (!/^[a-f0-9]{8}$/.test(hash) || !PLAYER_HASHES.has(hash)) {
          mark(t0);
          return withCpu(jsonError(403, 'HASH_NOT_ALLOWED', 'Hash player tidak ada di allowlist', cors));
        }
        if (rateLimited(`innertube:${ip}`, RATE_INNERTUBE_PER_MIN)) {
          mark(t0);
          const r = jsonError(429, 'RATE_LIMITED', 'Terlalu banyak request, coba lagi sebentar', cors);
          r.headers.set('Retry-After', '60');
          return withCpu(r);
        }
        mark(t0);
        const upstream = await fetch(
          `${YT_HOST}/s/player/${hash}/player_ias.vflset/en_US/base.js`,
          { signal: AbortSignal.timeout(PLAYER_SCRIPT_TIMEOUT_MS) },
        );
        const read = await readCapped(upstream.body, PLAYER_SCRIPT_CAP);
        t0 = performance.now();
        if (read.tooBig) {
          mark(t0);
          return withCpu(jsonError(502, 'UPSTREAM_TOO_BIG', 'Script player melewati cap', cors));
        }
        const resHeaders = new Headers(cors);
        resHeaders.set('Content-Type', 'text/javascript');
        resHeaders.set('Cache-Control', 'public, max-age=86400');
        mark(t0);
        return withCpu(new Response(read.bytes, { status: upstream.status, headers: resHeaders }));
      }

      // ---- Endpoint InnerTube JSON ----
      const route = ROUTES[url.pathname];
      if (route) {
        if (request.method !== 'POST') {
          mark(t0);
          return withCpu(jsonError(405, 'METHOD_NOT_ALLOWED', 'Metode tidak diizinkan', cors));
        }
        if (rateLimited(`innertube:${ip}`, RATE_INNERTUBE_PER_MIN)) {
          mark(t0);
          const r = jsonError(429, 'RATE_LIMITED', 'Terlalu banyak request, coba lagi sebentar', cors);
          r.headers.set('Retry-After', '60');
          return withCpu(r);
        }
        const bodyBytes = await request.arrayBuffer();
        t0 = performance.now();
        if (bodyBytes.byteLength > MAX_BODY_BYTES) {
          mark(t0);
          return withCpu(jsonError(413, 'BODY_TOO_BIG', 'Body request melewati 1 MB', cors));
        }
        const headers = new Headers();
        headers.set('Content-Type', 'application/json');
        const cn = request.headers.get('X-YouTube-Client-Name');
        const cv = request.headers.get('X-YouTube-Client-Version');
        if (cn) headers.set('X-YouTube-Client-Name', cn);
        if (cv) headers.set('X-YouTube-Client-Version', cv);
        mark(t0);
        const upstream = await fetch(`${route.upstream}?key=${INNERTUBE_KEY}&prettyPrint=false`, {
          method: 'POST',
          headers,
          body: bodyBytes,
          signal: AbortSignal.timeout(route.timeoutMs),
        });
        const read = await readCapped(upstream.body, route.capBytes);
        t0 = performance.now();
        if (read.tooBig) {
          mark(t0);
          return withCpu(jsonError(502, 'UPSTREAM_TOO_BIG', 'Respons upstream melewati cap', cors));
        }
        const resHeaders = new Headers(cors);
        resHeaders.set('Content-Type', 'application/json');
        mark(t0);
        return withCpu(new Response(read.bytes, { status: upstream.status, headers: resHeaders }));
      }

      mark(t0);
      return withCpu(jsonError(404, 'NOT_FOUND', 'Endpoint tidak ditemukan', cors));
    } catch (e) {
      const msg = e && e.name === 'TimeoutError' ? 'Timeout ke upstream' : 'Kesalahan proxy';
      // Jalur error juga membawa CORS + header CPU agar browser bisa
      // membaca kode error (tanpa ACAO, fetch gagal opaque dan kode hilang).
      const cors = corsHeaders(env, request);
      return withCpu(jsonError(502, 'UPSTREAM_ERROR', msg, cors));
    }
  },
};
