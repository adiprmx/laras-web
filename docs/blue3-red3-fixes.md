# Blue 3 — Perbaikan Temuan Audit Red 3 (Laras Web)

**Tanggal:** 19 November 2026.
**Auditor yang diperbaiki:** Red 3 (`docs/red3-audit.md`, 16 temuan:
1 sedang, 7 rendah, 8 info).
**Remote HEAD saat mulai:** 029c5dd2 (P8). **Tanpa push, tanpa deploy**
— koordinator yang memverifikasi, push, dan deploy.
**D1 tidak pernah di-query untuk data sesi/token pengguna.**
Migrasi hanya diuji di SQLite lokal (`/tmp`, database buatan).

## Ringkasan vonis

| Temuan | Tingkat | Status |
|---|---|---|
| S6 — callback tanpa rate limit + state bisa dipakai ulang | Sedang (wajib) | **DITUTUP** (rate limit + state single-use) |
| R10 — ALLOWED_ORIGINS produksi memuat localhost | Rendah | **DITUTUP di repo** (redeploy oleh koordinator) |
| R11 — push playlist/item tanpa cek kepemilikan | Rendah | **DITUTUP** |
| R12 — impor backup baca penuh sebelum cek 10 MB | Rendah | **DITUTUP** |
| R13 — impor Spotify jalur file tanpa cap | Rendah | **DITUTUP** |
| R14 — parser backup tanpa cap per-field/per-koleksi | Rendah | **DITUTUP** |
| R15 — hapus semua data tidak mengakhiri sesi sync | Rendah | **DITUTUP** |
| R16 — nama playlist impor Spotify tidak divalidasi | Rendah | **DITUTUP** |
| I11 — klasifikasi AbortError salah | Info | **DITUTUP** |
| I12 — parseCookies tanpa try/catch | Info | **DITUTUP** |
| I13 — recordToResult tanpa validasi record null | Info | **DITUTUP** |
| I14 — worker sync tanpa nosniff/CSP halaman 503 | Info | **DITUTUP** |
| I15 — tes rateLimit flaky | Info | **DITUTUP** |
| I16 — db.batch bukan transaksi atomik | Info | **DIDOKUMENTASIKAN** (tanpa restrukturisasi, lihat bawah) |
| I17 — header x-proxy-cpu-ms | Info | **TETAP DITUNDA** (keputusan Blue 1, dipertahankan) |
| I18 — allowlist hash player di-hardcode | Info | **TETAP DITUNDA** (keputusan Blue 1, dipertahankan) |

**Syarat release candidate terpenuhi:** S6 ditutup penuh
(rate limit + state single-use, bukan hanya rate limit).

---

## S6 — `/api/auth/callback` tanpa rate limit + state bisa dipakai ulang (SEDANG, WAJIB)

**Perubahan:**
- `workers/sync/src/index.js:955-972` (router): callback dicek
  rate limit `auth-callback:<ip>`, 10/mnt/IP (`RATE_AUTH_PER_MIN`,
  sama seperti login), SEBELUM `handleCallback` (sebelum tukar
  kode). Kelebihan dibalas 429 JSON + `Retry-After: 60`.
- `workers/sync/src/index.js:335-366` (`storeOAuthState`):
  login menyimpan hash SHA-256 state ke D1 (tabel `oauth_states`,
  TTL 10 menit) + menyapu baris kedaluwarsa tiap login.
  Best-effort: gagal simpan tidak mematikan login.
  Dipanggil di `:444`.
- `workers/sync/src/index.js:373-401` (`consumeOAuthState`):
  callback menghapus baris state saat dipakai; state yang sudah
  dipakai, tidak dikenal, atau kedaluwarsa ditolak
  (`:555-557`, sebelum tukar kode). Galat D1 fail-open ke
  "diizinkan" supaya login tidak mati total bila tabel belum
  termigrasi atau D1 mati sesaat — rate limit tetap melindungi
  kuota dalam keadaan itu. Koordinator WAJIB menerapkan migrasi
  0004 sebelum deploy supaya single-use benar-benar aktif.
- `workers/sync/migrations/0004_oauth_states_item_owner.sql`
  (baru): tabel `oauth_states` (hash sebagai primary key, bukan
  state mentah — bocor tabel tidak memberi state yang bisa
  dipakai) + indeks `idx_oauth_states_expires`.
- `workers/sync/README.md`: checklist migrasi 0004 + catatan
  state sekali pakai + rate limit callback.

**Tes yang membuktikan:**
- `app/src/worker/syncWorker.test.ts` — "S6: 11 callback cepat
  dari satu IP -> 10 diproses + 1 ditolak 429" (11 state valid
  dari 11 login ber-IP berbeda, kode palsu, token endpoint 400):
  10 pertama 302, ke-11 429, 0 pengguna tercipta.
- "S6: callback kedua dengan state yang sama ditolak" (302
  `reason=state`, sesi tetap 1).
- "S6: state yang tidak pernah dikeluarkan login ditolak".
- FakeD1 diperluas untuk `oauth_states` (insert/select/delete).

**Verifikasi tambahan:** migrasi 0004 diuji di SQLite lokal
sesudah 0001-0003: tabel + kedua indeks tercipta, tidak ada
galat.

## R10 — ALLOWED_ORIGINS produksi worker sync memuat localhost

**Perubahan:**
- `workers/sync/wrangler.toml:18-32`: `[vars]` produksi kini
  hanya `https://laras.adipmusic.my.id` (localhost dihapus).
  Localhost pindah ke `[env.dev.vars]` (pola yang sama dengan
  proxy, R6) + `APP_URL` dev `http://localhost:5173`.
  Komentar di file menjelaskan cara dev lokal tetap jalan:
  `wrangler dev --env dev`.
- `workers/sync/README.md`: catatan dev lokal + peringatan
  jangan menyalin localhost ke `[vars]`.

**Catatan koordinator (bagian dari penutupan R10):**
`hidden_files/koordinator/deploy_sync.py:42` (milik koordinator,
TIDAK diubah Blue 3) masih memuat localhost sebagai nilai
deploy, jadi **redeploy worker sync oleh koordinator** (sesudah
mengubah nilai deploy) adalah bagian yang belum selesai dari
penutupan R10. Verifikasi live sesudah redeploy: OPTIONS dengan
`Origin: http://localhost:5173` tidak lagi mendapat
`Access-Control-Allow-Origin`.

## R11 — Push playlist/item tanpa cek kepemilikan per-user

**Perubahan:**
- `workers/sync/src/index.js:836,845`: klausa `WHERE` upsert
  playlist + tombstone playlist kini
  `AND sync_playlists.user_id = excluded.user_id` — clientId
  milik orang lain tidak bisa ditimpa atau dihapus.
- `workers/sync/src/index.js:810-826` (`playlistOwned`): sebelum
  insert item, playlist induk dicek (`SELECT user_id ... WHERE
  id = ?`). Playlist yang sudah ada di D1 harus milik pendorong;
  playlist baru diizinkan hanya bila ikut dibuat di push yang
  sama (jadi "playlist baru + lagunya sekaligus" tetap jalan,
  item yatim ditolak). Item ditolak dihitung di
  `skippedNotOwned` (`:851-852`, `:864-865`) dan dilaporkan di
  respons push (`{ serverTime, applied, skippedNotOwned }`).
- `workers/sync/src/index.js:858,871`: insert item + tombstone
  item kini membawa kolom `user_id` (diisi `user.id` pendorong).
- `workers/sync/migrations/0004_oauth_states_item_owner.sql`:
  `ALTER TABLE sync_playlist_items ADD COLUMN user_id TEXT` +
  backfill dari `user_id` playlist induk untuk baris lama
  (item yatim tetap NULL) + indeks `idx_items_user`.

**Tes yang membuktikan** (`app/src/worker/syncWorker.test.ts`,
FakeD1 meniru guard user_id + kolom baru):
- "R11: B mendorong playlist dengan clientId milik A -> data A
  tidak berubah" (nama + deskripsi A utuh, B tidak melihatnya).
- "R11: B mendorong item ke playlist milik A -> item ditolak"
  (`skippedNotOwned` 1, pull A hanya berisi lagu asli).
- "R11: tombstone playlist milik A dari B tidak menghapus
  playlist A" (`deletedAt` tetap null).
- "R11: item untuk playlist yang tidak ada (yatim) ditolak"
  (`applied` 0, 0 baris item tercipta).
- "R11: playlist baru + item-nya dalam satu push tetap jalan"
  (`skippedNotOwned` 0).

**Verifikasi tambahan (SQLite asli):** upsert lintas user
tidak menimpa baris (`nama` tetap), upsert pemilik sendiri
menimpa, insert item dengan `user_id` jalan.

## R12 — Impor backup membaca seluruh file sebelum cek 10 MB

**Perubahan:**
- `app/src/components/settings/ImportBackupDialog.tsx:82-86`:
  `handleFile` mengecek `file.size > MAX_BACKUP_BYTES` SEBELUM
  `arrayBuffer()` dan menampilkan galat `tooLarge` langsung.
  Cek di `parseBackupBytes` dipertahankan sebagai lapis kedua.

**Tes yang membuktikan:**
- E2E `app/tests/e2e/p8.spec.ts` ("impor file rusak ditolak...",
  kasus baru): file 10.000.001 byte ditolak dengan pesan
  "File ini terlalu besar (lebih dari 10 MB).", database tidak
  berubah.

## R13 — Impor Spotify jalur file tanpa cap ukuran/jumlah lagu

**Perubahan:**
- `app/src/backup/spotify.ts:67` `SPOTIFY_FILE_MAX_BYTES` =
  10 MB (sama dengan backup); `:165-171` `parseSpotifyFile`
  menolak file di atasnya dengan `SpotifyFileException` kind
  `tooLarge` (lapis kedua; dialog mengecek `file.size` dulu di
  `SpotifyImportDialog.tsx:88-92`).
- `app/src/backup/spotify.ts:76` `SPOTIFY_FILE_MAX_TRACKS` = 30
  (SAMA dengan jalur tautan, sesuai penugasan — usulan Red 3
  sebesar 1.000 tidak dipakai). `capDraft` (`:224-241`) memotong
  daftar ke 30 dan mencatat `totalTracks` (jumlah sebelum cap);
  judul/artis dipotong ke 1.000 karakter
  (`MAX_SPOTIFY_TRACK_TEXT_CHARS`, `:79`).
- `app/src/components/settings/SpotifyImportDialog.tsx:310-318`:
  bila terpotong di jalur file, UI menampilkan jumlah asli
  ("File berisi 35 lagu, hanya 30 lagu pertama yang diimpor.",
  `strings.ts:416`), bukan diam-diam dipotong.
- `app/src/strings/id.ts:400,412`: copy diperbarui —
  `spotifyImportBody` menyebut batas 30 lagu per impor, dan
  `spotifyLinkLimit` tidak lagi menyarankan "pakai file" untuk
  playlist panjang (file kini sama-sama dibatasi 30).

**Tes yang membuktikan:**
- `app/src/backup/spotify.test.ts`: file teks 35 lagu -> 30 +
  `truncated` + `totalTracks` 35; JSON 40 lagu -> 30; 30 lagu
  tidak terpotong; file >10 MB -> kind `tooLarge`; judul 1.500
  karakter dipotong ke 1.000.
- E2E `app/tests/e2e/p8.spec.ts` (tes baru "Blue 3 (R13)"):
  tempelan 35 lagu -> "30 lagu" + pesan potong yang benar.

## R14 — Parser backup tanpa cap per-field/per-koleksi

**Cap yang dinyatakan (di kode + di sini):**

| Cap | Nilai | Lokasi |
|---|---|---|
| Judul/nama teks (lagu, album, artis) | 1.000 karakter | `format.ts:66` |
| Nama/deskripsi playlist di parser (merge tetap memotong ke 100/500) | 1.000 karakter | `format.ts:68` |
| Query pencarian | 500 karakter | `format.ts:70` |
| Id (lagu, album, artis, referensi) | 200 karakter | `format.ts:72` |
| URL gambar | 2.048 karakter | `format.ts:74` |
| Artis per lagu | 50 | `format.ts:76` |
| Lagu per playlist | 1.000 (sama dengan batas playlist app) | `format.ts:78` |
| Lagu | 50.000 (PRD B10.1: 10 MB / 200 byte) | `format.ts:80` |
| Album / artis | 50.000 | `format.ts:82-84` |
| Playlist | 1.000 | `format.ts:86` |
| Riwayat putar | 10.000 (sama dengan batas app) | `format.ts:88` |
| Riwayat pencarian | 100 (sama dengan batas app) | `format.ts:90` |
| Antrean | 200 (sudah ada) | `format.ts:60` |
| Pengaturan: string enum maks 100 karakter, eqGains maks 10 angka | — | `format.ts` `parseSettings` |
| Token unik per teks yang diindeks | 200 (lapis kedua) | `tokens.ts:45` |
| Panjang satu token | 100 karakter | `tokens.ts:48` |
| "Unduh ulang" per ketukan | 200 lagu, kelebihan dilaporkan | `service.ts:294` |

**Perubahan:**
- `app/src/backup/format.ts:62-90` (konstanta),
  `:503-` dst. (parser memakai `isBoundedString` /
  `isOptionalBoundedString`), `parseList` (`:729-758`) kini
  menerima cap jumlah dan menolak file yang melewatinya
  (`invalidStructure`), `fromJsonV1` (`:782-806`) meneruskan
  cap tiap koleksi.
- `app/src/data/tokens.ts:25-48` (`uniqueTokens`): dibatasi 200
  token unik + token di atas 100 karakter dibuang. Kueri
  pencarian tidak kena cap ini (`tokenize` terpisah, tidak
  diubah).
- `app/src/backup/service.ts:294-305` (`capRedownloadIds`,
  `MAX_REDOWLOAD_JOBS` 200) + `ImportBackupDialog.tsx:114-133,
  222-233`: "Unduh ulang" mengantre maks 200 lagu; bila ada
  kelebihan, UI menampilkan jumlah yang masuk antrean dan
  yang dilewati (`backupRedownloadPartial`, `strings/id.ts:369`).

**Tes yang membuktikan:**
- `app/src/backup/format.test.ts` (9 tes baru): judul 1.001
  ditolak / 1.000 diterima; query 501 ditolak; 1.001 playlist
  ditolak / 1.000 diterima; 10.001 riwayat, 101 pencarian,
  1.001 lagu per playlist, 51 artis, 50.001 lagu ditolak;
  eqGains 11 angka diabaikan (bukan menolak file).
- `app/src/data/tokens.test.ts` (2 tes baru): 300 kata unik ->
  200; token 101 karakter dibuang.
- `app/src/backup/service.test.ts` (2 tes baru): 250 id -> 200
  diantre + 50 dilewati; 100 id -> semua diantre.

## R15 — Hapus semua data tidak mengakhiri sesi sync

**Perubahan:**
- `app/src/components/settings/WipeFlow.tsx:64-90` (`handleWipe`):
  bila status `signed-in`, alur memanggil
  `POST /api/auth/logout` (`fetchLogout`) SEBELUM
  `wipeAllData`. Sesi server berakhir, jadi sync otomatis
  20 detik sesudah reload tidak mengembalikan data.
- Bila logout gagal (mis. offline): wipe TIDAK lanjut
  diam-diam. Dialog menampilkan peringatan jujur
  (`backupWipeLogoutFailed`, `strings/id.ts:391`) + tombol
  "Coba keluar lagi" (coba logout ulang) dan "Tetap hapus"
  (lanjut wipe dengan sadar data bisa kembali lewat
  sinkronisasi).
- Copy: `backupWipeBody2` (`strings/id.ts:387`) kini menyebut
  data di server tetap ada sampai akun dihapus; pengguna yang
  masuk melihat catatan tambahan di kedua dialog
  (`backupWipeSyncNote`, `strings/id.ts:389`, "Akunmu akan
  dikeluarkan dulu supaya datamu tidak kembali sendiri lewat
  sinkronisasi.").
- `app/src/backup/wipe.ts` (komentar kepala): pemanggil WAJIB
  logout dulu bila masuk — dicatat sebagai kontrak alur.

**Tes yang membuktikan:**
- `app/src/components/settings/WipeFlow.test.tsx` (baru, 3 tes,
  render klien jsdom): pengguna masuk melihat catatan
  sinkronisasi; pengguna belum masuk tidak melihatnya; copy
  dialog 2 menyebut server.
- E2E `p8.spec.ts` round-trip wipe tetap lolos 6/6 (pengguna
  belum masuk di E2E, jadi tidak ada panggilan logout).

**Catatan:** verifikasi ujung-ke-ujung "wipe saat masuk, tunggu
20 detik, data TIDAK kembali" butuh sesi login sungguhan dan
menjadi tugas Red 4 / koordinator (tidak bisa diuji Vitest
tanpa server OAuth live).

## R16 — Nama playlist impor Spotify tidak divalidasi panjangnya

**Perubahan:**
- `app/src/backup/spotify.ts:757-759` (`importDraft`): nama
  dipotong ke `MAX_PLAYLIST_NAME_LENGTH` (100) SEBELUM
  `createPlaylist` (mengikuti merge backup), dipakai di
  `:813` dan laporan `:864`.
- `app/src/components/settings/SpotifyImportDialog.tsx:128-139`
  (`handleStart`): `try/finally` kini punya `catch` yang
  menampilkan `spotifyErrorImportFailed`
  (`strings/id.ts:436`, "Impor gagal. Coba lagi, atau
  persingkat nama playlist-nya.") + pesan galat kini dirender
  juga di tampilan draf (`:340-348`), bukan hanya di tampilan
  awal.

**Tes yang membuktikan:**
- `app/src/backup/spotify.test.ts`: nama 150 karakter ->
  playlist tercipta dengan nama 100 karakter, impor tetap
  jalan (sebelum perbaikan: unhandled rejection, impor gagal
  diam-diam).

## I11 — Klasifikasi AbortError salah (DOMException bukan Error)

**Perubahan:** cek `name === 'AbortError'` tanpa gate
`instanceof Error` di:
`app/src/downloads/downloadManager.ts:263-264` (juga
`TimeoutError`), `app/src/downloads/chunkedDownloader.ts:137-142`
(`isAbort`), `app/src/sync/syncClient.ts:149-152`,
`app/src/backup/spotify.ts:535-538` (pola yang sama, belum
tercatat Red 3), `app/src/resilience/errors.ts:86-94`
(klasifikasi timeout/offline).

**Tes:** `syncClient.test.ts` (DOMException AbortError ->
TIMEOUT, bukan NETWORK), `chunkedDownloader.test.ts`
(DOMException AbortError dari fetchRange dikenali sebagai
batal).

## I12 — parseCookies tanpa try/catch

**Perubahan:** `workers/sync/src/index.js:129-148` — decode per
nilai dibungkus try/catch; nilai malformed dipakai mentah
daripada menggagalkan request dengan 500.

**Tes:** `syncWorker.test.ts` — cookie `laras_session=%E0%A4%A`
ke `/api/auth/me` menghasilkan 401, bukan 500.

## I13 — recordToResult LRCLIB tanpa validasi record null

**Perubahan:** `app/src/lyrics/lrclib.ts:115-118` — record bukan
objek/null mengembalikan `{ status: 'not-found' }`.

**Tes:** `lrclib.test.ts` — `/api/get` mengembalikan JSON `null`
-> `not-found`, bukan TypeError.

## I14 — Worker sync tanpa nosniff/CSP halaman 503

**Perubahan:** `workers/sync/src/index.js:87,99`
(`X-Content-Type-Options: nosniff` di `jsonError`/`jsonOk`),
`:418-420` (halaman 503: `nosniff` +
`Content-Security-Policy: default-src 'none'; style-src
'unsafe-inline'`).

**Tes:** `syncWorker.test.ts` — respons JSON membawa nosniff,
halaman 503 membawa CSP + nosniff.

## I15 — Tes rateLimit flaky (sapu 1 persen)

**Perubahan:** `app/src/worker/rateLimit.test.ts:136-144` —
tes sapu mem-mock `Math.random` ke 0.99 selama penyiapan
supaya sapu probabilistik tidak menyala di tengah asersi
jumlah baris. Perilaku produk tidak diubah (sapu memang harus
menghapus baris lama).

**Tes:** file dijalankan 3x berturut-turut, 7/7 hijau setiap
kali.

## I16 — db.batch bukan transaksi atomik (DIDOKUMENTASIKAN)

Tidak ada restrukturisasi murah: binding D1 di Workers tidak
menyediakan API transaksi (tidak ada `BEGIN`/`COMMIT` yang
bisa dipakai lintas pernyataan lewat binding; `db.batch`
menjalankan pernyataan berurutan). Mengganti ke satu
pernyataan SQL raksasa atau ke Durable Objects adalah
perubahan arsitektur, bukan perbaikan kecil, dan berisiko
memecah protokol S8 yang sudah terbukti.

Mitigasi yang sudah ada dan dipertahankan:
- Upsert push idempotent (last-write-wins): dorong ulang
  memperbaiki keadaan separuh-terap.
- Urutan hapus akun menempatkan `users` TERAKHIR: gagal di
  tengah meninggalkan akun utuh yang bisa mencoba hapus lagi.
- `skippedNotOwned` (R11) dihitung sebelum batch, jadi
  kegagalan batch tidak mengubah laporan kepemilikan.

Dicatat sebagai batasan yang diketahui, bukan temuan yang
butuh perbaikan segera (sejalan dengan penilaian Red 3).

## I17 + I18 — TETAP DITUNDA (dikonfirmasi, tanpa perubahan)

- **I17** (`x-proxy-cpu-ms` di worker proxy): keputusan Blue 1
  dipertahankan — header dicabut saat promosi ke proxy
  produksi; worker saat ini masih worker spike dan header
  adalah instrumen ukurnya. Tes s7 masih menegaskan header
  terekspos (20/20 lolos).
- **I18** (allowlist hash player di-hardcode): keputusan Blue 1
  dipertahankan — membaca dari config remote butuh desain
  sumber + TTL yang belum ada. Ketiga salinan hash sinkron
  per Red 2; tidak diubah ronde ini.

---

## Verifikasi

| Pemeriksaan | Hasil |
|---|---|
| Vitest penuh (baseline 715/715 + 35 tes regresi baru, tanpa tes yang dihapus/dilonggarkan) | **750/750, 50 file** |
| Tes unit worker proxy (`s7-unit-test.mjs`) | **20/20** |
| Tes unit worker sync (`syncWorker.test.ts`, termasuk 10 tes baru S6/R11/I12/I14) | **38/38** |
| Typecheck (`tsc -b`) | 0 error |
| Lint (`eslint .`, penuh) | 0 error |
| Tes rateLimit (I15) | 7/7, 3x run berturut-turut |
| E2E Playwright `p8.spec.ts` (wipe, impor backup, impor Spotify) | **6/6** Chromium (5 lama + 1 baru R13; kasus R12 ditambahkan ke tes "file rusak") |
| Migrasi 0004 di SQLite lokal (sesudah 0001-0003) | OK: tabel + indeks tercipta, backfill benar (item playlist terisi pemilik, item yatim NULL) |
| SQL upsert R11 di SQLite lokal | OK: timpa lintas user ditolak, timpa pemilik sendiri jalan |
| Bundle awal gzip (metrik gerbang CI: JS yang dirujuk `dist/index.html`) | **174.765 byte** dari batas 204.800 (sisa 30.035) |
| Bundle awal JS+CSS | 181.941 byte dari batas 204.800 (sisa 22.859) |
| Chunk `*TestPage*` di `dist/` (gerbang H1) | 0 |
| SW version | `0.9.0-71925ff2` (sama dengan build P8; `sw.js` tidak berubah) |

**Catatan E2E:** Vite CLI gagal di sandbox saat itu (gelombang
EPERM: `mkdir node_modules/.vite-temp` ENOENT), jadi E2E
dijalankan terhadap server dev yang dinyalakan lewat Vite API
(`createServer`, pola P6 yang sudah terbukti) di port 4173;
Playwright memakai ulang server itu (`reuseExistingServer`).
Chromium jalan normal (tanpa SIGTRAP). Skrip server sementara
dihapus sesudah E2E selesai; tidak ada file sementara yang
tertinggal di repo.

**Catatan bundle:** build lewat `app/build-api.mjs` (Vite API,
karena CLI terblokir EPERM) + salin `public/` manual +
substitusi placeholder SW manual dengan hash isi apa adanya
termasuk placeholder (hasil `0.9.0-71925ff2`, identik dengan
build P8 — bukti substitusinya benar). Angka 174.765 adalah
metrik yang dipakai gerbang CI (JS saja); angka 181.941
(JS+CSS) dicantumkan sebagai pembanding dengan baseline
181.064 di penugasan (selisih +877 byte dari kode baru:
string, cap, alur logout).

**File yang diubah (ringkas):**
worker sync (`src/index.js`, `wrangler.toml`, `README.md`,
`migrations/0004_oauth_states_item_owner.sql`),
`app/src/backup/{format,spotify,service,wipe}.ts`,
`app/src/data/tokens.ts`, `app/src/lyrics/lrclib.ts`,
`app/src/sync/syncClient.ts`,
`app/src/downloads/{downloadManager,chunkedDownloader}.ts`,
`app/src/resilience/errors.ts`, `app/src/strings/id.ts`,
`app/src/components/settings/{WipeFlow,ImportBackupDialog,SpotifyImportDialog}.tsx`,
tes: `syncWorker`, `rateLimit`, `format`, `spotify`,
`service`, `tokens`, `lrclib`, `syncClient`,
`chunkedDownloader`, `WipeFlow` (baru),
`app/tests/e2e/p8.spec.ts`.
`hidden_files/koordinator/` TIDAK disentuh.

---

## Langkah koordinator yang masih diperlukan

1. **Terapkan migrasi D1 0004** (SEBELUM deploy worker):
   `wrangler d1 execute laras-web-sync --file=workers/sync/migrations/0004_oauth_states_item_owner.sql --remote`
   (juga di checklist `workers/sync/README.md`).
2. **Ubah `hidden_files/koordinator/deploy_sync.py:42`** (hapus
   localhost dari nilai deploy) + **redeploy worker sync**,
   lalu verifikasi live R10 (OPTIONS localhost tidak mendapat
   ACAO) dan S6 (11 callback cepat ke 429).
3. **Push** ke `adiprmx/laras-web` (Blue 3 tidak push).
4. **Deploy preview** + verifikasi: wipe saat masuk lalu
   tunggu 20 detik (data TIDAK boleh kembali), impor file
   di atas cap, impor Spotify 35 lagu.
5. Red 4: audit ulang S6/R10/R11/R15 sesuai daftar Red 3.
