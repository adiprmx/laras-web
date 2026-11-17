# Keputusan Solver: Di Browser, Bukan di Worker

**Proyek:** Laras Web App Full-Stack (Fase 1, Tim Transfer Ekstraktor)
**Tanggal:** 17 November 2026
**Pertanyaan:** solver signature YouTube (`sig` + `n`) jalan di WORKER
(server-side, mis. Cloudflare Worker) atau di BROWSER (JS/WASM)?
**Status:** DIPUTUSKAN (dengan bukti; spike konfirmasi di §8 tetap wajib
sebelum implementasi penuh).

---

## 1. Keputusan

> **KEPUTUSAN: solver jalan DI BROWSER — QuickJS-WASM di dalam Web
> Worker khusus (dedicated worker), dengan ekstraksi dan driver yang
> diport dari kode APK (`player_script.dart` + `signature_solver.dart`).
> Cloudflare Worker dipakai HANYA sebagai proxy CORS/config (memindah
> byte, tanpa mengeksekusi base.js) — dan hanya bila spike browser
> membuktikan fetch langsung ke youtubei/base.js diblokir CORS.**

Keputusan ini bukan preferensi gaya. Dua temuan memblokir opsi Worker
secara definitif (§3.1–3.2), dan tiga temuan lagi membuat opsi browser
lebih kuat di biaya, skalabilitas, dan reputasi IP (§3.3–3.5).
Satu-satunya keunggulan nyata Worker — menyelesaikan CORS — dapat
diambil TANPA memindah solver ke Worker (§6).

### Arsitektur hasil keputusan

```
Browser pengguna (IP residensial)
┌─────────────────────────────────────────────────────────────┐
│ Halaman web (UI + orkestrator resolve, port Dart → TS)      │
│   │  1. config remote (fetch langsung, ACAO: *)             │
│   │  2. request player ──► [Worker proxy HANYA bila CORS    │
│   │     memblokir direct fetch; proxy tidak mengeksekusi    │
│   │     apa pun, hanya meneruskan byte]                     │
│   │  3. base.js (teks) ──► [jalur yang sama: direct bila    │
│   │     bisa, proxy bila CORS memblokir]                    │
│   ▼                                                         │
│ Web Worker khusus: QuickJS-WASM + stub DOM + prelude        │
│   → solve sig + transform n (median APK: 10,5 ms)           │
│   → URL final → <audio> (tanpa CORS) / unduhan              │
└─────────────────────────────────────────────────────────────┘
Fallback bila solver gagal: ANDROID_VR (URL langsung, tanpa solver)
— mode terdegradasi yang sama dengan APK.
```

---

## 2. Fakta dasar: tidak ada secret yang perlu dilindungi server

Argumen klasik "komputasi sensitif harus di server" TIDAK berlaku di
sini:

- Solver hanya mengeksekusi `base.js` — script player PUBLIK YouTube
  yang diunduh dari `www.youtube.com` dan bisa dibaca siapa pun.
  Tidak ada secret, kunci, atau kredensial di dalam solver.
- Satu-satunya "kunci" di seluruh jalur ekstraksi adalah kunci API
  InnerTube `AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8` — kunci PUBLIK
  yang tertanam di halaman youtube.com dan dipakai yt-dlp/pytubefix
  (keputusan K-F2-10 APK; ditegaskan ulang Red 2/Red 3). Kunci ini
  sudah ada di repo publik `adiprmx/laras`.
- Tidak ada login, cookie, atau token pengguna di v1 (PRD Won't).
  Tidak ada yang bocor bila solver jalan di perangkat pengguna —
  justru APK sudah membuktikan pola ini: solver jalan di HP pengguna
  sejak P1.

Konsekuensi: penempatan solver adalah murni soal KELAYAKAN PLATFORM,
BIAYA, dan REPUTASI IP — bukan keamanan secret.

---

## 3. Bukti dari pengalaman APK (angka)

Semua angka dari `laras/docs/spike-ekstraksi.md`,
`music-app/docs/arsitektur.md` §3, log koordinator Fase 2, dan kode
`lib/extractor/` (rincian di `transfer-ekstraktor.md`).

| Fakta | Nilai | Sumber/tanggal |
|---|---|---|
| Ukuran base.js | 2.677.001–2.876.993 byte (fad7e4e9 non-tcl 2.677.001; tcl 2.876.993; ad8d59ae 2.679.612; b559f50c 2.684.806) | Probe P1/P0, 15–17 Nov 2026 |
| Median solve (satu lagu) | 10,5 ms | 10 resolve nyata, Node di VM, 16 Nov 2026 |
| Median request player (HTTP) | 4.028,5 ms | Sama (bottleneck egress VM, bukan solver) |
| Median total resolve | 4.049 ms | Sama; min 2.440 ms, max 20.482 ms |
| Limit memori runtime solver | 192 MiB | SimpMusic (terbukti produksi); membangun AST base.js butuh >128 MiB |
| Limit stack runtime solver | 256 KiB (gg_quickjs saat ini) | 8 MiB adalah era quickjs_engine/SimpMusic; TIDAK aman di gg_quickjs (README: >512 KiB bisa crash proses native) |
| Timeout satu eksekusi solver | 10 detik | Ditegakkan native (interrupt handler) + backstop bunuh-isolate |
| Eksekusi solver | Serial, satu runtime | Dua runtime paralel × 192 MB bisa OOM |
| Kontribusi QuickJS di APK rilis | 1.240.840 byte | CI pasca-P1 |
| Hash player hidup bersamaan | 3 (fad7e4e9, ad8d59ae, b559f50c) | 17 Nov 2026 — multi-hash bersamaan |
| Kelas URL per hash | tf/gf, bs/ff, JH/gf | Wajib dibaca dari base.js per hash; hardcode = bug nyata (Tim Fix Solver) |

Dua implikasi langsung dari tabel ini:

1. **Solver itu murah** (10,5 ms) — penempatannya tidak menentukan
   latensi resolve; jaringan (4.028,5 ms) yang menentukan. Memindah
   solver ke Worker justru MENAMBAH satu round-trip jaringan per
   resolve tanpa mengurangi apa pun yang signifikan.
2. **Solver itu rakus memori saat init** (AST base.js >128 MiB) —
   platform penempatan harus memberi headroom memori di atas angka
   itu, bukan di bawahnya.

---

## 4. Analisis opsi A: solver di Worker (Cloudflare Worker)

### 4.1 Pemblokir definitif 1 — Worker MELARANG eksekusi kode dari string

Cloudflare Workers (workerd) memasang callback code-generation V8
yang melarang kompilasi string menjadi kode selama request ditangani:
`eval()`, `new Function()`, dan `Function()` melempar
`EvalError: Code generation from strings disallowed for this context`.
Ini kebijakan keamanan platform, bukan bug, dan tidak bisa diubah
dengan konfigurasi. Dikonfirmasi dari dokumentasi Cloudflare
("For security reasons, the following are not allowed" — Web
standards) dan berbagai laporan produksi (Okt–Nov 2026), termasuk
kasus `protobufjs`/`firebase-admin` dan Ajv yang gagal dengan error
yang sama persis di Workers.

Dampak untuk solver: **cara kerja solver APK — mengevaluasi base.js
(~2,7 MB string) di runtime JS — secara harfiah adalah operasi yang
dilarang platform ini.** Deploy akan sukses, lalu request pertama yang
mencapai jalur solver mengembalikan 500.

Jalan keluar yang tersisa di dalam Worker hanyalah menjalankan
interpreter JS DI DALAM JS (mis. QuickJS yang dikompilasi ke WASM,
lalu base.js dievaluasi oleh interpreter itu, bukan oleh V8 Worker).
Tapi:

- `WebAssembly.compile()` di request handler JUGA diblokir oleh
  kebijakan yang sama (`CompileError: WebAssembly.compile(): Wasm
  code generation disallowed by embedder`). Modul WASM yang
  diimpor sebagai modul ES (dikompilasi saat deploy/startup isolate)
  mungkin lolos — TAPI ini belum terbukti untuk kasus ini dan butuh
  spike tersendiri, dengan risiko platform yang tidak bisa
  dinegosiasikan.
- Bahkan bila WASM lolos, arsitektur menjadi: V8 Worker → WASM
  QuickJS → base.js. Dua lapis interpreter untuk pekerjaan yang di
  browser hanya butuh satu lapis (WASM QuickJS langsung).

**Vonis §4.1: opsi Worker membutuhkan jalan memutar yang belum
terbukti di atas platform yang secara eksplisit melarang operasi
intinya. Opsi browser tidak punya larangan ini.**

### 4.2 Pemblokir definitif 2 — CPU free-tier 10 ms LEBIH KECIL dari waktu solve

Batas Workers Free (dokumentasi Cloudflare Workers, Limits, terakhir
diperbarui 29 Okt 2026 — diverifikasi dari 3 sumber independen,
17 Nov 2026):

| Batas | Workers Free | Workers Paid |
|---|---|---|
| Request | 100.000/hari (reset 00:00 UTC; lewat → Error 1027) | Tanpa batas harian; 10 juta/bulan termasuk |
| CPU per request HTTP | **10 ms** | 30 detik default, maks 5 menit |
| Memori per isolate | 128 MB | 128 MB (tetap di semua paket) |
| Subrequest | 50 | 10.000 |
| Biaya | Rp0 | US$5/bulan minimum |

Waktu menunggu jaringan (fetch, KV, DB) TIDAK dihitung sebagai CPU —
hanya eksekusi kode yang dihitung.

Perbandingan dengan angka APK:

- Median solve SAJA sudah **10,5 ms** (Node di VM) — sudah di atas
  batas 10 ms, SEBELUM menghitung parse base.js 2,7 MB, ekstraksi
  (regex + pencocokan kurung + BFS transitif), dan serialisasi.
  Parse + init base.js adalah pekerjaan CPU terbesar (membangun AST
  >128 MiB), dan itu terjadi di SETIAP cold start isolate Worker
  (isolate tidak dijamin hangat antar request).
- Melewati batas CPU = Error 1102 (Worker Exceeded CPU Resource
  Limits), request gagal.

Satu-satunya jalan keluar adalah Workers Paid (US$5/bulan) — yang
**melanggar aturan Rp0 owner** (perintah permanen: budget nol rupiah;
solusi baru wajib jalan di free-tier sejati). Opsi berbayar bukan
keputusan tim ini; bila suatu hari dipertimbangkan, itu keputusan
owner dengan alasan tertulis.

**Vonis §4.2: solver di Worker free-tier tidak layak secara aritmetik
(10,5 ms > 10 ms, sebelum parse). Solver di Worker paid layak secara
teknis tapi melanggar batas Rp0.**

### 4.3 Memori: 128 MB Worker < 192 MiB terbukti

Limit memori Worker 128 MB per isolate (tetap di semua paket,
termasuk Paid) berada DI BAWAH limit 192 MiB yang terbukti di APK,
dan berada tepat di ambang kebutuhan membangun AST base.js (>128
MiB, per SimpMusic). Tidak ada headroom. Di browser, tab umumnya
punya ratusan MB–GB; QuickJS-WASM dapat dikonfigurasi dengan batas
yang sama dengan APK (192 MiB) tanpa menabrak batas platform.

### 4.4 Latensi: Worker menambah round-trip tanpa mengurangi apa pun

Solver 10,5 ms vs request player 4.028,5 ms — solver BUKAN bottleneck.
Memindah solver ke Worker menambah: (a) satu round-trip
browser→Worker per resolve, (b) cold start isolate Worker, (c) Worker
tetap harus fetch base.js (2,7 MB) dan request player sendiri.
Tidak ada penghematan latensi; yang ada hanya penambahan titik
gagal dan hop jaringan.

### 4.5 CORS: satu-satunya keunggulan nyata Worker

Dari browser, fetch langsung ke youtubei dan base.js kemungkinan
besar diblokir CORS (pengukuran curl 17 Nov 2026: preflight OPTIONS
ke youtubei dibalas 403 tanpa header CORS; base.js 200 tanpa header
`Access-Control-Allow-Origin`). Worker tidak kena CORS sama sekali
(fetch server-side bebas). Ini keunggulan NYATA — tapi keunggulan ini
dapat diambil tanpa memindah solver: Worker sebagai proxy byte-only
(§6). Proxy hanya meneruskan request/response; pekerjaan CPU-nya
hampir nol (rata-rata Worker ~2,2 ms CPU per request menurut
dokumentasi Cloudflare) sehingga muat nyaman di batas 10 ms free-tier.

### 4.6 Perawatan saat YouTube rotasi hash

- **Worker:** perbaikan pola ekstraksi = deploy Worker baru (cepat,
  tapi satu titik deploy yang bila gagal mematikan SEMUA pengguna
  sekaligus). Config remote (hash allowlist, versi client, sts)
  tetap bisa dipakai dari Worker.
- **Browser:** perbaikan pola ekstraksi = deploy bundle web baru
  (sama cepatnya; tanpa review toko aplikasi, tanpa install ulang
  APK — justru LEBIH cepat dari siklus APK). Config remote bekerja
  identik dari browser (fetch langsung; `raw.githubusercontent.com`
  mengirim `Access-Control-Allow-Origin: *`, diukur 17 Nov 2026).
- **Seri:** tidak ada keunggulan perawatan yang menentukan bagi
  Worker. Keduanya bergantung pada config remote untuk hash/versi
  dan deploy kode untuk pola ekstraksi.

### 4.7 Skalabilitas dan biaya

- **Worker Free:** kuota 100.000 request/hari dibagi SELURUH
  pengguna. Satu resolve = minimal 1 request solver (+ fetch player
  + fetch base.js bila lewat Worker juga). 10.000 pengguna × 10 lagu
  = kuota habis; request berikutnya gagal (Error 1027) sampai reset
  tengah malam UTC. Ini plafon keras yang mematikan pertumbuhan.
- **Browser:** tiap pengguna memakai CPU-nya sendiri. Biaya marginal
  per pengguna = Rp0. Tidak ada kuota bersama. Skala tidak terbatas
  oleh platform.

### 4.8 Risiko blokir IP: datacenter vs residensial (bukti APK)

Bukti APK menunjukkan IP datacenter diperlakukan lebih buruk oleh
YouTube/googlevideo:

- Dari VM (IP egress datacenter): googlevideo membatasi TEPAT 1 MiB
  per URL lalu 403 (P1); kemudian memburuk menjadi 403 di 0 byte
  dengan perilaku non-deterministik 302/403 (adendum koordinator,
  16 Nov 2026).
- Saat reputasi IP rendah, request player tanpa visitorData dibalas
  LOGIN_REQUIRED untuk SEMUA client (probe 15 Nov 2026).
- Hipotesis teratas P0-2 (belum terbukti, tapi rantai buktinya
  lengkap kecuali satu tautan): IP HP kena cek bot → visitorData
  gagal → semua client LOGIN_REQUIRED.

IP egress Cloudflare Worker adalah IP datacenter — kelas reputasi
yang SAMA dengan IP VM yang terbukti dibatasi. Memindah SEMUA request
pengguna ke IP Worker berarti memusatkan seluruh beban ke sedikit IP
datacenter yang reputasinya tidak terkontrol, dengan risiko
LOGIN_REQUIRED/403 massal. Solver + request dari browser memakai IP
residensial tiap pengguna — jalur yang sama dengan APK di HP, jalur
yang terbukti bekerja.

---

## 5. Analisis opsi B: solver di browser

### 5.1 Bentuk yang dipilih: QuickJS-WASM di Web Worker khusus

- **QuickJS-WASM** (QuickJS yang dikompilasi ke WebAssembly,
  mis. paket `quickjs-emscripten` — NAMA PAKET INI WAJIB
  diverifikasi saat spike; nama di sini adalah kandidat yang dikenal,
  bukan keputusan final): menjalankan base.js di dalam interpreter
  yang ter-sandbox, TANPA `eval`/`new Function` di halaman. Ini
  adalah padanan web paling setia dari arsitektur APK (QuickJS di
  isolate Dart) — batas yang sama (memori 192 MiB, timeout 10 dtk,
  serial, tanpa callback host, tanpa fetch dari dalam JS) dapat
  diterapkan satu-per-satu.
- **Web Worker khusus (dedicated worker):** solver jalan di luar UI
  thread (aturan APK yang sama: pekerjaan berat tidak boleh di UI
  thread). Worker tidak punya akses DOM; komunikasi dengan halaman
  hanya lewat `postMessage` (string masuk: base.js + cipher;
  string keluar: URL final). Base.js yang tidak tepercaya tidak
  pernah dievaluasi di konteks halaman utama.
- **Tanpa `unsafe-eval` di CSP halaman:** karena evaluasi terjadi di
  dalam WASM, Content-Security-Policy halaman tidak perlu
  mengizinkan `eval`. Ini penting: `unsafe-eval` melemahkan CSP
  seluruh halaman.
- **Ukuran:** kontribusi QuickJS di APK adalah 1.240.840 byte;
  bundle QuickJS-WASM di web diperkirakan seorde itu (angka pasti
  WAJIB diukur di spike — bukan ditebak). Bundle di-cache browser
  (Cache API / HTTP cache) sehingga hanya diunduh sekali.

### 5.2 Alternatif di dalam browser (cadangan, §7)

- **Eval langsung di Web Worker** (`new Function` di worker +
  CSP `unsafe-eval` untuk worker itu): lebih sederhana, tanpa WASM,
  V8 mengeksekusi base.js secara native (lebih cepat dari QuickJS).
  Kelemahan: butuh `unsafe-eval` (melemahkan CSP) dan base.js berjalan
  di V8 dengan akses API worker (fetch, dll.) — permukaan lebih luas
  dari QuickJS-WASM. Cadangan lapis kedua.
- **Eval di iframe sandbox** (`sandbox="allow-scripts"`, origin
  terpisah): isolasi origin penuh. Kelemahan: plumbing postMessage
  lebih rumit, dan iframe sandbox tetap butuh `unsafe-eval` bila CSP
  halaman melarang eval. Cadangan lapis ketiga.

### 5.3 CORS dari browser — masalah nyata, solusi tanpa memindah solver

Pengukuran curl 17 Nov 2026 (indikasi kuat, vonis final di spike
browser):

| Target | Hasil | Implikasi |
|---|---|---|
| Config remote (`raw.githubusercontent.com`) | 200 + `Access-Control-Allow-Origin: *` | Fetch langsung dari browser BISA |
| youtubei (`www.youtube.com/youtubei/v1/player`, OPTIONS preflight) | 403, tanpa header CORS | Direct fetch kemungkinan besar DIBLOKIR |
| base.js (`www.youtube.com/s/player/…/base.js`) | 200, tanpa header CORS | Direct fetch kemungkinan besar DIBLOKIR |
| Pemutaran audio googlevideo via `<audio>` | — (perilaku standar web) | Elemen media TIDAK kena CORS; putar langsung BISA |

Solusi (§6): Worker proxy byte-only untuk youtubei + base.js.
Solver tetap di browser; yang lewat Worker hanyalah byte request/
response dan teks base.js.

### 5.4 Kekuatan opsi browser

- **Biaya Rp0** — tanpa server, tanpa kuota bersama, tanpa paket
  berbayar. Selaras aturan owner dan PRD (tanpa server).
- **Skalabilitas tak terbatas** — komputasi terdistribusi ke perangkat
  pengguna.
- **IP residensial** — jalur yang terbukti bekerja di APK (§4.8).
- **Latensi terbaik** — tanpa hop tambahan; solve 10,5 ms di
  perangkat, nol round-trip ekstra.
- **Offline-first** — setelah base.js + QuickJS-WASM ter-cache,
  solver dapat jalan tanpa jaringan tambahan untuk hash yang sudah
  dikenal (resolve tetap butuh jaringan untuk request player).
- **Tidak ada larangan platform** — browser mengizinkan WASM dan
  Web Worker; tidak ada batas CPU 10 ms.

### 5.5 Kelemahan opsi browser (jujur)

- **CORS butuh proxy** bila direct fetch terbukti diblokir — satu
  komponen server-side (kecil, I/O-only) tetap dibutuhkan. Ini
  diterima sebagai bagian dari keputusan (§6).
- **Perangkat lemah:** HP low-end akan solve lebih lambat dari
  10,5 ms (angka itu dari VM). Mitigasi: timeout 10 dtk yang sama
  dengan APK + fallback VR (tanpa solver) bila solver timeout.
  Dampak terukur: solve 10× lebih lambat pun (105 ms) masih tidak
  berarti dibanding request player ~4 detik.
- **Bundle awal lebih besar** (~1,2 MB orde QuickJS-WASM, belum
  diukur pasti) — mitigasi: lazy-load modul solver hanya saat lagu
  pertama di-resolve; cache permanen sesudahnya.
- **Variasi browser:** WASM dan Web Worker didukung semua browser
  modern (Chrome/Firefox/Safari/Edge); browser sangat tua tidak
  didukung — dapat diterima untuk v1 web (target browser modern).

---

## 6. Perbandingan berdampingan

| Dimensi | Solver di Worker | Solver di browser (DIPILIH) |
|---|---|---|
| Kelayakan platform | ❌ `eval`/`new Function` DILARANG saat request; `Wasm.compile` juga diblokir | ✅ WASM + Web Worker didukung penuh |
| CPU free-tier | ❌ 10 ms < solve 10,5 ms (sebelum parse base.js) | ✅ Tanpa batas CPU platform |
| Memori | ❌ 128 MB < 192 MiB terbukti | ✅ Ratusan MB–GB; batas APK dapat dipakai |
| Secret | Seri (tidak ada secret di solver) | Seri |
| Latensi | ❌ +1 round-trip + cold start per resolve | ✅ 0 round-trip ekstra |
| CORS | ✅ Bebas CORS (server-side) | ⚠️ Butuh proxy byte-only bila direct fetch diblokir |
| Biaya | ❌ Free tidak layak; Paid US$5/bln melanggar Rp0 | ✅ Rp0 |
| Skalabilitas | ❌ 100.000 req/hari untuk SEMUA pengguna | ✅ Tak terbatas (CPU pengguna) |
| Reputasi IP | ❌ IP datacenter (kelas yang terbukti dibatasi) | ✅ IP residensial pengguna |
| Perawatan rotasi hash | Seri (deploy cepat; config remote sama) | Seri (deploy web justru tanpa install ulang) |
| Keamanan eksekusi base.js | Interpreter-dalam-interpreter (belum terbukti) | QuickJS-WASM ter-sandbox di worker (padanan APK) |
| Offline | ❌ Selalu butuh Worker | ✅ Solver ter-cache dapat jalan offline untuk hash dikenal |

---

## 7. Fallback bila opsi utama gagal (berlapis)

Keputusan ini tidak bergantung pada satu asumsi saja. Bila satu lapis
gagal, lapis berikut mengambil alih — tanpa mengubah keputusan utama
(solver tetap di browser kecuali lapis terakhir):

1. **QuickJS-WASM gagal / terlalu berat di perangkat target** →
   eval langsung di Web Worker khusus (V8 native, lebih cepat;
   butuh `unsafe-eval` di CSP worker). Solver tetap di browser.
2. **Eval di worker juga tidak memungkinkan** (mis. CSP organisasi
   yang ketat) → iframe sandbox origin-terpisah. Solver tetap di
   browser.
3. **Solver browser gagal total untuk satu hash** (pola ekstraksi
   belum diperbaiki) → **mode terdegradasi APK: ANDROID_VR** (URL
   langsung, tanpa solver sama sekali). Ini jaring pengaman yang
   sudah terbukti di APK, bukan teori.
4. **CORS memblokir direct fetch** (kemungkinan besar, §5.3) →
   Worker proxy byte-only untuk youtubei + base.js. Solver tetap di
   browser; Worker hanya memindah byte (I/O-bound, muat di free-tier
   10 ms CPU).
5. **Worker proxy ikut diblokir / kuota habis** → degraded penuh:
   putar lagu yang sudah tersimpan/offline + pesan jujur + tombol
   "Periksa pembaruan" (pola P6 APK). Bukan kegagalan diam.
6. **Terakhir (butuh keputusan owner):** Workers Paid US$5/bulan
   sebagai proxy dengan kuota lebih besar — BUKAN sebagai tempat
   solver (larangan eval tetap berlaku di Paid). Melanggar Rp0,
   jadi tidak diputuskan di sini.

Yang TIDAK menjadi fallback: memindah solver ke Worker free-tier
(diblokir §4.1–4.2) dan minting poToken/BotGuard (di luar cakupan
v1, PRD Won't).

---

## 8. Spike yang wajib jalan sebelum implementasi penuh

Keputusan ini diambil dengan bukti yang ada; empat spike berikut
wajib lolos (atau gagal dengan bukti yang mengubah keputusan) sebelum
tim membangun di atasnya:

| # | Spike | Kriteria lolos |
|---|---|---|
| S1 | QuickJS-WASM di Web Worker: muat base.js asli ketiga hash (fad7e4e9, ad8d59ae, b559f50c — salinan di `hidden_files/koordinator-fase-2/`), jalankan driver solver port dari APK | Solve lolos untuk ketiga hash; ukur median solve + ukuran bundle WASM + pemakaian memori puncak |
| S2 | Direct fetch dari origin browser ke youtubei (POST player) dan base.js (GET) | Vonis CORS final: bila diblokir → bangun Worker proxy byte-only; bila lolos → tanpa proxy sama sekali |
| S3 | Pemutaran `<audio>` dari URL googlevideo hasil resolve + Media Session | Lagu berbunyi sampai habis di browser desktop + HP; ukur waktu sampai bunyi pertama |
| S4 | Port `buildPlayerScript` + kolektor transitif + `_extractUrlInfo` ke TypeScript, diuji terhadap ketiga base.js asli + fixture tes APK | Semua tes unit port lolos (termasuk kasus Vm, helper builtin String, delimiter tabel `;` vs `{`, kelas URL tf/bs/JH) |

Bila S1 gagal total (QuickJS-WASM tidak dapat menjalankan base.js di
browser), fallback lapis 1 (§7.1) di-spike sebelum keputusan ini
dibuka ulang. Bila S2 membuktikan direct fetch LOLOS, arsitektur
menjadi lebih sederhana (tanpa Worker sama sekali) — keputusan solver
tidak berubah.

---

## 9. Batas dokumen ini

- Keputusan ini hanya menjawab PENEMPATAN SOLVER. Penempatan
  komponen lain (pencarian, browse, lirik, unduhan/offline via
  Service Worker + Cache API/IndexedDB, pemutar) diputuskan tim
  masing-masing dengan bukti sendiri.
- Angka batas Cloudflare Workers dikutip dari dokumentasi resmi
  (Limits, diperbarui 29 Okt 2026) dan diverifikasi silang 3 sumber
  independen pada 17 Nov 2026. Batas platform dapat berubah — tim
  implementasi WAJIB mengecek ulang halaman Limits saat membangun
  proxy (§6), dan mencatat tanggal ceknya.
- Pengukuran CORS (§5.3) dilakukan via curl dari VM, bukan dari
  browser nyata — indikasi kuat, bukan vonis final (lihat S2).
- Nama paket QuickJS-WASM (`quickjs-emscripten`) adalah kandidat
  yang dikenal, BUKAN keputusan final — spike S1 yang memutuskan
  paket dan versi pastinya setelah verifikasi.
