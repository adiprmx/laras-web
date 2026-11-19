# Blue 4 - Perbaikan Temuan Audit Red 4 (Laras Web)

**Tanggal:** 19 November 2026.
**Auditor yang diperbaiki:** Red 4 (`docs/red4-audit.md`, 4 temuan:
1 sedang, 2 rendah, 1 info).
**Remote HEAD saat mulai:** 39568d84 (Blue 3). **Tanpa push, tanpa
deploy** - koordinator yang memverifikasi, push, dan deploy.
**D1 tidak pernah di-query untuk data sesi/token pengguna.**
SQL baru hanya diuji di SQLite lokal (`/tmp`, database buatan)
dan lewat FakeD1 di Vitest.
**Tidak ada migrasi D1 baru:** semua COUNT S7 tercakup indeks
0001 (terbukti EXPLAIN QUERY PLAN, lihat S7).

## Ringkasan vonis

| Temuan | Tingkat | Status |
|---|---|---|
| S7 - worker sync tanpa batas total per pengguna | Sedang (wajib) | **DITUTUP** (batas §4.3 ditegakkan server + cap tarik klien) |
| R17 - wipe melewatkan logout bila status `unknown` | Rendah | **DITUTUP** (tunggu refreshAuth, peringatan bila tetap tak diketahui) |
| R18 - sync yang berjalan saat wipe membangkitkan data | Rendah | **DITUTUP** (generasi sync, applyPull berhenti menulis) |
| I19 - `consumeOAuthState` tidak atomik | Info | **DITUTUP** (satu DELETE berkondisi + `meta.changes`) |

**Syarat release candidate terpenuhi:** S7 ditutup penuh
(penegakan server per koleksi + lapis kedua di klien, bukan
hanya satu sisi).

---

## S7 - Worker sync tanpa batas total per pengguna (SEDANG, WAJIB)

**Batas yang ditegakkan (dibaca langsung dari arsitektur §4.3,
bukan hafalan):** maks 100 playlist per pengguna, maks 1.000
item per playlist, maks 10.000 suka per pengguna, maks 1.000
entri riwayat terbaru per pengguna.

**Perubahan server:**
- `workers/sync/src/index.js:73-76` (konstanta
  `MAX_PLAYLISTS_PER_USER` 100, `MAX_ITEMS_PER_PLAYLIST` 1000,
  `MAX_LIKES_PER_USER` 10000, `MAX_HISTORY_PER_USER` 1000) +
  komentar kepala file yang diperbarui.
- `workers/sync/src/index.js:804-871` (helper): `countUserRows`
  (satu COUNT per tabel), `countItemsPerPlaylist` (satu GROUP BY
  untuk semua playlist yang disentuh push), `capNewEntries`
  (saring entri ke yang muat dalam headroom).
- `workers/sync/src/index.js:888-1002` (`handlePush`, SEBELUM
  pernyataan upsert dibangun): COUNT per koleksi yang ada
  isinya (paralel via `Promise.all`, koleksi kosong tidak
  di-COUNT), lalu tiap koleksi disaring. Kelebihan DILEWATI
  per koleksi dan dilaporkan di respons (bukan gagal total,
  bukan gagal diam-diam): sisa push yang sah tetap diterapkan.
- `workers/sync/src/index.js:1128-1143` (respons push):
  `{ serverTime, applied, skippedNotOwned, skippedOverLimit,
  limits }`. `skippedOverLimit` berisi jumlah yang dilewati
  per koleksi; `limits` berisi keempat angka batas supaya
  klien bisa menampilkan pesan yang jelas tanpa menebak.
- `app/src/sync/syncClient.ts:111-130` (`PushData`): ketiga
  field baru dideklarasikan (opsional) supaya klien bisa
  membacanya dengan typecheck.

**Aturan penegakan yang penting:**
- Batas berlaku untuk jumlah TOTAL baris milik pengguna
  sesudah push, bukan jumlah entri di body. Bila headroom
  cukup untuk semua entri (kasus umum), tidak ada query
  tambahan. Bila tidak cukup, kunci yang sudah ada diambil
  satu query per koleksi supaya UPDATE entri lama tidak
  dihitung sebagai penambahan; hanya entri BARU yang memakan
  headroom. Duplikat kunci dalam satu push dihitung sekali.
- Tombstone TERMASUK dalam hitungan COUNT (tombstone tetap
  baris yang memakan kuota). Ini menutup putaran
  hapus-buat-ulang: pengguna yang sudah 100 baris (hidup +
  tombstone) tidak bisa membuat playlist baru sampai
  tombstone dibersihkan (30 hari), jadi pengisian kuota
  berhenti total di batas, bukan berputar tanpa henti.
- Penghapusan TIDAK PERNAH ditolak batas, dan tidak bisa
  dipakai mengakali batas: ketiga tombstone diubah dari
  INSERT ... ON CONFLICT menjadi UPDATE (`:1050` playlist,
  `:1076` item, `:1094` suka). Tombstone untuk baris yang
  tidak ada adalah no-op, bukan baris baru. Semantik LWW dan
  kepemilikan R11 dipertahankan di klausa WHERE UPDATE
  (kondisi `updated_at < ? OR (= AND device_id < ?)` sama
  persis dengan kondisi ON CONFLICT lama). Tanpa perubahan
  ini, batas total bisa diakali dengan mengirim tombstone
  untuk id yang tidak ada (100 baris baru per push, tanpa
  batas).

**Perubahan klien (lapis kedua):**
- `app/src/data/library.ts:90` (`MAX_SYNC_PLAYLISTS` 100) +
  `:3023-3038` (`createPlaylistFromRemote`): bila perangkat
  sudah punya 100 playlist, tarik mengembalikan null (tidak
  membuat playlist ke-101). Satu-satunya pemanggil adalah
  `applyPull` (`syncService.ts:97`), yang mengabaikan nilai
  kembali. Pembuatan playlist lokal manual tidak dibatasi
  angka ini.

**Tanpa migrasi D1:** kedelapan query baru (4 COUNT + 4
pengambil kunci) memakai covering index yang sudah ada di
0001. Terverifikasi EXPLAIN QUERY PLAN di SQLite lokal
sesudah 0001-0004: `SELECT COUNT(*) ... WHERE user_id = ?`
memakai `idx_playlists_client` / `idx_likes_user_updated` /
`idx_history_user_played`; GROUP BY item memakai
`idx_items_updated`; pengambil kunci memakai
`idx_playlists_client` dan PK index tiap tabel. Nol SCAN
tabel. Koordinator TIDAK perlu menerapkan migrasi apa pun
ronde ini.

**Tes yang membuktikan** (`app/src/worker/syncWorker.test.ts`,
FakeD1 diperluas untuk COUNT, GROUP BY, pengambil kunci,
UPDATE tombstone, dan `meta.changes`):
- "S7: pengguna dengan 100 playlist yang mendorong ke-101
  ditolak + batas dilaporkan" (skipped 1, applied 0, total
  tetap 100, `limits` sesuai §4.3).
- "S7: update playlist lama tetap jalan saat sudah di batas
  100" (ganti nama playlist ke-6 jalan, skipped 0).
- "S7: penghapusan playlist tetap jalan saat sudah di batas
  100" (tombstone jalan; playlist baru sesudahnya tetap
  ditolak karena tombstone ikut dihitung).
- "S7: tombstone untuk playlist yang tidak ada tidak membuat
  baris" (0 baris playlist + 0 baris suka tercipta).
- "S7: push suka berulang tidak melewati total 10.000"
  (9.950 seed + 100 push: 50 masuk, 50 dilewati; 100 push
  lagi: 100 dilewati; total mentok 10.000; update suka lama
  tetap jalan).
- "S7: item ke-1.001 di satu playlist ditolak, playlist lain
  tidak kena" (playlist penuh menolak 1, playlist kosong
  menerima 1; update item lama di playlist penuh jalan).
- "S7: riwayat ke-1.001 ditolak; update entri lama jalan"
  (entri baru ditolak, update `seconds_played` entri lama
  jalan ke nilai max).
- "S7: batas berlaku per pengguna" (A di batas 100, B tetap
  bisa mendorong playlist pertama).
- `app/src/sync/syncService.test.ts` (klien): "S7: tarik
  playlist ke-101 ditolak saat lokal sudah 100 playlist"
  dan "S7: tarik playlist ke-100 diterima saat lokal 99".

**Verifikasi tambahan (SQLite asli):** tombstone UPDATE
menerapkan LWW dengan benar (tombstone lebih lama tidak
menimpa, `changes` 0), kepemilikan dipertahankan (tombstone
user lain `changes` 0), tombstone hantu tidak membuat baris.

**Catatan biaya baca:** COUNT per push memindai indeks milik
pengguna itu saja (terbatas oleh batas total). Pengguna di
batas suka 10.000 yang sinkron tiap 20 detik akan memindai
sekitar 30 ribu baris indeks per menit; itu biaya yang
diterima sesuai penugasan (kuota baca 5 juta baris/hari) dan
jauh lebih murah daripada kuota tulis yang dilindungi. Bila
suatu hari terbukti berat, pemantauan kuota baca adalah
langkah berikutnya, bukan pelonggaran batas.

## R17 - Wipe melewatkan logout bila status akun masih `unknown`

**Perubahan:**
- `app/src/components/settings/WipeFlow.tsx:27`
  (`WIPE_REFRESH_TIMEOUT_MS` 10 detik) + `:73-120`
  (`handleWipe`): bila status `unknown`, alur menunggu
  `refreshAuth()` dulu (race dengan batas 10 detik), lalu
  membaca status AKHIR dari store (`useSyncStore.getState()`,
  bukan closure yang bisa basi) dan memutuskannya: signed-in
  lanjut ke jalur logout R15, signed-out langsung wipe,
  tetap `unknown` menampilkan peringatan.
- Bila status tetap `unknown` sesudah menunggu (offline atau
  refresh menggantung), wipe TIDAK lanjut diam-diam:
  `statusUnknown` (`:36`, `:124`) menampilkan copy baru
  `backupWipeUnknownStatus` (`strings/id.ts:393-394`,
  "Tidak bisa memastikan kamu sedang masuk atau tidak,
  mungkin internetmu sedang putus. Bila tetap menghapus,
  datamu bisa kembali sendiri lewat sinkronisasi.") dengan
  tombol yang sama seperti jalur logout-gagal ("Coba keluar
  lagi" / "Tetap hapus", `:214-215`). Tombol "Coba keluar
  lagi" menjalankan ulang seluruh keputusan (refreshAuth
  lagi, lalu logout bila ternyata masuk).
- Copy peringatan memakai testid `wipe-logout-failed` yang
  sama dengan jalur R15 supaya selektor E2E tetap stabil;
  isi pesannya yang membedakan kedua jalur.

**Tes yang membuktikan**
(`app/src/components/settings/WipeFlow.test.tsx`, render
klien jsdom; `fetchLogout`/`fetchAuthMe` di-mock,
`wipeAllData` di-mock, `location.reload` tidak di-stub
karena jsdom menolak menimpanya dan pemanggilan aslinya
hanya mencatat "not implemented" tanpa melempar):
- "unknown + refreshAuth sukses signed-in -> logout
  dipanggil SEBELUM wipe" (urutan invocationCallOrder
  logout < wipe).
- "unknown + refreshAuth sukses signed-out -> wipe tanpa
  logout" (401 membuat status signed-out, tidak ada
  panggilan logout, tidak ada peringatan).
- "unknown + refreshAuth gagal jaringan -> peringatan
  tampil, wipe tidak lanjut" (peringatan + kedua tombol
  tampil, wipe/logout tidak dipanggil).
- "unknown + refreshAuth menggantung -> peringatan tampil
  sesudah batas 10 detik" (fake timers: sebelum batas belum
  ada peringatan, sesudah batas peringatan tampil).
- "peringatan status unknown: Tetap hapus melanjutkan wipe"
  (pilihan sadar pengguna tetap dihormati).
- "pengguna belum masuk: wipe langsung tanpa logout"
  (jalur signed-out yang direkomendasikan Red 4).

## R18 - Sync yang berjalan saat wipe membangkitkan data

**Perubahan (mekanisme yang dipilih: penghitung generasi):**
- `app/src/sync/syncEpoch.ts` (baru, 29 baris): modul tanpa
  dependensi berisi `currentSyncEpoch`,
  `invalidateSyncEpoch`, `isSyncEpochCurrent`. Sengaja BUKAN
  di syncStore: syncService tidak boleh mengimpor store
  (store mengimpor syncService, siklus), dan wipe.ts butuh
  memanggilnya tanpa menarik seluruh graf syncService.
- `app/src/backup/wipe.ts:38,112`: `wipeAllData` memanggil
  `invalidateSyncEpoch()` sebagai BARIS PERTAMA (sinkron,
  sebelum await apa pun), supaya putaran sync yang berjalan
  berhenti menulis sebelum database dihapus. Kontrak dicatat
  di komentar kepala file.
- `app/src/sync/syncService.ts:86-94` (`applyPull`, parameter
  `epoch` baru dengan default generasi saat ini): cek
  `stale()` diletakkan TEPAT sebelum tiap penulisan, bukan
  di awal iterasi. Alasannya: baca (await) di antara cek dan
  tulis memberi jendela bagi wipe untuk menghapus database
  di tengah jalan, dan tulis berikutnya akan mendarat di
  database segar. Semua jalur tulis tercakup: playlist
  (buat/ubah/hapus), item (tambah/hapus), suka, riwayat,
  dan pengaturan (termasuk cek kedua sebelum
  `setSettingsAppliedAt`).
- `app/src/sync/syncService.ts:338-346,376,405` (`syncNow`):
  generasi ditangkap di awal dan diteruskan ke `applyPull`;
  bila generasi berubah, putaran berhenti SEBELUM
  `collectPushBody` (yang menulis clientId), sebelum tiap
  ronde dorong, dan sebelum penanda sukses (penanda basi di
  database segar akan membuat tarik pertama sesudah masuk
  lagi melewatkan perubahan server). Putaran yang dibatalkan
  mengembalikan `{ serverTime, pushed }` apa adanya tanpa
  melempar, supaya store tidak mencatat galat palsu (halaman
  akan reload karena wipe).

**Kenapa generasi, bukan menunggu sync selesai:** menunggu
putaran sync (yang bisa memakan banyak ronde dorong) akan
menunda wipe tanpa batas waktu yang jelas; pembatalan logis
via generasi bersifat seketika dan menutup jendela race
secara struktural (cek sebelum tulis), bukan secara
probabilistik (harap-harap sync selesai duluan).

**Tes yang membuktikan** (`app/src/sync/syncService.test.ts`):
- "R18: applyPull berhenti menulis bila generasi berubah di
  tengah jalan" (library stub: baca playlist kedua
  menggantung, wipe membatalkan di tengah jalan; hanya
  playlist pertama yang sempat dibuat).
- "R18: syncNow yang dibatalkan wipe tidak mendorong dan
  tidak menulis penanda" (wipe dimulai saat tarik berjalan:
  0 push terkirim, tarik tidak diterapkan, penanda
  `sync-last-pull` tidak ditulis).

## I19 - `consumeOAuthState` tidak atomik

**Perubahan:**
- `workers/sync/src/index.js:391-408`: SELECT lalu DELETE
  diganti satu DELETE berkondisi (`DELETE FROM oauth_states
  WHERE state_hash = ? AND provider = ? AND expires_at > ?`)
  + cek `res.meta?.changes === 1` (1 = berhasil dipakai,
  0 = tidak dikenal/kedaluwarsa/salah provider/sudah
  dipakai). Dua callback bersamaan dengan state yang sama
  tidak bisa sama-sama lolos: hanya DELETE pertama yang
  mengubah 1 baris.
- Pemetaan galat TIDAK berubah: pemanggil `:563` masih
  `if (!(await consumeOAuthState(...))) return fail('state')`,
  jadi semua kegagalan konsumsi tetap mengarah ke
  `reason=state` seperti sebelumnya. Fail-open saat galat D1
  dipertahankan (return true + peringatan).
- Satu-satunya perbedaan perilaku: baris kedaluwarsa/salah
  provider tidak lagi dihapus saat ditemui di callback
  (tidak cocok dengan kondisi DELETE); pembersihannya
  diserahkan ke sapu login di `storeOAuthState`, yang sudah
  berjalan tiap login. Tidak ada kebocoran fungsional.

**Tes yang membuktikan** (`app/src/worker/syncWorker.test.ts`,
FakeD1 kini meniru `meta.changes` lewat `lastChanges`):
- "I19: dua callback PARALEL dengan state yang sama, hanya
  satu yang lanjut" (`Promise.all` dua callback: satu
  `auth=ok`, satu `reason=state`, 1 pengguna + 1 sesi).
  Dengan kode lama (SELECT lalu DELETE), tes ini GAGAL di
  FakeD1 karena keduanya lolos SELECT sebelum DELETE.
- "I19: state kedaluwarsa ditolak (reason=state)".
- "I19: provider salah ditolak (reason=state)".

**Verifikasi tambahan (SQLite asli):** DELETE kondisional
pertama `changes()` 1, kedua 0.

---

## Verifikasi

| Pemeriksaan | Hasil |
|---|---|
| Vitest penuh (baseline 750/750 + 21 tes regresi baru, tanpa tes yang dihapus/dilonggarkan) | **771/771, 50 file** |
| Tes unit worker sync (`syncWorker.test.ts`, termasuk 11 tes baru S7/I19) | **49/49** |
| Tes unit worker proxy (`s7-unit-test.mjs`) | **20/20** |
| Tes syncService (termasuk 4 tes baru S7/R18) | **20/20** |
| Tes WipeFlow (termasuk 6 tes baru R17) | **9/9** |
| Typecheck (`tsc -b`) | 0 error |
| Lint (`eslint .`, penuh) | 0 error |
| E2E Playwright `p8.spec.ts` (wipe, impor backup, impor Spotify) | **6/6** Chromium (lihat catatan) |
| SQL baru di SQLite lokal (sesudah 0001-0004) | OK: 8 query COUNT/kunci memakai covering index, tombstone UPDATE benar (LWW + kepemilikan), DELETE I19 changes 1 lalu 0 |
| Bundle awal gzip (metrik gerbang CI: JS yang dirujuk `dist/index.html`) | **174.812 byte** dari batas 204.800 (sisa 29.988) |
| Bundle awal JS+CSS | 181.988 byte dari batas 204.800 (sisa 22.812) |
| Chunk `*TestPage*` di `dist/` (gerbang H1) | 0 |
| SW version | `0.9.0-71925ff2` (sama dengan build P8/Blue 3; `sw.js` tidak berubah) |

**Catatan Vitest:** ringkasan suite penuh menampilkan
"Errors 1 error" di samping 771/771 hijau. Itu noise jsdom
("Not implemented: navigation") dari `window.location.reload()`
di `doWipe`, yang kini terpanggil oleh tes klik WipeFlow yang
baru (tes Blue 3 tidak pernah mengklik wipe). Bukan kegagalan
tes: exit code 0, semua file lolos.

**Catatan E2E:** Vite CLI gagal di sandbox seperti biasa
(gelombang EPERM: `mkdir node_modules/.vite-temp` ENOENT),
jadi E2E dijalankan terhadap server dev yang dinyalakan lewat
Vite API (`createServer`, pola P6/Blue 3) di port 4173;
Playwright memakai ulang server itu (`reuseExistingServer`).
Chromium jalan normal (tanpa SIGTRAP). Run penuh pertama:
4/6, kedua tes yang gagal kehabisan timeout 60 detik per tes
di tengah beban CPU sandbox (bukan galat produk: retry tes
"impor file rusak" lolos 45,9 detik; retry tes round-trip
lolos 1,1 menit dengan timeout 120 detik, melewati wipe,
impor, dan verifikasi hitungan dengan benar). Skrip server
sementara + `test-results/` sudah dihapus sesudah E2E
selesai; tidak ada file sementara yang tertinggal di repo.

**Catatan bundle:** build lewat `app/build-api.mjs` (Vite API,
karena CLI terblokir EPERM) + salin `public/` manual +
substitusi placeholder SW manual dengan hash isi apa adanya
termasuk placeholder (hasil `0.9.0-71925ff2`, identik dengan
build P8/Blue 3, bukti substitusinya benar). Kenaikan +47
byte dari baseline 174.765 berasal dari kode baru (string
peringatan, cek generasi, cap tarik).

**File yang diubah (ringkas):**
worker sync (`src/index.js`, `README.md`),
`app/src/sync/{syncEpoch.ts (baru),syncService.ts,syncClient.ts}`,
`app/src/data/library.ts`, `app/src/backup/wipe.ts`,
`app/src/strings/id.ts`,
`app/src/components/settings/WipeFlow.tsx`,
tes: `syncWorker`, `syncService`, `WipeFlow`.
`hidden_files/koordinator/` TIDAK disentuh.
`app/tests/spikes/s7-unit-result.json` diregenerasi saat tes
proxy dijalankan (artefak, bukan kode).

---

## Yang ditunda + alasannya

1. **Anggaran tulis harian per akun (§4.3).** Arsitektur §4.3
   juga menyebut "satu sinkronisasi penuh dibatasi 100 ribu
   baris tulis/hari per akun secara agregat; bila kuota D1
   akun mendekati batas, Worker menolak sync baru dengan
   429". Itu mekanisme terpisah (penghitung tulis harian per
   pengguna + tabel penghitung + migrasi) yang TIDAK diminta
   Red 4 dan tidak diperlukan untuk menutup S7: batas total
   per pengguna sudah menghentikan pembakaran kuota (satu
   akun mentok di sekitar 111 ribu baris TOTAL, dan tidak
   bisa berputar hapus-buat-ulang karena tombstone ikut
   dihitung). Anggaran harian tetap dicatat sebagai
   peningkatan berikutnya bila koordinator menginginkannya.
2. **Notifikasi klien saat push melewati batas.** Respons
   push kini melaporkan `skippedOverLimit` + `limits`, dan
   `PushData` sudah mendeklarasikannya, tetapi UI belum
   menampilkannya (sinkronisasi tetap dilaporkan berhasil
   walau sebagian entri dilewati). Tugas ini tidak meminta
   UI-nya, dan menambahkannya berarti copy + state + tes
   baru di Pengaturan. Disarankan sebagai tindak lanjut
   kecil: tampilkan catatan di Pengaturan bila
   `skippedOverLimit` tidak nol.
3. **Verifikasi R15/R17/R18 ujung-ke-ujung dengan sesi login
   sungguhan.** Sama seperti Blue 3: butuh akun uji + login
   OAuth live, tetap menjadi tugas koordinator (wipe saat
   masuk, tunggu 20 detik, data TIDAK kembali; wipe saat
   status belum terkonfirmasi).

---

## Langkah koordinator yang masih diperlukan

1. **TIDAK ADA migrasi D1 ronde ini** (semua COUNT tercakup
   indeks 0001; terverifikasi EXPLAIN). Jangan menerapkan
   migrasi apa pun untuk Blue 4.
2. **Redeploy worker sync** (kode S7 + I19 hanya aktif
   sesudah deploy), lalu verifikasi live: push melewati
   batas mengembalikan `skippedOverLimit` + `limits`;
   callback kedua dengan state yang sama tetap
   `reason=state`.
3. **Push** ke `adiprmx/laras-web` (Blue 4 tidak push).
4. **Deploy preview** + verifikasi: wipe saat status akun
   belum terkonfirmasi (matikan jaringan lalu wipe),
   wipe saat sync sedang berjalan, impor backup 100+
   playlist lalu sinkron.
5. Red 5: audit ulang S7/R17/R18/I19 sesuai daftar Red 4
   (pengguna di ambang 100 playlist ditolak di playlist
   ke-101; wipe saat status `unknown`; pull yang resolve
   sesudah wipe tidak menulis ke database segar; dua
   callback paralel, satu state, hanya satu yang lanjut).
