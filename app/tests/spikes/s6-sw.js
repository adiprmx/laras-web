// Service Worker spike S6 — cache media opaque + Range.
// Desain yang diuji:
//  1. Request media tanpa Range: cache-first; bila miss, fetch no-cors
//     (respons opaque), simpan utuh, kembalikan.
//  2. Request media dengan Range: kunci cache sintetis "url#range=a-b"
//     (Cache API hanya mencocokkan URL, bukan header Range); bila miss,
//     teruskan request apa adanya ke jaringan, simpan respons 206 opaque
//     di bawah kunci sintetis, kembalikan.
//  3. Bila offline dan Range tidak ada di cache tetapi file utuh ada,
//     kembalikan file utuh (200) dan biarkan elemen media mencari di
//     dalam byte yang sudah diterimanya.
//  4. Pesan "inspect" membuktikan apakah body respons opaque bisa dibaca
//     SW (menentukan bisa-tidaknya slicing 206 manual dari cache).
const MEDIA_CACHE = 'laras-media-spike-v1';
const MEDIA_ORIGINS = ['http://127.0.0.1:4181', 'https://rr1---sn-a5meknzr.googlevideo.com'];
const MEDIA_HOST_SUFFIX = '.googlevideo.com';

function isMediaRequest(url) {
  if (url.origin === 'http://127.0.0.1:4181') return true;
  return url.hostname.endsWith(MEDIA_HOST_SUFFIX);
}

function rangeKey(url, rangeHeader) {
  // Kunci sintetis memakai query param: fragmen (#) DIHAPUS dari URL
  // Request sehingga tidak bisa dipakai sebagai pembeda kunci cache.
  const sep = url.search ? '&' : '?';
  return `${url.href}${sep}__laras_range=${encodeURIComponent(rangeHeader)}`;
}

function parseRange(rangeHeader, total) {
  const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader || '');
  if (!m) return null;
  const start = m[1] ? parseInt(m[1], 10) : 0;
  const end = m[2] ? parseInt(m[2], 10) : total - 1;
  return { start, end };
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const { type } = event.data || {};
  if (type === 'inspect') {
    (async () => {
      const cache = await caches.open(MEDIA_CACHE);
      const keys = await cache.keys();
      const info = [];
      let bodyReadable = 'belum diuji';
      for (const req of keys) {
        const res = await cache.match(req);
        info.push({ key: req.url, status: res ? res.status : null, type: res ? res.type : null });
        if (res && bodyReadable === 'belum diuji') {
          try {
            const buf = await res.clone().arrayBuffer();
            bodyReadable = `bisa dibaca, ${buf.byteLength} byte`;
          } catch (e) {
            bodyReadable = `TIDAK bisa dibaca: ${e.name}: ${e.message}`;
          }
        }
      }
      event.ports[0].postMessage({ keys: info, bodyReadable });
    })();
  }
  if (type === 'clear') {
    caches.delete(MEDIA_CACHE).then(() => event.ports[0].postMessage({ cleared: true }));
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (!isMediaRequest(url)) return;

  event.respondWith((async () => {
    const cache = await caches.open(MEDIA_CACHE);
    const rangeHeader = request.headers.get('Range');

    if (rangeHeader) {
      // 1. Cari entri Range persis.
      const ranged = await cache.match(rangeKey(url, rangeHeader));
      if (ranged) return ranged;
      // 2. Bila file utuh ada, kembalikan utuh (200) untuk dicari di dalamnya.
      const full = await cache.match(url.href);
      if (full) return full;
      // 3. Teruskan ke jaringan, simpan 206 opaque di bawah kunci Range.
      const net = await fetch(request);
      if (net.status === 206 || net.ok || net.type === 'opaque') {
        await cache.put(rangeKey(url, rangeHeader), net.clone());
      }
      return net;
    }

    // Tanpa Range: cache-first file utuh.
    const cached = await cache.match(url.href);
    if (cached) return cached;
    const net = await fetch(request);
    if (net.ok || net.type === 'opaque') {
      await cache.put(url.href, net.clone());
    }
    return net;
  })());
});
