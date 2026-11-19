# Red 3 - Audit Keamanan Laras Web (P7 + P8, Release Candidate)

**Tanggal:** 19 November 2026.
**Auditor:** Tim Red 3 - audit statis + tes unit + probe live terbatas
( endpoint publik tanpa auth).
**Ruang lingkup:** permukaan serangan baru P7 (lirik LRCLIB, EQ, timer
tidur, sinkronisasi OAuth + D1) dan P8 (backup JSON, impor merge, hapus
semua data, impor Spotify tanpa API, rute proxy `/api/spotify-page`),
worker `laras-sync` (`workers/sync/src/index.js`), perubahan P8 di
`workers/proxy/src/index.js`, plus verifikasi regresi seluruh temuan
Red 1 dan Red 2.
**HEAD yang diaudit:** workdir `~/workspace/music-app-web/` per 19 Nov
2026 (P8 + perbaikan koordinator; `git log` lokal basi dan tidak dipakai
sebagai acuan, sesuai catatan AGENTS.md tentang push via API).
**Metode:** baca kode penuh jalur sensitif P7/P8 dan kedua worker, grep
pola berbahaya, jalankan Vitest penuh, probe live hemat kuota ke domain
produksi dan kedua worker (7 request total, tanpa auth, tanpa menyentuh
data pengguna), dan verifikasi `dist/` hasil build P8 di disk.
Tanpa Playwright E2E dan tanpa browser (Chromium tidak stabil di sandbox
saat audit; dicatat di "Tidak bisa diverifikasi"). Red HANYA audit:
tidak ada kode produksi yang diubah; satu-satunya file yang ditulis
adalah laporan ini.
**Catatan penomoran:** temuan melanjutkan penomoran Red 2 (S6, R10-R16,
I11-I18).

## Ringkasan vonis

| Tingkat | Jumlah |
|---|---|
| Kritis | **0** |
| Tinggi | **0** |
| Sedang | **1** |
| Rendah | **7** |
| Info | **8** |
| **Total** | **16** |

**Vonis: LAYAK LANJUT KE BLUE 3, dengan satu temuan sedang (S6) yang
wajib ditutup sebelum release candidate.** Tidak ada temuan kritis atau
tinggi. Seluruh perbaikan Blue 1 dan Blue 2 MASIH bertahan (H1, S1-S5,
R1-R9, I5-I7 terverifikasi ulang di bawah). Fondasi P7/P8 kuat: alur
OAuth benar (state acak, tukar kode di server, sesi hash SHA-256),
validasi Origin ada di SEMUA rute POST worker sync, otorisasi baca
per-user benar di semua query pull, parser backup ketat (cap 10 MB,
versi, integritas referensi, merge satu transaksi), rute
`/api/spotify-page` tervalidasi ketat dan terbukti live, CSP live
terkonfirmasi dari header produksi, dan larangan `api.spotify.com`
dipatuhi total (nol panggilan, hanya disebut di komentar).
Satu-satunya lubang berarti adalah S6: endpoint callback OAuth adalah
satu-satunya endpoint tanpa rate limit dan state-nya bisa dipakai ulang
tanpa batas di server, sehingga satu IP bisa membakar kuota harian akun
dan mematikan proxy inti untuk semua pengguna.

---

## Temuan sedang

### S6 - `/api/auth/callback` tanpa rate limit dan state bisa dipakai ulang tanpa batas di server

**Tingkat: sedang.** **File:**
`workers/sync/src/index.js:421-493` (`handleCallback`),
`workers/sync/src/index.js:337` (state dibuat),
`workers/sync/src/index.js:181-199` (`checkRateLimit`).

**Bukti:**
- `handleCallback` TIDAK PERNAH memanggil `checkRateLimit`.
  Bandingkan dengan semua endpoint lain yang memakai pembatas:
  login (`:332`, 10/mnt/IP), `/api/auth/me` (`:823`, 60/mnt/IP),
  pull/push (`:896`, 30/mnt/user). Callback adalah satu-satunya
  endpoint tanpa pembatas apa pun.
- State TIDAK single-use di sisi server. State hanya disimpan di
  cookie (`stateCookieHeader`, `:163`) dan dicocokkan string
  (`:437-442`); tidak ada tabel/penanda "state sudah dipakai" di
  D1. `clearStateCookieHeader()` sesudah sukses/gagal hanya
  instruksi ke browser; penyerang terskrip mengabaikan `Set-Cookie`
  dan memakai ulang cookie state yang sama tanpa batas.
- Satu state didapat dari SATU request login (dibatasi 10/mnt/IP,
  tetapi satu saja sudah cukup). Setiap panggilan callback dengan
  state itu memicu `exchangeCode` (`:460-465`): satu fetch ke
  endpoint token Google/GitHub (timeout 15 dtk), lalu `fetchProfile`
  bila kode valid. Kode auth tidak bisa ditebak (bukan vektor
  brute-force akun), tetapi tiap panggilan membakar satu request
  Worker + satu subrequest upstream + waktu CPU isolate.
- Kuota yang dipertaruhkan adalah kuota akun: 100.000 request/hari
  (arsitektur §2.1, reset 00:00 UTC, lewat batas menjadi Error 1027
  dan produk dimatikan sampai reset). Endpoint lain dibatasi
  per-IP sehingga satu IP tidak bisa membakar kuota sendirian
  (mis. `/api/auth/me` 60/mnt/IP hanya mencapai ~86.400/hari bila
  dipukul tanpa henti); callback tanpa batas bisa membakar 100.000
  request dalam waktu kurang dari satu jam dari satu IP, dan karena
  kuota dipakai bersama worker lain di akun yang sama, proxy
  InnerTube (pencarian, streaming, unduhan) ikut mati untuk SEMUA
  pengguna. Preseden tingkat: Red 1 menilai S3 (rate limit
  in-memory yang bisa dilewati untuk membakar kuota) sebagai
  sedang dengan alasan yang sama.

**Dampak:** DoS ketersediaan seluruh layanan (sync + proxy inti)
dari satu IP, plus relay gratis ke endpoint token Google/GitHub
yang bisa memicu deteksi abuse di sisi provider atas client
OAuth app ini.
**Rekomendasi (Blue):**
1. Terapkan rate limit pada callback seperti login
   (`auth-callback:<ip>`, 10/mnt/IP), dicek SEBELUM tukar kode.
2. Jadikan state single-use di server: simpan hash state di D1
   saat login (tabel kecil + TTL 10 menit, dihapus saat dipakai);
   callback menolak state yang sudah dipakai atau tidak dikenal.
   Bila (2) dianggap terlalu berat, (1) saja sudah menutup vektor
   pembakaran kuota; (2) menutup pemakaian ulang sepenuhnya.
3. Tambahkan tes worker: 11 callback cepat dari satu IP (state
   valid, kode palsu) menghasilkan 10 diproses + 1 ditolak 429;
   callback kedua dengan state yang sama ditolak (bila (2)
   diterapkan).

---

## Temuan rendah

### R10 - `ALLOWED_ORIGINS` produksi worker sync memuat localhost (terkonfirmasi live)

**Tingkat: rendah.** **File:** `workers/sync/wrangler.toml`
(`[vars]`, `ALLOWED_ORIGINS`), `workers/sync/src/index.js:109-116`
(`isAllowedOrigin`), `:99-107` (`corsHeaders`).

**Bukti:**
- `[vars]` produksi (bukan `[env.dev]`) berisi:
  `https://laras.adipmusic.my.id,http://localhost:5173,http://localhost:4173`.
  Pola yang sama sudah diperbaiki di proxy oleh Blue 1 (R6:
  localhost hanya di `[env.dev.vars]`); worker sync yang baru di
  P7 mengulanginya.
- Terkonfirmasi LIVE 19 Nov 2026 (probe OPTIONS ke
  `https://laras-sync.hiroohengkerr.workers.dev/api/sync/push`):

```
Origin: http://localhost:5173
-> Access-Control-Allow-Origin: http://localhost:5173
-> Access-Control-Allow-Credentials: true
```

  Origin jahat (`https://evil.example.com`) benar-benar TIDAK
  mendapat `Access-Control-Allow-Origin` (kontrol negatif lolos),
  jadi allowlist bekerja, hanya saja localhost memang dipercaya.
- Dampaknya langsung pada mitigasi CSRF: cookie sesi memakai
  `SameSite=None`, sehingga SATU-SATUNYA yang menghalangi situs
  lain memakai sesi korban adalah cek `Origin` di POST
  (logout `:841`, delete `:860`, push `:914`). Konten web apa pun
  yang disajikan dari `http://localhost:5173` atau `:4173` di
  mesin korban (server dev Vite, layanan lokal lain, atau halaman
  berbahaya yang berhasil disajikan lokal) lolos cek itu dan bisa
  memanggil POST push/delete dengan cookie korban
  (`Allow-Credentials: true`). Pengguna produk ini adalah developer
  yang rutin menjalankan server dev di port 5173/4173, jadi
  skenarionya bukan hipotesis jauh.

**Dampak:** melemahnya satu-satunya lapisan CSRF untuk tiga
endpoint pengubah state, termasuk hapus akun.
**Rekomendasi (Blue):** hapus kedua localhost dari `[vars]`
produksi; bila pengujian lokal butuh, tambahkan `[env.dev.vars]`
seperti proxy (R6). Redeploy worker sync, lalu verifikasi live:
OPTIONS dengan `Origin: http://localhost:5173` tidak lagi
mendapat `Access-Control-Allow-Origin`.

### R11 - Push playlist dan item playlist tanpa cek kepemilikan per-user

**Tingkat: rendah.** **File:**
`workers/sync/src/index.js:699` (upsert playlist),
`:717` (upsert item), `:726` (tombstone item),
`workers/sync/0001_init.sql` (skema `sync_playlist_items` tanpa
kolom `user_id`).

**Bukti:**
- Upsert playlist cocok HANYA pada `id` (clientId dari klien)
  tanpa `user_id` di klausa `WHERE`:

```sql
... ON CONFLICT(id) DO UPDATE SET nama = excluded.nama, ...
WHERE excluded.updated_at > sync_playlists.updated_at OR ...
```

  Bila user A mendorong playlist dengan `clientId` yang sama
  dengan playlist user B, baris B ditimpa (nama, deskripsi,
  `device_id`, `deleted_at`) karena `updated_at` dorongan A
  (jam server saat push) selalu lebih baru. Varian tombstone
  (`deletedPlaylists`, `:708-715`) bisa menghapus playlist B
  dengan cara yang sama.
- Item playlist lebih longgar lagi: tabel `sync_playlist_items`
  tidak punya kolom `user_id` sama sekali, dan push item tidak
  memverifikasi bahwa `playlist_id` yang dirujuk adalah milik
  pendorong. Pull memang memfilter lewat join
  (`WHERE p.user_id = ?`), tetapi pull yang benar tidak menutup
  tulis yang tidak dicek.
- Penyeimbang yang membuat tingkatnya rendah, bukan tinggi:
  clientId berbentuk `<UUID perangkat>:<id lokal kecil>`
  (`syncService.ts:collectPushBody`, `deviceId.ts` memakai
  `crypto.randomUUID()`), tidak pernah terekspos publik (file
  backup TIDAK membawa clientId; pull hanya mengembalikan data
  milik pendorong sendiri), sehingga penyerang harus sudah
  mengetahui UUID perangkat korban (128 bit, tidak bisa ditebak)
  untuk mengeksploitasi. Tidak ada jalur bocor clientId yang
  ditemukan di ronde ini. Ini adalah celah otorisasi yang nyata
  tetapi belum punya jalur eksploitasi praktis; ia menjadi
  kritis bila suatu hari clientId terekspos (mis. fitur berbagi
  playlist atau backup yang membawa clientId).

**Dampak:** tulis lintas pengguna pada playlist (ubah nama,
hapus, tambah/kurangi lagu) bagi siapa pun yang mengetahui
clientId korban; item yatim (playlist_id tanpa playlist) juga
diterima dan menumpuk di D1.
**Rekomendasi (Blue):**
1. Tambahkan `AND sync_playlists.user_id = ?` (user pendorong)
   di klausa `WHERE` upsert playlist dan tombstone playlist.
2. Sebelum insert item, verifikasi playlist pemiliknya
   (`SELECT 1 FROM sync_playlists WHERE id = ? AND user_id = ?`);
   tolak item untuk playlist yang bukan milik pendorong atau
   tidak ada (sekaligus menutup item yatim).
3. Tambahkan tes worker: user B mendorong item/nama untuk
   clientId milik user A, lalu pull user A tidak berubah.

### R12 - Impor backup membaca seluruh file ke memori SEBELUM cek cap 10 MB

**Tingkat: rendah.** **File:**
`app/src/components/settings/ImportBackupDialog.tsx:71`,
`app/src/backup/format.ts:384-387` (`parseBackupBytes`).

**Bukti:**

```tsx
const bytes = new Uint8Array(await file.arrayBuffer());  // baca SELURUH file
setData(previewImport(bytes));  // cek 10 MB baru di dalam sini
```

`parseBackupBytes` sendiri benar (cek `bytes.length >
MAX_BACKUP_BYTES` sebelum decode/parse), tetapi pemanggilnya
sudah mengalokasikan seluruh file di memori tab lebih dulu.
File 500 MB atau 2 GB yang dipilih pengguna (salah pilih atau
file "backup" buatan yang dibagikan) membuat tab kehabisan
memori SEBELUM penolakan `tooLarge` sempat jalan. Ini pola yang
persis sama dengan Red 1 S1 (proxy) dan R5 (client) yang sudah
diperbaiki di tempat lain dengan cek-awal / baca-bercap.
**Dampak:** tab freeze/OOM dari satu pemilihan file; penolakan
cap menjadi tidak berguna untuk file sangat besar.
**Rekomendasi (Blue):** cek `file.size > MAX_BACKUP_BYTES`
sebelum `arrayBuffer()` dan tampilkan galat `tooLarge` langsung
(cek di `parseBackupBytes` tetap dipertahankan sebagai lapis
kedua). Terapkan pola yang sama di jalur Spotify (lihat R13).

### R13 - Impor Spotify jalur file tanpa cap ukuran maupun jumlah lagu

**Tingkat: rendah.** **File:**
`app/src/components/settings/SpotifyImportDialog.tsx:84`
(`handleFile`), `app/src/backup/spotify.ts:136`
(`parseSpotifyFile`), `:190` (teks), `:240` (CSV), `:353` (JSON),
`:609-700` (`importDraft`, loop pencocokan tanpa batas).

**Bukti:**
- Tidak ada cek `file.size`, tidak ada cap byte di
  `parseSpotifyFile` (berbeda dengan backup yang punya
  `MAX_BACKUP_BYTES` dan jalur tautan yang punya
  `SPOTIFY_PAGE_MAX_BYTES` 2 MB), dan tidak ada cap jumlah lagu
  di ketiga parser maupun di `importDraft`. Jalur tautan dibatasi
  30 lagu (`SPOTIFY_LINK_MAX_TRACKS`); jalur file tidak dibatasi
  sama sekali.
- Konsekuensi berantai dari satu file buatan: JSON ratusan MB
  dengan jutaan entri di-decode + `JSON.parse` penuh ke memori,
  lalu `importDraft` menembak SATU pencarian YTM per lagu
  (jeda 150 ms) lewat proxy. 10.000 lagu berarti ~25 menit
  request berurutan dan ribuan request proxy; 100.000 lagu
  berarti berjam-jam. Tombol Berhenti ada, tetapi parse raksasa
  terjadi SEBELUM pengguna melihat jumlah lagu, dan antrean
  pencarian sudah membakar kuota sejak tombol Mulai ditekan.
- Vektornya self-inflicted (pengguna harus memilih/menempel
  file), tetapi file daftar lagu adalah artefak yang dibagikan
  (ekspor Spotify, template komunitas), sama seperti file backup.

**Dampak:** tab beku/OOM saat parse + pembakaran kuota proxy
dan D1 rate limit yang berkepanjangan dari satu file.
**Rekomendasi (Blue):** samakan dengan backup: tolak file
`> 10 MB` sebelum `arrayBuffer()`; potong daftar ke mis.
1.000 lagu dengan `truncated: true` + pemberitahuan jujur di UI
(mengikuti pola jalur tautan); hentikan pencocokan bila daftar
melebihi cap.

### R14 - Parser backup tanpa cap per-field dan per-koleksi

**Tingkat: rendah.** **File:**
`app/src/backup/format.ts:400-700` (parse per bagian),
`app/src/data/library.ts:2479` (`mergeBackupData`),
`app/src/data/tokens.ts:25-29` (`uniqueTokens`),
`app/src/downloads/downloadManager.ts:487` (`enqueue` tanpa cap
jumlah job).

**Bukti:**
- Satu-satunya cap adalah cap TOTAL file 10 MB. Tidak ada cap
  panjang per string (judul lagu, nama artis/album, deskripsi
  di luar playlist, query pencarian) dan tidak ada cap jumlah
  entri per koleksi (lagu, album, artis, playlist, riwayat
  putar). Yang dibatasi hanya antrean (200, `format.ts`) dan
  nama/deskripsi playlist (100/500, dipotong saat merge).
- Tiga amplifikasi konkret dari satu file 10 MB yang dibuat
  dengan sengaja:
  1. Satu judul 5 MB berisi kata-kata unik: `uniqueTokens`
     (tanpa cap jumlah maupun panjang token) menghasilkan
     ratusan ribu baris `token_index` dalam satu transaksi
     merge (`library.ts`, blok token), memperlambat impor dan
     membengkakkan IndexedDB.
  2. ~50.000 playlist kosong (masing-masing puluhan byte):
     merge membuat 50.000 baris playlist + 50.000 `touchPlaylist`
     dalam satu transaksi.
  3. ~50.000 lagu berflag `downloaded`: sesudah impor, satu
     ketukan "Unduh ulang" memanggil `enqueue` tanpa batas
     jumlah job (`downloadManager.ts:487` tidak memeriksa
     jumlah antrean), mengantre puluhan ribu unduhan.
- Penyeimbang: file harus diimpor pengguna sendiri (bukan
  muatan jarak jauh), dan merge satu transaksi berarti gagal
  di tengah tidak meninggalkan data separuh. Tingkatnya rendah
  karena pemicunya butuh file buatan + tindakan pengguna.

**Dampak:** IndexedDB membengkak, impor lambat, antrean unduhan
teracuni dari satu file salinan buatan.
**Rekomendasi (Blue):** tambahkan cap per-field di parser
(mis. judul/nama maks 1.000 karakter, query maks 500 karakter,
tolak atau potong dengan pencatatan) + cap jumlah entri per
koleksi (mis. lagu 50.000 sesuai hitungan PRD B10.1, playlist
1.000) + cap jumlah job unduhan ulang (mis. 200, sisanya
dilaporkan sebagai dilewati).

### R15 - Hapus semua data tidak mengakhiri sesi sinkronisasi: data kembali 20 detik sesudah wipe

**Tingkat: rendah.** **File:**
`app/src/backup/wipe.ts` (tidak ada pemanggilan logout),
`app/src/components/settings/WipeFlow.tsx`,
`app/src/App.tsx:210-220` (sinkron otomatis 20 detik),
`app/src/strings/id.ts:379-387` (copy wipe).

**Bukti:**
- `wipeAllData` menghapus IndexedDB + Cache Storage +
  localStorage `laras.*`, tetapi TIDAK memanggil
  `POST /api/auth/logout` dan TIDAK BISA menghapus cookie sesi
  (HttpOnly, diakui di `wipe.ts` sebagai "tidak dihapus").
  Sesi di server tetap hidup 30 hari.
- Sesudah wipe, `WipeFlow` me-reload halaman. Saat boot,
  `App.tsx:210` menjadwalkan (20 detik):

```tsx
await useSyncStore.getState().refreshAuth();
if (useSyncStore.getState().status === 'signed-in') {
  void useSyncStore.getState().syncNow();
}
```

  Cookie sesi masih ada, jadi status `signed-in`, dan karena
  penanda `sync-last-pull` ikut terhapus bersama IndexedDB,
  pull berjalan dengan `since=0`: SELURUH playlist, suka,
  riwayat, dan pengaturan dari server ditulis kembali ke
  database lokal yang baru kosong. Dorong berikutnya lalu
  mengirim state hasil pull itu kembali (tidak ada data server
  yang terhapus).
- Copy UI menjanjikan tanpa kualifikasi: "Semua lagu, playlist,
  favorit, riwayat, dan file unduhan akan dihapus dari perangkat
  ini." dan "Sesudah ini, app kembali kosong seperti baru
  dipasang." Tidak satu kata pun menyebut sinkronisasi. Bagi
  pengguna yang masuk, janji itu salah: 20 detik kemudian
  datanya kembali tanpa penjelasan.
- Ini bukan kebocoran ke pihak ketiga (data kembali dari akun
  pengguna sendiri), sehingga tingkatnya rendah, bukan sedang.
  Tetapi ini melanggar ekspektasi privasi dari aksi destruktif
  yang paling tegas di app ("hapus semuanya", dua konfirmasi).

**Dampak:** pengguna yang menghapus data karena alasan privasi
(mis. menjual/meminsjamkan perangkat) mendapati datanya pulih
sendiri; penghapusan terasa tidak bisa dipercaya.
**Rekomendasi (Blue):**
1. Di alur wipe, bila status `signed-in`, panggil
   `POST /api/auth/logout` (best-effort, sebelum reload)
   supaya sinkron otomatis tidak berjalan sesudah wipe.
2. Tambahkan kalimat jujur di dialog wipe untuk pengguna yang
   masuk: data di server tetap ada sampai akun dihapus, dengan
   tautan ke hapus akun di seksi Sinkronisasi.
3. Pertimbangkan opsi "hapus juga data di server" (memakai
   endpoint delete yang sudah ada) sebagai pilihan eksplisit
   di dialog kedua, bukan perilaku diam-diam.

### R16 - Nama playlist impor Spotify tidak divalidasi panjangnya: impor gagal diam-diam

**Tingkat: rendah.** **File:**
`app/src/backup/spotify.ts:750` (`importDraft`),
`app/src/data/library.ts:1059` (`createPlaylist`,
`validatePlaylistName` maks 100 karakter),
`app/src/components/settings/SpotifyImportDialog.tsx:122-141`
(`handleStart` tanpa `catch`).

**Bukti:**
- Nama playlist baru berasal dari `og:title` halaman Spotify
  atau nama file pengguna, keduanya tanpa batas panjang, lalu
  diteruskan apa adanya ke `library.createPlaylist()`, yang
  MELEMPAR bila nama lebih dari 100 karakter
  (`validatePlaylistName`, `library.ts:3181`).
- `importDraft` tidak memotong atau memvalidasi nama sebelum
  memanggilnya (berbeda dengan merge backup yang memotong nama
  ke 100 karakter, `library.ts:2696-2698`), dan
  `handleStart` di dialog memakai `try/finally` TANPA `catch`,
  dipanggil lewat `void handleStart()`. Hasilnya: nama lebih
  dari 100 karakter membuat impor gagal dengan unhandled
  rejection, tanpa pesan galat apa pun; dialog tetap di layar
  draf dengan tombol Mulai yang akan gagal lagi dengan cara
  yang sama bila ditekan ulang. Pengguna tidak diberi petunjuk
  bahwa nama yang terlalu panjang adalah penyebabnya.
- Pemicu realistis: `og:title` playlist Spotify yang panjang
  atau nama file ekspor yang panjang; pengguna bisa
  mempersingkat manual di kolom nama, tetapi hanya bila ia
  menebak penyebabnya sendiri.

**Dampak:** jalan buntu tanpa pesan untuk impor yang sah;
pengalaman gagal yang tidak bisa didiagnosis pengguna.
**Rekomendasi (Blue):** potong nama ke 100 karakter di
`importDraft` (mengikuti merge) ATAU validasi di dialog dengan
pesan jelas; tambahkan `catch` di `handleStart` yang
menampilkan galat ke pengguna (pola yang sama sudah ada di
`handleRestore` impor backup).

---

## Info

### I11 - Klasifikasi `AbortError` memakai `instanceof Error`, padahal abort fetch asli adalah DOMException

**File:** `app/src/downloads/downloadManager.ts:262-264`,
`app/src/downloads/chunkedDownloader.ts:139`,
`app/src/sync/syncClient.ts:149`. (Observasi bawaan Blue 2,
terkonfirmasi di ronde ini.)
`DOMException` bukan turunan `Error`
(`new DOMException() instanceof Error` bernilai false), sehingga
cek `error instanceof Error && error.name === 'AbortError'`
tidak pernah cocok untuk abort/timeout fetch yang nyata.
Akibatnya: pembatalan unduhan jatuh ke `RetryableError` dulu dan
baru dihentikan `throwIfAborted` di puncak loop (tertunda satu
siklus backoff); timeout sinkron 30 detik dilaporkan sebagai
galat jaringan, bukan timeout. Dampak terbatas (batal tetap
jalan, hanya tertunda; pesan galat sync sama di UI), sehingga
ini info, bukan temuan rendah. Rekomendasi: cek
`(error as { name?: unknown })?.name === 'AbortError'` tanpa
gate `instanceof`, atau terima `DOMException` secara eksplisit.

### I12 - `parseCookies` memakai `decodeURIComponent` tanpa try/catch

**File:** `workers/sync/src/index.js:118-126`. Nilai cookie
dengan urutan `%` yang malformed membuat `decodeURIComponent`
melempar `URIError`. Lemparan ditangkap `try/catch` router
(`:800-an`) sehingga hasilnya hanya respons 500 untuk request
itu saja (bukan crash worker), dan cookie worker hanya ditulis
oleh worker sendiri, sehingga pemicunya sempit. Rekomendasi:
bungkus decode per nilai dengan try/catch (nilai rusak dilewati
atau dipakai mentah).

### I13 - `recordToResult` LRCLIB tidak memvalidasi record null

**File:** `app/src/lyrics/lrclib.ts:110-125,187`. Bila `/api/get`
mengembalikan JSON literal `null` dengan HTTP 200,
`record.instrumental` melempar `TypeError` DI LUAR blok try
(parse dibungkus, pemanggilan `recordToResult` tidak). Lemparan
ditangkap `.catch()` di `LyricsPanel` sehingga tampil sebagai
status galat (bukan crash app), tetapi klasifikasi salah
(seharusnya `not-found` atau `error` yang terkendali).
Jalur `/api/search` dan lyrics.ovh aman (ada `Array.isArray` /
optional chaining). Rekomendasi: tolak record bukan objek di
awal `recordToResult` (kembalikan `not-found`).

### I14 - Respons worker sync tanpa `X-Content-Type-Options`; halaman 503 tanpa CSP

**File:** `workers/sync/src/index.js:73-95` (`jsonError`/`jsonOk`),
`:285-307` (`setupPendingPage`). Semua respons JSON worker sync
tidak membawa `nosniff`, dan halaman HTML 503 (yang
menginterpolasi `appUrl(env)` dari variabel lingkungan,
bukan dari input pengguna, jadi bukan vektor injeksi) tidak
membawa CSP maupun `nosniff`. Risiko langsung minimal (JSON
tidak di-render sebagai HTML oleh browser modern; halaman 503
statis), ini defense-in-depth. Rekomendasi: tambahkan
`X-Content-Type-Options: nosniff` di `jsonError`/`jsonOk` dan
`Content-Security-Policy: default-src 'none'; style-src
'unsafe-inline'` di halaman 503.

### I15 - Satu tes `rateLimit` flaky (sapu probabilistik 1 persen)

**File:** `app/src/worker/rateLimit.test.ts:129-137`,
`workers/proxy/src/rateLimit.js` (sapu `Math.random() < 0.01`
di dalam `isRateLimited`). Run Vitest penuh ronde ini:
**714/715**; satu-satunya kegagalan adalah tes sapu
(`expect(db.rows.size).toBe(2)`) karena sapu acak 1 persen
menyala di dalam `isRateLimited` kedua dan menghapus baris
jendela lama sebelum asersi. Re-run file itu 3 kali: 7/7 hijau
semua. Perilaku produk BENAR (sapu memang harus menghapus
baris lama); yang rapuh adalah tesnya. Rekomendasi: mock
`Math.random` di tes itu, atau pisahkan sapu dari
`isRateLimited` supaya bisa diuji deterministik.

### I16 - `db.batch` push/hapus akun bukan transaksi atomik D1

**File:** `workers/sync/src/index.js` (push `:773-775`, hapus
akun `:872-890`). D1 `batch` menjalankan pernyataan berurutan,
bukan dalam satu transaksi: gagal di tengah bisa menerapkan
sebagian push atau sebagian penghapusan. Dampak dibatasi oleh
desain: upsert push idempotent (dorong ulang memperbaiki
keadaan) dan urutan hapus menempatkan `users` TERAKHIR sehingga
gagal di tengah meninggalkan akun yang masih utuh dan bisa
mencoba hapus lagi. Dicatat sebagai batasan yang diketahui,
bukan temuan yang butuh perbaikan segera.

### I17 - Header `x-proxy-cpu-ms` masih aktif (bawaan I1/I8, keputusan tunda)

`workers/proxy/src/index.js` masih mengeset
`x-proxy-cpu-ms` + `Access-Control-Expose-Headers`. Keputusan
Blue 1/Blue 2 dipertahankan: dicabut saat promosi ke proxy
produksi; worker saat ini masih worker spike dan header adalah
instrumen ukurnya. Bukan temuan baru; dicatat supaya tidak
hilang dari daftar promosi.

### I18 - Allowlist hash player masih di-hardcode (bawaan I2/I9, keputusan tunda)

`PLAYER_HASHES` di `workers/proxy/src/index.js` masih berisi
3 hash statis. Keputusan Blue 1 dipertahankan (membaca dari
config remote butuh desain sumber + TTL); ketiga salinan hash
sinkron per Red 2 (19 Nov 2026). Risiko ketersediaan bila
YouTube merotasi hash, bukan keamanan langsung.

---

## Verifikasi Origin di semua rute POST (fokus koordinator)

Semua handler POST di worker sync diperiksa satu per satu:

| Rute POST | Cek Origin | Bukti |
|---|---|---|
| `/api/auth/logout` | YA | `index.js:841` `if (!isAllowedOrigin(...))` -> 403 `ORIGIN_NOT_ALLOWED`, dicek SEBELUM `authUser` |
| `/api/auth/delete` | YA | `index.js:860`, pola yang sama, sebelum auth |
| `/api/sync/push` | YA | `index.js:914`, sesudah auth + rate limit, sebelum `handlePush` |

Catatan penting: `isAllowedOrigin` (`:109-116`) mengembalikan
false bila header `Origin` TIDAK ADA (string kosong tidak ada
di allowlist), jadi request tanpa Origin ditolak, bukan
diizinkan. Ini perilaku ketat yang benar untuk mitigasi CSRF
di bawah `SameSite=None`. Satu-satunya kelemahan adalah ISI
allowlist-nya (localhost, lihat R10), bukan mekanismenya.

Rute GET (`/api/auth/login`, `/api/auth/callback`,
`/api/auth/me`, `/api/sync/pull`) tidak memakai cek Origin dan
itu benar: login/callback adalah navigasi top-level OAuth
(callback dilindungi state acak 128 bit + kode sekali pakai
provider), `me`/`pull` bersifat baca-saja dan responsnya tidak
bisa dibaca lintas origin tanpa CORS (hanya origin allowlist
yang mendapat `Access-Control-Allow-Origin` + credentials).
Satu gangguan kecil yang dicatat: situs jahat bisa menembak
`/api/sync/pull` lewat tag `<img>` (cookie ikut terkirim
karena `SameSite=None`) dan membakar kuota sync korban
(30/mnt/user) selama satu menit; responsnya tidak terbaca dan
efeknya hanya sync gagal sesaat, jadi tidak dinilai sebagai
temuan.

Rute POST di worker proxy (endpoint InnerTube) TIDAK memakai
cek Origin dan itu benar: proxy stateless tanpa cookie/auth,
tanpa `Allow-Credentials`, sehingga tidak ada otoritas ambient
yang bisa dibajak CSRF; CORS allowlist membatasi siapa yang
bisa MEMBACA responsnya.

---

## Verifikasi regresi Red 1 (semua bertahan)

| ID Red 1 | Status Red 3 | Bukti |
|---|---|---|
| H1 (tinggi, chunk uji di produksi) | BERTAHAN | `App.tsx:35-54`: kedelapan rute uji (`/player-test`, `/library-test`, `/p4-test`, `/p5-test`, `/p6-test`, `/p7-test`, `/p8-test`) digerbang `import.meta.env.DEV` termasuk lazy import-nya; `parseRoute` (`:101-108`) ikut digerbang. `dist/assets` (53 aset, build P8): **0 chunk `*TestPage*`**, 1 chunk `SpikePage` (pengecualian koordinator). Gerbang CI masih ada di `ci.yml:53`. |
| S1 (sedang, body POST dibaca penuh) | BERTAHAN | `workers/proxy/src/index.js`: `readCapped(request.body, MAX_BODY_BYTES)` + cek `Content-Length` awal. Pola yang sama dipakai worker sync (`handlePush`). |
| S2 (sedang, tanpa CSP) | BERTAHAN + LIVE | `app/public/_headers` utuh; **terkonfirmasi dari header live** `https://laras.adipmusic.my.id/` 19 Nov 2026: CSP persis sama dengan file (termasuk `'wasm-unsafe-eval'`, bukan `'unsafe-eval'`), `nosniff`, `X-Frame-Options: DENY`. Item "tidak bisa diverifikasi" Red 2 ini kini TERTUTUP. |
| S3 (sedang, rate limit in-memory) | BERTAHAN (kode) | `workers/proxy/src/rateLimit.js` + D1 masih dipakai; tidak ada `buckets` in-memory. Uji unit 7/7 (dengan catatan flaky I15). Verifikasi D1 ASLI live masih menunggu probe 61+ request (tidak dilakukan, hemat kuota). |
| S4 (sedang, config tanpa cap/versi) | BERTAHAN | Cap 4 MB + `version === 1` masih ditegakkan (`fetchConfig.ts`, `resolve.ts`); jalur cache P6 kini aman (lihat S5). |
| R1 (rendah, redirect media tanpa validasi) | BERTAHAN | `redirect: 'manual'`, maks 3 hop, validasi host per hop, Content-Type allowlist + `nosniff`. Pola yang sama diterapkan di rute spotify-page baru (maks 2 hop, validasi host+path per hop). |
| R2 (rendah, `decodeURIComponent` tanpa try/catch) | BERTAHAN | `App.tsx:parseRoute` try/catch; `main.tsx` ErrorBoundary. |
| R3 (rendah, SW cache-first + versi manual) | BERTAHAN | Navigasi network-first; cache runtime hanya aset statis; `dist/sw.js` berisi `SW_VERSION = '0.9.0-71925ff2'` (hash baru mengikuti perbaikan R8, placeholder tidak tersisa). |
| R4 (rendah, CI tag `@v4`, tanpa permissions/audit) | BERTAHAN | `ci.yml`: ketiga action dipin SHA penuh, `permissions: contents: read`, gerbang `npm audit --omit=dev --audit-level=high` + audit dev informasional + gerbang H1. Audit lokal tetap terblokir egress (lihat "Tidak bisa diverifikasi"). |
| R5 (rendah, cap client sesudah baca penuh) | BERTAHAN | `resolve.ts` base.js (8 MB) dan `innertube.ts` (10 MB) memakai `readCappedText`. Catatan: pola lama yang sama muncul di tempat BARU (R12, impor backup). |
| R6 (rendah, origin dev di CORS produksi) | BERTAHAN (proxy) | `workers/proxy/wrangler.toml`: `[vars]` hanya dua domain produksi; localhost hanya di `[env.dev.vars]`. Catatan: pola lama yang sama muncul di worker BARU (R10, worker sync). |
| I1 (header CPU) | MASIH TERBUKA (sengaja) | Lihat I17. |
| I2 (hash hardcode) | MASIH TERBUKA (sengaja) | Lihat I18. |
| I3 (track lokal tanpa validasi URL) | BERTAHAN | `player/port.ts:78` `isSafeLocalUrl` + choke di `service.ts:766` sebelum `decidePath`. |
| I4 (sourcemap di dist) | BUKAN TEMUAN | Tetap sesuai putusan Red 1 (repo GPL publik). |

## Verifikasi regresi Red 2 (semua bertahan)

| ID Red 2 | Status Red 3 | Bukti |
|---|---|---|
| S5 (sedang, `JSON.parse` cache config) | BERTAHAN | `configStore.ts:135` `parseConfigText` (try/catch, mengembalikan null) dipakai ketiga jalur (memori `:192`, tersimpan `:217`, segar `:330`); entri rusak dihapus best-effort (`deletePersisted`, `:226-232`). Tes regresi Blue 2 lolos di suite penuh. |
| R7 (rendah, re-resolve tanpa cek itag) | BERTAHAN | `downloadManager.ts:724` `currentItag`, `:742-746` lempar `ItagChangedError` bila itag berubah, `:777-783` restart sekali dari byte 0, `:845` `formatId` memakai itag akhir. |
| R8 (rendah, SW Content-Type apa adanya) | BERTAHAN (sumber + dist) | `sw.js:154-190` `serveDownload`: tipe dipaksa lewat `safeDownloadContentType` + `nosniff` di jalur 200 dan 206; `if (!range) return cached;` sudah hilang. `dist/sw.js` hasil build P8 memuat fungsi itu (7 kecocokan) + versi hash baru. `downloadStore.ts` `putDownload` ikut memaksa tipe sebelum `cache.put`. |
| R9 (rendah, race batal vs rakit) | BERTAHAN | `downloadManager.ts:801` cek abort sebelum `putDownload`, `:821`/`:837` cek sebelum `markDownloaded` (+ hapus file bila batal di antaranya). |
| I5 (enum snapshot) | BERTAHAN | `diagnostics.ts:236` `hasOwnProperty` untuk `KIND_LETTER`/`CAUSE_LETTER`. |
| I6 (tunggu 429 tak terbatalkan) | BERTAHAN | `downloadManager.ts:102` `sleepAbortable`, dipakai di cabang 429 (`:283`). |
| I7 (fallback `combineSignal`) | BERTAHAN | Fallback tanpa `AbortSignal.any` memakai `AbortController` gabungan + listener abort manual. |
| I8 (header CPU) | MASIH TERBUKA (sengaja) | Lihat I17. |
| I9 (hash hardcode) | MASIH TERBUKA (sengaja) | Lihat I18. |
| I10 (versi worker live tak pasti) | TERTUTUP SEBAGIAN | Redeploy proxy TERBUKTI: rute `/api/spotify-page` (baru di P8) merespons live, id buruk ke 400 dan id valid mengembalikan halaman playlist Spotify asli ("50 Teratas - Global"). Worker live memuat kode pasca-Blue-1/P8. Perilaku rate limit D1 live (60 lolos / ke-61 429) masih belum dibuktikan langsung (butuh 61+ request; sengaja tidak dilakukan). |

## Daftar endpoint eksternal (diperbarui dari Red 2)

Perubahan dari Red 2: LRCLIB + lyrics.ovh (P7), worker sync 7
endpoint (P7), `/api/spotify-page` (P8). Tidak ada endpoint lain.

| # | Endpoint | Pemanggil | Keterangan |
|---|---|---|---|
| 1-5 | `.../api/innertube/player`, `search`, `browse`, `next`, `suggestions` | `innertube.ts` | Tidak berubah |
| 6 | `.../api/player-script?hash=` | `resolve.ts` | Tidak berubah |
| 7 | `.../api/media?u=` | `downloadManager.ts` | Tidak berubah |
| 8 | `.../api/spotify-page?id=` (BARU) | `spotify.ts` `fetchFromLink` | GET, id 22 karakter, cap 2 MB, rate limit 10/mnt/IP; live terverifikasi |
| 9 | `https://raw.githubusercontent.com/adiprmx/laras/config-v1/player-config.json` | `fetchConfig.ts` | Cap 4 MB, timeout 15 dtk |
| 10 | `https://lrclib.net/api/get`, `/api/search` (BARU) | `lrclib.ts` | Timeout 30 dtk, cap 1 MB, 429 dihormati, tanpa pengenal pengguna |
| 11 | `https://api.lyrics.ovh/v1/<artis>/<judul>` (BARU) | `lrclib.ts` | Fallback lirik polos, timeout 30 dtk, cap 1 MB |
| 12 | `https://laras-sync.hiroohengkerr.workers.dev/api/auth/*`, `/api/sync/*` (BARU) | `syncClient.ts`, `auth.ts` | OAuth + sync, `credentials: include`, timeout 30 dtk |
| 13 | `https://accounts.google.com/o/oauth2/v2/auth`, `https://oauth2.googleapis.com/token`, `https://openidconnect.googleapis.com/v1/userinfo` | worker sync (server-side) | OAuth Google; browser hanya navigasi ke authorize |
| 14 | `https://github.com/login/oauth/*`, `https://api.github.com/user` | worker sync (server-side) | OAuth GitHub; browser hanya navigasi ke authorize |
| 15 | `https://*.googlevideo.com/videoplayback...` | elemen `<audio>` saja | Tidak berubah |
| 16-17 | Thumbnail `*.ytimg.com`, `*.googleusercontent.com`, `*.ggpht.com` | `<img>` | Tidak berubah |

**NOL telemetri/analytics:** tidak ada `fetch`/`XHR`/`WebSocket`/
`sendBeacon`/piksel pelacak lain di seluruh `app/src` (grep
terverifikasi). **NOL panggilan ke `api.spotify.com` /
`accounts.spotify.com`:** kedua string hanya muncul di komentar
kode sebagai larangan (grep di `app/src`, `workers`,
`app/public`, `app/tests`); `api.github.com` di atas adalah
endpoint profil GitHub untuk OAuth (bukan Spotify) dan hanya
disentuh worker sync, bukan browser.

---

## Yang DIPERIKSA dan bersih (P7 + P8 + umum)

- **Validasi Origin di semua POST sync.** Lihat tabel di atas:
  logout, delete, push ketiganya memeriksa Origin sebelum
  mengubah state; Origin kosong ditolak.
- **Alur OAuth benar.** State 128 bit acak (`randomTokenHex(16)`),
  disimpan di cookie HttpOnly + Secure + `SameSite=Lax` +
  `Path=/api/auth` + 10 menit; provider disimpan di cookie,
  bukan URL; kode ditukar di server (secret tidak pernah ke
  browser); profil divalidasi (`sub` Google / `id` GitHub wajib
  ada); scope minimal (`openid profile`, `read:user`); galat
  provider (`denied`) ditangani; tanpa secret, login membalas
  503 jujur (bukan crash). Round-trip kedua provider terbukti
  bekerja live 19 Nov (verifikasi koordinator); ronde ini
  memverifikasi `/api/auth/me` tanpa cookie ke 401 dan provider
  tak dikenal ke 400.
- **Manajemen sesi benar.** Token 256 bit acak, hash SHA-256 di
  D1 (token mentah tidak pernah disimpan), cookie HttpOnly +
  Secure + `SameSite=None` (penyimpangan tercatat dari
  arsitektur §4.3 dengan alasan lintas-situs + mitigasi Origin;
  env `COOKIE_SAMESITE=Lax` tersedia bila pindah same-site),
  30 hari, maks 10 sesi/user (sesi terlama dihapus),
  kedaluwarsa dicek di `authUser`, logout menghapus sesi
  spesifik itu.
- **Otorisasi baca per-user benar.** Semua query pull
  memfilter `user_id = ?` (playlist, item via join, suka,
  riwayat, settings); `historyClearedBefore` dan hapus akun
  juga terikat `user_id`. Semua query memakai `.bind()`
  (parameterized, tanpa interpolasi string ke SQL).
- **Validasi push ketat.** Body dibaca ber-cap 1 MB selama
  stream + cek `Content-Length` awal; `JSON.parse` dibungkus;
  `validatePushBody` memeriksa tipe, panjang, dan keutuhan
  tiap koleksi (maks 100 entri/koleksi, settings maks 4 KB
  + CHECK D1, `deviceId` wajib); `updated_at` dari jam server
  (bukan jam perangkat). Satu-satunya lubang adalah kepemilikan
  playlist (R11), bukan validasi bentuk.
- **Hapus akun berurutan dan aman.** Tujuh penghapusan eksplisit
  (item, playlist, suka, riwayat, settings, sesi, pengguna
  TERAKHIR), butuh sesi + Origin; cookie dibersihkan sesudahnya.
- **Rate limit D1 fail-open konsisten.** Auth 10/mnt/IP, sync
  30/mnt/user, me 60/mnt/IP, spotify-page 10/mnt/IP; kunci dari
  `CF-Connecting-IP` (bukan `X-Forwarded-For`); gagal D1 berarti
  diizinkan + dicatat (keputusan yang didokumentasikan).
  Satu-satunya yang lolos adalah callback (S6).
- **Klien lirik aman.** Cap 1 MB + timeout 30 dtk di ketiga
  jalur; `JSON.parse` dibungkus try/catch; 429 dihormati
  (Retry-After + jitter, maks 60 dtk, satu ulang); header
  klien teridentifikasi (bukan secret); tanpa pengenal
  pengguna/perangkat di request; pemberitahuan privasi tampil
  SEBELUM fetch pertama; lirik dirender sebagai teks React
  (auto-escape, nol `innerHTML`); parser LRC iteratif tanpa
  pola regex berbahaya; cache 256 KB/kolom + penanda miss 7 hari.
- **EQ tidak pernah menyentuh stream.** `decidePath`
  (`audioGraph.ts`) mengembalikan `direct` untuk
  `*.googlevideo.com` (seed S5 + cek sufiks host); graph hanya
  untuk blob/data/same-origin/lokal; EQ disimpan walau graph
  belum ada; UI jujur bahwa EQ tidak tersedia untuk streaming.
  Timer tidur murni lokal (tanpa jaringan).
- **Klien sync aman.** `credentials: include` + timeout 30 dtk;
  respons non-JSON ditangani (`.catch(() => null)`); 401
  memetakan ke `signed-out` (bukan loop); `parseSettingsPayload`
  try/catch + cek `version === 1` + normalisasi EQ;
  `normalizeEqSettings` menolak gains yang panjangnya bukan 10
  dan men-clamp ke plus minus 12 dB; TIDAK ADA URL stream di
  payload push (hanya videoId + metadata judul/artis).
- **Parser backup ketat.** Cap 10 MB sebelum decode/parse;
  decode UTF-8 fatal; versi wajib 1 (lebih baru ditolak);
  validasi tipe per field per item; id lagu ganda ditolak;
  integritas referensi penuh (album, playlist, riwayat,
  antrean); antrean maks 200; `playbackState` divalidasi dan
  `currentIndex` di-clamp ke panjang antrean saat merge;
  pengaturan salah tipe diabaikan (bukan gagal total); kunci
  tak dikenal diabaikan (kompatibilitas APK).
- **Merge satu transaksi terbukti.** `mergeBackupData`
  (`library.ts:2479`) memakai satu `db.transaction('rw', [...11
  tabel...])`: gagal di tengah membatalkan segalanya.
  Aturan konflik setia APK (favorit/inLibrary hanya naik,
  total waktu putar tidak ditimpa, dedup riwayat, batas
  10.000 riwayat / 100 pencarian / 1.000 lagu per playlist /
  200 antrean ditegakkan di dalam transaksi).
- **Hapus semua data tuntas di sisi lokal.** Urutan benar
  (hentikan pemutar dulu via `stopForWipe`, lalu unduhan, lalu
  IndexedDB, lalu SEMUA cache, lalu localStorage `laras.*`
  termasuk `laras.player.v1`); state memori dibersihkan reload;
  dua konfirmasi + tombol simpan-dulu; kegagalan per langkah
  dicatat, bukan melempar di tengah. Satu-satunya celah adalah
  pemulihan via sync (R15).
- **Rute `/api/spotify-page` ketat + live.** Id regex 22
  karakter; rate limit 10/mnt/IP; redirect manual maks 2 hop
  dengan validasi host (`open.spotify.com` persis) + path
  (`/playlist/<id 22 karakter>`) per hop; timeout 15 dtk; cap
  2 MB (deklarasi + stream); hanya status 200 diteruskan;
  `Content-Type: text/html` + `nosniff`. Terverifikasi live:
  id buruk ke 400, id valid mengembalikan halaman playlist
  asli ("50 Teratas - Global"). Client mem-parse HTML dengan
  regex string + decode entitas manual (tanpa `DOMParser`,
  tanpa `innerHTML`, tanpa eksekusi), dan validasi URL klien
  (`validateSpotifyPlaylistUrl`) sama ketatnya (https + host
  persis + 2 segmen + id 22 karakter).
- **CSP lengkap dan live.** Lihat baris S2 di tabel regresi.
  `connect-src` hanya berisi origin yang memang dipakai
  (proxy, sync, raw.githubusercontent, lrclib, lyrics.ovh);
  tidak ada origin terbuka berlebihan. `'wasm-unsafe-eval'`,
  bukan `'unsafe-eval'`.
- **Nol XSS / eval liar / secret / telemetri / console.**
  NOL `dangerouslySetInnerHTML` / `innerHTML` DOM /
  `document.write` / `new Function` di `app/src` (`innerHTML`
  hanya properti objek stub di `jsStubs.ts:32`; `eval(` hanya
  metode engine solver QuickJS yang tersandbox; engine eval
  fallback hanya dipakai harness `spikePage.ts` yang TIDAK
  DIIMPOR kode app mana pun dan TIDAK ADA di `dist/`
  (0 chunk eval/fallback, 0 referensi `evalFallback` di
  chunk `SpikePage`). NOL `console.*` di kode produksi
  (termasuk `test-pages` dan `spike`). NOL pola secret di repo
  (satu-satunya kunci adalah kunci publik InnerTube
  `AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8`, BUKAN temuan;
  OAuth client ID publik, BUKAN temuan; client SECRET tidak
  ada di repo). NOL telemetri (lihat daftar endpoint).
- **Solver tetap tersandbox.** Tidak berubah sejak Red 1/2:
  Web Worker khusus, memori 192 MiB, timeout 10 dtk +
  terminasi, eksekusi serial, tanpa callback host, tanpa fetch
  dari dalam JS, hasil divalidasi allowlist googlevideo.
- **Dependensi produksi tidak berubah sejak Red 2.**
  Lockfile: React 19.3.1, React DOM 19.3.1, Vite 6.4.6,
  esbuild 0.25.12, Dexie 4.4.7, Zustand 5.1.0,
  quickjs-emscripten-core 0.32.0, rollup 4.68.5, ws 8.23.0,
  semver 6.3.2, Vitest 3.2.7; overrides picomatch 4.0.7 +
  tinypool 2.2.0 masih ada. Tidak ada dependensi produksi
  baru di P7/P8. picomatch GHSA-fc5q tetap diketahui dan
  tidak dilaporkan ulang (upgrade Vitest 5 terjadwal).
- **Tes hijau (dengan satu catatan flaky).** Vitest 714/715
  (49 file) di run penuh ronde ini; satu-satunya kegagalan
  adalah tes flaky I15 (re-run 3/3 hijau). Tes worker:
  syncWorker 28, spotifyProxy 11, rateLimit 7 (di dalam total
  di atas). Typecheck dan lint tidak dijalankan ulang ronde
  ini (P8 melaporkan 0 error untuk keduanya; tidak ada kode
  yang diubah Red 3).

---

## Yang TIDAK bisa diverifikasi + alasannya

- **`npm audit` (gerbang R4).** Endpoint audit npm diblokir
  egress proxy VM (403 `policy_denied`, terverifikasi 19 Nov
  2026, sama seperti Red 1/2 dan Blue 1/2). CI run adalah bukti
  sahnya; picomatch GHSA-fc5q sudah diketahui dan
  didokumentasi, bukan temuan baru.
- **Rate limit D1 live (S3, S6, spotify-page).** Pembuktian
  butuh 61+ request live per endpoint (membakar kuota harian
  + menembak upstream); sengaja tidak dilakukan. Kode +
  uji unit worker adalah bukti yang dipakai.
- **Round-trip OAuth live penuh.** Login sungguhan Google dan
  GitHub + `/api/auth/me` 200 sesudah login diverifikasi
  koordinator 19 Nov 2026 (dinyatakan di penugasan); ronde ini
  tidak mengulang login live (butuh kredensial owner) dan hanya
  memverifikasi sisi tanpa-auth (401 tanpa cookie, 400 provider
  tak dikenal, CORS localhost). Verifikasi koordinator diterima
  sebagai bukti untuk alur login.
- **Data sesi/token di D1.** Sengaja TIDAK di-query (sesuai
  penugasan: cukup baca skema + kode). Skema sessions/users
  dibaca dari `0001_init.sql`; perilaku sesi dibuktikan dari
  kode + endpoint publik tanpa auth.
- **Perilaku SW di browser nyata + E2E Playwright penuh.**
  Termasuk serving `/dl/` dengan Range dan network-first
  navigasi di browser nyata; Chromium tidak bisa jalan andal
  di sandbox ini (gelombang EPERM). Bukti terbaik adalah E2E
  P7/P8 yang sudah lolos di VM tim P7/P8 + CI, Vitest
  `sw.test.ts`, dan `dist/sw.js` hasil build P8 yang
  terverifikasi memuat perbaikan R8.
- **Unduh live ujung-ke-ujung + unduh ulang massal.**
  googlevideo memblokir IP VM (vonis S3); kaki live sudah
  dicatat sebagai utang dan bukan ranah audit ini.
- **Probe curl ke worker proxy dari VM.** TLS handshake ke
  `laras-proxy-spike.hiroohengkerr.workers.dev` berhasil
  tetapi 0 byte diterima dalam 15 detik (dua percobaan);
  worker yang sama merespons normal lewat jalur fetch
  browser (400 untuk id buruk, 200 halaman asli untuk id
  valid). Disimpulkan sebagai gangguan egress VM, bukan
  worker mati; tidak ada kesimpulan keamanan yang ditarik
  dari kegagalan curl itu.

---

## Rekomendasi urutan perbaikan untuk Blue 3

1. **S6** - rate limit callback + state single-use (satu-satunya
   temuan sedang; perbaikan kecil, menutup DoS kuota akun).
2. **R10** - hapus localhost dari `ALLOWED_ORIGINS` produksi
   worker sync + redeploy (satu baris config + verifikasi live).
3. **R15** - wipe memanggil logout + copy jujur soal data server
   (menutup janji yang dilanggar aksi destruktif utama).
4. **R11** - cek kepemilikan playlist di push (klausa `user_id`
   + verifikasi item; pertahanan otorisasi yang hilang).
5. **R12 + R13** - cap ukuran file sebelum dibaca (backup +
   Spotify) + cap jumlah lagu Spotify (satu pola, dua dialog).
6. **R14** - cap per-field/per-koleksi di parser backup + cap
   antrean unduhan ulang.
7. **R16** - potong/validasi nama playlist impor + `catch` di
   `handleStart`.
8. **I11-I14** - perbaikan kecil sekali jalan (cek nama galat
   tanpa `instanceof`, try/catch `decodeURIComponent`,
   validasi record LRCLIB, `nosniff`/CSP worker sync).
9. **I15** - perbaiki tes flaky rateLimit (mock `Math.random`).
10. **Koordinator (bukan Blue):** konfirmasi redeploy worker
    sync sesudah R10/S6 (verifikasi live: OPTIONS localhost
    tidak lagi mendapat ACAO; 11 callback cepat ke 429);
    cabut `x-proxy-cpu-ms` (I17) dan rancang sumber hash remote
    (I18) saat promosi produksi; gerbang `npm audit` di run CI.

**Red 4 (sesudah Blue 3):** verifikasi S6 dengan probe live
terbatas (11 callback cepat, bila kuota mengizinkan) atau uji
unit worker; verifikasi R10 live (OPTIONS localhost); verifikasi
R15 end-to-end (wipe saat masuk lalu tunggu 20 detik: data
TIDAK boleh kembali); verifikasi R11 dengan tes worker dua
pengguna; verifikasi R12/R13 dengan file di atas cap; plus
audit permukaan baru apa pun yang mendarat sesudah P8.
