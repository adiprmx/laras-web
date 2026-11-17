# Worker proxy byte-only Laras Web (skeleton spike S7)

Proxy tipis antara browser dan YouTube/googlevideo. Dibangun karena spike
S2 membuktikan fetch langsung dari browser diblokir CORS (preflight
youtubei 403 tanpa header CORS; base.js 200 tanpa header CORS).

## Yang dilakukan worker

- Meneruskan POST player/search/browse/next/suggestions ke youtubei
  (menambah kunci API publik InnerTube di sisi server).
- Melayani base.js dengan gerbang hash allowlist SEBELUM fetch.
- Melayani byte audio untuk UNDUHAN saja (`/api/media`) dengan Range
  passthrough dan streaming bercap 100 MB. Streaming pemutaran TIDAK
  lewat proxy (langsung elemen audio ke googlevideo).

## Yang TIDAK dilakukan worker

- Tidak mengeksekusi base.js, tidak memecahkan cipher, tidak menyimpan
  data pengguna, tidak mencatat body atau URL stream.

## Batas

- JSON youtubei 10 MB, script player 8 MB, body POST 1 MB, media 100 MB.
- Timeout: InnerTube 30 dtk, base.js 90 dtk, media 120 dtk.
- Rate limit: 60/menit endpoint InnerTube, 10/menit media, per IP.
  Skeleton memakai bucket in-memory per isolate (best-effort);
  produksi WAJIB pindah ke D1 (arsitektur.md §4.1).
- CORS: hanya origin di `ALLOWED_ORIGINS`, bukan `*`.

## Deploy spike

Upload memakai API Cloudflare langsung (tanpa wrangler):

```
python3 ~/workspace/custom-connectors/custom.cloudflare-workers/bin/cfw_t.py \
  PUT "/accounts/05928ed4e4ed9643a5665d1e59315abe/workers/scripts/laras-proxy-spike" \
  -F 'metadata={"main_module":"index.js","bindings":[{"type":"plain_text","name":"ALLOWED_ORIGINS","text":"https://laras.adipmusic.my.id,http://127.0.0.1:4173,https://preview.laras-web.pages.dev"}]};type=application/json' \
  -F 'index.js=@workers/proxy/src/index.js;type=application/javascript+module'
```

URL spike: `https://laras-proxy-spike.hiroohengkerr.workers.dev`

## Ukur CPU

Header respons `x-proxy-cpu-ms` (khusus spike, dicabut di produksi)
mengukur jumlah waktu segmen sinkron handler, di luar tunggu jaringan.
Target: di bawah 10 ms per request (batas CPU free-tier Workers).
