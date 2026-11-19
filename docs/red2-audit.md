# Red 2 - Audit Keamanan Laras Web (P5 + P6)

**Tanggal:** 19 November 2026.
**Auditor:** Tim Red 2 - audit statis + tes unit + probe live terbatas.
**Ruang lingkup:** permukaan serangan baru P5 (unduhan/offline) dan P6
(ketahanan) di `app/src/downloads/**`, `app/src/resilience/**`,
`app/public/sw.js`, `app/src/components/downloads/**`,
`app/src/components/settings/SettingsPage.tsx`, perubahan P5/P6 di
`app/src/player/service.ts` dan `app/src/extractor/resolve.ts`, plus
verifikasi regresi seluruh temuan Red 1 di `workers/proxy/src/**`,
`app/public/_headers`, `app/src/App.tsx`, dan `.github/workflows/ci.yml`.
**HEAD yang diaudit:** workdir `~/workspace/music-app-web/` per 19 Nov
2026 (sumber terkini sesudah perbaikan koordinator commit 9399e922;
`git log` lokal basi dan tidak dipakai sebagai acuan, sesuai catatan
AGENTS.md tentang push via API).
**Metode:** baca kode penuh jalur sensitif P5/P6, grep pola berbahaya,
jalankan Vitest penuh (454/454), uji unit worker `s7-unit-test.mjs`
(20/20), build in-memory (`vite.build({ write: false })`) untuk
memeriksa chunk produksi dari sumber terkini, dan probe live hemat
kuota ke config remote (1 GET) dan worker (2 GET). Tanpa Playwright
E2E dan tanpa browser (Chromium tidak stabil di sandbox saat audit;
dicatat di "Tidak bisa diverifikasi"). Red HANYA audit: tidak ada
kode produksi yang diubah; satu-satunya file yang ditulis adalah
laporan ini.
**Catatan penomoran:** temuan melanjutkan penomoran Red 1 (S5, R7-R9,
I5-I10).

## Ringkasan vonis

| Tingkat | Jumlah |
|---|---|
| Kritis | **0** |
| Tinggi | **0** |
| Sedang | **1** |
| Rendah | **3** |
| Info | **6** |
| **Total** | **10** |

**Vonis: LAYAK LANJUT KE BLUE 2, dengan satu temuan sedang (S5) yang
wajib ditutup sebelum release candidate.** Tidak ada temuan kritis
atau tinggi. Seluruh perbaikan Blue 1 MASIH bertahan (H1, S1-S4,
R1-R6 terverifikasi ulang di bawah). Fondasi P5/P6 kuat: unduhan
ber-chunk dengan cap dan resume yang benar, SW melindungi cache
unduhan di semua jalur, log/snapshot/kode diagnostik terbukti bebas
URL stream dan data pribadi, dan proxy menutup celah Content-Range
P5 di repo. Satu-satunya lubang berarti adalah S5: satu baris
`JSON.parse` tanpa pelindung di loader config P6 yang bisa membuat
aplikasi mati total dan permanen bila cache config tersimpan rusak.

---

## Temuan sedang

### S5 - `JSON.parse` cache config tanpa try/catch: satu entri rusak mematikan app permanen

**Tingkat: sedang.** **File:**
`app/src/resilience/configStore.ts:196-199` (`loadFresh`),
`app/src/extractor/resolve.ts:434` (`init`),
`app/src/extractor/resolve.ts:642` (`resolve`),
`app/src/player/service.ts:449-461` (`ensureResolver`).

**Bukti:**
- `loadFresh` mem-parse teks config tersimpan tanpa pelindung
  apa pun (`configStore.ts:197-199`):

```ts
const persisted = await readPersisted();
const persistedParsed = persisted
  ? parsePlayerConfig(JSON.parse(persisted.text) as unknown)
  : null;
```

  `parseCached` (baris 98-113) hanya memvalidasi bahwa `text`
  adalah string, bukan bahwa isinya JSON valid. Bila nilai
  `p6.config` di IndexedDB berisi wrapper JSON yang valid
  tetapi teks config di dalamnya rusak (korupsi storage,
  tulis terpotong, atau penulis lain dengan bentuk berbeda),
  `JSON.parse` melempar `SyntaxError` keluar dari `loadFresh`.
  Tidak ada try/catch di `loadFresh`, di `load()`, maupun di
  `StreamResolver.init()` (`resolve.ts:434` memanggil
  `loader.load()` tanpa try/catch; try/catch di `init()` hanya
  membungkus pengambilan visitorData).
- Dampaknya permanen, bukan satu sesi: `ensureResolver`
  (`service.ts:453-458`) menelan kegagalan init tetapi
  meng-cache promise-nya (`this.resolverInit`), sehingga
  `this.config` tetap `null` selamanya dan setiap `resolve()`
  melempar `'resolver belum init'` (`resolve.ts:642`). Entri
  rusak tidak pernah ditimpa karena lemparan terjadi SEBELUM
  fetch remote dan `writePersisted`; setiap restart aplikasi
  membaca entri rusak yang sama dan gagal dengan cara yang
  sama. Satu-satunya jalan pulih adalah pengguna menghapus
  data situs secara manual. Pemutaran, unduhan, dan kanari
  semuanya mati (ketiganya memakai resolver yang sama).
- Kontras dengan jalur lama: `loadPlayerConfig`
  (`resolve.ts:376-389`) membungkus `JSON.parse` dalam
  try/catch dan jatuh ke builtin. Jalur P6 yang baru justru
  kehilangan perlindungan itu. Jalur fetch segar di file yang
  sama (`configStore.ts:258-262`) SUDAH dibungkus try/catch;
  hanya jalur cache tersimpan yang lolos.
- **Dibuktikan dengan tes reproduksi** (file tes sementara di
  `/tmp/red2-repro.test.ts`, dijalankan terhadap kode asli
  lewat Vitest, repo tidak disentuh): loader dengan storage
  berisi `{ text: '{ini-bukan-json', fetchedAt: <now> }`
  membuat `loader.load()` MENOLAK dengan
  `SyntaxError: Expected property name or '}' in JSON at
  position 1`, stack mengarah ke `configStore.ts:198:32`.
  Tes yang mengharapkan `load()` resolve (fallback builtin
  atau remote) GAGAL, sesuai prediksi bug.

**Dampak:** skenario yang dirancang untuk ditahan rantai
fallback B9.1 ("bila config rusak, app memakai config
terakhir yang valid, lalu nilai bawaan") justru mematikan
aplikasi total dan permanen. Pemicunya sempit (butuh entri
cache yang rusak), tetapi kerusakan storage IndexedDB di
perangkat kelas bawah adalah kejadian nyata, dan tidak ada
jalur pulih otomatis sama sekali.

**Rekomendasi (Blue):**
1. Bungkus parse cache tersimpan dengan try/catch dan
   perlakukan teks rusak sebagai "tidak ada cache"
   (`persistedParsed = null`, lanjut ke fetch remote /
   builtin), persis seperti perlakuan config segar yang
   rusak di baris 258-262. Terapkan juga ke cabang memori
   (baris 192) sebagai pertahanan lapis kedua, walau secara
   konstruksi `memory.text` selalu valid.
2. Bila teks tersimpan rusak, hapus entri `p6.config` itu
   (best-effort) supaya restart berikutnya tidak membaca
   racun yang sama.
3. Tambahkan tes regresi: cache tersimpan berisi teks bukan
   JSON (dan berisi JSON yang gagal validasi skema) harus
   membuat `load()` resolve ke builtin/remote, bukan menolak.
   Tes reproduksi Red 2 di atas gagal sebelum perbaikan dan
   harus lolos sesudahnya.

---

## Temuan rendah

### R7 - Re-resolve di tengah unduhan tidak memeriksa itag: rakitan bisa tercampur dua format

**Tingkat: rendah.** **File:**
`app/src/downloads/downloadManager.ts:665-672` (`reResolve`),
`app/src/downloads/downloadManager.ts:697-733` (rakitan),
`app/src/downloads/chunkedDownloader.ts:220-221,258` (EOF tanpa total).

**Bukti:**
- `reResolve` di `runJob` hanya mengembalikan URL segar dan
  membuang itag hasil resolve baru (`downloadManager.ts:665-672`):

```ts
reResolve: async () => {
  const fresh = await this.resolver.resolve(
    { videoId: songId, title: song.song.title },
    { itagPreference: preference },
  );
  return fresh.url;
}
```

  Itag awal (`resolved.itag`) tidak pernah dicatat untuk
  dibandingkan. Bila itag awal tidak lagi tersedia saat
  re-resolve (rotasi format YouTube), `pickAudioFormatForPreference`
  memilih itag lain (codec/bitrate/file berbeda) dan chunk
  baru dari format berbeda itu ditempel ke part lama.
- Jaring pengaman ukuran tidak selalu menangkapnya. Cek
  `assembled !== result.totalBytes` (`downloadManager.ts:730`)
  hanya bekerja bila total diketahui. Bila `Content-Range`
  tidak terekspos (keadaan proxy live yang belum terverifikasi
  redeploy-nya, lihat I10), `downloadChunked` mengenali ujung
  file dari chunk pendek/kosong dan mengeset
  `total = offset` (`chunkedDownloader.ts:221,258`), sehingga
  `totalBytes` SELALU sama dengan `assembled` dan cek ukuran
  lolos otomatis. Hasilnya: file campuran dua format
  tersimpan sebagai unduhan "valid", lalu gagal diputar
  (jatuh balik ke stream lewat `downloadFallbackUsed`, jadi
  pengguna tidak terjebak, tetapi unduhannya sampah).
- Catatan penyeimbang: pemicu butuh URL mati di tengah
  unduhan DAN itag awal hilang dalam jendela yang sama;
  jarang, tetapi bukan mustahil pada unduhan panjang.

**Dampak:** integritas file unduhan: satu lagu terunduh bisa
berisi gabungan dua stream berbeda tanpa peringatan apa pun.
**Rekomendasi (Blue):** catat `resolved.itag` saat job mulai;
di `reResolve`, bila `fresh.itag !== itagAwal`, buang semua
part dan mulai ulang dari byte 0 dengan URL/format baru
(dengan batas, mis. sekali per job, supaya tidak loop).
Tambahkan tes unit: re-resolve yang mengembalikan itag
berbeda harus me-restart, bukan menempel.

### R8 - Service Worker menyajikan unduhan dengan Content-Type tersimpan apa adanya

**Tingkat: rendah.** **File:** `app/public/sw.js:121-143`
(`serveDownload`), `app/src/downloads/downloadStore.ts:90-108`
(`putDownload`), `app/src/downloads/downloadManager.ts:735-745`.

**Bukti:**
- `putDownload` menyimpan Content-Type dari respons proxy
  tanpa validasi apa pun (`downloadStore.ts:97-99`), dan
  `serveDownload` mengembalikan respons tersimpan itu apa
  adanya ke halaman same-origin (`sw.js:128`: `if (!range)
  return cached;`), termasuk untuk navigasi langsung ke
  `/dl/<videoId>`. Tidak ada `X-Content-Type-Options` dan
  tidak ada override tipe di jalur SW.
- Satu-satunya lapisan yang mencegah tipe non-media masuk
  cache adalah allowlist Content-Type di proxy repo
  (`workers/proxy/src/index.js`, `MEDIA_CONTENT_TYPES`).
  Bila satu respons non-media lolos ke cache (proxy live
  versi lama sebelum perbaikan R1, bug upstream, atau
  perubahan perilaku googlevideo), navigasi ke `/dl/<id>`
  bisa me-render HTML same-origin, yaitu stored XSS lewat
  cache unduhan. Praktiknya googlevideo hanya mengembalikan
  media untuk URL videoplayback yang sah, jadi eksploitasi
  realistis hari ini rendah; ini temuan defense-in-depth.
- Catatan: respons 404/416 SW memakai `text/plain` default
  dan aman; yang berisiko hanya respons `cached` utuh.

**Dampak:** kepercayaan satu lapis pada header upstream
untuk konten yang disajikan same-origin.
**Rekomendasi (Blue):** di `serveDownload`, salin header
tersimpan dan paksa `Content-Type` ke `application/octet-stream`
bila tipe tersimpan bukan `audio/*`, `video/*`, atau
`application/octet-stream`, serta selalu set
`X-Content-Type-Options: nosniff` pada respons unduhan
(200 maupun 206). Pertahanan lapis kedua di `putDownload`:
tolak `contentType` di luar ketiga pola itu (ganti dengan
`application/octet-stream`) sebelum `cache.put`.

### R9 - Race batal/hapus-semua vs fase rakit: unduhan yang dihapus bisa muncul kembali

**Tingkat: rendah.** **File:**
`app/src/downloads/downloadManager.ts:486-502` (`cancel`),
`521-545` (`deleteAllDownloads`), `697-760` (`runJob`,
rakitan sesudah cek abort terakhir).

**Bukti:**
- `runJob` memeriksa `abort.signal.aborted` terakhir kali
  sesudah `downloadChunked` kembali (baris 697), lalu
  menjalankan fase rakit yang seluruhnya async (baca part,
  `putDownload`, `deleteParts`, `markDownloaded`,
  `deleteDownloadJob`) tanpa satu pun cek abort lagi.
  `cancel()` dan `deleteAllDownloads()` memanggil
  `abort()` tetapi TIDAK menunggu `runJob` selesai; mereka
  langsung menghapus part/job/file.
- Interleaving yang mungkin: `deleteAllDownloads` menghapus
  part sebuah job yang sedang dirakit sesudah `runJob`
  selesai membaca semua part ke memori; `runJob` lalu tetap
  menulis file (`putDownload`) dan menandai terunduh
  (`markDownloaded`). Hasilnya satu unduhan "bangkit"
  sesudah "Hapus semua unduhan" (kontrak aksi destruktif
  itu dilanggar secara kasat mata). Varian yang sama
  berlaku untuk `cancel()` selama fase rakit.
- Jendela race sempit (rakit adalah operasi lokal yang
  cepat) dan akibatnya ringan (satu file muncul kembali,
  bisa dihapus lagi), sehingga tingkatnya rendah.

**Dampak:** aksi hapus pengguna tidak dijamin tuntas untuk
job yang sedang dirakit.
**Rekomendasi (Blue):** cek `abort.signal.aborted` sekali
lagi tepat sebelum `putDownload` dan sebelum
`markDownloaded` di `runJob`; atau buat `cancel()` /
`deleteAllDownloads()` menunggu job aktif selesai lewat
promise penyelesaian job sebelum menghapus. Tambahkan tes
unit: abort yang mendarat selama rakit tidak boleh
menghasilkan file terunduh.

---

## Info

### I5 - `parseSnapshot` tidak memvalidasi nilai enum kind/cause

**File:** `app/src/resilience/diagnostics.ts:205-246`.
`parseSnapshot` memvalidasi `layer`, `failedAt`, dan
`clientsTried`, tetapi `kind` dan `cause` hanya memakai
`??` default tanpa memeriksa keanggotaan enum (baris 226-227).
Snapshot tersimpan yang dirusak (atau ditulis versi lain)
dengan `kind: "zzz"` membuat `buildDiagnosticCode`
menghasilkan `LRS1-undefinedXX-...` karena
`KIND_LETTER["zzz"]` adalah `undefined`. Dampak kosmetik
saja (storage same-origin, kode hanya tampil), tetapi
validasi satu baris per field menutupnya. Rekomendasi: cek
`kind` terhadap kunci `KIND_LETTER` dan `cause` terhadap
kunci `CAUSE_LETTER`, fallback ke `'unplayable'` /
`'unknown'` bila tidak dikenal.

### I6 - Tunggu 429 tidak bisa dibatalkan: batal tertunda sampai 65 detik

**File:** `app/src/downloads/downloadManager.ts:222-232`
(`fetchRangeViaProxy`). Saat proxy membalas 429, kode
menunggu `Retry-After` penuh (`await sleep(waitSeconds *
1000)`, maks 65 detik) tanpa memeriksa `signal.aborted`
selama tidur. Pengguna yang menekan Batal di tengah tunggu
ini harus menunggu sampai tidur selesai sebelum pembatalan
diterapkan (cek abort berikutnya baru di puncak loop).
Dampak UX kecil; rekomendasi: tidur yang bisa dibatalkan
(`Promise.race` antara sleep dan event abort) atau cek
abort berkala selama tunggu.

### I7 - `combineSignal` membuang sinyal batal di browser tanpa `AbortSignal.any`

**File:** `app/src/downloads/downloadManager.ts:158-170`.
Bila `AbortSignal.any` tidak tersedia (Safari lama, Chrome
lama), fallback mengembalikan `timeout` saja dan sinyal
batal pengguna tidak diteruskan ke `fetch` chunk. Praktiknya
`readBodyWithWatchdog` tetap memeriksa `signal.aborted` di
tiap iterasi baca, sehingga pembatalan masih jalan selama
body mengalir; celahnya hanya fase tunggu koneksi/header
(sampai 120 detik). Dampak kecil dan hanya di browser lama;
rekomendasi: bila `any` tidak ada, pasang listener abort
manual yang memanggil `AbortController` gabungan.

### I8 - Header `x-proxy-cpu-ms` masih aktif di worker live (bawaan I1 Red 1)

Terkonfirmasi lewat probe live 19 Nov 2026: respons 404 dan
403 worker membawa `x-proxy-cpu-ms: 0.000` dan
`Access-Control-Expose-Headers: x-proxy-cpu-ms`. Ini
keputusan tunda yang disengaja dari Blue 1 (header dicabut
saat promosi ke proxy produksi; worker saat ini masih worker
spike dan header adalah instrumen ukurnya). Bukan temuan
baru; dicatat supaya tidak hilang dari daftar promosi.

### I9 - Allowlist hash player masih di-hardcode (bawaan I2 Red 1)

`PLAYER_HASHES` di `workers/proxy/src/index.js` masih berisi
3 hash statis. Terverifikasi sinkron hari ini: config remote
live (diambil 19 Nov 2026) membawa hash yang persis sama
(`ad8d59ae: 20768`, `b559f50c: 20770`, `fad7e4e9: 20767`)
dengan `version: 1` dan `ttlSeconds: 21600`, sama seperti
`BUILTIN_HASHES` di `app/src/spike/config.ts`. Risiko
ketersediaan bila YouTube merotasi hash tetap ada; keputusan
tunda Blue 1 (baca dari config remote butuh desain sumber +
TTL) masih berlaku.

### I10 - Versi kode worker live tidak bisa dipastikan dari luar

Perbaikan S1/S3/R1 dan expose Content-Range terverifikasi
di repo dan lewat uji unit worker 20/20, tetapi tidak ada
probe luar murah yang membedakan worker lama dari worker
baru: 413 body besar, 429, dan header expose pada respons
error berperilaku sama di kedua versi, sementara pembuktian
D1 butuh 61+ request dan pembuktian Content-Range butuh URL
googlevideo asli (sengaja tidak dilakukan: membakar kuota
dan menembak upstream). Probe live hanya memastikan worker
hidup dan gerbang host bekerja (403 `HOST_NOT_ALLOWED` untuk
`example.com`, 404 `NOT_FOUND` untuk rute tak dikenal).
Status redeploy tetap menjadi utang koordinator dari Blue 1;
sampai terkonfirmasi, perilaku live proxy (termasuk expose
Content-Range yang menentukan jalur "total diketahui" di
R7) harus dianggap belum pasti.

---

## Verifikasi regresi Red 1 (semua bertahan)

| ID Red 1 | Status Red 2 | Bukti |
|---|---|---|
| H1 (tinggi, chunk uji di produksi) | BERTAHAN | `App.tsx`: kelima rute uji (`/player-test`, `/library-test`, `/p4-test`, `/p5-test`, `/p6-test`) digerbang `import.meta.env.DEV` termasuk lazy import-nya. Build in-memory dari sumber terkini: **0 chunk `*TestPage*`**, 0 chunk eval/fallback, 1 chunk `SpikePage` (pengecualian koordinator, non-destruktif, terverifikasi tanpa aksi hapus). `dist/` di disk (18 Nov 23:48): 0 `*TestPage*`. Gerbang CI masih ada di `ci.yml`. |
| S1 (sedang, body POST dibaca penuh) | BERTAHAN | `workers/proxy/src/index.js`: `readCapped(request.body, MAX_BODY_BYTES)` + cek `Content-Length` awal. Uji unit worker: body 1 MB+7 byte ke 413 dan stream 1,2 MB tanpa Content-Length ke 413, keduanya lolos (20/20). |
| S2 (sedang, tanpa CSP) | BERTAHAN | `app/public/_headers` utuh dan tersalin ke `dist/_headers`: CSP dengan `'wasm-unsafe-eval'` (bukan `'unsafe-eval'`), `frame-ancestors 'none'`, `object-src 'none'`, `form-action 'none'`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`. `connect-src` mencakup proxy + `raw.githubusercontent.com`; belum ada LRCLIB (P7) sehingga belum perlu ditambah. |
| S3 (sedang, rate limit in-memory) | BERTAHAN (kode) | `workers/proxy/src/rateLimit.js` + `index.js` memakai D1 (`rate_limits`, jendela menit selaras, sapu probabilistik 1%); tidak ada lagi `buckets` in-memory. Uji unit: 60 lolos / ke-61 429 dengan `Retry-After: 60`; media 10 lolos / ke-11 429; fail-open tanpa binding DB lolos. Verifikasi D1 ASLI live masih menunggu redeploy (lihat I10). |
| S4 (sedang, config tanpa cap/versi) | BERTAHAN (dengan catatan S5) | `fetchConfig.ts` + `readCappedText` menegakkan cap 4 MB selama stream; `parsePlayerConfig` menolak `version !== 1` (`resolve.ts`, `CONFIG_SCHEMA_VERSION = 1`); file live terverifikasi berisi `"version": 1`. Catatan: jalur cache P6 memperkenalkan S5 (di atas), tetapi cap dan cek versi sendiri utuh. |
| R1 (rendah, redirect media tanpa validasi) | BERTAHAN | `redirect: 'manual'`, maks 3 hop, tiap `Location` divalidasi (https + `*.googlevideo.com`), satu deadline 120 dtk, Content-Type diteruskan hanya `audio/*` / `video/*` / `application/octet-stream` + `nosniff`. Uji unit: redirect ke example.com ke 502 `REDIRECT_NOT_ALLOWED`, redirect sesama googlevideo ke 206. |
| R2 (rendah, `decodeURIComponent` tanpa try/catch) | BERTAHAN | `App.tsx:parseRoute` membungkus decode dengan try/catch (segmen rusak ke beranda); `main.tsx` memakai `ErrorBoundary`. |
| R3 (rendah, SW cache-first + versi manual) | BERTAHAN, DITINGKATKAN | Navigasi network-first; cache runtime hanya aset statis; versi cache shell kini otomatis dari plugin Vite (`larasSwVersion`, `computeSwVersion`): `dist/sw.js` terverifikasi berisi `SW_VERSION = '0.9.0-f56db867'`, placeholder tidak tersisa. |
| R4 (rendah, CI tag `@v4`, tanpa permissions/audit) | BERTAHAN | `ci.yml`: ketiga action dipin SHA penuh, `permissions: contents: read`, gerbang `npm audit --omit=dev --audit-level=high` + audit dev informasional. Audit tidak bisa dijalankan lokal (egress proxy 403 `policy_denied`, sama seperti Blue 1); CI adalah bukti sahnya. |
| R5 (rendah, cap client sesudah baca penuh) | BERTAHAN | `resolve.ts` base.js (8 MB) dan `innertube.ts` (10 MB) memakai `readCappedText`. |
| R6 (rendah, origin dev di CORS produksi) | BERTAHAN | `wrangler.toml` `[vars]` hanya dua domain produksi; localhost:4173 hanya di `[env.dev.vars]`. |
| I1 (header CPU) | MASIH TERBUKA (sengaja) | Lihat I8. |
| I2 (hash hardcode) | MASIH TERBUKA (sengaja) | Lihat I9; sinkron dengan config live hari ini. |
| I3 (track lokal tanpa validasi URL) | BERTAHAN | `player/port.ts:isSafeLocalUrl` (blob same-origin atau http(s) same-origin, termasuk path relatif) masih dipakai sebagai titik choke di `service.ts` SEBELUM `decidePath` dan sebagai lapis kedua di `port.load`. Jalur unduhan `/dl/<id>` (path relatif same-origin) lolos dengan benar. |
| I4 (sourcemap di dist) | BUKAN TEMUAN | Tetap sesuai putusan Red 1 (repo GPL publik). |

---

## Daftar endpoint eksternal (diperbarui dari Red 1)

Perubahan dari Red 1: endpoint 7 (`/api/media`) kini DIPAKAI
client (P5, `downloadManager.ts:196`); tidak ada endpoint baru
lain. Tidak ada fetch ke LRCLIB (P7), Spotify, atau telemetri.

| # | Endpoint | Pemanggil | Keterangan |
|---|---|---|---|
| 1-5 | `.../api/innertube/player`, `search`, `browse`, `next`, `suggestions` | `innertube.ts` via resolve/search/browse | Tidak berubah |
| 6 | `.../api/player-script?hash=` | `resolve.ts` | Tidak berubah |
| 7 | `.../api/media?u=` | `downloadManager.ts` (P5, BARU dipakai) | GET Range 1 MiB, URL divalidasi allowlist sebelum dikirim |
| 8 | `https://raw.githubusercontent.com/adiprmx/laras/config-v1/player-config.json` | `fetchConfig.ts` via `loadPlayerConfig` + loader TTL P6 | Cap 4 MB, timeout 15 dtk (`CONFIG_TIMEOUT_MS`) |
| 9 | `https://*.googlevideo.com/videoplayback...` | elemen `<audio>` saja (streaming) | Tidak pernah di-fetch langsung dari JS kecuali probe CORS lokal (bukan googlevideo) |
| 10-11 | Thumbnail `*.ytimg.com`, `*.googleusercontent.com`, `*.ggpht.com` | `<img>` | Tidak berubah |

**NOL telemetri/analytics:** tidak ada `fetch`/`XHR`/`WebSocket`/
`sendBeacon`/piksel pelacak lain di seluruh `app/src` (grep
terverifikasi; `XMLHttpRequest` hanya muncul sebagai stub yang
melempar di `solver/jsStubs.ts:151`).

---

## Yang DIPERIKSA dan bersih (P5 + P6 + umum)

- **H1 bertahan dari sumber terkini.** Build in-memory
  19 Nov 2026: 16 chunk app, 0 `*TestPage*`, 0 chunk
  eval/fallback, 1 `SpikePage` (pengecualian koordinator).
  `/p5-test` dan `/p6-test` ikut digerbang DEV seperti
  seeder lama; kalaupun gerbang gagal, aksi destruktif
  keduanya terbatas pada seed tes (hapus satu file lagu
  uji P5, bersihkan seed P6), bukan database pengguna.
- **Unduhan ber-chunk benar dan berbatas.**
  `chunkedDownloader.ts`: cap 100 MB ditegakkan di tiga
  tempat (total dari header, akumulasi offset, cabang 200);
  retry maks 3x/chunk dengan backoff 1/2/4 dtk + jitter;
  re-resolve maks 2x/job; 429 ditangani di dalam
  `fetchRange` (tunggu Retry-After maks 65 dtk, maks 3
  tunggu) tanpa menghabiskan percobaan chunk; perbaikan
  resume-di-ujung koordinator (commit 9399e922) ada di
  kode (`chunksDownloaded > 0 || startByte > 0`) dan 19
  tes chunkedDownloader lolos termasuk regresi EOF.
  Loop tidak bisa berputar tanpa batas: tiap iterasi maju,
  mengeset total, berhenti, atau melempar; pertumbuhan
  offset dibatasi cap file.
- **Resume tidak menimpa part.** Indeks part baru dihitung
  berurutan dari part lama (`downloadManager.ts`,
  `resumeOffset` + `nextPartIndex`), bukan dari offset /
  ukuran chunk; prefix kontigu dari byte 0 yang dipakai.
  Rakitan memverifikasi `assembled === totalBytes` sebelum
  `putDownload` (dengan celah R7 saat total tidak diketahui).
- **URL stream tidak pernah disimpan/dicetak di jalur unduhan.**
  `fetchRangeViaProxy` memvalidasi allowlist SEBELUM
  mengirim URL ke proxy (lapis kedua sesudah resolver);
  yang disimpan hanya videoId + itag; pesan galat
  (`downloadErrorMessage`) tanpa URL; `readBodyWithWatchdog`
  memakai cap + watchdog macet 60 dtk (dengan flag
  `stalled` yang benar menangani semantik `reader.cancel()`).
- **Service Worker melindungi unduhan (K9).**
  `sw.js`: `activate` hanya menghapus cache yang lolos
  `isDeletableOnActivate`, dan predikat itu mengecualikan
  `laras-downloads-v1` secara eksplisit; `evictRuntimeCache`
  (`downloadStore.ts`) hanya membuka `laras-runtime-v1`;
  `isProtectedCache` satu-satunya anggota adalah cache
  unduhan; nama cache stabil lintas build. `parseRange`
  menolak rentang ganda, rentang kosong, dan `start >= size`
  (416 dengan `Content-Range: bytes */size`); `/dl-part/`
  TIDAK dilayani SW (awalan `/dl/` tidak cocok dengan
  `/dl-part/`); lintas origin tidak disentuh; navigasi
  network-first dengan cadangan cache.
- **Kualitas unduhan + estimasi jujur.** Tiga opsi dengan
  urutan itag terdokumentasi (`quality.ts`); estimasi ukuran
  dari bitrate x durasi dengan label perkiraan di UI; tidak
  ada angka karangan; `formatBytes` menangani nilai tak
  hingga/negatif.
- **Layar Penyimpanan aman.** Hapus semua memakai DUA
  dialog konfirmasi berurutan (`DownloadsPage.tsx`,
  `deleteAllStep` 1 lalu 2); hapus per lagu memakai satu
  dialog konfirmasi; judul/artis dirender lewat React
  (auto-escape); tidak ada URL yang ditampilkan.
- **Config loader TTL benar, kecuali S5.** TTL 6 jam,
  rate limit 5 menit antar fetch (kecuali dipaksa),
  single-flight, deteksi perubahan dari ISI teks,
  rantai fallback remote lalu cache lalu builtin,
  `fromRemote` true untuk cache (segmen CFG LRS1 benar),
  storage rusak tidak memblokir (degradasi memori).
  `parsePlayerConfig` tetap menolak versi tak dikenal dan
  memvalidasi tipe per field; `fetchRemoteConfigText`
  memakai cap 4 MB + timeout 15 dtk (naik dari 5 dtk yang
  terbukti terlalu agresif, sesuai catatan B9.2).
- **Retry LOGIN_REQUIRED berbatas.** Maks 3 putaran
  (9 request/lagu), backoff 5 dtk lalu 15 dtk, hanya untuk
  penolakan semua-client tanpa format dan tanpa galat
  jaringan/proxy; kanari memakai `maxRounds: 1`;
  `ResolveError.attempts` hanya berisi `CLIENT=STATUS`
  tanpa videoId.
- **Kanari hemat dan tidak mengganggu.** 5 lagu, resolve
  saja, jeda 1 dtk antar lagu, timeout 90 dtk/lagu, maks
  15 request/cek, dijadwalkan sekali sehari + 20 dtk
  sesudah buka, kegagalan jaringan diabaikan tanpa
  memajukan waktu cek, gagal diam-diam.
- **Klasifikasi error + banner benar.** 6 penyebab
  dipetakan dari `attempts`/status online, bukan dari teks
  bebas yang ditampilkan; tombol "Periksa pembaruan" hanya
  di banner gangguan (`StatusBanner.tsx`), sesuai PRD B9.8;
  tombol di Pengaturan memakai penjaga `checking` (tidak
  bisa diklik ganda selama pemeriksaan berjalan).
- **NOL URL stream / data pribadi di log, snapshot, dan kode.**
  Diverifikasi jalur per jalur, bukan asumsi:
  `playerLog.ts` menyamarkan `https?://\S+` menjadi `[url]`
  dan dibatasi 10 baris; pemanggil di `service.ts` hanya
  mencatat putaran retry, kode error media + posisi, dan
  `attempts` (`CLIENT=STATUS`); `FailureSnapshot`
  (`diagnostics.ts`) hanya berisi layer/kind/cause/waktu/
  client/playability/hash 8-hex; `buildDiagnosticCode`
  hanya merakit huruf kategori + waktu + inisial client +
  versi app + segmen config + status layanan; `SettingsPage`
  menampilkan field snapshot itu saja (tanpa judul,
  videoId, URL, IP, atau email). Tes `diagnostics.test.ts`
  dan `playerLog.test.ts` menegaskan properti ini.
- **Proxy: S1/S3/R1 bertahan + Content-Range diekspos.**
  `withCpu` kini MENGGABUNG `Access-Control-Expose-Headers`
  alih-alih menimpa (perbaikan bug P5 #1), dan `/api/media`
  mengeset `Access-Control-Expose-Headers: Content-Range,
  Accept-Ranges`. Uji unit worker 20/20 mencakup expose
  ini plus seluruh gerbang S1/S3/R1.
- **Tidak ada XSS / eval liar / secret / telemetri.**
  NOL `dangerouslySetInnerHTML` / `innerHTML` DOM /
  `document.write` / `new Function` di `app/src`
  (`innerHTML` hanya properti objek stub di `jsStubs.ts:32`;
  `eval(` hanya metode engine solver QuickJS yang
  tersandbox); NOL `console.*` di kode produksi (termasuk
  `test-pages` dan `spike`); NOL pola secret di repo
  (satu-satunya kunci adalah kunci publik InnerTube
  `AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8`, BUKAN temuan);
  NOL telemetri (lihat daftar endpoint).
- **CSP lengkap dan benar.** Lihat baris S2 di tabel regresi.
- **Dependensi produksi tidak berubah sejak Red 1.**
  Lockfile: React 19.3.1, Vite 6.4.6, esbuild 0.25.12,
  Dexie 4.4.7, Zustand 5.1.0, quickjs-emscripten-core
  0.32.0, rollup 4.68.5, ws 8.23.0, semver 6.3.2;
  overrides picomatch 4.0.7 + tinypool 2.2.0 sesuai
  addendum Blue 1. Tidak ada dependensi baru di P5/P6.
  picomatch GHSA-fc5q tetap diketahui dan tidak
  dilaporkan ulang (lihat "Tidak bisa diverifikasi").
- **Tes hijau.** Vitest 454/454 (34 file) dengan perintah
  `--configLoader runner --pool=threads`, 19 Nov 2026;
  uji unit worker `s7-unit-test.mjs` 20/20.

---

## Yang TIDAK bisa diverifikasi + alasannya

- **`npm audit` (gerbang R4).** Endpoint audit npm diblokir
  egress proxy VM (403 `policy_denied`, terverifikasi
  19 Nov 2026, sama seperti Blue 1). CI run adalah bukti
  sahnya; picomatch GHSA-fc5q sudah diketahui dan
  didokumentasi, bukan temuan baru.
- **Rate limit D1 live (S3) dan perilaku proxy live
  sesudah redeploy.** Butuh 61+ request live (membakar
  kuota + menembak upstream) atau URL googlevideo asli;
  sengaja tidak dilakukan. Lihat I10.
- **Header CSP live di Cloudflare Pages.** `_headers`
  terverifikasi di repo dan di `dist/`, tetapi header yang
  benar-benar disajikan Pages hanya bisa dicek dari
  deployment live (di luar jangkauan audit statis + VM).
- **Perilaku SW di preview/browser nyata.** Termasuk
  network-first navigasi (R3) dan serving `/dl/` dengan
  Range di browser nyata; E2E Playwright tidak bisa jalan
  andal di sandbox ini (Chromium gagal start saat gelombang
  EPERM). Bukti terbaik adalah E2E P5/P6 yang sudah lolos
  di CI + Vitest `sw.test.ts` 8/8.
- **Unduh live ujung-ke-ujung.** googlevideo memblokir IP
  VM (vonis S3); kaki live sudah dicatat sebagai utang P5
  dan bukan ranah audit ini.
- **E2E Playwright penuh.** Tidak dijalankan (alasan
  sandbox di atas); Vitest + uji unit worker + build
  in-memory adalah bukti yang dipakai ronde ini.

---

## Rekomendasi urutan perbaikan untuk Blue 2

1. **S5** - try/catch parse cache config + hapus entri rusak
   + tes regresi (satu-satunya temuan sedang; perbaikan
   kecil, dampak pemulihan total).
2. **R7** - verifikasi itag di re-resolve (restart dari 0
   bila itag berubah).
3. **R8** - override Content-Type + `nosniff` di SW untuk
   unduhan tersimpan.
4. **R9** - cek abort sebelum `putDownload`/`markDownloaded`.
5. **I5-I7** - validasi enum snapshot, tidur 429 yang bisa
   dibatalkan, fallback `combineSignal` dengan listener
   abort manual.
6. **Koordinator (bukan Blue):** konfirmasi redeploy proxy
   dengan binding D1 + kode baru (I10), lalu verifikasi
   live S3/S1/Content-Range; cabut `x-proxy-cpu-ms` (I8)
   dan rancang sumber hash remote (I9) saat promosi
   produksi.

**Red 3 (sesudah Blue 2):** verifikasi S5 dengan tes
reproduksi Red 2 (harus lolos), R7 (re-resolve beda itag
me-restart), R8 (SW memaksa tipe aman), R9 (abort selama
rakit tidak membangkitkan file), plus audit P7 (lirik
LRCLIB: `connect-src` harus ditambah `https://lrclib.net`,
cap lirik 1 MB, lirik sebagai teks bukan HTML) dan
verifikasi live proxy + CSP di preview.
