// Service Worker Laras Web (P5: shell + unduhan + runtime).
//
// Strategi:
// - Navigasi (index.html): network-first — pengguna selalu dapat
//   shell terbaru bila online; cache hanya cadangan saat offline.
// - Aset statis (/assets/, /icons/, manifest): cache-first —
//   nama file-nya ber-hash build, jadi isinya tidak pernah basi.
// - GET same-origin lain: TIDAK di-cache runtime.
// - Unduhan (/dl/<videoId>): dilayani dari cache unduhan dengan
//   potong Range manual (pola S6: respons 206 dari blob yang
//   tersimpan). Cache unduhan TIDAK PERNAH dihapus eviction maupun
//   pembersihan aktivasi (K9) — penghapusannya hanya lewat aksi
//   hapus eksplisit pengguna di layar Penyimpanan.
//
// Penomoran versi (utang Blue 1 R3, ditutup P5): placeholder
// `__LARAS_SW_VERSION__` diganti plugin Vite saat build dengan
// `<versi package.json>-<hash 8 karakter isi file ini>`, jadi
// tiap perubahan SW otomatis menaikkan versi cache shell tanpa
// bump manual. Di mode dev (tanpa build) placeholder tetap
// literal dan sah sebagai nama cache.
//
// NAMA CACHE (satu sumber kebenaran di
// `src/downloads/constants.ts`; tes `sw.test.ts` memaksa kedua
// salinan tetap sama):
// - `laras-shell-<versi build>`: shell app (berversi build).
// - `laras-downloads-v1`: file unduhan (STABIL lintas build —
//   unduhan adalah data pengguna, tidak boleh yatim saat update).
// - `laras-runtime-v1`: cache runtime (streaming, pasca-P5).
const SW_VERSION = '__LARAS_SW_VERSION__';
const CACHE_NAME = `laras-shell-${SW_VERSION}`;
const DOWNLOADS_CACHE_NAME = 'laras-downloads-v1';
const RUNTIME_CACHE_NAME = 'laras-runtime-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

/**
 * Cache yang TIDAK PERNAH dihapus saat aktivasi. Satu-satunya
 * anggota: cache unduhan (K9). Eviction runtime juga tidak
 * pernah menyentuhnya (jalur kode terpisah di downloadStore).
 */
function isProtectedCache(cacheName) {
  return cacheName === DOWNLOADS_CACHE_NAME;
}

/**
 * Cache yang boleh dihapus saat aktivasi bila bukan versi saat
 * ini: shell lama dan runtime lama. Cache unduhan tidak pernah
 * masuk daftar ini.
 */
function isDeletableOnActivate(cacheName) {
  if (isProtectedCache(cacheName)) return false;
  if (cacheName === CACHE_NAME) return false;
  if (cacheName === RUNTIME_CACHE_NAME) return false;
  return (
    cacheName.startsWith('laras-shell-') ||
    cacheName.startsWith('laras-runtime-')
  );
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter(isDeletableOnActivate).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Aset statis yang aman di-cache runtime: nama file ber-hash build
// (Vite) atau ikon/manifest yang hanya berubah tiap rilis.
function isCacheableAsset(url) {
  return (
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.webmanifest'
  );
}

/**
 * Tipe konten yang boleh disajikan untuk unduhan (R8, Red 2):
 * audio/*, video/*, atau application/octet-stream. Tipe lain
 * (mis. text/html dari upstream yang lolos ke cache) diganti
 * application/octet-stream supaya navigasi ke /dl/<id> tidak
 * pernah me-render HTML same-origin (stored XSS lewat cache
 * unduhan). Cerminan `safeDownloadContentType` di
 * `src/downloads/downloadStore.ts` — SW tidak bisa mengimpor
 * modul itu, jadi kedua salinan harus tetap sama (tes
 * downloadStore.test.ts + sw.test.ts memaksanya dengan kasus
 * yang sama).
 */
function safeDownloadContentType(contentType) {
  const type = (contentType || '').split(';')[0].trim().toLowerCase();
  if (
    type.startsWith('audio/') ||
    type.startsWith('video/') ||
    type === 'application/octet-stream'
  ) {
    return contentType;
  }
  return 'application/octet-stream';
}

/** Parse header Range (`bytes=start-end`, `bytes=start-`, `bytes=-n`). */
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  if (match[1] === '' && match[2] === '') return null;
  let start;
  let end;
  if (match[1] === '') {
    // Suffix range: N byte terakhir.
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      return null;
    }
    if (start > end || start >= size) return null;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

/**
 * Layani file unduhan dari cache unduhan. Tanpa Range: respons
 * utuh (200). Dengan Range: potong blob dan balas 206 manual
 * (pola S6 — elemen <audio> butuh Range untuk seek).
 *
 * Content-Type tersimpan TIDAK PERNAH dipercaya apa adanya
 * (R8, Red 2): tipe dipaksa ke audio/*, video/*, atau
 * application/octet-stream, dan setiap respons unduhan membawa
 * `X-Content-Type-Options: nosniff` supaya browser tidak
 * menebak tipe dari isi (stored XSS lewat cache unduhan).
 * Respons 200 dibangun ulang dari stream tersimpan (tanpa
 * buffering seluruh file ke memori); respons 206 sudah
 * membangun header baru dari potongan blob.
 */
async function serveDownload(request) {
  const cache = await caches.open(DOWNLOADS_CACHE_NAME);
  const cached = await cache.match(request);
  if (!cached) {
    return new Response('Lagu tidak ditemukan', { status: 404 });
  }
  const range = request.headers.get('Range');
  if (!range) {
    const headers = new Headers(cached.headers);
    headers.set(
      'Content-Type',
      safeDownloadContentType(cached.headers.get('Content-Type') || ''),
    );
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(cached.body, { status: cached.status, headers });
  }
  const blob = await cached.blob();
  const parsed = parseRange(range, blob.size);
  if (!parsed) {
    return new Response('Range tidak valid', {
      status: 416,
      headers: { 'Content-Range': `bytes */${blob.size}` },
    });
  }
  const slice = blob.slice(parsed.start, parsed.end + 1);
  const headers = new Headers(cached.headers);
  headers.set(
    'Content-Type',
    safeDownloadContentType(cached.headers.get('Content-Type') || ''),
  );
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Length', String(slice.size));
  headers.set(
    'Content-Range',
    `bytes ${parsed.start}-${parsed.end}/${blob.size}`,
  );
  headers.set('Accept-Ranges', 'bytes');
  return new Response(slice, { status: 206, headers });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Lintas origin: jangan disentuh SW.
  if (url.origin !== self.location.origin) return;

  // File unduhan: dari cache unduhan, dengan dukungan Range.
  // Part (`/dl-part/...`) TIDAK dilayani: internal manajer saja.
  if (url.pathname.startsWith('/dl/')) {
    event.respondWith(serveDownload(request));
    return;
  }

  // Navigasi: network-first, cadangan cache saat offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match('/index.html'))),
    );
    return;
  }

  // Aset statis: cache-first. Selain itu: jaringan saja, tanpa cache.
  if (!isCacheableAsset(url)) return;
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          // Hanya cache respons OK (bukan redirect/error).
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
