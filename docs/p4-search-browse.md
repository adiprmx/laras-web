# P4: Pencarian dan Browse

Tanggal: 18 November 2026. Tim: B4, B5, B1, B2, B3, A13, A12,
diperankan satu agen bergiliran.
Status: **kode selesai; terverifikasi kecuali run ulang E2E build
final + pengambilan ulang screenshot — keduanya TERBLOKIR
sandbox VM (Chromium tidak bisa diluncurkan sejak ~01:05 WIB)
dan WAJIB dijalankan ulang koordinator di CI / lingkungan
sehat** (lihat Bukti tes dan catatan lingkungan).

Paket TERAKHIR sebelum scope freeze. Sesudah paket ini, tidak ada
fitur baru — hanya P5 (unduhan), P6 (pengaturan), dan perbaikan.

## Ringkasan

P4 mengubah Laras Web dari "pemutar + library lokal" menjadi aplikasi
musik yang bisa mencari dan menjelajah katalog YouTube Music:
pencarian InnerTube (`/youtubei/v1/search`) lewat proxy yang sudah
ada, saran pencarian (riwayat + lokal + jaringan dengan debounce),
riwayat pencarian 100 kueri di IndexedDB (pola P3), beranda 6 seksi
sesuai PRD, Jelajah dari endpoint browse, dan rumus "Lagu untukmu"
yang sepenuhnya lokal (riwayat putar + favorit + library — tanpa
server, tanpa telemetri). Navigasi utama kini bar bawah di HP / rail
kiri di desktop; seksi "Coba pemutar" (placeholder P2) dihapus.

Proxy TIDAK berubah: `workers/proxy/src/index.js` ternyata sudah
mengizinkan `/api/innertube/search`, `/api/innertube/browse`, dan
`/api/innertube/suggestions` (batas 10 MB, timeout 30 dtk) — tidak
ada yang perlu dideploy ulang koordinator untuk P4.

## Yang dibangun

### Ekstraktor (`app/src/extractor/`)

| File | Isi |
| --- | --- |
| `innertube.ts` | `postInnertube(path, body, client, timeoutMs)` bersama + `InnertubeError` (bad-json/http/rate-limited). Satu konstanta URL proxy dari `src/spike/config.ts` — tidak ada URL proxy kedua. |
| `searchParser.ts` | Port setia `search_parser.dart` APK: `parseGroupedSearchResults`, `parseBrowsePage`, `parseSearchSuggestions`, cadangan toleran `parseSearchSongsTolerant`, cap 100 item/grup, thumbnail hanya dari allowlist yang sudah ada. |
| `searchService.ts` | `SearchService` (client WEB_REMIX, tangkap visitorData malas dari respons search), `search()`, `browse()`, `browseHome()` (FEmusic_home), `suggestions()` (maks 8). `SearchError` berkind (network/http/rate-limited/parse) dengan pesan ramah pengguna. Timeout UI 15 dtk (PRD B1.1: skeleton maks 15 dtk lalu galat), saran 10 dtk. |
| `resolve.ts` | `postViaProxy` direfaktor ke `postInnertube` bersama (pesan galat identik; satu perbaikan: HTTP 429 tanpa kode RATE_LIMITED kini juga tergolong rate-limited). |
| `test-fixtures/` | 7 rekaman nyata dari APK (15–16 Nov 2026): search-peterpan, browse-home, browse-moods, browse-artist, browse-album, browse-playlist, suggest-noah. Dipakai tes unit parser DAN mock E2E. |

### Lapisan data (`app/src/data/`)

| File | Isi |
| --- | --- |
| `recommendations.ts` | Rumus "Lagu untukmu" murni: putaran bermakna (≥30 dtk) dalam 30 hari terakhir = 1 poin/putaran, favorit +5, unduhan +2; pengisi dari lagu library terbaru bila kandidat < 20. `FOR_YOU_LIMIT = 20`. |
| `browseCache.ts` | Cache Jelajah di `app_meta` (kunci `browseHomeCache`, TTL 6 jam, cap 512 KB). |
| `library.ts` | Tambah `LibraryService.forYouSongs()`: satu kueri rentang berindeks `[timestamp+id]` untuk event 30 hari + kunci primer lagu favorit/unduhan; pengisi via halaman keyset. Riwayat pencarian 100 kueri SUDAH ada dari P3 (`MAX_SEARCH_HISTORY`, dedup tanpa beda kapital) — P4 memakai ulang, tanpa store baru. |

### UI (`app/src/components/`)

| File | Isi |
| --- | --- |
| `home/HomePage.tsx` | Beranda 6 seksi sesuai urutan PRD: Baru diputar, Lagu untukmu, Sering diputar, Playlist kamu, Unduhan, Jelajah (3 rak pertama, cache-first + refresh latar, status basi/offline/galat). Empty state pengguna baru hanya bila Jelajah juga gagal/kosong. |
| `search/SearchPage.tsx` | Pencarian URL-driven (`/search?q=`): kirim eksplisit saja (tombol/Enter — TIDAK PERNAH search-as-you-type; dibuktikan penghitung permintaan di E2E), saran gabung riwayat (maks 4) + judul lokal (maks 4) + jaringan setelah debounce 300 ms (isi sampai 8), grup lokal "Dari Library-mu" + grup jaringan Lagu/Album/Artis/Playlist, "Lihat semua" per grup (fetch terfilter bila ada filterParams, kalau tidak kembangkan hasil terparse s.d. 50), riwayat dengan hapus satu + hapus semua (dialog konfirmasi), spanduk offline, catatan galat jaringan bila hasil lokal ada, galat penuh + coba lagi bila gagal total. |
| `browse/BrowsePage.tsx` | `/browse` (beranda Jelajah, cache yang sama dengan beranda) dan `/browse/:browseId` (detail artis/album/playlist/mood: kepala + "Putar semua" + rak). Galat parse dibedakan dari galat lain (PRD B6.5). |
| `browse/BrowseShelves.tsx` | Rak bersama beranda + halaman browse: daftar lagu vertikal untuk rak lagu, kartu horizontal untuk sisanya. |
| `browse/browsePlay.ts` | Putar lagu rak dari indeks ketuk (sisa rak masuk antrean). |
| `BottomNav.tsx` | Satu DOM: bar bawah di HP, rail kiri 72 px di lebar ≥840 px. Tiga tab: Beranda, Cari, Library. (Tab Unduhan menyusul P5 — tidak ada tab mati.) |
| `TrackRow.tsx`, `SkeletonList.tsx`, `BrowseCard.tsx` | Baris lagu generik, skeleton, kartu browse (132/148 px, lencana putar untuk lagu). |
| `test-pages/P4TestPage.tsx` | Rute tersembunyi `/p4-test`: skenario deterministik (B 9 putaran, A 3 putaran + favorit, C 1 putaran + unduh, D terbaru, E 2 putaran, F tanpa putaran; 1 playlist; 1 unduhan) + hapus database. |

### Rute & navigasi (`app/src/App.tsx`)

- `/` beranda (impor statis — rute default), `/search?q=` dan
  `/browse[/:id][?params=]` lazy, `/library?tab=` (tab awal),
  `/p4-test` tersembunyi. `parseRoute` kini menerima query string.
- Header pill (Beranda/Library) dan placeholder pencarian
  nonaktif dihapus; judul tetap tombol ke beranda.
- MiniPlayer mendapat prop `withNav`: duduk di atas bar tab di HP
  (`calc(3.5rem + safe-area)`), kembali ke bawah + geser 72 px di
  desktop (kelas `.mini-player-nav-offset` di `index.css`).
- `TrySongs.tsx` dihapus; `App.test.tsx` ditulis ulang untuk
  navigasi baru.

### Keputusan desain (mengikat)

1. **Kirim eksplisit, tanpa pengecualian.** Mengetik tidak pernah
   memanggil `/search` (hemat kuota + PRD). Saran jaringan lewat
   endpoint `/suggestions` terpisah setelah debounce 300 ms —
   bukan pencarian penuh per ketik.
2. **Parser port setia APK, bukan tulis ulang.** Termasuk quirk
   traversal DFS terbalik `collectListItems` (uji cap menegaskan
   urutan itu — jangan "diperbaiki"). Fixture rekaman nyata yang
   sama dipakai tes unit dan E2E.
3. **"Lagu untukmu" lokal 100%.** Tidak ada panggilan server,
   tidak ada telemetri. Rumus terdokumentasi di PRD B6.2 dan
   diuji dengan contoh hitung PRD (B 9 > A 8 > C 3).
4. **Cache Jelajah 6 jam, tampil-dulu-segarkan-belakangan.**
   Cache segar = tanpa panggilan jaringan (dibuktikan E2E:
   muat ulang tidak menambah penghitung browse). Cache basi
   tampil dulu lalu disegarkan di latar; gagal refresh
   menampilkan data terakhir + pemberitahuan basi.
5. **Riwayat disimpan hanya bila pencarian tidak gagal total.**
   Sukses jaringan ATAU hasil lokal tidak kosong → simpan.
   Gagal total (galat jaringan + lokal kosong) → jangan simpan
   kueri yang tidak menghasilkan apa-apa.
6. **Satu DOM navigasi.** Bar bawah dan rail adalah satu komponen
   yang berubah bentuk lewat CSS — testid tombol unik di semua
   ukuran layar, tidak ada duplikat tersembunyi.
7. **Bundle awal dilindungi.** SearchPage/BrowsePage lazy;
   HomePage mengimpor searchService secara dinamis hanya untuk
   Jelajah. Bundle awal 151.011 byte gzip (batas 204.800).

## Kriteria selesai (terbukti)

- Preview mencari lagu (hasil YTM tampil): E2E `search.spec.ts`
  (mock) + `live/search-live.spec.ts` (proxy produksi, lihat
  Bukti tes).
- Beranda 6 seksi: E2E `home.spec.ts` (urutan PRD + isi skenario
  + rumus "Lagu untukmu" B/A/C/E/D/F).
- Membuka hasil browse: E2E `browse.spec.ts` (beranda Jelajah,
  detail playlist/artis/album/mood, "Putar semua", putar lagu).

## Bukti tes

### Vitest: 276/276 lolos (18 Nov 2026, 00:24 WIB)

Baseline P3 220 + 56 baru P4: parser 25, layanan search 14,
rekomendasi 13, cache browse 4. Semua file tes: 18 passed (18).
Termasuk: ekspektasi fixture (search 7 lagu/1 album/1 artis/
1 playlist, browse-home 2 rak, saran 6 item), cap 100 item/grup,
contoh hitung PRD B/A/C, riwayat 100 kueri (P3, tetap lolos),
refaktor resolve (15/15 tetap lolos).

### Playwright E2E: 97 lolos + 5 dilewati pada build sebelum perbaikan sampul; run ulang build final TERBLOKIR sandbox VM

- Suite penuh pada build sebelum perbaikan sampul: **97 lolos,
  5 dilewati** (18 Nov 2026, ~00:40 WIB, 4,7 mnt) — termasuk
  26 tes P4 × 2 proyek.
- P4 chromium-only: 25/25 lolos sebelum perbaikan sampul
  (18 Nov 2026, 00:35 WIB, 37 dtk) + 1 tes fallback sampul baru
  (× 2 proyek → total harapan run ulang: 99 lolos + 5 dilewati).
- **Run ulang build final (dengan perbaikan sampul + 1 tes baru)
  TIDAK BISA dijalankan di VM ini**: sejak ~01:05 WIB Chromium
  VM mati saat diluncurkan (SIGTRAP di zygote; `mmap() failed:
  Operation not permitted` — sandbox VM memblokir syscall).
  Satu percobaan run ulang menghasilkan ringkasan "11 passed"
  yang TIDAK DAPAT DIPERCAYA (89 file error-context 0 byte,
  `.last-run.json` 0 byte — catatan run-nya sendiri rusak
  EPERM). Ini kegagalan lingkungan, BUKAN produk: perubahan
  sejak run 97-lolos hanya fallback `onError` di 3 komponen
  (TrackRow, BrowseCard, kepala BrowsePage) + mock host sampul
  + 1 tes baru — semuanya lolos `tsc -p` (2 config, exit 0)
  dan `eslint .` penuh (exit 0, diverifikasi ulang ~01:14 WIB).
  **Koordinator WAJIB menjalankan ulang suite penuh di CI
  (GitHub Actions) atau lingkungan sehat sebelum push** — CI
  adalah gerbang otoritatif.
- Tes P4 meliputi: mengetik = 0 panggilan search (penghitung
  permintaan), saran riwayat + jaringan, riwayat simpan/buka/
  hapus-satu/hapus-semua, "Lihat semua" 10 → 21 lagu (fixture
  diperluas: 7 lagu asli × 3 — 6 item daftar + 1 kartu hasil
  teratas), putar dari hasil/beranda/browse, galat + coba lagi,
  offline (hasil lokal tetap tampil), cache Jelajah (muat ulang
  = 0 panggilan browse), sampul gagal → ubin huruf awal
  (bukan kotak kosong).
- Tes live (`tests/e2e/live/search-live.spec.ts`,
  `playwright.live.config.ts`, LARAS_SPIKE_LIVE=1): **0/3 dari VM
  — BUKAN cacat produk.** Browser VM tidak bisa mencapai host
  eksternal sama sekali (fetch ke proxy gagal `TypeError: Failed
  to fetch` walau `navigator.onLine` true; terbukti dengan
  evaluasi langsung di Chromium VM). Proxy sendiri SEHAT:
  curl dari VM mengembalikan HTTP 200 + data nyata
  (search "noah" 237.750 byte, browse home 399.183 byte,
  browse artis 556.581 byte), dan ketiganya TERPARSE oleh
  parser produksi (search → 14 lagu / 3 album / 3 artis /
  6 playlist; home → 1 rak "Throwbacks" 10 item; artis →
  judul "NOAH" + rak). Spesifikasi live harus dijalankan dari
  browser di luar VM (pola yang sama seperti uji live P1/P2).
  Catatan: judul artis live adalah "NOAH" (kapital) sementara
  fixture merekam "Noah" — asersi live memakai regex tanpa
  beda kapital.

### Temuan dari pemeriksaan screenshot (diperbaiki di P4)

Pemeriksaan visual screenshot pertama menemukan cacat nyata:
sampul dari host `yt3.googleusercontent.com` / `lh3.google
usercontent.com` (album/artis/playlist) tidak di-mock sehingga
gagal dimuat di browser VM — kartu browse tampil sebagai kotak
hitam kosong, baris lagu kehilangan ubin sampul. Dua perbaikan:
(1) produksi — `TrackRow`, `BrowseCard`, dan kepala
`BrowsePage` kini jatuh ke ubin huruf awal bila `<img>` gagal
(`onError`), bukan kotak kosong; (2) mock — ketiga host sampul
YTM di-mock di `p4-helpers.ts` dan `player.spec.ts`. Tes
regresi E2E ditambahkan (sampul 500 → ubin "S" tampil, 0 `<img>`).
Screenshot di `docs/p4/` adalah set SEBELUM perbaikan (itulah
yang memperlihatkan cacatnya); pengambilan ulang sesudah
perbaikan TERBLOKIR sandbox VM (Chromium tidak bisa
diluncurkan — lihat catatan lingkungan). Koordinator mengambil
ulang di lingkungan sehat.

### Gerbang lain

- `npx tsc -b`: 0 galat TIPE, tetapi exit 1 karena TIDAK BISA
  menulis file status incremental (`.tsbuildinfo`, EPERM —
  lihat catatan lingkungan di bawah). Bukti tipe bersih yang
  sah: `tsc -p tsconfig.app.json` dan `tsc -p tsconfig.node.json`
  masing-masing exit 0 (tanpa menulis buildinfo). CI GitHub
  Actions (lingkungan normal) adalah gerbang otoritatif untuk
  `tsc -b`.
- `npx eslint .`: bersih (seluruh repo, termasuk tes E2E).
- `npm run build`: lolos (sesudah 2x gagal EPERM lingkungan —
  retry berhasil; lihat catatan lingkungan).
- Bundle awal: **151.037 byte gzip** (batas 204.800; baseline P3
  143.816 per tugas / 143.625 per dokumen P3 — selisih 191 byte
  antar sumber, tidak dikejar; kenaikan P4 ≈ +7.200 byte dari
  beranda statis + navigasi + fallback sampul). Hanya JS yang
  dirujuk `dist/index.html`, diukur dengan skrip yang sama
  seperti CI.
- Screenshot 360 px + 1440 px: `docs/p4/` — set SEBELUM
  perbaikan sampul (mendokumentasikan cacat yang ditemukan);
  pengambilan ulang sesudah perbaikan TERBLOKIR sandbox VM
  (lihat catatan lingkungan).

### Catatan lingkungan: EPERM intermiten → blokir syscall (18 Nov 2026, ~00:52–01:20+ WIB)

Sejak ~00:52 WIB, proses Node tertentu di VM ini gagal menulis
file dengan `EPERM: operation not permitted, write` — secara
INTERMITEN per pemanggilan: `tsc -b` (tulis `.tsbuildinfo`),
`vite build` (tulis temp config), `npm` (cache), bahkan
`ts.sys.writeFile` dan `cp` file besar. Penyelidikan
(±20 menit, belasan eksperimen terkendali): bukan izin file
(root, 72 GB bebas), bukan ukuran tulis (5 MB lolos), bukan
path (gagal juga di /tmp), bukan cara tulis (`writeFileSync`
vs `openSync`+`writeSync` sama-sama kena di pemanggilan yang
"sial"). Pola yang konsisten: pemanggilan kecil sering lolos,
pemanggilan besar (tsc/vite) sering gagal, retry pada
pemanggilan baru sering berhasil (`vite build` lolos di
percobaan ke-2; `vitest` 13/13 lolos di tengah periode yang
sama). Diduga flapping kebijakan sandbox VM, BUKAN cacat kode
atau repo.

**Eskalasi ~01:05 WIB:** sandbox kini juga memblokir `mmap`
(`mmap() failed: Operation not permitted`) — Chromium VM
(headless shell MAUPUN full chrome, semua flag termasuk
`--no-zygote --single-process`) mati SIGTRAP saat diluncurkan,
dan `vitest` gagal di pemuatan config (EPERM tulis temp file,
5/5 percobaan gagal ~01:15 WIB). Dampak ke P4: run ulang E2E
penuh build final + pengambilan ulang screenshot + konfirmasi
Vitest akhir TERBLOKIR di VM ini. Yang tetap berdiri sebagai
bukti terukur: Vitest 276/276 (00:24 WIB — tidak ada file yang
diuji Vitest berubah sesudah itu; perbaikan sampul hanya
menyentuh komponen tanpa tes unit), E2E 97+5 (00:40 WIB,
build sebelum perbaikan sampul), `tsc -p` 2 config exit 0
(00:55 WIB, sesudah edit sumber terakhir), `eslint .` penuh
exit 0 (diverifikasi ulang ~01:14 WIB), `vite build` lolos +
bundle 151.037 byte gzip (~01:03 WIB, build final).
Koordinator WAJIB menjalankan ulang E2E penuh + screenshot
di CI / lingkungan sehat — CI adalah gerbang otoritatif.

## Screenshot

Enam cuplikan (seeded + mocked, set SEBELUM perbaikan sampul —
itulah yang memperlihatkan cacat sampul kosong):
`docs/p4/home-360.png`, `home-1440.png`, `search-360.png`,
`search-1440.png`, `browse-360.png`, `browse-1440.png`.
Diperiksa visual satu per satu: beranda menampilkan urutan
yang benar (Baru diputar D/C/B/A/E, "Lagu untukmu" B/A/C),
navigasi bar bawah (HP) dan rail kiri (desktop) benar, hasil
pencarian berkelompok dengan sampul, rak Jelajah berkartu
sampul. Satu cacat ditemukan dan diperbaiki dari pemeriksaan
ini (sampul kosong — lihat "Temuan" di atas). Pengambilan
ulang sesudah perbaikan TERBLOKIR sandbox VM (Chromium tidak
bisa diluncurkan); koordinator mengambil ulang di lingkungan
sehat.

## Checklist 7 skill anti-slop

| Skill | Bukti penerapan |
| --- | --- |
| design-taste-frontend | Operate-mode music app; arah desain dikunci dari PRD + arsitektur §3.1 (monokrom hitam/putih, dials variance 5 / motion 3 / density 5); bar bawah + rail mengikuti pola aplikasi musik nyata, bukan template generik. |
| impeccable | Audit visual per layar: 44 px area sentuh minimum, kontras AA (teks sekunder min zinc-400), 4 state per layar (default/loading skeleton/empty jujur/error + coba lagi), tidak ada UI mati (tab Unduhan ditunda, bukan tab kosong). |
| humanizer | Copy Indonesia sehari-hari di semua pesan ("Lagu tidak bisa diputar sekarang", "Coba lagi"), tanpa istilah teknis (tidak ada kata "cache", "resolve", "endpoint" di UI — ditegaskan App.test.tsx). |
| stop-slop | Tanpa basa-basi, tanpa label bergaya AI; pesan galat memberi aksi (coba lagi / periksa koneksi), bukan kalimat hiasan. |
| no-ai-slop | Tidak ada pola AI-slop: tanpa gradasi dekoratif, tanpa emoji, tanpa "✨", tanpa klaim trust-bait; warna hanya fungsi/status. |
| avoid-ai-writing | Teks UI ditulis ulang dengan suara produk, bukan suara template ("Dari Library-mu", "Lagu untukmu", "Baru diputar" — bukan "Hasil Pencarian Lokal" / "Rekomendasi Algoritma"). |
| anti-slop | Checklist ini + audit: tidak ada angka fabrikasi (semua angka dari tes terukur), tidak ada data contoh yang tampil seolah nyata (data uji berlabel jelas dan hanya masuk lewat halaman uji tersembunyi). |

## Utang

1. **Tombol "Periksa pembaruan" (P6).** PRD B6.5 memintanya untuk
   galat parse browse; maknanya (refresh remote-config + cek
   ulang canary) milik P6. P4 menampilkan "Coba lagi" (retry
   browse) dan TIDAK mengirim tombol berlabel salah.
2. **Tab Unduhan + "Lihat semua" Unduhan (P5).** Seksi Unduhan di
   beranda tidak punya tombol "Lihat semua" karena belum ada
   halaman tujuannya; tab navigasi Unduhan menyusul bersama
   layar Unduhan P5.
3. **Paginasi lanjutan pencarian.** Parser mengekstrak
   `continuation` hanya untuk halaman browse dua kolom;
   "Lihat semua" pencarian menampilkan s.d. 50 item terparse
   tanpa fetch lanjutan. Perlu endpoint continuation bila YTM
   mengembalikan hasil > 50 yang penting.
4. **Undo hapus riwayat 5 dtk** (utang P3, masih terbuka).
5. **Gesture pull-to-refresh Jelajah.** Tombol "Muat ulang
   jelajah" ada; gesture tarik-belumlah.
6. **Angka baseline bundle P3 berbeda antar sumber** (143.816 di
   tugas vs 143.625 di dokumen P3 — selisih 191 byte). Tidak
   memengaruhi anggaran; dicatat supaya tidak membingungkan.

## Kebutuhan tes perangkat nyata

- Navigasi bar bawah + rail di HP Android nyata (safe-area,
  tinggi bar 56 px, mini player di atasnya).
- Putar lagu dari hasil pencarian di HP owner (hipotesis P0-2
  APK: IP HP kena cek bot YouTube — perlu bukti di perangkat
  nyata, bukan VM).
- "Lagu untukmu" dengan riwayat putar nyata selama berminggu-minggu
  (rumus teruji dengan data sintetis; rasa urutannya butuh
  pemakaian nyata).
- Jelajah offline di perjalanan (cache 6 jam + mode pesawat).

## File yang berubah

Baru: `app/src/extractor/innertube.ts`,
`app/src/extractor/searchParser.ts`,
`app/src/extractor/searchParser.test.ts`,
`app/src/extractor/searchService.ts`,
`app/src/extractor/searchService.test.ts`,
`app/src/extractor/test-fixtures/` (7 JSON),
`app/src/data/recommendations.ts`,
`app/src/data/recommendations.test.ts`,
`app/src/data/browseCache.ts`, `app/src/data/browseCache.test.ts`,
`app/src/components/TrackRow.tsx`,
`app/src/components/SkeletonList.tsx`,
`app/src/components/BrowseCard.tsx`,
`app/src/components/BottomNav.tsx`,
`app/src/components/home/HomePage.tsx`,
`app/src/components/search/SearchPage.tsx`,
`app/src/components/browse/BrowsePage.tsx`,
`app/src/components/browse/BrowseShelves.tsx`,
`app/src/components/browse/browsePlay.ts`,
`app/src/test-pages/P4TestPage.tsx`,
`app/tests/e2e/p4-helpers.ts`, `app/tests/e2e/search.spec.ts`,
`app/tests/e2e/home.spec.ts`, `app/tests/e2e/browse.spec.ts`,
`app/tests/e2e/live/search-live.spec.ts`,
`app/playwright.live.config.ts`, `docs/p4/` (screenshot).

Diubah: `app/src/extractor/resolve.ts` (refaktor ke postInnertube),
`app/src/data/library.ts` (forYouSongs),
`app/src/components/library/LibraryPage.tsx` (initialTab),
`app/src/components/MiniPlayer.tsx` (withNav),
`app/src/App.tsx` (rute P4 + navigasi),
`app/src/App.test.tsx`, `app/src/strings/id.ts` (string P4, hapus
string TrySongs), `app/src/index.css` (.mini-player-nav-offset),
`app/tsconfig.app.json` (resolveJsonModule),
`app/playwright.config.ts` (testIgnore live),
`app/tests/e2e/player.spec.ts` (putar dari pencarian),
`app/tests/e2e/library.spec.ts` (mock search/browse),
`app/tests/e2e/smoke.spec.ts` (beranda 6 seksi),
`CHANGELOG.md`.

Dihapus: `app/src/components/TrySongs.tsx`.
