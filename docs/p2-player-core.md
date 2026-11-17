# P2 Player Core: Laporan

Tanggal: 18 Nov 2026. Tim: A6, B6, B7, B9, B10, A3, A10, C2.
Repo: `adiprmx/laras-web`, branch main. Status: selesai + terverifikasi di VM.
Laporan ini tidak mengklaim apa pun yang butuh perangkat nyata; bagian
itu dicatat di "Butuh tes perangkat nyata".

## Ringkasan

Player core produksi selesai: port pemutar, orkestrator service,
MediaSession, antrean 200 item, shuffle, repeat, kecepatan, re-resolve
tengah lagu, persistensi antrean, bar putar bawah, layar pemutar penuh,
dan daftar antrean. Beranda mendapat seksi "Coba pemutar" berisi lima
lagu kanari nyata sehingga owner bisa menguji pemutar dari preview.

Bukti tes: Vitest 127/127, Playwright E2E 25 lolos + 5 skip (4 skip
adalah uji live yang dijaga `LARAS_SPIKE_LIVE=1`, 1 skip adalah
cuplikan layar di proyek mobile), `tsc -b` 0 error, `eslint` bersih,
build produksi lolos. Bundle awal 97.543 byte gzip (Vite: 98,07 KB),
masih di bawah anggaran 200 KB gzip.

## Yang dibangun

### Logika murni (`app/src/player/`)

| File | Isi |
| --- | --- |
| `types.ts` | `Track`, `TrackSource` (stream/lokal), `RepeatMode`, `PlayerStatus`, `PLAYBACK_RATES` (7 kecepatan 0,5x sampai 2x), `AudioPath`, konstanta antrean |
| `queue.ts` | Model antrean (`items` + `order` + `orderPos`): cap 200, shuffle (Fisher-Yates, RNG injeksi untuk tes deterministik), repeat, prev ambang 3 detik, `playNext`, hapus, `clearExceptCurrent`, durasi sisa |
| `format.ts` | `formatTime` (m:ss, h:mm:ss), `formatRemaining` |
| `recovery.ts` | `StallTracker` (lanjut di 5 detik macet, resolve ulang di 10 detik), `FailureCounter` (berhenti di 3 gagal), `decideOnError`, `decideRestorePosition` (aturan 10 detik / sepertiga durasi PRD) |
| `persistence.ts` | Kunci `laras.player.v1`, cap 100 KB, validasi ketat, `sanitizeQueueForSave` (buang lagu blob/data, petakan ulang urutan) |
| `port.ts` | `AudioPlayerPort` + `HtmlAudioPort`: dua elemen `<audio>` (lihat keputusan di bawah), event hanya dari elemen aktif |
| `mediaSession.ts` | Metadata, 5 action handler, `playbackState` disetel eksplisit (Chromium tidak memperbaruinya otomatis, pelajaran S3/S9), `positionState` terjaga |
| `audioGraph.ts` | Graph Web Audio + probe CORS per host + cache (seed vonis S5: googlevideo tertutup). Rantai P2: source ke gain ke destination; simpul EQ 10 band (P7) disisipkan di tengah tanpa mengubah struktur |
| `service.ts` | `PlayerService` singleton: resolve, muat lagu, watchdog 1 detik, pra-resolve di detik 45, simpan posisi tiap 5 detik + saat jeda/sembunyi/tutup, hook debug `window.__larasPlayer.getState()` |

### Resolve dipromosikan ke produksi

`src/spike/resolve.ts` dipindah ke `src/extractor/resolve.ts` tanpa
mengubah alur (hanya ganti nama `SpikeResolver` ke `StreamResolver`
dan `CanarySong` ke `SongRef`). URL proxy tetap di satu konstanta
`app/src/spike/config.ts`; tidak ada duplikasi. Solver tetap lazy-load.

### Store (`app/src/store/player.ts`)

Zustand menyimpan state saja; semua logika hidup di service. State:
antrean, urutan putar, status, posisi, durasi, buffer, shuffle, repeat,
kecepatan, volume, jalur audio, pesan galat, pesan info, status layar
penuh, catatan pengatur suara.

### UI (`app/src/components/` + `app/src/App.tsx`)

- `MiniPlayer.tsx`: bar 64 px + garis progres, target sentuh 44 px,
  padding safe-area, tombol putar cakram putih.
- `FullPlayer.tsx`: sampul, judul, bilah cari (angka mengikuti seret,
  seek dikirim saat lepas; keyboard langsung), kontrol shuffle/prev/
  putar 72 px/next/repeat, menu kecepatan 7 opsi, volume ("Volume di
  app ini"), tombol Suara (EQ), panel galat + "Coba lagi", banner info,
  catatan EQ, daftar antrean.
- `QueueList.tsx`: urutan putar, durasi sisa antrean, batang "sedang
  diputar" beranimasi (mati bila `prefers-reduced-motion`), hapus per
  lagu, "Hapus semua" (lagu saat ini dipertahankan).
- `TrySongs.tsx`: lima lagu kanari nyata (judul + durasi terverifikasi
  dari probe APK; tanpa nama artis karena tidak terverifikasi).
- `App.tsx`: inisialisasi service sekali (idempotent, aman StrictMode),
  rute tersembunyi `/player-test` (lazy, seperti `/spike`).
- `src/test-pages/PlayerTestPage.tsx`: halaman uji nada lokal lewat
  jalur graph, tanpa jaringan.
- `src/index.css`: gaya slider, `:focus-visible` putih, seleksi putih
  di hitam, keyframes spinner + batang putar, fallback reduced-motion.

### String (`app/src/strings/id.ts`)

Semua copy pengguna di satu tempat, Bahasa Indonesia sehari-hari, tanpa
jargon, tanpa em-dash, tanpa kata "cache". Service memakai string yang
sama (tidak ada copy hardcode di logika).

## Keputusan arsitektur

1. **Dua elemen `<audio>`, bukan satu.** `createMediaElementSource`
   hanya bisa dipanggil sekali per elemen dan merutekan output lewat
   graph selamanya. Media lintas origin tanpa CORS mengeluarkan NOL
   lewat graph (vonis S5). Elemen stream tidak pernah masuk graph;
   elemen lokal yang masuk graph. Hanya elemen aktif yang bersuara.
2. **Streaming tanpa graph; EQ hanya lokal.** Sesuai vonis S5 dan
   arsitektur §3.4. Tanpa proxy audio di v1. Bila pengatur suara
   diminta saat streaming, UI menampilkan pesan jujur.
3. **Pra-resolve di detik 45.** Di bawah perkiraan dinding 1 MiB
   (sekitar 55 detik untuk itag 251) dengan margin. URL segar dipakai
   bila stream putus; gagal pra-resolve diam-diam karena resolve ulang
   reaktif tetap jalan.
4. **Batas waktu resolve keseluruhan 90 detik** (diputuskan di P2,
   selaras batas base.js). Single-flight per videoId: pra-resolve dan
   resolve sesuai permintaan berbagi satu promise.
5. **Aturan pulih posisi dari PRD**: di bawah 10 detik mulai dari 0;
   dalam 10 detik dari akhir pindah ke lagu berikut; lagu di bawah
   30 detik memakai ambang sepertiga durasi.
6. **Galat**: 3 gagal berturut-turut berhenti dengan pesan PRD +
   "Coba lagi". Repeat-one yang gagal berhenti, tidak pindah lagu.
   Pesan: "Lagu tidak bisa diputar sekarang. Periksa koneksi internet
   kamu, lalu coba lagi."
7. **Antrean tersimpan di localStorage** (P3 pindah ke IndexedDB).
   Penyimpanan dibatasi 100 KB; lagu blob tidak disimpan (URL blob
   tidak hidup sesudah muat ulang). Penyimpangan dari aturan
   anti-OOM dicatat di `persistence.ts` dengan rencana migrasi P3.

## Bukti tes

### Vitest: 127/127 (9 file), 18 Nov 2026 18:42 WIB

- Logika pemutar baru, 57 tes: antrean 27, pemulihan 14, persistensi
  12, format 4.
- Resolve 15, App 2, laporan spike 8, solver P1 45 (dihitung dari
  total: 127 kurang 82).
- Perintah: `npx vitest run`. Durasi 63,35 detik.

### Playwright E2E: 25 lolos, 5 skip, 18 Nov 2026 18:42 WIB

Proyek chromium + mobile (Pixel 7), terhadap `vite preview`.
Jaringan di-mock penuh (`context.route`): config gagal ke nilai
bawaan, proxy search/player kalengan (itag 251 URL langsung),
googlevideo dilayani nada WAV 10 detik sadar Range, thumbnail
dilayani PNG 1x1 warna `#18181b`.

Tes pemutar (9 di chromium, 8 di mobile):
memutar/jeda/lanjut, next/prev/ulang-dari-awal, seek/acak/ulang/
kecepatan, MediaSession metadata + playbackState, antrean bertahan
sesudah muat ulang, galat resolve + coba lagi (3 gagal lalu berhenti),
pesan pengatur suara streaming, nada lokal jalur graph + pesan
pengatur suara lokal, cuplikan layar (chromium saja).

Skip: 4 uji live (2 spec x 2 proyek, dijaga `LARAS_SPIKE_LIVE=1`)
dan 1 cuplikan layar di proyek mobile.

### Typecheck + lint + build

- `npx tsc -b`: 0 error.
- `npx eslint .`: bersih, tanpa warning.
- `npm run build`: lolos (Vite 6.4.6, 45,45 detik).

### Bundle (build final, 18 Nov 2026 18:42 WIB)

| Chunk | Mentah | gzip |
| --- | --- | --- |
| JS awal `index-BKBKfAl9.js` | 326.094 byte | 97.543 byte (gzip -9); Vite melaporkan 98,07 KB |
| CSS awal `index-DKWq1pLg.css` | 23.805 byte | 5.452 byte |
| `PlayerTestPage` (lazy) | 2.193 byte | 844 byte |
| `SpikePage` (lazy) | 13.129 byte | 4.883 byte |
| Solver (lazy, ukuran P1) | sekitar 274 KB gzip | tidak berubah |

Baseline P1: JS awal 70,90 KB gzip. Kenaikan sekitar 27 KB gzip
berasal dari kode pemutar + ikon Phosphor. Anggaran 200 KB gzip
tidak jebol (dipakai sekitar 49 persen).

### Cuplikan layar

- `docs/p2/player-360.png` (360 x 640): layar pemutar penuh, sampul,
  judul, bilah cari, kontrol, kecepatan, Suara.
- `docs/p2/player-1440.png` (1440 x 900): kolom tengah max-w-md,
  volume, antrean dengan batang "sedang diputar" dan durasi sisa.

Catatan: sampul di cuplikan adalah PNG mock warna `#18181b` (bukan
thumbnail YouTube asli) karena E2E tidak menyentuh jaringan nyata.

### Cacat yang ditemukan lewat tinjauan visual dan diperbaiki

1. Label ganda "Sisa antrean Sisa 18:19" (label + `formatRemaining`
   sama-sama menulis "Sisa"). Perbaiki: label dihapus, tampil
   "Sisa 18:18".
2. Thumbnail mock hijau: string base64 PNG 1x1 yang dipakai ternyata
   piksel hijau, bukan transparan. Perbaiki: PNG 1x1 warna `#18181b`
   dibuat dari nol (Node zlib + CRC32 manual).

## Checklist 7 skill anti-slop

Dibaca sebelum mendesain: ketujuh SKILL.md + rulebook local-anti-slop
+ sub-skill ui/copywriting/human/layoutmobile. Catatan mode: sebagai
subagent saya tidak bisa menanyakan mode ke user, jadi berjalan dalam
mode `during` sesuai instruksi tugas induk.

### 1. local-design-taste-frontend

- Design Read tercatat: mode operate (pemutar musik), pengguna HP
  Indonesia dengan kuota terbatas, bahasa visual monokrom terkunci,
  dial DESIGN_VARIANCE 5 / MOTION_INTENSITY 3 / VISUAL_DENSITY 5
  (arsitektur §3.1), dial anti-slop ENERGY 1 / RHYTHM 2 / MOTION 2.
- Titik fokus per layar: tombol putar/jeda (bar) dan sampul + tombol
  putar (layar penuh). Satu aksen disengaja: cakram putar putih
  (lingkaran putih, ikon hitam). Motif identitas: garis progres +
  angka waktu tabular.
- Aturan radius: sampul/kartu 12 px, tombol putar bulat, chip pil.
  Font: system stack (nol biaya unduh). Ikon: Phosphor satu keluarga;
  weight fill untuk putar/jeda, regular untuk toggle (aturan
  terdokumentasi di kode).
- Tanpa gradasi dekoratif, tanpa bayangan tebal, tanpa ungu-biru,
  tanpa hero generik.

### 2. local-impeccable

- Target sentuh 44 px minimum di semua tombol (bar, kontrol, hapus
  antrean, menu kecepatan).
- Empat state nyata: loading (spinner di tombol putar), galat (panel
  merah + "Coba lagi"), kosong (bar tidak tampil bila antrean kosong),
  info (banner biru autoplay diblokir).
- `:focus-visible` putih, angka tabular di semua waktu, padding
  safe-area di bar bawah, `prefers-reduced-motion` mematikan animasi
  pemutar, `aria-label`/`aria-pressed` di kontrol.
- Kontras: teks sekunder minimum zinc-400 (`#A1A1AA`); `#71717A`
  tidak dipakai untuk teks di komponen P2.

### 3. local-humanizer

- Copy Bahasa Indonesia sehari-hari di semua layar: "Putar", "Jeda",
  "Acak", "Ulang semua", "Sisa antrean", "Volume di app ini".
- Pesan jujur, bukan janji kosong: "Pengatur suara hanya bisa dipakai
  untuk lagu yang tersimpan di perangkat.", "Pengatur suara belum
  tersedia di versi ini."
- Tanpa frasa AI ("selain itu", "selanjutnya", "tentu saja"), tanpa
  emoji, tanpa kata "cache", tanpa em-dash.

### 4. local-stop-slop

- Label pendek dan langsung; tidak ada sapaan, tidak ada ajakan
  pemasaran, tidak ada kalimat pengisi di layar mana pun.
- Judul seksi "Coba pemutar" + satu kalimat penjelasan, bukan
  paragraf fitur.

### 5. local-no-ai-slop

- Tanpa pola slop visual: tanpa gradasi ungu, tanpa kartu kaca
  berlebihan, tanpa ikon generik buatan tangan (Phosphor nyata).
- Tanpa data palsu: lima lagu kanari adalah lagu nyata dengan durasi
  terverifikasi; nama artis tidak ditampilkan karena tidak
  terverifikasi (diisi "Sedang diputar" di bar, bukan nama karangan).
- Tanpa angka dummy: durasi antrean dihitung dari durasi nyata;
  durasi yang belum diketahui ditandai "(+N belum diketahui)".

### 6. local-avoid-ai-writing

- Copy diperiksa terhadap pola AI-ism: tanpa "selain itu",
  "selanjutnya", "dengan demikian", tanpa hedging ("mungkin", "bisa
  jadi") di pesan galat. Pesan galat memakai kalimat perintah yang
  jelas: "Periksa koneksi internet kamu, lalu coba lagi."
- Komentar kode menjelaskan "kenapa", bukan mengulang "apa".

### 7. local-anti-slop (rulebook)

- Mode `during` (lihat catatan di atas). Tanpa placeholder, tanpa
  lorem, tanpa state kosong palsu: beranda tidak lagi mengklaim
  "Belum ada lagu di sini" padahal ada lima lagu yang bisa diputar.
- Semua angka di UI berasal dari data nyata atau hitungan eksak
  (durasi antrean = jumlah durasi lagu dikurangi posisi saat ini).
- Aturan yang sengaja tidak dipakai: tidak ada. Satu penyimpangan
  arsitektur dicatat terbuka (localStorage untuk antrean, migrasi
  IndexedDB di P3), bukan disembunyikan.

## Utang dan batasan

1. **Re-resolve tengah lagu belum ada tes E2E.** Logika pemulihan
   teruji unit (StallTracker, decideOnError, FailureCounter) dan
   mekanisme ganti sumber terbukti di harness S3, tetapi E2E butuh
   pemutaran panjang atau injeksi macet; nada 10 detik di-buffer
   penuh oleh Chromium sehingga gangguan jaringan tengah lagu tidak
   bisa dipicu andal. Utang untuk ronde berikut.
2. **Seret-urut antrean (drag-and-drop)** tidak ada di P2.
3. **Prefetch lagu berikut** tidak ada; hanya pra-resolve lagu saat
   ini di detik 45.
4. **Headset dicabut**: ditangani native oleh browser (tidak ada
   event standar); tidak ada logika khusus.
5. **Tombol "Buka lagu yang sudah tersimpan"** di panel galat belum
   ada (butuh Library/P3); panel hanya punya "Coba lagi".
6. **Kontrol EQ 10 band** adalah P7. Rantai graph sudah siap
   (source ke gain ke destination); pesan EQ jujur sudah ada.
7. **IndexedDB penuh** adalah P3. localStorage sekarang, cap 100 KB.
8. **Drift token desain**: arsitektur §3.8 menulis elevated
   `#1C1C1E`, kode memakai `#18181b`; token `text-muted` di CSS
   `#52525b` vs `#8E8E93` di dokumen. Komponen P2 memakai zinc-400
   minimum untuk teks; penyelarasan token diserahkan ke ronde desain.
9. **Tombol bisu** mengembalikan volume ke 1 (bukan volume sebelum
   dibisukan). Perilaku ini sederhana dan terdokumentasi; kembalikan
   volume sebelumnya bila owner meminta.

## Butuh tes perangkat nyata (tidak diklaim)

1. **Lock screen HP**: MediaSession metadata + handler + playbackState
   terbukti benar di Chromium VM (tes E2E), tetapi tampilan dan
   kontrol di lock screen Android/iOS butuh HP nyata.
2. **Audio latar**: lagu terus berbunyi saat browser diminimalkan
   atau layar dikunci; butuh HP nyata.
3. **Pemutaran live**: dari VM, googlevideo memblokir IP VM (terbukti
   S3). Uji live dijaga `LARAS_SPIKE_LIVE=1` dan hanya jalan dari
   browser di luar VM. Pemutaran live dari preview di HP owner adalah
   bukti akhir yang belum ada.
4. **iOS Safari**: graph Web Audio, MediaSession, dan autoplay butuh
   uji di iPhone nyata (VM hanya punya Chromium).
5. **Headset dan tombol media fisik**: handler MediaSession terdaftar,
   tetapi tombol headset nyata belum diuji.

## Pelajaran yang ditemukan selama P2 (untuk AGENTS.md koordinator)

1. **`page.route` tidak mencegat request `<audio>` ke localhost**
   di Playwright 1.65.1 (terbukti deterministik 2/2 tiap arah di
   debug-route5.mjs). `context.route` selalu mencegat. Semua mock
   E2E pemutar memakai `context.route`.
2. **Pola glob `**/...` (diawali `**/`) tidak cocok** dengan URL
   localhost di Playwright 1.65.1 (terbukti hit=0, fallback SPA
   mengembalikan HTML). Rute nada lokal memakai regex.
3. **Base64 PNG 1x1 "transparan" yang beredar ada yang hijau.**
   Verifikasi warna piksel sebelum dipakai sebagai mock gambar;
   lebih aman membuat PNG dari nol dengan warna yang diinginkan.

## File yang berubah

Baru: `app/src/player/{types,queue,format,recovery,persistence,port,
mediaSession,audioGraph,service}.ts`, `app/src/player/{queue,format,
recovery,persistence}.test.ts`, `app/src/extractor/resolve.ts` (+tes,
pindahan dari `src/spike/`), `app/src/components/{MiniPlayer,
FullPlayer,QueueList,TrySongs}.tsx`, `app/src/test-pages/
PlayerTestPage.tsx`, `app/tests/e2e/player.spec.ts`,
`docs/p2/player-360.png`, `docs/p2/player-1440.png`,
`docs/p2-player-core.md`.

Diubah: `app/src/store/player.ts` (tulis ulang penuh),
`app/src/App.tsx`, `app/src/index.css`, `app/src/strings/id.ts`,
`app/src/App.test.tsx`, `app/tests/e2e/smoke.spec.ts`,
`app/src/spike/SpikePage.tsx` (impor resolve baru),
`app/package.json` + `package-lock.json` (`@phosphor-icons/react`
2.1.10, satu-satunya dependensi baru), `CHANGELOG.md`.

Dihapus: `app/src/spike/resolve.ts` + `app/src/spike/resolve.test.ts`
(pindah ke `src/extractor/`).
