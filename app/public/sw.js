// Service Worker Laras Web — P0: shell saja.
// P5 memperluas ke cache media + unduhan (tergantung vonis spike S6).
//
// Strategi (diperbaiki Red 1 R3):
// - Navigasi (index.html): network-first — pengguna selalu dapat
//   shell terbaru bila online; cache hanya cadangan saat offline.
//   Pola lama cache-first membuat pengguna terjebak di shell lama
//   (termasuk shell berkode yang sudah diperbaiki di server) sampai
//   versi cache dinaikkan manual.
// - Aset statis (/assets/, /icons/, manifest): cache-first —
//   nama file-nya ber-hash build, jadi isinya tidak pernah basi.
// - GET same-origin lain (mis. /search?q=...): TIDAK di-cache
//   runtime — pola lama meng-cache salinan index.html per URL.
// Versi cache dinaikkan manual tiap rilis yang mengubah shell/SW;
//   otomatisasi dari versi build ditunda ke P5 (butuh injeksi
//   build-time; lihat docs/blue1-red1-fixes.md R3).
const CACHE_NAME = 'laras-shell-v2';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
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

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Lintas origin: jangan disentuh SW P0.
  if (url.origin !== self.location.origin) return;

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
