# Spike S2, S6, S7: Direct Fetch CORS, Cache Media Service Worker, Worker Proxy

**Proyek:** Laras Web App Full-Stack, paket P1, Tim Jaringan (A5, A17, A16, A26)
**Tanggal uji:** 17 November 2026 (21:39-23:00 WIB, UTC+7; 14:39-16:00 UTC)
**Lingkungan uji:** VM Linux, Node v24.22.1, Playwright 1.65.1 (dipin),
Chromium headless, preview app Vite port 4173, relay CONNECT lokal port
18081 (Playwright ke egress), curl lewat proxy egress VM.
**Dokumen acuan:** `docs/arsitektur.md` §3.6, §4.1, §8;
`docs/keputusan-solver.md` §8.

**Catatan warisan:** Tim Jaringan pertama gugur karena restart drain
runtime sebelum menulis laporan. Seluruh bukti ronde pertama tersimpan
di disk dan diverifikasi ulang oleh tim lanjutan ini; pekerjaan yang
belum selesai (probe S7, diferensiasi S6) dikerjakan sampai tuntas di
ronde ini. Tidak ada pekerjaan yang diulang dari nol.

**Cara membaca vonis:** tiap spike divonis LULUS, GAGAL, atau LULUS
DENGAN CATATAN. Angka yang berasal dari jaringan VM dilabeli eksplisit
sebagai angka VM (egress-bound) dan BUKAN angka perangkat pengguna.
Kegagalan yang terbukti berasal dari jaringan VM tidak divonis sebagai
kegagalan mekanisme produk.

## Ringkasan vonis

| Spike | Vonis | Satu kalimat |
|---|---|---|
| S2 direct fetch CORS | **LULUS (vonis: DIBLOKIR, proxy WAJIB)** | POST player ketiga client dan GET base.js gagal CORS dengan pesan preflight asli; kontrol positif membuktikan browser bisa fetch sumber ber-CORS. Fetch langsung mati; proxy byte-only adalah satu-satunya jalur. |
| S6 SW cache media opaque + Range | **LULUS DENGAN CATATAN** | Mekanisme penuh terbukti di kaki lokal (putar online, putar offline dari cache, seek 30 dan 55 dtk). Kaki googlevideo gagal di lapisan jaringan VM, bukan mekanisme: format itag 251 yang sama terbukti diputar dari disk lokal dan URL yang sama terbukti bisa diambil dari edge Cloudflare. Uji ulang kaki googlevideo di luar VM tetap wajib sebelum v1. |
| S7 Worker proxy byte-only | **LULUS** | Proxy melayani player/base.js/unduhan; CPU per request 0,000 ms di semua sampel live (0,008-0,028 ms di uji Node), jauh di bawah 10 ms; cap body 413 dan gerbang host/hash 403 terbukti menolak live; rate limit 429 terbukti menolak di uji unit deterministik (burst live dari VM tidak dimungkinkan oleh egress). Dua bug deployment spike ditemukan dan diperbaiki selama ronde ini. |

## Keputusan proxy (hasil S2 + S7)

**Proxy WAJIB dibangun dan dipakai.** S2 membuktikan fetch langsung
dari browser ke youtubei dan base.js diblokir CORS total (bukan
sebagian, bukan satu client saja). S7 membuktikan Worker proxy
byte-only menutup loop itu: dari origin app yang sama, POST player dan
GET base.js lewat proxy berhasil dengan status 200 dan body lengkap,
sementara kontrol langsung di halaman yang sama tetap gagal CORS.
Arsitektur mengikuti `arsitektur.md` §4.1 tanpa perubahan: proxy hanya
memindah byte, tidak mengeksekusi base.js, tidak memecahkan cipher,
tidak menyimpan data pengguna. Streaming pemutaran tetap langsung dari
googlevideo ke elemen audio; proxy hanya dipakai untuk byte audio pada
unduhan (§3.6).

## 0. Lingkungan dan batas alat uji

- Egress VM lambat dan tidak stabil selama ronde ini: satu request
  HTTPS biasa memakan 16-40 detik sampai byte pertama (diukur:
  `youtube.com` 16,77 dtk; `googlevideo` Range 16,25 dtk sampai byte
  pertama; `raw.githubusercontent.com` timeout 20 dtk pada satu
  percobaan). Semua angka waktu jaringan di laporan ini adalah angka
  VM dan tidak mewakili perangkat pengguna.
- Fetch Node tidak bisa keluar lewat proxy egress MITM (semua request
  timeout); jalur uji jaringan dari shell adalah curl, dan dari
  browser adalah Playwright lewat relay CONNECT lokal
  (`tests/spikes/connect-relay.py`, port 18081).
- googlevideo dari IP egress VM bersifat non-deterministik: kadang
  200/206, kadang 302 lalu diblokir, kadang timeout 30-60 dtk. Perilaku
  ini sudah tercatat di proyek APK dan terulang di ronde ini.
- Waktu di laporan ini memakai UTC dari stempel file; WIB = UTC + 7 jam.

## 1. S2: Direct fetch dari browser ke youtubei dan base.js

**Kriteria lolos (§8):** vonis CORS final; bila diblokir, bangun Worker
proxy byte-only; bila lolos, tanpa proxy sama sekali. Hasil apa pun
adalah keputusan, bukan kegagalan.

**Vonis: LULUS (vonis: DIBLOKIR, proxy WAJIB).**

### 1.1 Bukti ronde pertama (14:39 UTC, `s2-result.json`)

Origin uji `http://127.0.0.1:4173/`, video kanari `hhn-nGSuenM`
("Semua Tentang Kita"), base.js hash `ad8d59ae` (sts 20768).

| Uji | Hasil | Waktu |
|---|---|---|
| POST player WEB_REMIX (id 67) | Gagal, `TypeError: Failed to fetch` | 9.342 ms |
| POST player MWEB (id 2) | Gagal, `TypeError: Failed to fetch` | 2.212 ms |
| POST player ANDROID_VR (id 14) | Gagal, `TypeError: Failed to fetch` | 2.110 ms |
| GET base.js mode cors, baca body | Gagal, `TypeError: Failed to fetch` | 1.885 ms |
| GET base.js mode no-cors, opaque | Berhasil, status 0, tipe opaque | 2.012 ms |
| KONTROL: GET raw.githubusercontent.com player-config.json | Berhasil, HTTP 200, 869 byte, `hasClients: true` | 3.227 ms |
| KONTROL: GET lrclib.net/api/search | Timeout 30 dtk (AbortError) | 30.001 ms |

Pesan console asli Chromium (3x, satu per client):

> Access to fetch at 'https://www.youtube.com/youtubei/v1/player?...'
> from origin 'http://127.0.0.1:4173' has been blocked by CORS policy:
> Response to preflight request doesn't pass access control check:
> No 'Access-Control-Allow-Origin' header is present on the requested
> resource.

Untuk base.js:

> Access to fetch at 'https://www.youtube.com/s/player/ad8d59ae/.../base.js'
> from origin 'http://127.0.0.1:4173' has been blocked by CORS policy:
> No 'Access-Control-Allow-Origin' header is present on the requested
> resource.

Peristiwa jaringan menegaskan: keempat request youtubei/base.js
berakhir `net::ERR_FAILED`; request base.js mode no-cors mencapai
status 200 tetapi tanpa header `Access-Control-Allow-Origin`
(`acao: null`); kontrol positif mencapai 200 dengan `acao: *`.

### 1.2 Mengapa ini vonis CORS, bukan konektivitas

Tiga lapis bukti saling mengunci:

1. **Pesan preflight asli.** Browser sendiri yang menulis "blocked by
   CORS policy" dengan alasan spesifik (preflight tanpa header ACAO).
   Ini bukan tebakan dari `Failed to fetch` semata.
2. **Kontrol positif.** Dari origin dan browser yang sama,
   `raw.githubusercontent.com` mengembalikan 200 + body 869 byte yang
   terbaca. Browser BISA melakukan fetch lintas origin dan membaca
   body bila server mengirim header CORS. Jalur jaringan hidup.
3. **Mode no-cors.** GET base.js mode no-cors mencapai server dan
   kembali 200 (opaque). Server hidup dan merespons; yang hilang
   hanyalah izin CORS untuk membaca body.

Kontrol lrclib timeout 30 dtk dan tidak dipakai sebagai bukti ke arah
mana pun; satu kontrol positif yang bersih sudah cukup.

### 1.3 Konfirmasi ulang ronde lanjutan (15:29 UTC)

Probe S7 (`s7-browser-probe.mjs`) mengulang kontrol langsung di halaman
yang sama: POST player langsung ke youtubei gagal `Failed to fetch`
dalam 24.090 ms dengan pesan console CORS yang identik. Hasil S2
terkonfirmasi dua kali, dari dua skrip berbeda, berselang 50 menit.

### 1.4 Dampak

- Ketiga client InnerTube (WEB_REMIX, MWEB, ANDROID_VR) sama-sama
  diblokir; tidak ada client yang lolos direct fetch.
- base.js tidak bisa diambil langsung oleh browser; solver browser
  (S1/S4) wajib menerima base.js lewat proxy (`/api/player-script`).
- Keputusan arsitektur §4.1 berlaku penuh: bangun Worker proxy
  byte-only. S7 menguji proxy itu.

## 2. S6: Service Worker cache media opaque + Range slicing

**Kriteria lolos (§8):** lagu yang sudah diputar sekali bisa diputar
offline dari cache; seek bekerja dari cache; estimasi ukuran tercatat.
Bila gagal, v1 hanya membawa unduhan eksplisit dan cache otomatis
pindah ke v1.1.

**Vonis: LULUS DENGAN CATATAN.** Mekanisme terbukti penuh di kaki
lokal. Kaki googlevideo tidak terbukti dari VM karena jaringan VM,
bukan karena mekanisme; uji ulang di luar VM wajib sebelum v1
mengandalkan cache otomatis untuk streaming googlevideo.

### 2.1 Kaki lokal: LULUS PENUH (14:42 UTC, `s6-result.json`)

Server tiruan googlevideo lokal (port 4181, tanpa header CORS,
mendukung Range) + file WAV 60 detik (`test-60s.wav`, 2.646.044 byte).
Service Worker terdaftar dan mengendalikan halaman
(`scope: http://127.0.0.1:4180/`, `controlling: true`).

| Uji | Hasil | Angka |
|---|---|---|
| Putar online | LULUS | 2.285 ms; durasi 60; readyState 4; buffered [0, 60] |
| Cache sesudah online | Terisi | 1 kunci opaque (`?__laras_range=bytes%3D0-`), status 0 |
| Putar offline dari cache | LULUS | 1.455 ms; durasi 60; readyState 4; buffered [0, 60] |
| Seek ke 30 dtk (offline) | LULUS | 1.296 ms; currentTime 31,15 dtk |
| Seek ke 55 dtk (offline) | LULUS | 1.402 ms; currentTime 56,00 dtk |

Semua kriteria §8 terpenuhi di kaki lokal: putar sekali, putar lagi
offline dari cache, seek bekerja dari cache. Pola ViMusic (mencegat
request media, simpan respons opaque, layani Range dari blob
tersimpan dengan respons 206 manual) terbukti bekerja di Chromium ini,
termasuk terhadap origin media tanpa CORS.

Catatan: body cache tercatat "bisa dibaca, 0 byte" karena respons
opaque tidak memberi ukuran; akuntansi ukuran memakai estimasi
durasi x bitrate itag sesuai §3.6 dan wajib dilabeli estimasi di layar
Penyimpanan.

### 2.2 Kaki googlevideo: GAGAL DI VM (14:42 dan 14:46 UTC)

URL itag 251 lagu kanari `hhn-nGSuenM` (host
`rr2---sn-a5mlrnek.googlevideo.com`, `clen=4808098`, `dur=268.461`,
berlaku sampai 20:41:37 UTC):

| Uji | Hasil |
|---|---|
| Putar online tanpa SW (B0) | Gagal: `NotSupportedError`, readyState 0, error code 4; jaringan: 302 lalu `net::ERR_BLOCKED_BY_ORB` |
| Putar online dengan SW (B) | Gagal: `NotSupportedError`, readyState 0, error code 4 (`MEDIA_ELEMENT_ERROR: Format error`); 60.173 ms |
| Putar online ulang (B2) | Gagal: sama; 90.181 ms |
| Putar offline dari cache | Gagal: cache kosong (tidak pernah ada byte masuk) |
| Seek | Tidak teruji (tidak ada pemutaran) |

Kegagalan terjadi SEBELUM satu byte pun sampai ke pemutar: readyState
0, buffered kosong, error code 4. Pertanyaannya adalah di lapisan mana:
format/codec, mekanisme SW, atau jaringan. Ronde lanjutan membedakan
ketiganya dengan tiga bukti independen.

### 2.3 Pembuktian diferensiasi (ronde lanjutan)

**Bukti 1: format itag 251 TERBUKTI diputar (`s6-format-proof.json`,
15:37 UTC).** Byte asli itag 251 dari googlevideo yang sudah terunduh
ke disk (`media/gv251-first1m.webm`, 1.048.576 byte pertama, diunduh
14:40 UTC) diputar lewat server lokal TANPA Service Worker:

- `played: true`, 2.452 ms
- durasi 268,461 (cocok dengan parameter `dur` URL), currentTime 1,50,
  `paused: false`, readyState 4, buffered [0, 268,461], error null
- console error: tidak ada

Format Opus/WebM itag 251 dari googlevideo BISA diputar Chromium ini.
Pesan `MEDIA_ELEMENT_ERROR: Format error` di kaki googlevideo adalah
gejala "tidak ada byte yang bisa di-decode", bukan vonis format tidak
didukung.

**Bukti 2: jaringan VM ke googlevideo lambat dan gagal
(15:33-15:35 UTC).** Probe curl langsung ke URL googlevideo yang sama:

- HEAD: timeout 30 dtk (HTTP 000), padahal CONNECT proxy berhasil
  (`200 Connection Established`).
- GET Range bytes=0-1023: timeout 30 dtk (HTTP 000, 0 byte).
- Ulangan dengan timeout 60 dtk: byte pertama tiba setelah 16,25 dtk,
  lalu 302 (redirect ke host googlevideo lain, tidak diikuti).
- Pembanding di menit yang sama lewat egress yang sama:
  `youtube.com` 16,77 dtk untuk 200;
  `raw.githubusercontent.com` timeout 20 dtk.

Egress VM sedang lambat untuk semua host (16-40 dtk per request) dan
khusus googlevideo sering tidak menjawab sama sekali. Timeout 60-90
dtk dan `ERR_FAILED`/`ERR_BLOCKED_BY_ORB` di browser konsisten dengan
kondisi ini.

**Bukti 3: URL yang sama BISA diambil dari edge Cloudflare
(15:38 UTC, `s7-curl-result.json`).** GET Range bytes=0-1023 ke URL
googlevideo yang sama persis lewat Worker proxy:

- HTTP 206, `Content-Range: bytes 0-1023/4808098`,
  `Content-Type: audio/webm`, 1.024 byte diterima.

URL-nya valid dan bisa dilayani; yang gagal hanyalah jalur jaringan
dari VM ini. Bukti 1 + 2 + 3 bersama-sama menutup kemungkinan penyebab
format dan mekanisme, dan menyisakan jaringan VM sebagai penyebab
kegagalan kaki googlevideo.

### 2.4 Catatan dan utang S6

- **Utang wajib sebelum v1:** uji ulang kaki googlevideo (putar
  online, putar offline dari cache, seek) dari jaringan sehat di luar
  VM (perangkat nyata atau CI dengan egress normal). Sampai utang ini
  lunas, cache otomatis untuk streaming googlevideo berstatus
  "mekanisme terbukti, jalur produksi belum terbukti".
- Mekanisme SW + Range slicing sendiri tidak perlu diuji ulang; yang
  belum terbukti hanya perilaku jaringan googlevideo dari perangkat
  pengguna (juga dicatat S3: jalur langsung `<audio src=googlevideo>`
  tidak bisa diuji dari VM).
- Estimasi ukuran cache memakai 4,2 MB per lagu 3,5 menit untuk itag
  251 (§3.6); angka ini konsisten dengan ukuran nyata lagu kanari
  (4.808.098 byte untuk 268 dtk = sekitar 4,6 MB untuk 4,5 menit).

## 3. S7: Worker proxy byte-only

**Kriteria lolos (§8):** proxy melayani player/search/base.js/unduhan;
CPU per request terukur di bawah 10 ms; cap dan rate limit terbukti
menolak. Bila CPU melewati 10 ms, sederhanakan proxy.

**Vonis: LULUS.**

Worker: `laras-proxy-spike`, URL
`https://laras-proxy-spike.hiroohengkerr.workers.dev`, akun Cloudflare
`hiroohengkerr` (Account ID `05928ed4e4ed9643a5665d1e59315abe`).
Kode: `workers/proxy/src/index.js` (11.800 byte sesudah perbaikan
ronde ini; 11.540 byte sebelumnya). Deploy spike memakai API
Cloudflare langsung (tanpa wrangler); perintah tercatat di
`workers/proxy/README.md`.

### 3.1 Dua bug ditemukan dan diperbaiki selama ronde ini

**Bug 1 (kritis): `ReferenceError` di semua endpoint InnerTube.**
Kode deploy awal memuat blok mati yang merujuk variabel `len` yang
tidak pernah didefinisikan:

```js
if (len > MAX_BODY_BYTES) { ... }
```

Setiap POST ke `/api/innertube/*` melempar `ReferenceError`,
ditangkap `catch` luar, dan kembali sebagai 502 `UPSTREAM_ERROR`.
Terbukti live sebelum perbaikan: POST player mengembalikan 502 dalam
4,13 dtk dengan body
`{"success":false,"error":{"code":"UPSTREAM_ERROR","message":"Kesalahan proxy"}}`.
Perbaikan: blok mati dihapus; pemeriksaan 1 MB yang benar
(`bodyBytes.byteLength > MAX_BODY_BYTES`, tepat di bawahnya) sudah
ada dan tetap berlaku. Verifikasi pasca-perbaikan: POST player
mengembalikan 200 + JSON playability (15:25 UTC).

**Bug 2 (diagnosabilitas): jalur error tanpa CORS dan tanpa header
CPU.** Blok `catch` mengembalikan `jsonError` mentah tanpa header
`Access-Control-Allow-Origin` dan tanpa `x-proxy-cpu-ms`, sehingga
browser tidak bisa membaca kode error apa pun dari proxy (fetch gagal
opaque). Perbaikan: `catch` kini menghitung header CORS dan membungkus
respons dengan `withCpu`, sama seperti semua jalur lain.

**Perbaikan instrumen (spike saja):** header `x-proxy-cpu-ms` tidak
terbaca dari JavaScript browser tanpa `Access-Control-Expose-Headers`.
`withCpu` kini menambahkan
`Access-Control-Expose-Headers: x-proxy-cpu-ms`. Header ukur dan
expose-nya dicabut di deployment produksi sesuai komentar kode.

Riwayat deploy spike:

| Deploy | Waktu (UTC) | Deployment ID | Isi |
|---|---|---|---|
| Awal (tim pertama) | 14:49:36 | - | Kode 11.540 byte, mengandung Bug 1 |
| Perbaikan Bug 1 + 2 | 15:25:19 | `bcfb6be6b26c4086827377c6dc5fe27e` | Hapus blok `len`, CORS di `catch` |
| Tambah Expose-Headers | 15:31:33 | `d4957153e2d644e8a379d932a07b7900` | `Access-Control-Expose-Headers` |

Semua hasil S7 di bawah ini diukur terhadap deployment terakhir
(`d4957153...`), kecuali dinyatakan lain. Setiap deploy diverifikasi
dengan import ESM sungguhan sebelum upload (bukan `node --check`
semata) dan dengan request live sesudah upload.

### 3.2 Proxy melayani player, base.js, dan unduhan dari browser

Probe browser (`s7-browser-probe.mjs`, 15:29 UTC, dan
`s7-browser-retry.mjs`, 15:30 UTC) dari origin app
`http://127.0.0.1:4173/`:

| Uji | Hasil | Waktu (angka VM) |
|---|---|---|
| POST player WEB_REMIX lewat proxy (timeout 30 dtk) | Timeout sinyal 30 dtk | 30.002 ms |
| POST player WEB_REMIX lewat proxy (ulang, timeout 90 dtk) | HTTP 200, playability OK | 31.419 ms |
| POST player ANDROID_VR lewat proxy (timeout 90 dtk) | HTTP 200, playability LOGIN_REQUIRED | 19.105 ms |
| GET player-script `ad8d59ae` lewat proxy | HTTP 200, 3.037.039 byte, diawali `var _yt_player` | 9.155 ms, lalu 6.795 ms |
| KONTROL: POST player LANGSUNG ke youtubei | Gagal CORS (`Failed to fetch` + pesan preflight) | 24.090 ms |

Penjelasan tiga hal yang tampak aneh:

1. **Timeout pertama lalu lolos.** Jalur VM ke proxy + youtubei
   memakan 19-31 dtk; timeout 30 dtk pada percobaan pertama hanya
   kurang beberapa detik. Ulangan dengan timeout 90 dtk lolos. Ini
   lambatnya egress VM, bukan lambatnya proxy (CPU handler 0,000 ms;
   sisa waktu adalah jaringan).
2. **Playability berubah-ubah.** WEB_REMIX mengembalikan
   `LOGIN_REQUIRED` lewat curl 15:25 UTC dan `OK` lewat browser 15:30
   UTC; ANDROID_VR mengembalikan `LOGIN_REQUIRED` di browser pada
   menit yang sama. Perilaku ini berasal dari YouTube (bergantung
   edge/visitorData), bukan dari proxy: proxy meneruskan body apa
   adanya dalam kedua kasus. Pemilihan client yang memberi
   playability stabil adalah urusan tim resolve/solver, bukan S7.
3. **Header CPU null di probe retry.** Sebelum deploy Expose-Headers,
   `res.headers.get('x-proxy-cpu-ms')` mengembalikan null dari JS
   (header tidak terekspos ke CORS). Nilai di jaringan tetap ada
   (curl membacanya); sesudah deploy Expose-Headers, JS browser
   membacanya (lihat §3.4).

Endpoint search/browse/next/suggestions memakai jalur kode yang sama
persis dengan player (tabel `ROUTES`, satu handler); player yang
terbukti live mewakili jalur InnerTube. Uji satu-per-satu kelima
endpoint dari browser dicatat sebagai utang ringan (bukan pemblokir:
tidak ada percabangan kode antar endpoint).

### 3.3 Cap dan gerbang terbukti menolak (curl, 8/8 lolos)

Rangkaian curl `s7-curl-test.py` v2 (15:37-15:39 UTC,
`s7-curl-result.json`): 8 dari 8 cek lolos.

| Uji | Harap | Dapat | CPU |
|---|---|---|---|
| OPTIONS preflight player | 204 | 204 | 0,000 ms |
| GET rute tidak dikenal | 404 | 404 | 0,000 ms |
| GET `/api/innertube/player` (POST-only) | 405 | 405 | 0,000 ms |
| POST body 1.048.584 byte (> 1 MB) | 413 | 413 | 0,000 ms |
| GET `/api/media` tanpa parameter `u` | 400 | 400 | 0,000 ms |
| GET `/api/media` host `example.com` | 403 | 403 | 0,000 ms |
| GET player-script hash `00000000` | 403 | 403 | 0,000 ms |
| GET `/api/media` Range 0-1023 googlevideo | 206 | 206 | 0,000 ms |

Detail penting:

- **Preflight** mengembalikan `Access-Control-Allow-Methods:
  GET, POST, OPTIONS`, `Access-Control-Allow-Headers` mencakup
  `Content-Type, X-YouTube-Client-Name, X-YouTube-Client-Version,
  Range`, dan `Access-Control-Allow-Origin` hanya untuk origin yang
  diizinkan (`http://127.0.0.1:4173`), bukan `*`.
- **Cap body 413** membuktikan pemeriksaan yang tersisa sesudah Bug 1
  diperbaiki bekerja (body 1.048.584 byte ditolak; batas 1.048.576).
- **Gerbang host media 403** membuktikan proxy bukan proxy terbuka:
  host di luar `*.googlevideo.com` tidak pernah diteruskan.
- **Gerbang hash 403** membuktikan allowlist hash dicek SEBELUM fetch
  ke YouTube (hash `00000000` ditolak tanpa request upstream).
- **Range media 206** membuktikan Range passthrough ujung-ke-ujung:
  `Content-Range: bytes 0-1023/4808098`, `Content-Type: audio/webm`,
  tepat 1.024 byte diterima. Total 4.808.098 byte cocok dengan ukuran
  itag 251 lagu kanari yang dicatat tim S3.

Catatan alat: rangkaian v1 (15:32 UTC) melaporkan 0/8 karena parser
membaca blok header `200 Connection Established` milik CONNECT proxy,
bukan respons asli. Parser v2 membaca status dari `-w %{http_code}`
dan header dari blok terakhir. Hasil v1 dibuang; hasil v2 yang
dipakai. File hasil v1 tidak disimpan sebagai bukti.

Cap yang BELUM diuji live dan dicatat sebagai utang: respons JSON
youtubei di atas 10 MB, script player di atas 8 MB, dan media di atas
100 MB (membutuhkan upstream yang mengembalikan body sebesar itu;
tidak dapat dibuat dari endpoint nyata). Logika cap memakai fungsi
`readCapped` yang sama untuk ketiga jalur dan diuji polanya lewat cap
body 1 MB (413). Utang ini ringan: cap adalah pengaman
penyalahgunaan, bukan jalur normal.

### 3.4 CPU per request: jauh di bawah 10 ms

Header `x-proxy-cpu-ms` mengukur jumlah waktu segmen sinkron handler
(validasi + bangun respons), di luar waktu tunggu jaringan upstream.

**Sampel live (Workers):** 16 sampel, semuanya `0,000` ms:

- curl: OPTIONS, 404, 405, 413, 400, 403 (host), 403 (hash), 206
  media, 200 player-script (3 MB), 200 player POST, plus 5 sampel
  OPTIONS tambahan.
- browser (sesudah Expose-Headers): OPTIONS 204, 404, player-script
  200, semuanya terbaca `0,000` dari JS.

**Sampel Node (uji unit §3.5):** 404 = 0,028 ms; OPTIONS = 0,008 ms.

**Interpretasi jujur.** Nilai live `0,000` berarti segmen sinkron
handler berada di bawah resolusi timer `performance.now()` di runtime
Workers (di bawah 0,001 ms pada 3 desimal), bukan berarti handler
tanpa biaya. Uji Node atas kode yang sama mengukur 0,008-0,028 ms.
Kedua angka jauh di bawah batas 10 ms (350x-1.250x margin pada angka
Node). Yang TIDAK diukur header ini adalah loop penyalinan byte
`readCapped` (di luar segmen sinkron yang ditandai); untuk base.js
3 MB itu adalah penyalinan memori kelas memcpy. Rekomendasi: pantau
`cpuTime` lewat analitik Workers di produksi sebagai verifikasi
lanjutan; tidak ada indikasi mendekati batas 10 ms.

### 3.5 Rate limit terbukti menolak

Batas (§4.1): 60 request/menit per IP untuk endpoint InnerTube,
10 unduhan/menit untuk `/api/media`, dengan header `Retry-After`.

**Bukti deterministik: uji unit atas modul Worker asli
(`s7-unit-test.mjs`, 12/12 lolos, `s7-unit-result.json`).**
Handler dipanggil langsung dengan upstream di-stub:

| Uji | Hasil |
|---|---|
| InnerTube 70 POST cepat | Tepat 60 lolos (200), tepat 10 ditolak (429) |
| 429 InnerTube pertama | Request ke-61 |
| Header `Retry-After` InnerTube | `60` |
| Media 12 GET Range cepat | Tepat 10 lolos (206), tepat 2 ditolak (429) |
| 429 media pertama | Request ke-11 |
| Cap body, gerbang host, gerbang hash, hash valid, header CPU | Semua lolos (lihat §3.3 untuk padanan live-nya) |

Logika rate limit terbukti tepat sampai hitungannya: batas 60 dan 10
ditegakkan persis, bukan kira-kira.

**Bukti live: burst dari VM (TIDAK MENUNJUKKAN 429, dijelaskan).**
Dua ronde burst curl:

- Ronde 1 (`s7-ratelimit-result.json`): 70 POST konkurensi 20 dalam
  214 dtk, distribusi 400 x53, 403 x8, error curl x9, 429 x0. Media:
  12 GET konkurensi 6 dalam 62,6 dtk, 206 x11, 403 x1, 429 x0.
- Ronde 2 burst penuh (`s7-ratelimit-result-burst.json`): 70 POST
  konkurensi 70 dalam 91,4 dtk, distribusi 0 x70 (SEMUA request gagal
  total di egress, tidak satu pun mencapai proxy), 429 x0. Media:
  12 GET konkurensi 12 dalam 78,8 dtk, 206 x11, 403 x1, 429 x0.
  (Percobaan pertama ronde 2 crash pada detik ke-92 karena parser
  header tidak menangani file header kosong; diperbaiki, lalu
  diulang sesudah jeda 65 dtk agar jendela rate limit bersih.)

**Mengapa burst live tidak memicu 429.** Laju kedatangan request dari
VM dibatasi egress yang lambat (satu request 20-60 dtk): ronde 1
hanya mencapai sekitar 20 request/menit, jauh di bawah batas 60.
Menaikkan konkurensi ke 70 justru meruntuhkan egress total (ronde 2:
70 dari 70 request gagal sebelum mencapai proxy). Di antara dua
ekstrem itu tidak ada titik yang bisa menghasilkan 60 kedatangan
dalam 60 detik dari VM ini. Bucket in-memory per isolate menambah
penyebaran: request dari satu IP bisa tersebar ke beberapa isolate
Cloudflare, masing-masing dengan bucket sendiri (keterbatasan yang
sudah diakui di §4.1 dan komentar kode; produksi WAJIB pindah ke D1).
Status 400 adalah YouTube menolak body kosong `{}` (passthrough
bekerja); 403 adalah respons upstream non-deterministik, bukan
penolakan proxy.

**Penilaian.** Rate limit DINYATAKAN TERBUKTI dari uji unit
deterministik atas kode deployment yang sama, dengan catatan bahwa
pembuktian live dari VM tidak dimungkinkan oleh kecepatan egress dan
sifat best-effort bucket per isolate. Sebelum produksi, dua hal wajib:
(1) pindah rate limit ke D1 sesuai §4.1; (2) uji burst live ulang dari
jaringan cepat (CI atau perangkat) sesudah migrasi D1.

### 3.6 Utang S7

1. Uji satu-per-satu endpoint search/browse/next/suggestions dari
   browser (jalur kode sama dengan player; utang ringan).
   **SEBAGIAN TERTUTUP 18 Nov 2026**: search/browse/next via proxy
   diuji langsung (curl) oleh koordinator — ketiganya HTTP 200
   dengan contents nyata (search: 237.932 byte, 30 hasil lagu;
   browse + next: contents ada). Sisa utang: uji yang sama DARI
   BROWSER (bukan curl).
2. Uji live cap respons 10 MB (JSON), 8 MB (script), 100 MB (media)
   dengan upstream buatan (utang ringan; pola cap terbukti via 413).
3. Migrasi rate limit in-memory ke D1 sebelum produksi (§4.1), lalu
   uji burst live ulang dari jaringan cepat.
4. Pantau `cpuTime` lewat analitik Workers di produksi (verifikasi
   lanjutan atas header ukur spike; header dicabut di produksi).
5. `readCapped` menyalin seluruh body ke memori sebelum merespons
   (bukan streaming) untuk jalur JSON dan script; untuk cap 10 MB ini
   dapat diterima, tetapi produksi perlu meninjau ulang bila cap
   dinaikkan.

### 3.7 Adendum 18 Nov 2026: playability NON-DETERMINISTIK (koreksi S7)

Variabilitas §3.2 poin 2 berlanjut dan makin tajam. Garis waktu
WEB_REMIX via proxy yang sama:

- 17 Nov 15:30 UTC (S7): HTTP 200, playability **OK**.
- 18 Nov ~08:00 WIB (parent, §5): HTTP 200, playability
  **LOGIN_REQUIRED**, 0 format audio.
- 18 Nov ~08:05–08:25 WIB (koordinator): HTTP 200, playability
  **OK 3/3** (4 format audio tiap kali), sementara MWEB dan
  ANDROID_VR di menit yang sama LOGIN_REQUIRED.

Penanda berubah per **client × waktu** (dan kemungkinan per IP
egress per request). Satu probe TIDAK BISA jadi vonis permanen
untuk satu egress/client. Setiap klaim "egress X diblokir/lolos"
WAJIB membawa jam + client + jumlah ulangan.

Temuan tambahan di jendela yang sama: replay player via proxy
dengan visitorData yang dipanen dari VM (bukan dari egress CF)
membalik ANDROID_VR 2/2 dan MWEB 1/2 menjadi OK, sementara
kontrol tanpa visitorData di menit yang sama tetap LOGIN_REQUIRED
(0/6). VisitorData yang dipanen LEWAT proxy (perilaku resolver
saat ini) tidak membantu — yang penting sumber panen, bukan
keberadaan visitorData. Detail lengkap + evaluasi opsi:
`docs/spikes/egress-dan-opsi-resolve.md`.

## 4. Keputusan dan tindak lanjut

| # | Keputusan / tindak lanjut | Pemilik | Status |
|---|---|---|---|
| 1 | Proxy WAJIB dipakai; fetch langsung mati (S2) | Arsitektur | Diputuskan |
| 2 | Worker proxy spike LULUS dan siap jadi dasar produksi | Tim Jaringan | Selesai |
| 3 | Perbaiki Bug 1 (`len`) + Bug 2 (CORS di `catch`) + Expose-Headers | Tim Jaringan | Selesai, terdeploy |
| 4 | Uji ulang kaki googlevideo S6 di luar VM | Tim Jaringan / QA perangkat | Utang wajib |
| 5 | Migrasi rate limit ke D1 + uji burst live ulang | Backend | Utang wajib pra-produksi |
| 6 | Uji kelima endpoint InnerTube satu-per-satu | Tim Jaringan | Utang ringan |
| 7 | Uji live cap respons 10/8/100 MB | Tim Jaringan | Utang ringan |
| 8 | Pantau `cpuTime` produksi via analitik Workers | Backend | Utang ringan |

## 5. Indeks bukti

Semua file di bawah `~/workspace/music-app-web/` (relatif terhadap
repo `laras-web`).

| Bukti | File |
|---|---|
| Hasil S2 (ronde pertama) | `app/tests/spikes/s2-result.json` |
| Skrip probe S2 | `app/tests/spikes/s2-probe.mjs` |
| Hasil S6 kaki lokal + googlevideo | `app/tests/spikes/s6-result.json` |
| Hasil S6 googlevideo ulang | `app/tests/spikes/s6-result-b2.json` |
| Bukti format itag 251 diputar | `app/tests/spikes/s6-format-proof.json` + `s6-format-proof.mjs` |
| Server + halaman + SW S6 | `app/tests/spikes/s6-server.mjs`, `s6-page.html`, `s6-sw.js` |
| Media uji (WAV 60 dtk + webm itag 251) | `app/tests/spikes/media/test-60s.wav`, `media/gv251-first1m.webm` |
| Probe browser S7 | `app/tests/spikes/s7-browser-probe.mjs` + `s7-browser-result.json` |
| Probe browser S7 (ulang 90 dtk) | `app/tests/spikes/s7-browser-retry.mjs` + `s7-browser-result-retry.json` |
| Probe CPU dari browser | `app/tests/spikes/s7-cpu-browser.mjs` + `s7-cpu-browser-result.json` |
| Rangkaian curl S7 (cap/gerbang/CPU) | `app/tests/spikes/s7-curl-test.py` + `s7-curl-result.json` |
| Uji rate limit (ronde 1) | `app/tests/spikes/s7-ratelimit-test.py` + `s7-ratelimit-result.json` |
| Uji rate limit (burst penuh) | `app/tests/spikes/s7-ratelimit-burst.py` + `s7-ratelimit-result-burst.json` |
| Uji unit Worker (deterministik) | `app/tests/spikes/s7-unit-test.mjs` + `s7-unit-result.json` |
| Kode Worker proxy | `workers/proxy/src/index.js` (11.800 byte) |
| Dokumen Worker + perintah deploy | `workers/proxy/README.md`, `workers/proxy/wrangler.toml` |
| Relay CONNECT untuk Playwright | `app/tests/spikes/connect-relay.py` |
