# P3: Database dan Library (IndexedDB)

Tanggal: 18 November 2026. Tim: A16, A17, A3, B11, B12, B13, B4
(pencarian lokal), diperankan satu agen bergiliran.
Status: **selesai dan terverifikasi** (lihat Bukti tes).

## Ringkasan

P3 memindahkan Laras Web dari "pemutar tanpa ingatan" ke aplikasi
yang menyimpan library pengguna di perangkat sendiri: IndexedDB
dengan skema port drift APK v4 (15 tabel + 3 store web), layanan
library lengkap (lagu, album, artis, playlist, favorit, riwayat
putar, pencarian lokal via indeks token), dan persistensi antrean
yang pindah dari localStorage ke IndexedDB. Antrean terbukti utuh
setelah browser ditutup lalu dibuka lagi (uji persistent context
Playwright). Impor massal 1.000 lagu contoh selesai dalam 5,6 detik
di browser setelah optimasi berkelompok (sebelumnya diproyeksikan
~175 detik).

## Yang dibangun

### Lapisan data (`app/src/data/`)

| File | Isi |
| --- | --- |
| `types.ts` | 18 tipe baris port drift APK v4 + enum angka (DownloadState, DownloadJobStatus, RepeatModeValue). |
| `tokens.ts` | Tokenizer, id artis semu FNV-1a 64 bit (port APK, byte-identik), skor pencarian deterministik. |
| `database.ts` | Dexie 4.4.7, database `laras`, migrasi berversi v1 (15 store APK) + v2 (token_index, playback_state, app_meta). |
| `library.ts` | `LibraryService`: port penuh `library_service.dart` (CRUD lagu/artis/album/playlist, favorit, riwayat putar, pencarian lokal, riwayat pencarian, antrean, lirik, unduhan, cache, lagu tidak bisa diputar, status pemutar, meta). |
| `queuePersistence.ts` | Simpan/muat antrean IndexedDB + migrasi satu kali localStorage P2. |
| `sampleData.ts` | Generator 1.000 lagu contoh deterministik (seed 42, jelas berlabel Contoh). |

### Keputusan desain (mengikat)

1. **Dexie, bukan wrapper mentah.** Pilihan utama arsitektur §5.1.
   Biaya bundle terukur: +45.560 byte gzip pada bundle awal
   (98.065 -> 143.625), masih di bawah anggaran 204.800.
2. **Migrasi berversi dua langkah.** v1 = 15 store APK, v2 = 3 store
   web. Tes migrasi membangun DB v1 persis dari definisi produksi
   lalu membukanya dengan kode v2: data utuh, 3 store baru ada.
   Upgrade tidak pernah menghapus data pengguna.
3. **Boolean disimpan 0/1.** Boolean bukan kunci IndexedDB yang
   valid, jadi tidak bisa dipakai di indeks gabungan. Ini juga
   persis penyimpanan drift APK (boolean menjadi INTEGER 0/1).
4. **Indeks token, bukan FTS5.** IndexedDB tidak punya FTS; satu
   baris per (token, jenis, id), prefix match lewat rentang kunci,
   AND dulu lalu OR bila kosong (port perilaku APK). Skor
   deterministik sederhana (cocok persis judul 3, awalan judul 2,
   cocok persis nama 1,5, awalan nama 1) menggantikan bm25 FTS5.
5. **Pagination keyset 50/halaman** (bukan offset): kursor adalah
   item terakhir halaman sebelumnya, supaya sisipan tidak
   menggeser isi. Indeks gabungan per urutan (terbaru, nama,
   sering diputar, favorit, album, playlist, riwayat).
6. **Impor massal berkelompok.** `importSongs` memakai
   bulkGet/bulkAdd/bulkPut (bukan per lagu satu per satu): 1.000
   lagu 5,6 detik di browser. Terukur sebelum optimasi: 120 lagu
   21 detik (bench replika 9,9 detik vs bulk 0,2 detik).
7. **Antrean di `queue_items` + `playback_state`.** Metadata lagu
   antrean di-upsert ke `songs` dengan `addToLibrary=false`
   (tidak mengotori Library, tetap bisa dicari). URL stream tidak
   pernah disimpan; lagu blob/data tidak disimpan.
8. **Migrasi localStorage satu kali.** Dijalankan saat pemutar
   mulai, sebelum restore. Bila antrean IndexedDB sudah berisi,
   antrean lama tidak menimpanya. Kunci lama dihapus, penanda
   dicatat di `app_meta`.
9. **Riwayat putar ambang 10 detik atau selesai** (PRD B2.7).
   Sesi dihitung dari event playing/pause/ended; gagal catat tidak
   pernah merusak pemutaran.
10. **Indeks `songId` di `song_artists`.** Ditambahkan ke definisi
    v1 (pra-rilis, belum ada pengguna dengan skema lama) supaya
    hapus pemetaan per lagu dan `attachArtists` memakai indeks,
    bukan pindai tabel.

### Pemutar (`app/src/player/service.ts`)

- `restore()` menjadi async: migrasi localStorage lalu restore
  dari IndexedDB; hanya diterapkan bila antrean masih kosong.
- `persistNow()` async berantai (tulis berurutan, state dibaca
  saat giliran tiba); gagal simpan tidak merusak pemutaran.
- Listener `pagehide` ditambahkan (selain `visibilitychange` +
  `beforeunload` + simpan posisi tiap 5 detik).
- `loadTrack` memulai sesi riwayat + upsert metadata lagu yang
  diputar (bukan ke Library). `stopPlayback` mengosongkan antrean
  IndexedDB (bukan localStorage).
- `persistence.ts` P2 dipertahankan (dipakai migrasi + tesnya).

### UI (`app/src/components/library/`, `app/src/store/library.ts`)

- Rute: `/` beranda, `/library`, `/library/playlist/:id`, rute
  tersembunyi `/library-test` (isi 1.000/120 lagu contoh, hapus
  database). Navigasi header Beranda/Library (tanpa react-router;
  bottom nav ditunda ke ronde desain P4).
- Layar Library 6 tab: Lagu (urut Terbaru/Nama/Sering diputar,
  urutan tersimpan di `app_meta`), Album, Artis, Playlist,
  Favorit, Riwayat. Klik artis/album menampilkan lagu-lagunya.
- Pencarian lokal di dalam Library (debounce 300 ms) + saran
  riwayat pencarian. Hasil lagu + artis.
- Menu lagu: putar berikutnya, tambah ke antrean, tambah ke
  playlist, suka/batal suka, hapus dari Library; di dalam
  playlist: pindah ke atas/bawah, hapus dari playlist.
- Dialog buat/ubah playlist (validasi 100/500 karakter), tambah
  ke playlist (termasuk buat baru langsung), konfirmasi hapus.
- Detail playlist: putar semua, ubah, hapus, pagination.
- Tombol hati di FullPlayer (menyimpan lagu lalu memfavoritkan
  bila lagu belum ada di database).
- 4 state nyata di tiap daftar: loading skeleton, kosong jujur,
  galat + "Coba lagi", info (toast 3 detik).
- Copy Bahasa Indonesia sehari-hari, tanpa jargon, tanpa em-dash.
  Design lock: hitam murni `#000000`, aksen putih, warna hanya
  fungsi/status.

## Kriteria selesai (terbukti)

| Kriteria | Bukti |
| --- | --- |
| Preview menyimpan 1.000 lagu contoh | E2E: seed 1.000 via `/library-test`, hitungan `1.000 lagu` tampil, 5,6 detik |
| Pencarian lokal jalan | E2E: hitungan hasil dihitung dari generator yang sama (AND, OR, awalan, artis) |
| Playlist bisa dibuat dan diedit | E2E: buat, tambah 2 lagu, pindah posisi, ubah nama, hapus lagu, hapus playlist |
| Antrean utuh setelah tutup-buka browser | E2E persistent context: 3 nada utuh + posisi pulih (~4 detik) |

## Bukti tes

### Vitest: 211/215 lolos (18 Nov 2026, 21:19 WIB)

- P3 baru: **88/88 lolos** — tokens 15, database 4 (termasuk
  migrasi v1 ke v2), library 49 (pagination 120 lagu 3 urutan,
  CRUD playlist, pencarian AND/OR, riwayat, favorit, merge artis,
  antrean, lirik, unduhan, cache), queuePersistence 12 (simpan/
  pulihkan, migrasi localStorage 4 skenario), sampleData 8.
- P2 yang tidak berubah: 123/123 lolos (player 57, extractor,
  spike, App, persistence, recovery, queue, format).
- **4 gagal di `src/solver/solverEngine.test.ts` (P1, BUKAN P3):**
  `InternalError: interrupted` — interrupt handler QuickJS
  (batas 10 detik, `quickJsEngine.ts`) memutus evaluasi init yang
  berjalan ~12 detik di VM ini (1,5 CPU berbagi). Jumlah gagal
  berubah antar run (1, lalu 5, lalu 4) — flake lingkungan murni.
  P3 tidak menyentuh `src/solver/` sama sekali; versi QuickJS
  tetap 0.32.0 seperti yang dipin. Tes tidak dilunakkan.
  Verifikasi CI (runner lebih cepat) diputuskan koordinator.

### Playwright E2E: 47 lolos + 5 skip (18 Nov 2026, 5,8 menit)

- `library.spec.ts` P3: **22/22 lolos** (11 tes x chromium +
  Pixel 7): empty state, seed 1.000 + pagination, urut nama,
  pencarian (awalan/AND, tanpa hasil, artis), playlist end-to-end,
  favorit dua arah, riwayat putar, migrasi localStorage,
  tutup-buka browser (persistent context).
- `player.spec.ts` P2: 17 lolos + 3 skip (tanpa regresi dari
  perubahan service).
- `smoke.spec.ts` + `spike.spec.ts`: sisanya lolos; 5 skip adalah
  tes live yang dijaga (`LARAS_SPIKE_LIVE=1`) + cuplikan layar P2.

### Gerbang lain

- `tsc -b`: 0 error. `eslint .`: bersih. `npm run build`: lolos.
- Bundle awal: **143.625 byte gzip** (batas 204.800; baseline P2
  98.065, +45.560 dari Dexie + lapisan data di chunk utama).
  Diukur dengan cara CI: hanya JS yang dirujuk `dist/index.html`.
- Screenshot di `docs/p3/`: `library-360-songs.png`,
  `library-1440-songs.png`, `library-1440-search.png`,
  `library-360-favorites.png`, `library-360-playlist-detail.png`,
  `library-1440-playlist-detail.png`. Diperiksa visual sendiri:
  satu cacat ditemukan dan diperbaiki (baris playlist 360 px
  terpotong karena tombol pindah inline; pindah posisi dipindah
  ke menu lagu, judul kini tampil penuh).

## Perbedaan dari arsitektur §5.1 (dicatat)

- Nama indeks arsitektur memakai `last_played_at`/`played_at`,
  sementara kolom drift memakai `date_added`/`timestamp`. Yang
  dipakai adalah nama kolom drift (kebenaran skema).
- `playback_state` mendapat kolom web `order`, `rate`, `volume`
  (di luar 5 kolom APK) supaya pulih antrean sama persis.
- `queue_items` mendapat kolom web `kind` (stream/lokal); kolom
  APK `source` (asal antrean) dipertahankan apa adanya.
- `songs`/`albums`/`artists` mendapat kolom web `titleKey`/
  `nameKey` (huruf kecil untuk urutan); `search_history` mendapat
  `queryLower` (dedup).
- `song_artists` mendapat indeks `songId` (lihat keputusan 10).

## Checklist 7 skill anti-slop

| Skill | Diterapkan |
| --- | --- |
| local-design-taste-frontend | Mode Operate, design lock monokrom menang atas default; dial DESIGN_VARIANCE 5 / MOTION_INTENSITY 3 / VISUAL_DENSITY 5 dipertahankan; tanpa gradasi dekoratif; satu keluarga ikon Phosphor; target sentuh min 44 px (pindah posisi dipindah ke menu karena tombol 24 px melanggar). |
| local-impeccable | 4 state nyata per daftar; skeleton meniru bentuk baris; empty state jujur (bukan data contoh); galat + "Coba lagi"; hierarki tipografi konsisten; angka UI dari data nyata (`1.000 lagu` dari hitungan database). |
| local-humanizer | Copy Bahasa Indonesia sehari-hari ("Library kamu masih kosong", "Lagu yang kamu sukai..."); tanpa istilah teknis ("cache", "IndexedDB", "token") di UI; tanpa pola AI (tanpa "free tier", tanpa emoji, tanpa em-dash). |
| local-stop-slop | Tanpa filler ("Tentu!", "Berikut adalah"); label singkat; tanpa kalimat pembuka/penutup robotik di dialog. |
| local-no-ai-slop | Tanpa klaim "gratis", tanpa badge promosi, tanpa angka dummy; data contoh jelas berlabel "Contoh" dan hanya masuk lewat tombol uji tersembunyi. |
| local-avoid-ai-writing | Teks UI diperiksa per pola: tanpa em-dash di semua string baru; tanpa huruf kapital berlebihan di label tab; tanpa "Menyelami"/"Komprehensif"/kata haram lain. |
| local-anti-slop (rulebook + ui/copywriting/human/layoutmobile) | Mode `during`; ENERGY 1 / RHYTHM 2 / MOTION 2; kontras AA (teks sekunder min zinc-400); radius konsisten 8-16 px; mobile-first 360 px diperiksa lewat screenshot; bottom sheet menu di mobile, dialog tengah di desktop. |

## Utang

1. **Undo hapus 5 detik** (PRD, USULAN): belum dikerjakan; hapus
   playlist/lagu/riwayat langsung tanpa undo.
2. **Drag-and-drop urut antrean/playlist**: tidak ada (P2 juga
   tidak punya); urutan diubah lewat tombol menu.
3. **Tombol "Buka lagu yang sudah tersimpan"** di panel galat
   pemutar (utang P2): Library kini ada, tombol bisa ditambahkan
   di ronde berikut.
4. **Seret-urut lagu playlist** lewat menu hanya naik/turun satu
   langkah; pindah jauh butuh banyak ketuk.
5. **Artis/album tanpa sampul** memakai huruf awal; sampul YTM
   terisi saat P4 mengambil data jaringan.
6. **IndexedDB penuh** (`QuotaExceededError`) ditangani sebagai
   gagal simpan diam-diam (coba lagi di kesempatan berikut);
   belum ada pesan khusus "penyimpanan penuh" untuk pengguna.
7. **Flake solver QuickJS di VM** (lihat Bukti tes): butuh
   verifikasi CI atau runner lebih cepat; bukan urusan P3.

## Kebutuhan tes perangkat nyata

- Antrean pulih setelah browser HP ditutup paksa (swipe dari
  pengalih tugas) + dibuka lagi, termasuk posisi putar.
- Seed 1.000 lagu di HP kelas bawah: waktu impor + kelancaran
  scroll daftar 50 per halaman.
- Perilaku mode privat (IndexedDB dibatasi): pesan galat Library
  tampil, pemutar tetap jalan tanpa persistensi.
- Pencarian lokal dengan keyboard HP (debounce 300 ms, submit
  Enter) + saran riwayat pencarian.

## File yang berubah

- Baru: `app/src/data/{types,tokens,database,library,queuePersistence,sampleData}.ts`
  + 5 file tes; `app/src/store/library.ts`;
  `app/src/components/library/{LibraryPage,PlaylistDetailPage,SongRow,SongMenu,PlaylistDialog,AddToPlaylistDialog,ConfirmDialog,FavoriteButton,trackFromView}.tsx`;
  `app/src/test-pages/LibraryTestPage.tsx`;
  `app/tests/e2e/library.spec.ts`; `docs/p3/*.png`.
- Diubah: `app/src/player/service.ts` (restore/simpan IndexedDB,
  riwayat putar, pagehide), `app/src/App.tsx` (routing + nav),
  `app/src/components/FullPlayer.tsx` (tombol hati),
  `app/src/strings/id.ts` (string Library), `app/package.json`
  + `package-lock.json` (dexie 4.4.7, fake-indexeddb 6.2.8),
  `CHANGELOG.md`.
- Tidak disentuh: `~/workspace/music-app/` (APK, hanya dibaca),
  `hidden_files/koordinator/log.md`, `app/src/solver/`.
