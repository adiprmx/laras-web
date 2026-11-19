# Red 4 - Audit Keamanan Laras Web (P9, sesudah Blue 3)

**Tanggal:** 19 November 2026.
**Auditor:** Tim Red 4 - audit statis + tes unit + probe live terbatas
( endpoint publik tanpa auth).
**Ruang lingkup:** verifikasi seluruh klaim perbaikan Blue 3 atas 16
temuan Red 3, verifikasi regresi perbaikan Blue 1 dan Blue 2, audit
permukaan baru kode Blue 3 (logika `oauth_states`, kepemilikan R11,
alur wipe R15, cap R14), plus pemeriksaan rutin (XSS, console,
secret, telemetri, larangan `api.spotify.com`).
**HEAD yang diaudit:** workdir `~/workspace/music-app-web/` per 19 Nov
2026 (remote HEAD 39568d84, Blue 3, sesuai penugasan; `git log` lokal
basi dan tidak dipakai sebagai acuan, sesuai catatan AGENTS.md tentang
push via API).
**Metode:** baca kode penuh jalur sensitif yang diubah Blue 3 dan
kedua worker, grep pola berbahaya, jalankan Vitest penuh + tes unit
worker, probe live hemat kuota ke domain produksi dan worker sync
(sekitar 40 request total, tanpa auth, tanpa menyentuh data pengguna),
dan verifikasi `app/dist/` hasil build Blue 3 di disk.
Tanpa Playwright E2E dan tanpa browser (dicatat di "Tidak bisa
diverifikasi"). Red HANYA audit: tidak ada kode produksi yang diubah;
satu-satunya file yang ditulis adalah laporan ini.
**Catatan penomoran:** temuan baru melanjutkan penomoran Red 3
(S7, R17-R18, I19).

## Ringkasan vonis

| Tingkat | Jumlah |
|---|---|
| Kritis | **0** |
| Tinggi | **0** |
| Sedang | **1** |
| Rendah | **2** |
| Info | **1** |
| **Total baru** | **4** |

**Vonis: LAYAK LANJUT KE BLUE 4, dengan satu temuan sedang (S7) yang
wajib ditutup sebelum release candidate.** Tidak ada temuan kritis atau
tinggi. Seluruh klaim perbaikan Blue 3 TERBUKTI (14 dari 14 klaim yang
bisa diverifikasi, termasuk S6 dan R10 yang dibuktikan LIVE, bukan
hanya di kode). Seluruh perbaikan Blue 1 dan Blue 2 MASIH bertahan
(H1, S1-S5, R1-R9, I5-I7 terverifikasi ulang di bawah). Fondasi
keamanannya kuat dan semakin kuat: callback OAuth kini dibatasi dan
state-nya sekali pakai di server, localhost sudah hilang dari CORS
produksi yang live, push playlist kini dicek kepemilikannya, semua
jalur impor file kini ber-cap sebelum dibaca, dan CSP live
terkonfirmasi dari header produksi.
Satu-satunya lubang berarti adalah S7: worker sync tidak pernah
menegakkan batas TOTAL per pengguna yang diwajibkan arsitektur §4.3,
sehingga satu akun terautentikasi bisa membakar kuota tulis D1
bersama (100.000 baris/hari) dalam waktu kurang dari lima menit dan
mematikan sinkronisasi untuk semua pengguna sampai reset.
Dua temuan rendah (R17, R18) adalah celah sisa di sekitar perbaikan
R15: wipe melewatkan logout bila status akun masih `unknown`, dan
sinkronisasi yang sedang berjalan saat wipe bisa membangkitkan data
sesudah penghapusan database.

---

## Temuan sedang

### S7 - Worker sync tanpa batas total per pengguna: satu akun bisa membakar kuota tulis D1 bersama dalam 5 menit

**Tingkat: sedang.** **File:**
`workers/sync/src/index.js:699-779` (`validatePushBody` + `handlePush`),
`workers/sync/0001_init.sql` (skema tanpa batas jumlah),
`app/src/data/library.ts:3012` (`createPlaylistFromRemote` tanpa cap
jumlah), `docs/arsitektur.md` §4.3 (batas yang diwajibkan).

**Bukti:**
- `validatePushBody` hanya membatasi jumlah entri PER PUSH (maks 100
  per koleksi, `:699-779`) dan ukuran per field. TIDAK ADA satu pun
  pemeriksaan jumlah TOTAL per pengguna di `handlePush`: grep `COUNT`
  di seluruh `workers/sync/src/index.js` mengembalikan NOL, dan
  `0001_init.sql` tidak punya CHECK/TRIGGER pembatas jumlah (satu-satunya
  CHECK ukuran adalah `length(settings_json) <= 4096`).
- Arsitektur §4.3 MEWAJIBKAN batas total yang tidak satu pun
  ditegakkan server: maks 100 playlist per pengguna, maks 1.000 item
  per playlist, maks 10.000 suka, maks 1.000 entri riwayat terbaru.
  Klien menuruti sebagian batas ini secara sukarela (mis.
  `insertPlaylistItemAt` menolak item ke-1.001, `library.ts:3107`),
  tetapi klien yang jahat atau rusak tidak terikat olehnya: server
  menerima apa pun yang lolos validasi bentuk.
- Hitungan kuota (angka dari arsitektur §2.1, bukan karangan):
  satu push bisa membawa 7 koleksi x 100 entri = 700 baris tulis.
  Rate limit sync adalah 30/mnt/user, jadi satu pengguna
  terautentikasi bisa menulis 700 x 30 = 21.000 baris/menit.
  Kuota D1 free-tier adalah 100.000 baris ditulis/hari
  (arsitektur §2.1, dipakai bersama seluruh database
  `laras-web-sync`, termasuk tulis rate limit proxy yang 1 baris
  per request). 100.000 / 21.000 = habis dalam waktu kurang dari
  5 menit dari satu akun.
- Akunnya gratis dan self-serve (OAuth Google/GitHub, tanpa
  persetujuan manual), jadi hambatan masuk penyerang adalah nol.
  Tidak seperti S6 (Red 3) yang butuh IP tanpa batas, S7 justru
  memakai jalur yang memang dirancang untuk dipakai berulang
  (sinkronisasi berkala) dan rate limit 30/mnt TIDAK menolong
  karena tiap request membawa 700 baris.
- Dampak berantai bila kuota tulis D1 habis: push/pull sync gagal
  (500) untuk SEMUA pengguna sampai reset 00:00 UTC; rate limit
  proxy dan sync fail-open (keputusan yang didokumentasikan),
  sehingga lapisan pelindung kuota Workers ikut nonaktif di saat
  yang sama; `storeOAuthState` best-effort gagal diam-diam
  (single-use S6 ikut lumpuh, login lanjut fail-open).
  Ini kelas yang sama dengan S3 (Red 1) dan S6 (Red 3):
  pembakaran kuota bersama oleh satu aktor, yang keduanya
  dinilai sedang.
- Amplifikasi ke klien: server yang memuat baris tanpa batas
  mengembalikan sampai 1.000 baris per koleksi per pull
  (`MAX_PULL_ROWS`), dan pull berulang dengan `since` yang maju
  mengakumulasikan semuanya ke perangkat korban sendiri;
  `createPlaylistFromRemote` (`library.ts:3012`) tidak
  menegakkan cap jumlah playlist total (tidak seperti item yang
  di-cap 1.000 per playlist), sehingga satu akun yang datanya
  membengkak membengkakkan IndexedDB di semua perangkatnya.

**Dampak:** DoS ketersediaan sinkronisasi untuk semua pengguna
sampai reset harian, plus degradasi berantai rate limit dan
single-use state OAuth; pembengkakan database server dan lokal
tanpa batas.
**Rekomendasi (Blue):**
1. Tegakkan batas arsitektur §4.3 di `handlePush` SEBELUM `batch`:
   hitung baris yang sudah dimiliki pengguna per tabel
   (`SELECT COUNT(*) ... WHERE user_id = ?`, 5x baca per push;
   baca D1 5 juta baris/hari, jadi biayanya dapat diabaikan) dan
   tolak push yang akan melewati 100 playlist / 1.000 item per
   playlist / 10.000 suka / 1.000 riwayat dengan 400/429 yang
   jelas. Alternatif yang lebih murah: tolak bila push ini saja
   membawa clientId playlist baru di atas ambang + hitung hanya
   bila ambang per-push terlampaui.
2. Sebagai pertahanan lapis kedua, tambahkan cap total playlist
   di `createPlaylistFromRemote` (mis. tolak di atas 1.000, sesuai
   batas playlist app) supaya pull dari server yang membengkak
   tidak membengkakkan IndexedDB tanpa batas.
3. Tambahkan tes worker: pengguna dengan 100 playlist yang
   mendorong playlist ke-101 ditolak; push 100 entri x 7 koleksi
   berulang tidak bisa melewati total yang ditetapkan.

---

## Temuan rendah

### R17 - Wipe melewatkan logout bila status akun masih `unknown`: data kembali 20 detik sesudah wipe tanpa peringatan

**Tingkat: rendah.** **File:**
`app/src/components/settings/WipeFlow.tsx:64-90` (`handleWipe`),
`app/src/sync/syncStore.ts:57,64-82` (status awal `unknown`,
`refreshAuth` gagal jaringan membiarkan `unknown`),
`app/src/components/settings/SettingsPage.tsx:114,117`
(`refreshAuth` dipanggil saat mount, async),
`app/src/App.tsx:210-220` (sinkron otomatis 20 detik).

**Bukti:**
- `handleWipe` hanya memanggil `fetchLogout()` bila
  `syncStatus === 'signed-in'`. Bila status adalah `unknown`,
  wipe langsung lanjut ke `doWipe()` tanpa logout, tanpa
  peringatan, dan tanpa catatan sinkronisasi (catatan
  `wipe-sync-note` juga hanya tampil bila `signed-in`).
- Status awal store adalah `unknown` (`syncStore.ts:57`) sampai
  `refreshAuth` pertama selesai. `SettingsPage` memanggil
  `refreshAuth()` saat mount, tetapi itu async (satu round-trip
  jaringan); pengguna yang membuka Pengaturan lalu langsung
  menekan Hapus dua kali dalam waktu kurang dari round-trip itu
  (atau saat jaringan lambat) menabrak jendela ini.
- Jalur yang lebih realistis: `refreshAuth` yang gagal karena
  jaringan/server membiarkan status TETAP `unknown`
  (`syncStore.ts:77-79`, disengaja supaya UI tidak menyuruh
  masuk berulang kali). Pengguna yang wipe saat offline atau
  saat server sync bermasalah, dengan sesi yang sebenarnya
  masih valid, tidak mendapat peringatan `logoutFailed` sama
  sekali (peringatan itu hanya ada di jalur `signed-in`).
  Sesudah reload dan jaringan pulih, sinkron otomatis 20 detik
  (`App.tsx:210-220`) memakai cookie sesi yang masih hidup dan
  menarik seluruh data kembali dengan `since=0`. Gejalanya
  persis R15 yang diklaim sudah ditutup, hanya lewat jalur
  status yang berbeda.
- Kontras yang menunjukkan ini kelalaian, bukan desain:
  `signOut` di store yang sama (`syncStore.ts:105-112`)
  memanggil `fetchLogout()` best-effort TANPA memeriksa status
  dulu. Endpoint logout sendiri aman dipanggil tanpa sesi
  (mengembalikan `{ loggedOut: true }` dan tidak menulis D1
  bila tidak ada sesi, `workers/sync/src/index.js:994-1010`).
- Penyeimbang yang membuat tingkatnya rendah, bukan sedang:
  jendela race-nya sempit dalam pemakaian normal (refreshAuth
  biasanya selesai sebelum pengguna menyelesaikan dua dialog),
  dan data yang kembali adalah data pengguna sendiri, bukan
  kebocoran ke pihak ketiga.

**Dampak:** pengguna yang menghapus data karena alasan privasi
(mis. menjual/meminsjamkan perangkat) dalam keadaan status
belum terkonfirmasi mendapati datanya pulih sendiri tanpa
peringatan apa pun; janji wipe kembali dilanggar di jalur ini.
**Rekomendasi (Blue):**
1. Di `handleWipe`, panggil `fetchLogout()` bila status
   `signed-in` ATAU `unknown` (lewatkan hanya bila status
   definitif `signed-out`, yang hanya diset sesudah 401 atau
   keluar eksplisit); kegagalan logout di jalur `unknown`
   menampilkan peringatan + tombol "Coba keluar lagi" /
   "Tetap hapus" yang sama seperti jalur `signed-in`.
   Alternatif yang sama baiknya: `await refreshAuth()` dulu
   di awal `handleWipe` bila status `unknown`, lalu putuskan
   berdasarkan status sesudahnya.
2. Tambahkan tes `WipeFlow`: status `unknown` + wipe memicu
   panggilan logout (atau refreshAuth dulu); status
   `signed-out` tidak memicu panggilan logout.

### R18 - Sinkronisasi yang sedang berjalan saat wipe bisa membangkitkan data sesudah database dihapus

**Tingkat: rendah.** **File:**
`app/src/components/settings/WipeFlow.tsx:64-90` (tidak pernah
membaca flag `syncing`), `app/src/backup/wipe.ts:60-100`
(menghentikan pemutar + unduhan, TIDAK menghentikan sync),
`app/src/sync/syncStore.ts:85-88` (flag `syncing` ada, guard
satu putaran), `app/src/sync/syncService.ts:303-316` (`syncNow`:
tarik lalu terapkan, tanpa token generasi).

**Bukti:**
- `wipeAllData` menghentikan pemutar (`stopForWipe`) dan
  unduhan (`deleteAllDownloads`) sebelum menghapus database,
  tetapi TIDAK menunggu atau membatalkan `syncNow` yang sedang
  berjalan. `WipeFlow` tidak pernah membaca `syncing` dari
  store (grep: hanya `syncStatus` yang dibaca).
- Interleaving yang mungkin: `syncNow` sudah melewati
  `fetchPull` (request diotorisasi SEBELUM logout, karena
  server memeriksa sesi saat request tiba) dan sedang
  menjalankan `applyPull` (rangkaian await per playlist/item);
  pengguna menekan Hapus, logout berhasil di server, lalu
  `deleteDatabase()` menghapus IndexedDB; `applyPull` yang
  masih berjalan kemudian menulis playlist/item/suka/riwayat
  hasil tarik ke database yang baru dibuka kosong (Dexie
  membuka ulang database secara lazy). Reload sesudahnya
  memang tidak memicu sinkron lagi (sesi sudah mati), tetapi
  data hasil tarik itu SUDAH ada di database segar.
- Varian dorongnya lebih ringan: push yang dikirim sebelum
  logout tetap diterapkan server (diotorisasi saat tiba),
  tetapi retensi data server memang didokumentasikan sebagai
  perilaku wipe (hapus akun adalah jalur terpisahnya), jadi
  varian ini bukan temuan.
- Jendela race-nya sempit (putaran sync tipikal selesai dalam
  hitungan detik; wipe butuh dua konfirmasi manual), dan
  pemicunya butuh tumpang tindih yang tepat, sehingga
  tingkatnya rendah. Namun ini adalah SATU-SATUNYA jalur
  kebangkitan data yang tersisa sesudah R15 ditutup, dan
  gejalanya identik dengan R15 sehingga pengguna tidak bisa
  membedakannya dari "wipe gagal".

**Dampak:** satu putaran sync yang tumpang tindih dengan wipe
mengembalikan sebagian atau seluruh data ke perangkat yang
baru di-wipe, walau logout berhasil.
**Rekomendasi (Blue):**
1. Di `handleWipe`, tunggu sampai `syncing` false sebelum
   `doWipe()` (poll singkat dengan batas, mis. maks 5 detik,
   lalu lanjut; putaran sync normal selesai jauh lebih cepat)
   ATAU batalkan putaran sync yang berjalan.
2. Pertahanan lapis kedua: token generasi di `syncService`
   (angka yang naik tiap wipe; `applyPull` memeriksa token
   sebelum menulis tiap batch dan berhenti bila generasi
   berubah), mengikuti pola cek abort sebelum `putDownload`
   di R9 (Blue 2).
3. Tambahkan tes: pull yang resolve SESUDAH wipe dimulai tidak
   menulis apa pun ke database segar.

---

## Info

### I19 - `consumeOAuthState` tidak atomik: SELECT lalu DELETE memberi jendela race dua callback bersamaan

**File:** `workers/sync/src/index.js:373-401` (`consumeOAuthState`).

Dua callback bersamaan dengan state yang sama bisa sama-sama
lolos `SELECT` (`:378`) sebelum salah satunya menjalankan
`DELETE` (`:389`), karena cek-dan-hapus adalah dua pernyataan
terpisah tanpa transaksi (D1 `batch` bukan transaksi atomik,
lihat I16 Red 3). Dampaknya dibatasi ketat oleh dua hal:
kode otorisasi provider BERSIFAT sekali pakai, sehingga
`exchangeCode` kedua gagal di sisi Google/GitHub dan tidak
ada sesi kedua yang tercipta; dan rate limit callback
10/mnt/IP membatasi percobaan race. Kerugian terburuknya
adalah satu fetch token-endpoint ekstra + tulis D1 ekstra
per race yang berhasil, bukan pembuatan sesi ganda atau
pengambilalihan akun. Karena itu info, bukan temuan rendah.
Rekomendasi: jadikan konsumsi atomik dengan satu pernyataan
`DELETE FROM oauth_states WHERE state_hash = ? AND provider
= ? AND expires_at > ?` lalu periksa `meta.changes === 1`
(hasil `run()` D1 membawa jumlah baris yang berubah);
hapus baris kedaluwarsa/salah provider yang ditemukan
dengan cara yang sama. Tambahkan tes worker dua callback
paralel dengan state yang sama (hanya satu yang boleh
lanjut ke tukar kode).

### I16, I17, I18 - Masih terbuka dengan sengaja (bawaan Red 3, tanpa perubahan)

- **I16** (`db.batch` bukan transaksi atomik): tidak berubah,
  tetap batasan yang didokumentasikan Blue 3. Urutan hapus
  akun (`users` TERAKHIR) dan idempotensi upsert push masih
  berlaku sebagai mitigasi.
- **I17** (`x-proxy-cpu-ms`): masih aktif, keputusan Blue 1
  dipertahankan (dicabut saat promosi proxy produksi). Tes s7
  masih menegaskan header terekspos (20/20 lolos).
- **I18** (allowlist hash player di-hardcode): tidak berubah,
  keputusan Blue 1 dipertahankan. Ketiga salinan hash MASIH
  sinkron per 19 Nov 2026: proxy `PLAYER_HASHES`
  (`workers/proxy/src/index.js:68`: `fad7e4e9`, `ad8d59ae`,
  `b559f50c`), `BUILTIN_HASHES` (`app/src/spike/config.ts:125-129`,
  nilai sts yang sama), dan config remote live (ketiga hash
  yang sama, `version: 1`, diambil 19 Nov 2026).

---

## Verifikasi perbaikan Blue 3 (prioritas utama)

Semua 14 klaim yang bisa diverifikasi TERBUKTI. Dua di antaranya
(S6, R10) dibuktikan LIVE, bukan hanya di kode.

| ID | Klaim Blue 3 | Vonis | Bukti |
|---|---|---|---|
| S6 | Rate limit callback 10/mnt/IP dicek SEBELUM tukar kode | **TERBUKTI (kode + live)** | Router `workers/sync/src/index.js:964` (`auth-callback:<ip>`, `RATE_AUTH_PER_MIN`) sebelum `handleCallback` (`:555` tukar kode di dalam handler). LIVE 19 Nov 2026, satu koneksi curl, 11 callback dalam satu menit (06:12 UTC): 10x 302 + ke-11 429. (Dua percobaan sebelumnya tidak valid: serial 11x menembus batas menit, paralel 11x memakai IP egress berbeda per koneksi; metode koneksi tunggal yang sah.) |
| S6 | State single-use D1 `oauth_states` | **TERBUKTI (kode + live)** | `storeOAuthState` `:335-366` (hash SHA-256, TTL 10 menit, sapu kedaluwarsa tiap login, dipanggil login `:444`); `consumeOAuthState` `:373-401` (hapus saat dipakai, tolak tak dikenal/kedaluwarsa/sudah dipakai, dipanggil `:555` sebelum tukar kode); migrasi `0004_oauth_states_item_owner.sql` (tabel + indeks + backfill). LIVE: callback state tak dikenal (cookie cocok, state acak) ke 302 `reason=state`, bukan `reason=exchange` (yang akan terjadi bila tabel belum ada karena fail-open), jadi migrasi 0004 TERBUKTI diterapkan live. Tes worker 3/3 S6 lolos (38/38 file). |
| S6 | Fail-open bila tabel belum ada | **TERBUKTI (kode)** | `consumeOAuthState` `:392-400`: galat D1 dicatat + `return true`; komentar menjelaskan rate limit tetap melindungi kuota. `storeOAuthState` best-effort (`:335-366`, catch tanpa lempar). |
| R10 | `ALLOWED_ORIGINS` produksi tanpa localhost | **TERBUKTI (repo + deploy + live)** | `workers/sync/wrangler.toml:24` `[vars]` hanya `https://laras.adipmusic.my.id`; localhost hanya di `[env.dev.vars]` (`:32-34`). Nilai deploy koordinator `hidden_files/koordinator/deploy_sync.py` SUDAH diperbaiki (hanya domain produksi; catatan Blue 3 tentang nilai deploy yang masih localhost sudah kedaluwarsa). LIVE 19 Nov 2026, 3x OPTIONS ke `/api/sync/push` dengan `Origin: http://localhost:5173`: 204 TANPA `Access-Control-Allow-Origin` (Red 3 mendapat header itu; kini hilang). |
| R11 | WHERE `user_id` di upsert/tombstone playlist | **TERBUKTI (kode + tes)** | Upsert `:836` dan tombstone `:845`: `... AND sync_playlists.user_id = excluded.user_id`. Kepemilikan tidak bisa berubah lewat upsert (klausa SET tidak menyentuh `user_id`), jadi tidak ada TOCTOU kepemilikan. |
| R11 | Kolom `user_id` item + backfill + penolakan item orang lain | **TERBUKTI (kode + tes)** | `playlistOwned` `:810-826` (playlist di D1 harus milik pendorong; playlist baru hanya bila ikut dibuat di push yang sama; item yatim ditolak); insert item `:858` + tombstone item `:871` membawa `user_id`; `skippedNotOwned` dilaporkan di respons. Migrasi 0004: `ADD COLUMN user_id` + backfill dari playlist induk + `idx_items_user`. 5 tes R11 lolos di `syncWorker.test.ts` (38/38). Pull JUGA memfilter per user (semua 5 query `handlePull` memakai `user_id = ?`, item lewat join `p.user_id`), dan hapus akun menghapus item hanya lewat subquery playlist milik pengguna (`:1028-1036`), jadi delete tidak menyentuh item orang lain. |
| R12 | Cek `file.size` sebelum `arrayBuffer` | **TERBUKTI (kode)** | `ImportBackupDialog.tsx:82-86`: `file.size > MAX_BACKUP_BYTES` sebelum `arrayBuffer()` (`:87`), galat `tooLarge` langsung. Lapis kedua di `parseBackupBytes` dipertahankan. |
| R13 | Cap 10 MB + 30 lagu jalur file | **TERBUKTI (kode)** | `spotify.ts:67` `SPOTIFY_FILE_MAX_BYTES` 10 MB (cek dialog `:88-92` + lapis kedua parser `:165-171`); `SPOTIFY_FILE_MAX_TRACKS` 30 (`:76`, `capDraft` `:224-241` memotong + mencatat `totalTracks`); judul/artis dipotong 1.000 karakter (`:79`); UI menampilkan jumlah asli saat terpotong (`SpotifyImportDialog.tsx:310-318`, `strings.ts:416`); copy diperbarui (`id.ts:400,412`). Jalur tautan tetap 30 (`SPOTIFY_LINK_MAX_TRACKS`, `:64,664`). |
| R14 | Semua cap per-field/per-koleksi + cap antrean "Unduh ulang" | **TERBUKTI (kode)** | `format.ts:62-90` konstanta (teks 1.000, query 500, id 200, URL 2.048, artis/lagu 50, lagu/playlist 1.000, lagu/album/artis 50.000, playlist 1.000, riwayat 10.000, pencarian 100, antrean 200); `parseList` `:729-758` menolak bila melewati cap; `fromJsonV1` `:782-806` meneruskan tiap cap; `parseSettings` enum maks 100 karakter + `eqGains` maks 10 angka; `tokens.ts:45,48` (200 token unik + token maks 100 karakter); `service.ts:294-305` `MAX_REDOWLOAD_JOBS` 200 + `capRedownloadIds` dipakai dialog `:114` dengan laporan kelebihan (`backupRedownloadPartial`, `id.ts:369`). Semua jalur masuk data lain ikut dicek (lihat "Cap di semua jalur masuk data" di bawah). |
| R15 | Wipe memanggil logout dulu + copy jujur bila offline | **TERBUKTI (kode, dengan catatan R17/R18)** | `WipeFlow.tsx:64-90`: bila `signed-in`, `fetchLogout()` SEBELUM `wipeAllData`; gagal logout menampilkan peringatan + "Coba keluar lagi" / "Tetap hapus" (bukan lanjut diam-diam). `fetchLogout` memakai `credentials: 'include'` (`syncClient.ts:132,169-173`). Copy server di `id.ts:387,389,391`. Kontrak dicatat di `wipe.ts` kepala file. Catatan: verifikasi ujung-ke-ujung "wipe saat masuk, tunggu 20 detik, data TIDAK kembali" masih butuh sesi login sungguhan (lihat "Tidak bisa diverifikasi"); celah status `unknown` dan race sync-dalam-penerbangan dilaporkan sebagai temuan baru R17/R18, bukan sebagai kegagalan klaim ini (klaim Blue 3 menyangkut jalur `signed-in`, dan jalur itu benar). |
| R16 | Potong nama 100 karakter + try/catch `handleStart` | **TERBUKTI (kode)** | `spotify.ts:757-759`: `safeName` dipotong ke `MAX_PLAYLIST_NAME_LENGTH` (100) sebelum `createPlaylist`; `SpotifyImportDialog.tsx:128-139`: `try/finally` kini punya `catch` yang menampilkan `spotifyErrorImportFailed` (`id.ts:436`) + galat dirender di tampilan draf (`:340-348`). |
| I11 | Klasifikasi AbortError tanpa gate `instanceof` | **TERBUKTI (kode)** | 5 lokasi memakai cek `name` langsung: `downloadManager.ts:263-264` (+ `TimeoutError`), `chunkedDownloader.ts:137-142` (`isAbort`), `syncClient.ts:149-152`, `spotify.ts:592` (catatan: dokumen Blue 3 menyebut `:535-538`, nomor baris bergeser; perbaikannya ada di `:592`), `resilience/errors.ts:86-94`. |
| I12 | `parseCookies` try/catch | **TERBUKTI (kode + tes)** | `workers/sync/src/index.js:129-148`: decode per nilai dibungkus try/catch, nilai malformed dipakai mentah. Tes worker: cookie `%E0%A4%A` ke `/api/auth/me` menghasilkan 401, bukan 500 (lolos di 38/38). |
| I13 | Validasi record null LRCLIB | **TERBUKTI (kode)** | `lrclib.ts:115-118`: record bukan objek/null mengembalikan `{ status: 'not-found' }`. |
| I14 | nosniff/CSP halaman 503 | **TERBUKTI (kode + tes)** | `index.js:87,99` nosniff di `jsonError`/`jsonOk`; `:418-420` halaman 503 membawa nosniff + `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`. Tes worker lolos (38/38). |
| I15 | Tes rateLimit stabil | **TERBUKTI (tes 3x)** | `rateLimit.test.ts:136-144` mem-mock `Math.random` ke 0.99 selama penyiapan. Dijalankan Red 4 3x berturut-turut: 7/7 hijau setiap kali. |
| I16 | `db.batch` bukan transaksi atomik | **DIDOKUMENTASIKAN** (tanpa restrukturisasi, sesuai Blue 3; lihat I16 di atas) | Tidak ada klaim perbaikan untuk diverifikasi |
| I17/I18 | Header CPU / hash hardcode | **TETAP DITUNDA** (keputusan Blue 1, dipertahankan; hash masih sinkron, lihat I18 di atas) | Tidak ada klaim perbaikan untuk diverifikasi |

**Catatan koreksi kecil atas dokumen Blue 3 (bukan temuan):** nomor
baris `spotify.ts` untuk I11 bergeser (`:592`, bukan `:535-538`);
catatan tentang `deploy_sync.py:42` yang "masih memuat localhost"
sudah kedaluwarsa (koordinator sudah memperbaikinya, dan probe
live R10 mengonfirmasi). Isi perbaikannya sendiri benar di kedua
kasus.

---

## Verifikasi regresi Blue 1 + Blue 2 (semua bertahan)

| ID | Status Red 4 | Bukti |
|---|---|---|
| H1 (tinggi, chunk uji di produksi) | BERTAHAN | `App.tsx:35-54`: kedelapan rute uji digerbang `import.meta.env.DEV` termasuk lazy import-nya; `parseRoute` (`:101-108`) ikut digerbang. `app/dist/assets` (53 aset, build Blue 3): **0 chunk `*TestPage*`**, 1 chunk `SpikePage` (pengecualian koordinator). Gerbang CI masih ada di `ci.yml:53`. Chunk index live `index-DXhl4Bt5.js` sama dengan `app/dist/index.html`. |
| S1 (sedang, body POST dibaca penuh) | BERTAHAN | Proxy: `readCapped(request.body, MAX_BODY_BYTES)` + cek `Content-Length` awal. Pola yang sama dipakai worker sync (`handlePush`). Uji unit worker 20/20. |
| S2 (sedang, tanpa CSP) | BERTAHAN + LIVE | `app/public/_headers` utuh; **terkonfirmasi dari header live** `https://laras.adipmusic.my.id/` 19 Nov 2026 (2x): CSP persis sama dengan file (termasuk `'wasm-unsafe-eval'`, bukan `'unsafe-eval'`, `connect-src` kini memuat sync + lrclib + lyrics.ovh), `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`. |
| S3 (sedang, rate limit in-memory) | BERTAHAN (kode + live tidak langsung) | Proxy `rateLimit.js` + D1 masih dipakai; tidak ada `buckets` in-memory. Uji unit 7/7 (stabil, I15). Bukti live tidak langsung: rate limit callback sync (mekanisme D1 yang sama, `isRateLimited`) TERBUKTI live 10+1 429 ronde ini; verifikasi D1 proxy ASLI live (61+ request) masih belum dilakukan (hemat kuota). |
| S4 (sedang, config tanpa cap/versi) | BERTAHAN | Cap 4 MB + `version === 1` masih ditegakkan (`fetchConfig.ts`, `resolve.ts`); config remote live terverifikasi berisi `"version": 1` (19 Nov 2026). |
| R1 (rendah, redirect media tanpa validasi) | BERTAHAN | `redirect: 'manual'` (proxy `:226,341`), maks 3 hop, validasi host per hop, Content-Type allowlist + `nosniff`. |
| R2 (rendah, `decodeURIComponent` tanpa try/catch) | BERTAHAN | `App.tsx:parseRoute` try/catch; `main.tsx` ErrorBoundary. |
| R3 (rendah, SW cache-first + versi manual) | BERTAHAN | Navigasi network-first; cache runtime hanya aset statis; `app/dist/sw.js` berisi `SW_VERSION = '0.9.0-71925ff2'` (sama dengan build P8; `sw.js` tidak berubah di Blue 3). |
| R4 (rendah, CI tag `@v4`, tanpa permissions/audit) | BERTAHAN | `ci.yml`: ketiga action dipin SHA penuh, `permissions: contents: read` (`:9`), gerbang `npm audit --omit=dev --audit-level=high` (`:42`) + audit dev informasional + gerbang H1 (`:53`). Audit lokal tetap terblokir egress (lihat "Tidak bisa diverifikasi"). |
| R5 (rendah, cap client sesudah baca penuh) | BERTAHAN | `resolve.ts` base.js (8 MB) dan `innertube.ts` (10 MB) memakai `readCappedText`. |
| R6 (rendah, origin dev di CORS produksi) | BERTAHAN (proxy) | `workers/proxy/wrangler.toml`: `[vars]` hanya dua domain produksi; localhost hanya di `[env.dev.vars]`. |
| S5 (sedang, `JSON.parse` cache config) | BERTAHAN | `configStore.ts:135` `parseConfigText` dipakai ketiga jalur (`:231,245,314`); entri rusak dihapus best-effort. |
| R7 (rendah, re-resolve tanpa cek itag) | BERTAHAN | `downloadManager.ts:724` `currentItag`, `:742-746` lempar `ItagChangedError`, restart sekali dari byte 0, `formatId` memakai itag akhir. |
| R8 (rendah, SW Content-Type apa adanya) | BERTAHAN (sumber + dist) | `sw.js:103` `safeDownloadContentType` + `nosniff` di jalur 200 (`:165`) dan 206 (`:182`); `downloadStore.ts:124` memaksa tipe sebelum `cache.put`; `app/dist/sw.js` memuat fungsi itu (4 kecocokan). |
| R9 (rendah, race batal vs rakit) | BERTAHAN | `downloadManager.ts:821` cek abort sebelum `putDownload`, `:837` cek sebelum `markDownloaded` (+ hapus file bila batal di antaranya); `:801` cek sesudah unduh sebelum rakit. |
| I5 (enum snapshot) | BERTAHAN | `diagnostics.ts:236,241` `hasOwnProperty` untuk `KIND_LETTER`/`CAUSE_LETTER`. |
| I6 (tunggu 429 tak terbatalkan) | BERTAHAN | `downloadManager.ts:102` `sleepAbortable`, dipakai di cabang 429 (`:283`). |
| I7 (fallback `combineSignal`) | BERTAHAN | Fallback tanpa `AbortSignal.any` memakai `AbortController` gabungan + listener abort manual. |
| I1/I8/I17 (header CPU) | MASIH TERBUKA (sengaja) | Lihat I17. |
| I2/I9/I18 (hash hardcode) | MASIH TERBUKA (sengaja) | Lihat I18; ketiga salinan masih sinkron. |
| I3 (track lokal tanpa validasi URL) | BERTAHAN | `player/port.ts` `isSafeLocalUrl` + choke di `service.ts` sebelum `decidePath` (tidak berubah sejak Red 3). |
| I4 (sourcemap di dist) | BUKAN TEMUAN | Tetap sesuai putusan Red 1 (repo GPL publik). |
| I10 (versi worker live tak pasti) | TERTUTUP SEBAGIAN (lanjut) | Redeploy sync TERBUKTI live ronde ini (R10 + S6, keduanya perilaku kode Blue 3). Redeploy proxy D1 live (61+ request) masih belum dibuktikan langsung. |

---

## Cap di semua jalur masuk data (fokus koordinator untuk R14)

| Jalur masuk | Cap | Status |
|---|---|---|
| Backup file | 10 MB total + per-field/per-koleksi (R14) + cek ukuran sebelum baca (R12) | Lengkap |
| Spotify file/teks | 10 MB + 30 lagu + teks 1.000 karakter (R13) | Lengkap |
| Spotify tautan | 30 lagu + halaman 2 MB (proxy) | Lengkap (tidak berubah) |
| Sync push (server) | 1 MB body + 100 entri/koleksi + per-field (nama 100, deskripsi 500, title/artist 500, clientId 200, settings 4 KB) | Lengkap per-push; TOTAL per pengguna TIDAK ADA (S7) |
| Sync pull (server) | 1.000 baris/koleksi per pull | Lengkap per-pull; akumulasi antar-pull tidak dibatasi (S7) |
| Sync pull (klien) | Item 1.000/playlist (`insertPlaylistItemAt`); judul/token di-cap saat indeks | Playlist total TIDAK di-cap di klien (`createPlaylistFromRemote`, lapis kedua S7) |
| Pencarian YTM | 100 item/grup (parser), 10 MB respons | Lengkap (tidak berubah) |
| Lirik LRCLIB/lyrics.ovh | 1 MB + timeout 30 dtk | Lengkap (tidak berubah) |
| Config remote | 4 MB + versi 1 | Lengkap (tidak berubah) |
| "Unduh ulang" | 200 job/ketukan + laporan kelebihan | Lengkap (R14) |
| Unduhan chunk | 100 MB/file, antrean 200 (unduh ulang) | Lengkap (tidak berubah) |

---

## Verifikasi Origin di semua rute POST sync (fokus koordinator)

Semua handler POST di worker sync diperiksa satu per satu; tidak ada
yang berubah sejak Red 3 kecuali penambahan rate limit callback
(GET, bukan POST).

| Rute POST | Cek Origin | Rate limit | Bukti |
|---|---|---|---|
| `/api/auth/logout` | YA, sebelum auth | Tidak ada (self-limiting: sesi dihapus di pemakaian pertama) | `index.js:997` |
| `/api/auth/delete` | YA, sebelum auth | Tidak ada (self-limiting: akun+sesi dihapus di pemakaian pertama) | `index.js:1016` |
| `/api/sync/push` | YA, sesudah auth + rate limit, sebelum `handlePush` | 30/mnt/user | `index.js:1070` |
| `/api/auth/callback` (GET) | N/A (navigasi OAuth) | 10/mnt/IP (baru, S6) | `index.js:964` |
| `/api/auth/login` (GET) | N/A (navigasi OAuth) | 10/mnt/IP | `index.js` login |
| `/api/auth/me` (GET) | N/A (baca-saja) | 60/mnt/IP | `index.js` me |
| `/api/sync/pull` (GET) | N/A (baca-saja) | 30/mnt/user | `index.js` sync |

`isAllowedOrigin` (`:120`) tetap mengembalikan false bila header
`Origin` TIDAK ADA, jadi request tanpa Origin ditolak, bukan
diizinkan. Logout/delete tanpa rate limit dinilai BUKAN temuan:
keduanya menghapus otoritas pemanggilnya sendiri di pemakaian
pertama yang berhasil (sesi/akun hilang, panggilan berikut 401),
dan logout tanpa sesi tidak menulis D1 sama sekali.

---

## Yang DIPERIKSA dan bersih (baru di ronde ini + umum)

- **Sesi cookie benar.** Token 256 bit acak, hash SHA-256 di D1,
  cookie HttpOnly + Secure + `SameSite=None` (penyimpangan tercatat
  dari arsitektur §4.3 dengan alasan lintas-situs + mitigasi Origin;
  env `COOKIE_SAMESITE=Lax` tersedia), 30 hari, maks 10 sesi/user
  (sesi terlama dihapus), kedaluwarsa dicek di `authUser`, logout
  menghapus sesi spesifik itu. Tanpa `Domain` (host-only, benar).
- **Logika `oauth_states` benar kecuali race I19.** State 128 bit
  acak; yang disimpan hanya hash SHA-256 (bocor tabel tidak memberi
  state yang bisa dipakai); TTL 10 menit sama dengan cookie;
  sapu kedaluwarsa tiap login; provider dicocokkan; baris
  kedaluwarsa/salah provider ikut dihapus saat ditemui. Tabrakan
  hash SHA-256 dapat diabaikan. Fail-open saat D1 gagal adalah
  keputusan yang didokumentasikan dan dilindungi rate limit.
- **Kepemilikan R11 tidak punya TOCTOU.** Upsert playlist tidak
  pernah mengubah `user_id` (tidak ada di klausa SET), sehingga
  kepemilikan tidak berubah di antara cek `playlistOwned` dan
  eksekusi batch. `playlistOwned` mengabaikan `newPlaylistIds`
  bila baris sudah ada (cek kepemilikan yang menang), jadi
  penyerang tidak bisa "mengklaim" playlist orang lain dengan
  menyertakannya di push yang sama.
- **Pull dan hapus akun terikat user.** Lihat tabel verifikasi
  R11 di atas; tidak ada jalur baca/hapus lintas pengguna.
- **Nol XSS / eval liar / secret / telemetri / console.**
  NOL `dangerouslySetInnerHTML` / `innerHTML` DOM /
  `document.write` di `app/src` (`innerHTML` hanya di tes
  `WipeFlow.test.tsx:31`, bukan kode produksi; `new Function`
  hanya di komentar `evalEngine.ts:19`). Engine eval fallback
  hanya diimpor `evalFallbackWorker.ts` (harness spike, bukan
  kode app) dan TIDAK ADA chunk eval/fallback di `app/dist/`.
  NOL `console.*` di kode produksi. NOL pola secret di repo
  (satu-satunya kunci adalah kunci publik InnerTube, BUKAN
  temuan; client secret OAuth tidak ada di repo). NOL telemetri
  (grep `sendBeacon`/`WebSocket`/analytics nol;
  `XMLHttpRequest` hanya nama di daftar stub `playerScript.ts:480`).
- **Larangan `api.spotify.com` dipatuhi total.** Kedua string
  hanya muncul di komentar kode sebagai larangan dan di tes
  (termasuk tes yang menegaskan URL itu DITOLAK).
- **Dependensi produksi tidak berubah sejak Red 3.**
  Tidak ada dependensi baru di Blue 3 (hanya kode). picomatch
  GHSA-fc5q tetap diketahui dan tidak dilaporkan ulang
  (upgrade Vitest 5 terjadwal).
- **Hash player sinkron.** Lihat I18 di atas.

---

## Hasil tes

| Tes | Hasil |
|---|---|
| Vitest penuh | **750/750, 50 file** (177 dtk, `--configLoader runner --pool=threads`), exit 0 |
| `rateLimit.test.ts` (I15) | **7/7, 3x run berturut-turut** (Red 4) |
| `syncWorker.test.ts` (termasuk 10 tes baru S6/R11/I12/I14) | **38/38** |
| Uji unit worker proxy (`s7-unit-test.mjs`) | **20/20** |
| Typecheck / lint | Tidak dijalankan ulang ronde ini (Blue 3 melaporkan 0 error untuk keduanya; tidak ada kode yang diubah Red 4) |

---

## Probe live (19 Nov 2026, tanpa auth, tanpa data pengguna)

| Probe | Hasil |
|---|---|
| OPTIONS `/api/sync/push`, `Origin: http://localhost:5173` (3x) | 204 TANPA `Access-Control-Allow-Origin` (R10 TERBUKTI live) |
| Callback state tak dikenal (cookie cocok, state acak) | 302 `reason=state` (migrasi 0004 + single-use TERBUKTI live) |
| 11 callback dalam 1 menit, satu koneksi (06:12 UTC) | 10x 302 + ke-11 429 (rate limit S6 TERBUKTI live) |
| 11 callback paralel (metode tidak valid: IP egress berbeda per koneksi) | 9x 302 + 2x 000 (egress); BUKAN bukti rate limit mati, metode dibuang |
| Header `https://laras.adipmusic.my.id/` (2x) | CSP + nosniff + DENY + no-referrer sesuai `_headers` (S2 live) |
| Config remote `player-config.json` (2x) | `version: 1`, ketiga hash sama dengan repo (I18 sinkron) |
| `cdn-cgi/trace` (IP egress) | IPv6 `2606:54c1:1:eff::23d:96` (satu sampel; rotasi IP antar koneksi paralel teramati) |

Total sekitar 40 request; tidak ada yang menyentuh data pengguna,
tidak ada login, tidak ada penulisan D1 atas nama pengguna.

---

## Yang TIDAK bisa diverifikasi + alasannya

- **`npm audit` (gerbang R4).** Endpoint audit npm diblokir
  egress proxy VM (403 `policy_denied`, terverifikasi di ronde
  sebelumnya, sama seperti Red 1/2/3 dan Blue 1/2/3). CI run
  adalah bukti sahnya; picomatch GHSA-fc5q sudah diketahui dan
  didokumentasi, bukan temuan baru.
- **Wipe saat masuk, tunggu 20 detik, data TIDAK kembali (R15
  ujung-ke-ujung).** Butuh sesi login sungguhan (kredensial
  owner); Red 4 hanya memverifikasi kode + `credentials:
  include`. Menjadi tugas koordinator dengan akun uji.
- **Rate limit D1 proxy live (S3, 61+ request).** Pembuktian
  butuh 61+ request live (membakar kuota harian + menembak
  upstream); sengaja tidak dilakukan. Kode + uji unit worker
  + bukti live tidak langsung (rate limit callback sync yang
  memakai helper D1 yang sama terbukti live) adalah bukti yang
  dipakai.
- **Round-trip OAuth live penuh.** Login sungguhan Google dan
  GitHub diverifikasi koordinator 19 Nov 2026 (dinyatakan di
  penugasan Red 3); ronde ini tidak mengulang login live (butuh
  kredensial owner) dan hanya memverifikasi sisi tanpa-auth
  (401 tanpa cookie, 400 provider tak dikenal, penolakan state
  tak dikenal, rate limit callback). Verifikasi koordinator
  diterima sebagai bukti untuk alur login.
- **Data sesi/token di D1.** Sengaja TIDAK di-query (sesuai
  penugasan: cukup baca skema + kode). Skema dibaca dari
  `0001_init.sql` + migrasi 0004; perilaku sesi dibuktikan dari
  kode + endpoint publik tanpa auth. Keberadaan tabel
  `oauth_states` live dibuktikan SECARA TIDAK LANGSUNG lewat
  perilaku callback (`reason=state` vs `reason=exchange`),
  bukan lewat query D1.
- **Perilaku SW di browser nyata + E2E Playwright penuh.**
  Termasuk serving `/dl/` dengan Range dan network-first
  navigasi di browser nyata; Chromium tidak bisa jalan andal
  di sandbox ini (gelombang EPERM). Bukti terbaik adalah E2E
  P7/P8 + Blue 3 yang sudah lolos di VM tim sebelumnya + CI,
  Vitest `sw.test.ts`, dan `app/dist/sw.js` hasil build Blue 3
  yang terverifikasi memuat perbaikan R8.
- **Unduh live ujung-ke-ujung + unduh ulang massal.**
  googlevideo memblokir IP VM (vonis S3); kaki live sudah
  dicatat sebagai utang dan bukan ranah audit ini.
- **Probe curl ke worker proxy dari VM.** Tidak diulang ronde
  ini (Red 3 mencatat TLS berhasil tetapi 0 byte diterima;
  gangguan egress VM, bukan worker mati). Tidak ada kesimpulan
  keamanan yang ditarik dari jalur itu.

---

## Rekomendasi urutan perbaikan untuk Blue 4

1. **S7** - tegakkan batas total per pengguna di `handlePush`
   (satu-satunya temuan sedang; COUNT per tabel sebelum batch,
   tolak bila melewati batas arsitektur §4.3) + cap total
   playlist di `createPlaylistFromRemote` sebagai lapis kedua.
2. **R17** - wipe memanggil logout bila status `signed-in` ATAU
   `unknown` (atau `refreshAuth()` dulu bila `unknown`); tampilkan
   peringatan yang sama bila logout gagal di jalur itu.
3. **R18** - wipe menunggu putaran sync selesai (atau token
   generasi di `applyPull`) supaya tarik yang sedang berjalan
   tidak membangkitkan data sesudah penghapusan database.
4. **I19** - jadikan `consumeOAuthState` atomik (satu DELETE
   berkondisi + cek `meta.changes`).
5. **Koordinator (bukan Blue):** verifikasi R15 ujung-ke-ujung
   (wipe saat masuk, tunggu 20 detik, data TIDAK kembali) dengan
   akun uji; cabut `x-proxy-cpu-ms` (I17) dan rancang sumber hash
   remote (I18) saat promosi produksi; gerbang `npm audit` di run
   CI; pertimbangkan pemantauan kuota tulis D1 (peringatan jauh
   sebelum 100 ribu baris/hari, karena S7 menunjukkan satu akun
   bisa menghabiskannya dalam hitungan menit).

**Red 5 (sesudah Blue 4):** verifikasi S7 dengan tes worker
(pengguna di ambang 100 playlist ditolak di playlist ke-101;
push berulang tidak melewati total); verifikasi R17 (wipe saat
status `unknown` memicu logout/peringatan); verifikasi R18
(pull yang resolve sesudah wipe tidak menulis ke database segar);
verifikasi I19 (dua callback paralel, satu state, hanya satu
yang lanjut); plus audit permukaan baru apa pun yang mendarat
sesudah P9.
