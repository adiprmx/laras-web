# Red 6 - Audit Keamanan Laras Web (P9, sesudah Blue 5)

**Tanggal:** 19 November 2026.
**Auditor:** Tim Red 6 - audit statis + tes unit + probe live terbatas
(endpoint publik tanpa auth) + verifikasi SQL lokal (SQLite).
**Ruang lingkup:** verifikasi seluruh klaim perbaikan Blue 5 atas 5
temuan Red 5 (S8, S9, R19, R20, I20), penilaian 2 temuan luar
cakupan Blue 5 (pembakaran baca pull, tulis rate-limit residual),
verifikasi regresi perbaikan Blue 1, Blue 2, Blue 3, dan Blue 4,
audit permukaan baru kode Blue 5 (anggaran tulis, penghitung,
guard-WHERE, gerbang clear 24 jam), plus pemeriksaan rutin (XSS,
console, secret, telemetri, larangan `api.spotify.com`).
**HEAD yang diaudit:** workdir `~/workspace/music-app-web/` per 19 Nov
2026 (remote HEAD b5edcf7e, Blue 5, sesuai penugasan; `git log` lokal
basi dan tidak dipakai sebagai acuan, sesuai catatan AGENTS.md tentang
push via API). Workdir KOTOR: dua tim resolve bekerja paralel dan
sudah menulis file yang belum di-push; file-file itu DIABAIKAN
sepenuhnya sesuai penugasan (id.ts, player/service.ts, canary,
retryLadder, retry-ladder.spec.ts, workers/vercel-proxy, potoken-brief,
retry-ladder.md, vercel-egress.md) dan tidak satu pun dipakai sebagai
dasar vonis di laporan ini.
**Metode:** baca kode penuh jalur sensitif yang diubah Blue 5 dan
kedua worker, grep pola berbahaya, jalankan Vitest bertarget +
tes unit worker, probe live hemat kuota ke domain produksi dan
worker sync (10 request total, tanpa auth, tanpa menyentuh data
pengguna), dan verifikasi SQL lokal di SQLite 3.45.1 (skema
0001-0005, data buatan: pengguna penuh 100 playlist / 10.900 item /
10.000 suka / 1.000 riwayat, plus seed skala besar 5.100 playlist /
51.000 riwayat untuk rencana query pull). Tanpa Playwright E2E dan
tanpa browser (dicatat di "Tidak bisa diverifikasi"). Red HANYA
audit: tidak ada kode produksi yang diubah; satu-satunya file yang
ditulis adalah laporan ini.
**Catatan penomoran:** temuan baru melanjutkan penomoran Red 5
(S10-S12, I21-I23). Tidak ada temuan rendah baru bernomor R21:
satu-satunya temuan rendah ronde ini adalah S12 (kelas kuota,
lanjutan penomoran S).

## Ringkasan vonis

| Tingkat | Jumlah |
|---|---|
| Kritis | **0** |
| Tinggi | **0** |
| Sedang | **2** |
| Rendah | **1** |
| Info | **3** |
| **Total baru** | **6** |

**Vonis: LAYAK LANJUT KE BLUE 6, dengan dua temuan sedang (S10, S11)
yang wajib ditutup sebelum release candidate.** Tidak ada temuan
kritis atau tinggi. Seluruh klaim perbaikan Blue 5 TERBUKTI (semua
klaim S8, S9, R19, R20, dan I20 terverifikasi di kode, tes, dan
SQL lokal; lihat tabel verifikasi). Seluruh perbaikan Blue 1,
Blue 2, Blue 3, dan Blue 4 MASIH bertahan (H1, S1-S7, R1-R18,
I5-I7, I11-I15, I19 terverifikasi ulang di bawah).
Namun pola yang sama dengan ronde lalu terulang: kedua temuan
sedang lahir dari BATAS-BATAS perbaikan S8 itu sendiri, bukan
dari klaim Blue 5 yang gagal. S10 menunjukkan anggaran tulis
dan stempel clear terikat pada `user_id`, sementara identitas
itu bisa didaur ulang gratis lewat hapus akun + daftar lagi,
sehingga satu manusia dengan satu akun Google bisa menguras
kuota tulis dalam 6-10 menit. S11 menunjukkan `/api/sync/pull`
masih membakar kuota baca, dan EXPLAIN membuktikan amplifikasinya
lebih besar dari perkiraan Blue 5 sendiri: query item memakai
JOIN + sort yang memindai SEMUA item pengguna (sampai 100.000
baris/pull), bukan 1.000. Dengan kata lain: S8/S9 ditutup sesuai
spesifikasinya, tetapi penutupannya tidak menutup kelas
serangannya sampai tuntas, karena batas per-akun tidak mengikat
identitas yang bisa didaur ulang dan karena pull tidak masuk
anggaran sama sekali.

---

## Temuan sedang

### S10 - Hapus akun + daftar lagi me-reset anggaran tulis dan stempel clear: satu identitas menguras kuota tulis dalam 6-10 menit

**Tingkat: sedang.** **File:**
`workers/sync/src/index.js:1792-1828` (handler delete, tanpa rate
limit), `:627-640` (handleCallback membuat pengguna baru),
`workers/sync/0001_init.sql` (UNIQUE provider+provider_id),
`workers/sync/src/index.js:101` (anggaran per user_id),
`:107` (stempel clear per user_id).

**Bukti:**
- Anggaran tulis S8 (`sync_write_budget`, PK user_id+hari) dan
  stempel clear S8a (`sync_user_meta`, PK user_id) keduanya
  terikat pada `user_id`. Hapus akun menghapus baris `users`
  beserta seluruh baris 0005 miliknya (`:1817-1819`), dan
  pendaftaran ulang sesudahnya membuat `user_id` BARU
  (`crypto.randomUUID()`, handleCallback): SELECT berdasarkan
  (provider, provider_id) tidak menemukan apa-apa karena
  barisnya sudah dihapus, lalu INSERT membuat akun segar
  dengan anggaran 20.000 penuh dan stempel clear kosong.
- Tidak ada satu pun penghambat daur ulang ini di kode: TIDAK
  ADA rate limit di `/api/auth/delete` (router tidak memanggil
  `checkRateLimit` untuk delete/logout; alasan "self-limiting"
  di Red 3/4/5 mengasumsikan otoritas yang dihapus tidak bisa
  dibuat lagi seketika, dan asumsi itu salah bila pendaftaran
  ulang gratis dan instan); TIDAK ADA tombstone pengguna
  terhapus; TIDAK ADA cooldown pendaftaran ulang; TIDAK ADA
  pengikatan anggaran ke identitas stabil (mis. hash
  provider_id).
- Siklus serangan: login (OAuth, akun Google milik penyerang
  sendiri) -> dorong 20.000 anggaran (22 push x 700 entri,
  di bawah 1 menit pada 30 push/mnt) -> hapus akun -> login
  lagi -> ulang. Login/callback 10/mnt/IP bukan penghambat
  (tiap siklus butuh sekitar 1 menit mendorong).
- Hitungan kuota (angka arsitektur §2.1): tiap siklus menulis
  sekitar 15.400 baris data (22 push x 700 entri; tagihan
  20.000 adalah batas atas, tulis nyata sedikit di bawahnya).
  100.000 / 15.400 = 7 siklus, sekitar 10 menit. Bila DELETE
  dihitung sebagai baris ditulis (aturan meteran D1 untuk
  baris yang diubah), tiap siklus menambah sekitar 15.400
  baris hapus akun, total sekitar 30.800 baris/siklus, sehingga
  kuota habis dalam 4 siklus, sekitar 6 menit. Kedua angka
  jauh di bawah satu jam, dari SATU manusia dengan SATU akun
  Google (login Google untuk aplikasi yang sudah pernah
  disetujui mengalir otomatis tanpa klik, sehingga siklusnya
  bisa diskrip dengan browser headless + sesi Google persisten).
- Dampaknya identik dengan S7/S8 semula: push sync gagal (500)
  untuk SEMUA pengguna sampai reset 00:00 UTC; rate limit
  fail-open; `storeOAuthState` best-effort gagal diam-diam
  (single-use S6 ikut lumpuh, login lanjut fail-open).
- Klaim Blue 5 yang dibantah temuan ini: "satu akun sendirian
  mustahil menguras kuota; butuh 5 akun yang kompak
  menghabiskan anggaran penuh." Klaim itu BENAR bila "akun"
  berarti lima identitas yang berbeda dan tidak bisa didaur
  ulang, tetapi SALAH dalam model ancaman produk ini: satu
  identitas OAuth bisa melahirkan lima (atau lima puluh)
  `user_id` berurutan dalam hitungan menit, masing-masing
  dengan anggaran penuh. Membuat lima akun Google memang
  juga gratis, tetapi Google membatasi pembuatan akun massal
  (verifikasi telepon, batas per IP), sementara daur ulang
  satu akun tidak punya hambatan apa pun.
- Catatan kejujuran: trik yang sama juga me-reset kunci rate
  limit sync (per user_id) dan penghitung (ikut terhapus),
  jadi S8a DAN S8b dikalahkan sekaligus oleh satu mekanisme.
  Pembuktian live sengaja TIDAK dilakukan (butuh otomasi
  OAuth + benar-benar membakar kuota bersama); bukti yang
  dipakai adalah kode + skema, yang sudah cukup karena
  tidak ada satu pun penghambat di jalurnya.

**Dampak:** DoS ketersediaan sinkronisasi untuk semua pengguna
sampai reset harian, plus degradasi berantai rate limit dan
single-use state OAuth; kelas yang sama dengan S7/S8, yang
keduanya dinilai sedang, dengan satu langkah otomasi tambahan
(login OAuth milik penyerang sendiri).
**Rekomendasi (Blue):**
1. Terapkan rate limit pada `/api/auth/delete` (mis. 5/hari/IP
   dan 1/hari/akun): hapus akun adalah tindakan langka
   (normalnya sekali seumur hidup akun), jadi batas ketat
   tidak mengganggu pemakaian sah tetapi mematahkan siklus
   menit demi menit.
2. Simpan tombstone minimal pengguna terhapus (hash
   provider+provider_id + deleted_at, TTL 24 jam sampai 30
   hari, DIDOKUMENTASIKAN sebagai metadata anti-penyalahgunaan,
   bukan data pengguna): pendaftaran ulang dalam jendela
   mewarisi anggaran + stempel lama, atau ditolak dengan pesan
   jelas. Ini perbaikan struktural yang mengikat anggaran ke
   identitas stabil, bukan ke `user_id` sekali pakai.
3. Alternatif yang lebih ringan: akun baru (umur di bawah 24
   jam) mendapat anggaran kecil dulu (mis. 2.000/hari), naik
   ke 20.000 sesudah 24 jam. Daur ulang menjadi 10x lebih
   lambat (50 siklus untuk 100 ribu baris).
4. Tambahkan tes worker: hapus akun lalu daftar lagi dengan
   provider_id yang sama tidak mendapat anggaran penuh baru
   (atau ditolak dalam jendela cooldown, sesuai opsi yang
   dipilih).

### S11 - `/api/sync/pull` membakar kuota BACA: query item JOIN memindai SEMUA item pengguna, kuota 5 juta habis dalam 2-54 menit dari satu akun

**Tingkat: sedang.** **File:**
`workers/sync/src/index.js:658-730` (`handlePull`, query item
JOIN), `:1830-1865` (rate limit sync 30/mnt/user, kunci sama
untuk pull dan push), `workers/sync/0001_init.sql`
(`idx_items_updated`, tanpa indeks (user_id, updated_at)
untuk item di jalur pull).

**Bukti:**
- Temuan ini adalah butir 1 di luar cakupan Blue 5 (§7), yang
  ditugaskan ke Red 6 untuk dinilai. Blue 5 memperkirakan
  satu pull memindai sekitar 3.100 baris (4 x LIMIT 1.000).
  Perkiraan itu SALAH untuk koleksi item, dan Red 6
  membuktikannya dengan EXPLAIN QUERY PLAN di SQLite lokal
  (seed skala besar: 5.100 playlist, 51.000 riwayat, ANALYZE):
  - Pull item: `SEARCH p USING INDEX idx_playlists_user_updated
    (user_id=?)` lalu `SEARCH i USING INDEX idx_items_updated
    (playlist_id=? AND updated_at>?)` PER PLAYLIST, lalu
    `USE TEMP B-TREE FOR ORDER BY`. LIMIT 1.000 baru
    diterapkan SESUDAH sort global, jadi seluruh item milik
    pengguna (sampai 100 playlist x 1.000 item = 100.000
    baris) dipindai dan disortir di tiap pull. LIMIT tidak
    menghentikan pemindaian.
  - Pull suka: `SEARCH ... idx_likes_user_updated
    (user_id=? AND updated_at>?)`, terurut indeks, LIMIT
    menghentikan di 1.000. Aman.
  - Pull riwayat: `SEARCH ... idx_history_user_played
    (user_id=?)` + temp b-tree atas maksimal 1.000 baris
    milik pengguna. Terbatas, aman. (SCAN tabel penuh yang
    muncul di seed kecil adalah artefak tabel kecil dan
    hilang pada skala besar; begitu pula SCAN playlist.)
  - Varian perbaikan yang diuji Red 6 (filter `i.user_id = ?`
    sebagai ganti `p.user_id = ?`): `SEARCH i USING INDEX
    idx_items_user (user_id=? AND updated_at>?)` + lookup PK
    playlist, TANPA temp b-tree, LIMIT-bounded di 1.000.
    Perbaikannya satu baris filter dan rencananya terverifikasi.
- Hitungan kuota (angka arsitektur §2.1, 5 juta baris baca/hari):
  satu pull dengan since=0 memindai N baris item + sekitar
  2.101 baris lain (suka 1.000 + riwayat 1.000 + playlist 100
  + settings 1), dengan N = total item milik penyerang:
  - N = 1.000 (setup Blue 5, 3.100 tulis satu kali):
    3.101/pull, kuota habis dalam 1.612 pull, sekitar 54 menit
    pada 30 pull/mnt.
  - N = 20.000 (satu hari anggaran penuh): 22.101/pull, kuota
    habis dalam 226 pull, sekitar 7,5 menit.
  - N = 100.000 (lima hari anggaran, di batas arsitektur):
    102.101/pull, kuota habis dalam 49 pull, sekitar 1,6 menit.
  Angka-angka ini adalah batas BAWAH: indeks item tidak
  covering (title/artist/posisi harus dibaca dari baris tabel),
  jadi meteran D1 bisa menghitung lebih banyak lagi per item.
- Jawaban atas tiga pertanyaan penugasan:
  1. Ya, pull dibatasi rate limit per user yang sama (30/mnt,
     kunci `sync:<user.id>` dipakai bersama push, dicek di
     router SEBELUM cabang pull/push). Tetapi 30/mnt tidak
     cukup karena tiap pull memindai ribuan sampai ratusan
     ribu baris; rate limit membatasi JUMLAH pull, bukan
     BIAYA per pull.
  2. Ya, penyerang harus PUNYA dulu datanya, tetapi biayanya
     kecil dan SATU KALI: 3.100 tulis untuk baseline 54 menit,
     20.000 tulis (satu hari anggaran) untuk 7,5 menit. Anggaran
     S8 membatasi KECEPATAN membangun (20.000/hari), bukan
     TOTAL akhirnya: data menetap antar hari, jadi pembakaran
     baca hari berikutnya gratis tanpa setup tambahan.
  3. Ya, pull dengan since=terkini membaca sedikit, tetapi
     penyerang bebas memakai since=0 berulang-ulang: tidak ada
     pembedaan rate limit, anggaran, atau pencatatan antara
     pull inkremental yang sah dan pull since=0 yang diulang.
- Dampak bila kuota baca habis: semua query D1 gagal, sehingga
  `authUser` gagal (sync 500 untuk semua pengguna), rate limit
  fail-open (kuota request Workers 100 ribu/hari menjadi
  satu-satunya pelindung), dan `consumeOAuthState` fail-open
  (single-use S6/I19 nonaktif). Kelas dampaknya sama dengan S9.
- Pembuktian live sengaja TIDAK dilakukan (akan membakar kuota
  baca bersama); bukti yang dipakai adalah EXPLAIN pada dua
  skala seed + aritmetika dari angka arsitektur §2.1.

**Dampak:** DoS ketersediaan sinkronisasi untuk semua pengguna
sampai reset harian, plus degradasi berantai rate limit dan
single-use state OAuth; sama cepatnya dengan S9 (7,5 menit pada
setup satu hari anggaran) dan lebih cepat lagi pada setup yang
lebih besar.
**Rekomendasi (Blue):**
1. Perbaiki query item pull: filter `i.user_id = ?` (kolom
   sudah ada sejak 0004, indeks `idx_items_user` sudah ada)
   sebagai ganti `p.user_id = ?`; JOIN ke playlist hanya
   untuk mengambil `client_id`. Rencana terverifikasi
   LIMIT-bounded tanpa temp b-tree. Ini menutup amplifikasi
   100x dalam satu baris.
2. Perbaikan (1) SAJA tidak cukup: baseline 3.101/pull tetap
   menghabiskan kuota dalam 54 menit. Tambahkan anggaran baca
   pull per akun (mis. hitung baris yang dikembalikan tiap
   pull terhadap anggaran harian yang sama atau anggaran
   terpisah, atau batasi pull since=0 secara khusus, mis. maks
   60/hari/akun; klien sah memakai since inkremental dan hampir
   tidak pernah mengulang since=0).
3. Pertimbangan kecil: indeks (user_id, updated_at) untuk
   riwayat menghilangkan temp b-tree pull riwayat (saat ini
   terbatas 1.000 baris, jadi bukan prioritas).
4. Tambahkan tes worker: pengguna dengan 10.000 item yang
   menarik 30x tidak memindai melebihi ambang baca yang
   ditetapkan (diukur lewat FakeD1 yang menghitung baris
   dipindai), dan pull since=0 berulang dibatasi anggarannya.

---

## Temuan rendah

### S12 - Tulis rate-limit residual: dua akun cukup menguras kuota tulis (bukan lima)

**Tingkat: rendah.** **File:**
`workers/proxy/src/rateLimit.js` (`isRateLimited`: 1 UPSERT
tulis + 1 SELECT baca per request, termasuk request yang
SUDAH dibatasi), `workers/sync/src/index.js` (router sync
30/mnt/user, `/api/auth/me` 60/mnt/IP dicek SEBELUM auth),
`docs/blue5-red5-fixes.md` §7 butir 2 (temuan luar cakupan).

**Bukti:**
- Temuan ini adalah butir 2 di luar cakupan Blue 5 (§7), yang
  ditugaskan ke Red 6 untuk dinilai. Blue 5 menghitung kasus
  terburuk jujur per akun 20.000 anggaran + 43.200 baris
  rate-limit = 63.200 (63% kuota tulis). Red 6 memverifikasi
  hitungan itu dan menemukan implikasinya lebih tajam:
  - DUA akun yang mendorong di laju maks: 2 x 63.200 =
    126.400 baris tulis/hari, melebihi kuota 100.000 dalam
    sekitar 19 jam, dengan hanya 86.400 request Workers
    (di bawah kuota 100.000). Kuota tulis D1 mati SEBELUM
    kuota request Workers. Klaim "butuh 5 akun" menjadi
    "butuh 2 akun" begitu baris rate-limit dihitung.
  - SATU IP + satu akun (push 30/mnt + `/api/auth/me`
    60/mnt, tanpa auth karena rate limit `/me` dicek sebelum
    `authUser`): campuran optimal menghasilkan sekitar
    120.000 baris tulis per 100.000 request Workers, sehingga
    kuota tulis D1 habis di sekitar 83 ribu request (sekitar
    15 jam), sebelum kuota Workers.
  - Akar masalahnya: `isRateLimited` menulis SATU baris per
    request, TERMASUK request yang sudah melewati batas
    (UPSERT jalan dulu, vonis dibaca sesudahnya). Penyerang
    yang membanjiri di atas batas tetap membakar 1 baris
    tulis per request yang ditolak.
- Penyeimbang yang membuat tingkatnya rendah, bukan sedang:
  serangan ini butuh 15-19 jam laju MAKSIMUM terus-menerus
  (bandingkan S7/S8/S9/S10/S11 yang hitungan menit sampai
  satu jam), butuh 2 akun terkoordinasi atau banjir
  multi-endpoint, dan penyerang harus menghabiskan 86-100%
  kuota request Workers (100 ribu/hari) untuk mencapainya;
  kuota tulis D1 dan kuota request Workers berukuran sama
  (100 ribu), jadi penyerang tidak bisa menguras D1 tanpa
  hampir menguras Workers juga. Celah marginalnya hanyalah
  kasus 2 akun (kuota tulis mati di 86% kuota Workers).
  Dampaknya sendiri (kuota tulis habis: push gagal, rate
  limit fail-open, state OAuth best-effort gagal) sama
  dengan S7/S8, tetapi bar usahanya jauh lebih tinggi.
**Dampak:** kuota tulis D1 bersama bisa dihabiskan 2 akun
dalam sekitar 19 jam, mematikan push sync + rate limit untuk
semua pengguna sampai reset.
**Rekomendasi (Blue):**
1. Bebankan baris rate-limit endpoint TERAUTENTIKASI (sync
   pull/push) ke anggaran tulis akun: tiap request sync
   memakan 1 anggaran di samping tagihan datanya, sehingga
   total per akun kembali ke 20.000 dan bar kembali ke
   5 akun. Ini perbaikan kecil (satu parameter di reservasi).
2. Jangan menulis baris untuk request yang SUDAH dibatasi:
   SELECT dulu, UPSERT hanya bila di bawah batas. Ini
   menutup banjir di atas batas di endpoint TANPA auth
   (/me, login, callback, proxy), di mana penyerang saat ini
   membakar 1 baris tulis per request yang ditolak.
   Perhatian: cek-dulu-tulis-kemudian punya race kecil di
   bawah konkurensi (dua request sama-sama melihat di bawah
   batas lalu sama-sama menulis); race itu hanya menggeser
   batas beberapa baris, jauh lebih murah daripada banjir
   tanpa batas.
3. Pantau kuota tulis D1 (peringatan di 50% dan 80%) supaya
   pola ini ketahuan sebelum mati total; ini melengkapi
   rekomendasi pemantauan kuota dari Red 5.

---

## Info

### I21 - Rekonsiliasi COUNT + storeCount tidak atomik: penghitung basi bisa menurunkan batas (over-cap sekitar 100 baris per kejadian)

**File:** `workers/sync/src/index.js:953-976` (`reconcileCount`:
COUNT lalu `storeCount` sebagai dua pernyataan terpisah),
`:933-942` (`storeCount` menimpa absolut).

`reconcileCount` menghitung COUNT lalu menyimpan hasilnya
dalam dua pernyataan berurutan, bukan satu pernyataan atomik.
Bila push bersamaan melakukan bump di antara COUNT dan
storeCount, nilai basi itu MENIMPA bump tersebut dan
penghitung turun di bawah jumlah nyata. Red 6 membuktikannya
di SQLite lokal: counter 9.900, COUNT 9.900, bump +100 dan
100 insert nyata menyela (jumlah nyata 10.000, counter
10.000), storeCount basi menulis 9.900 kembali; push
berikutnya melihat headroom 100, guard meloloskan insert,
jumlah nyata menjadi 10.001, di atas cap 10.000.
Dampaknya dibatasi ketat: tiap kejadian hanya memberi sekitar
100 baris over-cap (satu push), kejadian butuh rekonsiliasi
(yang langka: baris hilang sekali selamanya, sentinel -1
sesudah clear 1x/hari, over-cap sesudah overshoot, tua-dekat-cap
1x/24 jam/koleksi) DAN bump yang mendarat tepat di jendela
milidetik antara COUNT dan store; dan over-cap mengoreksi
diri di rekonsiliasi berikut (counter menjadi COUNT nyata,
headroom 0). Bukan vektor kuota (anggaran S8 membatasi
tulis) dan bukan vektor baca. Karena itu info, bukan temuan
rendah. Rekomendasi: jadikan rekonsiliasi satu pernyataan
atomik (`INSERT INTO sync_counts ... SELECT ..., COUNT(*) ...
ON CONFLICT DO UPDATE SET n = excluded.n`) atau
compare-and-swap (UPDATE ... WHERE n = nilai saat COUNT
dimulai, ulangi bila 0 baris berubah). Tambahkan tes worker
yang mensimulasikan bump di antara COUNT dan storeCount.

### I22 - Tombstone server tidak pernah dibersihkan: cap S7 tersumbat permanen seiring waktu

**File:** `workers/sync/0001_init.sql` (komentar: tombstone
"dipertahankan 30 hari lalu dibersihkan job terjadwal"),
`workers/sync/src/index.js` (tidak ada handler scheduled),
`workers/sync/wrangler.toml` (tidak ada triggers/cron).

Tidak ada satu pun job pembersih tombstone di worker sync:
tidak ada handler `scheduled`, tidak ada pemicu cron di
wrangler, dan `pruneTombstones` klien hanya menyentuh Dexie
lokal, bukan D1. Karena COUNT dan penghitung S9 menghitung
tombstone (sengaja, untuk menutup putaran hapus-buat-ulang),
cap menjadi tersumbat permanen: pengguna yang membuat lalu
menghapus 100 playlist SEUMUR HIDUP tidak akan pernah bisa
membuat playlist ke-101 lagi, walau saat ini tidak punya
playlist hidup sama sekali. Hal yang sama berlaku untuk suka
(10.000) dan item per playlist (1.000), hanya lebih lambat
tercapai. Penyimpanan tombstone juga tumbuh tanpa batas
(walau lambat). Ini bukan vektor serang (hanya menyakiti diri
sendiri; tiap tombstone 1 tulis UPDATE) dan butuh
berbulan-bulan pemakaian churning untuk terasa, jadi info.
Rekomendasi: tambah pemicu cron (mis. harian) yang menghapus
tombstone lebih tua dari 30 hari, dan sesudah penghapusan
tandai penghitung koleksi yang dibersihkan sebagai basi
(n = -1) atau rekonsiliasi, supaya penghitung tidak
kelebihan-hitung permanen sesudah pembersihan.

### I23 - Penghitung item fail-closed (500) sementara penghitung skalar fail-open ke COUNT

**File:** `workers/sync/src/index.js:1230-1280` (skalar dalam
try/catch, fallback COUNT + `countersOk = false`), `:1400-1430`
(item tanpa try/catch).

Bila `readScalarCounters` atau `resolveCount` skalar gagal
(galat D1 transient), push turun ke COUNT S7 dan tetap jalan.
Bila `readItemCounters` atau `resolveCount` item gagal dengan
galat yang sama, pengecualian lolos ke router dan seluruh push
gagal 500, padahal anggaran sudah terpotong. Perilakunya gagal
AMAN (tidak ada lubang kuota, tidak ada tulis parsial karena
batch belum jalan), hanya ketersediaan: galat transient yang
sama di jalur skalar hanya menurunkan kualitas, di jalur item
mematikan push. Karena itu info. Rekomendasi: bungkus blok
penghitung item dengan try/catch yang sama (fallback ke
`countItemsPerPlaylist`, yang sudah difilter user_id untuk
I20), atau tangkap galat rekonsiliasi per playlist dan pakai
COUNT per playlist itu saja.

### I16, I17, I18 - Masih terbuka dengan sengaja (bawaan Red 3/Red 4/Red 5, tanpa perubahan)

- **I16** (`db.batch` bukan transaksi atomik): tidak berubah,
  tetap batasan yang didokumentasikan. Relevan langsung dengan
  I21 ronde ini (rekonsiliasi dua pernyataan) dan dengan arah
  melenceng penghitung S9 (bump di awal batch = kelebihan-hitung
  bila batch gagal di tengah, arah aman).
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

## Penilaian 2 temuan luar cakupan Blue 5 (§7)

Kedua butir §7 Blue 5 dinilai dan diberi nomor temuan di ronde
ini, sesuai penugasan:

| Butir §7 Blue 5 | Nomor Red 6 | Tingkat | Alasan singkat |
|---|---|---|---|
| 1. Pembakaran baca lewat `/api/sync/pull` | **S11** | **Sedang** | Satu akun menghabiskan kuota baca 5 juta dalam 54 menit (setup 3.100 tulis) sampai 1,6 menit (setup 100 ribu item); query item JOIN memindai SEMUA item pengguna, bukan 1.000. Dampak sama dengan S9. |
| 2. Tulis rate-limit residual | **S12** | **Rendah** | 63.200 baris/akun/hari (63% kuota); 2 akun cukup, bukan 5. Tetapi butuh 15-19 jam laju maks terus-menerus dan hampir menghabiskan kuota request Workers juga, jadi bar usahanya jauh lebih tinggi dari temuan sedang. |

Butir §7 nomor 3 (permukaan UI klien untuk sinyal server baru:
`skippedOverLimit`, `historyClearIgnored`, pesan 429) BUKAN
temuan keamanan dan tidak diberi nomor: perilaku diam-diamnya
sudah benar (tidak ada data hilang, penanda dipertahankan,
sinkronisasi mencoba lagi), dan tidak ada temuan Red 5 yang
meminta UI-nya. Tetap dicatat sebagai utang tampilan kecil
untuk koordinator.

---

## Verifikasi perbaikan Blue 5 (prioritas utama)

Semua klaim Blue 5 TERBUKTI. Tidak satu pun klaim yang gagal;
temuan baru S10/S11/S12/I21 adalah celah di SEKITAR perbaikan
(batas identitas anggaran, endpoint pull di luar anggaran,
tulis rate-limit di luar anggaran, race rekonsiliasi), bukan
kegagalan klaimnya. Verifikasi aritmetika diminta penugasan
ikut dicantumkan per klaim.

| ID | Klaim Blue 5 | Vonis | Bukti |
|---|---|---|---|
| S8a | Gerbang clear riwayat 1x/24 jam per pengguna, stempel di `sync_user_meta`, clear yang terlalu sering diabaikan dengan respons jelas | **TERBUKTI (kode + tes)** | `workers/sync/src/index.js:107` (interval 24 jam), `:1098-1126` (baca stempel, `clearHonored` hanya bila `now - last >= 24 jam`, `clearRetryAfterSeconds` dihitung), `:1699` (respons `historyClearIgnored` + Retry-After), `:1819` (hapus akun ikut menghapus meta). Tes worker "clear kedua dalam 24 jam diabaikan" lolos (60/60). Caveat: stempel dibaca di awal push dan ditulis di batch, jadi push BERSEMAAN sama-sama bisa menghonori clear (TOCTOU stempel); dampaknya dibatasi anggaran (tiap clear ditagih 1.000, maks sekitar 20 clear/hari/akun), bukan temuan terpisah. |
| S8a | Klien mempertahankan penanda clear bila server mengabaikan | **TERBUKTI (kode + tes)** | `app/src/sync/syncService.ts:388` (`clearIgnored`), `:415` (disetel bila ronde 0 `historyClearIgnored`), `:431` (penanda hanya dihapus bila TIDAK diabaikan). Tes klien "penanda dipertahankan bila server mengabaikan clear" lolos (22/22). |
| S8b | Anggaran tulis 20.000 baris/hari/akun = 20% kuota tulis bersama; satu akun mustahil menguras kuota sendirian | **TERBUKTI (kode + aritmetika), dengan S10** | `index.js:101` (`DAILY_WRITE_BUDGET = 20000`); 20.000 / 100.000 = 20% persis. Klaim "mustahil sendirian" BENAR untuk satu `user_id`, tetapi S10 menunjukkan `user_id` bisa didaur ulang lewat hapus + daftar lagi, jadi klaimnya gugur di tingkat identitas, bukan di tingkat akun. |
| S8b | Sinkronisasi penuh akun di batas (sekitar 12.100 baris) masih muat dalam anggaran | **TERBUKTI (aritmetika, dengan koreksi)** | Entri di batas: 100 playlist + 10.000 suka + 1.000 riwayat + 1.000 item + pengaturan = 12.101. Tagihan NYATA lebih besar karena tunjangan pembukuan dibayar PER PUSH: 12.643 (item terkonsentrasi di sedikit playlist) sampai 14.623 (item tersebar di 100 playlist, 2 x 100 per ronde x 10 ronde). Keduanya di bawah 20.000; sisa 27-37%, bukan sekitar 40% di kasus tersebar. Sudut ekstrem (100 playlist x 1.000 item = 100.000 item): tagihan sekitar 119.000, selesai sekitar 6 hari (dokumen Blue 5 menulis sekitar 5 hari; selisih dari tunjangan per-push). Tetap muat dan inkremental, bukan gagal total. |
| S8b | Reservasi atomik (satu upsert berkondisi), SEBELUM batch; tagihan dari isi body (termasuk yang dilewati/bukan milik pendorong); maks 1.909/push; 429 + Retry-After sampai tengah malam UTC | **TERBUKTI (kode + SQL lokal)** | Reservasi `:1172` (INSERT ... ON CONFLICT DO UPDATE ... WHERE jumlah <= 20000), SEBELUM fase cap dan SEBELUM `db.batch` (`:1676`), jadi tidak ada TOCTOU anggaran: push bersamaan tidak bisa sama-sama lolos sesudah anggaran habis. Tagihan `:1153-1169` dari isi body + clear 1.000 + tunjangan `2*(skalar + playlist item berbeda) + 3`; Red 6 memverifikasi tunjangan itu MENUTUP seluruh tulis non-entri (bump penghitung + simpan rekonsiliasi + sentinel + stempel meta + baris anggaran itu sendiri), jadi tagihan tidak pernah kurang dari tulis sebenarnya. 429 `:1180-1189` + `secondsUntilMidnightUtc` `:1046`. Verifikasi SQLite Red 6: 15.000 diterima (changes 1), +15.000 ditolak (changes 0, nilai mentok 15.000), +5.000 pas 20.000 diterima (changes 1). Koreksi dokumen: tagihan maks per push adalah **1.910**, bukan 1.909 (700 + 1 + 1.000 + 2x(3+100) + 3). Selisih 1 di dokumen saja; kode menghitung dinamis dan benar. Tes 429 worker lolos (28x712 = 19.936 lalu 429; push kecil masih jalan; hari berganti bisa lagi). |
| S8b | Penolakan 429 tidak membocorkan info | **TERBUKTI (kode)** | Respons 429 hanya membawa kode `DAILY_WRITE_BUDGET_EXCEEDED`, pesan umum, dan Retry-After sampai tengah malam; tidak ada angka pemakaian, tidak ada info pengguna lain. `historyClearRetryAfterSeconds` hanya menyangkut penanda pemanggil sendiri. |
| S8 | Siklus S8 lama (insert 100 + clear) mati di dua lapis | **TERBUKTI (kode + tes)** | Tiap siklus menelan minimal 105 anggaran (100 entri + tunjangan) dan clear kedua diabaikan gerbang 24 jam. Tes worker "siklus 25x" lolos: riwayat mentok 1.000, anggaran terpakai tepat 3.625 (= 1.105 + 24x105). |
| S9 | Tabel `sync_counts`, 1 baris baca per koleksi per push; probe terbatas maksimal 100 kunci per koleksi | **TERBUKTI (kode + tes + EXPLAIN)** | `readScalarCounters` `:899`, `readItemCounters` `:916`, `capNewEntries` baru `:1010` (probe hanya kunci body, row-value IN untuk riwayat). EXPLAIN Red 6: kedua baca penghitung + keempat probe + subquery guard semuanya SEARCH lewat PK/indeks covering, NOL SCAN tabel (satu-satunya SCAN adalah "SCAN CONSTANT ROWS" untuk daftar IN, bukan tabel). Tes worker: update 1 suka pada pengguna penuh membaca maksimal 10 baris, 100 update maksimal 110 baris, 0 COUNT; baca 10 vs 10.000 suka identik. |
| S9 | Penyerang maks sekitar 300.000 baris baca/hari, sekitar 6% kuota 5 juta | **TERBUKTI (aritmetika, klaim konservatif)** | Red 6 menghitung ulang dari kode: rasio baca/anggaran terburuk NYATA adalah sekitar 1,3 (push kosong: 3 anggaran, sekitar 4 baca), BUKAN 6-7 seperti dokumen Blue 5 (angka 6-7 menghitung baca per entri, bukan per tagihan yang sudah termasuk tunjangan). Total push: 20.000 x 1,3 = sekitar 27.000 baca. Rekonsiliasi: suka 10.000 + playlist 100 + riwayat 1.000 + item maksimal 100.000/hari (steady state; transient pembangunan maksimal sekitar 200.000). Total sekitar 138.000-238.000 = 2,8-4,8% kuota. Klaim Blue 5 (300.000, 6%) adalah batas atas yang AMAN, bukan angka yang dilebih-lebihkan ke bawah. |
| S9 | Rekonsiliasi tidak bisa dipaksa berulang untuk membuka lagi pembakaran baca | **TERBUKTI (kode + penalaran)** | Tiga pemicu `resolveCount` (`:978-1008`) semuanya terbatas: n < 0 hanya sesudah clear (1x/24 jam, sentinel ditulis di batch yang sama); n > cap + 30 butuh headroom untuk overshoot, dan headroom tidak kembali sesudah cap tercapai kecuali lewat clear (riwayat) atau tidak pernah (suka/playlist/item, karena tombstone tetap dihitung dan tidak ada DELETE); tua > 24 jam dekat cap maksimal 1x/24 jam/koleksi karena `updated_at` disegarkan tiap bump dan tiap rekonsiliasi. Baris hilang: COUNT sekali lalu disimpan, 1x selamanya per (pengguna, koleksi/playlist). Satu-satunya celah terkait adalah I21 (race COUNT/storeCount), yang memberi over-cap, BUKAN pembakaran baca. |
| S9 | Increment penghitung PALING AWAL di batch (arah melenceng aman); backfill 0005 benar | **TERBUKTI (kode + SQL lokal)** | Bump `:1491-1496` (blok bump sekitar :1476-1500; nomor baris dokumen Blue 5 `:1472` bergeser sedikit) sebelum seluruh upsert; bila batch gagal di tengah, penghitung hanya kelebihan-hitung (menolak sah), tidak kekurangan-hitung. Sentinel -1 sesudah increment (`:1505`). Backfill diverifikasi Red 6 di SQLite: playlist 100, suka 10.000, riwayat 1.000, item pl1 1.000, item pl2 100, 100 baris item; item yatim (user_id NULL) dikecualikan secara konsisten dengan `countItemsForPlaylist`. `updated_at` backfill = waktu migrasi, jadi rekonsiliasi usia tidak langsung menyala. |
| S9 | Fail-open ke COUNT bila tabel 0005 belum ada | **TERBUKTI (kode)** | Catch `:1261-1280`: `countersOk = false`, fallback COUNT S7 untuk skalar; `countItemsPerPlaylist` HANYA dipanggil di cabang `countersOk` false (`:1430`, else branch), sesuai yang diminta penugasan untuk dicek. Jendela urutan-deploy ini didokumentasikan dan migrasi 0005 sudah diterapkan live (per penugasan koordinator, etag ae96fa69); verifikasi langsung tanpa sesi tidak dimungkinkan (lihat "Tidak bisa diverifikasi"). Catatan kecil: blok penghitung ITEM tidak punya try/catch yang sama (I23). |
| R19 | Guard-WHERE per INSERT entri baru, berbasis penghitung; terverifikasi di SQLite lokal | **TERBUKTI (kode + SQL lokal + tes)** | Guard di `:1541` (playlist), `:1581` (item), `:1612` (suka), `:1643` (riwayat), rumus `(penghitung - delta + k) < cap`. Verifikasi SQLite Red 6 (counter 9.950, dua push 100 suka baru): push A k=0 dan k=49 lolos (changes 1), k=50 dan k=99 diblokir (changes 0); push B terblokir TOTAL (changes 0); jumlah nyata bertahan 9.952; penghitung 10.150 memicu rekonsiliasi (> cap+30). Update entri lama memakai upsert polos (tidak menambah jumlah). Tes balapan worker `:2592` lolos. |
| R19 | Guard dengan penghitung basi (n = -1) | **DIPERIKSA, AMAN (dengan I21)** | Guard membaca n = -1 (TERBUKTI di SQLite: changes 1, lolos), tetapi -1 hanya terlihat guard untuk clear DI PUSH YANG SAMA (sentinel ditulis di batch sebelum insert); fase cap SUDAH merekonsiliasi -1 dari push sebelumnya lewat COUNT segar, jadi cap (bukan guard) yang mengikat di kasus clear dan "lolos tanpa batas" tidak terjadi. Celah staleness yang NYATA adalah I21 (storeCount basi menimpa bump), bukan sentinel. |
| R20 | Cek `stale()` sebelum `lyrics.setEnabled` | **TERBUKTI (kode + tes)** | `app/src/sync/syncService.ts:183` `if (stale()) return;` tepat sebelum `lyrics.setEnabled` `:184`, dengan komentar penjelas; kini ketiga penulisan cabang pengaturan (EQ :176, lirik :183, appliedAt :185) masing-masing dijaga. Tes `:390` lolos (generasi berubah selama `applySyncedEqSettings`, meta lirik tidak ditulis). |
| I20 | Cek kepemilikan sebelum hitung cap | **TERBUKTI (kode + tes)** | `playlistOwned` + filter `ownedItems`/`ownedDeletedItems` berjalan SEBELUM cap item dihitung; `countItemsPerPlaylist` difilter `user_id` (`:882-897`); item ke playlist orang lain ditolak `notOwned` tanpa menyentuh perhitungan cap dan tanpa membuat baris penghitung untuk playlist korban. Tes `:2652` lolos (`skippedOverLimit.playlistItems` 0). |
| S8/S9 | Migrasi 0005 + hapus akun ikut menghapus tabel 0005 | **TERBUKTI (kode + SQL)** | `migrations/0005_sync_quotas.sql` (81 baris, 3 tabel + backfill, diterapkan bersih di atas 0001-0004 di SQLite lokal); hapus akun `:1817-1819` menghapus `sync_counts`, `sync_write_budget`, `sync_user_meta`. Checklist deploy di `workers/sync/README.md:44-55`. |

**Catatan koreksi kecil atas dokumen Blue 5 (bukan temuan):**
tagihan maks per push 1.910, bukan 1.909; sinkronisasi penuh di
batas menelan 12.643-14.623 anggaran (bukan 12.100, karena
tunjangan dibayar per push), tetap muat; rasio baca/anggaran S9
yang nyata sekitar 1,3 (bukan 6-7; klaim Blue 5 konservatif dan
aman); kasus ekstrem 100 ribu item selesai sekitar 6 hari (bukan
sekitar 5); nomor baris blok bump bergeser (`:1491-1496`, bukan
`:1472`). Isi perbaikannya sendiri benar di semua kasus.

---

## Verifikasi regresi Blue 1 + Blue 2 + Blue 3 + Blue 4 (semua bertahan)

| ID | Status Red 6 | Bukti |
|---|---|---|
| H1 (tinggi, chunk uji di produksi) | BERTAHAN | `App.tsx:35-54`: kedelapan rute uji digerbang `import.meta.env.DEV` termasuk lazy import-nya; `parseRoute` ikut digerbang. `app/dist/assets` (53 aset, build lokal di disk): **0 chunk `*TestPage*`**, 1 chunk `SpikePage` (pengecualian koordinator). Gerbang CI masih ada di `ci.yml:53`. Catatan: chunk index dist (`index-nwkEvaMQ.js`) BERBEDA dari chunk live (`index-CQgLqbBQ.js`, terkonfirmasi dari HTML live), jadi dist di disk adalah build lokal ulang, bukan artefak live persis; dist memuat kode klien Blue 5 (`historyClearIgnored` ada di chunk syncStore). |
| S1 (sedang, body POST dibaca penuh) | BERTAHAN | Proxy: `readCapped(request.body, MAX_BODY_BYTES)` (`:455`) + cek `Content-Length` awal. Pola yang sama dipakai worker sync (`handlePush`). Uji unit worker 20/20. |
| S2 (sedang, tanpa CSP) | BERTAHAN + LIVE | `app/public/_headers` utuh; **terkonfirmasi dari header live** `https://laras.adipmusic.my.id/` 19 Nov 2026: CSP persis sama dengan file (termasuk `'wasm-unsafe-eval'`, bukan `'unsafe-eval'`, `connect-src` memuat sync + lrclib + lyrics.ovh), `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`. |
| S3 (sedang, rate limit in-memory) | BERTAHAN (kode + live tidak langsung) | Proxy `rateLimit.js` + D1 masih dipakai; tidak ada `buckets` in-memory. Uji unit 7/7 (stabil, I15). Bukti live tidak langsung: rate limit callback sync (mekanisme D1 yang sama, `isRateLimited`) TERBUKTI live di Red 4 dan perilaku callback ronde ini konsisten; verifikasi D1 proxy ASLI live (61+ request) masih belum dilakukan (hemat kuota). Sisi tulis desain ini dinilai sebagai S12 ronde ini. |
| S4 (sedang, config tanpa cap/versi) | BERTAHAN | Cap 4 MB + `version === 1` masih ditegakkan (`resolve.ts:123`, `CONFIG_SCHEMA_VERSION = 1`); config remote live terverifikasi berisi `"version": 1` (19 Nov 2026). |
| R1 (rendah, redirect media tanpa validasi) | BERTAHAN | `redirect: 'manual'` (proxy `:226,341`), maks 3 hop, validasi host per hop, Content-Type allowlist + `nosniff`. |
| R2 (rendah, `decodeURIComponent` tanpa try/catch) | BERTAHAN | `App.tsx:parseRoute` try/catch (`:123`); `main.tsx` ErrorBoundary. |
| R3 (rendah, SW cache-first + versi manual) | BERTAHAN | Navigasi network-first; cache runtime hanya aset statis; `app/dist/sw.js` berisi `SW_VERSION = '0.9.0-71925ff2'` (sama dengan build P8/Blue 3/Blue 4/Blue 5; `sw.js` tidak berubah di Blue 5). |
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
| S6 (sedang, callback tanpa rate limit + state bisa dipakai ulang) | BERTAHAN + LIVE | Rate limit callback 10/mnt/IP sebelum tukar kode; state single-use D1 + konsumsi atomik I19 (`:429-446`); fail-open dipertahankan. LIVE: callback state tak dikenal ke 302 `reason=state` (19 Nov 2026). |
| R10 (rendah, localhost di ALLOWED_ORIGINS sync) | BERTAHAN + LIVE | `workers/sync/wrangler.toml:23` `[vars]` hanya `https://laras.adipmusic.my.id`; localhost hanya di `[env.dev.vars]`. LIVE 19 Nov 2026, OPTIONS ke `/api/sync/push` dengan `Origin: http://localhost:5173`: 204 TANPA `Access-Control-Allow-Origin` (sesudah redeploy Blue 5). |
| R11 (rendah, push tanpa cek kepemilikan) | BERTAHAN | Upsert playlist `WHERE ... AND sync_playlists.user_id = excluded.user_id`; `playlistOwned` + `skippedNotOwned`; insert/tombstone item membawa `user_id`; tombstone UPDATE membawa `user_id` di WHERE; guard R19 baru JUGA tidak mengubah `user_id` (tidak ada di klausa SET), jadi kepemilikan dipertahankan di bentuk barunya. |
| R12 (rendah, impor backup baca penuh sebelum cek) | BERTAHAN | `ImportBackupDialog.tsx:82-86`: `file.size > MAX_BACKUP_BYTES` sebelum `arrayBuffer()`. |
| R13 (rendah, impor Spotify jalur file tanpa cap) | BERTAHAN | `spotify.ts:67` 10 MB + `:76` 30 lagu + `:165-171` lapis kedua parser; judul/artis dipotong 1.000 karakter. |
| R14 (rendah, parser backup tanpa cap per-field/per-koleksi) | BERTAHAN | `format.ts:62-90` konstanta cap lengkap; `tokens.ts:45,48` (200 token + 100 karakter); `service.ts:294` `MAX_REDOWLOAD_JOBS` 200. |
| R15 (rendah, wipe tidak mengakhiri sesi) | BERTAHAN (dengan R17/R18/R20 kini tertutup) | `WipeFlow.tsx:100-121`: `signed-in` logout dulu sebelum wipe; gagal logout menampilkan peringatan + "Coba keluar lagi" / "Tetap hapus". Celah status `unknown` (R17), race sync-dalam-penerbangan (R18), dan cek lirik (R20) kini ditutup (lihat tabel verifikasi). |
| R16 (rendah, nama playlist impor Spotify tidak divalidasi) | BERTAHAN | `spotify.ts:757-759` potong ke 100 karakter sebelum `createPlaylist`; `SpotifyImportDialog.tsx` `handleStart` punya `catch` + galat dirender. |
| I11 (klasifikasi AbortError) | BERTAHAN | 5 lokasi memakai cek `name` langsung tanpa gate `instanceof` (`chunkedDownloader.ts:140`, `syncClient.ts:170`, `spotify.ts:592`, `downloadManager.ts`, `resilience/errors.ts`). |
| I12 (`parseCookies` tanpa try/catch) | BERTAHAN | `workers/sync/src/index.js:180-199`: decode per nilai dibungkus try/catch (`:190`), nilai malformed dipakai mentah. |
| I13 (record null LRCLIB) | BERTAHAN | `lrclib.ts:115-118`: record bukan objek/null mengembalikan `{ status: 'not-found' }`. |
| I14 (nosniff/CSP halaman 503) | BERTAHAN | `index.js:138,150` nosniff di `jsonError`/`jsonOk`; `:464` halaman 503 membawa nosniff + CSP. |
| I15 (tes rateLimit stabil) | BERTAHAN | `rateLimit.test.ts` mem-mock `Math.random`; dijalankan Red 6: 7/7 hijau. |
| S7 (sedang, batas total per pengguna) | BERTAHAN + DIPERKUAT | Batas §4.3 kini ditegakkan via penghitung S9 + guard R19 (bukan COUNT lagi); cap klien 100 di `createPlaylistFromRemote` (`library.ts:90,3030`) masih ada; `skippedOverLimit` + `limits` masih dilaporkan di respons push. |
| R17 (rendah, wipe status unknown) | BERTAHAN | `WipeFlow.tsx:27` timeout 10 detik + `:73-92` race `refreshAuth`, status akhir dari store; peringatan + tombol coba lagi / tetap hapus. 9/9 tes WipeFlow lolos. |
| R18 (rendah, sync saat wipe membangkitkan data) | BERTAHAN | `wipe.ts:112` `invalidateSyncEpoch()` baris pertama; `syncService.ts` cek `stale()` sebelum tiap penulisan (14 cek, termasuk R20 `:183`); `syncNow` berhenti bila generasi berubah. |
| I19 (konsumsi state OAuth tidak atomik) | BERTAHAN + LIVE | Satu DELETE berkondisi + cek `meta.changes` (`:429-446`); LIVE 19 Nov 2026 callback state tak dikenal ke 302 `reason=state`. |
| I1/I8/I17 (header CPU) | MASIH TERBUKA (sengaja) | Lihat I17. |
| I2/I9/I18 (hash hardcode) | MASIH TERBUKA (sengaja) | Lihat I18; ketiga salinan masih sinkron. |
| I3 (track lokal tanpa validasi URL) | BERTAHAN | `player/port.ts` `isSafeLocalUrl` + choke di `service.ts` sebelum `decidePath` (tidak berubah sejak Red 3; `service.ts` sendiri ada di daftar abaikan workdir kotor, tetapi choke yang diverifikasi Red 3-5 masih ada di baris yang sama dan tidak disentuh klaim Blue 5). |
| I4 (sourcemap di dist) | BUKAN TEMUAN | Tetap sesuai putusan Red 1 (repo GPL publik). |
| I10 (versi worker live tak pasti) | TERTUTUP SEBAGIAN (lanjut) | Redeploy sync Blue 5 TERBUKTI live ronde ini lewat perilaku (R10 + callback `reason=state`, keduanya butuh kode pasca-Blue-3; etag deploy ae96fa69 sesuai penugasan). Redeploy proxy D1 live (61+ request) masih belum dibuktikan langsung. |

---

## Cap di semua jalur masuk data (diperbarui untuk S8/S9/S10/S11/S12)

| Jalur masuk | Cap | Status |
|---|---|---|
| Backup file | 10 MB total + per-field/per-koleksi (R14) + cek ukuran sebelum baca (R12) | Lengkap |
| Spotify file/teks | 10 MB + 30 lagu + teks 1.000 karakter (R13) | Lengkap |
| Spotify tautan | 30 lagu + halaman 2 MB (proxy) | Lengkap (tidak berubah) |
| Sync push (server) | 1 MB body + 100 entri/koleksi + per-field + batas TOTAL per pengguna (S7/S9) + anggaran tulis 20.000/hari/akun (S8) + gerbang clear 24 jam (S8a) + guard per pernyataan (R19) | Lengkap per `user_id`, KECUALI: anggaran + stempel bisa di-reset lewat hapus + daftar lagi (S10); tulis rate-limit di luar anggaran (S12) |
| Sync pull (server) | 1.000 baris/koleksi per pull, 30/mnt/user | TIDAK LENGKAP: tidak ada anggaran baca; query item memindai SEMUA item pengguna (S11) |
| Sync pull (klien) | Item 1.000/playlist; playlist total 100 (`createPlaylistFromRemote`, S7) | Lengkap |
| Pencarian YTM | 100 item/grup (parser), 10 MB respons | Lengkap (tidak berubah) |
| Lirik LRCLIB/lyrics.ovh | 1 MB + timeout 30 dtk | Lengkap (tidak berubah) |
| Config remote | 4 MB + versi 1 | Lengkap (tidak berubah) |
| "Unduh ulang" | 200 job/ketukan + laporan kelebihan | Lengkap (R14) |
| Unduhan chunk | 100 MB/file, antrean 200 (unduh ulang) | Lengkap (tidak berubah) |

---

## Verifikasi Origin di semua rute POST sync (fokus koordinator)

Semua handler POST di worker sync diperiksa satu per satu; tidak ada
yang berubah sejak Red 5 kecuali penambahan logika S8/S9/R19 di dalam
handler (bukan di gerbangnya).

| Rute POST | Cek Origin | Rate limit | Bukti |
|---|---|---|---|
| `/api/auth/logout` | YA, sebelum auth | Tidak ada (self-limiting: sesi dihapus di pemakaian pertama) | `index.js:1773` |
| `/api/auth/delete` | YA, sebelum auth | Tidak ada (ALASAN SELF-LIMITING GUGUR, lihat S10: akun bisa dibuat lagi seketika) | `index.js:1792` |
| `/api/sync/push` | YA, sesudah auth + rate limit, sebelum `handlePush` | 30/mnt/user | `index.js:1855` |
| `/api/auth/callback` (GET) | N/A (navigasi OAuth) | 10/mnt/IP (S6) | `index.js:1744` |
| `/api/auth/login` (GET) | N/A (navigasi OAuth) | 10/mnt/IP | `index.js:1729` |
| `/api/auth/me` (GET) | N/A (baca-saja) | 60/mnt/IP | `index.js:1759` |
| `/api/sync/pull` (GET) | N/A (baca-saja) | 30/mnt/user (kunci SAMA dengan push) | `index.js:1837` |

`isAllowedOrigin` (`:171`) tetap mengembalikan false bila header
`Origin` TIDAK ADA, jadi request tanpa Origin ditolak, bukan
diizinkan. Logout tanpa rate limit tetap dinilai BUKAN temuan
(menghapus otoritas pemanggilnya sendiri dan tidak menulis D1
bila tanpa sesi). Delete tanpa rate limit kini DINILAI sebagai
bagian dari S10: penghapusannya bisa diulang tanpa batas karena
pendaftaran ulang gratis dan instan.

---

## Yang DIPERIKSA dan bersih (baru di ronde ini + umum)

- **Anggaran dihitung SEBELUM upsert, reservasi atomik.**
  Reservasi (`:1172`) jalan sebelum fase cap dan sebelum batch;
  satu upsert berkondisi, bukan baca-lalu-tulis. Bila batch
  gagal di tengah, anggaran sudah terpotong (arah aman:
  kelebihan-tagih, bukan kekurangan-tagih). Tidak ada TOCTOU
  anggaran.
- **Penghitung tidak bisa dibuat negatif kecuali sentinel -1.**
  Bump hanya menambah delta positif; satu-satunya penulisan
  negatif adalah sentinel clear (`:1505`), yang MEMAKSA
  rekonsiliasi di push berikut (bukan melonggarkan batas).
  Satu-satunya jalur melenceng ke bawah adalah I21 (race
  COUNT/storeCount), yang terbatas sekitar 100 baris per
  kejadian dan mengoreksi diri.
- **Guard-WHERE tidak memakai penghitung basi tanpa batas.**
  Lihat baris R19 di tabel verifikasi: -1 hanya dari clear
  di push yang sama (cap sudah mengikat), dan stale
  rekonsiliasi adalah I21.
- **Tombstone tidak mengubah penghitung ke bawah.** Tombstone
  adalah UPDATE yang tidak menambah/mengurangi baris, dan
  tidak ada pembersihan tombstone server (I22), jadi tidak
  ada jalur penghitung kelebihan-rendah dari penghapusan.
- **Pull dan hapus akun terikat user.** Semua 5 query
  `handlePull` memakai `user_id = ?` (item lewat join
  `p.user_id`), dan hapus akun menghapus item hanya lewat
  subquery playlist milik pengguna, jadi baca/hapus tidak
  menyentuh data orang lain. S11 adalah soal VOLUME baca,
  bukan soal otorisasi baca.
- **`playlistOwned` tidak memberi oracle keberadaan playlist.**
  Playlist yang tidak ada dan playlist milik orang lain
  sama-sama menghasilkan `skippedNotOwned` (tidak ada
  perbedaan respons yang bisa dipakai membedakan keduanya),
  dan I20 menutup bocoran jumlah item lewat cap.
- **Klien tidak retry 429 dalam loop ketat.** `syncNow`
  digerbang flag `syncing` (tidak ada putaran tumpang tindih)
  dan auto-sync App hanya tiap 20 detik; pengguna yang
  anggarannya habis membakar maksimal sekitar 2 baris
  rate-limit per 20 detik, bukan banjir. Pesan 429 spesifik
  anggaran belum ditampilkan di UI (utang Blue 5 §7 butir 3,
  bukan temuan keamanan).
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
  dicocokkan; konsumsi atomik (satu DELETE berkondisi).
  Fail-open saat D1 gagal adalah keputusan yang
  didokumentasikan dan dilindungi rate limit + kode provider
  sekali pakai.
- **Kepemilikan R11 tidak punya TOCTOU.** Upsert playlist tidak
  pernah mengubah `user_id` (tidak ada di klausa SET guard
  maupun upsert polos), sehingga kepemilikan tidak berubah di
  antara cek `playlistOwned` dan eksekusi batch.
- **`applied` menghitung pernyataan, bukan baris yang lolos
  guard.** Insert yang diblokir guard tetap dihitung di
  `applied` (pernyataan ada di batch). Ini ketidaktepatan
  pelaporan kecil (klien memakai `applied` sebagai info),
  bukan temuan keamanan; dicatat supaya Blue 6 tahu bila
  memakai angka itu untuk keputusan.
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
- **Dependensi produksi tidak berubah sejak Red 5.**
  Tidak ada dependensi baru di Blue 5 (hanya kode). picomatch
  GHSA-fc5q tetap diketahui dan tidak dilaporkan ulang
  (upgrade Vitest 5 terjadwal).
- **Hash player sinkron.** Lihat I18 di atas.

---

## Hasil tes

| Tes | Hasil |
|---|---|
| Vitest penuh (workdir kotor: Blue 5 + tes tim resolve) | **820/820, 52 file** (83 dtk, `--configLoader runner --pool=threads`), exit 0. Baseline Blue 5 784/784 + 36 tes tim resolve (termasuk `retryLadder.test.ts` 12 tes); NOL kegagalan dari file daftar-abaikan maupun dari kode Blue 5. |
| `syncWorker.test.ts` (termasuk 11 tes baru S8/S9/R19/I20) | **60/60** |
| `syncService.test.ts` (termasuk 2 tes baru R20/S8) | **22/22** |
| `WipeFlow.test.tsx` (termasuk 6 tes R17) | **9/9** |
| `rateLimit.test.ts` (I15) | **7/7** |
| Suite bertarget gabungan (4 file di atas) | **98/98** |
| Suite library/backup (`library`, `format`, `service`, `spotify`, `tokens`) | **181/181, 5 file** |
| Uji unit worker proxy (`s7-unit-test.mjs`) | **20/20** |
| Verifikasi SQL lokal (SQLite 3.45.1, skrip `/tmp/red6-sql-verify.sql` + `/tmp/red6-sql-scale.sql`) | Backfill 0005 benar; reservasi anggaran 1/0/1; guard R19 lolos/blokir sesuai prediksi; race stale-reconcile TERBUKTI (I21); sentinel -1 lolos guard; row-value IN eksak (2 baris); EXPLAIN pull dua skala (lihat S11); EXPLAIN 9+ query S9 semua SEARCH, nol SCAN tabel |
| Typecheck / lint | Tidak dijalankan ulang ronde ini (Blue 5 melaporkan 0 error untuk keduanya; tidak ada kode yang diubah Red 6) |

---

## Probe live (19 Nov 2026, tanpa auth, tanpa data pengguna)

| Probe | Hasil |
|---|---|
| Header `https://laras.adipmusic.my.id/` (2x, percobaan pertama timeout egress) | CSP + nosniff + DENY + no-referrer sesuai `_headers` (S2 live) |
| HTML `https://laras.adipmusic.my.id/` | Chunk live `index-CQgLqbBQ.js` (sesuai penugasan; BERBEDA dari chunk dist lokal `index-nwkEvaMQ.js`) |
| OPTIONS `/api/sync/push`, `Origin: http://localhost:5173` | 204 TANPA `Access-Control-Allow-Origin` (R10 TERBUKTI live sesudah redeploy Blue 5) |
| Callback state tak dikenal (cookie cocok, state acak) | 302 `reason=state` (jalur DELETE berkondisi I19 TERBUKTI live; tabel `oauth_states` ada) |
| Config remote `player-config.json` | `version: 1`, `ttlSeconds: 21600`, ketiga hash sama dengan repo (I18 sinkron) |
| `/api/auth/me` tanpa cookie | 401 `UNAUTHORIZED` |

Total 10 request; tidak ada yang menyentuh data pengguna,
tidak ada login, tidak ada penulisan D1 atas nama pengguna
(kecuali 1 baris rate-limit callback dari probe I19).
Probe curl pertama ke domain dan ke raw.githubusercontent
sempat timeout (egress VM flaky, bukan situs mati); retry
berhasil.

---

## Yang TIDAK bisa diverifikasi + alasannya

- **S8/S9/R19/I20 live (anggaran, penghitung, guard, cap).**
  Butuh sesi login sungguhan (kredensial owner); Red 6 tidak
  punya sesi dan tidak meminta kredensial. Verifikasi kode +
  tes worker (60/60, termasuk 11 tes Blue 5) + SQL lokal
  adalah bukti yang dipakai. Pernyataan koordinator bahwa
  migrasi 0005 diterapkan dan worker sync redeploy (etag
  ae96fa69) diterima sebagai bukti deploy live; TIDAK ADA
  endpoint tanpa-auth yang bisa membedakan worker dengan
  tabel 0005 dari worker fail-open. Menjadi tugas koordinator
  dengan akun uji: push normal 1 entri harus mengembalikan
  field `limits` + `skippedOverLimit`; clear kedua dalam 24
  jam harus mengembalikan `historyClearIgnored: true`.
- **S10 live (laju daur ulang hapus + daftar).**
  Pembuktian live butuh otomasi login OAuth + benar-benar
  membakar kuota tulis bersama; sengaja TIDAK dilakukan.
  Bukti yang dipakai adalah kode + skema (tidak ada satu pun
  penghambat di jalurnya).
- **S11 live (laju pembakaran baca pull yang sebenarnya).**
  Pembuktian live butuh akun uji yang benar-benar membakar
  kuota baca D1 bersama (jutaan baris); sengaja TIDAK
  dilakukan karena merusak kuota harian produk. Bukti yang
  dipakai adalah EXPLAIN QUERY PLAN pada dua skala seed +
  aritmetika dari angka arsitektur §2.1. Satu ketidakpastian
  yang dicatat jujur: meteran D1 untuk lookup baris tabel
  sesudah pencarian indeks (indeks item tidak covering)
  bisa membuat hitungan nyata LEBIH BESAR dari angka di
  laporan ini; angka laporan adalah batas bawah.
- **S12 live (laju tulis rate-limit).** Sama seperti di atas:
  pembuktian butuh banjir 15-19 jam; sengaja tidak dilakukan.
  Bukti adalah kode `isRateLimited` (1 UPSERT per request)
  + aritmetika.
- **Wipe ujung-ke-ujung (R15/R17/R18/R20) dengan sesi login.**
  Wipe saat masuk lalu tunggu 20 detik (data TIDAK kembali),
  wipe saat status belum terkonfirmasi, wipe saat sync sedang
  berjalan, wipe di antara dua await cabang pengaturan:
  keempatnya butuh sesi login sungguhan + browser. Red 6
  hanya memverifikasi kode + tes Vitest. Menjadi tugas
  koordinator dengan akun uji.
- **`npm audit` (gerbang R4).** Endpoint audit npm diblokir
  egress proxy VM (403 `policy_denied`, terverifikasi di ronde
  sebelumnya, sama seperti Red 1/2/3/4/5 dan Blue 1/2/3/4/5).
  CI run adalah bukti sahnya; picomatch GHSA-fc5q sudah
  diketahui dan didokumentasi, bukan temuan baru.
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
  `0001_init.sql` + migrasi 0004/0005; perilaku sesi dibuktikan
  dari kode + endpoint publik tanpa auth. Keberadaan tabel
  `oauth_states` live dibuktikan SECARA TIDAK LANGSUNG lewat
  perilaku callback (`reason=state` vs `reason=exchange`),
  bukan lewat query D1.
- **Perilaku SW di browser nyata + E2E Playwright penuh.**
  Termasuk serving `/dl/` dengan Range dan network-first
  navigasi di browser nyata; Chromium tidak bisa jalan andal
  di sandbox ini (gelombang EPERM). Bukti terbaik adalah E2E
  P7/P8 + Blue 5 yang sudah lolos di VM tim sebelumnya + CI
  (Blue 5 melaporkan `p8.spec.ts` 6/6), Vitest `sw.test.ts`,
  dan `app/dist/sw.js` hasil build di disk yang terverifikasi
  memuat perbaikan R8.
- **Unduh live ujung-ke-ujung + unduh ulang massal.**
  googlevideo memblokir IP VM (vonis S3); kaki live sudah
  dicatat sebagai utang dan bukan ranah audit ini.
- **File daftar-abaikan workdir kotor.** Seluruh file tim
  resolve (canary, retryLadder, vercel-proxy, potoken-brief,
  service.ts, id.ts, dan kawan-kawan) sengaja TIDAK diaudit
  sesuai penugasan; vonis di laporan ini hanya menyangkut
  kode Blue 5 (remote HEAD b5edcf7e). Tes penuh 820/820
  mencakup tes tim resolve yang semuanya hijau, tetapi
  KEAMANAN kode mereka bukan bagian audit ini dan wajib
  diaudit terpisah sesudah mereka push.

---

## Rekomendasi urutan perbaikan untuk Blue 6

1. **S10** - ikat anggaran + stempel ke identitas yang tidak
   bisa didaur ulang (tombstone pengguna terhapus + cooldown
   pendaftaran ulang, ATAU rate limit delete + anggaran kecil
   untuk akun baru). Ini menutup satu-satunya jalan memutar
   S8 yang tersisa.
2. **S11** - perbaiki query item pull (filter `i.user_id`) +
   anggaran baca pull per akun (atau batas khusus pull
   since=0). Perbaikan query saja tidak cukup (baseline 54
   menit tetap ada); keduanya dibutuhkan.
3. **S12** - bebankan baris rate-limit sync ke anggaran akun +
   jangan menulis baris untuk request yang sudah dibatasi.
   Mengembalikan bar kuota tulis ke 5 akun.
4. **I21** - jadikan rekonsiliasi satu pernyataan atomik
   (INSERT ... SELECT COUNT ... ON CONFLICT DO UPDATE).
5. **I22** - tambah cron pembersih tombstone 30 hari +
   rekonsiliasi penghitung sesudah pembersihan.
6. **I23** - samakan fail-open blok penghitung item dengan
   blok skalar (fallback COUNT).
7. **Koordinator (bukan Blue):** verifikasi S8/S9 live dengan
   akun uji (push 1 entri mengembalikan `limits` +
   `skippedOverLimit`; clear kedua mengembalikan
   `historyClearIgnored`); verifikasi R15/R17/R18/R20
   ujung-ke-ujung (wipe saat masuk, tunggu 20 detik, data
   TIDAK kembali; wipe saat status belum terkonfirmasi;
   wipe saat sync sedang berjalan); cabut `x-proxy-cpu-ms`
   (I17) dan rancang sumber hash remote (I18) saat promosi
   produksi; gerbang `npm audit` di run CI; terapkan
   pemantauan kuota D1 (baca DAN tulis, dengan peringatan di
   50% dan 80%, karena S11/S12 menunjukkan kedua kuota bisa
   dihabiskan dari arah yang berbeda); audit terpisah untuk
   kode tim resolve (canary/retryLadder/vercel-proxy) sesudah
   mereka push, karena Red 6 sengaja tidak menyentuhnya.

**Red 7 (sesudah Blue 6):** verifikasi S10 dengan tes worker
(hapus + daftar lagi tidak mendapat anggaran penuh baru);
verifikasi S11 (pengguna dengan 10.000 item yang menarik 30x
tidak memindai melebihi ambang; pull since=0 berulang
dibatasi); verifikasi S12 (dua akun di laju maks tidak bisa
melewati kuota tulis; request di atas batas tidak menulis
baris rate-limit); verifikasi I21/I22/I23 bila ditutup; plus
audit permukaan baru apa pun yang mendarat sesudah P9.
