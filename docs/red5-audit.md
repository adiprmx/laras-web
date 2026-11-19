# Red 5 - Audit Keamanan Laras Web (P9, sesudah Blue 4)

**Tanggal:** 19 November 2026.
**Auditor:** Tim Red 5 - audit statis + tes unit + probe live terbatas
(endpoint publik tanpa auth) + verifikasi SQL lokal (SQLite).
**Ruang lingkup:** verifikasi seluruh klaim perbaikan Blue 4 atas 4
temuan Red 4 (S7, R17, R18, I19), verifikasi regresi perbaikan Blue 1,
Blue 2, dan Blue 3, audit permukaan baru kode Blue 4 (logika COUNT S7,
tombstone UPDATE, generasi sync R18, alur wipe R17, DELETE atomik I19),
plus pemeriksaan rutin (XSS, console, secret, telemetri, larangan
`api.spotify.com`).
**HEAD yang diaudit:** workdir `~/workspace/music-app-web/` per 19 Nov
2026 (remote HEAD 5196078a, Blue 4, sesuai penugasan; `git log` lokal
basi dan tidak dipakai sebagai acuan, sesuai catatan AGENTS.md tentang
push via API).
**Metode:** baca kode penuh jalur sensitif yang diubah Blue 4 dan
kedua worker, grep pola berbahaya, jalankan Vitest penuh + tes unit
worker, probe live hemat kuota ke domain produksi dan worker sync
(8 request total, tanpa auth, tanpa menyentuh data pengguna),
verifikasi EXPLAIN QUERY PLAN kedelapan query baru S7 di SQLite lokal
(sesudah migrasi 0001-0004), dan verifikasi `app/dist/` hasil build
Blue 4 di disk. Tanpa Playwright E2E dan tanpa browser (dicatat di
"Tidak bisa diverifikasi"). Red HANYA audit: tidak ada kode produksi
yang diubah; satu-satunya file yang ditulis adalah laporan ini.
**Catatan penomoran:** temuan baru melanjutkan penomoran Red 4
(S8-S9, R19-R20, I20).

## Ringkasan vonis

| Tingkat | Jumlah |
|---|---|
| Kritis | **0** |
| Tinggi | **0** |
| Sedang | **2** |
| Rendah | **2** |
| Info | **1** |
| **Total baru** | **5** |

**Vonis: LAYAK LANJUT KE BLUE 5, dengan dua temuan sedang (S8, S9)
yang wajib ditutup sebelum release candidate.** Tidak ada temuan
kritis atau tinggi. Seluruh klaim perbaikan Blue 4 TERBUKTI (semua
klaim S7, R17, R18, dan I19 terverifikasi di kode, tes, dan
EXPLAIN; lihat tabel verifikasi). Seluruh perbaikan Blue 1, Blue 2,
dan Blue 3 MASIH bertahan (H1, S1-S6, R1-R16, I5-I7, I11-I15
terverifikasi ulang di bawah).
Namun kedua temuan sedang ini lahir dari logika S7 ITU SENDIRI,
bukan dari klaim Blue 4 yang gagal: S8 menunjukkan satu koleksi
(riwayat) masih bisa memutar hapus-buat-ulang lewat
`historyClearedBefore` dan membakar kuota tulis D1 bersama seperti
S7 semula, hanya lebih lambat; S9 menunjukkan COUNT per push yang
dipasang S7 membuka vektor baru, yaitu pembakaran kuota BACA D1
(5 juta baris/hari) oleh satu akun yang sudah di batas suka.
Dengan kata lain: S7 ditutup sesuai spesifikasinya, tetapi
penutupannya tidak menutup kelas serangannya sampai tuntas.

---

## Temuan sedang

### S8 - `historyClearedBefore` membuka lagi pembakaran kuota tulis D1: hapus-buat-ulang riwayat menguras 100 ribu baris dalam 17-33 menit

**Tingkat: sedang.** **File:**
`workers/sync/src/index.js:1103` (insert riwayat), `:1118-1122`
(DELETE `historyClearedBefore`), `:1126` (`db.batch`),
`:905-919` (COUNT sebelum upsert), `:777-781` (validasi
`historyClearedBefore` hanya `isSafeInt`).

**Bukti:**
- Blue 4 menutup putaran hapus-buat-ulang untuk playlist, item,
  dan suka dengan dua lapis: tombstone dihitung dalam COUNT,
  dan tombstone memakai UPDATE (bukan INSERT). Riwayat TIDAK
  punya tombstone: satu-satunya hapus riwayat adalah
  `historyClearedBefore`, yaitu DELETE keras
  (`DELETE FROM sync_history WHERE user_id = ? AND played_at
  <= ?`, `:1120`), dan baris yang terhapus TIDAK LAGI
  dihitung COUNT berikutnya.
- Urutan pernyataan dalam satu push adalah: insert riwayat
  (`:1103`) dulu, DELETE `historyClearedBefore` (`:1120`)
  sesudahnya, keduanya dieksekusi berurutan dalam satu
  `db.batch` (`:1126`). `played_at` batas DELETE diambil dari
  body dan hanya divalidasi `isSafeInt` (bilangan bulat
  non-negatif apa pun, `:777-781`), jadi penyerang memakai
  batas raksasa (mis. 9999999999999) dan satu push menghapus
  seluruh riwayatnya sendiri, termasuk 100 baris yang baru
  saja dimasukkan push itu.
- Siklusnya: push N melihat COUNT 0 (push N-1 sudah menghapus
  semuanya), memasukkan 100 baris baru, lalu menghapus 100
  baris itu; push N+1 melihat COUNT 0 lagi. Batas total 1.000
  riwayat tidak pernah menghalangi karena COUNT selalu 0.
- **Dibuktikan di SQLite lokal** (skema 0001-0004, data buatan):
  1.000 insert lalu COUNT 1000; DELETE dengan batas besar lalu
  COUNT 0; insert 100 lagi lalu COUNT 100. Mekanismenya persis
  seperti yang dipakai worker.
- Hitungan kuota (angka dari arsitektur §2.1): tiap push
  menulis 100 insert + 1 DELETE yang menghapus ~100 baris.
  Bila DELETE dihitung sebagai baris ditulis (aturan meteran
  D1 untuk baris yang diubah), satu push membakar ~200 baris
  x 30 push/mnt (rate limit sync) = 6.000 baris/mnt, sehingga
  kuota 100.000 baris/hari habis dalam ~17 menit. Bila DELETE
  tidak dihitung sama sekali, tetap 100 baris/push x 30/mnt =
  3.000 baris/mnt, habis dalam ~33 menit. Kedua angka jauh di
  bawah satu jam, dari satu akun gratis self-serve (OAuth,
  tanpa persetujuan manual), sama seperti model ancaman S7.
- Dampaknya identik dengan S7 semula: push/pull sync gagal
  (500) untuk SEMUA pengguna sampai reset 00:00 UTC; rate
  limit proxy dan sync fail-open sehingga lapisan pelindung
  kuota Workers ikut nonaktif; `storeOAuthState` best-effort
  gagal diam-diam (single-use S6 ikut lumpuh, login lanjut
  fail-open).
- Klaim Blue 4 yang dibantah temuan ini: "Ini menutup putaran
  hapus-buat-ulang: pengguna yang sudah 100 baris tidak bisa
  membuat playlist baru sampai tombstone dibersihkan (30
  hari), jadi pengisian kuota berhenti total di batas, bukan
  berputar tanpa henti." Klaim itu BENAR untuk playlist, item,
  dan suka, tetapi SALAH untuk riwayat: riwayat berputar tanpa
  henti lewat DELETE keras, tanpa menunggu 30 hari apa pun.

**Dampak:** DoS ketersediaan sinkronisasi untuk semua pengguna
sampai reset harian, plus degradasi berantai rate limit dan
single-use state OAuth; kelas yang sama dengan S7 (Red 4) dan
S6 (Red 3), yang keduanya dinilai sedang.
**Rekomendasi (Blue):**
1. Terapkan anggaran hapus riwayat: tolak `historyClearedBefore`
   yang datang bersamaan dengan `history` non-kosong dalam satu
   push (hapus dan isi ulang tidak boleh satu paket), ATAU
   batasi frekuensinya (mis. satu DELETE riwayat per pengguna
   per jam, dicatat di baris meta pengguna), ATAU hitung DELETE
   riwayat sebagai pemakaian kuota dengan menolak push riwayat
   berikutnya bila pengguna sudah menghapus dalam jendela
   terakhir.
2. Alternatif yang lebih struktural: samakan riwayat dengan
   koleksi lain, yaitu tombstone (`deleted_at`) untuk hapus
   riwayat massal, bukan DELETE keras, sehingga baris hapus
   tetap dihitung COUNT. Ini perubahan protokol yang lebih
   besar; opsi (1) cukup untuk menutup vektor pembakaran.
3. Tambahkan tes worker: push 100 riwayat + `historyClearedBefore`
   berulang tidak bisa membakar kuota tanpa batas (push kedua
   ditolak atau dibatasi); hapus riwayat yang sah (tanpa isi
   ulang) tetap jalan.

### S9 - COUNT S7 per push membuka pembakaran kuota BACA D1: satu akun di batas suka menguras 5 juta baris/hari dalam ~8 menit

**Tingkat: sedang.** **File:**
`workers/sync/src/index.js:905-919` (COUNT per koleksi),
`:968-981` (cap suka + `fetchKeys`), `:838-872`
(`capNewEntries`), arsitektur §2.1 (baris dibaca dihitung dari
baris yang dipindai).

**Bukti:**
- Arsitektur §2.1 menyatakan meteran D1 secara eksplisit:
  "Baris dibaca dihitung dari baris yang dipindai, bukan baris
  yang dikembalikan." `COUNT(*)` lewat covering index tetap
  memindai seluruh entri indeks milik pengguna itu. Pengguna
  di batas suka (10.000 baris) membuat tiap COUNT suka
  memindai 10.000 baris, dan `fetchKeys` suka mengembalikan
  10.000 baris lagi.
- `capNewEntries` menjalankan `fetchKeys` setiap kali headroom
  tidak cukup untuk seluruh entri push (`:841-842`). Di batas
  suka, headroom = 0, sehingga SETIAP push yang membawa suka
  (bahkan satu update entri lama) memicu COUNT 10.000 +
  `fetchKeys` 10.000 = 20.000 baris dibaca per push.
- Hitungan kuota: 20.000 baris/push x 30 push/mnt (rate limit
  sync per pengguna) = 600.000 baris/mnt. Kuota baca D1
  free-tier adalah 5.000.000 baris/hari (dipakai bersama
  seluruh database `laras-web-sync`, termasuk baca rate limit
  proxy yang 1 baris per request dan baca pull). 5.000.000 /
  600.000 = habis dalam ~8 menit dari satu akun.
- Varian yang lebih murah bagi penyerang (tanpa `fetchKeys`):
  bertahan satu baris di bawah batas (9.999 suka) dan mendorong
  update entri lama: headroom 1 cukup untuk 1 entri sehingga
  `fetchKeys` tidak jalan, tetapi COUNT tetap memindai 9.999
  baris per push, yaitu ~10.000 x 30/mnt = 300.000 baris/mnt,
  habis dalam ~17 menit.
- Biaya masuk penyerang kecil: mencapai batas suka butuh 10.000
  tulis (10% kuota tulis harian, ~3,5 menit pada 30 push/mnt
  x 100 entri). Sesudah itu, pembakaran baca tidak butuh tulis
  tambahan sama sekali (update entri lama yang sama
  berulang-ulang).
- Blue 4 SUDAH mencatat biaya ini di dokumennya ("Pengguna di
  batas suka 10.000 yang sinkron tiap 20 detik akan memindai
  sekitar 30 ribu baris indeks per menit"), tetapi memakai
  angka pemakaian klien normal (3 push/mnt), bukan angka
  penyerang (30 push/mnt, 10x lipat). Pada laju penyerang,
  biaya yang "diterima" itu menjadi 600 ribu baris/mnt.
- Dampak bila kuota baca habis: semua query D1 gagal, sehingga
  `authUser` gagal (sync 500 untuk semua pengguna), rate limit
  fail-open (kuota request Workers 100 ribu/hari menjadi
  satu-satunya pelindung), dan `consumeOAuthState` fail-open
  (single-use S6/I19 nonaktif). Kelas dampaknya sama dengan
  S7/S8, hanya kuotanya yang berbeda (baca, bukan tulis).

**Dampak:** DoS ketersediaan sinkronisasi untuk semua pengguna
sampai reset harian, plus degradasi berantai rate limit dan
single-use state OAuth; vektor baru yang diperkenalkan oleh
perbaikan S7 itu sendiri.
**Rekomendasi (Blue):**
1. Perbaikan struktural: tabel penghitung per pengguna
   (satu baris per pengguna per koleksi), diperbarui di batch
   yang sama dengan upsert (mis. `INSERT ... ON CONFLICT ...
   DO UPDATE SET n = n + ?` dengan jumlah entri BARU yang
   lolos cap). Cek batas menjadi lookup satu baris (O(1)),
   bukan COUNT 10.000 baris. Bila batch gagal di tengah,
   penghitung bisa meleset sedikit (longgar bila update
   penghitung sesudah upsert, ketat bila sebelumnya); selisih
   itu terbatas dan jauh lebih aman daripada pemindaian penuh
   per push. Rekonsiliasi berkala (COUNT sesekali, mis. satu
   kali per jam per pengguna) menutup selisihnya.
2. Perbaikan murah sementara (bila tabel penghitung dianggap
   terlalu besar untuk Blue 5): jalankan COUNT hanya bila push
   membawa kunci yang MUNGKIN baru, dan cache hasil COUNT per
   pengguna di memori isolate dengan TTL singkat (mis. 60
   detik); satu jendela menit yang sama tidak perlu di-COUNT
   30 kali. Atau: tolak push suka di atas ambang bila pengguna
   sudah di batas tanpa menjalankan `fetchKeys` (update entri
   lama tetap butuh kunci, tetapi kunci bisa diambil dari
   cache, bukan dari D1 tiap push).
3. Tambahkan tes worker: pengguna di batas suka yang mendorong
   30x dalam satu menit tidak memindai lebih dari ambang baca
   yang ditetapkan (diukur lewat FakeD1 yang menghitung baris
   dipindai), dan batas total tetap ditegakkan.

---

## Temuan rendah

### R19 - COUNT + upsert tidak atomik: push bersamaan bisa melewati batas total sampai ~30x

**Tingkat: rendah.** **File:**
`workers/sync/src/index.js:905-919` (COUNT),
`:1126` (`db.batch`, bukan transaksi, lihat I16).

**Bukti:**
- COUNT dan batch upsert adalah dua operasi terpisah tanpa
  transaksi (D1 `batch` bukan transaksi atomik, I16 Red 3).
  Dua push bersamaan dari pengguna yang sama sama-sama membaca
  COUNT lama sebelum salah satunya melakukan batch, lalu
  sama-sama memasukkan entri baru.
- Batas atas pelampauan: rate limit sync 30/mnt/user
  membatasi 30 push per jendela menit, dan tiap push membawa
  maks 100 entri baru per koleksi. Bila ke-30 push dikirim
  bersamaan (pipelining), masing-masing melihat COUNT di bawah
  batas dan memasukkan 100 entri: sampai ~3.000 playlist
  (30x batas 100), ~3.000 item per playlist, ~3.000 suka,
  ~3.000 riwayat. Satu gelombang itu juga menulis sampai
  30 x 700 = 21.000 baris (21% kuota tulis harian) dalam satu
  menit.
- Penyeimbang yang membuat tingkatnya rendah, bukan sedang:
  pelampauan TERBATAS SATU KALI dan memperbaiki diri sendiri.
  Sesudah gelombang itu, COUNT sudah di atas batas sehingga
  push berikutnya dilewati semua (kecuali update entri lama
  dan siklus hapus riwayat S8). Tidak ada pembakaran
  berkelanjutan dari race ini saja. Ini cacat ketepatan batas,
  bukan vektor DoS berulang.
- Catatan: perbaikan struktural S9 (tabel penghitung yang
  diperbarui di batch yang sama) TIDAK menutup race ini
  sepenuhnya (baca penghitung lalu tulis tetap dua langkah),
  tetapi mempersempit jendelanya; penutupan penuh butuh
  penegakan di dalam satu pernyataan (mis. trigger CHECK atau
  upsert berkondisi pada subquery COUNT), yang merupakan
  perubahan lebih besar dan boleh ditunda selama pelampauan
  tetap terbatas seperti di atas.

**Dampak:** database pengguna membengkak sampai ~30x batas
arsitektur §4.3 dari satu gelombang push bersamaan, plus satu
ledakan tulis 21 ribu baris; batas total menjadi "lunak", bukan
"keras".
**Rekomendasi (Blue):** terima pelampauan terbatas ini sebagai
batasan yang didokumentasikan untuk Blue 5 (seperti I16), ATAU
tutup dengan trigger CHECK di D1 / upsert berkondisi bila
koordinator menginginkan batas keras. Bila tabel penghitung
(S9) diterapkan, catat bahwa race ini tetap ada dalam bentuk
yang lebih sempit. Tambahkan tes worker dua push bersamaan
(masing-masing 100 playlist baru, COUNT awal 50): total akhir
tidak melebihi 250 (50 + 100 + 100), dan tidak ada duplikasi
baris.

### R20 - `applyPull` jalur pengaturan: `lyrics.setEnabled` menulis tanpa cek generasi

**Tingkat: rendah.** **File:**
`app/src/sync/syncService.ts:168-178` (cabang pengaturan
`applyPull`), `app/src/lyrics/lyricsService.ts:57-62`
(`setEnabled` menulis meta IndexedDB).

**Bukti:**
- Desain R18 Blue 4 menempatkan cek `stale()` "TEPAT sebelum
  tiap penulisan" (`syncService.ts:89-94`). Cabang pengaturan
  mematuhinya di dua dari tiga penulisan: `stale()` sebelum
  `applySyncedEqSettings` (`:172`) dan sebelum
  `setSettingsAppliedAt` (`:176`). Tetapi penulisan di
  antaranya, `lyrics.setEnabled(payload.lyricsEnabled, ...)
  (:175)`, TIDAK punya cek `stale()` sebelumnya.
- `setEnabled` adalah penulisan persisten: `library.setMeta
  (LYRICS_ENABLED_KEY, ...)` (`lyricsService.ts:61`), yaitu
  tulis ke tabel meta IndexedDB.
- Jendelanya nyata, bukan teoretis: di antara cek `:172` dan
  panggilan `:175` ada DUA await (`applySyncedEqSettings`
  dan `getLyricsService()`), dan wipe yang dimulai selama
  await itu menaikkan generasi, menghapus database, lalu
  `setEnabled` tetap berjalan dan menulis nilai
  `lyricsEnabled` dari server ke database segar.
- Penyeimbang yang membuat tingkatnya rendah: yang
  dibangkitkan hanya satu boolean preferensi (lirik aktif
  atau tidak), bukan playlist, suka, atau riwayat; nilai
  default-nya aktif, sehingga dalam banyak kasus tulis itu
  tidak mengubah apa pun yang terlihat. Semua jalur tulis
  lain di `applyPull` (playlist buat/ubah/hapus, item
  tambah/hapus, suka, riwayat, `setSettingsAppliedAt`)
  TERBUKTI punya cek `stale()` sebelum tiap penulisan.
- Jalur tulis lain di `syncNow` juga sudah benar: cek sesudah
  `applyPull` sebelum `collectPushBody` (`:346`), cek sebelum
  tiap ronde dorong (`:376`), cek sebelum penanda sukses
  (`:405`). Jendela sisa di `collectPushBody` sendiri
  (`setPlaylistClientId` sesudah `allPlaylists`) aman karena
  `setPlaylistClientId` memakai Dexie `.update()`
  (`library.ts:2983-2985`), yaitu no-op bila barisnya sudah
  tidak ada sesudah wipe, dan `allPlaylists` di database segar
  mengembalikan daftar kosong sehingga tidak ada tulis.

**Dampak:** satu preferensi (lirik aktif/tidak) dari server
bisa bangkit sesudah wipe bila wipe mendarat di jendela
antara dua await di cabang pengaturan; janji wipe "kembali
kosong" dilanggar secara kecil.
**Rekomendasi (Blue):** tambahkan `if (stale()) return;`
tepat sebelum `lyrics.setEnabled` (`syncService.ts:175`),
mengikuti pola semua penulisan lain di `applyPull`.
Tambahkan tes: generasi berubah selama
`applySyncedEqSettings` (stub menggantung) lalu
`setEnabled` TIDAK dipanggil dan meta lirik tidak tertulis.

---

## Info

### I20 - `skippedOverLimit` bisa membocorkan jumlah item playlist orang lain bila clientId-nya diketahui

**File:** `workers/sync/src/index.js:938-966` (cap item dihitung
sebelum cek kepemilikan), `:1027-1040` (`playlistOwned`),
`countItemsPerPlaylist` (`:813-831`, tanpa filter `user_id`).

Cap item per playlist dihitung dari `playlistClientId` di body
SEBELUM `playlistOwned` menolak item ke playlist orang lain,
dan query GROUP BY-nya tidak memfilter `user_id`. Penyerang
yang mengetahui clientId playlist korban bisa mendorong 100
item ke playlist itu dan membaca `skippedOverLimit
.playlistItems` di respons: angkanya mencerminkan jumlah item
korban (mis. 99 dilewati berarti korban punya ~999 item).
Dampaknya dibatasi ketat: clientId berbentuk
`<UUID perangkat>:<id lokal>` (128 bit, tidak pernah terekspos
publik; file backup tidak membawanya, pull hanya mengembalikan
data milik pendorong sendiri), sehingga penyerang harus sudah
mengetahui rahasia itu lebih dulu; dan yang bocor hanya
perkiraan jumlah item satu playlist, bukan isi atau metadata.
Karena itu info, bukan temuan rendah. Rekomendasi: jalankan
cek kepemilikan SEBELUM cap item (atau tambahkan filter
`user_id` lewat join ke `sync_playlists` di query GROUP BY)
supaya hitungan cap tidak pernah menyentuh baris orang lain;
atau kembalikan `skippedOverLimit.playlistItems` 0 bila semua
item di playlist itu ditolak sebagai bukan milik pendorong.
Untuk koleksi lain (playlist, suka, riwayat) tidak ada celah
ini: COUNT-nya sudah terfilter `user_id = ?` milik pendorong,
dan `limits` hanya berisi konstanta publik §4.3.

### I16, I17, I18 - Masih terbuka dengan sengaja (bawaan Red 3/Red 4, tanpa perubahan)

- **I16** (`db.batch` bukan transaksi atomik): tidak berubah,
  tetap batasan yang didokumentasikan. Relevan langsung dengan
  R19 ronde ini (COUNT + batch tidak atomik).
- **I17** (`x-proxy-cpu-ms`): masih aktif, keputusan Blue 1
  dipertahankan (dicabut saat promosi proxy produksi). Tes s7
  masih menegaskan header terekspos (20/20 lolos).
- **I18** (allowlist hash player di-hardcode): tidak berubah,
  keputusan Blue 1 dipertahankan. Ketiga salinan hash MASIH
  sinkron per 19 Nov 2026: proxy `PLAYER_HASHES`
  (`workers/proxy/src/index.js:68`: `fad7e4e9`, `ad8d59ae`,
  `b559f50c`), `BUILTIN_HASHES` (`app/src/spike/config.ts:125-129`,
  nilai sts yang sama), dan config remote live (ketiga hash
  yang sama di `playerHashes`, `version: 1`, `ttlSeconds:
  21600`, diambil 19 Nov 2026).

---

## Verifikasi perbaikan Blue 4 (prioritas utama)

Semua klaim Blue 4 TERBUKTI. Tidak satu pun klaim yang gagal;
temuan baru S8/S9/R19/R20 adalah celah di SEKITAR perbaikan
(efek samping logika baru), bukan kegagalan klaimnya.

| ID | Klaim Blue 4 | Vonis | Bukti |
|---|---|---|---|
| S7 | Konstanta batas §4.3: 100 playlist / 1.000 item / 10.000 suka / 1.000 riwayat | **TERBUKTI (kode)** | `workers/sync/src/index.js:73-76` (`MAX_PLAYLISTS_PER_USER` 100, `MAX_ITEMS_PER_PLAYLIST` 1000, `MAX_LIKES_PER_USER` 10000, `MAX_HISTORY_PER_USER` 1000), sesuai arsitektur §4.3. |
| S7 | COUNT per koleksi SEBELUM upsert, paralel, koleksi kosong tidak di-COUNT | **TERBUKTI (kode)** | `handlePush` `:905-919`: `Promise.all` empat hitungan dengan guard `length > 0` per koleksi; `countUserRows` `:804-811`, `countItemsPerPlaylist` `:813-831`. |
| S7 | Kelebihan dilewati per koleksi + dilaporkan `skippedOverLimit` + `limits` | **TERBUKTI (kode)** | `skippedOverLimit` diinisialisasi `:895-901`, diisi per koleksi (`:935`, `:963`, `:982`, `:1001`); respons `:1131-1141` membawa `skippedOverLimit` + `limits` (keempat angka). Sisa push yang sah tetap diterapkan (bukan gagal total). |
| S7 | Update entri lama tidak dihitung penambahan; duplikat kunci dihitung sekali | **TERBUKTI (kode + tes)** | `capNewEntries` `:838-872`: kunci yang sudah ada (`existing.has`) selalu `kept`; kunci baru memakan headroom sekali lalu ditambahkan ke `existing`. Tes worker "update playlist lama tetap jalan saat sudah di batas 100" lolos (49/49). |
| S7 | Tombstone UPDATE bukan INSERT; tombstone hantu no-op; penghapusan tidak pernah ditolak batas | **TERBUKTI (kode + tes + SQL)** | UPDATE playlist `:1050`, item `:1076`, suka `:1094`, ketiganya `WHERE ... AND user_id = ?` + kondisi LWW yang sama dengan ON CONFLICT lama. Tombstone tidak melewati `capNewEntries` sama sekali. Tes "tombstone untuk playlist yang tidak ada tidak membuat baris" lolos. |
| S7 | Cap klien 100 di `createPlaylistFromRemote` | **TERBUKTI (kode + tes)** | `library.ts:90` `MAX_SYNC_PLAYLISTS` 100 + `:3023-3038`: `count >= 100` mengembalikan null sebelum `add`. Satu-satunya pemanggil adalah `applyPull` (`syncService.ts:114`). Tes klien "tarik playlist ke-101 ditolak" + "ke-100 diterima" lolos (20/20 syncService). |
| S7 | Query baru memakai covering index, nol migrasi, nol SCAN | **TERBUKTI (EXPLAIN, Red 5)** | Red 5 menjalankan EXPLAIN QUERY PLAN kedelapan query di SQLite lokal sesudah 0001-0004: COUNT playlist `idx_playlists_client`, COUNT suka `idx_likes_user_updated`, COUNT riwayat `idx_history_user_played`, GROUP BY item `idx_items_updated`, pengambil kunci playlist `idx_playlists_client`, kunci item/suka/riwayat memakai PK autoindex; SEMUA "USING COVERING INDEX", NOL SCAN tabel. Sesuai klaim Blue 4 (nama indeks di dokumen Blue 4 benar; komentar di `index.js` bagian S7 menyebut `idx_playlists_user_updated`/`idx_items_playlist`, yaitu nama yang tidak dipakai rencana query, catatan kecil, bukan temuan). |
| S7 | `PushData` mendeklarasikan field baru | **TERBUKTI (kode)** | `syncClient.ts:111-130`: `skippedNotOwned?`, `skippedOverLimit?`, `limits?` (opsional). |
| S7 | Live: push mengembalikan `limits`/`skippedOverLimit` | **TIDAK BISA DIVERIFIKASI LIVE** | Butuh sesi login (kredensial owner); Red 5 tidak punya sesi. Verifikasi kode + tes + EXPLAIN adalah bukti yang dipakai. Lihat "Tidak bisa diverifikasi". |
| R17 | Wipe menunggu `refreshAuth` bila status `unknown`, batas 10 detik | **TERBUKTI (kode + tes)** | `WipeFlow.tsx:27` `WIPE_REFRESH_TIMEOUT_MS` 10.000 + `:73-92`: `Promise.race([refreshAuth(), setTimeout 10 dtk])`, lalu status akhir dibaca dari `useSyncStore.getState()` (bukan closure basi). Timeout ditangani: race resolve sesudah 10 dtk walau `refreshAuth` menggantung, tidak ada gantungan selamanya; `refreshAuth` sendiri menangkap galatnya (`syncStore.ts:64-82`), jadi tidak ada rejection tak tertangani dari janji latar. |
| R17 | Status tetap `unknown` menampilkan peringatan + tombol coba lagi / tetap hapus | **TERBUKTI (kode + tes)** | `WipeFlow.tsx:93-99` (`setStatusUnknown(true)`, wipe tidak lanjut) + `:214-215` tombol "Coba keluar lagi" (menjalankan ulang seluruh keputusan) / "Tetap hapus" (pilihan sadar). Copy `backupWipeUnknownStatus` (`id.ts:393-394`) sesuai klaim. Testid `wipe-logout-failed` dipakai bersama jalur R15. 6 tes R17 lolos (WipeFlow 9/9). |
| R17 | Jalur `signed-in` tetap logout dulu; `signed-out` langsung wipe | **TERBUKTI (kode)** | `WipeFlow.tsx:100-121`: `signed-in` memanggil `fetchLogout()` sebelum `doWipe()` (gagal logout menampilkan peringatan R15); `signed-out` melewati keduanya langsung ke `doWipe()`. |
| R18 | Wipe menaikkan generasi sebagai baris pertama | **TERBUKTI (kode)** | `syncEpoch.ts` (baru, 29 baris, tanpa dependensi); `wipe.ts:112` `invalidateSyncEpoch()` sebagai baris pertama `wipeAllData`, sinkron, sebelum await apa pun. Kontrak dicatat di kepala file. |
| R18 | `applyPull` cek generasi sebelum tiap penulisan | **TERBUKTI (kode, dengan pengecualian R20)** | `syncService.ts:86-94` (parameter `epoch` + `stale()`); cek sebelum: buat/ubah/hapus playlist, tambah/hapus item, `ensureRemoteSong` + `setLiked`, `recordPlay`, `applySyncedEqSettings`, `setSettingsAppliedAt`. Satu-satunya yang lolos adalah `lyrics.setEnabled` (`:175`), dilaporkan sebagai R20, bukan sebagai kegagalan klaim (klaim Blue 4 menyebut "cek kedua sebelum `setSettingsAppliedAt`", dan cek itu memang ada; yang hilang adalah cek ketiga sebelum `setEnabled`). |
| R18 | `syncNow` berhenti bila generasi berubah; tidak menulis penanda; tidak melempar galat palsu | **TERBUKTI (kode + tes)** | `syncService.ts:338` generasi ditangkap di awal; `:346` berhenti sebelum `collectPushBody`; `:376` berhenti sebelum tiap ronde dorong; `:405` berhenti sebelum penanda sukses. Putaran yang dibatalkan mengembalikan `{ serverTime, pushed }` tanpa melempar, sehingga store tidak mencatat galat (`syncStore.ts` mengatur `syncing: false` di kedua jalur, tidak ada status menggantung). Tes "syncNow yang dibatalkan wipe tidak mendorong dan tidak menulis penanda" lolos. |
| I19 | Satu DELETE berkondisi + cek `meta.changes` | **TERBUKTI (kode + tes)** | `consumeOAuthState` `index.js:391-408`: `DELETE FROM oauth_states WHERE state_hash = ? AND provider = ? AND expires_at > ?` (`:396`) + `return res.meta?.changes === 1` (`:400`). Tes "dua callback PARALEL, satu state, hanya satu yang lanjut" lolos (49/49). |
| I19 | Pemetaan galat tetap `fail('state')`; fail-open dipertahankan | **TERBUKTI (kode + live tidak langsung)** | Pemanggil `:563` tidak berubah (`if (!(await consumeOAuthState(...))) return fail('state')`); catch `:401-407` mengembalikan true + peringatan. LIVE 19 Nov 2026: callback state tak dikenal (cookie cocok, state acak) ke 302 `reason=state`, bukan `reason=exchange` (yang akan terjadi bila tabel belum ada karena fail-open), jadi jalur DELETE berkondisi TERBUKTI aktif live. |
| I19 | Replay saat D1 galat (fail-open + catch return true) | **DIPERIKSA, BERSIH** | Fail-open hanya melewati cek state; kode otorisasi provider BERSIFAT sekali pakai, sehingga `exchangeCode` kedua gagal di sisi Google/GitHub dan tidak ada sesi kedua yang tercipta. Kerugian terburuk saat D1 galat adalah satu fetch token-endpoint ekstra per callback, bukan pembuatan sesi ganda. Rate limit callback 10/mnt/IP tetap berlaku. Bukan temuan. |

**Catatan koreksi kecil atas dokumen Blue 4 (bukan temuan):**
nomor baris respons push bergeser (`:1131-1141`, bukan
`:1128-1143`); komentar S7 di `index.js` menyebut indeks
`idx_playlists_user_updated`/`idx_items_playlist` sementara
rencana query yang sebenarnya memakai `idx_playlists_client`/
`idx_items_updated` (dokumen Blue 4 yang benar; EXPLAIN Red 5
mengonfirmasi). Isi perbaikannya sendiri benar di semua kasus.

---

## Verifikasi regresi Blue 1 + Blue 2 + Blue 3 (semua bertahan)

| ID | Status Red 5 | Bukti |
|---|---|---|
| H1 (tinggi, chunk uji di produksi) | BERTAHAN | `App.tsx:35-54`: kedelapan rute uji digerbang `import.meta.env.DEV` termasuk lazy import-nya; `parseRoute` (`:101-108`) ikut digerbang. `app/dist/assets` (53 aset, build Blue 4): **0 chunk `*TestPage*`**, 1 chunk `SpikePage` (pengecualian koordinator). Gerbang CI masih ada di `ci.yml:53`. Chunk index live `index-CPtPzBRh.js` sama dengan `app/dist/index.html`. |
| S1 (sedang, body POST dibaca penuh) | BERTAHAN | Proxy: `readCapped(request.body, MAX_BODY_BYTES)` (`:455`) + cek `Content-Length` awal. Pola yang sama dipakai worker sync (`handlePush`). Uji unit worker 20/20. |
| S2 (sedang, tanpa CSP) | BERTAHAN + LIVE | `app/public/_headers` utuh; **terkonfirmasi dari header live** `https://laras.adipmusic.my.id/` 19 Nov 2026 (2x): CSP persis sama dengan file (termasuk `'wasm-unsafe-eval'`, bukan `'unsafe-eval'`, `connect-src` memuat sync + lrclib + lyrics.ovh), `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`. |
| S3 (sedang, rate limit in-memory) | BERTAHAN (kode + live tidak langsung) | Proxy `rateLimit.js` + D1 masih dipakai; tidak ada `buckets` in-memory. Uji unit 7/7 (stabil, I15). Bukti live tidak langsung: rate limit callback sync (mekanisme D1 yang sama, `isRateLimited`) TERBUKTI live 10+1 429 di Red 4 dan perilaku callback ronde ini konsisten; verifikasi D1 proxy ASLI live (61+ request) masih belum dilakukan (hemat kuota). |
| S4 (sedang, config tanpa cap/versi) | BERTAHAN | Cap 4 MB + `version === 1` masih ditegakkan (`resolve.ts:123`, `readCappedText`); config remote live terverifikasi berisi `"version": 1` (19 Nov 2026). |
| R1 (rendah, redirect media tanpa validasi) | BERTAHAN | `redirect: 'manual'` (proxy `:226,341`), maks 3 hop, validasi host per hop, Content-Type allowlist + `nosniff`. |
| R2 (rendah, `decodeURIComponent` tanpa try/catch) | BERTAHAN | `App.tsx:parseRoute` try/catch; `main.tsx` ErrorBoundary. |
| R3 (rendah, SW cache-first + versi manual) | BERTAHAN | Navigasi network-first; cache runtime hanya aset statis; `app/dist/sw.js` berisi `SW_VERSION = '0.9.0-71925ff2'` (sama dengan build P8/Blue 3/Blue 4; `sw.js` tidak berubah di Blue 4). |
| R4 (rendah, CI tag `@v4`, tanpa permissions/audit) | BERTAHAN | `ci.yml`: ketiga action dipin SHA penuh, `permissions: contents: read` (`:9`), gerbang `npm audit --omit=dev --audit-level=high` (`:42`) + audit dev informasional + gerbang H1 (`:53`). Audit lokal tetap terblokir egress (lihat "Tidak bisa diverifikasi"). |
| R5 (rendah, cap client sesudah baca penuh) | BERTAHAN | `resolve.ts` base.js (8 MB) dan `innertube.ts` (10 MB) memakai `readCappedText`. |
| R6 (rendah, origin dev di CORS produksi) | BERTAHAN (proxy) | `workers/proxy/wrangler.toml`: `[vars]` hanya dua domain produksi; localhost hanya di `[env.dev.vars]`. |
| S5 (sedang, `JSON.parse` cache config) | BERTAHAN | `configStore.ts:135` `parseConfigText` dipakai ketiga jalur (`:231,245,314`); entri rusak dihapus best-effort. |
| R7 (rendah, re-resolve tanpa cek itag) | BERTAHAN | `downloadManager.ts:724` `currentItag`, `:742-746` lempar `ItagChangedError`, restart sekali dari byte 0, `formatId` memakai itag akhir. |
| R8 (rendah, SW Content-Type apa adanya) | BERTAHAN (sumber + dist) | `sw.js` `safeDownloadContentType` + `nosniff` di jalur 200 dan 206; `downloadStore.ts` memaksa tipe sebelum `cache.put`; `app/dist/sw.js` memuat fungsi itu (4 kecocokan). |
| R9 (rendah, race batal vs rakit) | BERTAHAN | `downloadManager.ts:801` cek abort sebelum `putDownload`, `:821` cek sebelum `markDownloaded` (+ hapus file bila batal di antaranya), `:837` cek sesudah unduh sebelum rakit. |
| I5 (enum snapshot) | BERTAHAN | `diagnostics.ts:236,241` `hasOwnProperty` untuk `KIND_LETTER`/`CAUSE_LETTER`. |
| I6 (tunggu 429 tak terbatalkan) | BERTAHAN | `downloadManager.ts:102` `sleepAbortable`, dipakai di cabang 429 (`:283`). |
| I7 (fallback `combineSignal`) | BERTAHAN | Fallback tanpa `AbortSignal.any` memakai `AbortController` gabungan + listener abort manual. |
| S6 (sedang, callback tanpa rate limit + state bisa dipakai ulang) | BERTAHAN + LIVE | Rate limit callback 10/mnt/IP sebelum tukar kode (`index.js:1183`); state single-use D1 + konsumsi atomik I19 (`:391-408`); fail-open dipertahankan. LIVE: callback state tak dikenal ke 302 `reason=state` (19 Nov 2026). |
| R10 (rendah, localhost di ALLOWED_ORIGINS sync) | BERTAHAN + LIVE | `workers/sync/wrangler.toml:24` `[vars]` hanya `https://laras.adipmusic.my.id`; localhost hanya di `[env.dev.vars]`. LIVE 19 Nov 2026, 2x OPTIONS ke `/api/sync/push` dengan `Origin: http://localhost:5173`: 204 TANPA `Access-Control-Allow-Origin`. |
| R11 (rendah, push tanpa cek kepemilikan) | BERTAHAN | Upsert playlist `WHERE ... AND sync_playlists.user_id = excluded.user_id`; `playlistOwned` + `skippedNotOwned`; insert/tombstone item membawa `user_id`; tombstone UPDATE baru JUGA membawa `user_id` di WHERE (`:1050,1076,1094`), jadi kepemilikan dipertahankan di bentuk barunya. |
| R12 (rendah, impor backup baca penuh sebelum cek) | BERTAHAN | `ImportBackupDialog.tsx:82-86`: `file.size > MAX_BACKUP_BYTES` sebelum `arrayBuffer()`. |
| R13 (rendah, impor Spotify jalur file tanpa cap) | BERTAHAN | `spotify.ts:67` 10 MB + `:76` 30 lagu + `:165-171` lapis kedua parser; judul/artis dipotong 1.000 karakter. |
| R14 (rendah, parser backup tanpa cap per-field/per-koleksi) | BERTAHAN | `format.ts:62-90` konstanta cap lengkap; `tokens.ts:45,48` (200 token + 100 karakter); `service.ts:294` `MAX_REDOWLOAD_JOBS` 200. |
| R15 (rendah, wipe tidak mengakhiri sesi) | BERTAHAN (dengan R17/R18 kini tertutup) | `WipeFlow.tsx:100-121`: `signed-in` logout dulu sebelum wipe; gagal logout menampilkan peringatan + "Coba keluar lagi" / "Tetap hapus". Celah status `unknown` (R17) dan race sync-dalam-penerbangan (R18) kini ditutup Blue 4 (lihat tabel verifikasi; satu sisa kecil dilaporkan sebagai R20). |
| R16 (rendah, nama playlist impor Spotify tidak divalidasi) | BERTAHAN | `spotify.ts:757-759` potong ke 100 karakter sebelum `createPlaylist`; `SpotifyImportDialog.tsx` `handleStart` punya `catch` + galat dirender. |
| I11 (klasifikasi AbortError) | BERTAHAN | 5 lokasi memakai cek `name` langsung tanpa gate `instanceof` (`chunkedDownloader.ts:140`, `syncClient.ts:166`, `spotify.ts:592`, `downloadManager.ts`, `resilience/errors.ts`). |
| I12 (`parseCookies` tanpa try/catch) | BERTAHAN | `workers/sync/src/index.js:142-161`: decode per nilai dibungkus try/catch (`:152`), nilai malformed dipakai mentah. (Nomor baris bergeser dari dokumen Blue 3; perbaikannya ada.) |
| I13 (record null LRCLIB) | BERTAHAN | `lrclib.ts:115-118`: record bukan objek/null mengembalikan `{ status: 'not-found' }`. |
| I14 (nosniff/CSP halaman 503) | BERTAHAN | `index.js:100,112` nosniff di `jsonError`/`jsonOk`; `:426` halaman 503 membawa nosniff + CSP. |
| I15 (tes rateLimit stabil) | BERTAHAN | `rateLimit.test.ts` mem-mock `Math.random`; dijalankan Red 5: 7/7 hijau. |
| I1/I8/I17 (header CPU) | MASIH TERBUKA (sengaja) | Lihat I17. |
| I2/I9/I18 (hash hardcode) | MASIH TERBUKA (sengaja) | Lihat I18; ketiga salinan masih sinkron. |
| I3 (track lokal tanpa validasi URL) | BERTAHAN | `player/port.ts` `isSafeLocalUrl` + choke di `service.ts` sebelum `decidePath` (tidak berubah sejak Red 3). |
| I4 (sourcemap di dist) | BUKAN TEMUAN | Tetap sesuai putusan Red 1 (repo GPL publik). |
| I10 (versi worker live tak pasti) | TERTUTUP SEBAGIAN (lanjut) | Redeploy sync Blue 4 TERBUKTI live ronde ini lewat perilaku (R10 + callback `reason=state`, keduanya butuh kode pasca-Blue-3; etag deploy 2af810c3 sesuai penugasan). Redeploy proxy D1 live (61+ request) masih belum dibuktikan langsung. |

---

## Cap di semua jalur masuk data (diperbarui untuk S7/S8/S9)

| Jalur masuk | Cap | Status |
|---|---|---|
| Backup file | 10 MB total + per-field/per-koleksi (R14) + cek ukuran sebelum baca (R12) | Lengkap |
| Spotify file/teks | 10 MB + 30 lagu + teks 1.000 karakter (R13) | Lengkap |
| Spotify tautan | 30 lagu + halaman 2 MB (proxy) | Lengkap (tidak berubah) |
| Sync push (server) | 1 MB body + 100 entri/koleksi + per-field + batas TOTAL per pengguna (S7) | Lengkap per koleksi, KECUALI: riwayat bisa dihapus keras lalu diisi ulang tanpa batas (S8); COUNT per push membakar kuota baca (S9); race bersamaan melampaui batas sampai ~30x (R19) |
| Sync pull (server) | 1.000 baris/koleksi per pull | Lengkap per-pull; akumulasi antar-pull kini dibatasi S7 di sisi tulis + cap klien 100 playlist |
| Sync pull (klien) | Item 1.000/playlist; playlist total 100 (`createPlaylistFromRemote`, S7) | Lengkap |
| Pencarian YTM | 100 item/grup (parser), 10 MB respons | Lengkap (tidak berubah) |
| Lirik LRCLIB/lyrics.ovh | 1 MB + timeout 30 dtk | Lengkap (tidak berubah) |
| Config remote | 4 MB + versi 1 | Lengkap (tidak berubah) |
| "Unduh ulang" | 200 job/ketukan + laporan kelebihan | Lengkap (R14) |
| Unduhan chunk | 100 MB/file, antrean 200 (unduh ulang) | Lengkap (tidak berubah) |

---

## Verifikasi Origin di semua rute POST sync (fokus koordinator)

Semua handler POST di worker sync diperiksa satu per satu; tidak ada
yang berubah sejak Red 4 kecuali penambahan logika S7/I19 di dalam
handler (bukan di gerbangnya).

| Rute POST | Cek Origin | Rate limit | Bukti |
|---|---|---|---|
| `/api/auth/logout` | YA, sebelum auth | Tidak ada (self-limiting: sesi dihapus di pemakaian pertama) | `index.js:1216` |
| `/api/auth/delete` | YA, sebelum auth | Tidak ada (self-limiting: akun+sesi dihapus di pemakaian pertama) | `index.js:1235` |
| `/api/sync/push` | YA, sesudah auth + rate limit, sebelum `handlePush` | 30/mnt/user | `index.js:1289` |
| `/api/auth/callback` (GET) | N/A (navigasi OAuth) | 10/mnt/IP (S6) | `index.js:1183` |
| `/api/auth/login` (GET) | N/A (navigasi OAuth) | 10/mnt/IP | `index.js:444` |
| `/api/auth/me` (GET) | N/A (baca-saja) | 60/mnt/IP | `index.js:1198` |
| `/api/sync/pull` (GET) | N/A (baca-saja) | 30/mnt/user | `index.js:1271` |

`isAllowedOrigin` (`:133`) tetap mengembalikan false bila header
`Origin` TIDAK ADA, jadi request tanpa Origin ditolak, bukan
diizinkan. Logout/delete tanpa rate limit dinilai BUKAN temuan:
keduanya menghapus otoritas pemanggilnya sendiri di pemakaian
pertama yang berhasil (sesi/akun hilang, panggilan berikut 401),
dan logout tanpa sesi tidak menulis D1 sama sekali.

---

## Yang DIPERIKSA dan bersih (baru di ronde ini + umum)

- **Tombstone UPDATE tidak bisa menghapus baris orang lain.**
  Ketiga UPDATE membawa `user_id = ?` milik pendorong di WHERE
  (`:1050,1076,1094`) di samping kondisi LWW; item juga membawa
  `playlist_id` + `video_id`. Baris yatim pra-migrasi 0004
  (`user_id` NULL) tidak pernah cocok dengan `user_id = ?`,
  jadi tombstone-nya no-op, bukan penghapusan liar.
- **Batas item/playlist tidak bisa dipalsukan lewat body.**
  COUNT item memakai `playlistClientId` dari body sebagai
  `playlist_id`, tetapi INSERT memakai nilai yang sama persis,
  dan `playlistOwned` menolak item untuk playlist yang bukan
  milik pendorong atau tidak ada di push yang sama. Mengaku
  playlist kosong tidak memberi headroom di playlist orang
  lain; satu-satunya kebocoran adalah perkiraan jumlah item
  (I20, info).
- **`skippedOverLimit` tidak membocorkan info ke pemiliknya
  sendiri.** Angka yang dikembalikan hanya menyangkut data
  milik pendorong yang terautentikasi, dan `limits` hanya
  konstanta publik §4.3. Satu-satunya pengecualian adalah
  I20 (butuh clientId korban yang 128 bit).
- **R17 timeout 10 detik ditangani, tidak menggantung.**
  `Promise.race` di `WipeFlow.tsx:82-89` resolve sesudah 10
  detik walau `refreshAuth` menggantung; `refreshAuth` sendiri
  menangkap galatnya di store, jadi janji latar tidak
  meninggalkan rejection tak tertangani. Pengguna yang
  memilih "Tetap hapus" melakukannya sesudah melihat
  peringatan eksplisit.
- **`syncNow` yang dibatalkan wipe tidak meninggalkan status
  menggantung.** Putaran yang dibatalkan mengembalikan normal
  (tanpa melempar), store mengatur `syncing: false` di jalur
  sukses maupun galat (`syncStore.ts:85-104`), dan halaman
  me-reload karena wipe. `lastSyncAt` memang ditulis dari
  `pull.serverTime` walau putaran dibatalkan, tetapi reload
  menghapus state memori itu; bukan temuan.
- **Sesi cookie benar.** Token 256 bit acak, hash SHA-256 di D1,
  cookie HttpOnly + Secure + `SameSite=None` (penyimpangan
  tercatat dari arsitektur §4.3 dengan alasan lintas-situs +
  mitigasi Origin; env `COOKIE_SAMESITE=Lax` tersedia), 30
  hari, maks 10 sesi/user (sesi terlama dihapus), kedaluwarsa
  dicek di `authUser`, logout menghapus sesi spesifik itu.
  Tanpa `Domain` (host-only, benar).
- **Logika `oauth_states` benar sesudah I19.** State 128 bit
  acak; yang disimpan hanya hash SHA-256; TTL 10 menit sama
  dengan cookie; sapu kedaluwarsa tiap login; provider
  dicocokkan; konsumsi kini atomik (satu DELETE berkondisi).
  Baris kedaluwarsa/salah provider tidak lagi dihapus saat
  callback (tidak cocok dengan kondisi DELETE); pembersihannya
  diserahkan ke sapu login, yang sudah berjalan tiap login.
  Fail-open saat D1 gagal adalah keputusan yang
  didokumentasikan dan dilindungi rate limit + kode provider
  sekali pakai (lihat baris I19 di tabel verifikasi).
- **Kepemilikan R11 tidak punya TOCTOU.** Upsert playlist tidak
  pernah mengubah `user_id` (tidak ada di klausa SET), sehingga
  kepemilikan tidak berubah di antara cek `playlistOwned` dan
  eksekusi batch. `playlistOwned` mengabaikan
  `newPlaylistIds` bila baris sudah ada (cek kepemilikan yang
  menang), jadi penyerang tidak bisa "mengklaim" playlist
  orang lain dengan menyertakannya di push yang sama.
- **Pull dan hapus akun terikat user.** Semua 5 query
  `handlePull` memakai `user_id = ?` (item lewat join
  `p.user_id`), dan hapus akun menghapus item hanya lewat
  subquery playlist milik pengguna (`:1248-1256`), jadi delete
  tidak menyentuh item orang lain.
- **Nol XSS / eval liar / secret / telemetri / console.**
  NOL `dangerouslySetInnerHTML` / `innerHTML` DOM /
  `document.write` di `app/src` (grep ronde ini; `innerHTML`
  hanya di tes `WipeFlow.test.tsx`, bukan kode produksi).
  Engine eval fallback hanya diimpor `evalFallbackWorker.ts`
  (harness spike, bukan kode app) dan TIDAK ADA chunk
  eval/fallback di `app/dist/`. NOL `console.*` di kode
  produksi. NOL pola secret di repo (satu-satunya kunci
  adalah kunci publik InnerTube, BUKAN temuan; client secret
  OAuth tidak ada di repo). NOL telemetri (grep `sendBeacon`/
  `WebSocket`/analytics nol).
- **Larangan `api.spotify.com` dipatuhi total.** String itu
  hanya muncul di komentar kode sebagai larangan dan di tes
  (termasuk tes yang menegaskan URL itu DITOLAK).
- **Dependensi produksi tidak berubah sejak Red 4.**
  Tidak ada dependensi baru di Blue 4 (hanya kode). picomatch
  GHSA-fc5q tetap diketahui dan tidak dilaporkan ulang
  (upgrade Vitest 5 terjadwal).
- **Hash player sinkron.** Lihat I18 di atas.

---

## Hasil tes

| Tes | Hasil |
|---|---|
| Vitest penuh | **771/771, 50 file** (115 dtk, `--configLoader runner --pool=threads`), exit 0 |
| `syncWorker.test.ts` (termasuk 11 tes baru S7/I19) | **49/49** |
| `syncService.test.ts` (termasuk 4 tes baru S7/R18) | **20/20** |
| `WipeFlow.test.tsx` (termasuk 6 tes baru R17) | **9/9** |
| `rateLimit.test.ts` (I15) | **7/7** |
| Uji unit worker proxy (`s7-unit-test.mjs`) | **20/20** |
| Typecheck / lint | Tidak dijalankan ulang ronde ini (Blue 4 melaporkan 0 error untuk keduanya; tidak ada kode yang diubah Red 5) |

---

## Probe live (19 Nov 2026, tanpa auth, tanpa data pengguna)

| Probe | Hasil |
|---|---|
| Header `https://laras.adipmusic.my.id/` (2x) | CSP + nosniff + DENY + no-referrer sesuai `_headers` (S2 live) |
| OPTIONS `/api/sync/push`, `Origin: http://localhost:5173` (2x) | 204 TANPA `Access-Control-Allow-Origin` (R10 TERBUKTI live sesudah redeploy Blue 4) |
| Callback state tak dikenal (cookie cocok, state acak) | 302 `reason=state` (jalur DELETE berkondisi I19 TERBUKTI live; tabel `oauth_states` ada) |
| Config remote `player-config.json` | `version: 1`, `ttlSeconds: 21600`, ketiga hash sama dengan repo (I18 sinkron) |
| `/api/auth/me` tanpa cookie | 401 `UNAUTHORIZED` |

Total 8 request; tidak ada yang menyentuh data pengguna,
tidak ada login, tidak ada penulisan D1 atas nama pengguna.
Probe curl ke worker proxy dari VM tidak diulang ronde ini
(Red 3/Red 4 mencatat gangguan egress VM, bukan worker mati).

---

## Yang TIDAK bisa diverifikasi + alasannya

- **S7 live (push mengembalikan `limits`/`skippedOverLimit`).**
  Butuh sesi login sungguhan (kredensial owner); Red 5 tidak
  punya sesi dan tidak meminta kredensial. Verifikasi kode +
  tes worker (49/49, termasuk 8 tes S7) + EXPLAIN adalah bukti
  yang dipakai. Menjadi tugas koordinator dengan akun uji:
  push normal 1 entri harus mengembalikan field `limits` +
  `skippedOverLimit` di respons.
- **S8/S9 live (laju pembakaran kuota yang sebenarnya).**
  Pembuktian live butuh akun uji yang benar-benar membakar
  kuota D1 bersama (puluhan ribu baris tulis/baca); sengaja
  TIDAK dilakukan karena merusak kuota harian produk. Bukti
  yang dipakai adalah kode + SQL lokal (S8 terbukti di SQLite)
  + aritmetika dari angka arsitektur §2.1 (S9, meteran baris
  dipindai). Satu ketidakpastian yang dicatat jujur: apakah
  DELETE dihitung sebagai baris ditulis dalam meteran D1
  (S8 memakai kedua angka, 17 dan 33 menit, supaya vonis tidak
  bergantung pada asumsi itu).
- **Wipe ujung-ke-ujung (R15/R17/R18) dengan sesi login.**
  Wipe saat masuk lalu tunggu 20 detik (data TIDAK kembali),
  wipe saat status belum terkonfirmasi, wipe saat sync sedang
  berjalan: ketiganya butuh sesi login sungguhan + browser.
  Red 5 hanya memverifikasi kode + tes Vitest. Menjadi tugas
  koordinator dengan akun uji.
- **`npm audit` (gerbang R4).** Endpoint audit npm diblokir
  egress proxy VM (403 `policy_denied`, terverifikasi di ronde
  sebelumnya, sama seperti Red 1/2/3/4 dan Blue 1/2/3/4). CI
  run adalah bukti sahnya; picomatch GHSA-fc5q sudah diketahui
  dan didokumentasi, bukan temuan baru.
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
  (401 tanpa cookie, penolakan state tak dikenal). Verifikasi
  koordinator diterima sebagai bukti untuk alur login.
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
  P7/P8 + Blue 4 yang sudah lolos di VM tim sebelumnya + CI
  (Blue 4 melaporkan `p8.spec.ts` 6/6), Vitest `sw.test.ts`,
  dan `app/dist/sw.js` hasil build Blue 4 yang terverifikasi
  memuat perbaikan R8.
- **Unduh live ujung-ke-ujung + unduh ulang massal.**
  googlevideo memblokir IP VM (vonis S3); kaki live sudah
  dicatat sebagai utang dan bukan ranah audit ini.

---

## Rekomendasi urutan perbaikan untuk Blue 5

1. **S8** - tutup siklus hapus-buat-ulang riwayat (tolak
   `historyClearedBefore` satu paket dengan isi riwayat, atau
   batasi frekuensi DELETE riwayat, atau tombstone untuk hapus
   riwayat massal). Satu-satunya koleksi yang masih bisa
   memutar kuota tulis tanpa batas.
2. **S9** - hilangkan COUNT penuh per push (tabel penghitung
   per pengguna yang diperbarui di batch yang sama, atau cache
   COUNT ber-TTL singkat). Perbaikan S7 tidak boleh menukar
   pembakaran tulis dengan pembakaran baca.
3. **R20** - tambahkan cek `stale()` sebelum `lyrics.setEnabled`
   di `applyPull` (satu baris + satu tes).
4. **R19** - dokumentasikan pelampauan race sebagai batasan
   (seperti I16), atau tutup dengan trigger CHECK / upsert
   berkondisi bila koordinator menginginkan batas keras.
5. **I20** - jalankan cek kepemilikan sebelum cap item, atau
   tambahkan filter `user_id` di GROUP BY item.
6. **Koordinator (bukan Blue):** verifikasi S7 live dengan akun
   uji (push 1 entri mengembalikan `limits` +
   `skippedOverLimit`); verifikasi R15/R17/R18 ujung-ke-ujung
   (wipe saat masuk, tunggu 20 detik, data TIDAK kembali;
   wipe saat status belum terkonfirmasi; wipe saat sync sedang
   berjalan); cabut `x-proxy-cpu-ms` (I17) dan rancang sumber
   hash remote (I18) saat promosi produksi; gerbang `npm audit`
   di run CI; pertimbangkan pemantauan kuota D1 (baca DAN tulis,
   karena S9 menunjukkan kuota baca sama rentannya, dengan
   peringatan jauh sebelum 5 juta baris/hari).

**Red 6 (sesudah Blue 5):** verifikasi S8 dengan tes worker
(push riwayat + `historyClearedBefore` berulang tidak bisa
membakar kuota); verifikasi S9 (pengguna di batas suka yang
mendorong 30x tidak memindai melebihi ambang baca yang
ditetapkan, batas total tetap ditegakkan); verifikasi R20
(generasi berubah selama `applySyncedEqSettings` lalu
`setEnabled` tidak dipanggil); verifikasi R19/I20 bila ditutup;
plus audit permukaan baru apa pun yang mendarat sesudah P9.
