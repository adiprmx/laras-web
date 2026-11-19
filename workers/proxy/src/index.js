// Laras Web — Worker proxy byte-only (SKELETON SPIKE S7).
//
// Peran: memindah byte antara browser dan YouTube/googlevideo karena
// fetch langsung dari browser diblokir CORS (vonis spike S2).
// Plus satu rute P8: /api/spotify-page mengambil halaman PUBLIK
// playlist Spotify (open.spotify.com, tanpa login/API) karena halaman
// itu juga tanpa header CORS — api.spotify.com tidak pernah disentuh.
// Worker ini TIDAK mengeksekusi base.js, TIDAK memecahkan cipher,
// TIDAK menyimpan data pengguna, TIDAK mencatat body/URL stream.
// Pekerjaan CPU per request: validasi allowlist + parsing header saja.
//
// Batas yang ditegakkan (arsitektur.md §4.1):
//   JSON youtubei maks 10 MB, script player maks 8 MB,
//   body POST maks 1 MB, media streaming cap 100 MB per request.
// Rate limit di D1 (Red 1 S3, migrasi workers/sync/0002_ratelimit.sql):
// satu baris per (IP, jendela menit). Fail-open: bila D1 tidak
// terikat atau gagal, request diizinkan + dicatat — rate limit yang
// mati tidak boleh mematikan layanan. Binding D1: `DB`
// (database laras-web-sync); redeploy WAJIB membawa binding ini.
// Header x-proxy-cpu-ms adalah instrumen ukur spike: jumlah waktu
// segmen sinkron handler (validasi + bangun respons), di luar waktu
// tunggu jaringan upstream. Header ini dicabut di deployment produksi.

import { isRateLimited } from './rateLimit.js';

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
const RATE_SPOTIFY_PER_MIN = 10;
// /api/resolve-cache (P3): GET dibaca app saat resolve langsung
// gagal (batas sama dengan innertube: 60/menit/IP); POST hanya
// dari populator koordinator (kunci rahasia + 10/menit/IP).
const RATE_CACHE_READ_PER_MIN = 60;
const RATE_CACHE_WRITE_PER_MIN = 10;
// Cap body POST cache: satu entri (URL googlevideo + metadata)
// tidak pernah sebesar ini; 8 KB sudah longgar.
const CACHE_BODY_CAP = 8 * 1024;
// Umur maksimum entri yang diterima POST: 24 jam. URL googlevideo
// biasanya berlaku ~6 jam; batas ini hanya jaring pengaman
// terhadap nilai expire yang ngawur.
const CACHE_MAX_TTL_S = 24 * 60 * 60;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
// /api/spotify-page (P8): halaman playlist publik Spotify, diambil
// worker karena browser tidak bisa langsung (tanpa header CORS).
// Ukuran nyata ~515 KB (probe 19 Nov 2026); cap 2 MB + timeout
// 15 dtk + redirect manual maks 2 hop dalam open.spotify.com
// (port aturan APK spotify_import.dart).
const SPOTIFY_PAGE_CAP = 2 * 1024 * 1024;
const SPOTIFY_PAGE_TIMEOUT_MS = 15000;
const SPOTIFY_MAX_REDIRECTS = 2;
const SPOTIFY_PLAYLIST_ID = /^[A-Za-z0-9]{22}$/;
const SPOTIFY_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0 Mobile Safari/537.36';
// Redirect /api/media diikuti manual maks 3 hop (Red 1 R1).
const MEDIA_MAX_REDIRECTS = 3;
// Content-Type upstream yang boleh diteruskan /api/media (Red 1 R1).
// Selain ini (mis. text/html halaman galat) ditolak 502 supaya proxy
// tidak pernah meneruskan HTML dari host lain ke browser.
const MEDIA_CONTENT_TYPES = ['audio/', 'video/', 'application/octet-stream'];

// Allowlist hash player (config-v1, 17 Nov 2026). Gerbang dicek SEBELUM
// fetch ke YouTube. Produksi membaca daftar ini dari config remote.
const PLAYER_HASHES = new Set(['fad7e4e9', 'ad8d59ae', 'b559f50c']);

// Rate limit D1 (Red 1 S3) dengan fail-open: bila binding DB tidak
// ada atau D1 gagal, request DIIZINKAN dan kegagalan dicatat lewat
// console.warn (tampil di log Cloudflare). Kunci (yang memuat IP)
// TIDAK PERNAH dicatat. Peringatan "binding tidak ada" ditulis
// sekali per isolate supaya log tidak dibanjiri tiap request.
let warnedMissingDb = false;
async function checkRateLimit(env, key, limit) {
  if (!env.DB) {
    if (!warnedMissingDb) {
      warnedMissingDb = true;
      console.warn('rate limit: binding D1 (DB) tidak ada, rate limit nonaktif');
    }
    return false;
  }
  try {
    return await isRateLimited(env.DB, key, limit);
  } catch (e) {
    console.warn(
      'rate limit: D1 gagal, request diizinkan:',
      e instanceof Error ? e.message : 'unknown',
    );
    return false;
  }
}

function corsHeaders(env, request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || 'https://laras.adipmusic.my.id')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const h = { 'Vary': 'Origin' };
  if (allowed.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

// Bandingkan dua string dalam waktu yang tidak bergantung pada
// posisi beda pertama (menghindari tebakan kunci lewat timing).
// Dipakai untuk X-Cache-Key (POST /api/resolve-cache).
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function jsonError(status, code, message, extraHeaders = {}) {
  return new Response(JSON.stringify({ success: false, error: { code, message } }), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

// Baca body dengan cap: kembalikan { tooBig: true } bila melewati
// cap, TANPA mem-buffer seluruh body (stream dibatalkan begitu cap
// terlampaui). Dipakai untuk respons upstream DAN body request
// (Red 1 S1); pemanggil yang memutuskan kode galatnya (502/413).
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
      // GABUNG, jangan timpa: /api/media mengekspos Content-Range
      // (bug P5 #1 — timpa membuat fetch() tidak bisa membaca total
      // byte unduhan chunked).
      const prev = h.get('Access-Control-Expose-Headers');
      const exposed = new Set(
        (prev || '').split(',').map((s) => s.trim()).filter(Boolean),
      );
      exposed.add('x-proxy-cpu-ms');
      h.set('Access-Control-Expose-Headers', [...exposed].join(', '));
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
            'Access-Control-Allow-Headers': 'Content-Type, X-YouTube-Client-Name, X-YouTube-Client-Version, X-Cache-Key, Range',
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
        if (await checkRateLimit(env, `media:${ip}`, RATE_MEDIA_PER_MIN)) {
          mark(t0);
          const r = jsonError(429, 'RATE_LIMITED', 'Terlalu banyak unduhan, coba lagi sebentar', cors);
          r.headers.set('Retry-After', '60');
          return withCpu(r);
        }
        const headers = new Headers();
        const range = request.headers.get('Range');
        if (range) headers.set('Range', range);
        mark(t0);
        // Redirect diikuti MANUAL maks 3 hop (Red 1 R1): pola lama
        // `redirect: 'follow'` meneruskan konten host mana pun yang
        // dituju Location upstream tanpa validasi ulang. Tiap hop
        // divalidasi dengan aturan host yang sama, dan total waktu
        // semua hop dibatasi satu deadline MEDIA_TIMEOUT_MS.
        let upstream = null;
        {
          let current = dest.href;
          const deadline = Date.now() + MEDIA_TIMEOUT_MS;
          for (let hop = 0; hop <= MEDIA_MAX_REDIRECTS; hop++) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
              mark(t0);
              return withCpu(jsonError(502, 'UPSTREAM_ERROR', 'Timeout ke upstream', cors));
            }
            const res = await fetch(current, {
              headers,
              signal: AbortSignal.timeout(remaining),
              redirect: 'manual',
            });
            t0 = performance.now();
            const loc = res.headers.get('Location');
            if (res.status < 300 || res.status >= 400 || !loc) {
              upstream = res;
              break;
            }
            if (hop === MEDIA_MAX_REDIRECTS) {
              mark(t0);
              return withCpu(jsonError(502, 'TOO_MANY_REDIRECTS', 'Upstream redirect terlalu banyak', cors));
            }
            let next;
            try {
              next = new URL(loc, current);
            } catch {
              mark(t0);
              return withCpu(jsonError(502, 'BAD_REDIRECT', 'Location redirect upstream tidak valid', cors));
            }
            if (next.protocol !== 'https:' || !next.hostname.endsWith('.googlevideo.com')) {
              mark(t0);
              return withCpu(jsonError(502, 'REDIRECT_NOT_ALLOWED', 'Redirect upstream ke host di luar allowlist', cors));
            }
            current = next.href;
          }
        }
        t0 = performance.now();
        const declared = Number(upstream.headers.get('Content-Length') || 0);
        if (declared > MEDIA_CAP) {
          mark(t0);
          return withCpu(jsonError(502, 'UPSTREAM_TOO_BIG', 'Respons upstream melewati cap', cors));
        }
        // Hanya teruskan Content-Type media (Red 1 R1): halaman
        // galat HTML upstream tidak boleh sampai ke browser.
        const contentType = upstream.headers.get('Content-Type') || '';
        if (
          contentType &&
          !MEDIA_CONTENT_TYPES.some((p) => contentType.toLowerCase().startsWith(p))
        ) {
          mark(t0);
          return withCpu(jsonError(502, 'UPSTREAM_BAD_TYPE', 'Content-Type upstream bukan media', cors));
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
        // P5: Content-Range + Accept-Ranges bukan header safelist CORS —
        // tanpa expose, fetch() browser tidak bisa membacanya dan
        // pengunduh chunked kehilangan total byte.
        resHeaders.set('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges');
        resHeaders.set('X-Content-Type-Options', 'nosniff');
        mark(t0);
        return withCpu(new Response(
          upstream.body ? upstream.body.pipeThrough(counting) : null,
          { status: upstream.status, headers: resHeaders },
        ));
      }

      // ---- /api/spotify-page: halaman playlist publik Spotify (P8) ----
      // Satu-satunya rute yang menyentuh domain Spotify — dan hanya
      // halaman PUBLIK open.spotify.com/playlist/<id> (tanpa login,
      // tanpa API). api.spotify.com / accounts.spotify.com TIDAK
      // PERNAH disentuh (larangan permanen PRD B10.2). HTML
      // diteruskan sebagai TEKS untuk di-parse client (fetch +
      // readCappedText); tidak pernah dieksekusi/dinavigasi, jadi
      // bukan vektor XSS — ditambah nosniff untuk jaga-jaga.
      if (url.pathname === '/api/spotify-page') {
        if (request.method !== 'GET') {
          mark(t0);
          return withCpu(jsonError(405, 'METHOD_NOT_ALLOWED', 'Metode tidak diizinkan', cors));
        }
        const id = url.searchParams.get('id') || '';
        if (!SPOTIFY_PLAYLIST_ID.test(id)) {
          mark(t0);
          return withCpu(jsonError(400, 'BAD_ID', 'Id playlist tidak valid (22 karakter)', cors));
        }
        if (await checkRateLimit(env, `spotify:${ip}`, RATE_SPOTIFY_PER_MIN)) {
          mark(t0);
          const r = jsonError(429, 'RATE_LIMITED', 'Terlalu banyak permintaan, coba lagi sebentar', cors);
          r.headers.set('Retry-After', '60');
          return withCpu(r);
        }
        mark(t0);
        // Redirect manual maks 2 hop, hanya dalam
        // open.spotify.com/playlist/<id> (mis. penambahan locale).
        // Redirect ke host/path lain (termasuk halaman login) = tolak.
        let upstream = null;
        {
          let current = `https://open.spotify.com/playlist/${id}`;
          const deadline = Date.now() + SPOTIFY_PAGE_TIMEOUT_MS;
          for (let hop = 0; hop <= SPOTIFY_MAX_REDIRECTS; hop++) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
              mark(t0);
              return withCpu(jsonError(502, 'UPSTREAM_ERROR', 'Timeout ke upstream', cors));
            }
            const res = await fetch(current, {
              headers: {
                'User-Agent': SPOTIFY_UA,
                'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
              },
              signal: AbortSignal.timeout(remaining),
              redirect: 'manual',
            });
            t0 = performance.now();
            const loc = res.headers.get('Location');
            if (res.status < 300 || res.status >= 400 || !loc) {
              upstream = res;
              break;
            }
            if (hop === SPOTIFY_MAX_REDIRECTS) {
              mark(t0);
              return withCpu(jsonError(502, 'TOO_MANY_REDIRECTS', 'Upstream redirect terlalu banyak', cors));
            }
            let next;
            try {
              next = new URL(loc, current);
            } catch {
              mark(t0);
              return withCpu(jsonError(502, 'BAD_REDIRECT', 'Location redirect upstream tidak valid', cors));
            }
            const segs = next.pathname.split('/').filter((s) => s !== '');
            if (
              next.protocol !== 'https:' ||
              next.hostname !== 'open.spotify.com' ||
              segs.length !== 2 ||
              segs[0] !== 'playlist' ||
              !SPOTIFY_PLAYLIST_ID.test(segs[1])
            ) {
              mark(t0);
              return withCpu(jsonError(502, 'REDIRECT_NOT_ALLOWED', 'Redirect upstream ke luar halaman playlist', cors));
            }
            current = next.href;
          }
        }
        t0 = performance.now();
        if (upstream.status !== 200) {
          mark(t0);
          return withCpu(jsonError(502, 'UPSTREAM_ERROR', `Upstream mengembalikan HTTP ${upstream.status}`, cors));
        }
        const declared = Number(upstream.headers.get('Content-Length') || 0);
        if (declared > SPOTIFY_PAGE_CAP) {
          mark(t0);
          return withCpu(jsonError(502, 'UPSTREAM_TOO_BIG', 'Respons upstream melewati cap', cors));
        }
        const capped = await readCapped(upstream.body, SPOTIFY_PAGE_CAP);
        if (capped.tooBig) {
          mark(t0);
          return withCpu(jsonError(502, 'UPSTREAM_TOO_BIG', 'Respons upstream melewati cap', cors));
        }
        const resHeaders = new Headers(cors);
        resHeaders.set('Content-Type', 'text/html; charset=utf-8');
        resHeaders.set('X-Content-Type-Options', 'nosniff');
        mark(t0);
        return withCpu(new Response(capped.bytes, { status: 200, headers: resHeaders }));
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
        if (await checkRateLimit(env, `innertube:${ip}`, RATE_INNERTUBE_PER_MIN)) {
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
        if (await checkRateLimit(env, `innertube:${ip}`, RATE_INNERTUBE_PER_MIN)) {
          mark(t0);
          const r = jsonError(429, 'RATE_LIMITED', 'Terlalu banyak request, coba lagi sebentar', cors);
          r.headers.set('Retry-After', '60');
          return withCpu(r);
        }
        // Cap body 1 MB ditegakkan SELAMA membaca stream (Red 1 S1):
        // pola lama `arrayBuffer()` dulu lalu cek sudah terlambat —
        // body ratusan MB memenuhi memori isolate sebelum 413.
        // Content-Length dicek dulu sebagai penolakan cepat.
        const declaredLen = Number(request.headers.get('Content-Length') || 0);
        if (declaredLen > MAX_BODY_BYTES) {
          mark(t0);
          return withCpu(jsonError(413, 'BODY_TOO_BIG', 'Body request melewati 1 MB', cors));
        }
        let bodyBytes;
        if (request.body) {
          const read = await readCapped(request.body, MAX_BODY_BYTES);
          t0 = performance.now();
          if (read.tooBig) {
            mark(t0);
            return withCpu(jsonError(413, 'BODY_TOO_BIG', 'Body request melewati 1 MB', cors));
          }
          bodyBytes = read.bytes;
        } else {
          bodyBytes = new Uint8Array(0);
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

      // ---- /api/resolve-cache: cache URL stream di D1 (P3) ----
      // Mengapa di worker proxy, bukan sync: proxy SUDAH memegang
      // binding D1 + rate limit + validasi Origin yang sama, dan
      // cache adalah bagian dari jalur resolve (yang dilayani
      // proxy). Worker sync adalah soal akun/sinkronisasi; cache
      // URL publik tidak ada hubungannya dengan akun.
      //
      // GET ?videoId=... : dibaca app saat resolve langsung gagal.
      // Hanya entri yang BELUM kedaluwarsa yang dilayani
      // (expires_at > sekarang, difilter di SQL); app memeriksa
      // lagi di sisi client sebelum memutar. Entri hilang atau
      // kedaluwarsa -> 404 CACHE_MISS (bukan galat).
      // POST: hanya populator koordinator. Wajib header
      // X-Cache-Key == secret RESOLVE_CACHE_KEY (wrangler secret;
      // bila secret belum disetel, SEMUA tulis ditolak 503).
      // Body JSON: { videoId, streamUrl, itag, bitrate?, client,
      // title?, expiresAt, resolvedAt } (epoch detik). streamUrl
      // WAJIB https + *.googlevideo.com; expiresAt wajib di masa
      // depan dan <= 24 jam dari sekarang. Hasil gagal TIDAK
      // PERNAH di-cache (populator hanya mengirim hasil resolve
      // yang berhasil membawa format audio).
      if (url.pathname === '/api/resolve-cache') {
        if (request.method === 'GET') {
          const videoId = url.searchParams.get('videoId') || '';
          if (!VIDEO_ID_RE.test(videoId)) {
            mark(t0);
            return withCpu(jsonError(400, 'BAD_VIDEO_ID', 'videoId tidak valid (11 karakter)', cors));
          }
          if (await checkRateLimit(env, `cache:${ip}`, RATE_CACHE_READ_PER_MIN)) {
            mark(t0);
            const r = jsonError(429, 'RATE_LIMITED', 'Terlalu banyak permintaan, coba lagi sebentar', cors);
            r.headers.set('Retry-After', '60');
            return withCpu(r);
          }
          if (!env.DB) {
            mark(t0);
            return withCpu(jsonError(503, 'CACHE_UNAVAILABLE', 'Cache belum tersedia', cors));
          }
          mark(t0);
          const nowS = Math.floor(Date.now() / 1000);
          let row = null;
          try {
            row = await env.DB.prepare(
              'SELECT video_id, stream_url, itag, bitrate, client, title, expires_at, resolved_at ' +
              'FROM resolve_cache WHERE video_id = ? AND expires_at > ?',
            ).bind(videoId, nowS).first();
          } catch (e) {
            console.warn('resolve-cache GET: D1 gagal:', e instanceof Error ? e.message : 'unknown');
            mark(t0);
            return withCpu(jsonError(503, 'CACHE_UNAVAILABLE', 'Cache belum tersedia', cors));
          }
          t0 = performance.now();
          if (!row) {
            mark(t0);
            return withCpu(jsonError(404, 'CACHE_MISS', 'Tidak ada simpanan untuk lagu ini', cors));
          }
          const resHeaders = new Headers(cors);
          resHeaders.set('Content-Type', 'application/json');
          mark(t0);
          return withCpu(new Response(JSON.stringify({
            success: true,
            data: {
              videoId: row.video_id,
              streamUrl: row.stream_url,
              itag: row.itag,
              bitrate: row.bitrate,
              client: row.client,
              title: row.title,
              expiresAt: row.expires_at,
              resolvedAt: row.resolved_at,
            },
          }), { status: 200, headers: resHeaders }));
        }
        if (request.method === 'POST') {
          const secret = env.RESOLVE_CACHE_KEY || '';
          if (!secret) {
            mark(t0);
            return withCpu(jsonError(503, 'CACHE_WRITE_DISABLED', 'Tulis cache belum dikonfigurasi', cors));
          }
          if (!safeEqual(request.headers.get('X-Cache-Key') || '', secret)) {
            mark(t0);
            return withCpu(jsonError(401, 'UNAUTHORIZED', 'Kunci cache tidak valid', cors));
          }
          if (await checkRateLimit(env, `cache-write:${ip}`, RATE_CACHE_WRITE_PER_MIN)) {
            mark(t0);
            const r = jsonError(429, 'RATE_LIMITED', 'Terlalu banyak permintaan, coba lagi sebentar', cors);
            r.headers.set('Retry-After', '60');
            return withCpu(r);
          }
          if (!env.DB) {
            mark(t0);
            return withCpu(jsonError(503, 'CACHE_UNAVAILABLE', 'Cache belum tersedia', cors));
          }
          const declaredLen = Number(request.headers.get('Content-Length') || 0);
          if (declaredLen > CACHE_BODY_CAP) {
            mark(t0);
            return withCpu(jsonError(413, 'BODY_TOO_BIG', 'Body request melewati 8 KB', cors));
          }
          let bodyBytes;
          if (request.body) {
            const read = await readCapped(request.body, CACHE_BODY_CAP);
            t0 = performance.now();
            if (read.tooBig) {
              mark(t0);
              return withCpu(jsonError(413, 'BODY_TOO_BIG', 'Body request melewati 8 KB', cors));
            }
            bodyBytes = read.bytes;
          } else {
            bodyBytes = new Uint8Array(0);
          }
          let body;
          try {
            body = JSON.parse(new TextDecoder().decode(bodyBytes));
          } catch {
            mark(t0);
            return withCpu(jsonError(400, 'BAD_JSON', 'Body bukan JSON yang valid', cors));
          }
          const nowS = Math.floor(Date.now() / 1000);
          const videoId = typeof body?.videoId === 'string' ? body.videoId : '';
          const streamUrl = typeof body?.streamUrl === 'string' ? body.streamUrl : '';
          const itag = body?.itag;
          const bitrate = body?.bitrate ?? null;
          const client = typeof body?.client === 'string' ? body.client : '';
          const title = typeof body?.title === 'string' ? body.title : '';
          const expiresAt = body?.expiresAt;
          const resolvedAt = body?.resolvedAt;
          let urlOk = false;
          try {
            const dest = new URL(streamUrl);
            urlOk = dest.protocol === 'https:' && dest.hostname.endsWith('.googlevideo.com');
          } catch {
            urlOk = false;
          }
          if (
            !VIDEO_ID_RE.test(videoId) ||
            !urlOk ||
            !Number.isInteger(itag) || itag < 0 || itag > 9999 ||
            (bitrate !== null && (!Number.isInteger(bitrate) || bitrate < 0)) ||
            client.length === 0 || client.length > 32 ||
            title.length > 200 ||
            !Number.isInteger(expiresAt) || expiresAt <= nowS || expiresAt > nowS + CACHE_MAX_TTL_S ||
            !Number.isInteger(resolvedAt) || resolvedAt <= 0 || resolvedAt > nowS + 60
          ) {
            mark(t0);
            return withCpu(jsonError(400, 'BAD_ENTRY', 'Entri cache tidak valid', cors));
          }
          mark(t0);
          try {
            await env.DB.prepare(
              'INSERT OR REPLACE INTO resolve_cache ' +
              '(video_id, stream_url, itag, bitrate, client, title, expires_at, resolved_at) ' +
              'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            ).bind(videoId, streamUrl, itag, bitrate, client, title, expiresAt, resolvedAt).run();
            // Sapu oportunistik: hapus entri kedaluwarsa tiap
            // tulis (satu pernyataan, tabel kecil).
            await env.DB.prepare(
              'DELETE FROM resolve_cache WHERE expires_at <= ?',
            ).bind(nowS).run();
          } catch (e) {
            console.warn('resolve-cache POST: D1 gagal:', e instanceof Error ? e.message : 'unknown');
            mark(t0);
            return withCpu(jsonError(503, 'CACHE_UNAVAILABLE', 'Cache belum tersedia', cors));
          }
          t0 = performance.now();
          const resHeaders = new Headers(cors);
          resHeaders.set('Content-Type', 'application/json');
          mark(t0);
          return withCpu(new Response(JSON.stringify({ success: true }), { status: 200, headers: resHeaders }));
        }
        mark(t0);
        return withCpu(jsonError(405, 'METHOD_NOT_ALLOWED', 'Metode tidak diizinkan', cors));
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
