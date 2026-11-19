# P8 — Backup dan Ekspor

**Status:** selesai, terverifikasi lokal, belum push (koordinator yang push + deploy).
**Tanggal:** 19 Nov 2026. **Ruang lingkup:** `docs/rencana-fase-2.md` §P8 + PRD B7/B10.
**Aturan paket:** backup/ekspor jalan penuh tanpa akun — login tidak menyelinap lewat P8.

## Ringkasan

Empat fitur, semua di Pengaturan → seksi "Salinan data":

1. **Backup JSON berversi** — ekspor seluruh data pengguna ke file JSON
   (`backupVersion: 1`, format kompatibel APK), unduh lewat browser, tanpa server.
2. **Impor merge satu transaksi** — merge (bukan timpa buta), satu transaksi Dexie,
   validasi skema + versi sebelum impor, ringkasan hasil bahasa sehari-hari.
3. **Hapus semua data** — dua konfirmasi + tombol "Simpan salinan dulu"; hapus
   IndexedDB + Cache Storage + localStorage app + state memori.
4. **Impor Spotify tanpa API** — jalur file (teks/CSV/JSON) + jalur tautan publik
   (maks 30 lagu, lewat proxy worker); tiap lagu dicocokkan ke katalog
   YouTube Music satu per satu, yang tidak ketemu dilaporkan, tidak dikarang.

**Angka verifikasi (19 Nov 2026):** Vitest 715/715 (49 file, baseline 587/587);
tsc app + node 0 error; ESLint 0 error 0 warning; bundle awal 181.441 byte gzip
(batas 204.800, sisa 23.359); E2E Playwright 5/5 chromium + 5/5 mobile;
8 screenshot 360 + 1440 di `docs/p8/`, sudah diperiksa visual. Detail di §9.

## 1. Backup JSON berversi

**Yang dibangun.** `app/src/backup/format.ts` (port penuh `backup_format.dart`
APK: tipe, konstanta, encode, parse + seluruh validasi), `app/src/backup/service.ts`
(`BackupService`: bangun data dari snapshot library, encode, cek ukuran,
unduh lewat Blob + anchor). Tombol "Simpan salinan" di seksi Salinan data.

**Format.** Sama persis dengan APK v1: `backupVersion`, `appVersion`,
`exportedAt`, `songs[]`, `albums[]`, `artists[]`, `playlists[]` (tanpa id
playlist — merge cocokkan lewat nama persis), `playEvents[]`, `searchHistory[]`,
`queue[]`, `playbackState`, `settings`. Nama file mengikuti APK:
`backup-musik-YYYYMMDD-HHmmss.json` (waktu lokal). Batas 10.000.000 byte:
ekspor di atas itu ditolak dengan pesan jelas + saran (hapus riwayat lama dulu).

**Tambahan web.** `BackupSettings` punya tiga field ekstra web-only:
`lyricsEnabled`, `eqPresetName`, `eqGains`. Parser APK mengabaikan kunci tak
dikenal, jadi file web tetap bisa dibaca APK (tiga field itu diabaikan) dan
file APK tetap bisa dibaca web. Pengaturan APK yang tidak punya padanan web
(`dataSaver`, `wifiOnly`, `cacheLimitBytes`, `defaultQuality`, `playbackSpeed`,
`playbackPitch`, `skipSilence`, `eqEnabled`, `eqPreset`) diabaikan saat impor
dan tidak diekspor — dicatat di sini, bukan disembunyikan.

**Yang TIDAK masuk backup (keputusan eksplisit, PRD B7.6):**

- File audio unduhan — hanya daftarnya (flag `downloaded` per lagu). Sesudah
  impor, tombol "Unduh ulang" muncul bila ada lagu yang dulu terunduh.
- URL stream — TIDAK PERNAH ditulis ke backup (juga tidak ke log/laporan).
- Status kanari, konfigurasi remote, status layanan, stempel waktu Jelajah,
  flag first-run, penanda sinkronisasi (data operasional, bukan data pengguna).
- Data sinkronisasi server (milik akun, bukan perangkat).

**Bukti kompatibilitas APK.** `format.test.ts` memuat `APK_SAMPLE_JSON` —
salinan literal fixture `sampleBackup()` dari `backup_format_test.dart` APK
(2 lagu, 1 album, 1 artis, 1 playlist, 1 event, 1 pencarian, antrean 2,
playbackState, settings lengkap) — dan membuktikan parse + round-trip +
merge-nya. Arah sebaliknya (file web dibaca APK) dijamin oleh parser APK yang
mengabaikan kunci tak dikenal; uji live di APK adalah utang (lihat §10).

## 2. Impor merge satu transaksi

**Yang dibangun.** `LibraryService.mergeBackupData()` di
`app/src/data/library.ts` (satu transaksi Dexie atas 11 tabel — merge tinggal
di service karena butuh helper privat sinkronisasi token + posisi playlist)
dan `BackupService.importBackup()` (parse → merge → terapkan pengaturan →
laporan). Dialog impor: pilih file → pratinjau isi (hitungan + tanggal dibuat
+ centang "Pakai juga pengaturan dari file", default nyala) → impor → laporan.

**Aturan konflik (port aturan APK, didokumentasikan di kode):**

- Album/artis: masukkan-bila-belum-ada, cocokkan lewat id.
- Lagu baru: dimasukkan apa adanya dari file (status unduhan selalu
  belum-terunduh). Lagu yang sudah ada: hanya metadata diperbarui
  (judul/album/durasi/thumbnail); favorit dan inLibrary hanya bisa NAIK,
  tidak pernah turun; total waktu putar tidak disentuh; artis lagu yang
  sudah ada tidak ditulis ulang.
- Playlist: cocokkan lewat nama persis (tidak pernah dibuat "(salinan)");
  lagu yang belum ada ditambahkan; nama dipotong 100 karakter, deskripsi 500.
- Riwayat putar: dedup (lagu, detik, durasi) — perbandingan memakai detik
  seperti APK — batas 10.000 (tertua dihapus).
- Riwayat pencarian: dedup tanpa bedakan huruf besar/kecil, batas 100.
- Antrean: ditambahkan di belakang, duplikat dilewati, batas 200 (yang
  dilewati dilaporkan). Playback state dipulihkan HANYA bila antrean tujuan
  kosong sebelum impor dan file punya isi antrean.
- Gagal di tengah = tidak ada perubahan separuh (satu transaksi Dexie).

**Penyimpangan web dari APK (sengaja, dicatat):** (1) lagu yang berubah judul
ikut sinkronisasi ulang indeks token — APK membiarkan FTS basi, web tidak bisa
(pencarian lokal akan pakai judul lama); (2) batas 1.000 lagu per playlist
ditegakkan saat merge, dihitung di `playlistSongsSkippedFull`; (3) item antrean
dari file selalu `kind: 'stream'`; (4) playback state yang dipulihkan memakai
urutan identitas, rate/volume = 1 (file tidak membawa keduanya).

**Validasi sebelum impor.** Ukuran > 10 MB, JSON rusak, bukan file backup,
versi lebih baru dari yang dikenal, id lagu ganda, referensi menggantung
(album/playlist/event/antrean), antrean > 200, playbackState tidak valid —
semua ditolak dengan pesan jelas, database tidak tersentuh (dibuktikan tes:
impor file tidak valid tidak mengubah DB). Pengaturan bertipe salah ditoleransi
(diabaikan, bukan gagal); kunci tak dikenal diabaikan.

**Ringkasan hasil.** Bahasa sehari-hari, tanpa jargon: mis. "14 hal baru
ditambahkan." (5 lagu + 1 playlist + 2 lagu playlist + 2 riwayat + 2 pencarian
+ 2 antrean) + daftar yang dilewati + tombol "Unduh ulang" bila ada lagu yang
dulu terunduh.

**Pengaturan yang diterapkan saat impor** (bila centang nyala): urutan lagu,
lirik nyala/mati, preset + gains EQ (lewat `normalizeEqSettings` — preset
dihitung ulang dari gains, jadi gains non-kanonis menjadi 'custom').
`eqPreset` APK (indeks preset perangkat) TIDAK diterapkan web (tergantung
perangkat). Menerapkan EQ memanggil `markSettingsChanged()` supaya sinkronisasi
P7 ikut memperbarui (bukan lewat `applySyncedEqSettings` saja).

## 3. Hapus semua data

**Yang dibangun.** `app/src/backup/wipe.ts` (`wipeAllData`, dependensi bisa
diinjeksi untuk tes) + `WipeFlow.tsx` (dua dialog konfirmasi) + tombol teks
merah "Hapus semua data" di seksi Salinan data. Dialog pertama punya tiga
tombol: "Simpan salinan dulu" (lebar penuh), Batal, Hapus (merah). Gagal
ekspor tidak memblokir penghapusan — pengguna sudah memutuskan.

**Urutan hapus:** (1) hentikan pemutar total; (2) hapus file unduhan;
(3) hapus database IndexedDB + reset singleton service; (4) hapus SEMUA cache
(termasuk kerangka — diunduh ulang); (5) hapus kunci localStorage awalan
`laras.`; lalu UI memuat ulang halaman (state memori dibersihkan oleh reload,
sama seperti APK yang menutup app sesudah wipe). Langkah best-effort kecuali
database: kegagalan dicatat di `WipeResult.failedSteps`, tidak melempar di
tengah jalan.

**Yang TIDAK dihapus (bukan data pengguna):** registrasi service worker
(kerangka app), cookie sesi sinkronisasi (HttpOnly, tidak bisa dihapus dari
JS), data sinkronisasi di server (penghapusan akun terpisah, PRD B10.3).

**Bug yang ditemukan E2E dan diperbaiki.** `clearQueue()` P2 hanya menghapus
kecuali lagu yang sedang diputar DAN persist-nya ter-debounce 500 ms — tulis
itu mendarat SESUDAH database dihapus dan membangkitkan antrean (E2E gagal:
"Antrean: 1" sesudah wipe). Perbaikan: metode baru `PlayerService.stopForWipe()`
(jeda, kosongkan antrean SEPENUHNYA, batalkan timer tidur + persist tertunda,
tulis keadaan kosong, TUNGGU rantai tulis IndexedDB selesai). `clearQueue()`
tidak diubah — perilaku P2 utuh. Tes unit `stopForWipe` tidak ada (tidak ada
harness PlayerService; semua tes player adalah fungsi murni) — verifikasinya
E2E round-trip yang menemukan bugnya.

**Catatan verifikasi cache.** Sesudah wipe + reload, cache `laras-downloads-v1`
bangkit KOSONG karena App membuka DownloadManager di setiap boot (P5,
rekonsiliasi unduhan) — sama seperti IndexedDB yang dibuat ulang kosong.
E2E memverifikasi "tidak ada ISI di cache mana pun" (0 entri), bukan "tidak
ada nama cache".

## 4. Impor Spotify tanpa API

**Larangan permanen dipatuhi:** tidak pernah memanggil api.spotify.com atau
accounts.spotify.com, tidak meminta client id/secret/token, tidak ada login
Spotify, tidak ada library wrapper Web API. Satu-satunya permintaan ke Spotify
adalah pengambilan halaman publik playlist lewat proxy (jalur B).

**Yang dibangun.** `app/src/backup/spotify.ts` (port penuh `spotify_import.dart`
APK: parser file + parser HTML + normalisasi + pencocokan) + rute proxy baru
`GET /api/spotify-page?id=<id 22 karakter>` di `workers/proxy/src/index.js` +
`SpotifyImportDialog.tsx` (tab file/tautan, draf, progres + tombol Berhenti,
laporan).

**Jalur file (utama).** Pengguna menempel teks atau mengunggah file. Format
dideteksi dari ISI (bukan ekstensi): JSON bila diawali `[`/`{` (daftar
langsung `[{"Track Name","Artist Name(s)"}]` atau `[{"name","artists":[...]}]`,
pembungkus `{"tracks":[...]}` / `{"playlist":{"name","tracks"}}`, item
terbungkus `{"track":{...}}`); CSV bila baris pertama mirip header kolom
artis+judul (tanpa header juga dideteksi bila ≥2 baris dan ≥separuh berisi
koma, dibaca sebagai artis, judul); sisanya teks "Artis - Judul" per baris
(penomoran awal `1. ` dihapus, pemisah " - " atau dash ber-spasi, kemunculan
pertama). Parser CSV menangani tanda kutip + koma di dalam kutip.

**Jalur tautan publik.** Hanya `https://open.spotify.com/playlist/<id 22
karakter>` (tautan lagu/album/artis ditolak dengan pesan jelas). Browser TIDAK
BISA mengambil langsung — probe live 19 Nov 2026 membuktikan
open.spotify.com tidak mengirim header CORS — jadi pengambilan lewat proxy
worker: id divalidasi regex, rate limit 10/menit per IP, redirect manual
maks 2 hop hanya di dalam open.spotify.com/playlist/<id>, tenggat 15 detik,
batas 2 MB, User-Agent Android. Respons HTML diambil sebagai teks (tidak
dieksekusi — bukan vektor XSS). Parser HTML memakai jangkar APK yang masih
valid live (probe 19 Nov 2026: playlist "Today's Top Hits", 30 kemunculan
`data-testid="track-row"`): `og:title` untuk nama playlist, `aria-label`
untuk judul lagu + tautan artis pertama sesudah penanda baris; entitas HTML
didekode; batas 30 lagu, `truncated=true` di batas.

**Pencocokan ke YouTube Music.** Tiap lagu dicari satu per satu lewat
`SearchService.search()` langsung (bukan lewat UI — kueri pencocokan TIDAK
masuk riwayat pencarian pengguna, sama seperti APK yang memakai API langsung).
Kecocokan "yakin" = judul DAN artis sama persis sesudah normalisasi (huruf
kecil, hapus sufiks dalam kurung berulang, lipat diakritik Latin, hapus
tanda baca/spasi) di dalam 5 hasil teratas; artis kosong = judul saja.
Tidak ada kecocokan yakin = dilaporkan tidak ketemu, TIDAK PERNAH ditebak.
Jeda 150 ms antar pencarian. Error jaringan di tengah jalan menghentikan
pencocokan (sisanya ditandai jaringan); lagu yang sudah cocok tetap disimpan.
Lagu yang cocok dimasukkan ke Library + playlist baru (nama bisa diedit,
default nama playlist Spotify atau "Impor Spotify"); bila 0 cocok, playlist
TIDAK dibuat. VideoId yang sudah ada dihitung sudah-ada, bukan duplikat.

**Batasan jalur tautan (jujur):** bergantung pada struktur HTML publik
Spotify yang bisa berubah sewaktu-waktu tanpa pemberitahuan (bila jangkar
berubah, impor tautan gagal dengan pesan jelas — bukan hasil salah); maks
30 lagu; butuh proxy worker yang sudah di-deploy ulang (rute baru — utang
koordinator, lihat §10); playlist privat/tidak ditemukan gagal di proxy
dengan 502; hanya playlist, bukan lagu/album/artis.

## 5. Antarmuka

Seksi "Salinan data" di Pengaturan, di antara Lirik dan Pembaruan — tiga
tombol (Simpan salinan / Pulihkan dari salinan / Impor dari Spotify) + tombol
teks merah "Hapus semua data". Semua kode backup lazy-load bersama SettingsPage
(kode UI P8 hanya ada di chunk `SettingsPage-*.js`; yang masuk bundle awal
hanya string + logika merge/snapshot di `LibraryService` yang memang dipakai
bersama). Dialog mengikuti gaya `ConfirmDialog` yang sudah ada; dialog hapus
tidak bisa memakai ulang komponen itu karena butuh 3 tombol. Copy bahasa
Indonesia sehari-hari, tanpa jargon, tanpa em dash, tanpa angka yang tidak
perlu. Warna hanya fungsi/status (merah = hapus), sisanya hitam/putih sesuai
design lock. Screenshot di `docs/p8/` (8 PNG, 360 + 1440, sudah diperiksa
visual — lihat §9).

## 6. Berkas

**Baru (app):**

- `app/src/backup/format.ts` (+ `format.test.ts`, 26 tes)
- `app/src/backup/report.ts` (laporan impor, port `import_report.dart`)
- `app/src/backup/service.ts` (+ `service.test.ts`, 14 tes)
- `app/src/backup/wipe.ts` (+ `wipe.test.ts`, 6 tes)
- `app/src/backup/spotify.ts` (+ `spotify.test.ts`, 56 tes)
- `app/src/backup/test-fixtures/spotify_playlist.html` (salinan fixture APK)
- `app/src/backup/merge.test.ts` (15 tes, untuk `mergeBackupData`)
- `app/src/worker/spotifyProxy.test.ts` (11 tes, untuk rute proxy)
- `app/src/components/settings/BackupSection.tsx`
- `app/src/components/settings/ImportBackupDialog.tsx`
- `app/src/components/settings/ImportReportView.tsx`
- `app/src/components/settings/SpotifyImportDialog.tsx`
- `app/src/components/settings/WipeFlow.tsx`
- `app/src/test-pages/P8TestPage.tsx` (DEV-only, halaman seed + baca hitungan)
- `app/tests/e2e/p8.spec.ts` (5 tes) + `p8-screenshots.spec.ts` (4 tes)
- `workers/proxy/src/index.d.ts` (deklarasi tipe worker proxy)

**Diubah:**

- `app/src/data/library.ts` — `backupSnapshot()` + `mergeBackupData()` +
  `BackupSnapshot`/`BackupMergeResult` + `mergeTotalAdded`/`mergeTotalExisted`
- `app/src/player/service.ts` — `stopForWipe()` (baru, aditif; `clearQueue()`
  tidak berubah)
- `app/src/components/settings/SettingsPage.tsx` — render `<BackupSection />`
- `app/src/strings/id.ts` — string P8 + `done`/`back` generik
- `app/src/store/library.ts` — `SORT_META_KEY` kini diekspor
- `app/src/App.tsx` — rute `/p8-test` DEV-only
- `workers/proxy/src/index.js` — rute `/api/spotify-page`
- `workers/proxy/README.md` — daftar rute + batas rute baru

**Tidak diubah:** repo APK (`~/workspace/music-app/`, hanya dibaca) dan
perilaku P0–P7 di luar yang diperlukan P8.

## 7. Aturan merge vs "entri terbaru menang"

Rencana §P8 memberi contoh "entri terbaru menang berdasarkan waktu" — aturan
APK yang di-port LEBIH SPESIFIK dan sudah terbukti: metadata baru menang,
favorit/inLibrary hanya naik, total waktu putar tidak pernah ditimpa, riwayat
di-dedup (bukan ditimpa), antrean ditambahkan (bukan diganti). Alasan: "terbaru
menang" buta akan MENGHAPUS favorit yang baru ditandai di perangkat tujuan
bila file salinan lebih lama; aturan APK tidak pernah menghilangkan data
pengguna lewat impor. Keputusan ini mengikuti APK, bukan contoh di rencana.

## 8. Checklist 7 skill anti-slop

Semua dibaca sebelum kerja (mode `during`; subagent tidak bisa bertanya ke
owner). Design lock hitam/putih owner menang atas default generik skill.

- **local-design-taste-frontend** — dipakai: mode Operate, ikuti desain
  incumbent (seksi Pengaturan yang sudah ada, tombol + dialog ConfirmDialog);
  dial 5/3/5 mengikuti preseden P3. Tidak ada elemen dekoratif baru.
- **local-impeccable** — dipakai: audit visual 8 screenshot sendiri sebelum
  lapor (menemukan + memperbaiki framing 360 yang terpotong mini-player);
  semua state dialog diperiksa (pilih file, pratinjau, mengimpor, laporan,
  error, kosong); touch target mengikuti tombol yang sudah ada.
- **local-anti-slop** — dipakai: tidak ada klaim kosong ("mudah", "cepat",
  "canggih") di copy UI; pesan error menyebut penyebab + langkah berikutnya
  ("File terlalu besar. Hapus riwayat lama dulu, lalu coba lagi.");
  tidak ada angka yang tidak perlu di copy pengguna.
- **local-humanizer** — dipakai: copy ditulis seperti penjelasan ke teman
  ("Simpan salinan datamu sebagai file, pulihkan di HP lain"), bukan bahasa
  dokumentasi; ringkasan impor kalimat biasa, bukan tabel teknis.
- **local-stop-slop** — dipakai: frasa pengisi dihapus dari copy + laporan
  (tidak ada "dengan senang hati", "secara menyeluruh"); setiap kalimat di
  laporan ini membawa fakta atau keputusan.
- **local-no-ai-slop** — dipakai: tidak ada pola AI (tidak ada "Berikut
  adalah", tidak ada emoji dekoratif, tidak ada daftar klise); batasan
  ditulis jujur, bukan dibungkus kalimat manis.
- **local-avoid-ai-writing** — dipakai: audit akhir copy UI + laporan —
  tidak ada em dash, tidak ada "penting untuk dicatat", tidak ada struktur
  "bukan hanya X, tapi juga Y"; istilah teknis (Dexie, IndexedDB, CORS)
  hanya ada di laporan teknis ini, TIDAK di copy pengguna.

## 9. Verifikasi (angka nyata, 19 Nov 2026)

- **Vitest penuh: 715/715, 49 file** (baseline 587/587, 43 file; +128 tes,
  +6 file). Baru: format 26, merge 15, service 14, wipe 6, spotify 56,
  spotifyProxy 11. Perintah: `./node_modules/.bin/vitest run --configLoader
  runner --pool=threads` (Vitest biasa gagal `mkdir node_modules/.vite-temp`
  saat gelombang TERBATAS).
- **tsc: 0 error** (`tsconfig.app.json` + `tsconfig.node.json`, `--noEmit`).
  **ESLint: 0 error, 0 warning** pada semua berkas P8.
- **Build** `node build-api.mjs` sukses. **Bundle awal 181.441 byte gzip**
  (JS 174.310 + CSS 7.131), batas 204.800, **sisa 23.359**; naik 5.932 dari
  P7 (175.509) — logika merge/snapshot di `LibraryService` masuk bundle awal
  karena dipakai bersama. **0 chunk `*TestPage*` di dist** (53 aset; string
  TestPage hanya ada di source map sebagai penanda impor DEV-gated — sama
  seperti P4/P7; 0 kecocokan di `.js` maupun `index.html`).
- **E2E Playwright 5/5 chromium + 5/5 mobile** (masing-masing ~1,9 menit),
  lawan server dev Vite API + mock jaringan (Vite CLI gagal mkdir saat
  gelombang TERBATAS — jalan keluar P6/P7; file sementara + server sudah
  dibersihkan sesudah jalan):
  1. Round-trip: ekspor (nama file + isi JSON + backupVersion 1 + flag
     downloaded + tanpa URL stream) → hapus (2 konfirmasi + simpan-dulu,
     reload, hitungan 0 semua + 0 isi cache + 0 kunci localStorage) →
     impor kembali (pratinjau, "14 hal baru ditambahkan.", tombol Unduh
     ulang, library + playlist pulih, Unduhan tetap 0).
  2. File rusak (JSON bukan backup + versi 99) ditolak, database tidak berubah.
  3. Spotify dari file: 1 cocok masuk playlist, 1 tidak ketemu dilaporkan.
  4. Spotify dari tautan (mock proxy, fixture HTML APK "Chill Hits", 3 lagu):
     draf terbaca, 0 cocok (fixture pencarian tidak mengandung ketiganya) —
     membuktikan jalur ambil + parse + cocok dengan hasil tidak-ketemu yang
     jujur, tanpa playlist dibuat.
  5. Tautan bukan playlist ditolak dengan pesan jelas.
- **Screenshot: 8 PNG di `docs/p8/`** (backup-section, import-dialog,
  wipe-dialog, spotify-dialog × 360 + 1440), semua diperiksa visual oleh
  penulis. Satu perbaikan dari pemeriksaan: framing 360 seksi backup yang
  tertutup mini-player (diperbaiki di spec, dipotret ulang).
- **Dua bug ditemukan E2E, keduanya diperbaiki (bukan tesnya yang
  dilonggarkan):** (1) antrean bangkit sesudah wipe (persist debounce —
  lihat §3); (2) ekspektasi hitungan seed (Lagu 4, bukan 5 — p8vid-004
  sengaja history-only; perilaku merge setia APK, diverifikasi ke
  `library_service.dart` baris 2757). Satu asersi diperbaiki alasannya:
  cache kosong yang bangkit di boot adalah perilaku P5, bukan sisa data
  (lihat §3).

## 10. Utang + batasan

1. **Redeploy proxy worker** (koordinator): rute `/api/spotify-page` baru
   ada di kode. Catatan: `index.js` mengimpor `./rateLimit.js`, jadi upload
   satu berkas TIDAK cukup (bundle dengan esbuild atau upload multi-bagian);
   binding D1 `DB` diperlukan untuk rate limit (fail-open tanpa itu).
2. **Uji live jalur tautan Spotify** (koordinator, sesudah #1): E2E memakai
   mock proxy; impor tautan sungguhan belum diuji end-to-end. Unit test
   memakai HTML terekam (fixture APK + probe live 19 Nov 2026 membuktikan
   jangkar masih valid hari itu).
3. **Uji baca file web oleh APK** (utang): kompatibilitas dua arah dijamin
   parser APK yang mengabaikan kunci tak dikenal + tes round-trip satu arah
   (APK → web); baca file web di APK sungguhan belum dijalankan.
4. **Sisa bundle 23.359 byte** — paket berikutnya perlu mengawasi; logika
   merge/snapshot di `LibraryService` tidak bisa pindah ke chunk lazy tanpa
   membuka internal service.
5. **Utang P7 yang tidak terkait** (dicatat, bukan dikerjakan P8): uji login
   OAuth live masih gagal (19 Nov 09:41 WIB, `/api/auth/me` 401 sesudah
   otorisasi GitHub berhasil) — koordinator sedang menyelidiki.
