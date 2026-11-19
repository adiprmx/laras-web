# Blue 2 — Perbaikan Red 2 (P5 + P6)

**Tanggal:** 19 November 2026.
**Tim:** Blue 2 (perbaikan keamanan).
**Dasar:** `docs/red2-audit.md` (10 temuan: 0 kritis, 0 tinggi, 1 sedang,
3 rendah, 6 info) atas workdir per 19 Nov 2026 (sesudah perbaikan
koordinator commit 9399e922).
**Hasil:** 1 sedang + 3 rendah DITUTUP; 3 dari 6 info ditutup (I5-I7),
3 ditunda dengan alasan (I8-I10, pola Blue 1). Tidak ada fitur baru;
tidak ada perubahan perilaku produk di luar temuan; tidak ada tes
yang dilonggarkan. JANGAN push / deploy — itu langkah koordinator.

## Catatan keadaan saat Blue 2 mulai

Percobaan Blue 2 pertama (spawn sebelum reboot VM 17) SUDAH menulis
kode perbaikan S5, R7, R9, I5, I6, dan I7 ke workdir (file diubah
19 Nov 00:10–00:11 WIB) plus helper `safeDownloadContentType` di
`downloadStore.ts` — tetapi TIDAK sempat menulis tes regresi apa
pun, TIDAK menyambung R8 (helper ada, `putDownload` belum memakainya,
`sw.js` belum disentuh), dan TIDAK menulis laporan. Blue 2 (sesi
ini) memverifikasi tiap perbaikan yang sudah ada itu baris per baris
terhadap rekomendasi Red 2, menyambung R8 sampai tuntas, dan menulis
SELURUH tes regresi (24 tes baru). Tidak ada kode perbaikan pertama
yang perlu diubah — semuanya sudah sesuai rekomendasi; yang Blue 2
tambahkan adalah R8 + semua tes + dokumen ini.

## Ringkasan verifikasi

| Gerbang | Hasil |
|---|---|
| Vitest | 478/478 lolos (34 file; 24 tes baru Blue 2; baseline 454/454) |
| Typecheck (`tsc -p tsconfig.app.json --noEmit` + `tsc -p tsconfig.node.json --noEmit`) | 0 error |
| Lint (`eslint` pada 10 file yang diubah) | 0 warning |
| Build (`node build-api.mjs`, jalan keluar TERBATAS) | lolos |
| Bundle awal gzip (hanya JS+CSS yang dirujuk index.html) | 169.612 byte (batas 204.800; P6 163.336) |
| Chunk `*TestPage*` di `dist/` | 0 (H1 bertahan) |
| Playwright E2E `downloads.spec.ts` (chromium) | 8/8 lolos (4,1 mnt; termasuk K8 putar offline + K9 eviction + aktivasi SW) |
| `npm audit` | TIDAK BISA jalan lokal (egress proxy VM memblokir endpoint audit npm, 403 `policy_denied`, sama seperti Blue 1 / Red 2); CI adalah bukti sahnya |

---

## S5 (sedang) — `JSON.parse` cache config tanpa try/catch: satu entri rusak mematikan app permanen

**Perbaikan** (`app/src/resilience/configStore.ts`):
- Fungsi baru `parseConfigText(text)` — `JSON.parse` + `parsePlayerConfig`
  dalam satu try/catch, mengembalikan `null` (bukan melempar) untuk teks
  bukan JSON maupun JSON yang gagal validasi skema. Dipakai KETIGA jalur
  yang mem-parse teks config (cache memori, cache tersimpan, fetch segar)
  supaya perlakuannya identik.
- Jalur cache tersimpan (`loadFresh`): teks rusak diperlakukan sebagai
  "tidak ada cache" (lanjut ke fetch remote / builtin) DAN entrinya
  dihapus best-effort (`deletePersisted`, via `storage.delete` yang
  sudah ada di interface `KeyValueStorage`) supaya restart berikut tidak
  membaca racun yang sama. Tanpa penghapusan ini, app mati permanen
  karena lemparan terjadi SEBELUM fetch dan `writePersisted`.
- Jalur cache memori: teks rusak (tidak mungkin secara konstruksi —
  memori hanya diisi dari teks yang sudah lolos parse) membuang memori
  dan lanjut seperti tidak ada cache memori, bukan menolak.
- Tidak ada perubahan pada rantai fallback selain ini: TTL, rate limit
  5 menit, single-flight, dan deteksi perubahan dari isi tidak disentuh.

**Bukti tes** (`configStore.test.ts`, 6 tes baru):
- Cache tersimpan berisi teks bukan JSON + fetch gagal → `load()`
  resolve ke builtin (BUKAN menolak `SyntaxError` seperti reproduksi
  Red 2) dan entri rusak terhapus (`storage.get` → null).
- Cache tersimpan berisi JSON gagal validasi skema (versi 99) → sama.
- Cache tersimpan rusak + remote sehat → remote dipakai, dan loader
  baru (simulasi restart) dengan fetch gagal memakai cache valid
  penggantinya — racun terganti, bukan bertahan.
- `parseConfigText`: teks bukan JSON → null; JSON gagal skema → null;
  teks valid → hasil parse.
- Catatan cabang memori: tidak ada jalur API publik yang bisa membuat
  `memory.text` rusak (memori hanya diisi dari teks yang sudah lolos
  parse), jadi cabang "memory rusak" tidak terjangkau secara konstruksi
  dan tidak bisa diuji end-to-end — yang diuji adalah fungsi parse
  yang dipakai cabang itu (`parseConfigText`, di atas). Dicatat di
  komentar akhir `configStore.test.ts`.

## R7 (rendah) — Re-resolve di tengah unduhan tidak memeriksa itag

**Perbaikan** (`app/src/downloads/downloadManager.ts`):
- Itag awal dicatat saat job mulai (`currentItag = resolved.itag`).
  `reResolve` membandingkan `fresh.itag` dengan itag job; bila berbeda,
  melempar `ItagChangedError` baru (membawa URL + itag baru). Galat ini
  TIDAK ditangkap `downloadChunked` (lemparan `reResolve` terjadi di
  dalam blok `catch` loop retry, jadi lolos langsung ke pemanggil) —
  sampai ke loop restart di `runJob`.
- Restart (sekali per job): SEMUA part lama dihapus, unduhan mulai ulang
  dari byte 0 dengan URL + format baru, progres di-reset. Perubahan
  itag kedua menggagalkan job dengan pesan jelas
  ("Format lagu berubah saat mengunduh. Coba lagi nanti.") — tidak ada
  loop restart tanpa batas.
- `formatId` yang disimpan memakai `currentItag` (itag akhir yang
  benar-benar diunduh), bukan itag awal.
- Pilihan restart-dari-0 (bukan gagalkan langsung) mengikuti rekomendasi
  Red 2: paling aman untuk integritas file DAN paling baik untuk
  pengguna (unduhan tetap selesai dengan format baru, bukan gagal).

**Bukti tes** (`downloadManager.test.ts`, 2 tes baru, fixture format
kedua 1.800 byte pola berbeda + fetch per-URL yang bisa "mematikan"
satu URL sesudah N request):
- Re-resolve beda itag → file akhir 100% format baru (byte-demi-byte
  sama dengan fixture B, BUKAN campuran), `formatId` 140, URL baru
  diunduh dari byte 0 (`bytes=0-999`, `bytes=1000-1799`).
- Itag berubah dua kali → job gagal dengan pesan "Format lagu berubah",
  tanpa file unduhan, tanpa loop.

## R8 (rendah) — SW menyajikan unduhan dengan Content-Type tersimpan apa adanya

**Perbaikan:**
- `app/public/sw.js` — fungsi baru `safeDownloadContentType` (cerminan
  helper di `downloadStore.ts`; SW tidak bisa mengimpor modul TS):
  `audio/*`, `video/*`, `application/octet-stream` dipertahankan,
  sisanya diganti `application/octet-stream`. `serveDownload` kini:
  - Jalur 200 (tanpa Range): TIDAK LAGI `return cached` — membangun
    respons baru dari stream tersimpan (`new Response(cached.body, …)`,
    tanpa buffering seluruh file ke memori) dengan Content-Type yang
    dipaksa aman + `X-Content-Type-Options: nosniff`.
  - Jalur 206 (Range): header salinan ikut dipaksa aman + `nosniff`
    (sebelumnya hanya `Content-Length`/`Content-Range`/`Accept-Ranges`).
  - Respons 404/416 tidak berubah (sudah `text/plain` default, aman
    menurut audit).
- `app/src/downloads/downloadStore.ts` — `putDownload` kini menerapkan
  `safeDownloadContentType` (helper-nya sudah ditulis percobaan
  pertama tetapi belum dipakai) sebelum `cache.put`: tipe non-media
  tidak pernah masuk cache. Pertahanan lapis kedua sesuai rekomendasi
  Red 2; lapis pertama tetap di SW (melindungi entri lama yang sudah
  tersimpan sebelum perbaikan ini).
- Catatan soal rumusan tugas ("berdasarkan format/itag tersimpan"):
  cache unduhan TIDAK menyimpan itag — satu-satunya info format yang
  tersedia bagi SW adalah header Content-Type tersimpan. Perbaikan ini
  mengikuti rekomendasi audit (allowlist atas Content-Type tersimpan),
  yang juga merupakan rumusan helper yang sudah ada. Tidak ada metadata
  itag yang ditambahkan ke cache (di luar cakupan temuan).

**Bukti tes** (9 tes baru):
- `downloadStore.test.ts` (4): `safeDownloadContentType` mempertahankan
  audio/video/octet-stream (termasuk parameter `; codecs=opus` dan
  huruf besar) dan mengganti `text/html`/`application/json`/kosong;
  `putDownload` dengan `text/html` menyimpan `application/octet-stream`
  (dibaca langsung dari respons cache), `audio/webm` tersimpan apa adanya.
- `sw.test.ts` (5): SATU tes string (SW memuat fungsi cermin + `nosniff`,
  dan `if (!range) return cached;` sudah hilang) + EMPAT tes perilaku
  lewat harness BARU yang mengeksekusi `sw.js` asli di `node:vm`
  dengan `self` + `caches` palsu: 200 `text/html` → octet-stream +
  nosniff + isi utuh; 200 `audio/webm` → dipertahankan + nosniff; 206
  Range → tipe dipaksa + nosniff + `Content-Range` + potongan benar;
  404 bila tidak ada di cache. Harness mengambil kelas
  Response/Headers/Request dari instance nyata (bukan global jsdom)
  dan memakai Blob Node (pola yang sama dengan tes store/manajer —
  Blob jsdom mengubah `new Response(blob)` menjadi "[object Blob]").

## R9 (rendah) — Race batal/hapus-semua vs fase rakit

**Perbaikan** (`app/src/downloads/downloadManager.ts`, `runJob`):
- Cek abort PERTAMA sesudah rakit selesai dan ukuran cocok, SEBELUM
  `putDownload`: bila dibatalkan/dihapus, buang part dan kembali tanpa
  menulis apa pun.
- Cek abort KEDUA sesudah `putDownload` + `deleteParts`, SEBELUM
  `markDownloaded`: bila dibatalkan di jendela itu, hapus file yang
  baru ditulis (`deleteDownload`) dan kembali — "Hapus semua unduhan"
  tidak dilanggar.
- `cancel()` / `deleteAllDownloads()` tidak diubah (tetap tidak
  menunggu job selesai — rekomendasi audit memberi dua opsi, cek
  abort di `runJob` dipilih karena tidak mengubah kontrak API
  manajer dan tidak menambah deadlock antar job serial).

**Bukti tes** (`downloadManager.test.ts`, 2 tes baru, deterministik
lewat hook pada store — bukan tidur acak):
- Batal mendarat sesudah part terakhir dibaca saat rakit (hook
  `getPart` indeks 2 memanggil `cancel()`; `abort()` di `cancel`
  berjalan sinkron sebelum await pertamanya) → tidak ada file, tidak
  ada status terunduh, job + part bersih.
- Batal mendarat antara `putDownload` dan `markDownloaded` (hook
  `putDownload`) → file yang baru ditulis DIHAPUS lagi. `cancel()`
  sendiri tidak menghapus file unduhan, jadi hilangnya file membuktikan
  cek kedua bekerja, bukan efek samping `cancel()`.

## Info

| ID | Status | Perbaikan / alasan |
|---|---|---|
| I5 — `parseSnapshot` tidak memvalidasi enum kind/cause | DIPERBAIKI | `diagnostics.ts`: `kind` dicek terhadap kunci `KIND_LETTER`, `cause` terhadap kunci `CAUSE_LETTER`, memakai `hasOwnProperty` (bukan `in`) supaya properti warisan seperti `'constructor'` tidak lolos; nilai tak dikenal jatuh ke `'unplayable'` / `'unknown'`. Bukti: 3 tes baru di `diagnostics.test.ts` (`zzz` → default + kode tidak mengandung `undefined`, `constructor`/`toString` → default, nilai valid dipertahankan). |
| I6 — Tunggu 429 tidak bisa dibatalkan (s.d. 65 dtk) | DIPERBAIKI | `downloadManager.ts`: helper baru `sleepAbortable` — `Promise.race` antara tidur dan event abort (listener dilepas di `finally`); dipakai di cabang 429 `fetchRangeViaProxy`. Bukti: 1 tes baru — fetch 429 `Retry-After: 65` + tidur yang tidak pernah selesai + abort → menolak `DownloadAbortedError` segera. |
| I7 — `combineSignal` membuang sinyal batal tanpa `AbortSignal.any` | DIPERBAIKI | `downloadManager.ts`: fallback tanpa `any` kini membuat `AbortController` gabungan dengan listener abort manual pada sinyal pengguna + sinyal timeout (bukan mengembalikan `timeout` saja). Bukti: 1 tes baru — `AbortSignal.any` disembunyikan sementara (dikembalikan di `finally`), fetch yang menggantung sampai sinyalnya batal → abort pengguna menolak `DownloadAbortedError`. |
| I8 — Header `x-proxy-cpu-ms` masih live | DITUNDA (sengaja, bawaan I1 Red 1) | Keputusan Blue 1 dipertahankan: tidak ada bukti baru. Header dicabut saat promosi ke proxy produksi; worker saat ini masih worker spike dan header adalah instrumen ukurnya. |
| I9 — Allowlist hash player masih hardcode | DITUNDA (sengaja, bawaan I2 Red 1) | Keputusan Blue 1 dipertahankan: tidak ada bukti baru. Membaca hash dari config remote butuh desain sumber + TTL; ketiga salinan hash sinkron per 19 Nov 2026 (Red 2). |
| I10 — Versi kode worker live tidak bisa dipastikan dari luar | DITUNDA (utang koordinator) | Bukan ranah Blue: butuh konfirmasi redeploy proxy (binding D1 + kode baru) lalu verifikasi live S3/S1/Content-Range oleh koordinator. |

---

## File yang diubah / ditambah

**Baru:** `docs/blue2-red2-fixes.md` (dokumen ini).

**Diubah (produksi):**
- `app/src/resilience/configStore.ts` — S5 (`parseConfigText`, hapus entri rusak).
- `app/src/resilience/diagnostics.ts` — I5 (validasi enum snapshot).
- `app/src/downloads/downloadManager.ts` — R7 (`ItagChangedError` + restart sekali), R9 (dua cek abort saat rakit), I6 (`sleepAbortable`), I7 (fallback `combineSignal`).
- `app/src/downloads/downloadStore.ts` — R8 (`safeDownloadContentType` + dipakai di `putDownload`).
- `app/public/sw.js` — R8 (cermin `safeDownloadContentType`, override tipe + `nosniff` di 200/206).
- `CHANGELOG.md` — entri Blue 2 di bawah `## [Unreleased]` → `### Fixed`.

**Diubah (tes, 24 tes baru):**
- `app/src/resilience/configStore.test.ts` (+6: S5).
- `app/src/resilience/diagnostics.test.ts` (+3: I5).
- `app/src/downloads/downloadStore.test.ts` (+4: R8).
- `app/src/downloads/sw.test.ts` (+5: R8, termasuk harness perilaku SW `node:vm`).
- `app/src/downloads/downloadManager.test.ts` (+6: R7 ×2, R9 ×2, I6, I7).

**Tidak disentuh:** `~/workspace/music-app/` (APK), worker proxy
(`workers/proxy/`, tidak ada temuan Red 2 di sana), `wrangler.toml`,
CI, `_headers`, `persistence.ts` (WAL), timeout solver (10 dtk).

**File sementara (dihapus sesudah verifikasi, jangan push):**
`app/dev-api.tmp.mjs` — server dev via Vite API untuk E2E saat
gelombang EPERM (lihat E2E di bawah). Dihapus sesudah run E2E.

## Catatan verifikasi

- **E2E `downloads.spec.ts`: 8/8 lolos (chromium, 4,1 mnt)** — mengunduh
  10 lagu, K8 putar 10 lagu offline, K9 eviction, rekonsiliasi, hapus
  per lagu + hapus semua, aktivasi SW, tab Unduhan, PWA. K8
  (putar offline) melewati jalur SW `serveDownload` dengan perbaikan
  R8 — bukti ujung-ke-ujung bahwa override Content-Type + `nosniff`
  tidak mematahkan pemutaran unduhan. Proyek mobile tidak dijalankan
  (chromium adalah gerbang yang diminta tugas; CI menjalankan keduanya).
- **Gelombang EPERM saat verifikasi:** CLI Vite gagal start server dev
  (`mkdir node_modules/.vite-temp`, ENOENT) pada dua percobaan —
  gelombang TERBATAS aktif. Server dev dijalankan via Vite API
  (`createServer({ configFile: false })`, `dev-api.tmp.mjs`,
  jalan keluar terbukti P6) dan Playwright memakai ulang server itu
  (`reuseExistingServer`).
- **Build API tidak menyalin `public/`:** `build-api.mjs` memakai
  `publicDir: false`, jadi `dist/sw.js` di disk masih salinan build
  lama (belum berisi perbaikan R8) dan plugin versi SW tidak jalan.
  Ini keterbatasan jalan keluar lokal, bukan cacat perbaikan: build
  kanonis koordinator/CI menyalin `public/` + menerapkan plugin versi
  (hash SW dihitung dari isi file, jadi otomatis berubah mengikuti
  perbaikan R8). Verifikasi R8 di level sumber (harness `sw.test.ts`)
  adalah bukti sahnya; koordinator memverifikasi `dist/sw.js` hasil
  build kanonis.
- **Bundle naik 163.336 → 169.612 byte gzip (+6.276):** sebagian dari
  kode Blue 2 (kecil — beberapa ratus byte), sebagian dari perbaikan
  koordinator sesudah P6 (resume-at-EOF dsb.). Masih jauh di bawah
  batas 204.800; tidak ada pemecahan chunk baru yang dibutuhkan.
- **Observasi di luar cakupan (tidak diperbaiki, dicatat untuk Red 3):**
  `fetchRangeViaProxy` mengklasifikasi galat fetch yang dibatalkan
  lewat `error instanceof Error && error.name === 'AbortError'` —
  tetapi fetch asli menolak dengan `DOMException` (bukan turunan
  `Error`), sehingga klasifikasi itu tidak pernah cocok untuk abort
  nyata dan pembatalan jatuh ke `RetryableError` dulu sebelum
  `throwIfAborted` di loop chunk menghentikannya (penundaan satu
  siklus backoff). Perilaku lama, bukan temuan Red 2 — Blue 2 tidak
  mengubahnya (tes I7 memakai `Error` bernama `AbortError` sesuai
  kontrak klasifikasi yang ada). Red 3 boleh mengangkatnya bila
  dianggap layak.

## Yang masih terbuka untuk Red 3 / koordinator

- Verifikasi S5 dengan tes reproduksi Red 2 (harus lolos — tes Blue 2
  di atas mencakup kasus yang sama), R7, R8, R9 sesuai daftar Red 2.
- Konfirmasi redeploy proxy + verifikasi live S3/S1/Content-Range
  (I10); cabut `x-proxy-cpu-ms` (I8) dan rancang sumber hash remote
  (I9) saat promosi produksi.
- Audit P7 (lirik LRCLIB: `connect-src` + `https://lrclib.net`, cap
  lirik 1 MB, lirik sebagai teks bukan HTML).
- Verifikasi live CSP di preview + `dist/sw.js` hasil build kanonis
  (berisi perbaikan R8 + versi hash baru).
- Gerbang `npm audit` di run CI (tidak bisa dicek lokal).
