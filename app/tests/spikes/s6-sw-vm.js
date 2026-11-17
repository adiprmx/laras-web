// Service Worker spike S6 — VARIAN VM untuk Tes B2.
// Sama dengan s6-sw.js, ditambah SATU workaround khusus VM: request Range
// terbuka (bytes=N-) ke googlevideo dibatasi menjadi 1 MiB
// (bytes=N-(N+1048575)). Alasan: dari IP VM, googlevideo membalas 403
// untuk Range terbuka dan untuk offset >= 1 MiB (terbukti curl, 17 Nov
// 2026), sehingga elemen media tidak pernah mendapat byte tanpa batas
// ini. Workaround ini HANYA untuk pembuktian di VM dan TIDAK masuk
// desain produksi (di IP residensial Range terbuka diharapkan jalan).
const MEDIA_CACHE = 'laras-media-spike-vm-v1';
const VM_RANGE_CAP = 1048576; // 1 MiB
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
      // Workaround VM: batasi Range terbuka ke 1 MiB untuk googlevideo.
      let netRequest = request;
      const isGv = url.hostname.endsWith('.googlevideo.com');
      const openMatch = /^bytes=(\d+)-$/.exec(rangeHeader);
      if (isGv && openMatch) {
        const start = parseInt(openMatch[1], 10);
        const end = start + VM_RANGE_CAP - 1;
        netRequest = new Request(request, {
          headers: { ...Object.fromEntries(request.headers.entries()), Range: `bytes=${start}-${end}` },
        });
      }
      const net = await fetch(netRequest);
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
