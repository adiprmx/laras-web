# P7 — Fitur Should: Lirik, EQ, Timer Tidur, Sinkronisasi Opsional

Laporan tim P7, 19 Nov 2026. Repo `adiprmx/laras-web`, workdir
`~/workspace/music-app-web/`. Tim P7 tidak push dan tidak deploy —
koordinator yang push + deploy sesudah verifikasi.

## Ringkasan

Keempat fitur Should dari `docs/rencana-fase-2.md` §P7 selesai
dibangun dan terverifikasi di workdir:

| Fitur | Status |
| ----- | ------ |
| 1. Lirik tersinkron (LRCLIB) | Selesai + terverifikasi |
| 2. EQ 10 band (lokal saja) | Selesai + terverifikasi |
| 3. Timer tidur | Selesai + terverifikasi |
| 4. Sinkronisasi opsional (OAuth + D1) | Selesai kecuali uji masuk live — **menunggu langkah owner** (aplikasi OAuth belum dibuat; lihat §Utang) |

Angka verifikasi (semua diukur tim P7 di workdir, 19 Nov 2026):

- **Vitest: 587/587, 43 file** (baseline 478/478, 34 file; +109 tes
  baru P7, +9 file).
- **TypeScript: 0 error** (`tsc -p tsconfig.app.json --noEmit` +
  `tsc -p tsconfig.node.json --noEmit`).
- **ESLint: bersih** (0 error, 0 warning).
- **E2E Playwright `p7.spec.ts`: 7/7 chromium + 7/7 mobile
  (Pixel 7)**. Regresi `player.spec.ts`: 9/9 chromium (+1 live
  skip yang memang butuh browser di luar VM).
- **Screenshot: 4/4** (`p7-screenshots.spec.ts`), 8 file di
  `docs/p7/`, sudah diperiksa visual oleh tim P7.
- **Bundle awal: 175.509 byte gzip** (batas 204.800; naik 5.897
  dari 169.612 pasca-Blue 2). **0 chunk `*TestPage*` di dist.**
- CSP `connect-src` sudah memuat `https://lrclib.net`,
  `https://api.lyrics.ovh`, dan Worker sync (menutup utang Blue 1).

## 1. Lirik tersinkron (LRCLIB)

### Yang dibangun

- Panel lirik di layar pemutar penuh (tombol "Lirik"): baris
  tersinkron dengan sorot baris aktif (latar putih, teks hitam),
  ketuk baris untuk melompat ke waktunya, gulir otomatis yang
  berhenti 5 detik sesudah pengguna menggulir manual, hormat
  `prefers-reduced-motion`.
- Jalur fetch (`app/src/lyrics/lrclib.ts`, mengikuti spike S10):
  `/api/get` dulu (median 17.754 byte), fallback `/api/search`
  (pilih hasil dengan durasi ±2 detik), fallback kedua
  lyrics.ovh (lirik polos). Header klien `Lrclib-Client:
  LarasWeb/1.0 (+https://github.com/adiprmx/laras-web)`.
  429 dihormati via Retry-After + jitter maks 30%, satu kali
  coba ulang, tunggu dibatasi 60 detik. Timeout 30 detik, cap
  1 MB per respons. Lagu instrumental diperlakukan sebagai
  "tidak ditemukan" (bukan galat).
- Cache IndexedDB (store `lyrics` dari P3, cap 256 KB per kolom):
  lirik yang sudah diambil tidak di-fetch ulang. Penanda
  "tidak ditemukan" 7 hari di app_meta (menghindari fetch ulang
  lagu tanpa lirik; sesuai arsitektur §3.7).
- Pemberitahuan privasi satu kali SEBELUM fetch apa pun:
  "Lirik diambil dari layanan luar. Layanan itu bisa melihat
  judul lagu yang kamu putar dan alamat internetmu." — tidak
  ada request jaringan sebelum pengguna menekan "Mengerti".
  Saklar lirik di Pengaturan (default aktif).
- Empty state jujur: "Lirik lagu ini belum ada.",
  "Lirik belum bisa dimuat. Periksa koneksimu lalu coba lagi.",
  "Lirik belum tersimpan. Sambungkan internet sekali untuk
  mengambilnya." (offline + belum tersimpan). Lirik TIDAK PERNAH
  dikarang.
- Atribusi sumber disimpan bersama lirik (`source: 'lrclib' |
  'ovh'` di baris cache): lirik dari lyrics.ovh tetap diakui
  "Lirik oleh lyrics.ovh" sesudah dibaca dari cache (bug
  atribusi yang ditemukan + diperbaiki saat verifikasi, §Bug).

### Keputusan

- Panel lirik/EQ/timer di-lazy-load dari FullPlayer supaya
  bundle awal tetap di bawah anggaran (ketiganya jadi chunk
  terpisah: `LyricsPanel-*`, `EqPanel-*`, `SleepTimerPanel-*`).
- Tidak ada fetch sebelum persetujuan privasi — desain paling
  sederhana dan paling jujur (cache pun baru dibaca sesudah
  pengguna menekan "Mengerti").
- Parser LRC (`lrc.ts`) menangani tag waktu ganda per baris,
  `[offset:]`, tag metadata yang diabaikan, dan tag kata
  LRC lanjutan `<mm:ss.xx>` yang dibuang.

### Batasan jujur

- Lirik hanya tersedia bila LRCLIB/lyrics.ovh punya lagunya —
  banyak lagu Indonesia tidak ada lirik tersinkronnya.
- LRCLIB membatasi ~45 request/menit (generik), ~90/menit
  (teridentifikasi via header klien), ~180/menit (terdaftar
  dengan App-Id). Laras memakai jalur teridentifikasi; bila
  lalu lintas naik, koordinator perlu mendaftarkan App-Id
  (langkah rilis, lihat §Utang).
- Lirik lyrics.ovh tidak tersinkron (tampil sebagai teks polos).

## 2. EQ 10 band

### Yang dibangun

- Panel "Pengatur suara" di pemutar penuh: 10 slider
  (31 Hz – 16 kHz, ±12 dB, langkah 1 dB), preset Rata, Bass,
  Vokal, Akustik + "Atur sendiri" (kustom), tombol "Atur
  ulang". Pengaturan tersimpan di IndexedDB (app_meta
  `eq-settings`) dan bertahan antar reload (dibuktikan E2E).
- Graph Web Audio (`audioGraph.ts`): sumber → 10 filter
  peaking seri (Q=1) → gain → tujuan. Nilai EQ disimpan walau
  graph belum dibuat, diterapkan via `setTargetAtTime`
  (tanpa bunyi klik).
- Saat streaming, panel menampilkan pesan jujur bahwa EQ
  tidak tersedia untuk streaming (bukan kontrol mati yang
  menipu). Stream TIDAK PERNAH masuk graph (penjaga S5 tidak
  diubah: googlevideo tanpa header CORS akan membisukan audio
  bila masuk graph). Tidak ada proxy audio (di luar scope v1).

### Keputusan

- Kurva preset dipilih sebagai kurva yang wajar dan
  didokumentasikan di `equalizer.ts` (Bass menaikkan 31–250 Hz
  +6/+5/+3/+1 dB; Vokal menaikkan 500 Hz–4 kHz; Akustik
  menaikkan ujung atas secara lembut). Bukan salinan kurva
  produk lain.
- EQ diterapkan ke graph oleh PlayerService (store hanya
  menyimpan state + persistensi — pola yang sama dengan store
  pemutar).

### Batasan jujur

- EQ hanya untuk lagu lokal/unduhan (jalur graph). Ini batasan
  arsitektur yang disengaja (S5), bukan bug.
- Perubahan EQ saat memutar streaming tidak berpengaruh sampai
  lagu lokal diputar (pengaturan tetap tersimpan).

## 3. Timer tidur

### Yang dibangun

- Panel "Timer tidur" di pemutar penuh: pilihan 5/10/15/30/45/60
  menit atau "Sampai lagu ini selesai". Sisa waktu tampil di
  panel dan di pemutar ("Berhenti dalam 5 menit"), diperbarui
  tiap detik, bisa dibatalkan.
- Berbasis tenggat (deadline), bukan hitungan `setTimeout`:
  dicek di 3 pemicu — watchdog 1 detik, `timeupdate`, dan
  `visibilitychange` saat tab kembali terlihat. 10 detik
  terakhir volume turun perlahan (fade) sebelum dijeda.
- Timer akhir-lagu mengalahkan repeat-one (timer menang saat
  lagu berakhir). Ganti lagu membatalkan timer akhir-lagu
  dengan pemberitahuan "Timer dibatalkan karena kamu ganti
  lagu." (retry lagu yang sama tidak membatalkan).
- Pesan jujur di panel: "Timer berhenti kalau tab ini
  ditutup."

### Batasan jujur

- Timer berhenti bila tab ditutup (browser tidak memberi
  jalan untuk menjalankan kode sesudah tab ditutup; tidak
  ada Service Worker timer di v1). Ini dinyatakan di UI,
  bukan disembunyikan.
- Di latar, browser men-throttle timer JavaScript — tenggat
  tetap akurat saat tab kembali terlihat (dicek di
  `visibilitychange`), tetapi jeda bisa terlambat beberapa
  detik bila tab lama di latar. Pemutaran audio sendiri
  tetap jalan di latar (elemen `<audio>` tidak di-throttle
  seperti `setTimeout`).

## 4. Sinkronisasi opsional (OAuth + D1)

### Yang dibangun

- **Worker `laras-sync`** (`workers/sync/src/index.js` +
  `wrangler.toml` + `README.md`): endpoint `/api/auth/login`,
  `/api/auth/callback`, `/api/auth/me`, `/api/auth/logout`,
  `/api/auth/delete`, `/api/sync/pull`, `/api/sync/push`.
  Mengikuti protokol S8 yang sudah terbukti: last-write-wins
  + tiebreak `device_id`, tombstone hapus, hash sesi SHA-256,
  sinkronisasi inkremental 2 arah, settings 4 KB.
- **Klien** (`app/src/sync/`): `config.ts`,
  `deviceId.ts` (UUID stabil per perangkat di app_meta),
  `syncClient.ts` (fetch + `credentials: 'include'` +
  timeout 30 detik + `SyncApiError`), `syncService.ts`
  (orkestrasi tarik-dulu-dorong-belakangan, batch 100),
  `syncStore.ts` (Zustand), `auth.ts` (tautan masuk),
  `settingsMarkers.ts` (pengaturan hanya didorong bila
  berubah).
- **UI Pengaturan** (seksi "Akun", paling atas): belum masuk
  → penjelasan + tombol Google/GitHub; sudah masuk → nama,
  "Sinkronkan sekarang", terakhir sinkron, "Keluar", "Hapus
  akun" (dialog konfirmasi 2 langkah), catatan bahwa file
  unduhan tidak ikut disinkronkan. Seksi "Lirik" (saklar)
  di bawahnya.
- **Skema lokal**: DB naik ke v3 (`sync_tombstones` store
  baru: `key, kind, deletedAt`); `PlaylistRow.clientId`
  opsional (tanpa indeks — Dexie menyimpan properti ekstra
  tanpa perubahan skema). Tombstone dicatat saat: hapus
  playlist, keluarkan lagu dari playlist, batal suka,
  keluarkan dari Library. Hapus riwayat total dicatat sebagai
  penanda `sync-history-cleared-before`.
- **Migrasi D1 `workers/sync/0003_item_meta.sql`**: kolom
  `title`/`artist` (nullable) di `sync_playlist_items`,
  `sync_likes`, `sync_history` — supaya perangkat kedua bisa
  menampilkan judul asli, bukan mengarang atau menghilangkan
  lagu. **Koordinator WAJIB menerapkan 0003 sebelum deploy
  Worker** (SQL push/pull memakai kolom ini).
- **App init**: periksa sesi + sinkron sekali di latar
  sesudah jeda 20 detik (best-effort, diam, tidak memblokir
  pemutaran). Redirect OAuth (`?auth=ok` /
  `?auth=error`) ditangani di Pengaturan (query dibersihkan
  dari URL sesudah dibaca).
- **Login TIDAK PERNAH wajib untuk memutar lagu**: tombol
  masuk hanya di Pengaturan; app jalan penuh tanpa login;
  sinkronisasi manual via tombol (tidak ada sinkron otomatis
  berkala di v1 — menghemat kuota D1 + baterai).

### Keputusan (dengan alasan)

- **Worker terpisah `laras-sync`**, bukan digabung ke proxy
  byte-only (menjaga peran proxy S7 tetap bersih).
- **Tarik dulu, dorong belakangan**: perubahan server
  diterapkan ke lokal dulu, sehingga dorong mengirim state
  gabungan — konflik nama playlist yang diubah di dua
  perangkat dimenangkan versi server (yang sampai duluan).
  Batasan LWW ini didokumentasikan, sesuai protokol S8.
- **Riwayat didorong inkremental** (hanya event lebih baru
  dari penanda), sementara playlist/suka didorong penuh —
  riwayat bisa 10.000 event (ratusan request bila penuh),
  playlist/suka jumlahnya kecil.
- **Pengaturan hanya didorong bila berubah** (penanda lokal
  vs penanda terapan): tanpa ini, dorong akan menimpa
  pengaturan yang baru saja ditarik (server menstempel waktu
  dorong dengan jam server, jadi dorong selalu "lebih baru").
- **Cookie sesi `SameSite=None; Secure`** — PENYIMPANGAN
  TERCATAT dari arsitektur §4.3 (yang menulis Lax): Worker
  di domain workers.dev dan app di adipmusic.my.id adalah
  lintas situs; cookie Lax tidak dikirim fetch lintas situs
  sehingga auth akan rusak total. Mitigasi CSRF: semua POST
  memvalidasi header `Origin` terhadap allowlist; GET
  bersifat baca-saja dan responsnya tidak bisa dibaca lintas
  origin tanpa CORS. Bila Worker suatu hari pindah ke
  subdomain app yang sama (same-site), set env
  `COOKIE_SAMESITE=Lax` untuk memperketat. Keputusan ini
  didokumentasikan di kepala `workers/sync/src/index.js` dan
  `workers/sync/README.md`.
- **Penghapusan akun menghapus data secara eksplisit
  berurutan** (tidak mengandalkan `ON DELETE CASCADE` —
  penegakan FK D1 tidak dijamin).
- **Rate limit D1 fail-open** (pola proxy): auth 10/mnt/IP,
  sync 30/mnt/user, me 60/mnt/IP. Bila D1 mati, request
  diizinkan — layanan tetap jalan, bukan mati total.
- **Tanpa secret OAuth, `/api/auth/login` membalas 503**
  dengan halaman penjelasan ("Masuk belum tersedia.") —
  bukan crash, bukan login palsu.

### Batasan jujur

- **Uji masuk live MENUNGGU LANGKAH OWNER**: aplikasi OAuth
  Google/GitHub belum dibuat (butuh client id/secret lewat
  Secure Vault). Alur OAuth diuji dengan fetch di-stub
  (28 tes Worker, termasuk tukar kode → buat pengguna +
  sesi → cookie → `/api/auth/me`). Login sungguhan ke Google/
  GitHub belum pernah dicoba — lihat §Utang.
- Sinkronisasi manual (tombol + sekali saat app dibuka).
  Tidak ada sinkronisasi real-time antar perangkat.
- File lagu yang diunduh TIDAK ikut disinkronkan (hanya
  metadata: suka, playlist, riwayat, pengaturan). Dinyatakan
  di UI Pengaturan.
- Pengaturan yang diubah di dua perangkat sebelum sempat
  sinkron: yang tersimpan di server duluan yang menang
  (perubahan lokal yang belum terkirim tertimpa saat tarik).
- Judul/artis metadata sync adalah "apa adanya" dari
  perangkat pengirim (bukan sumber kebenaran katalog). Bila
  metadata tidak ada, judul jatuh ke videoId (id asli, bukan
  karangan).

## Bug yang ditemukan + diperbaiki saat verifikasi P7

1. **Sisa timer tidur tampil "31 menit" untuk opsi 30 menit**
   (ditemukan di screenshot P7). Penyebab: `now` di
   FullPlayer/SleepTimerPanel berasal dari state tick yang
   dibuat sebelum timer dipasang (FullPlayer mount sejak app
   start — bisa menit lebih tua), dan `ceil` membulatkan
   30:01 menjadi 31 menit. Perbaikan: segarkan `now` segera
   saat timer aktif, di kedua komponen. Screenshot ulang
   membuktikan "30 menit" yang benar.
2. **Atribusi lirik cache selalu "oleh LRCLIB"** walau asalnya
   dari lyrics.ovh. Penyebab: cache tidak menyimpan sumber.
   Perbaikan: kolom `source` di `LyricsRow` (opsional, tanpa
   perubahan skema) + `saveLyrics`/`getLyrics` membawa
   sumbernya; tes baru membuktikan ovh tetap diakui ovh
   sesudah putaran cache.
3. **Tes `database.test.ts` "18 store"** — ekspektasi belum
   diperbarui untuk store `sync_tombstones` (v3). Diperbarui
   ke 19 store (perubahan skema yang disengaja, bukan
   pelonggaran).
4. **Mock `networkOk` bocor antar-tes** di
   `lyricsService.test.ts` (asersi "tidak dipanggil" gagal
   karena panggilan tes sebelumnya). Perbaikan:
   `vi.clearAllMocks()` di `beforeEach`.
5. **Tes batch sync 150 lagu kena timeout 5 detik** di bawah
   beban suite penuh. Perbaikan: 120 lagu + timeout tes
   15 detik (tetap membuktikan pemecahan 100 + 20).
6. **Seed EQ di halaman uji tidak terlihat di screenshot**
   (store EQ dimuat sekali saat init, sebelum seed ditulis).
   Bukan bug produk — spec screenshot diubah memilih preset
   Bass lewat UI (membuktikan jalur pengguna yang nyata).

## Tes (angka nyata)

### Vitest — 587/587, 43 file

109 tes baru P7:

| File | Tes |
| ---- | --- |
| `src/lyrics/lrc.test.ts` | 12 |
| `src/lyrics/lrclib.test.ts` | 15 |
| `src/lyrics/lyricsService.test.ts` | 7 |
| `src/player/equalizer.test.ts` | 13 |
| `src/player/sleepTimer.test.ts` | 10 |
| `src/sync/syncService.test.ts` | 16 |
| `src/sync/syncClient.test.ts` | 6 |
| `src/sync/deviceId.test.ts` | 2 |
| `src/worker/syncWorker.test.ts` | 28 |

Tes Worker memakai D1 palsu in-memory yang meniru semantik
upsert LWW + tiebreak `device_id` (termasuk tiebreak jam
beku), tombstone, cap 4 KB/100 entri/1 MB, rate limit,
CSRF Origin, dan alur OAuth penuh dengan fetch di-stub.
Tes `syncService` memakai LibraryService nyata +
fake-indexeddb + stub `SyncDeps`.

### E2E Playwright — `p7.spec.ts` 7/7 chromium + 7/7 mobile

1. Lirik tersimpan tampil + baris aktif mengikuti waktu
   putar (posisi ≥ 6 detik → baris ketiga aktif).
2. Tanpa seed lirik: pemberitahuan privasi muncul sebelum
   fetch.
3. EQ: ubah band tersimpan dan bertahan sesudah reload.
4. Timer 5 menit: sisa waktu tampil + bisa dibatalkan.
5. Timer sampai lagu selesai: pemutaran dijeda di ujung
   nada 10 detik.
6. Sinkronisasi mock (sudah masuk): nama tampil, tombol
   sinkron menarik + mendorong (body push tertangkap,
   `deviceId` terisi).
7. Sinkronisasi mock (belum masuk): tombol masuk tampil
   dengan tautan Worker yang benar.

Regresi `player.spec.ts` (diubah P7 untuk EQ baru): 9/9
chromium (+1 live skip). Semua jaringan di-mock; tidak ada
jaringan nyata dalam tes E2E.

### Screenshot — `docs/p7/` (8 file, diperiksa visual)

`lyrics-360/1440.png`, `eq-360/1440.png`,
`sleep-timer-360/1440.png`, `settings-account-360/1440.png`.
Pemeriksaan visual menemukan bug #1 dan #6 di atas; kedua
screenshot yang bermasalah diambil ulang sesudah perbaikan
dan diperiksa lagi.

### Bundle

- Bundle awal gzip: **175.509 byte** (batas 204.800;
  JS 168.490 + CSS 7.019). Naik 5.897 dari 169.612
  pasca-Blue 2 — sebagian besar dari kode sinkronisasi +
  store baru yang masuk bundle awal; panel P7
  (lirik/EQ/timer) dan halaman Pengaturan tetap lazy.
- 0 chunk `*TestPage*` di `dist/` (gerbang Red 1 H1 aman;
  rute `/p7-test` DEV-only seperti rute uji lainnya).

### Lingkungan verifikasi

Gelombang EPERM TERBATAS aktif saat verifikasi: Vite CLI
gagal start server dev (`mkdir node_modules/.vite-temp`,
ENOENT). Server dev dijalankan via Vite API
(`createServer({ configFile: false })`, pola terbukti P6/
Blue 2) dan Playwright memakai ulang server itu
(`reuseExistingServer`). Build via `node build-api.mjs`.
File sementara (`dev-api.tmp.mjs`, log) dihapus sesudah
verifikasi; server dev dimatikan.

## Checklist 7 skill anti-slop

Dibaca + dipakai untuk desain + writing P7 (mode `during`;
sebagai subagent, tim P7 tidak bisa bertanya ke user —
sama seperti P2):

| Skill | Dipakai untuk | Bukti |
| ----- | ------------- | ----- |
| local-design-taste-frontend | Panel lirik/EQ/timer + seksi Akun | Mengikuti design lock hitam/putih yang ada; tidak ada warna dekoratif baru; tombol + chip memakai pola komponen yang sudah ada |
| local-impeccable | Audit visual screenshot | Pemeriksaan 8 screenshot menemukan bug #1 + #6; EQ menampilkan kurva lengkap 10 band; tidak ada teks terpotong/overflow di 360px |
| local-anti-slop | Copy UI + laporan | Semua copy Bahasa Indonesia sehari-hari; tanpa em dash; tanpa jargon ("sinkron" dijelaskan sebagai "playlist-mu sama di HP dan laptop") |
| local-humanizer | Copy Pengaturan + pesan galat | "Masuk belum tersedia." / "Masuk hanya perlu kalau kamu mau playlist-mu sama di HP dan laptop." — kalimat manusia, bukan template |
| local-stop-slop | Copy + laporan | Tanpa filler ("Tentu!", "Berikut adalah"); laporan langsung ke angka + keputusan |
| local-no-ai-slop | Copy + laporan | Tanpa klaim "gratis/cepat/mudah" yang tidak terbukti; batasan dinyatakan jujur (timer berhenti kalau tab ditutup; file unduhan tidak ikut sinkron) |
| local-avoid-ai-writing | Laporan ini | Kalimat pendek, aktif, spesifik; angka nyata dengan sumber pengukuran, bukan estimasi |

## File yang diubah / dibuat

Baru:

- `app/src/lyrics/{lrc,lrc.test,lrclib,lrclib.test,lyricsService,lyricsService.test,LyricsPanel}.ts(x)`
- `app/src/player/{equalizer,equalizer.test,sleepTimer,sleepTimer.test}.ts`
- `app/src/store/equalizer.ts`
- `app/src/components/{EqPanel,SleepTimerPanel}.tsx`
- `app/src/sync/{config,deviceId,deviceId.test,syncClient,syncClient.test,syncService,syncService.test,syncStore,settingsMarkers,auth}.ts`
- `app/src/worker/syncWorker.test.ts`
- `app/src/test-pages/P7TestPage.tsx`
- `app/tests/e2e/{p7.spec,p7-screenshots.spec}.ts`
- `workers/sync/{0003_item_meta.sql,wrangler.toml,README.md,src/index.js,src/index.d.ts}`
- `docs/p7/*.png` (8 screenshot)

Diubah:

- `app/src/strings/id.ts` (string P7: lirik, EQ, timer, akun)
- `app/src/player/{audioGraph,service}.ts` (filter EQ di graph;
  API EQ + timer tidur di service)
- `app/src/store/player.ts` (`sleepTimer`, hapus `eqNote`)
- `app/src/components/{FullPlayer,settings/SettingsPage}.tsx`
  (panel lazy + tombol; seksi Akun + Lirik)
- `app/src/data/{types,database,database.test,library,library.test}.ts`
  (v3 + `sync_tombstones`, `clientId`, `LyricsRow.source`,
  hook tombstone + API sync)
- `app/src/App.tsx` (rute `/p7-test` DEV-only + init sync
  tertunda 20 detik)
- `app/public/_headers` (CSP `connect-src` + lrclib.net,
  api.lyrics.ovh, Worker sync)
- `app/tests/e2e/player.spec.ts` (tes EQ diperbarui ke UI baru)
- `CHANGELOG.md` (entri P7 di `## [Unreleased]` → `### Added`)

Tidak disentuh: `~/workspace/music-app/` (APK), worker proxy
(`workers/proxy/`, kecuali diimpor ulang rate limit-nya),
CI, perilaku P0–P6 di luar yang diperlukan P7.

## Utang (untuk koordinator / owner)

1. **Aplikasi OAuth Google/GitHub belum dibuat (langkah
   owner).** Buat aplikasinya, daftarkan redirect URI
   `https://laras-sync.hiroohengkerr.workers.dev/api/auth/callback`
   (satu URI untuk kedua provider), simpan client id/secret
   sebagai Worker secrets via Secure Vault
   (`wrangler secret put GOOGLE_CLIENT_ID` dst. — lihat
   `workers/sync/README.md`). **Uji masuk live belum pernah
   dilakukan** — koordinator wajib menguji login sungguhan
   sesudah secret dipasang (cek: redirect → Google/GitHub →
   `/settings?auth=ok` → nama tampil → sinkron jalan).
   Sampai saat itu, tombol masuk membalas halaman 503 yang
   jujur ("Masuk belum tersedia.") — perilaku yang benar,
   bukan galat.
2. **Migrasi D1 0003 wajib sebelum deploy Worker sync.**
   Terapkan `0001` + `0002` (sudah ada) + `0003_item_meta.sql`
   ke `laras-web-sync` sebelum `wrangler deploy` dari
   `workers/sync/`. Bila Worker di-deploy duluan, push/pull
   gagal "no such column" (terdeteksi di smoke test deploy).
3. **Deploy Worker `laras-sync`** (`wrangler deploy` dari
   `workers/sync/`) + smoke test (`GET /api/auth/me` tanpa
   cookie harus 401; `/api/auth/login?provider=google`
   harus 302 ke Google sesudah secret dipasang). Checklist
   lengkap di `workers/sync/README.md`.
4. **LRCLIB App-Id terdaftar** (langkah rilis, bukan
   pemblokir): bila lalu lintas lirik naik, daftarkan App-Id
   untuk naik dari ~90 ke ~180 request/menit (S10).
5. **CI adalah gerbang E2E mobile + live**: tim P7
   menjalankan p7.spec.ts di chromium + mobile lokal, tetapi
   suite E2E penuh + uji live tetap menjadi gerbang CI.
