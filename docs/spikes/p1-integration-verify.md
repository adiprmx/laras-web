# P1 Penutup: Halaman Spike Integrasi Pemutar Lagu (rute `/spike`)

**Proyek:** Laras Web App Full-Stack, Paket P1, Tim Integrasi (A6, A13, A7)
**Tanggal:** 18 November 2026 (00:10-00:35 WIB; 17:10-17:35 UTC 17 Nov 2026)
**Dokumen acuan:** `docs/spikes/s1-s4-solver.md`, `docs/spikes/s2-s6-s7-network.md`,
`docs/spikes/s3-s5-s9-playback.md` (§S3.4 vonis + §utang), `docs/arsitektur.md` §3.3 + §4.1
**Status:** SELESAI DIBANGUN DAN DIVERIFIKASI DARI VM SEBATAS YANG MUNGKIN.
**Bukti pemutaran penuh HANYA bisa dibuat dari browser nyata di luar VM**
(googlevideo memblokir IP VM: 403 pada semua range non-nol, terbukti S3).
Langkah verifikasi persis untuk parent ada di §5.

---

## 1. Yang dibangun

Satu halaman spike di rute `/spike` (TERSEMBUNYI, tidak ditautkan dari
beranda mana pun): bukti integrasi ujung ke ujung bahwa lima lagu
kanari bisa di-resolve lewat proxy lalu diputar dari URL googlevideo
langsung sampai habis. UI pemutar sesungguhnya adalah P2; halaman ini
hanya alat verifikasi.

Alur per lagu: muat config-v1 (fetch langsung, CORS terbuka) lalu
resolve via proxy (POST player + base.js lewat proxy, solver
QuickJS-WASM di browser untuk format cipher) lalu set `<audio>` src
ke URL googlevideo LANGSUNG (bukan lewat proxy, sesuai arsitektur
produksi; proxy audio untuk streaming dilarang) lalu putar, tampilkan
status live, dan lanjut otomatis ke lagu berikut.

| Berkas | Isi |
|---|---|
| `app/src/spike/config.ts` | Konstanta: URL proxy (SATU tempat), config-v1, lagu kanari, urutan itag 251/140/250/249/139, client + hash bawaan, timeout |
| `app/src/spike/resolve.ts` | Resolve browser via proxy: config, visitorData (best-effort), POST player per client (sts WAJIB untuk client scripted), pilih itag, tolak SABR, allowlist host, solver lazy-load untuk cipher |
| `app/src/spike/report.ts` | Logika murni: status lagu, format waktu, ringkasan X/5, laporan teks polos |
| `app/src/spike/SpikePage.tsx` | Halaman uji: dua mode, status live per lagu, pemutar audio, coba ulang resolve 1x di tengah lagu bila macet, ringkasan + tombol Salin hasil |
| `app/src/spike/report.test.ts` | 8 tes Vitest logika laporan |
| `app/src/spike/resolve.test.ts` | 15 tes Vitest logika resolve murni |
| `app/src/App.tsx` | Rute `/spike` lazy-load (React.lazy); beranda tidak berubah |
| `app/public/_redirects` | SPA fallback Cloudflare Pages (`/* /index.html 200`), tanpa ini `/spike` 404 di preview |
| `app/tests/e2e/spike.spec.ts` | Tes Playwright UI (3 tes) + tes live yang dilewati kecuali `LARAS_SPIKE_LIVE=1` |
| `app/tests/spikes/verify-prod-solver.mts` | Verifikasi satu kali solver di build produksi (lihat §4) |
| `app/src/solver/solverClient.ts` | PERBAIKAN BUG: pola worker produksi (lihat §3) |
| `app/vite.config.ts` | `worker.format: 'es'` (lihat §3) |
| `workers/proxy/wrangler.toml`, `workers/proxy/README.md` | ALLOWED_ORIGINS ditambah origin preview (lihat §2) |

Keputusan dan perilaku halaman yang dicatat:

- **Dua mode.** "Periksa cepat": 30 detik per lagu, total sekitar
  3 menit (150 detik putar + waktu resolve). "Putar penuh": 5 lagu
  sampai habis, total 1.359 detik (22 menit 39 detik, dihitung eksak
  dari durasi kanari 268+251+308+254+278), dilabeli sekitar 23 menit.
- **Hash player** yang dipakai solver adalah hash dengan sts terbesar
  di config (saat ini b559f50c, sts 20770), konsisten dengan aturan
  S3 yang memakai sts terbesar untuk request player.
- **Coba ulang di tengah lagu:** bila putaran macet (posisi tidak maju
  45 detik) atau error sesudah terdengar lebih dari 5 detik, halaman
  me-resolve ulang sekali lalu lanjut dari posisi terakhir (mekanisme
  ganti sumber yang terbukti S3). Jumlah coba ulang tercatat per lagu
  di layar dan di laporan.
- **Blokir putar otomatis:** bila browser menolak `play()` karena
  belum ada interaksi, halaman menampilkan pesan biru meminta pengguna
  menekan tombol putar pada pemutar, lalu menunggu sampai 120 detik.
- **Layar dijaga menyala** selama uji berjalan lewat Wake Lock bila
  browser mengizinkan (membantu mode penuh 23 menit). Gagal meminta
  wake lock tidak menghentikan uji.
- **Tombol Hentikan** membatalkan resolve yang sedang menunggu
  jaringan (tanpa ini, Hentikan harus menunggu timeout sampai 60
  detik). Laporan berisi hasil sampai titik penghentian.
- **Laporan tidak pernah memuat URL stream** (aturan PRD B2.1):
  hanya judul, videoId, client, itag, jalur (lewat solver atau URL
  langsung), waktu resolve, posisi terdengar, coba ulang, dan penyebab
  gagal. Tes menegaskan tidak ada `googlevideo.com` atau
  `videoplayback` di laporan.
- **Status juga bisa dibaca dari konsol browser:**
  `window.__larasSpike.getReport()` dan `window.__larasSpike.getSummary()`.
- **Design lock:** canvas hitam `#000000`, aksen putih, warna hanya
  untuk status (hijau selesai, merah gagal, biru aktif/info).
  Copy Bahasa Indonesia sehari-hari, tanpa jargon, tanpa em-dash.

---

## 2. Proxy: origin preview ditambahkan dan terverifikasi live

Binding `ALLOWED_ORIGINS` worker `laras-proxy-spike` ditambah
`https://preview.laras-web.pages.dev` dan di-deploy ulang via API
langsung (`cfw_t.py` PUT, sesuai `workers/proxy/README.md` §Deploy
spike; kode worker tidak berubah, 11.800 byte). Deploy mengembalikan
`success: true`.

Verifikasi live sesudah deploy (curl, 17:16 UTC):

| Origin preflight OPTIONS | HTTP | `Access-Control-Allow-Origin` |
|---|---|---|
| `https://laras.adipmusic.my.id` | 204 | dikembalikan |
| `http://127.0.0.1:4173` | 204 | dikembalikan |
| `https://preview.laras-web.pages.dev` | 204 | dikembalikan |
| `https://example.com` (kontrol negatif) | 204 | TIDAK dikembalikan (benar) |

Catatan: cek pertama ~40 detik sesudah deploy sempat tidak membawa
header ACAO untuk origin preview (isolate lama), cek ulang sesudahnya
membawa header dengan benar. Deploy berikutnya WAJIB memakai daftar
tiga origin di `wrangler.toml` dan `README.md` (keduanya sudah
diperbarui) agar origin preview tidak terhapus.

---

## 3. Temuan kritis: solver GAGAL TOTAL di build produksi (sudah diperbaiki)

Build produksi pertama halaman spike membuktikan bug yang lolos dari
S1 (S1 hanya menguji di mode dev, di mana Vite mentransformasi `.ts`
di server):

1. `solverClient.ts` menyimpan `new URL('./solverWorker.ts',
   import.meta.url)` ke variabel dulu, lalu meneruskannya ke
   `new Worker(...)`. Vite TIDAK mengenali pola itu sebagai worker:
   build produksi mengubahnya menjadi data URL base64 berisi sumber
   TypeScript MENTAH (dengan MIME `video/mp2t`), sehingga worker
   tidak pernah bisa jalan (sumber TS bukan JS valid, impor di
   dalamnya tidak bisa di-resolve). Bukti: `dist/` build pertama
   tidak mengandung chunk worker sama sekali dan tidak mengandung
   modul QuickJS.
2. Perbaikan: `new Worker(new URL(...))` ditulis LANGSUNG di dalam
   pemanggilan `new Worker` (pola yang dikenali Vite), dengan komentar
   peringatan di konstruktor `SolverClient` agar tidak dikembalikan
   ke pola lama.
3. Perbaikan itu mengungkap masalah kedua: build gagal dengan
   `Invalid value "iife" for option "worker.format"` karena format
   worker default Vite (`iife`) ditolak untuk build dengan
   code-splitting. Perbaikan: `worker: { format: 'es' }` di
   `vite.config.ts` (worker dibuat dengan `{ type: 'module' }`,
   jadi format `es` adalah yang benar).

Dampak bila tidak diperbaiki: format cipher (WEB_REMIX/MWEB) tidak
pernah bisa dipecahkan di produksi; resolve selalu jatuh ke
ANDROID_VR. Halaman spike tetap bisa memutar lagu (lewat VR), tetapi
bukti integrasi solver S1/S4 di produksi menjadi nol.

Catatan utang: jalur fallback eval (`evalFallbackWorker.ts`, dipakai
`spikePage.ts` S1 di mode dev dengan pola URL lama yang sama) BELUM
diperbaiki karena hanya dipakai alat spike dev. Bila fallback eval
suatu hari dipakai produksi, ia butuh pola yang sama.

---

## 4. Bukti tes (angka ukur, 17-18 Nov 2026)

### 4.1 Anggaran bundle awal: LOLOS

Build produksi final (Vite 6.4.6, `npm run build`):

| Chunk | Mentah (byte) | gzip (byte) | Kapan diunduh |
|---|---|---|---|
| `index` (bundle awal JS) | 227.214 | 70.808 | Setiap kunjungan |
| CSS awal | 12.940 | 3.595 | Setiap kunjungan |
| `SpikePage` (rute /spike) | 40.410 | 14.200 | Hanya saat buka /spike |
| `solverClient` | 2.604 | 1.165 | Hanya saat cipher pertama |
| `solverWorker` + `ffi` + `module` + `emscripten-module` (QuickJS-WASM) | 729.226 | 272.955 | Hanya saat cipher pertama |

Bundle awal JS **70.90 KB gzip**, jauh di bawah anggaran 200 KB gzip
(sisa 129 KB). Verifikasi pemisahan: bundle awal hanya mengandung
satu referensi `import("./SpikePage-...js")` (lazy-load) dan TIDAK
mengandung kode solver, WASM, atau URL proxy. Solver total sekitar
274 KB gzip (261.054 byte modul WASM + 9.186 + 1.061 + 1.654 +
1.165 byte pendukung) hanya diunduh saat format cipher pertama
ditemui; jalur ANDROID_VR (URL langsung) tidak memuat solver sama
sekali.

### 4.2 Solver di build produksi: LOLOS lawan oracle

Skrip `tests/spikes/verify-prod-solver.mts` (Chromium nyata melawan
`vite preview`, build produksi): memuat chunk `solverClient` hasil
build, solve cipher oracle fad7e4e9 dengan base.js asli (2.677.001
byte, arsip koordinator Fase 2 APK):

| Pemeriksaan | Hasil |
|---|---|
| Solve + muat worker/WASM (cold start) | 1.927 ms |
| Host hasil `*.googlevideo.com` | YA |
| Sig cocok oracle APK (terverifikasi pytubefix) | YA |
| Transform n cocok (`4kdLuLGx-Us4iQ`) | YA |
| `pageerror` di halaman | 0 |

Ini membuktikan perbaikan §3 bekerja di artefak yang sama persis
dengan yang akan di-deploy ke preview.

### 4.3 Vitest, typecheck, lint: LOLOS

- `npx vitest run` (seluruh app): **70/70 lolos** (23 baru halaman
  spike: 8 laporan + 15 resolve; 47 lama tidak berubah).
- `npx tsc -b`: 0 galat. `npx eslint` pada berkas baru/berubah: bersih.
- Satu perbaikan dari tes: parse `signatureCipher` awalnya memakai
  dekode persen ganda yang merusak URL cipher (tes oracle gagal);
  diperbaiki ke dekode satu kali sesuai port `Uri.splitQueryString`
  APK, dan tes oracle lolos.

### 4.4 Playwright UI: LOLOS (chromium + mobile)

`tests/e2e/spike.spec.ts` melawan `vite preview` (build produksi):

| Uji | chromium | mobile (Pixel 7) |
|---|---|---|
| Lima lagu + dua mode tampil | lolos | lolos |
| Beranda tidak menautkan ke /spike | lolos | lolos |
| Tombol Hentikan + ringkasan muncul | lolos | lolos |
| Live periksa cepat 5/5 | dilewati (butuh `LARAS_SPIKE_LIVE=1`) | dilewati |

Suite E2E penuh proyek chromium sesudah perubahan: 4 lolos,
17 dilewati (spesifikasi S3/S5/S9 melewati diri sendiri di konfigurasi
utama, sesuai desain). Tidak ada regresi.

### 4.5 Yang TIDAK terbukti dari VM (jujur, bukan gagal)

- **Resolve via proxy + pemutaran lagu dari VM TIDAK diuji dan TIDAK
  diklaim.** Uji live Playwright sengaja dilewati bila
  `LARAS_SPIKE_LIVE` tidak disetel: dari VM, resolve lambat dan
  googlevideo memblokir IP VM (403 semua range non-nol, S3), sehingga
  uji itu gagal jaringan, bukan gagal kode. Memaksanya hijau dari VM
  adalah pemalsuan.
- **Pemutaran penuh 5 lagu** menunggu verifikasi parent di browser
  nyata (§5). Itulah satu-satunya bukti yang menutup P1.

---

## 5. LANGKAH VERIFIKASI PERSIS UNTUK PARENT (browser nyata, di luar VM)

### 5.0 Prasyarat

- Browser Chrome (desktop atau Android) di jaringan biasa (IP
  residensial), BUKAN dari VM. Pastikan suara perangkat menyala
  (volume cukup, tidak mute) dan koneksi stabil.
- URL preview: **https://preview.laras-web.pages.dev/spike**
- Siapkan sekitar 3 menit untuk langkah pertama dan sekitar 23 menit
  untuk langkah kedua (langkah kedua bisa ditinggal, tab jangan
  ditutup).

### 5.1 Langkah 1: Periksa cepat (JALANKAN DULU)

1. Buka **https://preview.laras-web.pages.dev/spike**.
2. Periksa tampilan: judul "Uji putar lima lagu", lima lagu
   (Semua Tentang Kita, Rahasia Hati, Surat Cinta Untuk Starla,
   Ya Sudahlah, Tak Ingin Usai), dua tombol mode, dan satu pemutar
   audio dengan tombol putar.
3. Ketuk tombol **"Periksa cepat"**.
4. Amati tanpa menutup tab (sekitar 3 menit):
   - Tiap lagu berubah status: Menunggu lalu Mencari lagu lalu
     Memutar, dengan angka waktu berjalan (0:00 sampai 0:30).
   - **Pastikan suara lagu TERDENGAR** minimal pada lagu pertama
     (angka waktu berjalan membuktikan decode, telinga membuktikan
     suara keluar).
   - Sesudah 30 detik, lagu berikut mulai otomatis.
   - Bila muncul pesan biru "Browser meminta ketukan": ketuk tombol
     putar pada pemutar audio di halaman, uji lanjut sendiri.
5. Sesudah lagu kelima, ringkasan muncul: "Hasil: X/5 lagu selesai".
6. Ketuk **"Salin hasil"** (tombol berubah menjadi "Hasil tersalin"),
   lalu **tempel laporan ke parent** (chat koordinator).
7. **Kriteria lanjut:** bila hasil 5/5, lanjut ke Langkah 2. Bila
   ada lagu gagal, tetap tempel laporannya, lalu lapor ke koordinator
   SEBELUM lanjut (koordinator memutuskan apakah Langkah 2 tetap
   jalan).

### 5.2 Langkah 2: Putar penuh (SETELAH Langkah 1 lolos 5/5)

1. Di halaman yang sama, ketuk tombol **"Putar penuh"**.
2. Biarkan berjalan **sekitar 23 menit**. Tab boleh ditinggal (layar
   dijaga menyala bila browser mengizinkan), tetapi **jangan tutup
   tab** dan jangan matikan perangkat.
3. Periksa sesekali: tiap lagu berjalan sampai durasi penuhnya
   (4:28, 4:11, 5:08, 4:14, 4:38) lalu lanjut otomatis ke lagu
   berikut. Catat bila ada lagu yang macet lama atau mengulang
   ("Coba ulang 1x" pada kartu lagu berarti halaman me-resolve
   ulang di tengah lagu; itu perilaku yang dirancang, bukan cacat,
   tetapi tetap dicatat di laporan).
4. Sesudah lagu kelima habis, ringkasan muncul. Ketuk **"Salin
   hasil"**, lalu **tempel laporan ke parent**.
5. **Kriteria P1 TERTUTUP:** Periksa cepat 5/5 DAN Putar penuh 5/5,
   dengan suara terdengar. Bila putar penuh ada yang gagal, tempel
   laporan lengkapnya (penyebab tiap lagu sudah tertulis di laporan)
   dan lapor ke koordinator; P1 belum tertutup.

### 5.3 Yang dicatat dan ditempel balik ke parent

- Laporan teks lengkap dari tiap mode (dua laporan bila keduanya
  jalan). Laporan berisi: mode, waktu mulai/selesai, total waktu,
  hasil X/5, jalur tiap lagu (client, itag, lewat solver atau URL
  langsung), waktu cari lagu, posisi terdengar, coba ulang, dan
  penyebab gagal.
- Konfirmasi suara terdengar (ya/tidak) dan perangkat/browser yang
  dipakai (mis. "Chrome desktop Windows" atau "Chrome Android").
- Bila ada keanehan (lagu macet, pesan ketukan muncul, tab tertidur),
  sebutkan di pesan bersama laporan.

### 5.4 Bila halaman tidak bisa dibuka atau uji macet total

- Halaman 404 di `/spike`: deploy preview belum memuat `_redirects`
  (perubahan ini) atau belum di-deploy ulang. Lapor ke koordinator.
- Semua lagu gagal di tahap "Mencari lagu" dengan penyebab soal
  server perantara: kemungkinan CORS proxy (cek preflight §2) atau
  kuota Workers. Tempel laporan dan lapor ke koordinator.
- Satu lagu gagal tetapi sisanya lolos: tempel laporan; koordinator
  memutuskan (bisa jadi masalah per lagu di sisi YouTube, bukan
  integrasi).

---

## 6. Utang dan tindak lanjut

1. **Verifikasi parent (§5)** adalah satu-satunya penutup P1 yang
   tersisa. Sampai laporan 5/5 dari browser nyata diterima, P1
   berstatus "dibangun dan terverifikasi dari VM sebatas yang
   mungkin", bukan "terbukti ujung ke ujung".
2. **Jalur fallback eval** (`evalFallbackWorker.ts`) masih memakai
   pola URL worker lama; hanya dipakai alat spike S1 di mode dev.
   Bila dipakai produksi, terapkan pola §3.
3. **Seek tengah lagu, dinding 1 MiB di IP residensial, dan audio
   latar/lock screen** tetap utang tes perangkat nyata dari S3/S9;
   halaman spike tidak mengujinya (halaman ini hanya membuktikan
   putar sampai habis + re-resolve 1x bila macet).
4. **Uji live Playwright** (`LARAS_SPIKE_LIVE=1`) tersedia untuk
   jalan ulang otomatis dari jaringan sehat di luar VM:
   `npx playwright test spike.spec` dengan variabel itu disetel.
   Dari VM, uji itu tetap dilewati.
5. **Koordinator yang push ke GitHub** (aturan tim; tim ini tidak
   push). Sesudah push, preview Pages di-deploy ulang otomatis dan
   URL §5 menjadi bisa diverifikasi.

---

## 7. Hasil §5 putaran pertama (18 Nov 2026 ~08:00 WIB) — 0/5

Parent menjalankan Langkah 1 di browser nyata (cloud browser,
Chrome 157): **Periksa cepat 0/5, dua kali identik** (total 5 detik
+ 3 detik; tiap lagu gagal ~1 detik). Pesan tampil: "Lagu tidak bisa
ditemukan di semua jalur. Coba lagi nanti." Langkah 2 tidak jalan
(kriteria). Tampilan halaman lengkap, tombol jalan.

Diagnosis parent (probe langsung): semua infra hidup (preview 200,
preflight proxy 204 + ACAO benar, config-v1 200, 869 byte). Player
via proxy: WEB_REMIX + ANDROID_VR HTTP 200 LOGIN_REQUIRED "Sign in
to confirm you're not a bot", 0 format audio.

**KOREKSI atas klaim §5 lama ("HP owner penentu definitif"): salah
untuk tahap resolve** — IP yang dilihat YouTube adalah IP egress
worker, bukan IP browser pemanggil. Tes HP owner akan gagal sama di
tahap resolve; IP residensial HP hanya berpengaruh di fetch audio
googlevideo sesudah resolve lolos. Jangan minta owner tes §5 dari HP
sampai resolve lewat proxy bisa lolos.

Tindak lanjut koordinator (18 Nov 2026): matriks egress empiris,
eksperimen visitorData terkendali, evaluasi opsi + rekomendasi
(retry LOGIN_REQUIRED lintas waktu direkomendasikan; poToken tetap
di luar v1) — semua di
`docs/spikes/egress-dan-opsi-resolve.md`. Perbaikan diagnosis:
laporan kini menampilkan baris `Detail:` per lagu (attempts +
playability dari `ResolveError.message`), jadi §5 berikut bisa
didiagnosis dari laporan saja. Uji §5 ulang sesudah retry mendarat
(P6); ekspektasi waktu berubah (jendela buruk gagal ~30–60 detik,
bukan ~1 detik).
