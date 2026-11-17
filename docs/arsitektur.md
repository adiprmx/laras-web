# Arsitektur Laras Web App Full-Stack

**Status:** Fase 1, dokumen saja. Belum ada kode, belum ada repo.
**Tanggal tulis:** 17 November 2026.
**Disusun oleh:** Tim Arsitektur (Fase 1) dari dokumen riset, transfer ekstraktor,
keputusan solver, arsitektur APK, PRD v1, dan roster tim.
**Dokumen acuan:**
`docs/riset-kompetitor-web.md` (17 Nov 2026),
`docs/transfer-ekstraktor.md` (17 Nov 2026),
`docs/keputusan-solver.md` (17 Nov 2026),
`~/workspace/music-app/docs/arsitektur.md`,
`~/workspace/music-app/docs/prd-v1.md`,
`docs/roster-tim.md`.

**Cara membaca:** semua angka batas free-tier dikutip dari dokumentasi resmi
atau sumber sekunder yang menyebut halaman resmi, dengan URL di bagian Daftar
sumber. Angka yang belum terverifikasi dilabeli eksplisit, bukan ditebak.
Keputusan yang mengikat ditandai **DIPUTUSKAN**. Usulan yang masih bisa diubah
ditandai **USULAN**.

## 0. Ringkasan eksekutif

Laras Web adalah aplikasi musik gratis, tanpa iklan, bisa offline, yang berjalan
di browser sebagai PWA. Ia memakai katalog YouTube Music lewat client InnerTube
kustom yang sama dengan APK Laras, memutar audio lewat elemen `<audio>` HTML,
menyimpan library di IndexedDB, dan menyelesaikan signature YouTube di browser
pengguna (QuickJS-WASM di Web Worker). Satu-satunya komponen server adalah
proxy byte-only tipis di Cloudflare Workers, dan itu pun hanya dipakai bila
spike membuktikan fetch langsung dari browser diblokir CORS. Tanpa login untuk
memutar lagu. Tanpa server berbayar. Tanpa kartu kredit. Biaya Rp0.

| Komponen | Pilihan v1 | Alasan singkat |
|---|---|---|
| Hosting + edge + DB server | Cloudflare Pages + Workers + D1 (+ KV baca) | Satu vendor, tanpa kartu, tanpa jeda nonaktif, reset harian |
| Frontend | React + Vite + TypeScript + Tailwind + Zustand | Pola yang sama dengan tiga kompetitor web terdekat |
| PWA | vite-plugin-pwa (Workbox) + Service Worker | Shell offline, instalasi, cache media |
| Pemutar | `<audio>` + MediaSession + Web Audio (EQ) | EQ hanya aktif bila audio lolos CORS (spike S5) |
| Solver signature | QuickJS-WASM di Web Worker khusus | Keputusan mengikat `keputusan-solver.md` |
| Pencarian/katalog | InnerTube (player/search/browse) via proxy bila perlu | Port pengetahuan APK, fallback WEB_REMIX, MWEB, ANDROID_VR |
| Lirik | LRCLIB langsung dari browser + cache IndexedDB | CORS terbuka, tanpa kunci, tanpa akun |
| Data lokal | IndexedDB (port 15 tabel APK) + Cache Storage | Tanpa JSON blob besar, tanpa key-value untuk koleksi |
| Config remote | Pakai ulang `config-v1` repo `adiprmx/laras` | Satu control plane untuk APK dan web |
| Akun | Opsional, OAuth Google/GitHub, hanya untuk sinkronisasi | Login tidak pernah wajib untuk memutar lagu |
| Lisensi | GPL-3.0-only | Sama dengan APK (PRD B11.1) |

**Tujuh keputusan arsitektur utama:**

1. **Solver tetap di browser.** Cloudflare Workers melarang `eval` dan membatasi
   CPU free-tier 10 ms, sementara solve saja median 10,5 ms. Solver di Worker
   tidak layak secara aritmetik dan melanggar batas platform. Bukti lengkap di
   `keputusan-solver.md`.
2. **Proxy hanya memindah byte.** Worker tidak mengeksekusi base.js, tidak
   memecahkan cipher, tidak menyimpan data pengguna. Pekerjaan CPU-nya hampir
   nol sehingga muat di batas 10 ms free-tier.
3. **Satu control plane config untuk APK dan web.** Versi client, hash player,
   dan sts hidup di satu file `player-config.json` tag `config-v1`. Satu
   pembaruan memperbaiki kedua platform.
4. **Offline-first port penuh dari APK.** Unduhan, cache streaming, library,
   pencarian lokal, playlist, antrean, dan pengaturan jalan tanpa internet.
   Yang butuh jaringan menjelaskan keadaannya, bukan menampilkan tombol mati.
5. **Semua koleksi di IndexedDB, tidak pernah di localStorage.**
   localStorage hanya nilai primitif kecil (batas keras 1 KB per nilai,
   100 KB total), port langsung aturan anti-OOM APK.
6. **Tanpa login di jalur inti.** Akun hanya membuka sinkronisasi antar
   perangkat. Pengguna tanpa akun mendapat seluruh fungsi pemutaran, unduhan,
   lirik, dan EQ.
7. **Keamanan diuji berulang, bukan sekali.** Siklus Red, Blue, Red memakai
   OWASP ASVS dan MASVS yang relevan untuk web, terikat milestone, berhenti di
   nol temuan kritis/tinggi/sedang, maks 5 ronde. Purple Team memvalidasi
   setiap perbaikan.

## 1. Gambaran arsitektur

```
+------------------------------------------------------------------+
|  Browser pengguna (IP residensial)                               |
|  PWA: React + Vite + TS + Tailwind + Zustand                     |
|  Beranda, Cari, Player, Library, Playlist, Pengaturan, Unduhan  |
|  State di lapisan UI; widget tidak memanggil fetch/InnerTube/    |
|  IndexedDB langsung, hanya lewat service.                        |
+------------------------------------------------------------------+
   |                 |                   |                 |
+--v--------+  +-----v----------+  +-----v--------+  +-----v--------+
| PlayerSvc |  | LibrarySvc     |  | SearchSvc    |  | SyncSvc      |
| (AudioPl- |  | (playlist,     |  | (cari lokal  |  | (opsional,   |
|  ayerPort)|  |  favorit,      |  |  + cari YTM) |  |  akun saja)  |
+--+--------+  +-----+----------+  +-----+--------+  +-----+--------+
   |                 |                   |                 |
+--v--------+  +-----v----------+  +-----v--------+  +-----v--------+
| <audio> + |  | IndexedDB      |  | InnerTube    |  | Worker API   |
| MediaSess |  | 15 store,      |  | module (TS)  |  | /api/*       |
| + WebAud  |  | token index,   |  | player/srch/ |  | (auth + sync,|
| (EQ)      |  | blob audio     |  | browse parse |  |  D1)         |
+--+--------+  +-----+----------+  +-----+--------+  +--------------+
   |                 |                   |
+--v--------+  +-----v----------+  +-----v--------------------------+
| Solver    |  | Service Worker |  | Worker proxy (byte-only,      |
| QuickJS-  |  | + Cache Stor.  |  | HANYA bila S2 membuktikan     |
| WASM di   |  | (shell + media |  | direct fetch diblokir CORS)   |
| Web Worker|  |  cache opaque) |  |                               |
+-----------+  +----------------+  +--------------------------------+
```

Aturan lapisan yang mengikat:

- Komponen UI hanya berbicara ke service. Service hanya berbicara ke
  port/interface. Implementasi konkret (elemen audio, IndexedDB, fetch) hidup
  di balik interface dan bisa diganti tanpa menyentuh UI.
- Semua pekerjaan berat (solver, parsing base.js, penulisan blob, pengindeksan
  token) berjalan di luar UI thread: solver di Web Worker khusus, pengindeksan
  di worker atau idle callback.
- Semua fetch jaringan punya timeout eksplisit lewat AbortController (aturan
  proyek, berlaku umum). Tidak ada request tanpa batas waktu.
- Tidak ada data pengguna yang meninggalkan perangkat kecuali request ke
  YouTube/Google (pencarian, stream), penyedia lirik (judul lagu), host config
  remote (GitHub), dan, bila pengguna memilih membuat akun, Worker sync milik
  app. Tidak ada telemetri, tidak ada tracker pihak ketiga.
- URL stream hanya ada di memori, tidak pernah disimpan di database, file,
  atau log (port PRD B2.1). Yang disimpan adalah videoId; URL di-resolve ulang
  setiap kali giliran lagu tiba atau sesudah jeda panjang.

## 2. Keputusan backend

### 2.1 Batas free-tier yang terverifikasi (cek 17 Nov 2026)

**Cloudflare Workers Free** (halaman harga resmi, dibuka langsung):
100.000 request/hari (reset 00:00 UTC, lewat batas menjadi Error 1027),
CPU 10 ms per invocation, memori 128 MB per isolate, 50 subrequest per
request. Waktu tunggu jaringan tidak dihitung sebagai CPU. Workers Paid
US$5/bulan minimum, di luar batas Rp0 sehingga bukan opsi.
Sumber: https://developers.cloudflare.com/workers/platform/pricing/
dan https://developers.cloudflare.com/workers/platform/limits/index.md

**Cloudflare Workers KV** (halaman harga resmi yang sama): 100.000 baca
kunci/hari, 1.000 tulis/hari, 1.000 hapus/hari, 1.000 list/hari, penyimpanan
1 GB. Tulis KV adalah kuota paling sempit di seluruh stack dan sudah pernah
habis di akun owner lain (batas harian KV kena 16-17 Nov 2026 di akun adiprmx,
per memori proyek). Karena itu KV hanya untuk cache baca, tidak pernah untuk
tulis per request.

**Cloudflare D1** (halaman harga resmi yang sama): 5.000.000 baris dibaca/hari,
100.000 baris ditulis/hari, penyimpanan total 5 GB, maks 10 database per akun.
Batas 500 MB per database dikutip dari sumber sekunder
(https://toolfreebie.com/cloudflare-free-tier-limits/,
https://www.qaupot.com/posts/2b234af97b2c4fa39fc26e2697f353ec/).
Baris dibaca dihitung dari baris yang dipindai, bukan baris yang dikembalikan,
sehingga indeks wajib ada di kolom filter (dinyatakan eksplisit di halaman
harga resmi).

**Cloudflare Pages Free** (sumber sekunder, belum diverifikasi dari halaman
resmi): 500 build/bulan, 1 build bersamaan, timeout build 20 menit, 20.000
file per situs, 25 MiB per file.
Sumber: https://www.cloudsoftzone.com/blog/cloudflare-review-free-pro-workers-2026
Status: **belum terverifikasi** dari halaman resmi; tim implementasi wajib
cek ulang sebelum memakai angka ini sebagai dasar keputusan build.

**Cloudflare R2** (sumber sekunder, beberapa sumber sepakat): 10 GB
penyimpanan, 1 juta operasi Class A/bulan, 10 juta operasi Class B/bulan,
tanpa biaya egress.
Sumber: https://toolfreebie.com/cloudflare-free-tier-limits/
R2 tidak dipakai di v1 (audio tidak di-host app), dicatat sebagai cadangan
penyimpanan aset bila suatu hari dibutuhkan.

**Supabase Free** (halaman harga resmi via beberapa sumber sekunder yang
sepakat, dibaca 8-27 Okt 2026): 2 proyek aktif, database 500 MB per proyek,
file storage 1 GB, egress 5 GB/bulan ditambah 5 GB cached egress, Auth
50.000 MAU, 500.000 invokasi Edge Function/bulan, request API tanpa batas
hitungan baris. Proyek gratis dijeda otomatis sesudah 1 minggu tanpa aktivitas
dan harus dipulihkan manual dari dashboard. Tanpa backup otomatis.
Sumber: https://supabase.com/pricing (via
https://billiem.uk/posts/supabase-free-tier-limits/,
https://makerkit.dev/blog/saas/supabase-pricing,
https://aiagencyplus.com/supabase-free-tier-limits/).
Catatan penting: batas 2 proyek aktif berlaku di seluruh organisasi tempat
pengguna adalah Owner atau Admin, sehingga organisasi kedua belum tentu
memberi 2 slot baru (https://billiem.uk/posts/supabase-free-tier-limits/).
Klaim ini **belum terverifikasi** dari dokumen billing resmi Supabase dan
wajib dicek sebelum organisasi kedua dipakai sebagai dasar rencana.

**Vercel Hobby** (sumber sekunder, angka berubah antar sumber): sumber terbaru
(Agu 2026, mengutip halaman limits Vercel yang diperbarui 3 Agu 2026)
menyebut 1 juta invokasi fungsi/bulan, transfer 100 GB/bulan, 4 CPU-jam,
360 GB-jam memori, durasi maks 300 detik per invokasi, memori 2 GB per fungsi.
Sumber lama menyebut 100 ribu invokasi dan timeout 10 detik; angka lama itu
kedaluwarsa sejak Vercel pindah ke model fluid compute April 2025.
Sumber: https://www.natecue.com/en/learn/tech/serverless-functions-explained/,
https://supadrop.host/blog/vercel-pricing-free-tier-limits/
Status: angka terbaru **belum terverifikasi** langsung dari halaman limits
resmi; tim implementasi wajib cek ulang. Yang konsisten di semua sumber:
Hobby hanya untuk pemakaian personal non-komersial, dan bila batas terlampaui
proyek dijeda sampai siklus berikutnya (sekitar 30 hari), bukan reset harian.

**Firebase Spark** (halaman harga resmi via beberapa sumber sekunder yang
sepakat, dibaca 1-16 Okt 2026): Firestore 50.000 baca/hari, 20.000 tulis/hari,
20.000 hapus/hari, penyimpanan 1 GiB, egress 10 GiB/bulan; Auth 50.000 MAU;
Hosting 10 GB penyimpanan dan transfer 360 MB/hari. Cloud Functions TIDAK
tersedia di Spark (hanya Blaze, butuh kartu). Cloud Storage juga butuh Blaze
sejak 3 Feb 2026. Bila kuota terlampaui, produk dimatikan sampai reset, bukan
ditagih.
Sumber: https://firebase.google.com/pricing (via
https://magora-systems.com/firebase-pricing/,
https://www.lilachbullock.com/is-firebase-free/,
https://procurementvms.com/vendors/firebase-pricing-guide.html).

### 2.2 Matriks trade-off tiga opsi backend

| Dimensi | (1) Cloudflare Workers/Pages + D1/KV | (2) Vercel + Supabase free | (3) Firebase Spark |
|---|---|---|---|
| Proxy InnerTube (server-side) | Bisa, Worker byte-only, CPU ~2 ms (I/O-bound) | Bisa, fungsi serverless | TIDAK BISA, Cloud Functions hanya di Blaze (butuh kartu) |
| Hosting PWA | Pages, gratis, tanpa batas transfer yang mengikat | Vercel Hobby, 100 GB/bulan | Hosting Spark, transfer 360 MB/hari (sempit untuk bundle ~1,2 MB QuickJS-WASM) |
| Database sync | D1: 5 jt baris baca/hari, 100 rb tulis/hari, 5 GB | Postgres 500 MB/proyek, API tanpa batas baris | Firestore 50 rb baca/hari, 20 rb tulis/hari, 1 GiB |
| Auth bawaan | Tidak ada, bangun sendiri di Worker + D1 (OAuth) | Supabase Auth lengkap (OAuth, magic link, 50 rb MAU) | Firebase Auth lengkap (50 rb MAU) |
| Batas proyek/akun | 100 Worker per akun, 10 DB D1, tanpa batas proyek yang mengikat | Org adipmusic 0 headroom (2/2 proyek terpakai); organisasi kedua presedennya ada tetapi batas 2 proyek mungkin berlaku lintas organisasi | Tanpa batas proyek yang mengikat |
| Jeda nonaktif | Tidak ada | Proyek dijeda sesudah 1 minggu tanpa aktivitas, pulihkan manual | Tidak ada |
| Bila kuota habis | Gagal sampai reset 00:00 UTC (harian) | Proyek dijeda sampai siklus berikut (sekitar 30 hari) | Produk dimatikan sampai reset |
| Klausul pemakaian | Tanpa klausul non-komersial | Hobby hanya personal non-komersial (risiko ToS bila proyek menerima donasi/sponsor) | Tanpa klausul non-komersial |
| Kartu kredit | Tidak butuh | Tidak butuh | Tidak butuh di Spark; butuh kartu begitu Functions dipakai (Blaze) |
| Jumlah vendor | 1 | 2 | 1 (tetapi proxy tetap butuh vendor kedua) |
| Pengalaman tim owner | Sudah dipakai (Atlys Mail di Cloudflare, akun hiroohengkerr) | Sudah dipakai (AyoQris, Karir) | Sudah dipakai (adipmusic, RTDB + Auth) |

### 2.3 Keputusan

**DIPUTUSKAN: stack utama adalah Cloudflare (Pages + Workers + D1 + KV
baca).** Alasannya, berurutan dari yang paling menentukan:

1. Opsi 3 gugur sebagai stack utama karena Spark tidak menyediakan fungsi
   server-side sama sekali. Proxy InnerTube adalah kebutuhan arsitektur yang
   diputuskan di `keputusan-solver.md` §6, dan Firebase tidak bisa
   memenuhinya tanpa kartu (Blaze). Memakai Firebase berarti tetap butuh
   vendor kedua untuk proxy, sehingga keunggulan satu vendor hilang.
2. Opsi 2 gugur sebagai stack utama karena headroom Supabase nol dan jeda
   nonaktifnya. Org adipmusic sudah 2/2 proyek gratis. Organisasi kedua adalah
   preseden yang sudah diputuskan owner di proyek lain, tetapi dokumen billing
   Supabase (via sumber sekunder) menyatakan batas 2 proyek aktif berlaku
   lintas organisasi tempat pengguna adalah Owner/Admin, sehingga organisasi
   kedua belum tentu menambah slot. Ditambah jeda otomatis sesudah 1 minggu
   tanpa aktivitas: layanan sinkronisasi yang mati tiap minggu sepi adalah
   perilaku yang tidak bisa diterima untuk app musik, dan pemulihannya manual.
   Vercel Hobby menambah dua risiko lagi: klausul non-komersial dan jeda
   sekitar 30 hari bila kuota terlampaui.
3. Opsi 1 memenuhi semua kebutuhan di satu vendor tanpa kartu: Pages untuk
   hosting, Workers untuk proxy byte-only (CPU I/O-bound, jauh di bawah 10 ms)
   dan API auth/sync, D1 untuk database sync (kuota baris harian jauh di atas
   kebutuhan sinkronisasi playlist/riwayat), KV hanya sebagai cache baca
   (config, jawaban search yang sering diulang). Reset harian berarti
   kegagalan kuota pulih sendiri keesokan hari, bukan sebulan kemudian.
4. Satu-satunya kekurangan nyata opsi 1 adalah tidak ada auth bawaan. Ini
   diterima karena auth Laras Web sengaja minimal: OAuth Google/GitHub saja,
   tanpa kata sandi yang disimpan, tanpa email magic link (yang butuh layanan
   pengirim email). Worker + D1 cukup untuk itu (§4.3).

**Cadangan bila stack utama gagal: Vercel Hobby (hosting + proxy serverless)
+ Supabase (organisasi kedua, sesuai preseden owner) untuk auth dan sync.**
Cadangan ini dipakai hanya bila salah satu pemicu terpenuhi: Cloudflare
mengubah batas free-tier sehingga proxy tidak lagi muat, akun Cloudflare
bermasalah, atau D1 terbukti tidak cukup untuk sync. Sebelum cadangan dipakai,
tim wajib memverifikasi dua hal dari dokumen resmi Supabase: apakah batas
2 proyek benar berlaku lintas organisasi, dan apakah jeda 1 minggu bisa
dinetralkan dengan ping terjadwal yang sah (bila ping penjaga melanggar
ketentuan, cadangan ini tidak dipakai). Firebase Spark dicatat sebagai
cadangan lapis ketiga hanya untuk auth/sync, bukan sebagai stack penuh,
dan tetap butuh proxy Cloudflare atau Vercel.

**Hitungan kuota proxy (asumsi dinyatakan eksplisit).** Satu pengguna aktif
diperkirakan memakai sekitar 17 request proxy/hari: 10 resolve player,
5 pencarian, 2 browse. 100.000 request/hari dibagi 17 sama dengan sekitar
5.800 pengguna aktif/hari. Unduhan lewat proxy menambah sekitar 3 request per
lagu (resume Range). Bila spike S2 membuktikan direct fetch lolos di browser,
beban proxy turun mendekati nol dan angka ini tidak lagi mengikat. Bila kuota
habis (Error 1027), app beralih ke mode terdegradasi: lagu tersimpan dan cache
tetap bisa diputar, pencarian dan streaming baru menampilkan pesan jujur
beserta tombol "Periksa pembaruan", dan jalur fallback IFrame (§4.1) ditawarkan
untuk pemutaran.

## 3. Frontend PWA

### 3.1 Design read

Reading this as: pemutar musik mode Operate untuk pendengar Indonesia yang
sering kehabisan kuota, dengan bahasa visual monokrom yang dikunci owner,
leaning toward React + Vite + Tailwind + token desain APK. Dials:
DESIGN_VARIANCE 5, MOTION_INTENSITY 3, VISUAL_DENSITY 5. Ini aplikasi yang
dipakai tiap hari, bukan landing page: gerak dibatasi pada umpan balik sentuhan
dan transisi layar, tanpa animasi dekoratif yang menguras baterai.

### 3.2 Framework

**DIPUTUSKAN: React + Vite + TypeScript + Tailwind CSS + Zustand.**

- Bukti dari kompetitor terdekat: Musike memakai React 19 + Vite 8 + Tailwind
  4 + Zustand + React Router (README dibaca 17 Nov 2026); Cantio memakai
  React 18 + Vite + Tailwind + Zustand; Vibentra memakai React + Capacitor.
  Ketiganya memutar katalog YouTube Music di browser dengan stack ini, jadi
  stack ini terbukti untuk produk yang sama persis.
- Proyek owner lain memakai Vite (Adip Tools memakai Vite sejak v6.14.0),
  sehingga perkakas dan pola build-nya sudah dikenal tim.
- TypeScript wajib untuk port ekstraktor: parser respons InnerTube yang dalam
  dan berubah-ubah butuh tipe yang ketat, dan port `buildPlayerScript` dari
  Dart ke TypeScript butuh pemeriksaan tipe di setiap langkah (spike S4).
- Zustand untuk state global (antrean, status putar, library) karena dipakai
  Musike dan Cantio untuk kebutuhan yang sama dan ukurannya kecil.
- React Router untuk rute (Musike memakainya). State pencarian dan filter
  memakai URL search params agar bisa dibagikan dan di-bookmark.
- PWA memakai vite-plugin-pwa (Workbox) untuk manifest, precache shell, dan
  strategi cache runtime. Nama paket ini adalah kandidat standar; versi pastinya
  diverifikasi saat implementasi.

Yang dipertimbangkan dan tidak dipilih:

- Svelte/SvelteKit: bundle lebih kecil, tetapi tidak ada satu pun kompetitor
  web terdekat yang memakainya untuk produk ini, dan ekosistem pustaka audio
  serta PWA-nya lebih kecil. Dicatat sebagai alternatif bila anggaran bundle
  React tidak tercapai.
- Vanilla JS: tanpa framework berarti menulis sendiri routing, state, dan
  daftar virtual untuk library 10.000 lagu. Biaya perawatan lebih besar dari
  penghematan bundle.
- Preact: kompatibel React dengan bundle lebih kecil. Cadangan bila anggaran
  bundle §3.9 tidak tercapai setelah optimasi.
- Next.js/SSR: tidak dibutuhkan. App ini client-side penuh; data katalog
  datang dari InnerTube saat runtime, bukan dari server render. SSR menambah
  kompleksitas dan biaya compute tanpa manfaat untuk pemutar musik.

### 3.3 Pemutar

Satu elemen `<audio>` persisten yang hidup selama sesi (pola Musike: satu
elemen media yang berpindah tempat tanpa memutus pemutaran). Semua akses audio
lewat interface `AudioPlayerPort` milik app, bukan memanggil elemen audio
langsung dari komponen. Ini port langsung keputusan APK §7.1: engine bisa
diganti tanpa menyentuh UI.

- Kontrol dasar: putar, jeda, seek (angka waktu mengikuti drag, seek dikirim
  sekali saat drag dilepas), next, prev. Prev memakai ambang 3 detik port APK:
  posisi lebih dari 3 detik kembali ke awal lagu yang sama, 3 detik atau kurang
  pindah ke lagu sebelumnya.
- Shuffle, repeat tiga keadaan (mati, semua, satu), kecepatan 7 pilihan
  (0,5x sampai 2x). Pitch dan skip silence adalah Could, bukan v1.
- `navigator.mediaSession`: metadata (judul, artis, album, sampul) dan action
  handler (play, pause, previoustrack, nexttrack, seekto). Ini kewajiban,
  bukan hiasan: kontrol lock screen dan headset adalah ekspektasi dasar
  pemutar web (riset §2 dan §16.5).
- Reverse-queue: tombol previous benar-benar kembali ke lagu sebelumnya dari
  riwayat putar, bukan restart lagu (standar Cantio).
- Urutan sumber audio, port PRD B2.1: file unduhan dulu, lalu file cache
  streaming, lalu resolve URL stream dari videoId. Prefetch 1 lagu ke depan.
- Stream gagal di tengah lagu: pemulihan diam-diam berurutan (tunggu 2 detik
  lalu resume; resolve ulang dari videoId; pindah ke lagu berikut). Sesudah
  3 lagu berturut-turut gagal, app berhenti dan menampilkan pesan bahasa
  sehari-hari dengan tombol "Coba lagi" dan "Buka lagu yang diunduh".
- Re-resolve di tengah pemutaran dirancang sejak awal, bukan tambalan:
  googlevideo membatasi 1 MiB per URL dari IP datacenter VM (transfer §10),
  dan belum terbukti apakah batas itu berlaku di IP residensial. Bila batas
  itu berlaku di perangkat pengguna, pemutar wajib me-resolve ulang sebelum
  batas tercapai. Mekanisme: pantau byte yang sudah diputar lewat
  `buffered` dan posisi; bila mendekati ambang, resolve URL baru dan sambung
  lewat Media Source Extensions atau ganti `src` di posisi yang sama.
  Detail implementasi diputuskan spike S3; arsitektur menyediakan titik
  sambungnya sejak awal.
- Snapshot kegagalan pemutar: port pelajaran P0-2 (§9.4 transfer). Snapshot
  resolve saja tidak cukup; kegagalan engine (setSources/play, googlevideo
  403) wajib punya snapshot paralel yang masuk ke kode diagnostik LRS1.

### 3.4 Web Audio: EQ dan normalisasi

Graph Web Audio: `MediaElementAudioSourceNode` ke 10 filter biquad
(peaking, frekuensi tengah standar ISO 31 Hz sampai 16 kHz, port spesifikasi
mpv_audio_kit APK §2.5) ke `DynamicsCompressorNode` (normalisasi loudness
sederhana) ke `GainNode` (volume app) ke tujuan. Preset + mode "Atur sendiri"
dengan nilai tersimpan di IndexedDB.

Batasan yang menentukan: `createMediaElementSource` pada media lintas origin
hanya mengeluarkan suara bila respons membawa header CORS yang mengizinkan.
Bila header itu tidak ada, output graph menjadi sunyi. Apakah googlevideo
mengirim header CORS untuk audio adalah **belum terverifikasi** dan diputuskan
spike S5. Desain menangani kedua hasil:

- Bila S5 membuktikan CORS terbuka: EQ aktif untuk semua jalur (streaming,
  cache, unduhan).
- Bila S5 membuktikan CORS tertutup: EQ aktif untuk audio lokal dan cache
  (blob same-origin, selalu lolos CORS); untuk streaming langsung, pemutar
  memakai elemen audio tanpa graph dan kontrol EQ menampilkan penjelasan
  jujur. Tidak ada proxy audio di v1 untuk mengejar EQ (proxy audio akan
  menghabiskan kuota 100 ribu request/hari dan memusatkan beban ke IP
  datacenter yang reputasinya buruk, transfer §10 dan keputusan-solver §4.8).

Deteksi runtime: sebelum menyambung graph, app menguji satu fetch CORS
dengan Range kecil ke URL stream. Fetch berhasil berarti graph aman dipakai;
fetch gagal karena CORS berarti pemutar memakai jalur tanpa graph. Pengujian
ini murah (satu request kecil) dan hasilnya di-cache per host.

### 3.5 Pencarian, jelajah, perpustakaan, playlist

- Pencarian jaringan hanya jalan saat pengguna mengirim kueri secara eksplisit
  (port PRD B1.1). Saran pencarian dari endpoint `music/get_search_suggestions`
  sesudah debounce 300 ms, maks 8 saran; kegagalan saran hilang diam-diam.
- Riwayat pencarian lokal maks 100 query, dedup tanpa peduli kapitalisasi.
- Pencarian library lokal memakai indeks token IndexedDB (§5.2), kelompok
  hasil berlabel "Dari Library-mu", tampil sebelum hasil jaringan, jalan penuh
  saat offline.
- Hasil pencarian dikelompokkan (lagu, album, artis, playlist), maks 10 item
  per kelompok dengan tombol "Lihat semua" ke daftar penuh 50 per halaman.
  Parser yang gagal di satu kelompok tidak mengosongkan kelompok lain.
- Pagination: keyset 50 per halaman untuk lokal, continuation token InnerTube
  untuk jaringan, prefetch saat 10 item sebelum akhir.
- Beranda: 5 seksi lokal ditambah 1 seksi jaringan ("Jelajah"), urutan port
  PRD B6.1: "Baru diputar", "Lagu untukmu", "Sering diputar", "Playlist kamu",
  "Unduhan", "Jelajah". Rumus "Lagu untukmu" port utuh dari PRD (skor putaran
  bermakna 30 detik dalam 30 hari, tambah 5 bila favorit, tambah 2 bila
  diunduh, 20 teratas). Seksi lokal tampil dulu dari database; beranda tidak
  pernah loading penuh.
- Playlist: nama maks 100 karakter, deskripsi maks 500 karakter; sampul
  kolase 2x2 dari 4 lagu pertama di halaman detail, sampul lagu pertama di
  daftar; drag and drop untuk urutan; hapus dengan Urungkan 5 detik. Favorit
  adalah playlist virtual tersendiri, bukan tag.
- Library 10.000 lagu wajib tetap lancar: daftar virtual (windowing) + halaman
  50 item. Tanpa daftar virtual, 10.000 node DOM akan membuat scroll tersendat.
- Impor playlist Spotify tanpa API: jalur B (file/teks tempel) utama, jalur A
  (tautan playlist publik) sekunder yang wajib dibuktikan sebelum dikapalkan.
  Larangan memanggil `api.spotify.com` atau `accounts.spotify.com` berlaku
  permanen (PRD B10.1).
- Tautan dalam: URL `youtu.be`, `youtube.com/watch`, `music.youtube.com`
  yang dibuka di app memutar lagu atau playlist yang dituju (validasi 11
  karakter videoId, port P7 APK).

### 3.6 Unduhan dan offline

- Unduhan lagu, album, dan playlist dengan dialog ringkas ("Unduh 12 lagu
  (sekitar 50 MB)?") dari durasi nyata tiap lagu. Kualitas unduhan memakai
  label kanonis APK: "Terbaik" (251, sekitar 4,2 MB per lagu 3,5 menit),
  "Seimbang" (140, sekitar 3,4 MB), "Hemat data" (249/139, sekitar 1,3 MB).
  Kata itag, bitrate, codec, Opus, AAC, dan angka kbps tidak pernah tampil
  di antarmuka.
- Unduhan berjalan serial 1 file dalam satu waktu, lewat proxy Worker dengan
  header Range (resume dari byte terakhir). File ditulis ke IndexedDB sebagai
  Blob sesudah ukuran cocok; pembatalan menghapus job dan blob sebagian.
  Antrean unduhan tersimpan di store `download_jobs` sehingga tahan restart.
- Unduhan butuh proxy karena fetch langsung ke googlevideo dari browser
  diblokir CORS (googlevideo tidak mengirim header CORS untuk fetch; elemen
  `<audio>` dikecualikan dari CORS, tetapi `fetch` tidak). Ini satu-satunya
  pemakaian proxy untuk byte audio di v1.
- Cache streaming otomatis (pola ViMusic): Service Worker mencegat request
  media ke googlevideo dan menyimpan respons opaque ke Cache Storage.
  Respons opaque tidak memberi ukuran dan header, sehingga akuntansi ukuran
  memakai estimasi dari durasi dikali bitrate itag (4,2 MB per lagu 3,5 menit
  untuk itag 251) dan wajib dilabeli estimasi di layar Penyimpanan. Range
  request dari cache dilayani dengan memotong blob yang tersimpan dan
  membangun respons 206 secara manual. Pola ini dibuktikan spike S6; bila S6
  gagal, v1 hanya membawa unduhan eksplisit dan cache otomatis pindah ke v1.1.
- Batas cache: default 500 MB, pilihan 250 MB, 500 MB, 1 GB, 2 GB (port APK).
  Eviction LRU tidak pernah menyentuh unduhan dan tidak pernah menghapus file
  yang sedang diputar. Cache dan unduhan dipisah total.
- Pemeriksaan ruang sebelum unduh: kurang dari perkiraan ditambah 100 MB
  berarti unduhan ditolak dengan pesan jelas. API `navigator.storage.estimate()`
  dipakai untuk membaca kuota; angka kuota browser bervariasi per perangkat
  dan per browser, sehingga app menampilkan angka dari API, bukan angka
  karangan.
- Rekonsiliasi saat start dingin: blob unduhan hilang atau ukurannya tidak
  cocok menurunkan `download_state` ke 0 tanpa menghapus lagu dari library;
  entri cache yatim dihapus; job berstatus mengunduh kembali ke antre.

### 3.7 Lirik, sleep timer, restore antrean

- Lirik lewat LRCLIB langsung dari browser: endpoint `/api/get` (cocok persis
  artis + judul + durasi) lalu fallback `/api/search` bila 404, pilih durasi
  cocok plus minus 2 detik (port P7 APK). Cache di store `lyrics`; penanda
  "tidak ditemukan" disimpan 7 hari supaya app tidak menanyakan lagu yang sama
  berulang-ulang. Hasil "tidak ada" dan instrumental tidak disimpan permanen
  supaya lirik baru tetap bisa ditemukan sesi berikut.
- LRCLIB mengirim `Access-Control-Allow-Origin: *` sehingga fetch langsung
  dari browser berfungsi tanpa proxy (riset §16.3). Batas laju tergantung
  identifikasi client: klien generik sekitar 45 request/menit per IP (angka
  dari pengujian sekunder, belum terverifikasi dari dokumentasi resmi LRCLIB).
  Browser tidak bisa menyetel header `User-Agent`, tetapi LRCLIB juga membaca
  `X-User-Agent`, `Lrclib-Client`, dan `lrclib-app-id`; app mengirim
  pengenal client yang deskriptif.
- Tampilan lirik: tersinkron dengan auto-scroll, jeda 5 detik sesudah pengguna
  menggulir manual; ketuk baris mencari ke timestamp baris itu. Footer
  atribusi LRCLIB persisten. Pemberitahuan satu kali sebelum request lirik
  pertama: layanan luar bisa melihat judul lagu dan alamat internet pengguna.
- Sleep timer: preset 5/10/15/30/45/60 menit + kustom 1-180 menit + mode
  akhir-lagu. Hitung mundur memakai deadline timestamp yang dicek tiap detik
  dan saat tab kembali terlihat (timer `setTimeout` di-throttle browser saat
  tab di latar, sehingga deadline adalah satu-satunya hitungan yang bisa
  diandalkan). Saat habis, volume turun perlahan 10 detik terakhir lalu
  pemutaran dijeda; antrean dan posisi utuh. Opsi akhir-lagu mengunci ke lagu
  yang sedang diputar saat timer dipasang; next atau prev membatalkan timer
  dengan pesan.
- Restore antrean: antrean tersimpan di store `queue_items` (sumber
  kebenaran; pemutar adalah cerminnya), maks 200 item metadata. Simpan dengan
  debounce 500 ms; posisi disimpan tiap 5 detik dan saat jeda. Saat app
  dibuka lagi, mini-player menampilkan lagu terakhir dan putar melanjutkan
  dari posisi tersimpan. Posisi di bawah 10 detik mulai dari awal; posisi
  kurang dari 10 detik dari akhir pindah ke lagu berikut.

### 3.8 Design lock dan token

Design lock owner berlaku penuh di web: canvas hitam murni `#000000`, aksen
putih. Token port PRD §6: surface `#121214`, elevated `#1C1C1E`, teks utama
`#FFFFFF`, sekunder `#A1A1AA`, redup `#8E8E93`. Warna hanya untuk status:
hijau `#34D399` (sukses), kuning `#FBBF24` (peringatan), merah `#F87171`
(error), biru `#60A5FA` (info). `#71717A` dilarang untuk teks (kontras 4,35:1,
di bawah AA). Rasio kontras terverifikasi koordinator APK dengan rumus WCAG:
teks utama 21,0:1, sekunder 8,19:1, redup 6,44:1.

Catatan kejujuran terhadap skill design-taste-frontend: skill itu melarang
`#000000` murni sebagai default dan menganjurkan mode gelap dan terang.
Design lock owner MENANG atas default skill (skill sendiri menyatakan brief
menang; IDENTITY.md §3.1 menyatakan hal yang sama). v1 hanya mode gelap,
port keputusan PRD (k). Mode terang adalah pekerjaan pasca-v1 lewat token
semantik.

- Font sistem (tanpa biaya unduh font); skala 8 token dari 12 sp sampai 24 sp,
  lantai 12 sp untuk semua teks yang menghadap pengguna. Font Didone/Playfair
  dilarang permanen (IDENTITY.md §3.2).
- Grid 4 dp; satu sistem radius; ikon satu keluarga (Phosphor, sesuai urutan
  prioritas skill taste); target sentuh 48 dp; kontras AA; label aksesibilitas
  per kontrol; status tidak pernah hanya warna.
- Navigasi: tab bawah 4 tab (Beranda, Cari, Library, Unduhan) di HP; rail
  navigasi di lebar 840 dp ke atas. Mini-player 64 dp, tidak bisa dihapus
  dengan geser.
- Copy: bahasa sehari-hari, tanpa istilah teknis, tanpa kata "cache" di layar
  ("Ruang untuk lagu yang pernah diputar"), tanpa kata "perpustakaan" (pakai
  "Library"), kata kerja "Periksa" distandarkan. Audit copy manual tiap layar
  (port K14 APK).

### 3.9 Anggaran performa (target terukur)

Target ini adalah target desain, bukan hasil ukur. Target tidak boleh
diturunkan diam-diam bila pengukuran pertama lebih rendah; perubahan target
wajib dicatat dengan alasan.

| Metrik | Target | Cara ukur |
|---|---|---|
| Bundle JS awal (gzip, tanpa solver) | Maks 200 KB | Laporan build Vite; QuickJS-WASM lazy-load terpisah |
| Bundle QuickJS-WASM (gzip) | Diukur di S1, target maks 1,5 MB | Ukur file WASM + JS hasil build spike |
| Total berat muat pertama (gzip) | Maks 500 KB | Lighthouse, throttling 4G |
| LCP | Di bawah 2,5 detik | Lighthouse / Web Vitals, HP kelas menengah |
| TTI / INP | TTI di bawah 3,5 detik; INP di bawah 200 ms | Lighthouse; INP lapangan via PerformanceObserver |
| CLS | Di bawah 0,1 | Lighthouse; ruang dicadangkan untuk gambar dan font |
| TTFB | Di bawah 600 ms | Pengukuran WebPageTest/Lighthouse |
| Waktu sampai bunyi pertama (koneksi baik) | Di bawah 2 detik dari keadaan dingin | Uji 20 lagu, port K3 APK |
| Median resolve | Di bawah 2 detik per lagu | Uji 60 lagu, port K1 APK (median VM 4.049 ms adalah egress-bound; angka perangkat nyata wajib diukur) |
| Library 10.000 lagu | Scroll 60 fps, tanpa OOM | Uji stress port K11 APK, RAM 3 GB |

Cara mencapai target: code-splitting per rute, lazy-load modul solver hanya
saat lagu pertama di-resolve, lazy-load halaman lirik dan EQ, gambar sampul
lazy dengan `decoding="async"`, daftar virtual untuk semua daftar panjang,
Service Worker precache shell saja (bukan seluruh bundle solver), dan audit
`--analyze-size` setara Vite (`rollup-plugin-visualizer`) tiap rilis.

## 4. Backend

### 4.1 Proxy InnerTube (Worker byte-only)

Proxy dipakai HANYA bila spike S2 membuktikan fetch langsung dari browser
ke youtubei dan base.js diblokir CORS. Bila S2 membuktikan direct fetch lolos,
proxy tidak dibangun sama sekali dan arsitektur menjadi lebih sederhana.
Keputusan solver tidak berubah dalam kedua hasil.

Endpoint (satu Worker, rute di bawah path `/api/`):

| Endpoint | Metode | Tujuan | Catatan |
|---|---|---|---|
| `/api/innertube/player` | POST | `https://www.youtube.com/youtubei/v1/player` | Body JSON diteruskan apa adanya; kunci API InnerTube publik ditambahkan server |
| `/api/innertube/search` | POST | `https://www.youtube.com/youtubei/v1/search` | Sama; dipakai juga untuk visitorData segar |
| `/api/innertube/browse` | POST | `https://www.youtube.com/youtubei/v1/browse` | Halaman artis, album, playlist, Jelajah |
| `/api/innertube/next` | POST | `https://www.youtube.com/youtubei/v1/next` | Antrean dan rekomendasi |
| `/api/innertube/suggestions` | POST | `https://music.youtube.com/youtubei/v1/music/get_search_suggestions` | Saran saat mengetik |
| `/api/player-script` | GET | `https://www.youtube.com/s/player/.../base.js` | Query `?hash=`; gerbang hash allowlist SEBELUM fetch (§6) |
| `/api/media` | GET | `*.googlevideo.com` | HANYA untuk unduhan; Range passthrough, streaming, tanpa buffering penuh |

Aturan proxy yang mengikat:

- **Allowlist host tujuan.** Proxy hanya meneruskan ke `www.youtube.com`,
  `music.youtube.com`, dan `*.googlevideo.com`. Host lain ditolak dengan 403.
  Proxy ini bukan proxy terbuka; request dengan host tujuan di luar allowlist
  tidak pernah diteruskan.
- **Allowlist path.** Setiap endpoint hanya memetakan ke satu path InnerTube.
  Client tidak bisa meminta path sembarang lewat parameter.
- **Cap ukuran respons.** JSON youtubei 10 MB, script player 8 MB, config
  remote 4 MB, HTML youtube 4 MB (port `response_limits.dart` APK). Respons
  yang melewati cap dipotong dan request gagal dengan 502. `/api/media`
  memakai streaming dengan cap total 100 MB per request (lagu terpanjang
  yang wajar jauh di bawah angka ini; cap melindungi dari penyalahgunaan).
- **Cap ukuran request.** Body POST maks 1 MB. Body lebih besar ditolak 413.
- **Timeout.** Fetch ke upstream memakai timeout: player/search/browse 30
  detik, base.js 90 detik, media 120 detik dengan watchdog stall 60 detik
  (port timeout APK §11 transfer, disesuaikan: timeout media lebih panjang
  karena unduhan).
- **Rate limit.** Per IP: 60 request/menit untuk endpoint InnerTube, 10
  unduhan/menit untuk `/api/media`. Rate limit disimpan di D1 (bukan KV,
  karena KV tulis hanya 1.000/hari). Melewati batas menjadi 429 dengan header
  `Retry-After`. Retry client memakai backoff 1 detik lalu 2 detik + jitter,
  maks 3 kali, hanya untuk error jaringan, 5xx, dan 429 (port APK).
- **Header CORS.** Proxy membalas `Access-Control-Allow-Origin` hanya untuk
  origin app sendiri (bukan `*`), karena proxy ini adalah milik app dan
  kuotanya dibagi seluruh pengguna. Origin yang diizinkan dicatat di
  konfigurasi Worker, bukan di-hardcode per request.
- **Tanpa log isi.** Worker tidak mencatat body request/response, URL stream,
  atau pengenal pengguna. Log hanya metrik agregat (jumlah request per
  endpoint per jam, jumlah 429/502) untuk memantau kuota.
- **Tanpa eksekusi.** Worker tidak menjalankan JavaScript dari base.js, tidak
  memecahkan cipher, tidak mengubah body selain menambahkan kunci API publik
  dan header yang diperlukan. Pekerjaan CPU per request adalah parsing header
  dan validasi allowlist, jauh di bawah 10 ms.
- **Cache.** Respons base.js di-cache di KV (baca 100 ribu/hari, cukup) dengan
  kunci hash; respons search/browse populer TIDAK di-cache di server pada v1
  (hasil pencarian bersifat personal dan cepat basi). Config remote di-cache
  di KV dengan TTL 6 jam.

**Fallback bila proxy gagal total.** Jalur IFrame Player API resmi YouTube
(Cantio) adalah fallback pemutaran lapis terakhir: tanpa proxy, tanpa EQ,
tanpa kontrol kualitas audio, tanpa offline, tetapi lagu tetap berbunyi.
IFrame tidak pernah menjadi jalur utama karena tidak ada akses byte audio
untuk EQ dan offline. Bila proxy dan IFrame sama-sama tidak bisa dipakai,
app menampilkan pesan jujur dan lagu tersimpan tetap bisa diputar (mode
terdegradasi penuh, port keputusan-solver §7.5).

### 4.2 Config remote

**DIPUTUSKAN: pakai ulang `config-v1` dari repo `adiprmx/laras`.** File yang
sama (`player-config.json`, tag `config-v1`) melayani APK dan web.

Alasan:

1. Data yang dibutuhkan web identik dengan data APK: urutan client
   (WEB_REMIX, MWEB, ANDROID_VR), versi client, allowlist hash player + sts,
   dan videoId kanari. Tidak ada satu pun field yang hanya dibutuhkan satu
   platform.
2. Satu pembaruan memperbaiki kedua platform. Saat YouTube rotasi hash, tim
   menerbitkan satu entri config dan APK serta web sama-sama pulih tanpa rilis.
   Dua file config berarti dua tempat yang bisa basi, dan pengalaman APK
   membuktikan config basi menonaktifkan hash baru (transfer §7.2).
3. Fetch langsung dari browser bisa: `raw.githubusercontent.com` mengirim
   `Access-Control-Allow-Origin: *` (diukur 17 Nov 2026). Config tidak butuh
   proxy.
4. Rantai fallback sumber config port utuh dari APK: aset rilis GitHub dulu,
   lalu tree tag `raw.githubusercontent.com`, lalu cache terakhir yang valid,
   lalu nilai bawaan di kode.

Aturan yang mengikat:

- **Semantik allowlist dipertahankan.** Config remote MENGGANTIKAN builtin,
  bukan digabung (desain APK yang disengaja: config remote adalah control
  plane termasuk pencabutan hash). Web memakai semantik yang sama persis.
- **Jaring pengaman VR di loader.** Loader menjamin daftar client yang dipakai
  selalu membawa minimal satu client bebas-script (ANDROID_VR ditambahkan di
  ujung urutan, hanya di memori, bila config tidak membawanya). Titik choke
  tunggal dipakai semua jalur: pemutaran, unduhan, kanari.
- **Field web-spesifik, bila suatu hari dibutuhkan, ditambahkan sebagai field
  opsional** yang diabaikan parser APK. Skema memakai nomor versi; app menolak
  config dengan versi mayor yang tidak dikenalnya. Field web-spesifik tidak
  pernah mengubah arti field yang sudah ada.
- **TTL refresh normal 6 jam, timeout fetch 5 detik, maks ukuran respons
  4 MB, single-flight, rate limit 5 menit, stale-while-revalidate** (port
  `RemoteConfigLoader` APK). Catatan APK §9.5: timeout 5 detik terbukti
  terlalu agresif di jaringan lambat (satu pengukuran fetch nyata 6,058
  detik); web memakai timeout 10 detik untuk config.
- **Deteksi perubahan membandingkan sidik jari isi**, bukan `fetchedAt` (bug
  P6 APK: refresh selalu menulis `fetchedAt` baru sehingga "sudah terbaru"
  tidak pernah tercapai).

### 4.3 Akun opsional dan sinkronisasi

**Prinsip: login tidak pernah wajib untuk memutar lagu.** Semua fungsi inti
(cari, putar, unduh, lirik, EQ, playlist lokal, antrean) jalan penuh tanpa
akun. Akun hanya membuka sinkronisasi antar perangkat: playlist, favorit,
riwayat putar, dan pengaturan. Pola ini sama dengan mode tamu Cantio.

**DIPUTUSKAN: auth memakai OAuth Google dan GitHub saja, tanpa kata sandi
yang disimpan.** Alasan: tanpa kata sandi berarti tanpa hash kata sandi yang
harus dijaga, tanpa reset kata sandi, tanpa layanan email. Alur OAuth
ditangani Worker (tukar kode di server, bukan di browser) sehingga client
secret tidak pernah menyentuh browser. Sesi memakai token acak 256-bit yang
disimpan sebagai hash SHA-256 di D1, dikirim sebagai cookie `HttpOnly`,
`Secure`, `SameSite=Lax`, dan kedaluwarsa 30 hari. Token tidak pernah disimpan
di localStorage (aturan keamanan §6). Logout menghapus sesi di server dan
cookie di browser.

Skema sync di D1 (tabel server, terpisah dari IndexedDB lokal):

| Tabel | Isi | Batas |
|---|---|---|
| `users` | id, provider, provider_id, display_name, created_at | Satu baris per akun |
| `sessions` | id, user_id, token_hash, expires_at, created_at | Maks 10 sesi aktif per pengguna |
| `sync_playlists` | id, user_id, client_id, nama, deskripsi, updated_at, deleted_at | Maks 100 playlist per pengguna |
| `sync_playlist_items` | playlist_id, video_id, posisi, added_at | Maks 1.000 item per playlist |
| `sync_likes` | user_id, video_id, liked_at, deleted_at | Maks 10.000 per pengguna |
| `sync_history` | user_id, video_id, played_at, seconds_played | Maks 1.000 entri terbaru per pengguna |
| `sync_settings` | user_id, settings_json, updated_at | Satu baris per pengguna, JSON maks 4 KB |

Konflik diselesaikan dengan **last-write-wins per entitas** memakai
`updated_at` (milidetik, dari server, bukan dari jam perangkat) dengan
`device_id` sebagai pemecah seri deterministik. Hapus memakai tombstone
(`deleted_at` terisi, baris dipertahankan 30 hari lalu dibersihkan).
Sinkronisasi memakai tarik inkremental (`since=timestamp`) dan dorong batch
(maks 100 entri per request). Client yang offline lama tetap bisa sinkron
karena yang dikirim hanya perubahan sejak timestamp terakhir, bukan seluruh
data.

Batas yang melindungi kuota D1: satu sinkronisasi penuh dibatasi 100 ribu
baris tulis/hari per akun secara agregat; bila kuota D1 akun mendekati batas,
Worker menolak sync baru dengan 429 dan client menunda sampai besok. Data
lokal tidak pernah hilang karena sync gagal: lokal adalah sumber kebenaran
untuk perangkat itu, server hanya cermin.

**Yang tidak disinkronkan:** file audio unduhan (hanya metadata dan status
unduhan; lagu diunduh ulang di perangkat baru), URL stream (hanya ada di
memori), cache streaming, riwayat pencarian (diputuskan: riwayat pencarian
masuk backup file, bukan sync server, untuk membatasi data yang meninggalkan
perangkat). Backup JSON berversi (port P8 APK) tetap tersedia sebagai jalan
pindah perangkat tanpa akun: ekspor file, pindahkan, impor. Merge, bukan
timpa buta; impor dalam satu transaksi; batas file 10 MB.

## 5. Model data

### 5.1 IndexedDB lokal: port 15 tabel APK

| Store | Kunci | Indeks | Catatan port |
|---|---|---|---|
| `songs` | videoId | album_id, title, artist_id, liked, download_state, unplayable, last_played_at | Tambah kolom `unplayable` (skema v3 APK) |
| `albums` | id | title | |
| `artists` | id | name | Pseudo-id `local-<FNV-1a nama>` port P3 APK |
| `song_artists` | [song_id, artist_id] | artist_id | Penghubung banyak-ke-banyak |
| `album_artists` | [album_id, artist_id] | artist_id | Penghubung banyak-ke-banyak |
| `playlists` | id (auto) | name, updated_at | Kolom description maks 500 karakter |
| `playlist_songs` | [playlist_id, position] | playlist_id, song_id | Urutan lewat position |
| `formats` | [song_id, itag] | song_id | Format audio yang diketahui per lagu |
| `lyrics` | song_id | | Lirik tersinkron (LRC) + polos; tolak simpan lirik di atas 256 KB per kolom (port R3-L1) |
| `play_events` | id (auto) | song_id, played_at | Batas 10.000 entri, hapus tertua otomatis |
| `search_history` | id (auto) | query, searched_at | Batas 100 query, dedup |
| `queue_items` | position | | Antrean, maks 200 item metadata |
| `local_items` | id | | File audio lokal pengguna (v1.1; store disiapkan sejak v1 supaya migrasi tidak pecah) |
| `cache_entries` | videoId | last_played_at, size_estimate | Manifest cache streaming, bukan file JSON |
| `download_jobs` | videoId | status, created_at | Status, byte terunduh, total byte, percobaan |
| `token_index` | token | | Indeks token pencarian lokal (§5.2) |
| `playback_state` | id (selalu 1) | | Posisi pemutar + antrean aktif (port skema v4 APK) |
| `app_meta` | key | | Nilai kecil: status kanari, fetchedAt config, flag onboarding |

Pustaka akses: Dexie (pembungkus IndexedDB bertipe, dirawat aktif) sebagai
pilihan utama; `idb` (pembungkus minimal) sebagai cadangan bila Dexie
terbukti terlalu berat. Versi pasti diverifikasi saat implementasi.
Migrasi memakai nomor versi database dan fungsi migrasi per versi, dengan
pengujian migrasi lompat (v1 ke v3 langsung) port pola drift APK.

### 5.2 Pencarian lokal tanpa FTS5

IndexedDB tidak punya FTS5 seperti SQLite. Pencarian lokal memakai indeks
token yang dirawat sendiri: saat lagu ditulis, judul dan nama artis dipecah
menjadi token (huruf kecil, tanpa tanda baca), dan tiap token memetakan ke
daftar videoId di store `token_index`. Pencarian memecah kueri menjadi token,
mengambil irisan daftar, lalu mengurutkan berdasarkan kecocokan. Token
disimpan per lagu (bukan satu blob global) supaya penulisan dan penghapusan
bersifat lokal. Alternatif wa-sqlite (SQLite WASM dengan FTS5) dicatat
sebagai cadangan bila indeks token terbukti tidak cukup; wa-sqlite menambah
sekitar 1 MB bundle dan kompleksitas worker, sehingga bukan pilihan pertama.

### 5.3 Database server (D1)

Skema D1 adalah skema sync §4.3, bukan cermin penuh IndexedDB lokal. Server
tidak menyimpan katalog lagu, lirik, atau file audio. Server menyimpan hanya
data sinkronisasi milik pengguna yang memilih membuat akun. Indeks wajib di
semua kolom filter (`user_id`, `updated_at`, `playlist_id`) karena D1
menghitung baris yang dipindai, bukan baris yang dikembalikan (§2.1).

### 5.4 Sembilan aturan anti-OOM versi web (port §4.6 APK)

1. localStorage hanya nilai primitif kecil. Batas keras: tidak ada satu nilai
   pun di atas 1 KB, total seluruh localStorage di bawah 100 KB. Daftar objek,
   antrean, riwayat, dan cache tidak pernah masuk ke sini.
2. Semua koleksi masuk IndexedDB. Antrean adalah store `queue_items`, riwayat
   adalah `play_events`, pencarian adalah `search_history`. IndexedDB membaca
   per rentang lewat indeks, tidak pernah memuat seluruh store ke memori.
3. Gambar tidak pernah disimpan sebagai data di database. Thumbnail disimpan
   sebagai file di Cache Storage, database hanya menyimpan URL. Blob audio
   adalah pengecualian yang disengaja (audio harus bisa diputar offline) dan
   dibatasi oleh batas cache serta pemeriksaan ruang.
4. Semua query daftar memakai batas dan pagination. Standar halaman 50 item.
   Tidak ada query yang memuat seluruh library ke memori. Daftar virtual di UI.
5. Tidak ada JSON blob besar di kolom database. Kolom JSON hanya struktur kecil
   yang tidak perlu di-query, dibatasi 4 KB per baris. Bila datanya perlu
   di-query atau bisa tumbuh, buat store sendiri.
6. Manifest cache adalah store `cache_entries`, bukan file JSON. File JSON
   manifest tumbuh tanpa batas dan harus dibaca penuh setiap kali dibuka.
7. Batas ukuran di semua koleksi yang tumbuh otomatis, ditegakkan kode:
   riwayat putar 10.000 entri, riwayat pencarian 100 query, log internal
   1 MB dengan rotasi, antrean 200 item, playlist 1.000 lagu.
8. Pengujian regresi: uji otomatis mengisi database dengan 10.000 lagu, 1.000
   entri riwayat, dan antrean 500 lagu, lalu mengukur memori saat membuka
   library (port K11 APK). Ambang memori diputuskan setelah pengukuran
   pertama di perangkat nyata, bukan ditebak di sini.
9. Jangan meniru pola "baca seluruh file lalu parse" untuk data apa pun yang
   bisa tumbuh. Impor backup memakai streaming parser bila file mendekati
   batas 10 MB.

## 6. Keamanan

Port pelajaran APK (§6 arsitektur APK, transfer §11) ditambah ancaman khas
web. Daftar ini adalah checklist yang wajib lolos di tiap ronde Red.

### 6.1 Port kontrol APK

- **Allowlist URL stream.** Skema wajib HTTPS, tanpa userinfo, host
  `googlevideo.com` atau subdomainnya. Host lain (termasuk youtube.com)
  ditolak sebagai URL stream. Thumbnail: `*.ytimg.com`,
  `*.googleusercontent.com`, `*.ggpht.com`. Semua jalur yang menerima URL
  dari respons InnerTube atau solver wajib lewat allowlist sebelum dipakai,
  termasuk jalur langsung ANDROID_VR (celah R1-M1/R2-M1 APK: jalur langsung
  sempat lolos tanpa validasi).
- **Cap ukuran respons.** JSON youtubei 10 MB, script player 8 MB, config
  remote 4 MB, HTML youtube 4 MB, lirik 1 MB. Parser dibatasi 100 item per
  respons. Unduhan dibatasi 1 GB + margin 1 MB dengan rumus `min(...)`, bukan
  `max(...)` (rumus max adalah bug yang ditemukan Blue 2 APK).
- **Timeout semua fetch.** Connect 10 detik, player/search 30 detik, HTML
  60 detik, base.js 90 detik, config 10 detik (port APK dengan penyesuaian
  §4.2), solver 10 detik, kanari 90 detik, watchdog stall unduhan 60 detik.
  Timeout ditegakkan lewat AbortController; tidak ada fetch tanpa sinyal
  abort.
- **Retry maks 3 kali**, backoff 1 detik lalu 2 detik + jitter, hanya untuk
  error jaringan, 5xx, dan 429. Tidak ada retry tanpa batas.
- **Tanpa eval di luar jalur solver yang dibatasi.** Satu-satunya eksekusi
  kode dinamis adalah base.js di dalam QuickJS-WASM di Web Worker khusus,
  dengan gerbang hash allowlist SEBELUM unduh, batas memori 192 MiB, timeout
  10 detik, eksekusi serial, tanpa callback host, tanpa fetch dari dalam JS.
  CSP halaman tidak mengandung `unsafe-eval`.
- **Tanpa secret di client.** Kunci API InnerTube adalah kunci publik yang
  tertanam di halaman youtube.com (keputusan K-F2-10 APK), bukan secret.
  Client secret OAuth tidak pernah ada di bundle; penukaran kode OAuth
  terjadi di Worker.
- **Sanitasi nama file.** Nama file unduhan memakai videoId
  (`<videoId>.<ekstensi>`), bukan judul lagu, untuk mencegah path traversal
  lewat metadata (skenario S6 APK).
- **Tanpa logging data sensitif.** Tidak ada log berisi URL stream lengkap,
  isi respons InnerTube mentah, token, cookie, atau isi database. Log
  internal maks 1 MB dengan rotasi, semua URL http(s) disensor.
- **Validasi respons.** Semua respons JSON divalidasi tipe dan nullability
  sebelum dipakai. Parsing defensif: satu kelompok hasil yang gagal parse
  tidak mengosongkan kelompok lain.
- **Dependensi.** Lockfile di-commit; tidak ada dependensi tanpa versi yang
  dipin; audit kerentanan (`npm audit` atau pemindai setara) di CI tiap
  rilis; dependensi baru melewati checklist kurasi dan dicatat di
  `docs/dependencies.md`.

### 6.2 Ancaman khas web

- **XSS.** React meng-escape output secara default. `dangerouslySetInnerHTML`
  dilarang untuk data apa pun yang berasal dari jaringan (judul lagu, nama
  artis, lirik, deskripsi playlist). Lirik ditampilkan sebagai teks, bukan
  HTML. Tidak ada template string yang membangun HTML dari metadata.
- **Content Security Policy.** Header CSP dari Pages/Worker:
  `default-src 'self'`; `script-src 'self'` (tanpa `unsafe-eval` dan tanpa
  `unsafe-inline`); `connect-src 'self'` + origin Worker + `lrclib.net` +
  `raw.githubusercontent.com`; `img-src 'self'` + `*.ytimg.com` +
  `*.googleusercontent.com` + `*.ggpht.com` + `blob:` + `data:`;
  `media-src 'self'` + `*.googlevideo.com` + `blob:`; `worker-src 'self'`;
  `frame-src` hanya untuk IFrame fallback YouTube (`*.youtube.com`) bila
  fallback diaktifkan; `object-src 'none'`; `base-uri 'self'`;
  `form-action 'self'`. Nilai pastinya ditulis tim Blue saat implementasi
  dan diuji dengan pelanggaran CSP yang dilaporkan, bukan ditebak di sini.
- **CSRF.** Sesi memakai cookie `SameSite=Lax` dan semua endpoint yang
  mengubah state memeriksa header `Origin` terhadap allowlist origin app.
  Tidak ada endpoint pengubah state yang memakai GET.
- **Token storage.** Token sesi hanya di cookie `HttpOnly`, `Secure`,
  `SameSite=Lax`. Token tidak pernah di localStorage, sessionStorage, atau
  IndexedDB. Token OAuth sementara tidak pernah ditulis ke log.
- **Clickjacking dan framing.** Header `X-Frame-Options: DENY` dan
  `frame-ancestors 'none'` di CSP untuk semua halaman app (pengecualian
  hanya komponen IFrame fallback yang memang membingkai YouTube, bukan
  halaman app yang dibingkai pihak lain).
- **Service Worker.** Service Worker hanya mencegat request ke origin app
  dan ke googlevideo untuk cache media. SW tidak mengubah respons InnerTube
  dan tidak menyuntikkan script. Update SW memakai strategi skip-waiting
  dengan pemberitahuan ke pengguna, bukan update diam-diam yang mengubah
  perilaku pemutaran di tengah lagu.
- **Deep link dan parameter URL.** Semua parameter URL (videoId, playlistId,
  kueri) divalidasi bentuknya sebelum dipakai. videoId wajib 11 karakter
  dari alfabet yang diizinkan YouTube. Parameter yang tidak valid menampilkan
  halaman kosong yang jujur, bukan error mentah.
- **Informasi perangkat.** App tidak mengumpulkan sidik jari perangkat, tidak
  mengirim pengenal perangkat ke pihak ketiga, dan request lirik hanya
  membawa artis/judul/durasi tanpa pengenal pengguna.

### 6.3 Threat model ringkas (port APK §6.2)

Aset: sesi akun (bila login ada, nilai sedang; tanpa login tidak ada aset
ini); database lokal berisi playlist, riwayat dengar, riwayat cari (sedang,
profil selera); file audio unduhan dan cache (rendah, konten publik yang
bisa diunduh ulang); signing dan kredensial deploy (tinggi, di luar perangkat
pengguna, di tangan owner). Penyerang yang dimodelkan: penyerang jaringan
(WiFi publik, ISP nakal); situs lain yang mencoba mencuri sesi (CSRF/XSS);
pembuat situs tiruan (phishing); penyerang supply chain (paket npm yang
diretas, typosquat); Google/YouTube sebagai pengendali server (pemutusan
layanan). Yang tidak masuk threat model: penyerang dengan akses penuh ke
perangkat korban dan waktu tak terbatas (tidak ada pertahanan client-side
yang menang melawan itu), dan serangan terhadap infrastruktur Google sendiri.

### 6.4 Siklus Red, Blue, Red

Port siklus APK §6.1 butir 5, disesuaikan untuk web: Red Team (A19) menyerang
memakai OWASP ASVS (aplikasi web) dan WSTG, Blue Team (A18) memperbaiki,
Purple Team (A20) memvalidasi perbaikan, Red menyerang lagi. Ronde terikat
milestone: Red 1 sesudah cari/streaming jalan, Red 2 sesudah unduhan/solver,
Red 3 di release candidate. Berhenti di nol temuan kritis/tinggi/sedang, maks
5 ronde. Setiap perbaikan disertai tes regresi yang gagal sebelum perbaikan
dan lolos sesudahnya (port aturan APK §6.4 butir 23).

## 7. Matriks offline-first (port tabel APK §5.6)

| Fungsi | Tanpa internet | Keterangan web |
|---|---|---|
| Putar lagu yang diunduh | Jalan | Blob IndexedDB, tanpa jaringan sama sekali |
| Putar lagu dari cache streaming | Jalan | Selama entri cache masih ada (bila S6 lolos) |
| Browsing library lokal | Jalan | Semua data dari IndexedDB |
| Pencarian di library lokal | Jalan | Indeks token lokal |
| Playlist, favorit, riwayat | Jalan | Semua lokal |
| Antrean pemutaran | Jalan | Antrean disimpan lokal |
| Pengaturan | Jalan | Semua lokal |
| Shell aplikasi (buka app) | Jalan | Service Worker precache; PWA terinstal terbuka tanpa internet |
| Solver untuk hash yang dikenal | Jalan | QuickJS-WASM + base.js ter-cache; resolve tetap butuh jaringan untuk request player |
| Pencarian YouTube Music baru | Tidak jalan | Pesan jelas + tombol coba lagi |
| Streaming lagu yang belum di-cache | Tidak jalan | Pesan jelas ("Lagu ini butuh internet. Unduh dulu supaya bisa didengar offline." + tombol "Unduh") |
| Ambil metadata/sampul baru | Tidak jalan | Placeholder, metadata lama tetap tampil |
| Unduh lagu baru | Tidak jalan | Masuk antrean unduhan, jalan otomatis saat online |
| Rak jaringan ("Jelajah") | Tidak jalan | Pesan "Bagian jelajah butuh internet." tanpa tombol coba lagi yang tidak berfungsi |
| Saran pencarian jaringan | Tidak jalan | Diganti saran dari riwayat lokal |
| Refresh config | Tidak jalan | Pakai cache config terakhir yang valid |
| Sinkronisasi akun | Tidak jalan | Perubahan lokal diantrekan, dikirim saat online |

Aturan tambahan: jangan blokir UI menunggu jaringan (layar library tampil
dari database lokal dulu; data jaringan memperbarui tampilan belakangan;
tidak ada layar yang menampilkan loading penuh hanya karena jaringan lambat).
App mendengarkan perubahan status koneksi (`online`/`offline` + Network
Information API bila tersedia) dan menampilkan indikator "Kamu sedang offline"
yang jelas. Tombol yang butuh jaringan tetap bisa diketuk dan menjelaskan
keadaannya, bukan tombol mati tanpa penjelasan.

## 8. Spike wajib sebelum komitmen penuh

S1 sampai S4 berasal dari `keputusan-solver.md` §8 dan mengikat. S5 sampai
S10 ditambahkan dokumen ini. Tiap spike punya kriteria lolos yang bisa diuji,
bukan perasaan. Bila satu spike gagal, jalur cadangan yang tercantum dipakai
dengan bukti, bukan dengan pendapat.

| # | Spike | Kriteria lolos | Bila gagal |
|---|---|---|---|
| S1 | QuickJS-WASM di Web Worker: muat base.js asli ketiga hash (fad7e4e9, ad8d59ae, b559f50c), jalankan driver solver port dari APK | Solve lolos untuk ketiga hash; ukur median solve + ukuran bundle WASM + memori puncak | Fallback lapis 1 keputusan-solver §7: eval langsung di Web Worker khusus |
| S2 | Direct fetch dari origin browser ke youtubei (POST player) dan base.js (GET) | Vonis CORS final: bila diblokir, bangun Worker proxy byte-only; bila lolos, tanpa proxy sama sekali | Tidak ada kegagalan; hasil apapun adalah keputusan |
| S3 | Pemutaran `<audio>` dari URL googlevideo hasil resolve + Media Session | Lagu berbunyi sampai habis di browser desktop + HP; ukur waktu sampai bunyi pertama; uji re-resolve di tengah lagu | Bila lagu tidak pernah berbunyi penuh, selidiki batas googlevideo di IP residensial sebelum lanjut |
| S4 | Port `buildPlayerScript` + kolektor transitif + `_extractUrlInfo` ke TypeScript, diuji terhadap ketiga base.js asli + fixture tes APK | Semua tes unit port lolos (termasuk kasus Vm, helper builtin String, delimiter tabel `;` vs `{`, kelas URL tf/bs/JH) | Perbaiki port sampai lolos; tidak ada jalan pintas karena solver adalah inti produk |
| S5 | Web Audio CORS: `createMediaElementSource` pada URL googlevideo + deteksi runtime | Vonis: EQ aktif untuk streaming bila CORS terbuka; bila tertutup, EQ hanya untuk audio lokal/cache dengan pesan jujur | Jalur tanpa graph untuk streaming (§3.4); tanpa proxy audio di v1 |
| S6 | Service Worker cache media opaque + Range slicing dari Cache Storage | Lagu yang sudah diputar sekali bisa diputar offline dari cache; seek bekerja dari cache; estimasi ukuran tercatat | v1 hanya unduhan eksplisit; cache otomatis pindah ke v1.1 |
| S7 | Worker proxy byte-only: Range passthrough, cap, rate limit, CPU terukur | Proxy melayani player/search/base.js/unduhan; CPU per request terukur di bawah 10 ms; cap dan rate limit terbukti menolak | Bila CPU melewati 10 ms, sederhanakan proxy (hapus validasi berat, pindah ke Vercel cadangan) |
| S8 | Sync D1 end-to-end: OAuth, sesi cookie, tarik/dorong inkremental, konflik | Dua perangkat sinkron playlist/favorit/riwayat; konflik last-write-wins terbukti; tombstone hapus terbukti | Sync pindah ke pasca-v1; backup JSON tetap menjadi jalan pindah perangkat |
| S9 | PWA install + audio latar di Android Chrome dan iOS Safari | PWA terinstal; audio tetap berbunyi saat layar terkunci; MediaSession tampil di lock screen | Dokumentasikan batasan per browser; iOS adalah platform paling berisiko (kebijakan audio latar Safari) |
| S10 | LRCLIB dari browser: rate limit + header pengenal client | 50 request lirik berurutan tanpa 429; header `X-User-Agent`/`Lrclib-Client` diterima | Cache lebih agresif + fallback lyrics.ovh (lirik polos, CORS `*`) |

## 9. Yang sengaja tidak masuk v1

Port daftar APK §8 dengan penyesuaian web. Tiap butir punya alasan yang
tercatat; menambahkan satu butir ke v1 butuh keputusan eksplisit dengan alasan
baru.

- Login YouTube Music (tanpa OAuth ke Google untuk YouTube; menunda berarti
  tanpa cookie sesi akun Google di perangkat).
- Minting poToken / BotGuard (pekerjaan besar dan rapuh; hindari client yang
  membutuhkannya selama masih ada client yang tidak).
- Client SABR (protobuf + UMP; v1 menolak format SABR, bukan memutarnya).
- Unduhan video (app ini audio saja).
- Normalisasi volume antar lagu berbasis ReplayGain/EBU R128 (kompresor
  DynamicsCompressor adalah perataan dinamis, bukan normalisasi antar lagu,
  dan tidak boleh dilabeli normalisasi).
- API Spotify dalam bentuk apa pun (permanen, bukan penundaan; preseden
  cease-and-desist ke Spotube 2025).
- Akun wajib, telemetri, iklan, dan pembayaran (batas proyek: Rp0, tanpa
  server berbayar; akun hanya opsional untuk sync).
- Solver di server (dilarang platform Workers dan tidak layak CPU; keputusan
  mengikat `keputusan-solver.md`).
- Proxy audio untuk streaming (hanya unduhan yang lewat proxy; streaming
  langsung dari googlevideo ke elemen audio).
- IFrame Player API sebagai jalur utama (hanya fallback bila proxy gagal
  total; IFrame tidak memberi EQ dan offline).
- Pemutar file audio lokal sebagai fitur wajib v1 (store `local_items`
  disiapkan; fitur masuk v1.1 mengikuti APK).
- Notifikasi push dan widget layar beranda (butuh layanan push dan kode
  native; bukan janji v1).
- Fitur sosial (playlist kolaboratif, Blends, komentar, mengikuti pengguna).
- Statistik dengar dan rekomendasi berbasis server (rekomendasi v1 memakai
  rumus lokal dari riwayat dengar di perangkat).
- Enkripsi database lokal (tidak wajib sampai pemicu APK terpenuhi: login
  masuk, owner menilai profil selera sensitif, atau regulasi mewajibkan).
  Catatan: sync server memakai TLS dan cookie HttpOnly; itu bukan enkripsi
  database.
- Certificate pinning ke YouTube/Google (dilarang; Google merotasi kunci
  tanpa pemberitahuan).
- Dukungan browser sangat tua (target browser modern dengan WASM, Web Worker,
  IndexedDB, dan Service Worker; browser tanpa WASM menampilkan pesan jujur).

## 10. Kriteria sukses v1 (port K1-K15 APK)

| ID | Kriteria | Target | Cara ukur |
|----|----------|--------|-----------|
| W1 | Kecepatan resolve | Median di bawah 2 detik per lagu | Uji 60 lagu, hitung median waktu resolve |
| W2 | Muat pertama | LCP di bawah 2,5 detik, TTI di bawah 3,5 detik | Lighthouse, HP kelas menengah, throttling 4G |
| W3 | Pemutaran pertama | Di bawah 2 detik di koneksi baik | Uji 20 lagu dari keadaan dingin |
| W4 | Ukuran bundle awal | Maks 200 KB gzip (tanpa solver) | Laporan build Vite |
| W5 | Keberhasilan pemutaran | 57 dari 60 lagu berhasil (95 persen) | Uji 60 lagu, 20 lagu per hari selama 3 hari |
| W6 | Fallback antar client | 10 dari 10 tanpa error terlihat | Matikan client utama di config, 10 lagu tetap jalan |
| W7 | Config remote | Dipakai dalam 6 jam | Ubah entri di tag config-v1, web mengambil dalam TTL tanpa deploy ulang |
| W8 | Offline penuh | 10 lagu mode pesawat | Unduh 10 lagu, aktifkan mode pesawat, putar semuanya |
| W9 | Cache tidak menghapus unduhan | 0 unduhan terhapus oleh eviction | Isi cache sampai batas, periksa semua unduhan masih ada |
| W10 | Antrean persisten | Antrean utuh setelah restart | Buat antrean 50 lagu, tutup paksa tab/browser, buka lagi, antrean sama |
| W11 | Ketahanan memori | 10.000 lagu, 1.000 entri riwayat, antrean 500, tanpa OOM | Uji stress di RAM 3 GB |
| W12 | Keamanan | Nol temuan kritis, tinggi, dan sedang | Siklus Red-Blue-Red, maks 5 ronde |
| W13 | Kualitas kode | Linter tanpa warning; tes jalur resolve, fallback, unduhan, migrasi lolos | CI GitHub Actions |
| W14 | Copy bahasa sehari-hari | 0 istilah teknis di teks layar | Audit copy manual tiap layar |
| W15 | Distribusi dan dokumen | README, PRIVACY_POLICY.md, CHANGELOG, rilis GitHub dengan checksum | Periksa satu per satu sebelum rilis |

## 11. Risiko dan yang belum terverifikasi

- **Batas 1 MiB googlevideo di IP residensial.** Dari VM (IP datacenter),
  googlevideo membatasi tepat 1 MiB per URL lalu 403. Hanya uji perangkat
  dengan IP residensial yang bisa memutuskan apakah batas ini berlaku untuk
  pengguna. Bila berlaku, re-resolve tengah lagu (§3.3) adalah kebutuhan,
  bukan hiasan.
- **CORS googlevideo untuk Web Audio (S5).** Belum terverifikasi; menentukan
  apakah EQ bekerja untuk streaming atau hanya audio lokal/cache.
- **Cache media opaque (S6).** Pola Service Worker + Range slicing belum
  dibuktikan untuk app ini; bila gagal, cache otomatis pindah ke v1.1.
- **Batas Pages Free.** Angka 500 build/bulan dan 20.000 file per situs
  berasal dari sumber sekunder dan belum diverifikasi dari halaman resmi.
- **Batas 2 proyek Supabase lintas organisasi.** Klaim sumber sekunder yang
  belum diverifikasi dari dokumen billing resmi; menentukan apakah cadangan
  Vercel + Supabase benar-benar tersedia.
- **Angka Vercel Hobby terbaru.** Sumber saling bertentangan (10 detik vs
  300 detik durasi maks); angka terbaru belum diverifikasi langsung dari
  halaman limits resmi.
- **Rate limit LRCLIB.** Angka 45 request/menit berasal dari pengujian
  sekunder, belum terverifikasi dari dokumentasi resmi LRCLIB.
- **Nama paket QuickJS-WASM.** `quickjs-emscripten` adalah kandidat yang
  dikenal, bukan keputusan final; spike S1 memutuskan paket dan versi
  pastinya setelah verifikasi.
- **Versi pasti dependensi frontend.** React, Vite, Tailwind, Zustand,
  vite-plugin-pwa, Dexie, dan React Router: versi pastinya diverifikasi
  saat implementasi dari npm, bukan ditebak di sini. Angka dari README
  Musike (React 19, Vite 8, Tailwind 4) adalah bukti stack ini dipakai
  kompetitor, bukan pin versi untuk Laras Web.
- **Nama repo dan domain.** Repo web diusulkan `adiprmx/laras-web` dan domain
  diusulkan subdomain `adipmusic.my.id`; keduanya **USULAN** dan diputuskan
  koordinator bersama owner, bukan diputuskan dokumen ini.
- **Audio latar iOS Safari.** Kebijakan audio latar dan PWA di iOS adalah
  yang paling berisiko di antara platform target; spike S9 yang memutuskan
  batasannya.
- **Perubahan YouTube.** Rotasi hash player, perubahan format base.js, dan
  perubahan perilaku client adalah kejadian rutin, bukan pengecualian.
  Seluruh desain ketahanan (config remote, kanari, fallback client, mode
  terdegradasi) ada karena risiko ini.

## 12. Checklist 7 skill anti-slop

Dokumen ini ditulis dengan ketujuh skill anti-slop owner dibaca terlebih
dulu. Checklist per skill di bawah ini mencatat apa yang diterapkan dan apa
yang sengaja tidak dipakai beserta alasannya. Aturan permanen owner: ketujuh
skill wajib dipakai di setiap kerjaan desain dan writing yang relevan.

### local-design-taste-frontend

- [x] Design read satu baris ditulis sebelum keputusan desain (§3.1).
- [x] Dials DESIGN_VARIANCE / MOTION_INTENSITY / VISUAL_DENSITY ditetapkan
  (5/3/5) dengan alasan: aplikasi Operate harian, bukan landing page.
- [x] Satu palet dikunci (monokrom + status fungsional), tanpa gradasi
  dekoratif dan tanpa aksen ungu/biru AI.
- [x] Empat state visual diwajibkan tiap layar (skeleton, empty state jujur,
  error dengan tombol coba lagi, offline).
- [x] Angka palsu dilarang: semua angka berasal dari sumber yang dibaca atau
  dilabeli belum terverifikasi.
- [ ] Aturan "tanpa `#000000` murni" dan "desain untuk dua mode" TIDAK dipakai:
  design lock owner (hitam murni + mode gelap saja di v1) menang atas default
  skill. Alasan tercatat di §3.8.
- [ ] Sebagian besar aturan hero/landing (padding hero, eyebrow, bento,
  marquee) tidak relevan: dokumen ini adalah arsitektur aplikasi, bukan
  landing page. Aturan yang dipakai adalah yang kontekstual.

### local-impeccable

- [x] Brief menang: design lock owner dan keputusan solver yang mengikat
  dipertahankan walau bertabrakan dengan default skill.
- [x] Mode Operate dipilih untuk permukaan app (bukan Persuade): scanability,
  konsistensi, dan ekspektasi native didahulukan atas ekspresi.
- [x] Keputusan dicatat dengan alasan "mengapa", bukan hanya "apa", di
  setiap bagian keputusan.
- [ ] Launcher `impeccable context` tidak dijalankan: dokumen ini adalah
  arsitektur, bukan permukaan UI yang dibangun; tidak ada PRODUCT.md atau
  DESIGN.md web yang bisa dimuat. Konteks proyek dibaca langsung dari
  dokumen Fase 1 yang tercantum di kepala dokumen.

### local-humanizer

- [x] Tanpa kontras "bukan X tetapi Y" sebagai hiasan; kontras hanya dipakai
  bila kedua belah pihak membawa informasi (mis. perbandingan opsi backend).
- [x] Tanpa kalimat penutup dramatis satu baris dan tanpa fragmen dramatis.
- [x] Tanpa kata-kata daftar §12 (delve, robust, pivotal, landscape, dan
  kawan-kawan) di teks dokumen.
- [x] Tanpa em dash di seluruh dokumen; hubungan antar klausa memakai koma,
  titik, atau tanda kurung.
- [x] Bold dipakai hemat, hanya untuk label keputusan (DIPUTUSKAN, USULAN)
  dan nama bagian yang dirujuk, bukan sebagai dekorasi tiap item.
- [x] Judul memakai sentence case, tanpa emoji dan tanpa dekorasi.

### local-stop-slop

- [x] Tanpa pembuka throat-clearing ("mari kita bahas", "berikut adalah").
  Setiap bagian langsung masuk ke isi.
- [x] Kalimat pasif dihindari sebisa mungkin; pelaku ditulis jelas (tim,
  app, Worker, browser).
- [x] Spesifik: setiap klaim menyebut angka, nama file, atau URL sumbernya.
- [x] Tanpa klaim ekstrem yang malas ("selalu", "tidak pernah") kecuali
  sebagai aturan yang memang absolut dan ditegakkan kode.
- [x] Ritme bervariasi: tabel untuk perbandingan, paragraf pendek untuk
  alasan, daftar hanya bila itemnya benar-benar daftar.

### local-no-ai-slop

- [x] Uji portabilitas: kalimat generik yang bisa pindah ke proyek lain
  tanpa berubah dihapus atau diganti fakta spesifik Laras (hash player,
  nama client, angka kuota).
- [x] Tanpa bahasa penjualan (groundbreaking, stunning, revolusioner) dan
  tanpa klaim pentingnya sesuatu tanpa bukti.
- [x] Tanpa atribusi kabur ("para ahli sepakat"); setiap klaim menyebut
  sumbernya atau dilabeli belum terverifikasi.
- [x] Tanpa akhiran rangkuman ("kesimpulannya"); dokumen berakhir di
  daftar sumber.
- [x] Istilah yang sama dipakai konsisten (proxy, resolve, config remote),
  tanpa rotasi sinonim demi gaya.

### local-avoid-ai-writing

- [x] Audit pola P0: tanpa disclaimer cutoff, tanpa artefak chatbot, tanpa
  atribusi kabur tanpa sumber, tanpa inflasi signifikansi.
- [x] Audit pola P1: tanpa kata daftar terlarang, tanpa pembuka "mari",
  tanpa bold berlebihan, tanpa penutup narasi masa depan yang generik.
- [x] Angka, nama, dan tanggal hanya dari sumber yang dibaca; kekosongan
  data ditulis "belum terverifikasi", bukan diisi tebakan.
- [x] Kutipan, nama file, URL, dan pengenal teknis dipertahankan apa adanya
  sebagai konten yang dilindungi.

### local-anti-slop (rulebook inti + sub-skill UI/copy)

- [x] Mode: during (aturan diterapkan saat menulis, bukan diaudit sesudahnya).
- [x] C-1 intentionality: setiap elemen arsitektur punya alasan tertulis
  (proxy, KV, D1, setiap store IndexedDB).
- [x] C-2 functional completeness: keempat state tiap layar dan seluruh
  matriks offline-first ditulis, bukan hanya jalur sukses.
- [x] C-3 content-driven composition: layout dokumen mengikuti isi
  (perbandingan di tabel, alasan di paragraf), bukan template baku.
- [x] C-4 resilience: batas terkecil (HP RAM 3 GB, jaringan lambat, kuota
  habis, YouTube berubah) ditulis sebagai kasus yang dirancang, bukan
  catatan kaki.
- [x] C-5 evidence over claims: tidak ada angka karangan, tidak ada klaim
  yang tidak bisa dibuktikan; yang belum terbukti masuk §11.
- [x] R-31: setiap keputusan punya alasan tertulis. R-35: verifikasi sebelum
  klaim (spike S1-S10 adalah gerbang verifikasi sebelum komitmen penuh).
- [ ] Arah desain (DESIGN.md) web belum ada sebagai file terpisah; arah yang
  dipakai dokumen ini adalah design lock owner + token APK yang sudah
  diputuskan. Tim A2 (Komponen UI dan Design System Web) menulis DESIGN.md
  web di paket berikutnya.

## Daftar sumber

Dokumen internal (dibaca langsung):

- `~/workspace/music-app-web/docs/riset-kompetitor-web.md` (17 Nov 2026)
- `~/workspace/music-app-web/docs/transfer-ekstraktor.md` (17 Nov 2026)
- `~/workspace/music-app-web/docs/keputusan-solver.md` (17 Nov 2026)
- `~/workspace/music-app/docs/arsitektur.md` (15-17 Nov 2026)
- `~/workspace/music-app/docs/prd-v1.md` (15 Nov 2026)
- `~/workspace/music-app-web/docs/roster-tim.md` (17 Nov 2026)

Dokumentasi resmi (dibuka atau dikutip langsung):

- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/workers/platform/limits/index.md
- https://supabase.com/pricing (via sumber sekunder di bawah)
- https://firebase.google.com/pricing (via sumber sekunder di bawah)
- https://lrclib.net/docs

Sumber sekunder untuk batas free-tier:

- https://toolfreebie.com/cloudflare-free-tier-limits/
- https://www.qaupot.com/posts/2b234af97b2c4fa39fc26e2697f353ec/
- https://www.cloudsoftzone.com/blog/cloudflare-review-free-pro-workers-2026
- https://billiem.uk/posts/supabase-free-tier-limits/
- https://makerkit.dev/blog/saas/supabase-pricing
- https://aiagencyplus.com/supabase-free-tier-limits/
- https://www.natecue.com/en/learn/tech/serverless-functions-explained/
- https://supadrop.host/blog/vercel-pricing-free-tier-limits/
- https://magora-systems.com/firebase-pricing/
- https://www.lilachbullock.com/is-firebase-free/
- https://procurementvms.com/vendors/firebase-pricing-guide.html

Referensi kompetitor (dari riset-kompetitor-web.md):

- https://github.com/Ernani1234/musike
- https://github.com/akshay-k-a-dev/cantio/blob/HEAD/README.md
- https://github.com/srivatsan2007/vibentra/blob/HEAD/README.md
