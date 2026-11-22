# Modul bersama worker Laras (P-Shared, 22 Nov 2026)

Satu sumber kebenaran untuk kode yang dipakai KEDUA worker live
(`laras-proxy-spike` dan `laras-sync`). Sebelum P-Shared, helper ini
diduplikasi verbatim di `workers/proxy/src/index.js` dan
`workers/sync/src/index.js` — drift sudah terjadi (mis. `nosniff`
hanya di sync).

## Isi

| Modul | Isi |
|---|---|
| `http.js` | `MAX_BODY_BYTES`, `parseAllowedOrigins`, `corsHeaders`, `jsonError`, `readCapped` |
| `log.js` | `logJson`, `logWarn`, `logInfo` (log JSON P-Health), `newRequestId`, `checkDb` |
| `rateLimit.js` (+ `rateLimit.d.ts`) | `isRateLimited`, `windowStartFor`, `sweepExpiredWindows`, `checkRateLimit` (fail-open), `MAX_WINDOW_MS`, `SWEEP_PROBABILITY` |

`rateLimit.js` sebelumnya tinggal di `proxy/src/` dan diimpor sync
lewat path lintas worker yang rapuh — kini di sini.

## Aturan

- **Impor searah:** worker mengimpor dari `shared/`; `shared/` TIDAK
  BOLEH mengimpor dari `proxy/` atau `sync/` (tidak ada dependensi
  balik).
- **Deploy membundel:** kedua skrip deploy memakai esbuild `--bundle`
  (`hidden_files/koordinator/deploy_proxy.py`, `deploy_sync.py`),
  jadi impor relatif `../../shared/...` aman. JANGAN upload file
  worker mentah tanpa bundel.
- **Perbedaan yang disengaja:** `corsHeaders(env, request,
  { credentials: true })` hanya dipakai sync (cookie sesi); proxy
  memanggil tanpa opsi. `jsonError` selalu membawa `nosniff`
  (dulu hanya sync — pengetatan keamanan, tanpa perubahan perilaku
  klien). `WORKER_VERSION` sengaja TIDAK dibagi — versi per worker
  (naik independen saat perilaku satu worker berubah).
- **Tes:** `app/src/worker/rateLimit.test.ts` mengimpor
  `shared/rateLimit.js` langsung; tes worker lain
  (`syncWorker.test.ts`, `proxyHealth.test.ts`, `spotifyProxy.test.ts`)
  menguji perilaku lewat kedua worker — hijau = bukti no-regression
  ekstraksi ini.
