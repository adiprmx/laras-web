# Blue 1 — Perbaikan Red 1 (P0–P4)

**Tanggal:** 18 November 2026.
**Tim:** Blue 1 (perbaikan keamanan).
**Dasar:** `docs/red1-audit.md` (15 temuan: 0 kritis, 1 tinggi, 4 sedang,
6 rendah, 4 info) atas HEAD remote `debca8ad` (P4 + fix laporan spike).
**Hasil:** 1 tinggi + 4 sedang DITUTUP; 5 dari 6 rendah ditutup (R3
sebagian — lihat bawah); 2 dari 4 info ditutup, 2 ditunda dengan alasan.
Tidak ada fitur baru (scope freeze); tidak ada perubahan timeout solver
produksi (10 dtk) atau perilaku WAL (`persistence.ts`).

## Ringkasan verifikasi

| Gerbang | Hasil |
|---|---|
| Vitest | 301/301 lolos (21 file; 26 tes baru Blue 1) |
| Typecheck (`tsc -b`) | bersih |
| Lint (`./node_modules/.bin/eslint .`) | bersih |
| Build (`npm run build`) | lolos |
| Bundle awal gzip | 151.562 byte (batas 204.800; baseline P4 151.041) |
| Chunk `*TestPage*` di `dist/` | 0 (H1 terbukti) |
| Uji unit worker (`s7-unit-test.mjs`) | 17/17 lolos |
| Playwright E2E (chromium + mobile) | 107/116 (run 2 — bukti terbaik di VM; run 3 dibatalkan sandbox, lihat riwayat run di H1; CI adalah gerbang sah) |
| `npm audit` | TIDAK BISA jalan lokal (egress proxy VM memblokir endpoint audit npm, 403 `policy_denied`); gerbang ditambahkan di CI, run CI pertama adalah bukti sahnya |

---

## H1 (tinggi) — Halaman uji destruktif terkirim di build produksi

**Perbaikan:**
- `app/src/App.tsx`: rute `/library-test`, `/player-test`, `/p4-test`
  + lazy import-nya digerbang `import.meta.env.DEV`. Di build produksi
  `import.meta.env.DEV` adalah `false` literal dan Rollup menghapus
  cabang mati itu total — chunk `*TestPage*` tidak ada di `dist/`
  (terverifikasi: 0 chunk, dari 3 sebelumnya) dan rute-nya jatuh ke
  beranda (`parseRoute` juga digerbang).
- `.github/workflows/ci.yml`: langkah baru "Gerbang H1" di job `check`
  menggagalkan build bila `find dist/assets -name '*TestPage*.js'`
  menemukan apa pun.
- Pertahanan lapis kedua: tombol hapus database di `LibraryTestPage`
  dan `P4TestPage` kini konfirmasi dua langkah (ketukan pertama
  mengaktifkan mode konfirmasi, ketukan kedua baru menghapus).
  Tidak ada E2E yang mengklik tombol hapus, jadi tidak ada tes yang
  berubah perilakunya.

**PENGECUALIAN KOORDINATOR (mengikat): `/spike` BOLEH tetap di
produksi.** Itu alat verifikasi §5 yang dijalankan koordinator dari
preview, non-destruktif (hanya memutar lagu kanari + menyalin laporan),
bukan halaman uji destruktif. `SpikePage` tetap di-`lazy`-load tanpa
gerbang, chunk-nya tetap ada di `dist/` (`SpikePage-*.js`), dan gerbang
CI sengaja HANYA memeriksa `*TestPage*`. Pengecualian ini didokumentasi
di komentar `App.tsx`, di gerbang CI, dan di sini. JANGAN hapus `/spike`
di ronde berikut tanpa keputusan koordinator baru.

**Konsekuensi yang disengaja — E2E pindah ke server dev:**
Seeder E2E (`library.spec`, `player.spec`, `home.spec`, `p4-helpers`)
mengisi data lewat halaman uji, sehingga E2E TIDAK BISA lagi jalan
terhadap `vite preview` (build produksi). `playwright.config.ts` kini
menjalankan `npm run dev:e2e` (`vite --port 4173 --strictPort`, skrip
baru di `package.json`). Build produksi tetap diuji: gerbang H1 di CI
+ `tests/e2e/security.spec.ts` menyajikan `dist/` sendiri (lihat S2).
Job `e2e` CI tetap membangun dulu karena spesifikasi itu butuh `dist/`.
Tidak ada tes E2E di konfigurasi utama yang bergantung pada perilaku
khusus produksi (tidak ada tes SW di konfigurasi utama; SW hanya
terdaftar bila `import.meta.env.PROD`).

**Tiga konsekuensi dev-mode yang ditemukan dan diperbaiki Blue 1:**
1. **StrictMode double-effect (deterministik).** Di mode dev React
   menjalankan efek mount dua kali; efek muat Jelajah di
   `HomePage.tsx` memanggil `browseHome` dua kali sehingga tes
   "Jelajah di-cache" gagal deterministik (`counters.browse` = 2,
   diharapkan 1) — di produksi efek hanya jalan sekali. Diperbaiki
   dengan penjaga `useRef` di efek itu (muat sekali per mount;
   remount tetap memuat ulang lewat cache). Tes lain yang menghitung
   request (`search.spec.ts`) berbasis event, bukan efek — aman.
2. **Server dev lebih lambat dari preview.** Transformasi modul per
   permintaan membuat `page.goto` (menunggu `load`) melewati batas
   30 detik default di bawah beban paralel. `playwright.config.ts`
   kini memakai `timeout: 60000` + `expect: { timeout: 10000 }`.
   Ini memberi ruang untuk transformasi dingin, bukan menyembunyikan
   bug produk (tes yang benar-benar macet tetap gagal).
3. **Satu worker.** `workers: 1` (lokal maupun CI — CI memang sudah
   1): dua worker paralel + dua browser di CPU bersama membuat muat
   halaman melewati 60 detik (run 2: 3 timeout di 116 tes, semua
   `page.goto`/locator di bawah beban paralel). Serial lebih lambat
   tapi stabil; lokal kini == CI.

**Riwayat run suite penuh (jujur, termasuk run yang merah):**
- **Run 1** (02:28–02:41 UTC): 33 lolos / 79 gagal / 4 dilewati dari
  116 tes. Penyebab: timeout `page.goto` 30 detik di bawah beban
  paralel (server dev) + tes Jelajah StrictMode + gelombang EPERM
  (68 dari 79 file error-context tertulis 0 byte — artefak gagal
  ditulis sandbox). Pelajaran proses: perintah run memakai
  `| tail -30` sehingga exit code 0 yang terbaca adalah exit code
  `tail`, bukan Playwright — kegagalan nyaris tidak ketahuan.
  Run berikut memakai reporter JSON + exit code langsung.
- **Run 2** (02:48–03:09 UTC): 107 lolos / 4 gagal / 5 dilewati.
  3 gagal = timeout 60 detik beban paralel (home "Lihat semua"
  mobile, search "riwayat" chromium + mobile); 1 gagal = bug
  spesifikasi Blue 1 sendiri — tiga `expect(...).toHaveCount(0)`
  di `security.spec.ts` (tes H1) tanpa `await`, sehingga di bawah
  beban tes berakhir ("Test ended") sebelum expect selesai.
  Diperbaiki (tambah `await`; spesifikasi kini 12/12 di kedua
  proyek) + `workers: 1`.
- **Run 3** (03:11–03:27 UTC, serial): TIDAK VALID — dibatalkan
  oleh kondisi sandbox, BUKAN oleh kode. 76 direktori kegagalan
  (20 chromium + 56 mobile), kegagalan mengumpul di 5 menit
  terakhir run; 74 dari 76 file error-context tertulis 0 byte,
  reporter JSON 0 byte, `.last-run.json` 0 byte (gelombang EPERM
  aktif — tulis gagal diam-diam), dan `load average` VM terukur
  **11,40** pada 1,5 CPU bersama sesudah run (proses agen lain +
  daemon memakan CPU). Di bawah beban itu muat halaman yang biasa
  5–15 detik melampaui 60 detik. Dua file error yang sempat
  terbaca: timeout `page.goto` 60 detik + `element not found`
  (efek lanjutan kelambatan) — bukan assertion kegagalan produk.
  Upaya verifikasi terarah sesudah run 3 pun sempat gagal total
  karena gelombang EPERM kembali (server dev tidak bisa start,
  `npm error EPERM`, 03:28 UTC). **Keputusan:** suite penuh TIDAK
  BISA didorong hijau andal di VM ini pada sesi ini — CI
  (runner khusus, `workers: 1`, `retries: 2`) adalah gerbang
  sahnya, sesuai instruksi tugas bila Chromium gagal karena
  sandbox. Bukti terbaik dari VM ini adalah run 2 (107/116) +
  verifikasi terarah di bawah.
- **Verifikasi terarah sesudah perbaikan:** `security.spec.ts`
  12/12 (kedua proyek, sesudah perbaikan `await`); `home.spec.ts`
  + `smoke.spec.ts` 10/10 (chromium); tes "Jelajah di-cache"
  lolos sesudah penjaga StrictMode; uji ulang terarah 3 tes run-2
  (03:30 UTC) TIDAK VALID — server dev mati tengah run (`npm
  error EPERM`, 03:30 UTC) dan file error 0 byte (gelombang EPERM
  aktif). Tes-tes itu tidak pernah gagal dengan assertion
  kegagalan produk di run mana pun; seluruh kegagalannya adalah
  timeout muat / server mati di bawah kondisi sandbox.

**Bukti tes:** E2E `security.spec.ts` — rute uji jatuh ke beranda di
build produksi + nol request chunk `*TestPage*`; gerbang CI (langkah
baru); `ls dist/assets` 0 chunk `*TestPage*` sesudah build lokal.

## S1 (sedang) — Proxy baca body POST sampai habis sebelum cek cap 1 MB

**Perbaikan** (`workers/proxy/src/index.js`, cabang endpoint InnerTube):
- Body request kini dibaca lewat `readCapped(request.body,
  MAX_BODY_BYTES)` yang sudah ada — stream dibatalkan begitu total
  byte melewati cap, tanpa buffering penuh; `tooBig` → 413
  `BODY_TOO_BIG` (kode yang sama seperti sebelumnya).
- Penolakan cepat: `Content-Length` di atas cap ditolak sebelum
  membaca body sama sekali.
- POST tanpa body (`request.body === null`) ditangani eksplisit
  (body kosong, bukan crash).

**Bukti tes:** `app/tests/spikes/s7-unit-test.mjs` cek 3 (body 1 MB+7
byte → 413, jalur Content-Length) + cek 3b BARU (body stream 1,2 MB
tanpa Content-Length → 413, jalur `readCapped`). 17/17 cek lolos.

## S2 (sedang) — Tanpa CSP / security header

**Perbaikan:** `app/public/_headers` (baru; disalin Vite ke `dist/`):
- CSP sesuai rekomendasi Red 1: `default-src 'self'; script-src
  'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'
  <proxy spike> https://raw.githubusercontent.com; img-src 'self'
  <ytimg/googleusercontent/ggpht> blob: data:; media-src 'self'
  https://*.googlevideo.com blob:; style-src 'self' 'unsafe-inline';
  font-src 'self'; object-src 'none'; base-uri 'self';
  frame-ancestors 'none'; form-action 'none'`.
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`
  (arsitektur §6.2), `Referrer-Policy: no-referrer`.
- Dua penyimpangan dari rekomendasi Red 1, keduanya disengaja dan
  dicatat di file: (1) `img-src` memuat `blob:` sesuai arsitektur
  §6.2 (sampul lokal); (2) `X-Frame-Options: DENY` ditambahkan
  sesuai arsitektur §6.2 (pelengkap `frame-ancestors`).
- QuickJS-WASM memakai `'wasm-unsafe-eval'`, BUKAN `'unsafe-eval'`
  penuh (arsitektur §6). `style-src 'unsafe-inline'` dibutuhkan
  karena komponen memakai atribut `style={{...}}`.

**Catatan untuk P7:** saat lirik (LRCLIB) mendarat, `connect-src`
HARUS ditambah `https://lrclib.net` (dicatat di `_headers`).

**Bukti tes:** E2E `security.spec.ts` (6 tes, chromium + mobile) —
header CSP di respons dokumen sama persis dengan file `_headers`;
WebAssembly minimal terkompilasi di bawah CSP; worker solver
same-origin yang asli bisa dibuat; pemutar stream berputar dari
hasil pencarian (mock); `/spike` mulai + berhenti; nol pelanggaran
CSP di console selama semua navigasi itu. Catatan metode: Vite dev
menyuntikkan preamble React Refresh INLINE, sehingga CSP produksi
(tanpa `'unsafe-inline'` di script-src) mem-blank halaman di mode
dev — itu artefak dev, bukan cacat CSP. Karena itu seluruh uji CSP
dijalankan terhadap `dist/` (server statis di spesifikasi itu),
bukan terhadap server dev.

## S3 (sedang) — Rate limit proxy in-memory per isolate + bucket tanpa eviction

**Perbaikan:**
- `workers/sync/0002_ratelimit.sql` (baru): tabel `rate_limits
  (key, window_start, count)` + indeks `window_start` untuk sapu.
  Satu baris per (kunci, jendela menit selaras); kunci
  `innertube:<ip>` / `media:<ip>`.
- `workers/proxy/src/rateLimit.js` (baru): `isRateLimited(db, key,
  limit)` — UPSERT hitungan + SELECT (dua pernyataan SQLite dasar,
  sengaja tanpa `RETURNING` supaya tidak bergantung pada fitur D1
  yang belum terverifikasi dari VM) + sapu probabilistik baris
  kedaluwarsa (1% request; kegagalan sapu tidak mengubah vonis).
- `workers/proxy/src/index.js`: `buckets` in-memory + `rateLimited`
  DIHAPUS total; ketiga call site memakai `checkRateLimit(env, …)`
  yang fail-open: bila binding `DB` tidak ada atau D1 gagal,
  request DIIZINKAN dan kegagalan dicatat `console.warn` (tampil di
  log Cloudflare; kunci/IP tidak pernah dicatat). Peringatan
  "binding tidak ada" sekali per isolate.
- `workers/proxy/wrangler.toml`: binding `[[d1_databases]]`
  (`DB`, `laras-web-sync`, id `3a2cb6d6-…`).
- `workers/proxy/README.md`: perintah deploy diperbarui (binding D1
  di metadata) + langkah migrasi + peringatan bundling (lihat bawah).

**Biaya kuota D1:** 1 baris tulis + 1 baris baca per request proxy.
Tulis 100.000/hari seorde dengan kuota request Workers
(100.000/hari) — rate limit tidak menjadi bottleneck baru sebelum
kuota request itu sendiri. (KV tulis 1.000/hari tetap bukan opsi.)

**PERINGATAN BUNDLING — WAJIB dibaca koordinator sebelum redeploy:**
`index.js` kini mengimpor `./rateLimit.js`, tetapi perintah deploy
di README selama ini mengunggah SATU file (`index.js` saja).
Mengunggah satu file sekarang akan GAGAL (modul tidak ditemukan)
atau — lebih buruk — deploy worker lama bila unggahan ditolak.
Koordinator WAJIB menggabungkan kedua modul dulu (mis. `esbuild
workers/proxy/src/index.js --bundle --format=esm`, esbuild sudah
ada di `app/node_modules`) atau mengunggah multi-part sesuai API
Workers, lalu redeploy dengan binding `DB` di metadata. Langkah
lengkap ada di "Catatan redeploy proxy" di bawah.

**Bukti tes:** Vitest `app/src/worker/rateLimit.test.ts` (7 tes,
D1 palsu in-memory: batas 60 lolos/ke-61 ditolak, kunci terpisah,
reset jendela, lemparan D1 gagal, sapu + sapu-gagal-tidak-mengubah-
vonis); `s7-unit-test.mjs` cek 1–2 (60/70 + 10/12 429 lewat D1
palsu) + cek 7 BARU (tanpa binding DB → 200 fail-open). Perilaku
D1 ASLI (UPSERT, binding) HANYA bisa dibuktikan sesudah redeploy —
lihat langkah verifikasi di bawah.

## S4 (sedang) — Config remote tanpa cap 4 MB + tanpa cek versi skema

**Perbaikan:**
- `app/src/extractor/readCapped.ts` (baru): `readCappedText(res,
  cap)` — baca stream per chunk, batalkan saat cap terlampaui
  (port pola `readCapped` proxy); cek `Content-Length` dulu sebagai
  penolakan cepat; `ResponseTooBigError` bila melewati cap.
- `app/src/extractor/resolve.ts`:
  - `loadPlayerConfig` memakai `readCappedText(res,
    CONFIG_MAX_BYTES)` (4 MB, PRD B9.2) + `JSON.parse` — respons
    raksasa dibatalkan sebelum memenuhi memori. Gagal (cap/HTTP/
    parse) → nilai bawaan, seperti sebelumnya.
  - `parsePlayerConfig` kini memeriksa `root.version`:
    HANYA `1` diterima (`CONFIG_SCHEMA_VERSION`, `spike/config.ts`).
    Versi lain, versi bukan angka, atau tanpa field versi → `null`
    → fallback builtin. File live
    (`raw.githubusercontent.com/adiprmx/laras/config-v1/
    player-config.json`) terverifikasi berisi `"version": 1`.
  - `loadPlayerScript` memakai `readCappedText` 8 MB (R5, lihat bawah).
- Konstanta baru di `app/src/spike/config.ts`: `CONFIG_MAX_BYTES`,
  `INNERTUBE_MAX_BYTES`, `BASE_JS_MAX_BYTES`,
  `CONFIG_SCHEMA_VERSION`.

**Keputusan yang dicatat:** Red 1 menyarankan "tambahkan field
`schemaVersion` ke player-config.json", tetapi file itu hidup di
repo LAIN (`adiprmx/laras`, tag `config-v1`) — di luar repo ini dan
di luar cakupan Blue 1 — dan file itu SUDAH membawa nomor versi
skema (`version: 1`, sesuai PRD B9.1 "Nomor versi skema config ada
di file"). Blue 1 memvalidasi field `version` yang sudah ada,
bukan menambah field baru. Bila suatu hari skema berubah, penerbit
config menaikkan `version` dan app lama menolaknya (fallback
builtin) — perilaku yang diminta PRD B9.1. Cache "config terakhir
yang valid" (B9.2) adalah pekerjaan P6 (tombol "Periksa pembaruan"),
bukan Blue 1; fallback saat ini adalah builtin.

**Bukti tes:** Vitest `resolve.test.ts` — 6 tes baru (tolak versi
2/0/hilang/string; `loadPlayerConfig` memakai remote valid,
fallback builtin untuk versi 99, Content-Length > 4 MB, stream
> 4 MB, fetch gagal/HTTP 500) + `readCapped.test.ts` (6 tes:
body kecil, tolak cepat Content-Length, tolak stream, tepat di
cap, body null, UTF-8 terpotong antar chunk).

---

## Temuan rendah

| ID | Status | Perbaikan / alasan |
|---|---|---|
| R1 — `/api/media` ikuti redirect tanpa validasi ulang host | DIPERBAIKI | `workers/proxy/src/index.js`: `redirect: 'manual'`, maks 3 hop, tiap `Location` divalidasi (https + `*.googlevideo.com`), satu deadline 120 dtk untuk semua hop; kode galat baru `REDIRECT_NOT_ALLOWED` / `TOO_MANY_REDIRECTS` / `BAD_REDIRECT`. Content-Type yang diteruskan dibatasi `audio/*` / `video/*` / `application/octet-stream` (selain itu → 502 `UPSTREAM_BAD_TYPE`) + `X-Content-Type-Options: nosniff` di respons media. Bukti: `s7-unit-test.mjs` cek 6 (3 sub-cek). |
| R2 — `decodeURIComponent` tanpa try/catch → app blank | DIPERBAIKI | `App.tsx`: try/catch di `parseRoute` (segmen rusak → beranda); `BrowseShelves.tsx`: `encodeURIComponent(item.browseId)`; `main.tsx` + `components/ErrorBoundary.tsx` (baru): ErrorBoundary dengan layar "Terjadi kesalahan" + tombol Muat ulang / Ke beranda. Bukti: E2E `security.spec.ts` (`/browse/%E0%A4%A` → beranda, tidak blank). |
| R3 — SW cache-first tanpa revalidasi + versi manual | DIPERBAIKI SEBAGIAN | `app/public/sw.js`: navigasi kini network-first (cadangan cache saat offline); cache runtime hanya aset statis (`/assets/`, `/icons/`, manifest) — `/search?q=…` tidak lagi meng-cache salinan index.html; `CACHE_NAME` naik ke `laras-shell-v2` (wajib karena strategi berubah). **Ditunda:** penomoran versi cache otomatis dari versi build — butuh injeksi build-time (atau vite-plugin-pwa); SW disentuh lagi di P5 (cache media) dan itu titik yang tepat. Tidak ada tes otomatis SW (tidak ada harness SW di repo; Red 2 memverifikasi di preview). |
| R4 — CI: action tag `@v4`, tanpa `permissions`, tanpa `npm audit` | DIPERBAIKI | `.github/workflows/ci.yml`: ketiga action dipin ke SHA commit penuh (diambil dari GitHub API 18 Nov 2026: checkout `11d5960a…`, setup-node `49933ea5…`, upload-artifact `ea165f8d…`, masing-masing ujung tag v4); `permissions: contents: read` di level workflow; langkah `npm audit --audit-level=high` sebagai gerbang di job `check`. Catatan: audit TIDAK BISA diverifikasi lokal (endpoint audit npm diblokir egress proxy VM, 403 `policy_denied`) — run CI pertama adalah bukti sahnya; bila gerbang itu merah, itu temuan nyata, bukan alarm palsu. |
| R5 — Cap ukuran dicek sesudah body dibaca penuh (client) | DIPERBAIKI | `resolve.ts` base.js + `innertube.ts` (10 MB) kini memakai `readCappedText` yang sama dengan S4. `InnertubeError` mendapat kind baru `'too-big'` (dipetakan ke pesan pengguna di `resolve.ts`; di `searchService.ts` jatuh ke cabang galat HTTP umum). Bukti: Vitest `readCapped.test.ts` + `resolve.test.ts`. |
| R6 — Origin dev di konfigurasi CORS produksi | DIPERBAIKI | `workers/proxy/wrangler.toml`: `[vars]` produksi kini hanya `https://laras.adipmusic.my.id` + `https://preview.laras-web.pages.dev`; localhost:4173 pindah ke `[env.dev.vars]`. Worker spike yang sedang live memakai daftar dev (dipakai pengujian dari server dev); saat promosi ke proxy produksi, pakai daftar `[vars]`. Efek live menunggu redeploy koordinator (sama dengan S3). |

## Info

| ID | Status | Perbaikan / alasan |
|---|---|---|
| I1 — Header `x-proxy-cpu-ms` masih aktif | DITUNDA (sengaja) | Rekomendasi Red sendiri: "cabut saat promosi ke proxy produksi". Worker yang di-deploy saat ini MASIH worker spike (S7), dan header ini adalah instrumen ukurnya; mencabut sekarang membutakan pengukuran CPU pra-produksi. Dicabut saat promosi produksi. |
| I2 — Allowlist hash player di-hardcode | DITUNDA (sengaja) | Membaca hash dari config remote (KV/D1) butuh keputusan desain (sumber + TTL + perilaku saat fetch gagal) dan menambah subrequest + jalur gagal ke worker — bukan perbaikan "murah dan aman". Ini risiko ketersediaan, bukan keamanan langsung; rotasi hash ditangani S4 di sisi client + sinkronisasi saat deploy (hash di `index.js` + `BUILTIN_HASHES` + config remote adalah tiga salinan yang sama per 18 Nov 2026). |
| I3 — Track lokal tanpa validasi skema URL | DIPERBAIKI | `player/port.ts`: `isSafeLocalUrl()` (blob same-origin atau http(s) same-origin, termasuk path relatif) + `load()` melempar untuk URL lokal host asing; `player/service.ts`: titik choke di cabang lokal — validasi SEBELUM `decidePath` (yang me-fetch URL untuk probe CORS), gagal → `onResolveFailed` (status error, bukan gantung loading). Mencakup jalur `port.load(url, 'stream')` untuk track lokal non-graph. Bukti: Vitest `player/port.test.ts` (7 tes). |
| I4 — Sourcemap dikirim di `dist/` | TIDAK ADA TINDAKAN | Red sendiri menyatakan ini BUKAN temuan (repo GPL publik, sumber terbuka). Dicatat supaya tidak dianggap temuan di ronde berikut. |

---

## File yang diubah / ditambah

**Baru:** `app/public/_headers`, `app/src/extractor/readCapped.ts`,
`app/src/extractor/readCapped.test.ts`, `app/src/components/ErrorBoundary.tsx`,
`app/src/player/port.test.ts`, `app/src/worker/rateLimit.test.ts`,
`app/tests/e2e/security.spec.ts`, `workers/proxy/src/rateLimit.js`,
`workers/proxy/src/rateLimit.d.ts`, `workers/sync/0002_ratelimit.sql`,
`docs/blue1-red1-fixes.md` (dokumen ini).

**Diubah:** `app/src/App.tsx`, `app/src/main.tsx`,
`app/src/extractor/resolve.ts`, `app/src/extractor/resolve.test.ts`,
`app/src/extractor/innertube.ts`, `app/src/spike/config.ts`,
`app/src/player/port.ts`, `app/src/player/service.ts`,
`app/src/components/browse/BrowseShelves.tsx`,
`app/src/components/home/HomePage.tsx` (penjaga StrictMode muat Jelajah),
`app/src/test-pages/LibraryTestPage.tsx`,
`app/src/test-pages/P4TestPage.tsx`, `app/public/sw.js`,
`app/package.json` (skrip `dev:e2e`), `app/playwright.config.ts`,
`app/playwright.spikes.config.ts` (komentar),
`app/tests/e2e/spike.spec.ts` (komentar),
`app/tests/spikes/s7-unit-test.mjs` (+ FakeD1, cek 3b/6/7),
`workers/proxy/src/index.js`, `workers/proxy/wrangler.toml`,
`workers/proxy/README.md`, `.github/workflows/ci.yml`, `CHANGELOG.md`.

**Tidak disentuh:** `~/workspace/music-app/` (APK),
`app/src/player/persistence.ts` (WAL), timeout solver (10 dtk),
`app/src/test-pages/PlayerTestPage.tsx` (tidak punya tombol destruktif).

## Catatan redeploy proxy (untuk koordinator — Blue TIDAK deploy)

1. **Jalankan migrasi D1** (database `laras-web-sync`):
   `wrangler d1 execute laras-web-sync --file=workers/sync/0002_ratelimit.sql`
   (atau setara via API). Verifikasi tabel `rate_limits` ada.
2. **Bundle worker** (WAJIB — `index.js` kini mengimpor
   `./rateLimit.js`; unggah satu file akan gagal):
   `esbuild workers/proxy/src/index.js --bundle --format=esm --outfile=/tmp/laras-proxy-bundle.js`
   (esbuild ada di `app/node_modules/.bin/esbuild`).
3. **Redeploy** dengan perintah di `workers/proxy/README.md` (sudah
   diperbarui: metadata memuat binding D1 `{"type":"d1","name":"DB",
   "database_id":"3a2cb6d6-5481-42a1-b213-070215cd2ce5"}` + file bundle
   sebagai `index.js`).
4. **Verifikasi live:**
   - 61 POST cepat `/api/innertube/player` dari satu IP → 60 lolos +
     1× 429 (`Retry-After: 60`); baris `rate_limits` muncul di D1.
   - POST body > 1 MB → 413 `BODY_TOO_BIG`.
   - `/api/media` dengan redirect upstream ke host luar allowlist →
     502 `REDIRECT_NOT_ALLOWED` (sulit dipicu live; bukti utama
     adalah uji unit worker 17/17).
   - Cek log worker: TIDAK ADA warning "binding D1 (DB) tidak ada"
     (warning itu berarti binding tidak terbawa redeploy → rate
     limit nonaktif fail-open).
5. **Catatan:** sampai redeploy ini jalan, proxy live MASIH memakai
   kode lama (rate limit in-memory, body dibaca penuh, redirect
   follow). Perbaikan S1/S3/R1/R6 di repo belum berlaku di worker
   live. `/spike` di preview memakai proxy live — perilakunya tidak
   berubah oleh redeploy ini kecuali rate limit kini antar-isolate.

## Yang masih terbuka untuk Red 2

- Verifikasi live S3 (rate limit bertahan antar isolate) + S1
  (body > 1 MB → 413 tanpa OOM) sesudah redeploy koordinator.
- Header CSP live di preview (Pages menyajikan `_headers`; uji E2E
  di sini memakai server statis lokal yang meniru Pages, bukan
  Pages asli).
- SW R3 (network-first navigasi) di preview + keputusan penomoran
  versi cache otomatis (P5).
- I1 (cabut `x-proxy-cpu-ms`) + I2 (hash dari config remote) saat
  promosi proxy produksi.
- Gerbang `npm audit` di run CI pertama (tidak bisa dicek lokal).
