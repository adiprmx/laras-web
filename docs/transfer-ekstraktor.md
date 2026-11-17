# Transfer Ekstraktor: Pengetahuan Laras APK yang Dipakai Ulang di Web

**Proyek:** Laras Web App Full-Stack (Fase 1, Tim Transfer Ekstraktor)
**Tanggal:** 17 November 2026
**Sumber:** `~/workspace/music-app/docs/arsitektur.md` (§3, §3.5–3.7, §6),
`~/workspace/music-app/docs/prd-v1.md`, `~/workspace/music-app/laras/docs/spike-ekstraksi.md`
(P1 + Adendum P0 + adendum koordinator 16 Nov 2026),
`~/workspace/music-app/hidden_files/koordinator-fase-2/log.md`,
kode `~/workspace/music-app/laras/lib/extractor/` (dibaca langsung),
`player-config-2026-11-17.json`.
**Aturan dokumen ini:** semua angka dikutip dari sumber di atas atau dari
pengukuran yang dicatat tanggalnya. Tidak ada angka karangan. Bila sebuah
angka berasal dari satu pengukuran VM, itu dinyatakan eksplisit.

---

## 1. Ringkasan satu halaman

Ekstraktor Laras APK adalah client InnerTube kustom: memanggil endpoint
`player` YouTube, memilih format audio, dan — bila formatnya terproteksi
cipher — menjalankan script player YouTube (`base.js`) di runtime
JavaScript lokal untuk memecahkan signature (`sig`) dan tantangan
throttling (`n`). Semua pengetahuan di bawah ini TERBUKTI di APK
(15–17 Nov 2026, 892 tes hijau, RC v1.0.0 terverifikasi) dan dapat
dipakai ulang di web dengan penyesuaian platform yang dicatat di §12.

Tiga hal yang paling menentukan keberhasilan porting:

1. **Urutan fallback client yang terbukti** — hanya 3 client yang memberi
   audio yang bisa diputar tanpa login (§2).
2. **`signatureTimestamp` (sts) WAJIB** di request player pertama, dan
   **visitorData segar** saat reputasi IP rendah (§3).
3. **Mode terdegradasi + client bebas-script ANDROID_VR** adalah jaring
   pengaman yang menyelamatkan pemutaran saat base.js berubah (§3.5, §9).

---

## 2. Client InnerTube dan urutan fallback yang terbukti

### 2.1 Urutan fallback (hasil ukur, bukan usulan desain)

Urutan ini adalah HASIL UKUR spike P1 (15–16 Nov 2026, 5 lagu kanari)
ditambah P0 (16 Nov 2026). Usulan desain awal (ANDROID_MUSIC dulu)
DIGANTI hasil ukur ini.

| Urutan | Client | clientId header | Versi terbukti | Sifat |
|---|---|---|---|---|
| 1 | WEB_REMIX | 67 | 1.20261110.04.00 | Format cipher; butuh script (sts + solver) |
| 2 | MWEB | 2 | 2.20260708.05.00 | Format cipher; butuh script (sts + solver) |
| 3 | ANDROID_VR | 14 | 1.65.10 | URL LANGSUNG tanpa cipher; TIDAK butuh script (`requiresScript: false`) |

Sumber versi: WEB_REMIX dari HTML `music.youtube.com`
(`INNERTUBE_CLIENT_VERSION`, 15 Nov 2026, diverifikasi ulang 16 Nov
2026 tidak berubah); MWEB dari yt-dlp master; ANDROID_VR 1.65.10 dari
yt-dlp master. Versi pin extractor lama GAGAL di probe: WEB_REMIX versi
pin yt-dlp/pytubefix 1.20260707.12.00 kena LOGIN_REQUIRED — hanya versi
live dari HTML yang bekerja. **Versi client tidak boleh di-pin lama;
versi hidup di config remote (§7), bukan di-hardcode.**

Catatan ketidaksesuaian yang wajib diperhatikan saat porting: nilai
`clientId` (header `X-YouTube-Client-Name`) ANDROID_VR di kode dan
config adalah `14`, sementara tabel arsitektur §3.2 mencatat ID
InnerTube numerik ANDROID_VR `28`. Web WAJIB memakai nilai yang
terbukti di kode (`14`) untuk header, dan memverifikasi ulang bila
memakai ID numerik di tempat lain.

### 2.2 Client yang dikecualikan — dengan alasan terbukti

| Client | Hasil probe | Alasan pengecualian |
|---|---|---|
| ANDROID (3) | Playability OK 5/5 | SEMUA format audio hanya SABR (§6) |
| IOS (5) | Playability OK 5/5 | SEMUA format audio hanya SABR |
| ANDROID_MUSIC (21) | LOGIN_REQUIRED 5/5 | "Please sign in", semua versi yang dicoba (7.27.52, 8.05.53), dengan/tanpa visitorData, SDK 30 maupun 34 |
| IOS_MUSIC (26) | LOGIN_REQUIRED 5/5 | "Please sign in" (7.27.0) |
| WEB (1) | LOGIN_REQUIRED | "Sign in to confirm you're not a bot" |
| WEB_EMBEDDED_PLAYER (56) | ERROR 5/5 | "This video is unavailable" |
| TVHTML5_SIMPLY_EMBEDDED_PLAYER (85) | ERROR | "no longer supported" |
| ANDROID_VR (28) | LOGIN_REQUIRED di P1 | **Dibatalkan pengecualiannya di P0:** probe ulang dengan sts + visitorData segar LOLOS (probe p0d/p0f). Keadaan client BERUBAH; pengecualian harus diuji ulang berkala, bukan dianggap permanen. |

### 2.3 Bentuk request player

- Endpoint: POST JSON ke `https://www.youtube.com/youtubei/v1/player`
  (host `www.youtube.com` untuk SEMUA client, termasuk WEB_REMIX).
  Alasan: POST ke `music.youtube.com` STALL TOTAL dari VM (0 byte dalam
  120 detik, 2 kali — temuan koordinator, dicatat di
  `client_definitions.dart`).
- Body: `context.client` berisi `clientName`, `clientVersion`, dan
  `visitorData` (bila ada), ditambah `videoId` dan
  `playbackContext.contentPlaybackContext.signatureTimestamp` (sts,
  §3.1). Bila client butuh attestation, token dikirim di
  `serviceIntegrityDimensions.poToken` — v1 TIDAK melakukan minting
  poToken/BotGuard (sengaja tidak masuk cakupan; lihat §11).
- Header per client wajib cocok dengan client asli yang ditiru
  (User-Agent dan `X-YouTube-Client-Name` yang sesuai). User-Agent
  terbukti ada di config §7.3.
- Kunci API InnerTube: `AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8`.
  Ini kunci PUBLIK yang tertanam di halaman youtube.com dan dipakai
  yt-dlp/pytubefix — BUKAN secret (keputusan K-F2-10, ditegaskan ulang
  di Red 2/Red 3). Tidak ada kunci lain yang dipakai.

---

## 3. Alur resolve

Alur ini adalah `StreamResolver` di `fallback_orchestrator.dart`.
Urutan langkahnya mengikat — mengubah urutan memecahkan resolve
(terbukti di insiden P0).

```
1. Ambil config remote (urutan client + versi + allowlist hash).
2. Pastikan visitorData segar (dari endpoint search, cache 6 jam).
3. Muat script player (cache memori per hash; unduh bila belum ada)
   untuk signatureTimestamp (sts).
   → Bila script GAGAL dimuat: masuk MODE TERDEGRADASI (§3.5),
     JANGAN langsung gagal.
4. Untuk tiap client dalam urutan fallback (dengan rotasi, §3.6):
   a. Request player DENGAN sts.
      → Bila LOGIN_REQUIRED: refresh visitorData + muat ulang script,
        ulangi SEKALI untuk client itu.
   b. Parse respons; pilih format audio (pemilih itag, §5).
   c. Format URL langsung → selesai.
      Format cipher → solver (§4) → selesai.
   d. Kegagalan apa pun → client berikutnya.
5. Semua client habis → lempar error dengan penyebab paling informatif
   (penyebab non-jaringan didahulukan atas penyebab jaringan).
```

Aturan pendukung yang terbukti penting:

- **Single-flight per videoId:** dua resolve bersamaan untuk lagu yang
  sama memakai satu pekerjaan. Berlaku juga untuk load script dan
  fetch config.
- **URL stream hanya ada di memori**, tidak pernah disimpan di database,
  file, atau log (PRD B2.1). Yang disimpan adalah videoId; URL
  di-resolve ulang setiap kali giliran lagu tiba atau sesudah jeda
  panjang.
- **Satu client gagal lalu client berikut berhasil TIDAK terlihat
  pengguna** (tanpa error, tanpa pesan). Kegagalan baru ditampilkan
  bila semua client gagal, dengan pesan bahasa sehari-hari sesuai
  penyebab — bukan kode error mentah.
- **Log resolve tanpa URL** disimpan di memori (maks 50 baris, per
  client: hasil + durasi ms + penyebab terstruktur) untuk diagnosis
  (§9.4).

### 3.1 signatureTimestamp (sts) WAJIB

Temuan 16 Nov 2026, terbukti 4 kombinasi (`diag-sts-vd.js`):

| Kombinasi | Hasil |
|---|---|
| sts + visitorData | OK, 4 format audio |
| tanpa sts + visitorData | UNPLAYABLE ("The page needs to be reloaded.") |
| sts + tanpa visitorData | OK, 4 format audio |
| tanpa sts + tanpa visitorData | UNPLAYABLE |

Karena itu app memuat script player DULU (untuk sts) sebelum request
player pertama. Desain lama ("tanpa sts dulu, ulangi bila
LOGIN_REQUIRED") SALAH — tanpa sts server membalas UNPLAYABLE, bukan
LOGIN_REQUIRED, sehingga retry tidak pernah terpicu.

Nilai sts per hash (config remote, §7.3): fad7e4e9 → 20767,
ad8d59ae → 20768, b559f50c → 20770. Varian tcl fad7e4e9 memakai sts
20767001. sts lama 20767 MASIH diterima server saat varian tcl muncul
(terbukti probe P0) — sts tidak harus persis sama dengan sts hash
terbaru, tapi harus ada.

### 3.2 visitorData

- Saat reputasi IP rendah, request player TANPA visitorData dibalas
  LOGIN_REQUIRED untuk SEMUA client; dengan visitorData segar dari
  endpoint search, WEB_REMIX lolos (probe 15 Nov 2026).
- App mengambil visitorData lewat search, cache 6 jam. Bila player
  LOGIN_REQUIRED, refresh sekali lalu ulangi sekali.
- `ensureVisitorData` tidak pernah melempar (terbukti tes P0-2):
  kegagalan mengambil visitorData tidak boleh membunuh resolve.
- Rekomendasi P0-2 yang BELUM diimplementasikan (butuh bukti kode
  dulu): visitorData cadangan dari HTML youtube.com yang sudah
  diunduh loader script.

### 3.3 Cipher: signature (`sig`) dan `n`

- URL stream diacak: parameter signature (`sig`/`s`) harus diubah
  dengan fungsi decipher yang hanya ada di `base.js`; parameter `n`
  (throttling) harus diubah dengan fungsi transform yang juga ada di
  `base.js`. Bila nilai `n` salah, server memberi 0 byte atau
  membatasi kecepatan sampai tidak bisa diputar.
- Cara kerja solver (terbukti di Node, spike 2; validasi oracle
  pytubefix 11.2.1 — signature dan `n` IDENTIK):
  1. Ekstrak dari `base.js` saat berjalan (regex call-site +
     pencocokan kurung, BUKAN hardcode): nama fungsi decipher,
     rantai transform, tabel string, helper.
  2. Jalankan fungsi decipher di runtime JS lokal.
  3. Bangun URL final lewat kelas URL internal player
     (`new <kelas URL>(cipherUrl, true)` → set `sig` → serialisasi).
     Serialisasi inilah yang menjalankan transform `n`.
- **Nama kelas URL + metode set/serialisasi BERPUTAR per hash dan
  WAJIB dibaca dari base.js per hash** (bug nyata Tim Fix Solver,
  17 Nov 2026 — driver lama meng-hardcode `tf`/`gf`, padahal `g.tf`
  TIDAK MUNCUL SAMA SEKALI di kedua hash baru; grep: fad7e4e9
  g.tf=19, ad8d59ae g.tf=0/g.bs=19, b559f50c g.tf=0/g.JH=19):

  | Hash | Kelas URL | Metode serialisasi |
  |---|---|---|
  | fad7e4e9 | `tf` | `gf` |
  | ad8d59ae | `bs` | `ff` |
  | b559f50c | `JH` | `gf` |

- Contoh rantai signature fad7e4e9 (didokumentasikan, bukan untuk
  di-hardcode): `vf(2,6827,Ne(56,7789,uf(9,8472,s)))` — `uf` =
  decodeURIComponent, `Ne` = cabang 4 (splice 2, swap 69, splice 1,
  swap 9, splice 1, swap 46), `vf` = encodeURIComponent.
- Bukti byte audio: URL final (sig decipher + n transform), Range
  0–999 → HTTP 206, `audio/webm`, head hex `1a45dfa3` (magic
  EBML/WebM). Tanpa header Range: HTTP 403 (dari VM).

### 3.4 Script player: unduh, cache, gerbang hash, fallback varian

- `PlayerScriptLoader`: HTML youtube.com → jsUrl → base.js →
  ekstraksi. Cache memori per hash: bila hash jsUrl dari HTML terbaru
  sama dengan yang sudah dimuat, base.js (~2,7 MB) tidak diunduh
  ulang tiap resolve. Cache memori hilang saat app ditutup; cache
  disk diizinkan (base.js bukan URL stream, jadi boleh disimpan).
- **Gerbang hash SEBELUM unduh (R1-M2):** hash yang tidak ada di
  allowlist (§7) DITOLAK sebelum base.js diunduh, apalagi dieksekusi.
  Cache diperiksa ulang terhadap allowlist. Ini gerbang keamanan yang
  melindungi mesin solver.
- **Fallback varian non-tcl (P0, 16 Nov 2026):** YouTube mulai
  melayani varian `player_es6_tcl` (obfuscation baru: tabel string
  `g.d='...'.split("{")` + indeks XOR + dispatcher `pa`) sehingga
  pola ekstraksi app tidak cocok (callSite NULL, table NULL) →
  `unknownPlayerHash` SEBELUM request player. Varian non-tcl dengan
  hash yang sama masih dilayani (HTTP 200, 2.677.001 byte, rantai
  signature utuh, sts 20767 masih diterima). Bila ekstraksi varian
  dari HTML gagal, loader mencoba varian non-tcl dengan hash yang
  sama (hanya mengubah infiks path `player_es6_tcl` →
  `player_es6`) sebelum menyerah. Peringatan: fallback ini rapuh
  (tidak diketahui berapa lama varian lama tetap dilayani); VR adalah
  jaring pengaman yang tidak bergantung base.js.
- Ukuran base.js yang terukur (semua non-tcl kecuali dinyatakan):

  | Hash | Ukuran | sts | sha256 (awalan) |
  |---|---|---|---|
  | fad7e4e9 | 2.677.001 byte | 20767 | `dbfabdaf…` |
  | fad7e4e9 (varian tcl) | 2.876.993 byte | 20767001 | — |
  | ad8d59ae | 2.679.612 byte | 20768 | `aa9d9b7f…` |
  | b559f50c | 2.684.806 byte | 20770 | `d9ed02c4…` |

- **Multi-hash bersamaan (17 Nov 2026):** YouTube menyajikan
  beberapa hash bersamaan — halaman tonton → ad8d59ae, beranda →
  b559f50c, di menit yang sama. Allowlist multi-hash adalah
  KEHARUSAN, bukan kemewahan. Hash bawaan + config remote kini
  membawa ketiganya.
- **Format tabel string berubah (17 Nov 2026):** bentuk lama
  `w='...'.split(";");` HILANG di kedua base.js baru. Bentuk baru:
  `w="...".split("X");` (kutip ganda, delimiter bervariasi: `;` di
  ad8d59ae, `{` di b559f50c). `extractStringTable` menerima kedua
  bentuk (lama dulu; baru dengan isi ≥100 karakter + `\"`, delimiter
  1–3 karakter).
- **Helper builtin (17 Nov 2026):** cipher ad8d59ae memakai global
  bawaan `String` sebagai helper (`String.fromCharCode` dkk., tanpa
  literal objek `String={` di file; tabel berisi fromCharCode/split/
  reverse/join/slice/splice). `buildPlayerScript` mengizinkan helper
  builtin tanpa literal (daftar `kJsBuiltinGlobals`: String/Array/
  Object/Math/dll.); helper kustom yang hilang tetap gagal keras.
- **Bug Vm — kolektor dependensi transitif (17 Nov 2026):**
  `buildPlayerScript` lama hanya memuat SATU objek helper (pertama
  ketemu); di ad8d59ae yang pertama adalah `String` (builtin, tanpa
  literal) sehingga `Vm` (dipakai `Xm` di cabang hidup) tidak pernah
  dimuat → `ReferenceError: Vm is not defined`, semua resolve
  scripted gagal. Perbaikan: kolektor dependensi TRANSITIF (BFS, cap
  64 definisi) + pemindai JS kecil + alias IIFE `var g = _yt_player;`.
  Cap byte prelude 1 MB (gagal keras `unknownPlayerHash` bila lewat —
  prelude raksasa = base.js patologis; memotong akan ReferenceError
  saat solve). Kedalaman template JS dibatasi 32.
  Solve live kini terverifikasi end-to-end untuk KETIGA hash hidup
  (reproduksi koordinator: ad8d59ae 13 dtk, b559f50c 15 dtk total;
  transform `n` terverifikasi di ad8d59ae).

### 3.5 Mode terdegradasi

Bila script player gagal dimuat (ekstraksi base.js gagal / jaringan
putus saat unduh), client yang butuh script (`requiresScript: true`)
DILEWATI tanpa request player — tanpa sts mereka DIJAMIN UNPLAYABLE,
dan format cipher mereka tidak bisa dipecahkan tanpa solver. Client
bebas-script (saat ini hanya ANDROID_VR, terbukti probe P0f lolos
tanpa sts dan memberi URL langsung) tetap dicoba. Bila tidak ada
client bebas-script yang berhasil, error script yang dilempar (bila
tidak ada client yang dicoba sama sekali) atau error client terakhir
yang paling informatif.

Mode terdegradasi juga bisa masuk di TENGAH loop (P0-2): bila load
script gagal saat jalur cipher sesudah load awal berhasil (mis. hash
player baru muncul saat load ulang), orkestrator TIDAK berhenti —
client butuh-script yang tersisa dilewati dan client bebas-script
tetap dicoba. Versi lama memakai `break` di titik ini dan VR tidak
pernah dicoba (Lubang 1 P0-2, §9.1).

Tanpa mode ini, satu perubahan base.js YouTube mematikan SEMUA putar
— persis insiden P0 16 Nov 2026 (owner: nol bunyi sama sekali).

### 3.6 Rotasi client antar-resolve

Bila satu resolve menghabiskan semua client dan gagal, resolve
BERIKUTNYA untuk lagu yang sama mulai dari client berikutnya dalam
urutan fallback, bukan mengulang urutan yang sama dari awal. Retry
pengguna dan re-resolve otomatis jadi mencoba client lain dulu.
Sukses menghapus rotasi (urutan default lagi). Rotasi disimpan per
videoId, dibatasi 50 entri, best-effort.

### 3.7 Waktu resolve yang terukur

10 resolve nyata, Node di VM, 16 Nov 2026, steady-state (visitorData
+ script sudah hangat; warm-up tidak dihitung):

| Metrik | Nilai |
|---|---|
| Berhasil | 10/10 |
| Median total | 4.049 ms |
| Median player (HTTP) | 4.028,5 ms |
| Median solve | 10,5 ms |
| Min total | 2.440 ms |
| Max total | 20.482 ms |
| Target desain (K1) | <2.000 ms |

Target TIDAK tercapai dari VM. Bottleneck-nya panggilan player HTTP
lewat proxy egress VM (median ~4 detik), BUKAN solver (median
10,5 ms — komputasi solver tidak signifikan). Putaran ke-2 jauh lebih
cepat dari putaran ke-1 (median 2.807 ms vs 7.939 ms) — koneksi hangat
membantu. Angka perangkat owner di jaringan HP langsung hampir pasti
lebih baik, tapi WAJIB diukur di sana (K1 berstatus TERTUNDA di
verifikasi K1–K15).

---

## 4. Solver: batas operasi yang terbukti

Angka-angka ini berasal dari SimpMusic (satu-satunya kompetitor yang
rilis rutin sampai Nov 2026), dibaca langsung dari source-nya, lalu
dipakai dan dibuktikan di Laras:

| Batas | Nilai | Catatan |
|---|---|---|
| Memori runtime | 192 MiB | Membangun AST base.js (~2,6 MiB) butuh >128 MiB; batas 16 MB (usulan awal A6) akan memecahkan solver |
| Stack runtime | 256 KiB (saat ini, gg_quickjs) | Default gg_quickjs; README paket memperingatkan limit >512 KiB bisa crash proses native (stack isolate Dart ~1 MiB di 64-bit). Nilai 8 MiB adalah era quickjs_engine/SimpMusic dan TIDAK aman di gg_quickjs — jangan dikembalikan |
| Timeout satu eksekusi | 10 detik | Init maupun solve; ditegakkan native (interrupt handler) + backstop bunuh-isolate di Dart |
| Eksekusi | Serial | Dua track yang resolve bersamaan dengan tiap runtime memegang limit 192 MB bisa kehabisan memori bila paralel |
| Callback host / fetch dari JS | Tidak ada | Solver murni komputasi; tanpa callback host, tanpa fetch |

Riwayat mesin solver (penting untuk porting — JANGAN meniru versi
lama):

1. `quickjs_engine` 0.1.7 (QuickJS-NG 0.14.0) — pilihan awal P1.
   Cacat fatal: parameter `timeout` TIDAK BERFUNGSI (sisi Dart
   meneruskannya ke `jsNewRuntime`, tapi implementasi C tidak
   memasang interrupt handler sama sekali; argumen dibuang diam-diam
   oleh ABI C). Timeout 10 detik terpaksa ditegakkan di Dart (isolate
   dimatikan paksa lalu dibuat ulang). Juga rentan CVE-2026-120438 /
   -120439 / -120440 (R1-H1; diperbaiki di 0.16.0). Tidak bisa dites
   di `flutter test` host Linux (tidak membawa lib native Linux).
2. `gg_quickjs` 0.1.0 (QuickJS-ng 0.17.0) — pengganti (Blue 1).
   Timeout BERFUNGSI via interrupt handler; mendukung Linux host.
3. Fork `adiprmx/gg_quickjs` commit `0bb8b583` (QuickJS-ng 0.18.0) —
   versi final (Blue 2 + hotfix CI 17 Nov 2026). Upstream pub.dev
   tertinggal di 0.17.0 dengan 2 UAF (#1781/#1844) + OOM uncatchable
   yang sudah diperbaiki di 0.18.0. Commit 0bb8b583 memperbaiki
   signature `JSInterruptHandler` (`JSRuntime *` → `JSContext *`,
   berubah di QuickJS-ng 0.18.0; Clang 16+ menjadikan ketidakcocokan
   ini ERROR, GCC hanya warning — tes lokal lolos karena memakai shim
   gcc, CI gagal). Kembali ke upstream adalah jalur yang
   didokumentasikan bila upstream merilis ≥0.18.0.

Ukuran kontribusi QuickJS di APK rilis (CI pasca-P1): 1.240.840 byte.

Keputusan solver untuk WEB (Worker vs browser) ada di dokumen
terpisah: `keputusan-solver.md`. Ringkasnya: solver jalan DI BROWSER
(QuickJS-WASM di Web Worker khusus).

---

## 5. Format itag

### 5.1 Tabel itag audio

| Itag | Container | Codec | Bitrate | Ketersediaan |
|---|---|---|---|---|
| 139 | MP4 | AAC (LC) | 48 kbps | Ya |
| 140 | MP4 | AAC (LC) | 128 kbps | Ya, termasuk YT Music |
| 141 | MP4 | AAC (LC) | 256 kbps | Premium saja |
| 249 | WebM | Opus (VBR) | ~50 kbps | Sebagian video |
| 250 | WebM | Opus (VBR) | ~70 kbps | Sebagian video |
| 251 | WebM | Opus (VBR) | ~128–160 kbps | Ya |

Kualitas audio publik terbaik adalah itag 251 (Opus, sampai ~160
kbps). Tidak ada stream 320 kbps dan tidak ada yang lossless. Itag
141 hanya untuk pelanggan Premium. Klaim "lossless streaming" dari
sumber mana pun tidak bisa benar untuk sumber YouTube.

Itag 599/600 juga teramati di respons MWEB dan fixture SABR-only
ANDROID (format audio tambahan tanpa `url`/cipher pada SABR-only).

### 5.2 Urutan pemilihan

- Urutan kualitas terbaik (kanonis): **251, 140, 250, 249, 139**.
- Urutan hemat data (saklar "Hemat data"): **249, 139, 250, 140,
  251**; naik bila perlu supaya lagu tetap bisa diputar.
- Aturan yang mengikat: format SABR tidak pernah dipilih; format
  tanpa URL langsung dan tanpa `signatureCipher` yang lengkap juga
  tidak dipilih.
- Itag di luar daftar yang dikenal: pakai bitrate tertinggi sebagai
  jalan terakhir, supaya format audio baru dari YouTube tetap bisa
  jalan.
- Label kualitas unduhan (PRD, tanpa istilah teknis di UI): "Terbaik"
  (251, ~4,2 MB per lagu 3,5 menit), "Seimbang" (140, ~3,4 MB),
  "Hemat data" (249/139, ~1,3 MB). Hitungan memakai rumus bitrate ×
  durasi ÷ 8 dengan asumsi durasi 210 detik.

---

## 6. Deteksi SABR (Server Adaptive Bitrate)

SABR adalah protokol streaming adaptif milik YouTube yang dikendalikan
server. Format SABR tidak memberi URL HTTP statis; sebagai gantinya
ada `serverAbrStreamingUrl`. Playback SABR memakai request protokol
biner, framing UMP, dan sering membutuhkan poToken. **V1 menolak
format SABR; app tidak memilih format SABR dan tidak pernah memakai
`serverAbrStreamingUrl` sebagai URL putar.**

Aturan deteksi (HASIL SPIKE P1 — memperbaiki aturan desain awal):

- Status SABR ditentukan **PER FORMAT**, bukan dari field tingkat
  atas `streamingData`. Respons WEB_REMIX membawa
  `serverAbrStreamingUrl` tingkat atas SEKALIGUS format konvensional
  di `adaptiveFormats`, jadi field tingkat atas saja BUKAN penanda
  SABR-only.
- Format ditandai SABR bila (a) punya `serverAbrStreamingUrl`
  sendiri, ATAU (b) tidak punya URL langsung maupun cipher SEMENTARA
  respons membawa URL SABR tingkat atas.
- Bentuk SABR-only yang teramati (client ANDROID/IOS): format audio
  TIDAK punya `url`, TIDAK punya `signatureCipher`, dan TIDAK punya
  `serverAbrStreamingUrl` per format (fixture respons asli di
  `test/fixtures/player-android-sabr-only.json`: 6 format audio
  139/140/249/251/599/600 seperti itu; satu-satunya jalur putar
  adalah URL SABR tingkat atas).
- Pemilih itag tidak pernah memilih format SABR (tes: semua SABR →
  null; campuran → pilih yang konvensional).

Klaim "semua permukaan web YouTube sudah pindah ke SABR" TERBANTAH
untuk WEB_REMIX dan MWEB (keduanya masih memberi format konvensional
cipher 5/5 lagu kanari, 15–16 Nov 2026).

---

## 7. Config remote

### 7.1 Peran dan prinsip

Pola SimpMusic/Metrolist faraday: tabel player config remote berisi
nama fungsi/class di dalam player JS, signatureTimestamp, daftar
client + versinya — BUKAN signature yang sudah di-decode. Yang dibeli
tabel adalah langkah penebakan yang rusak setiap kali YouTube
mengacak obfuscation-nya. Dengan tabel, kerusakan diperbaiki dengan
menerbitkan entri baru, bukan merilis app baru.

Aturan yang mengikat:

- Config adalah DATA, bukan kode. App tidak pernah mengeksekusi
  JavaScript dari tabel config (yang dieksekusi hanyalah script
  player YouTube itu sendiri).
- Config diambil lewat HTTPS dari host yang di-pin (GitHub Releases
  repo sendiri); validasi skema sebelum dipakai.
- Bila host mati atau config rusak, app memakai cache terakhir yang
  valid, lalu nilai bawaan.
- Nomor versi skema config ada di file; app lama menolak config yang
  tidak dikenalnya.

### 7.2 Perilaku loader (`RemoteConfigLoader`)

| Perilaku | Nilai |
|---|---|
| TTL refresh normal | 6 jam (21.600 detik) |
| Timeout fetch | 5 detik |
| Maks ukuran respons | 4 MB |
| Single-flight | Ya (satu fetch bersamaan) |
| Rate limit | Fetch tidak diulang dalam 5 menit kecuali dipaksa |
| Stale-while-revalidate | Ya (cache basi tetap dipakai sambil fetch baru jalan di latar) |
| Refresh dipicu kegagalan | Ya (hash tak dikenal, penolakan CDN) + tombol "Periksa pembaruan" memaksa refresh di luar TTL lalu menjalankan ulang cek kanari |

Rantai fallback sumber config:

1. Aset rilis: `https://github.com/adiprmx/laras/releases/download/config-v1/player-config.json`
2. Tree tag (cadangan): `https://raw.githubusercontent.com/adiprmx/laras/config-v1/player-config.json`
3. Cache terakhir yang valid (di perangkat)
4. Nilai bawaan di kode (`kDefaultClientFallbackOrder`,
   `kBuiltinPlayerHashes`)

Catatan: cadangan (2) ada karena upload aset rilis lewat API butuh
`uploads.github.com` dengan auth, dan kredensial GitHub di lingkungan
ini hanya berlaku untuk `api.github.com` (surrogate ditolak 401 di
uploads.github.com, terbukti 16 Nov 2026). Tag `config-v1` adalah
pre-release, BUKAN tag `v*`, sehingga tidak memicu workflow rilis.

**Perilaku allowlist yang wajib dipahami (temuan koordinator,
17 Nov 2026):** `RemotePlayerConfig.tryParse` membangun playerHashes
HANYA dari JSON remote (tanpa gabung builtin); orkestrator memakai
`config.playerHashes.keys` sebagai allowlist; loader fallback ke
builtin HANYA bila set yang diteruskan kosong. Artinya: config remote
yang basi (hanya fad7e4e9) MENONAKTIFKAN hash builtin baru — update
tag config-v1 adalah SYARAT agar app baru bisa memakai client
scripted (tanpanya app tetap jalan via VR saja). Ini desain yang
disengaja (config remote = control plane termasuk pencabutan hash),
BUKAN bug — tidak diubah. Web WAJIB mempertahankan semantik ini atau
memutuskan eksplisit untuk mengubahnya dengan alasan tertulis.

**Jaring pengaman VR di loader (P0-2):** loader menjamin daftar
client yang dipakai selalu membawa minimal satu client bebas-script
(ANDROID_VR bawaan ditambahkan di ujung urutan, hanya di memori, bila
config — remote atau cache lama — tidak membawanya). Titik choke-nya
adalah `current()` yang dipakai orkestrator + downloads + kanari.
Tanpa jaring ini, config lama pra-VR (dilayani 15 Nov–07:42 WIB
16 Nov) + satu kegagalan script = semua putar mati.

### 7.3 Struktur config (isi nyata, 17 Nov 2026)

File `player-config-2026-11-17.json` (tag `config-v1`, commit
`ee584cc3` saat demo b2p7; 3 hash):

```json
{
  "canaryVideoIds": ["hhn-nGSuenM", "qkC4waEZVt4", "k2XdBPv0D3Y",
                     "NL8WUtq_NDY", "YsGwU8vTRsE"],
  "clients": [
    {"clientId": "67", "name": "WEB_REMIX",
     "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
     "version": "1.20261110.04.00"},
    {"clientId": "2", "name": "MWEB",
     "userAgent": "Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
     "version": "2.20260708.05.00"},
    {"clientId": "14", "name": "ANDROID_VR", "requiresScript": false,
     "userAgent": "com.google.android.youtube/21.26.364 (Linux; U; Android 14; Pixel 8) gzip",
     "version": "1.65.10"}
  ],
  "playerHashes": {
    "ad8d59ae": {"signatureTimestamp": 20768},
    "b559f50c": {"signatureTimestamp": 20770},
    "fad7e4e9": {"signatureTimestamp": 20767}
  },
  "ttlSeconds": 21600,
  "version": 1
}
```

Catatan: `requiresScript` default `true` bila kunci tidak ada.
Context client (mis. `androidSdkVersion: 34` untuk VR di kode bawaan)
tidak ada di config remote — bentuk context config remote terbukti
lolos tanpa `androidSdkVersion` (probe P0f).

### 7.4 Deteksi perubahan config

Deteksi perubahan membandingkan SIDIK JARI ISI (client + hash player
+ videoId kanari), BUKAN `fetchedAt` — refresh selalu menulis
`fetchedAt` baru walau isi sama, sehingga perbandingan `fetchedAt`
membuat hasil "sudah terbaru" tidak pernah tercapai (bug ketahuan
lewat tes P6, diperbaiki sebelum push).

---

## 8. Deteksi kerusakan kanari

Semua lokal, tanpa telemetri ke server mana pun.

### 8.1 Lagu kanari (5 videoId terverifikasi lewat search)

| videoId | Judul | Durasi |
|---|---|---|
| hhn-nGSuenM | Semua Tentang Kita | 268 dtk |
| qkC4waEZVt4 | Rahasia Hati | 251 dtk |
| k2XdBPv0D3Y | Surat Cinta Untuk Starla | 308 dtk |
| NL8WUtq_NDY | Ya Sudahlah | 254 dtk |
| YsGwU8vTRsE | Tak Ingin Usai | 278 dtk |

Judul + durasi dari respons player probe ronde 2 (15 Nov 2026),
bukan hafalan. Kelimanya mengembalikan format audio itag 251 + 140
lewat WEB_REMIX dan MWEB.

### 8.2 Ambang rusak dan perilaku cek

- **Ambang 1:** 3 cek kanari gagal berturut-turut dengan penyebab
  dominan yang sama → status broken.
- **Ambang 2:** >50% resolve kanari gagal dalam 1 jam (dengan
  minimal 5 resolve) → status broken.
- Jadwal cek: sekali sehari di latar saat start dingin dan saat
  kembali dari background, tanpa mengganggu pemutaran. Status
  tersimpan lokal dan dibaca UI.
- Kegagalan JARINGAN diabaikan dan tidak memajukan waktu cek (offline
  bukan kerusakan layanan).
- Riwayat cek: hanya 1 jam terakhir, dibatasi 50 entri.
- Timeout satu cek kanari: 90 detik.
- Banner beranda 3 tingkat: ok = tanpa banner, degraded = tipis,
  broken = jelas + tombol "Periksa pembaruan". Tombol yang sama ada
  di Pengaturan dan kegagalan Jelajah; tombol memaksa refresh config
  di luar TTL 6 jam lalu menjalankan ulang cek kanari.
- Keenam penyebab resolve dipetakan ke pesan bahasa sehari-hari tanpa
  jargon: HTTP 403, respons kosong, parse gagal, hanya format SABR,
  timeout solver, hash player tak dikenal.

### 8.3 Bukti ketahanan (K6/K7)

- K6: client utama dihapus/dimatikan di config tiruan → 10/10 lagu
  tetap jalan tanpa error terlihat.
- K7: TTL dimanipulasi → config baru dipakai setelah refresh latar;
  bukti live K7 dari P1 (loader mengambil config nyata dari tag dan
  memakai nilainya tanpa install ulang).

---

## 9. Pelajaran P0-2 (lagu tidak bisa diputar di HP owner)

Insiden 16 Nov 2026 17:54–19:22 WIB. Fakta: internet owner NYALA,
semua lagu gagal, tombol "Coba lagi" berkali-kali selalu gagal,
config remote benar, base.js tidak berubah (player_es6 non-tcl,
fad7e4e9), izin INTERNET ada, network config waras, tanpa gerbang
konektivitas, tes live VM kanari 5/5 lolos. **Akar tunggal TIDAK
ketemu dari VM** — sesuatu yang HANYA terjadi di perangkat nyata
menggagalkan semua jalur. Pelajaran di bawah ini adalah hasil yang
bisa dipakai ulang; hipotesis yang belum terbukti dilabeli jelas.

### 9.1 Lubang 1 (TERBUKTI, diperbaiki): `break` di tengah loop

`break` pada hash tak dikenal di tengah loop orkestrator →
ANDROID_VR tidak pernah dicoba walau VR tidak butuh script. Fix:
degradasi tengah loop (`degraded = true`, lanjut loop; client
butuh-script dilewati). Catatan jujur tim: pemicunya butuh rotasi
hash di tengah satu resolve; hash stabil sejak 15 Nov — BUKAN
penjelasan paling mungkin insiden 17:54, kecuali HP dapat hash
berbeda dari VM.

**Duplikat lubang (ditemukan P0-2, diperbaiki Blue 2 sebagai R2-L5):**
`download_url_resolver.dart` punya `break` yang sama pada
unknownPlayerHash + tanpa jaring VR — dampak hanya resolve URL
unduhan, bukan pemutaran. Pelajaran umum: SETIAP salinan logika
fallback wajib menerapkan pola degradasi yang sama; logika resolve
yang diduplikasi adalah utang yang menagih dua kali.

### 9.2 Jaring pengaman 2: config tanpa client bebas-script

Config lama pra-VR + satu kegagalan script = semua putar mati. Fix:
`RemoteConfigLoader._withScriptFreeFallback` (§7.2). Web WAJIB punya
jaring yang sama di SATU titik choke yang dipakai semua jalur
(pemutaran, unduhan, kanari).

### 9.3 Hipotesis tersisa (terurut, BELUM terbukti)

1. IP HP kena cek bot YouTube → visitorData gagal → SEMUA client
   LOGIN_REQUIRED. Setiap tautan rantai ini TERBUKTI kecuali
   reputasi IP HP; retry tidak membantu. Kode diagnostik akan
   memutuskan.
2. googlevideo 403 di IP HP (resolve lolos, putar gagal) — pembeda:
   uji unduh K8.
3. VPN/pemblokir iklan MITM CA / DNS privat di HP.
4. Timeout berantai.
5. Hash berbeda di rute HP (sebagian dinetralkan fix degradasi).
6. Solver gagal + VR gagal alasan lain.

Implikasi untuk web: hipotesis 1 dan 2 adalah soal REPUTASI IP
PERANGKAT PENGGUNA — alasan kuat solver + request jalan dari browser
pengguna (IP residensial), bukan dari IP datacenter Worker. Lihat
`keputusan-solver.md` §5.

### 9.4 Diagnosis diri (kode diagnostik)

- `ResolveLogEntry` terstruktur per upaya (cause / isNetworkError /
  isTimeout / skipped); `ResolveFailureSnapshot` + `lastFailure`
  dibersihkan saat resolve sukses.
- Kode diagnostik singkat format `LRS1-JK-DDMMHHMM-KLIEN-APP-CFG-
  LAYANAN` (contoh `LRS1-UPF-16111905-WMV-0901-R20261110-D`) —
  merangkum kegagalan terakhir dari data lokal saja, berfungsi
  offline, bisa disalin ke chat, ikut terkirim di badan email
  laporan. Kode TIDAK berisi judul lagu, videoId, URL, IP, atau data
  pribadi apa pun.
- BATAS yang dicatat P0-2: snapshot hanya kegagalan RESOLVE —
  kegagalan engine (setSources/play, mis. googlevideo 403) TIDAK
  tertangkap; butuh snapshot paralel di lapisan pemutar. Web WAJIB
  menutup celah ini sejak awal (snapshot resolve + snapshot pemutar).

### 9.5 Temuan latensi P0-2

- `_doLoad` tanpa timeout keseluruhan; rantai worst-case bisa
  bermenit-menit sebelum VR dicoba/error tampil. Web WAJIB punya
  timeout keseluruhan resolve.
- `PlayerScriptLoader.load()` selalu fetch HTML dulu walau cache ada
  (pemborosan satu round-trip per resolve dingin). Web: pakai cache
  dulu, fetch HTML hanya bila hash berubah atau cache kosong.
- Timeout fetch config 5 detik < fetch nyata 6,058 detik (satu
  pengukuran) — timeout config 5 detik terbukti terlalu agresif di
  jaringan lambat; pertimbangkan menaikkan atau membedakan timeout
  config dari timeout API lain.

---

## 10. Batas googlevideo dan re-resolve

- **Batas 1 MiB (P1, 16 Nov 2026):** dari VM, googlevideo membatasi
  TEPAT 1 MiB per URL lalu 403 (terbukti di URL segar WEB_REMIX dan
  MWEB; URL segar yang LANGSUNG diminta 1 MiB @offset 1 MiB sebagai
  request pertama juga 403). Batasnya BUKAN anggaran per-URL dan
  BUKAN single-use `n`. Polanya cocok dengan token bucket per-IP (IP
  egress datacenter bersama yang reputasinya buruk) ATAU penegakan
  poToken. yt-dlp menandai format HTTPS web_music dan MWEB sebagai
  `GVS_PO_TOKEN_POLICY required=True` ("may yield HTTP 403" tanpa
  poToken). 1 MiB ≈ 55 detik audio itag 251 dari lagu 268 detik.
- **Memburuk + non-deterministik (adendum koordinator, 16 Nov
  2026):** dari IP egress VM, host tepi googlevideo menolak request
  byte (403 di 0 byte) — LEBIH BURUK dari dinding 1 MiB. Range 0–999
  → 206 + byte EBML asli, lalu request IDENTIK menit berikut → 302;
  Range 10 KiB → 206; Range ≥64 KiB/terbuka/tanpa Range → 302 CMS
  redirect ke host rr lain → diikuti → 403, 0 byte, tanpa
  Set-Cookie. Ambang 206-vs-302 tidak deterministik, jadi unduh
  per-chunk kecil pun BUKAN jalan keluar dari VM.
- **Penyebab (reputasi IP vs poToken) tidak bisa ditentukan dari
  VM** — hanya uji perangkat owner (IP residensial) yang bisa
  memutuskan. Bila batas ini juga berlaku di HP, pemutaran lagu penuh
  butuh re-resolve di tengah pemutaran (pekerjaan P2 APK; web WAJIB
  merancang re-resolve sejak awal, bukan sebagai tambalan).
- Tes live unduh penuh TIDAK BISA lolos dari VM — jangan diulang dari
  VM untuk membuktikan unduh; bukti E2E unduh adalah uji K8 di HP
  owner.

---

## 11. Batas keamanan dan perilaku jaringan

- **Allowlist URL stream** (`url_allowlist.dart`): skema WAJIB HTTPS,
  tanpa userinfo, host `googlevideo.com` atau subdomainnya. Host lain
  (termasuk youtube.com) DITOLAK sebagai URL stream. Thumbnail:
  `*.ytimg.com`, `*.googleusercontent.com`, `*.ggpht.com`. Semua
  jalur yang menerima URL dari respons InnerTube atau solver WAJIB
  lewat allowlist sebelum dipakai (celah R1-M1/R2-M1: jalur langsung
  VR sempat lolos tanpa validasi — diperbaiki Blue 2).
- **Batas ukuran respons** (`response_limits.dart`): JSON youtubei
  10 MB, script player 8 MB, config remote 4 MB, HTML youtube 4 MB.
  Parser dibatasi 100 item. Unduhan dibatasi 1 GB + margin 1 MB
  (rumus `min(...)`, BUKAN `max(total+margin, batas)` — rumus max
  adalah bug: server deklarasi 10 GB lolos).
- **Timeout** (berbasis bukti P0 — request sah dari VM: HTML 41,2
  dtk, base.js 52 dtk, player 16,2/22,2/26,5 dtk): connect 10 dtk,
  player/search 30 dtk, HTML 60 dtk, base.js 90 dtk, config 5 dtk
  (lihat catatan §9.5), solver 10 dtk, kanari 90 dtk, watchdog stall
  unduhan 60 dtk.
- **Retry:** maks 3 kali, backoff 1 dtk lalu 2 dtk + jitter, HANYA
  untuk error jaringan, 5xx, dan 429. Tidak ada retry tanpa batas.
- **Yang TIDAK masuk v1 (mengikat, PRD §4 Won't):** minting poToken/
  BotGuard; client SABR; login YouTube Music; API Spotify dalam
  bentuk apa pun (permanen, preseden cease-and-desist ke Spotube
  2025); akun, sinkronisasi cloud, telemetri, iklan, server.
- **Kunci InnerTube adalah kunci publik** (§2.3) — bukan secret,
  tidak perlu dilindungi sebagai secret, tapi juga tidak boleh
  disalahartikan sebagai kredensial.
- **QuickJS sandbox:** runtime solver terpisah (isolate), eksekusi
  serial, tanpa callback host, tanpa fetch dari dalam JS, hash player
  dicocokkan sebelum eksekusi. Insiden nyata yang mendasari pagar
  ini: 11 Nov 2026, peneliti mendemonstrasikan sandbox escape lewat
  bug use-after-free di QuickJS-NG pada widget bot Telegram; Telegram
  merilis perbaikan darurat keesokan harinya. (Kaitan dengan
  quickjs-ng issue #1910 BELUM terkonfirmasi; insidennya
  terkonfirmasi.)

---

## 12. Catatan porting ke web (yang berubah, yang tetap)

| Aspek APK | Padanan web | Catatan |
|---|---|---|
| Runtime QuickJS native (gg_quickjs) | QuickJS-WASM di Web Worker khusus | Lihat `keputusan-solver.md` — keputusan solver DI BROWSER |
| Isolate Dart pekerja solver | Web Worker (dedicated worker) | Serial, satu runtime, timeout 10 dtk ditegakkan di sisi pemanggil |
| `buildPlayerScript` (Dart) | Port ke TypeScript/JS | Logika ekstraksi (call-site, tabel string, kolektor transitif BFS cap 64, `_extractUrlInfo` per hash) dipindah utuh; JANGAN tulis ulang dari nol tanpa memakai kode APK sebagai referensi baris-per-baris |
| Dio + timeout | `fetch` + `AbortController` | SEMUA fetch WAJIB timeout (aturan proyek, berlaku umum) |
| SharedPreferences (cache config, status kanari) | localStorage (nilai kecil) / IndexedDB (cache base.js, antrean) | Batas anti-OOM tetap berlaku: koleksi di IndexedDB, bukan localStorage |
| Drift/SQLite | IndexedDB | Skema 15 tabel APK adalah referensi desain |
| just_audio/ExoPlayer | `<audio>` + Media Session API | URL googlevideo diputar lewat elemen media — TIDAK butuh CORS (elemen media dikecualikan dari CORS) |
| Config remote (GitHub) | Sama, fetch langsung dari browser | `raw.githubusercontent.com` mengirim `Access-Control-Allow-Origin: *` (diukur 17 Nov 2026) — fetch langsung dari browser BISA |
| Request youtubei + base.js dari browser | BUTUH proxy CORS (lihat bawah) | Preflight OPTIONS ke youtubei dibalas 403 tanpa header CORS; base.js 200 tanpa header CORS (diukur 17 Nov 2026 via curl) — vonis final tetap butuh spike browser, tapi indikasi kuat direct fetch diblokir. Proxy HANYA memindah byte; solver tetap di browser (`keputusan-solver.md` §6) |
| Mode terdegradasi + VR | Sama persis | Jaring pengaman tidak bergantung platform |
| Kode diagnostik LRS1 | Sama (format boleh dipakai ulang) | Tambah snapshot pemutar (§9.4) |

---

## 13. Daftar file/kode APK yang jadi referensi

Semua di `~/workspace/music-app/laras/` (repo `adiprmx/laras`,
HEAD RC v1.0.0 `01c59b58` kecuali dinyatakan lain):

| File | Isi yang dirujuk |
|---|---|
| `lib/extractor/client_definitions.dart` | Definisi 3 client, versi, UA, context, `kInnertubeApiKey`, `kInnertubeHost`, 5 lagu kanari |
| `lib/extractor/fallback_orchestrator.dart` | `StreamResolver`: alur resolve, mode terdegradasi (awal + tengah loop), rotasi client, single-flight, snapshot kegagalan |
| `lib/extractor/innertube_client.dart` | POST youtubei, visitorData (search, cache 6 jam, refresh+retry), timeout, retry 429/503, cap respons |
| `lib/extractor/cipher/player_script.dart` | `buildPlayerScript`, `extractStringTable` (2 bentuk), kolektor transitif BFS (cap 64), `_extractUrlInfo` per hash, `kJsBuiltinGlobals`, cap prelude 1 MB, kedalaman template 32 |
| `lib/extractor/cipher/player_script_loader.dart` | Load HTML→jsUrl→base.js, cache memori per hash, gerbang hash sebelum unduh, fallback varian non-tcl, single-flight |
| `lib/extractor/cipher/signature_solver.dart` | `QuickJsSignatureSolver`, `QuickJsLimits` (192 MiB / 256 KiB / 10 dtk), driver URL-class, antrean serial |
| `lib/extractor/cipher/js_stubs.dart` | Stub DOM minimal untuk evaluasi base.js |
| `lib/extractor/remote_config.dart` | `RemotePlayerConfig`, `RemoteConfigLoader` (TTL 6 jam, timeout 5 dtk, cap 4 MB, rate limit 5 mnt, stale-while-revalidate, jaring VR), `kBuiltinPlayerHashes` |
| `lib/extractor/player_parser.dart` | Parse respons player, deteksi SABR per format |
| `lib/extractor/itag_picker.dart` | Urutan 251/140/250/249/139 + hemat data, penolakan SABR, fallback bitrate tertinggi |
| `lib/extractor/url_allowlist.dart` | `isAllowedStreamUrl` (`*.googlevideo.com`), `isAllowedThumbnailUrl` |
| `lib/extractor/response_limits.dart` | Cap ukuran respons (10/8/4/4 MB) |
| `lib/extractor/models.dart` | `AudioFormat` (`isSabr`, `hasDirectUrl`, `needsSolver`), `ResolveFailureSnapshot`, `ResolveLogEntry` |
| `lib/extractor/canary.dart` | `CanaryChecker`, ambang 3× / >50% dalam 1 jam, riwayat 50 entri |
| `lib/extractor/errors.dart` | `ExtractorException`, `ResolveFailureCause` (6 penyebab) |
| `lib/downloads/download_url_resolver.dart` | Resolver cermin untuk unduhan (wajib pola degradasi yang sama — pelajaran §9.1) |
| `lib/resilience/diagnostic_code.dart` | Format kode diagnostik `LRS1-…` |
| `docs/spike-ekstraksi.md` | Bukti P1 lengkap + Adendum P0 + adendum koordinator (dinding googlevideo) |
| `test/fixtures/player-android-sabr-only.json` | Fixture respons SABR-only asli (6 format tanpa url/cipher) |
| `hidden_files/tim-p1-spike/` | Skrip probe + bukti mentah (probe-player.js, base-fad7e4e9.js, measure-resolve.json, diag-sts-vd.js) |
| `hidden_files/koordinator-fase-2/base_ad8d59ae.js`, `base_b559f50c.js` | Salinan persisten base.js hash baru (2.679.612 / 2.684.806 byte, sha256 terverifikasi) |
| `hidden_files/koordinator-fase-2/player-config-2026-11-17.json` | Config remote 3 hash (isi §7.3) |

Dokumen proyek: `~/workspace/music-app/docs/arsitektur.md` §3
(ekstraksi), §3.5 (config + kanari), §6 (keamanan);
`~/workspace/music-app/docs/prd-v1.md` §5.1–5.3, §7 (K1–K15),
§9 (R1–R11).

---

## 14. Yang masih belum terbukti (utang bukti warisan APK)

1. Apakah batas 1 MiB googlevideo juga berlaku di IP residensial HP
   (hanya uji perangkat owner yang bisa memutuskan).
2. Waktu resolve di jaringan HP langsung (median VM 4.049 ms adalah
   egress-bound; K1 TERTUNDA).
3. Apakah F-Droid menerima config remote yang mengubah perilaku
   ekstraksi (tidak relevan langsung untuk web, tapi relevan bila web
   memakai pola config yang sama dan suatu hari dibungkus APK).
4. VisitorData cadangan dari HTML youtube.com (rekomendasi P0-2,
   belum diimplementasikan, butuh bukti kode dulu).
5. Berapa lama varian non-tcl lama tetap dilayani YouTube (fallback
   varian rapuh; VR adalah jaring pengaman).
6. Akar tunggal P0-2 (hipotesis teratas: cek bot IP HP → semua
   client LOGIN_REQUIRED) — menunggu kode diagnostik + uji unduh K8
   dari perangkat owner.
