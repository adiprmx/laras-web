# Red 7 - Audit Keamanan Laras Web (P9, ronde TERAKHIR, sesudah Blue 6)

**Tanggal:** 19 November 2026.
**Auditor:** Tim Red 7 - audit statis + tes unit + E2E Chromium nyata +
probe live terbatas (endpoint publik tanpa auth) + verifikasi SQL lokal
(SQLite).
**Ruang lingkup:** verifikasi seluruh klaim perbaikan Blue 6 atas 6
temuan Red 6 (S10, S11, S12, I21, I22, I23) plus lubang tambahan yang
ditemukan Blue 6 (tagihan tulis pull); putusan atas dua residual Blue 6
§8 dan celah kecil §9; audit TERPISAH kode resolve yang belum pernah
diaudit (tangga retry, kanari, perubahan service pemutar, fungsi proxy
Vercel); verifikasi regresi perbaikan Blue 1, Blue 2, Blue 3, Blue 4,
dan Blue 5; plus pemeriksaan rutin (XSS, console, secret, telemetri,
larangan `api.spotify.com`).
**HEAD yang diaudit:** commit `d54915e5` (Blue 6 + hotfix tangga retry +
fungsi proxy Vercel + docs, 29 file diff vs Blue 5), workdir
`~/workspace/music-app-web/` per 19 Nov 2026; live di
laras.adipmusic.my.id (chunk `index-aUI1GTTa.js`, terkonfirmasi dari
HTML live ronde ini). `git log` lokal basi dan tidak dipakai sebagai
acuan, sesuai catatan AGENTS.md tentang push via API.
**Metode:** baca kode penuh jalur sensitif yang diubah Blue 6 dan kode
resolve, grep pola berbahaya, jalankan Vitest penuh + tes unit worker +
E2E bertarget di Chromium nyata, probe live hemat kuota (9 percobaan,
tanpa auth, tanpa menyentuh data pengguna), dan verifikasi SQL lokal di
SQLite 3.45.1 (skema 0001-0006, seed skala kecil 10 playlist / 1.000
item dan skala besar 100 playlist / 100.000 item). Pembuktian S10/S11
live yang membakar kuota D1 bersama sengaja TIDAK dilakukan (aturan
yang sama seperti Red 5/6); bukti yang dipakai adalah kode + tes worker
+ SQL lokal. Red HANYA audit: tidak ada kode produksi yang diubah;
satu-satunya file yang berubah selama audit adalah artefak hasil tes
`app/tests/spikes/s7-unit-result.json` (diregenerasi saat menjalankan
s7-unit-test, sama seperti Red 4) dan laporan ini.
**Catatan penomoran:** temuan baru melanjutkan penomoran Red 6
(R21, S13-S14, I24-I30). Residual Blue 6 §8 diberi nomor S13/S14
supaya bisa dilacak Blue 7; celah §9 diberi nomor I24.

## Ringkasan vonis

| Tingkat | Jumlah |
|---|---|
| Kritis | **0** |
| Tinggi | **0** |
| Sedang | **0** |
| Rendah | **3** |
| Info | **7** |
| **Total baru** | **10** |

**Vonis: LAYAK LANJUT KE BLUE 7, lalu RC sesudah Blue 7 menutup tiga
temuan rendah (R21, S13, S14) dan tiga info yang diwajibkan (I24, I25,
I26).** Tidak ada temuan kritis, tinggi, atau sedang. Seluruh klaim
perbaikan Blue 6 TERBUKTI (semua klaim S10, S11, S12, I21, I22, I23,
dan tagihan tulis pull terverifikasi di kode, tes, dan SQL lokal; lihat
tabel verifikasi). Seluruh perbaikan Blue 1 sampai Blue 5 MASIH
bertahan. Kode resolve (tangga retry + kanari + service pemutar)
terverifikasi benar dan aman di semua titik kecuali satu: aturan ketat
LOGIN_REQUIRED saja membuat tangga latar tidak jalan untuk pola
campuran UNPLAYABLE + LOGIN_REQUIRED, dan pola itu TERBUKTI NYATA
(R21), bukan hipotesis. Fungsi proxy Vercel dormant dan tidak
di-wiring; temuannya info saja.

Pola ronde ini berbeda dari ronde lalu: tidak ada lagi lubang kuota
kelas menit. Ketiga temuan rendah semuanya berbar persiapan panjang
(6 hari, 42 hari) atau berbiaya efektivitas (tangga retry), bukan
celah yang bisa dipakai hari ini juga. Itu kabar baik: pertahanan
kuota S8/S9/S10/S11/S12 sudah membentuk lapis yang utuh, dan yang
tersisa adalah memperkuat tepi-tepinya sebelum RC.

## Putusan atas residual Blue 6 §8 dan celah §9 (inti ronde ini)

Brief memerintahkan putusan, bukan sekadar pencatatan. Ketiganya
DIPUTUS di bawah ini; perincian bukti dan aritmetika ada di
temuan masing-masing.

| Butir | Putusan | Alasan singkat |
|---|---|---|
| Residual §8(a): hapus akun bermuatan penuh (~111.200 tulis sekali) | **WAJIBKAN MITIGASI (S13, rendah)** | Perbaikan murah tersedia (cooldown sebanding dengan ukuran akun, ~20 baris + 1 kolom migrasi + 1 string); siklus serang memanjang 8 hari menjadi ~13 hari. Hapus bertahap asinkron tetap tindak lanjut pasca-RC. Sisa risiko sesudah mitigasi dikuantifikasi di S13. |
| Residual §8(b): dump stok tombstone via sapu | **WAJIBKAN PERBAIKAN (S14, rendah)** | Perbaikan kecil dan MENUTUP TOTAL lubang (cadangan atomik pra-sapu sebesar biaya sapu persis). Koreksi atas §8: volume benar sampai ~210.200 tulis (bukan ~110.100; Blue 6 tidak menghitung UPDATE penghitung), dan persiapan benar ~42 hari (bukan 6 hari; Blue 6 tidak menghitung biaya tombstone + penuaan 30 hari). |
| Celah §9: probe gagal sesudah reservasi tanpa refund | **WAJIBKAN PERBAIKAN (I24, info)** | Perbaikan 5 baris dengan pola yang sama persis seperti I23 (bungkus fase cap dengan `failCountsUnavailable`). Dampak maks 1.911 anggaran per galat D1 transien; tidak ada alasan meninggalkannya di ronde terakhir. |

---

## Temuan rendah

### R21 - Pola campuran UNPLAYABLE + LOGIN_REQUIRED tidak memicu tangga latar: keterbatasan §7 retry-ladder.md TERBUKTI NYATA

**Tingkat: rendah.** **File:**
`app/src/resilience/retryLadder.ts:113-122` (`isLoginRequiredOnly`),
`app/src/player/service.ts:1125-1145` (gerbang tangga),
`app/src/resilience/errors.ts:113-120` (klasifikasi `refused`),
`app/src/extractor/resolve.ts:592,746-756` (retry P6 + sts),
`app/src/resilience/retry.ts:27-29` (`isRefusalPlayability`),
`app/src/resilience/canary.ts:92-101` (sinyal `recent-fail`).

**Bukti:**
- Aturan tangga latar mensyaratkan SEMUA upaya `=LOGIN_REQUIRED`
  (`retryLadder.ts:118-121`). Satu upaya `UNPLAYABLE` saja
  membatalkan tangga, dan perilaku lama (gagal cepat + pindah lagu)
  yang berlaku.
- Pola campuran BUKAN hipotesis: probe parent 19 Nov 2026 15:57 WIB
  (tercatat di `docs/retry-ladder.md` §2.3 dan log koordinator)
  menunjukkan `WEB_REMIX=UNPLAYABLE` + `ANDROID_VR=LOGIN_REQUIRED`
  untuk video `hhn-nGSuenM`, yaitu lagu kanari nomor 1, video yang
  DIKETAHUI BAGUS dan lolos di jendela baik. Jadi campuran terjadi
  pada video yang seharusnya diselamatkan tangga, di jendela buruk
  yang sama dengan yang memicu hotfix ini.
- `UNPLAYABLE` bukan sinyal andal "lagu benar-benar tidak ada":
  `resolve.ts:592` mendokumentasikan bahwa tanpa `sts` server
  membalas UNPLAYABLE, bukan LOGIN_REQUIRED (penyebab konfigurasi,
  bukan permanen). Penanda playability bersifat non-deterministik
  per client x waktu (tercatat di `docs/vercel-egress.md` §4).
- Inkonsistensi internal, tiga lapis kode yang sama-sama
  mendefinisikan "penolakan" secara LEBIH LONGGAR dari tangga:
  (1) retry cepat P6 (`resolve.ts:746-756`, `isRefusalPlayability`
  di `retry.ts:27-29`) menganggap LOGIN_REQUIRED ATAU UNPLAYABLE
  sebagai penolakan dan me-retry putaran; (2) klasifikasi
  `errors.ts:113-120` memetakan campuran LOGIN_REQUIRED/UNPLAYABLE
  apa pun ke penyebab `refused` yang sama; (3) kanari memakai
  klasifikasi itu, sehingga cek kanari campuran menghasilkan
  `dominantCause: 'refused'` dan sinyal `recent-fail`
  (`canary.ts:99`). Akibatnya, di jendela campuran, kanari berkata
  "jendela buruk, lewati putaran cepat" SEMENTARA tangga berkata
  "bukan LOGIN_REQUIRED murni, tidak ada retry latar": dua paruh
  hotfix yang sama saling bertentangan atas bukti yang sama.
- Data frekuensi yang ada: uji §5 15:50 WIB menunjukkan 5/5 lagu
  murni LOGIN_REQUIRED di semua client, sementara probe 15:57
  menunjukkan 1/1 lagu campuran. Campuran adalah minoritas dalam
  data yang diamati (1 dari 6 lagu), tetapi bukan nol, dan tidak
  ada data yang membuktikan ia langka secara sistematis.

**Dampak:** tangga latar, yang merupakan inti hotfix resolve,
tidak jalan untuk sebagian kegagalan jendela buruk (yang
campuran). Mode gagalnya ramah (perilaku lama: gagal cepat dengan
pesan jujur + pengguna bisa coba lagi manual), sehingga tingkatnya
rendah, bukan sedang. Tetapi bila campuran ternyata umum di
jendela buruk, hotfix menjadi hampir tidak berguna.
**Rekomendasi (Blue 7, WAJIB):** longgarkan gerbang sesuai
keputusan parent 19 Nov 2026 18:43 WIB: tangga mulai bila
MAYORITAS upaya adalah LOGIN_REQUIRED. Implementasi konkret:
hitung pangsa `=LOGIN_REQUIRED` dari `allAttempts` di
`isLoginRequiredOnly` (atau fungsi baru `isMostlyLoginRequired`
dengan ambang >50%); upaya `UNPLAYABLE` tetap dihitung sebagai
penolakan (konsisten dengan `isRefusalPlayability`), upaya
proxy/jaringan/solver tidak ikut menghalangi bila mayoritas
tetap LOGIN_REQUIRED. Perbarui `retryLadder.test.ts` (kasus
mayoritas vs minoritas vs tanpa LOGIN_REQUIRED sama sekali)
dan `service.retryLadder.test.ts` (kasus campuran). Validasi
lanjut memakai data uji §5 ulang dari cron laras-resolve-watch
(milik parent, bukan Blue 7). Biaya pelonggaran terbatas: video
yang benar-benar UNPLAYABLE di semua client TIDAK memenuhi
mayoritas (0 LOGIN_REQUIRED), jadi tetap gagal cepat; video
campuran yang ternyata permanen hanya menelan maks 6 request
tambahan + penantian maks ~7 menit yang bisa di-skip kapan saja.

### S13 - Residual §8(a): hapus akun bermuatan penuh menulis ~111.200 baris sekali; PUTUSAN: wajibkan cooldown sebanding

**Tingkat: rendah.** **File:**
`workers/sync/src/index.js:2567-2598` (batch hapus, 11 DELETE),
`:2492-2509` (rate limit hapus), `:851` (cooldown 24 jam),
`:2524-2565` (tulis tombstone, tanpa hitung baris terhapus).

**Bukti:**
- Batch hapus menghapus SEMUA baris pengguna tanpa batas dan
  tanpa tagihan anggaran: akun di batas penuh (100 playlist +
  100.000 item + 10.000 suka + 1.000 riwayat + settings +
  ~103 baris penghitung + anggaran + meta + sesi + users)
  menulis ~111.200 baris dalam satu panggilan, melebihi kuota
  tulis harian bersama 100.000 sendirian. Angka Blue 6
  terverifikasi: hitungan Red 7 dari skema memberi ~111.210
  (111.101 data + 1 settings + 103 penghitung + ~6 anggaran
  tulis + ~6 anggaran baca + 1 meta + maks 10 sesi + 1 users);
  selisih dari 111.200 adalah pembulatan, tidak material.
- Persiapan yang dibutuhkan penyerang: membangun data itu
  menelan >=111.101 anggaran tulis, yaitu 6 hari di batas
  maksimal 20.000/hari (5,56 hari, dibulatkan ke atas 6 hari).
  Angka Blue 6 BENAR untuk residual ini (tidak ada biaya
  tombstone tambahan: hapus tidak butuh tombstone dulu).
- Siklus serang penuh: 6 hari persiapan + 1 hari dump + 1 hari
  cooldown 24 jam = ~8 hari per satu hari kuota mati. Selama 6
  hari persiapan penyerang memakai 20% kuota tiap hari (bukan
  DoS, tetapi terlihat di pemantauan bila ada).
- Perbandingan yang jujur dengan baseline S8: 5 akun
  terkoordinasi membunuh kuota SETIAP hari tanpa persiapan
  (rasio 1:1, tanpa jeda). Residual ini membutuhkan 1 identitas
  tetapi hanya membunuh 1 hari per ~8 hari, dengan rasio
  bayar:rusak ~1,1:1 (111.101 dibayar untuk ~100.000 kerusakan
  terealisasi). Residual ini TIDAK mengalahkan baseline dalam
  efisiensi; ia mengalahkannya hanya dalam jumlah identitas
  (1 vs 5) dengan harga persiapan 6 hari.
- Mitigasi yang sudah ada (rate limit hapus 1/jam/akun +
  3/jam/IP + cooldown 24 jam) TIDAK menyentuh volume dump
  sekali ini: dump hanya butuh SATU panggilan hapus.

**Dampak:** satu identitas bisa mematikan sinkronisasi untuk
semua pengguna selama satu hari penuh, sekali per ~8 hari,
sesudah 6 hari persiapan di laju maksimal. Dampak per kejadian
sama dengan S7/S8 (sedang), tetapi bar persiapan 6 hari jauh
di atas bar S12 (15-19 jam, dinilai rendah), sehingga
tingkatnya rendah.
**PUTUSAN: WAJIBKAN MITIGASI, bukan terima mentah dan bukan
tunda ke perbaikan besar.** Perbaikan sejati (hapus bertahap
asinkron/antrean) adalah perubahan desain besar dan dicatat
sebagai tindak lanjut pasca-RC. Mitigasi yang diwajibkan untuk
Blue 7 adalah **cooldown sebanding dengan ukuran akun**:
(1) delete handler menjumlahkan `meta.changes` dari 11
pernyataan DELETE batch dan menyimpan jumlahnya sebagai kolom
baru `deleted_rows` di `sync_deleted_identities` (migrasi 0007:
satu ALTER TABLE); (2) cooldown daftar ulang menjadi 24 jam
+ 1 hari per 20.000 baris di atas 20.000, dibatasi maks 30 hari
(retensi tombstone): akun normal (<=20.000 baris, mencakup
sinkronisasi penuh di batas skalar ~12.100) TIDAK berubah
(24 jam); akun penuh 111.200 baris mendapat ~6 hari
(24 jam + 5 hari); (3) redirect callback membawa tanggal
buka kunci (`reason=deleted-recently&until=<tanggal ISO>`)
dan string klien menyebut tanggal itu, supaya pesan "masuk
lagi besok" tidak berbohong untuk cooldown panjang.
Sesudah mitigasi, siklus serang menjadi ~13 hari per satu hari
kuota mati (6 persiapan + 1 dump + 6 cooldown), dan harga
dump menjadi sebanding dengan kerusakannya. Sisa risiko
sesudah mitigasi (diterima sebagai risiko terdokumentasi):
satu identitas yang sangat tekun MASIH bisa mematikan kuota
satu hari per ~13 hari; menutupnya total butuh hapus bertahap
asinkron pasca-RC.

### S14 - Residual §8(b): dump stok tombstone via sapu; PUTUSAN: wajibkan tagihan sapu ke anggaran (dengan dua koreksi atas §8)

**Tingkat: rendah.** **File:**
`workers/sync/src/index.js:1601-1695` (`pruneOldTombstones`,
tulis TIDAK ditagih), `:1816` (pemanggilan tiap push),
`:187-190` (TOMBSTONE_PRUNE_PER_PUSH=100,
TOMBSTONE_PRUNE_AGE_MS=30 hari).

**Bukti dan dua koreksi atas analisis Blue 6 §8:**
- **Koreksi 1, volume: ~210.200 tulis, bukan ~110.100.** Blue 6
  hanya menghitung DELETE tombstone (100 playlist + 100.000
  item + 10.000 suka = 110.100). Sapu juga menulis UPDATE
  penghitung: 1 per koleksi skalar + 1 per playlist BERBEDA
  dalam sampel item (:1677-1691). Red 7 membuktikan di SQLite
  bahwa sampel 100 item bisa mencakup 100 playlist berbeda
  (penyerang mengatur urutan hapus selang-seling antar
  playlist, karena sampel diurutkan `deleted_at` lewat indeks
  (user_id, deleted_at)), sehingga dump item menelan sampai
  100 UPDATE per push x 1.000 push = 100.000 UPDATE tambahan.
  Total yang dicoba: 110.100 DELETE + ~100.100 UPDATE =
  ~210.200 tulis (terealisasi dibatasi sisa kuota harian
  ~100.000; kerusakannya sama: kuota mati). Bila tombstone
  dibuat berkelompok per playlist, totalnya ~111.100; rentang
  jujurnya 111.100 sampai 210.200, BUKAN 110.100.
- **Koreksi 2, persiapan: ~42 hari, bukan 6 hari.** Blue 6
  menulis ">=6 hari di batas maksimal". Itu hanya biaya
  MEMBUAT baris (110.100 anggaran). Tombstone juga menelan
  anggaran saat DIBUAT: tiap entri hapus ditagih 1 anggaran
  (`computePushCharge` menghitung `deleted*In.length`), jadi
  total persiapan anggaran adalah 110.100 (buat) + 110.100
  (tombstone) = 220.200 anggaran = 12 hari di batas maksimal.
  Ditambah penuaan WAJIB 30 hari: sapu hanya menyentuh
  tombstone `deleted_at` lebih tua dari 30 hari (:1603-1604),
  dan Blue 6 §8 TIDAK menyebut syarat ini sama sekali.
  Jadwal optimal (buat + tombstone 10.000/hari sambil
  batch awal menua) membuat stok penuh baru bisa di-dump
  pada hari ~42. Rasio steady-state Blue 6 ("~14 anggaran
  per 1 tulis sapu") juga keliru arah: 14 adalah biaya
  per-baris bila penyerang mendorong 1 entri per push
  (tagihan 7 per baris x buat + tombstone); penyerang rasional
  yang mem-batch 100/push membayar ~2,1 anggaran per 1 tulis
  sapu (2 buat+tombstone + 0,04 tagihan push dump).
  Koreksi ini MEMPERKUAT mitigasi (bar persiapan 7x lebih
  tinggi dari yang diklaim) tetapi MEMPERLEMAH klaim rasio.
- Dump-nya sendiri: ~1.000 push (item mendominasi, 100/push;
  tiap push menyentuh ketiga koleksi), ~34 menit di rate limit
  30/menit, tagihan dump-hari 13.000 anggaran (13/push: 3 entri
  + tunjangan 6 + 3 + 1) yang muat dalam 20.000. Semua angka
  di atas dihitung dari kode, bukan dari laporan Blue 6.
- Siklus serang penuh: ~42 hari per satu hari kuota mati
  (12 hari anggaran + 30 hari penuaan, tumpang tindih sebagian;
  dump ulang butuh membangun ulang seluruh stok).

**Dampak:** sama dengan S13 (satu hari kuota mati), tetapi
dengan bar persiapan ~42 hari, jauh di atas S13. Tingkatnya
rendah.
**PUTUSAN: WAJIBKAN PERBAIKAN (bukan terima), karena
perbaikannya kecil dan menutup TOTAL lubang ini.**
Spesifikasi untuk Blue 7: (1) sesudah sampling sapu (jumlah
tombstone + jumlah UPDATE penghitung yang akan jalan
diketahui persis dari sampel), cadangkan jumlah itu ke
anggaran tulis secara atomik (upsert berkondisi yang sama
seperti reservasi push, sebelum DELETE apa pun); (2) bila
cadangan gagal (anggaran habis), lewati sapu push ini
(tombstone menunggu besok; push sendiri tetap jalan);
(3) cadangan memakai hitungan PERSIS (tombstone + UPDATE),
bukan batas atas 102, supaya pengguna normal tidak
kelebihan-tagih. Sesudah perbaikan, total tulis per akun per
hari kembali dibatasi anggaran 20.000 (invarian "semua tulis
ditagih" pulih penuh), dan dump sapu menjadi mustahil:
menyiapkan stok tetap mungkin, tetapi menyapunya menelan
anggaran yang sama dengan membuatnya. Catatan implementasi:
cadangan sapu harus dilakukan SEBELUM penghitung dikurangi,
dan `pruneOldTombstones` perlu mengembalikan jumlah yang
disapu (atau 0 bila dilewati) untuk observabilitas.

---

## Info

### I24 - Celah §9 Blue 6: probe gagal sesudah reservasi tanpa refund; PUTUSAN: wajibkan perbaikan

**File:** `workers/sync/src/index.js:1917-2120` (fase cap/probe
tanpa try/catch: `capNewEntries` playlist :1917, suka :1944,
riwayat :1970, `playlistOwned` :2018-2045, probe item :2095-2120),
dibandingkan blok penghitung yang SUDAH dibungkus
(`:1843-1915` skalar, `:2055-2090` item, I23).

**Bukti:** reservasi anggaran jalan di :1767-1796. Sesudah itu,
fase penghitung dilindungi `failCountsUnavailable` (refund +
500 jelas, I23). Tetapi fase cap/probe yang berjalan sesudah
penghitung TIDAK dibungkus: bila satu query probe
(`fetchExisting` atau `playlistOwned`) melempar galat D1
transien, pengecualian lolos ke router (:2725-2732) dan push
gagal 500 generik `SERVER_ERROR` TANPA refund. Red 7
mengonfirmasi dengan membaca jalur kode: tidak ada satu pun
try/catch antara :1917 dan pembangunan batch, dan
`reservedCharge` hanya dipakai di jalur penghitung + batch.
**Dampak:** pengguna kehilangan paling banyak satu tagihan
push (maks 1.911 anggaran, 9,6% anggaran harian) per galat D1
transien di fase probe, plus pesan galat yang generik (bukan
`SYNC_TEMPORARILY_UNAVAILABLE`). Galat D1 transien langka dan
kerugian pulih besok, sehingga tingkatnya info, sama seperti
I23. **PUTUSAN: WAJIBKAN PERBAIKAN.** Bungkus fase cap/probe
(:1917-2120) dalam satu try/catch yang mengembalikan
`failCountsUnavailable(db, user.id, day, reservedCharge)`,
pola yang sama persis seperti I23. Tambahkan satu tes worker
(probe melempar: 500 `SYNC_TEMPORARILY_UNAVAILABLE` +
`budgetUsed` 0). Perkiraan Blue 6 di §9 ("paling banyak satu
tagihan push") terverifikasi benar.

### I25 - Race decrement penghitung sapu: dua push bersamaan mengurangi dua kali untuk tombstone yang sama (TERBUKTI di SQLite)

**File:** `workers/sync/src/index.js:1619-1633` (playlist),
`:1649-1663` (suka), `:1677-1691` (item): decrement memakai
`ids.length` / `found.length`, bukan `meta.changes` dari DELETE.

**Bukti:** Red 7 membuktikan di SQLite lokal: penghitung 100
(50 hidup + 50 tombstone); push A DELETE 50 baris (changes 50)
lalu decrement 50 menjadi 50 (benar); push B yang menyeleksi
50 id yang SAMA sebelum DELETE A commit mengeksekusi DELETE
yang sama (changes 0, baris sudah hilang) tetapi tetap
decrement 50 menjadi 0, padahal sisa benar 50. Undercount 50
TERBUKTI. Jendela race-nya adalah selang antara SELECT sampel
dan DELETE di dua push bersamaan; D1 mengeksekusi pernyataan
berurutan tetapi dua invocasi Worker bisa interleave.
**Dampak:** penghitung kelebihan-rendah sampai ~100 per
kejadian (sampai ~2.900 pada 30 push bersamaan ekstrem),
melonggarkan cap koleksi itu sebesar itu sampai rekonsiliasi
berikut (pemicu `oldNearCap` mengoreksi saat penghitung
mendekati cap dalam 24 jam; di bawah cap-500 tidak ada pemicu
koreksi, jadi pelonggaran bisa menetap). Bukan vektor kuota
(anggaran tetap membatasi tulis) dan bukan vektor baca.
Tingkatnya info, setara I21. **Rekomendasi (Blue 7, WAJIB,
kecil):** pakai `res.meta?.changes` dari DELETE sebagai jumlah
decrement di ketiga cabang (playlist, suka, item); untuk item,
hitung decrement per playlist dari baris yang BENAR-BENAR
terhapus (bila DELETE menghapus kurang dari sampel, kurangi
per playlist secara proporsional dari hasil DELETE, atau
sederhanakan: decrement total dengan `changes` dan alokasikan
ke playlist berdasarkan sampel yang terhapus). Tambahkan tes
worker balapan sapu (dua push bersamaan, penghitung akhir
eksak).

### I26 - Sapu playlist yatimkan item hidup: item tidak pernah di-pull, disapu, atau terhapus saat hapus akun (TERBUKTI di SQLite)

**File:** `workers/sync/src/index.js:1601-1633` (sapu playlist
hanya hapus baris playlist), `:2568-2573` (hapus akun hapus
item lewat subquery playlist), `:2223-2231` (tombstone
playlist tidak menyentuh item); `app/src/data/library.ts:1117-1140`
(`deletePlaylist` menghapus lagu lokal secara keras dan hanya
mencatat satu tombstone playlist).

**Bukti:** rantai lengkap terverifikasi: (1) klien menghapus
playlist hanya mengirim tombstone playlist; itemnya tetap
HIDUP di server (`deleted_at` NULL). (2) Sesudah 30 hari, sapu
I22 menghapus baris playlist tombstone tetapi TIDAK itemnya.
(3) Item yatim itu tidak pernah kembali lewat pull (JOIN ke
`sync_playlists` gagal, :982), tidak pernah disapu cabang item
(`deleted_at` NULL, bukan < cutoff), dan tidak terhapus saat
hapus akun (subquery `playlist_id IN (SELECT id ...)` tidak
menemukan playlist yang sudah hilang). Red 7 membuktikan di
SQLite: hapus 1 playlist dari 100 (masing-masing 1.000 item),
1.000 item yatim tetap ada; delete handler hanya menghapus
99.000 dari 100.000 item. Baris `sync_counts` items untuk
playlist yang hilang juga tertinggal (tidak berbahaya: hanya
dibaca bila playlist itu disentuh lagi).
**Dampak:** kebocoran penyimpanan permanen yang tumbuh lambat
(pengguna yang churn playlist bisa meninggalkan sampai 100.000
baris yatim, ~20 MB pada ~200 byte/baris; jauh di bawah batas
penyimpanan D1 5 GB). Bukan vektor kuota (tulis sudah dibayar
saat pembuatan) dan tidak terlihat pengguna. Tingkatnya info.
**Rekomendasi (Blue 7, WAJIB, bersama S14):** (a) cabang sapu
playlist ikut menghapus item dari playlist yang disapu
(`DELETE FROM sync_playlist_items WHERE playlist_id IN (...)`)
+ mengurangi penghitung items per playlist, DENGAN cap total
sapu per push (mis. 1.000 baris termasuk item) dan tagihan
anggaran per S14 (tanpa cap, satu push bisa menghapus
100 playlist x 1.000 item = 100.000 baris); (b) sabuk
pengaman: delete handler ikut menghapus item yatim
(`DELETE ... WHERE user_id = ? AND playlist_id NOT IN (SELECT
id FROM sync_playlists)`). Tambahkan tes worker (sapu playlist
+ hitung yatim 0; hapus akun + hitung yatim 0).

### I27 - Tes tangga retry flaky di bawah beban CPU (bukan bug produk)

**File:** `app/src/player/service.retryLadder.test.ts` (15 tes).

**Bukti:** run penuh Red 7: 839/842, ketiga kegagalan adalah
TIMEOUT (bukan asersi) di file ini: tes kehabisan (batas 30
dtk), tes skip (batas 5 dtk), tes jeda (batas 20 dtk). Run
ulang file ini saja: gagal 3 lalu 2 (di bawah beban), lalu
15/15 LOLOS dalam 20,4 dtk saat mesin sepi. Tes kehabisan
saja memakan 17,8 dtk waktu nyata di run sepi (memajukan
392 dtk jam palsu + ~400 detak watchdog 1 dtk yang masing-masing
kerja nyata), menyisakan headroom hanya 1,7x terhadap batas
30 dtk. Koordinator memverifikasi 842/842 di run-nya sendiri
(17:15 WIB), konsisten dengan flaky-beban, bukan regresi.
**Dampak:** nol terhadap produk; risiko terhadap CI
(flake acak) dan terhadap kepercayaan pada suite.
**Rekomendasi (Blue 7, kecil):** naikkan batas tes panjang
(kehabisan ke 60 dtk, jeda ke 30 dtk, skip ke 15 dtk) ATAU
kurangi kerja nyata per detak watchdog di tes (injeksi
interval watchdog lebih panjang untuk tes tangga). Jangan
longgarkan asersi.

### I28 - Fungsi proxy Vercel dormant: 5 catatan kecil, wajib dibenahi SEBELUM wiring apa pun

**File:** `workers/vercel-proxy/api/innertube/player.js`,
`workers/vercel-proxy/vercel.json`. Fungsi ini TIDAK di-wiring
ke app (vonis DITOLAK JUGA, tidak ada `proxyFailover.ts`),
sehingga semua catatan di sini info, bukan temuan aktif.

1. **IP dari `X-Forwarded-For` entri pertama bisa dipalsukan**
   (:176-177): klien bisa mengirim header `X-Forwarded-For`
   palsu dan Vercel MENAMBAHKAN IP asli di belakang, sehingga
   entri pertama adalah nilai kiriman klien. Rate limit
   per-IP bisa di-bypass dengan memutar header palsu. Proxy CF
   memakai `CF-Connecting-IP` yang tidak bisa dipalsukan.
   Perbaiki sebelum wiring: pakai entri TERAKHIR rantai, atau
   header khusus Vercel.
2. **Jalur `?ping=1` lolos dari rate limit** (:125-130):
   dicek sebelum rate limit; banjir ping membakar kuota
   invokasi Vercel. Perbaiki: pindahkan sesudah rate limit,
   atau hapus sebelum produksi.
3. **Tidak ada cek `responded` sesudah await** (:215-252):
   bila penjaga 28 dtk sudah mengirim 502, kode yang lanjut
   sesudah `await fetch` / `await readCapped` tetap memanggil
   `res.writeHead` pada respons yang sudah selesai (galat
   `ERR_HTTP_HEADERS_SENT`, noise log). Tambahkan
   `if (responded) return;` sesudah tiap await.
4. **Tanpa `X-Content-Type-Options: nosniff`** pada respons
   sukses (:247-251) maupun galat; proxy CF memakainya.
   Tambahkan di semua respons.
5. **Cleanup bucket O(n) per request saat map >10.000**
   (:50-57): bila 10.000+ bucket masih segar (tidak ada yang
   kedaluwarsa), tiap IP baru memicu pemindaian penuh tanpa
   hasil, dan map tumbuh tanpa batas keras. Batasi dengan
   probabilitas (mis. 1% seperti sapu D1) atau eviksi paksa
   saat melewati batas.

Yang terverifikasi BENAR di fungsi ini: CORS allowlist 3 origin
Laras (bukan `*`), cap body 1 MB + respons 10 MB + timeout
upstream 30 dtk + penjaga keras 28 dtk + `maxDuration: 30`,
tanpa log body/videoId/URL stream, envelope galat konsisten,
hanya POST yang diterima (GET 405). README akurat terhadap kode.

### I29 - Pra-cek anggaran sebelum rate limit: akun kehabisan anggaran bisa membanjiri pull/push tanpa batas laju per-user

**File:** `workers/sync/src/index.js:2611-2660` (pull),
`:2667-2722` (push): pra-cek anggaran jalan SEBELUM
`checkRateLimit`, sehingga request yang ditolak pra-cek tidak
pernah menyentuh rate limit.

**Bukti dan hitungan:** akun yang anggarannya habis bisa
membanjiri pull/push tanpa batas 30/menit: tiap pull yang
ditolak pra-cek menelan 3-4 baca D1 (`authUser` 2 + anggaran
baca 1 + anggaran tulis 1 bila lolos yang pertama). Batas
yang tersisa hanyalah kuota request Workers bersama
(100.000/hari): 100.000 x 3-4 = 300.000-400.000 baca
(6-8% kuota baca 5 juta). Tetapi mencapai angka itu HARUS
membakar seluruh kuota Workers, yang sendirinya mematikan
sync + proxy untuk semua pengguna; jadi sisi baca D1 BUKAN
vektor independen, melainkan efek samping dari DoS kuota
Workers yang sudah ada sebelumnya untuk endpoint mana pun
(rate limit per-user/IP tidak bisa mencegahnya karena request
dihitung sebelum kode Worker jalan). Memindahkan rate limit
ke sebelum pra-cek akan membuka lagi S12a (baris rate-limit
tak tertagih untuk request yang ditolak anggaran), jadi
urutan saat ini adalah tradeoff yang benar.
**Dampak:** info, TIDAK WAJIB diperbaiki. Opsi bila
koordinator menginginkan pertahanan berlapis: cek rate-limit
HANYA-BACA (SELECT hitungan saja, tanpa UPSERT) sebelum
pra-cek, membatasi banjir ke 30/menit (maks ~130.000 baca,
2,6%) tanpa menulis baris apa pun.

### I30 - Noise jsdom `URL.revokeObjectURL` di tes backup (bukan bug produksi)

**File:** `app/src/backup/service.ts:250`:
`window.setTimeout(() => URL.revokeObjectURL(url), 1000)`
tanpa guard. jsdom tidak mengimplementasikan
`URL.revokeObjectURL`, sehingga run penuh Vitest mencatat
"Errors 1 error" (unhandled, sesudah tes "250 lagu -> 200
diantre + 50 dilewati"). Di browser nyata fungsi itu ada,
jadi produksi tidak terpengaruh. Sarankan guard
`typeof URL.revokeObjectURL === 'function'` atau mock di
setup tes, supaya noise ini tidak menutupi unhandled error
yang nyata. Info, tidak wajib.

### I16, I17, I18 - Masih terbuka dengan sengaja (bawaan, tanpa perubahan)

- **I16** (`db.batch` bukan transaksi atomik): tidak berubah.
  Relevan dengan I23b (refund penuh bila batch gagal di
  tengah, didokumentasikan dan diterima Blue 6 §6) dan
  dengan `restoreFromTombstone` (batch tidak atomik:
  warisan anggaran bisa mendarat tanpa konsumsi tombstone,
  tetapi warisan ulang tombstone basi tidak berbahaya karena
  cek `budgetDay` + stempel clear tua lolos gerbang).
- **I17** (`x-proxy-cpu-ms`): masih aktif, keputusan Blue 1
  dipertahankan. Tes s7 masih menegaskan header terekspos
  (20/20 lolos ronde ini).
- **I18** (allowlist hash player di-hardcode): tidak berubah,
  keputusan Blue 1 dipertahankan. Ketiga salinan hash MASIH
  sinkron per 19 Nov 2026: proxy `PLAYER_HASHES`
  (`workers/proxy/src/index.js:68`: `fad7e4e9`, `ad8d59ae`,
  `b559f50c`), `BUILTIN_HASHES`
  (`app/src/spike/config.ts:125-129`, nilai sts yang sama),
  dan config remote live (ketiga hash yang sama,
  `version: 1`, `ttlSeconds: 21600`, diambil Red 6 19 Nov 2026;
  ronde ini tidak mengambil ulang, config tidak berubah di
  diff Blue 6).

---

## Verifikasi perbaikan Blue 6 (prioritas utama)

Semua klaim Blue 6 TERBUKTI. Tidak satu pun klaim yang gagal;
temuan baru S13/S14/I24/I25/I26 adalah celah di SEKITAR
perbaikan (volume hapus dan sapu di luar anggaran, fase probe
di luar refund, race decrement, item yatim), bukan kegagalan
klaimnya. Verifikasi aritmetika diminta penugasan ikut
dicantumkan per klaim.

| ID | Klaim Blue 6 | Vonis | Bukti |
|---|---|---|---|
| S10a | Rate limit hapus 3/jam/IP + 1/jam/akun, jendela 1 jam, 429 + Retry-After 3600 | **TERBUKTI (kode + tes)** | Konstanta `index.js:163-165`, penegakan `:2492-2509` (dua `checkRateLimit` sebelum batch hapus, `Retry-After: 3600` di :2508). Jendela per jam didukung `windowStartFor` + parameter `windowMs` di `rateLimit.js:47,67`. Tes worker "hapus ke-4 dari satu IP" + "hapus ke-2 satu akun" lolos (78/78). |
| S10b | Tombstone identitas (hanya SHA-256 + angka) + warisan anggaran/stempel | **TERBUKTI (kode + tes)** | Migrasi 0006 (`sync_deleted_identities`, 6 kolom, tanpa nama/email); `identityHashFor` :694 (`SHA-256("provider:provider_id")`); tulis tombstone SEBELUM hapus :2524-2565 (INSERT ... ON CONFLICT DO UPDATE); baca :699-727; warisan :738-776 (anggaran hanya bila `budgetDay` sama dengan hari daftar ulang; stempel clear selalu; tombstone dikonsumsi); sapu malas >30 hari di callback :842-848. Tes privasi (:3265) + warisan white-box (:3170) lolos. Catatan: sesudah cooldown 24 jam hari UTC selalu berganti, jadi cabang warisan anggaran memang hanya pertahanan berlapis, sesuai dokumen. |
| S10c | Cooldown daftar-ulang 24 jam + pesan klien | **TERBUKTI (kode + tes + E2E)** | Konstanta :178, penegakan :851-853 (`fail('deleted-recently')`); string `id.ts:333-334`; wiring `SettingsPage.tsx:93-94,107-108,184`; E2E Chromium nyata `blue6-settings.spec.ts` 2/2 lolos ronde ini (pesan khusus tampil, query dibersihkan). Tes worker "daftar ulang 25 jam berhasil, anggaran lama tidak diwariskan" lolos. |
| S10 | Aritmetika: 1 identitas maks ~20.020 tulis/hari = 20% kuota; butuh 5 identitas | **TERBUKTI (aritmetika, dengan S13)** | 20.000 anggaran + ~13 hapus + ~4 tombstone = ~20.017, dibulatkan 20.020; 100.000/20.020 = 4,995, butuh 5 identitas. Berlaku untuk tulis STEADY-STATE; dump hapus sekali (S13) adalah jalur terpisah di luar angka ini, didokumentasikan Blue 6 §8 dan diputus ronde ini. |
| S11a | Query pull item filter `i.user_id` langsung; EXPLAIN terverifikasi 2 skala | **TERBUKTI (kode + EXPLAIN Red 7)** | Query :982 (`WHERE i.user_id = ? AND i.updated_at > ?`, JOIN hanya lookup PK). Red 7 memverifikasi sendiri di SQLite 3.45.1 pada 2 skala: kecil (1.000 item) dan besar (100.000 item) SAMA-SAMA `SEARCH i USING INDEX idx_items_user (user_id=? AND updated_at>?)` + `SEARCH p USING INDEX sqlite_autoindex_sync_playlists_1 (id=?)`, TANPA temp b-tree; bentuk lama (pembanding) `SCAN p` + temp b-tree. Himpunan hasil identik (1.000 milik sendiri, 0 milik pengguna lain). |
| S11b | Anggaran baca 40.000/hari/akun, cadangan atomik 4.002, refund | **TERBUKTI (kode + SQL lokal + tes)** | `DAILY_READ_BUDGET = 40000` :138; cadangan `4*1000+1+1 = 4.002` :144; reservasi atomik :937-968 (upsert berkondisi, 429 `DAILY_READ_BUDGET_EXCEEDED` + Retry-After); refund :1003-1025 (tagihan akhir = baris kembali + 1). Verifikasi SQL Red 7: 9 cadangan sukses (36.018), ke-10 gagal (`changes=0`); refund 32.021 tepat (36.018 - 3.997). Tes worker batas persis (:3451: 36.000 + 4.002 ditolak, 35.998 lolos) + 12 pull penuh lalu 429 (:3367) lolos. |
| S11 | Aritmetika: 0,8% kuota baca; butuh 125 akun; sinkron penuh ~3x/hari; ekstrem 100.000 item ~3 hari | **TERBUKTI (aritmetika)** | 40.000/5.000.000 = 0,8% persis; 5.000.000/40.000 = 125. Sinkron penuh skalar 12.101 baris + ~10 pull = ~12.111, muat 3,3x/hari (dokumen menulis 2,7-3,2x memakai angka tagihan TULIS Red 6 yang lebih besar; konservatif, arah aman). Ekstrem 111.101/40.000 = 2,78 hari, ~3 hari. Catatan kecil: pull kosong dengan settings menagih bersih 2 (bukan 1); batas atas 4.002 tidak berubah. |
| S12a | Baris rate-limit ditagih ke anggaran + pra-cek router sebelum rate limit | **TERBUKTI (kode + tes)** | `computePushCharge` :1480 (+1 baris rate-limit; maks 1.911 = 700+1+1.000+2x(3+100)+3+1, terverifikasi hitungannya); pra-cek pull :2611-2660 (baca lalu tulis), push :2667-2722 (body dibaca dulu di `parsePushBody` :1450); `writeBudgetExhausted` :1515, `readBudgetExhausted` :1534. Tes "push/pull yang pasti ditolak tidak menulis baris rate-limit" lolos (:3504, :3530). Sudut sempit pra-cek batas atas + clear diabaikan didokumentasikan di kode (:2679-2686) dan diterima (kehilangan <1.000 anggaran hanya di ambang + clear diabaikan). |
| S12b | `rateLimit.js` ditulis ulang: SELECT dulu, yang sudah dibatasi ditolak tanpa UPSERT | **TERBUKTI (kode + tes)** | `rateLimit.js:77-108`: SELECT hitungan dulu (:77), tolak tanpa tulis bila > limit (:85), UPSERT (:86-92), baca ulang untuk vonis eksak (:93-98). Retensi sapu 1 jam (:41, `MAX_WINDOW_MS`) supaya baris jendela jam tidak terhapus sapu menit. Tes: 70 panggilan batas 60 menyimpan 61 baris (bukan 70); sapu menahan baris 2 menit (11/11 lolos). Race tersisa fail-closed (dua request di batas bisa sama-sama ditolak), sesuai dokumen. |
| S12 | Tagihan tulis pull 4/pull (lubang baru Blue 6) | **TERBUKTI (kode + SQL + tes)** | `PULL_WRITE_CHARGE = 4` :153; reservasi atomik di `handlePull` :905-920; pra-cek router :2630-2648. Cakupan 4 = rate-limit 1 + cadangan tulis 1 + cadangan baca 1 + refund 1, terverifikasi menutup SEMUA tulis satu pull (pull penuh refund 0 kelebihan-tagih 1, arah aman). Verifikasi SQL Red 7: 19.996 + 4 pas 20.000 diterima, +4 berikutnya ditolak. Tes "12 pull = 48 tagihan tulis" lolos (:3367). |
| S12 | Aritmetika: total per akun ~20.030/hari; butuh 5 akun | **TERBUKTI (aritmetika, dengan catatan)** | 20.000 + ~13 hapus + ~4 tombstone + kebocoran race pra-cek (beberapa baris) = ~20.020-20.030. Catatan: angka ini per AKUN; baris rate-limit endpoint tanpa-auth (login/callback/me, kunci per IP, 10+10+60/menit) tidak masuk angka ini, tetapi dibatasi kuota request Workers 100.000/hari (1 tulis per request yang diizinkan; request di atas batas tidak menulis sesudah S12b), analisis yang sama seperti Red 6 S12. Sisa di luar angka: S13 + S14 (diputus ronde ini). |
| I21 | `storeCount` compare-and-swap + fallback MAX atomik | **TERBUKTI (kode + SQL lokal + tes)** | `storeCount` :1297-1335 (CAS `WHERE n = ? AND updated_at = ?`, fallback `UPDATE ... SET n = MAX(n, ?)` satu pernyataan); `reconcileCount` meneruskan baris dibaca :1336-1365. Verifikasi SQL Red 7: CAS basi `changes=0`, penghitung tetap 10.000 (bukan 9.900); MAX mempertahankan 10.000; CAS cocok `changes=1` mengoreksi 5.000 menjadi 100. Tes balapan `RacingFakeD1` (:3555) lolos: penghitung akhir 10.001, guard memblokir insert. |
| I22 | Sapu tombstone malas tiap push, ≤100/koleksi yang disentuh, tanpa cron | **TERBUKTI (kode + tes)** | `pruneOldTombstones` :1601-1695; pemanggilan :1816 (sesudah reservasi, sebelum fase cap); indeks 0006 dipakai (`WHERE user_id = ? AND deleted_at < ? LIMIT 100`); penghitung dikurangi sejumlah yang terhapus (tanpa INSERT baris 0). Tes :3648 (50 lama hilang, penghitung 100 menjadi 51, 1 baru bertahan) + :3687 (item per playlist) lolos. Celah di sekitarnya: I25 (race decrement), I26 (item yatim), S14 (tulis tidak ditagih). |
| I23a | Penghitung item fail-open ke COUNT | **TERBUKTI (kode + tes)** | Blok item dibungkus try/catch :2055-2090 (fallback `countItemsPerPlaylist`; bila COUNT juga gagal, 500 `SYNC_TEMPORARILY_UNAVAILABLE` + refund); skalar :1905-1914; helper `failCountsUnavailable` :1577. Tes :3731 (fallback COUNT, push 200) + :3773 (keduanya gagal, 500 jelas + budget 0) lolos. |
| I23b | Refund anggaran tepat sebesar reservasi bila push gagal | **TERBUKTI (kode + SQL + tes)** | `refundWriteBudget` :1559-1576 (lantai 0, sekali per push gagal); pemanggilan batch :2356, penghitung :1912/:2079/:2086. Verifikasi SQL Red 7: 20.000 - 5.000 = 15.000; kelebihan-refund dilantai 0. Tes :3798 (batch gagal lalu coba lagi, satu tagihan 7) lolos. Catatan mid-batch I16 didokumentasikan di kode (:2338-2352) dan diterima. |
| §0 | Koreksi: tidak ada auto-sync tiap 20 detik | **TERBUKTI (kode)** | `App.tsx:210-219`: sync adalah `setTimeout` ONE-SHOT 20 dtk sesudah load (+ manual + sesudah redirect OAuth); NOL `setInterval` untuk sync di `app/src/sync/` maupun `App.tsx`. Asumsi Red 6 tentang auto-sync tiap 20 detik memang salah; koreksi Blue 6 benar dan memperkuat kelayakan anggaran baca + tagihan pull. |
| §7 | Batas baca S9 tetap berlaku (push 1 update ≤10 baca, 100 update ≤110, tanpa COUNT) | **TERBUKTI (tes)** | Suite Blue 5 (60/60) lolos tanpa perubahan di run penuh Red 7. Catatan Red 7: sapu I22 menambah baca sampel (maks 300/push bila stok tombstone besar); batas worst-case per akun menjadi ~13,4% kuota baca (S9 ~6% + sapu ~9% + pull 0,8%, tumpang tindih sebagian), tetap butuh ~8 akun untuk membunuh kuota baca. Bukan temuan terpisah. |

**Koreksi kecil atas dokumen Blue 6 (bukan temuan):** (1) volume
dump sapu §8 sampai ~210.200 (bukan ~110.100) dan persiapan
~42 hari (bukan 6 hari), lihat S14; (2) rasio "14 anggaran
per 1 tulis sapu" adalah biaya worst-case 1-entri-per-push,
bukan biaya penyerang rasional (~2,1); (3) pull kosong dengan
settings menagih bersih 2 baris baca (bukan 1); (4) §8
menyebut endpoint tanpa-auth "dibatasi 10-30/menit/IP",
padahal `/api/auth/me` 60/menit/IP; batas akhirnya tetap
kuota Workers, kesimpulan tidak berubah; (5) nomor baris
`storeCount` di dokumen (:1308) adalah awal komentar,
fungsinya di :1297; nomor baris `handlePull` dan kawan-kawan
lainnya cocok.

---

## Audit kode resolve (pertama kali diaudit)

Kode ini sengaja diabaikan Red 6 (workdir kotor) dan baru
diaudit penuh ronde ini: `app/src/resilience/retryLadder.ts`,
`app/src/resilience/canary.ts` (bagian sinyal),
`app/src/player/service.ts` (bagian tangga), `app/src/strings/id.ts`
(2 string), `workers/vercel-proxy/` (fungsi + config + README).
`resolve.ts` sendiri TIDAK diubah hotfix (terverifikasi: tidak
ada diff fungsional di luar yang diklaim; plumbing `maxRounds`
sudah ada sejak P6).

| Aspek | Vonis | Bukti |
|---|---|---|
| Tangga latar +60 dtk/+5 mnt, total ~6,3 mnt, maks 15 request/lagu | **TERBUKTI** | `BACKGROUND_RETRY_BACKOFF_MS = [60_000, 300_000]` (`retryLadder.ts:48`); total 5.000+15.000+60.000+300.000 = 380.000 ms (:52-56); maks 15 = 5 putaran x 3 client (:59); tiap percobaan latar `maxRounds: 1` (`service.ts:1291`). Jauh di bawah rate limit proxy 60/menit di setiap menitnya (maks 3 request/menit di fase latar). |
| Aturan ketat LOGIN_REQUIRED saja | **TERBUKTI ADA, DINILAI R21** | `isLoginRequiredOnly` (:113-122) + gerbang `service.ts:1125-1145`. Implementasinya sesuai spesifikasi hotfix; spesifikasinya sendiri yang bermasalah untuk pola campuran (lihat R21). |
| Penjaga jeda (jeda selama tangga cepat = tangga tidak mulai; jeda selama tangga latar = batal) | **TERBUKTI** | Gerbang status `!== 'paused'` di `onResolveFailed` (:1128-1130); `pause()` membatalkan tangga (:339); token check sesudah resolve latar (:1297, :1311) mencegah lagu mulai sendiri sesudah jeda. Melindungi sleep timer. |
| Tab latar (tenggat epoch + 3 pemicu) | **TERBUKTI** | Tenggat `nextAttemptAt` (`retryLadder.ts:66-70`, `isLadderDue` :104-106); pemicu: `setTimeout` (:1249), watchdog 1 dtk (`service.ts:1477`), `visibilitychange` (:247). `checkBackgroundRetry` idempotent + guard tumpang tindih (:1262-1276). |
| Sinyal kanari recent-fail (segar <1 jam + penyebab refused) | **TERBUKTI** | `CANARY_HEALTH_FRESH_MS = 3.600.000` (`canary.ts:47`); `canaryHealthSignal` (:92-101): basi = unknown, status ok = recent-pass, `dominantCause === 'refused'` = recent-fail. `loadCanaryRecord` mandiri (:109-119, tanpa siklus impor). Efek: notice sejak awal + `maxRounds: 1` (:864-878), tangga latar tetap jalan. `parseCanaryRecord` memvalidasi field + try/catch (:132-156); `dominantCause` tak tervalidasi aman karena hanya dibandingkan `=== 'refused'`. |
| Tangga habis: TIDAK pindah lagu, pesan akhir jujur | **TERBUKTI** | `exhaustBackgroundRetry` (:1355-1374): status `error` + `retryExhausted`, tanpa advance; `failures.recordFailure()` + persist. String `id.ts:210-211` bahasa sehari-hari, tanpa jargon, tanpa em dash. |
| Skip/prev/ganti lagu/wipe membatalkan tangga | **TERBUKTI** | `cancelBackgroundRetry` di `loadTrack` (:780), `stopPlayback` (:1438), `stopForWipe`/dispose (:1762), plus token check di `checkBackgroundRetry` (:1265) dan sesudah resolve (:1297). |
| Keamanan resolve (batas, validasi, kebocoran) | **BERSIH** | Tangga murni tanpa DOM/timer; tidak ada input pengguna baru; tidak ada log URL stream (log hanya `CLIENT=STATUS`); tidak ada fetch baru (memakai `resolveWithTimeout` yang sudah ada + timeout 90 dtk); tidak ada perubahan CSP/connect-src; kanari membaca IndexedDB lokal saja. `resolve.ts` tidak disentuh. |
| Fungsi proxy Vercel (dorman) | **INFO (I28)** | Lihat I28. Batas + CORS + tanpa-log terverifikasi benar; 5 catatan kecil wajib dibenahi sebelum wiring apa pun. Fungsi TIDAK dipakai app mana pun saat ini. |
| `resolve.ts` tidak diubah | **TERBUKTI** | Tidak ada perubahan perilaku di `resolve.ts` dari hotfix (hanya plumbing `maxRounds` P6 yang dipakai service). Klaim dokumen benar. |

---

## Verifikasi regresi Blue 1 + Blue 2 + Blue 3 + Blue 4 + Blue 5 (semua bertahan)

Spot-check kode + tes. Tidak ada satu pun perbaikan ronde
sebelumnya yang hilang atau melemah.

| ID | Status Red 7 | Bukti |
|---|---|---|
| H1 (chunk uji di produksi) | BERTAHAN | `App.tsx`: 9 gerbang `import.meta.env.DEV`; dist live 0 chunk `*TestPage*`; gerbang CI masih ada. |
| S1 (body POST dibaca penuh) | BERTAHAN | Proxy `readCapped(request.body, MAX_BODY_BYTES)` (:455); sync `parsePushBody` + `readCapped` (:1450). |
| S2 (tanpa CSP) | BERTAHAN + LIVE | `_headers` utuh; terkonfirmasi dari header live ronde ini (CSP persis, `'wasm-unsafe-eval'`, `nosniff`, `DENY`, `no-referrer`). Catatan: respons live juga membawa `Access-Control-Allow-Origin: *` yang BUKAN dari `_headers` (platform/zone); tidak berbahaya untuk shell HTML publik tanpa kredensial, bukan temuan. |
| S3 (rate limit in-memory) | BERTAHAN | Proxy memakai `isRateLimited` D1; NOL `buckets` in-memory di `workers/proxy/src/index.js`. Sisi tulisnya kini S12 (ditutup Blue 6). |
| S4 (config tanpa cap/versi) | BERTAHAN | `version === CONFIG_SCHEMA_VERSION` (`resolve.ts:123`); cap 4 MB tidak berubah. |
| R1 (redirect media tanpa validasi) | BERTAHAN | `redirect: 'manual'`, maks 3 hop, validasi host, Content-Type allowlist + nosniff (tidak berubah). |
| R2 (`decodeURIComponent` tanpa try/catch) | BERTAHAN | `parseRoute` try/catch + ErrorBoundary (tidak berubah). |
| R3 (SW cache-first + versi manual) | BERTAHAN | Navigasi network-first; `SW_VERSION = '0.9.0-71925ff2'` di dist + live (sw.js tidak berubah sejak P8). |
| R4 (CI tag `@v4`, tanpa permissions/audit) | BERTAHAN | `ci.yml`: pin SHA, `permissions: contents: read`, gerbang audit + gerbang H1 (tidak berubah; CI run 44510696844 SUCCESS). |
| R5 (cap client sesudah baca penuh) | BERTAHAN | `readCappedText` base.js 8 MB + innertube 10 MB (tidak berubah). |
| R6 (origin dev di CORS proxy) | BERTAHAN | `workers/proxy/wrangler.toml` `[vars]` hanya 2 domain produksi; localhost hanya `[env.dev.vars]`. |
| S5 (`JSON.parse` cache config) | BERTAHAN | `parseConfigText` (`configStore.ts:135`) dipakai ketiga jalur (:231/:245/:314). |
| R7 (re-resolve tanpa cek itag) | BERTAHAN | `ItagChangedError` + restart sekali dari byte 0 (tidak berubah; tes lolos). |
| R8 (SW Content-Type apa adanya) | BERTAHAN | `safeDownloadContentType` + nosniff di 200/206 (tidak berubah). |
| R9 (race batal vs rakit) | BERTAHAN | Cek abort sebelum `putDownload` + sebelum `markDownloaded` (tidak berubah). |
| I5/I6/I7 | BERTAHAN | Validasi enum snapshot, tidur 429 bisa dibatalkan, fallback combineSignal (tidak berubah). |
| S6 (callback tanpa rate limit + state bisa dipakai ulang) | BERTAHAN + LIVE | Rate limit callback 10/mnt/IP (:2430); state single-use atomik (:524, :804); LIVE ronde ini: state tak dikenal ke 302 `reason=state`. |
| R10 (localhost di ALLOWED_ORIGINS sync) | BERTAHAN + LIVE | `wrangler.toml` `[vars]` hanya `https://laras.adipmusic.my.id`; LIVE ronde ini: OPTIONS localhost 204 TANPA ACAO. |
| R11 (push tanpa cek kepemilikan) | BERTAHAN | `playlistOwned` + `skippedNotOwned` + upsert WHERE `user_id` (tidak berubah; tes lolos). |
| R12/R13/R14 (cap impor backup/Spotify/parser) | BERTAHAN | Cek `file.size` sebelum baca, cap 10 MB + 30 lagu, cap per-field/per-koleksi (tidak berubah; tes lolos). |
| R15/R17/R18 (wipe + sesi + epoch) | BERTAHAN | Logout dulu bila `signed-in`, tunggu `refreshAuth` bila `unknown`, `invalidateSyncEpoch` baris pertama wipe (:112), cek `stale()` di syncService (tidak berubah; tes WipeFlow 9/9 lolos). |
| R16 (nama playlist impor Spotify) | BERTAHAN | Potong 100 karakter + try/catch (tidak berubah). |
| I11/I12/I13/I14/I15 | BERTAHAN | Klasifikasi AbortError, `parseCookies` try/catch, validasi record LRCLIB, nosniff/CSP 503, tes rateLimit stabil (11/11 lolos). |
| S7 (batas total per pengguna) | BERTAHAN + DIPERKUAT | Batas §4.3 via penghitung S9 + guard R19 + cap klien 100 (`library.ts:90,3031`); `skippedOverLimit` + `limits` masih dilaporkan. |
| I19 (konsumsi state OAuth atomik) | BERTAHAN + LIVE | Satu DELETE berkondisi + cek `meta.changes`; LIVE via 302 `reason=state`. |
| S8 (anggaran tulis + gerbang clear) | BERTAHAN | `DAILY_WRITE_BUDGET = 20000` (:126), gerbang clear 24 jam (:197), reservasi atomik, 429 + Retry-After (tes 78/78 lolos). |
| S9 (penghitung + probe terbatas) | BERTAHAN | `sync_counts` + probe ≤100 + rekonsiliasi terbatas (tes batas baca lolos tanpa perubahan). |
| R19 (guard-WHERE) | BERTAHAN | Guard per INSERT entri baru (tes balapan lolos). |
| R20 (cek `stale()` lirik) | BERTAHAN | `syncService.ts:183` `if (stale()) return;` sebelum `lyrics.setEnabled` :184. |
| I20 (kepemilikan sebelum cap) | BERTAHAN | `playlistOwned` sebelum hitung cap item; tes lolos. |
| I1/I8/I17, I2/I9/I18, I3, I4, I10 | SAMA SEPERTI RED 6 | Lihat I17/I18 di atas; I3 (URL lokal) + I4 (sourcemap, bukan temuan) + I10 (sebagian tertutup) tidak berubah. |

---

## Cap di semua jalur masuk data (diperbarui untuk S10/S11/S12/I22)

| Jalur masuk | Cap | Status |
|---|---|---|
| Backup file | 10 MB total + per-field/per-koleksi (R14) + cek ukuran sebelum baca (R12) | Lengkap |
| Spotify file/teks | 10 MB + 30 lagu + teks 1.000 karakter (R13) | Lengkap |
| Spotify tautan | 30 lagu + halaman 2 MB (proxy) | Lengkap |
| Sync push (server) | 1 MB body + 100 entri/koleksi + per-field + batas TOTAL (S7/S9) + anggaran tulis 20.000/hari/akun (S8) + gerbang clear 24 jam (S8a) + guard per pernyataan (R19) + baris rate-limit ditagih (S12) | Lengkap per IDENTITAS (S10), kecuali sapu di luar anggaran (S14, diputus wajib diperbaiki) |
| Sync pull (server) | 1.000 baris/koleksi per pull, 30/mnt/user, anggaran baca 40.000/hari/akun (S11), tagihan tulis 4/pull (S12) | Lengkap |
| Sync pull (klien) | Item 1.000/playlist; playlist total 100 (S7) | Lengkap |
| Hapus akun | 3/jam/IP + 1/jam/akun + cooldown 24 jam + tombstone (S10) | Lengkap untuk DAUR ULANG; volume hapus sekali di luar anggaran (S13, diputus wajib mitigasi) |
| Sapu tombstone | ≤100/koleksi/push, hanya >30 hari (I22) | TIDAK LENGKAP: tulis tidak ditagih (S14, diputus wajib diperbaiki) |
| Pencarian YTM | 100 item/grup (parser), 10 MB respons | Lengkap |
| Lirik LRCLIB/lyrics.ovh | 1 MB + timeout 30 dtk | Lengkap |
| Config remote | 4 MB + versi 1 | Lengkap |
| "Unduh ulang" | 200 job/ketukan + laporan kelebihan | Lengkap |
| Unduhan chunk | 100 MB/file, antrean 200 | Lengkap |
| Resolve retry (klien) | Maks 15 request player/lagu/7 menit (tangga P6 + latar) | Lengkap (di bawah rate limit proxy 60/menit) |
| Proxy Vercel (dorman) | 1 MB body, 10 MB respons, 30 dtk, 60/menit/IP in-memory | Lengkap di atas kertas; TIDAK DIPAKAI app (dorman) |

---

## Yang DIPERIKSA dan bersih (baru di ronde ini + umum)

- **Anggaran baca tidak bisa di-reset lewat daftar ulang.**
  Cooldown S10c menutup reset anggaran tulis DAN baca sekaligus
  (alasan pilih tolak, bukan warisi, di :168-177); warisan
  tombstone mencakup `read_rows` sebagai lapis kedua.
- **Tombstone identitas tidak membocorkan identitas.**
  Yang disimpan hanya SHA-256 `provider:provider_id` + angka;
  serialisasi tes (:3265) tidak mengandung provider_id mentah
  atau nama. Hash satu arah tidak bisa dipakai memulihkan
  provider_id (ruang provider_id cukup besar; bukan
  pengenal berentropi rendah seperti nomor urut).
- **Tombstone tidak bisa dipakai dua kali.** Dikonsumsi
  (dihapus) dalam batch yang sama dengan warisan (:765);
  warisan ulang dari batch yang gagal sebagian tidak
  berbahaya (cek `budgetDay` + stempel tua lolos gerbang).
- **Cadangan baca tidak bisa di-TOCTOU.** Satu upsert
  berkondisi sebelum query; pull bersamaan tidak bisa
  sama-sama lolos sesudah anggaran habis (terverifikasi SQL:
  ke-10 gagal `changes=0`).
- **Refund baca tidak bisa menggandakan anggaran.**
  Refund = cadangan dikurangi (kembali + 1), dijaga `refund > 0`
  dan lantai 0; dipanggil sekali per pull sesudah query sukses.
  Bila query gagal (Promise.all melempar), cadangan TIDAK
  di-refund (kelebihan-tagih, arah aman).
- **Refund tulis tidak bisa menggandakan anggaran.**
  Sekali per push gagal, tepat sebesar reservasi, lantai 0,
  tanpa retry (terverifikasi SQL).
- **CAS tidak bisa menurunkan penghitung di bawah jumlah nyata.**
  Arah melenceng aman (terlalu tinggi); koreksi ke bawah hanya
  lewat CAS sukses dengan nilai COUNT segar (terverifikasi SQL).
- **Sapu tidak menyentuh tombstone baru.** Sampel memakai
  `deleted_at < now - 30 hari` (terverifikasi SQL: 50 lama
  terpilih, 1 baru tidak).
- **Sapu tidak membuat baris penghitung 0.** Decrement memakai
  UPDATE tanpa INSERT (:1622, :1646, :1679).
- **Delete tidak meninggalkan anggaran/stempel.** Batch hapus
  mencakup `sync_read_budget` (:2590) di samping seluruh tabel
  0005; hanya tombstone identitas yang sengaja tersisa.
- **Origin validation lengkap di semua POST sync.**
  Logout, delete, push semua cek Origin sebelum auth/handler;
  `isAllowedOrigin` menolak bila header Origin tidak ada.
  Pull (GET, baca-saja) tidak butuh cek Origin.
- **Sesi cookie benar.** Token 256 bit acak, hash SHA-256 di D1,
  HttpOnly + Secure + SameSite=None (penyimpangan tercatat),
  30 hari, maks 10 sesi/user, host-only (tanpa Domain).
- **`applied` menghitung pernyataan, bukan baris yang lolos
  guard.** Ketidaktepatan pelaporan kecil yang dicatat Red 6,
  tidak berubah, bukan temuan keamanan.
- **Nol XSS / eval liar / secret / telemetri / console.**
  NOL `dangerouslySetInnerHTML` di `app/src` (`innerHTML` hanya
  properti stub di `solver/jsStubs.ts:32`, bukan DOM nyata).
  Engine eval hanya QuickJS sandbox + harness spike (tidak ada
  chunk eval di dist). NOL `console.*` di kode produksi app.
  NOL pola secret di repo (kunci InnerTube adalah kunci publik,
  BUKAN temuan; secret OAuth tidak ada di repo). NOL telemetri
  (`sendBeacon`/`WebSocket`/analytics nol).
- **Larangan `api.spotify.com` dipatuhi total.** String itu
  hanya muncul di komentar sebagai larangan.
- **Dependensi produksi tidak berubah sejak Red 6.** Tidak ada
  dependensi baru di Blue 6 maupun hotfix resolve (hanya kode).
  picomatch GHSA-fc5q tetap diketahui dan tidak dilaporkan
  ulang (upgrade Vitest 5 terjadwal).
- **Hash player sinkron.** Lihat I18.
- **Tidak ada `proxyFailover.ts`, tidak ada wiring Vercel.**
  Sesuai mandat (failover hanya bila vonis BERSIH); `resolve.ts`
  tidak merujuk fungsi Vercel sama sekali.
- **Tangga retry tidak dipersist lintas reload.** Keputusan
  sadar yang didokumentasikan (§3.3 retry-ladder.md), bukan
  kelalaian; reload menghentikan tangga dan pengguna menekan
  putar untuk memulai lagi.

---

## Hasil tes

| Tes | Hasil |
|---|---|
| Vitest penuh | **839/842, 52 file** (242,81 dtk), 3 gagal = TIMEOUT di `service.retryLadder.test.ts` (bukan asersi; lihat I27). Run ulang file itu saja: 15/15 LOLOS dalam 20,4 dtk saat mesin sepi. Suite ini LOLOS 842/842 di tangan koordinator (17:15 WIB) dan di tangan Red 7 saat sepi; kegagalan Red 7 adalah flaky-beban, bukan regresi. |
| `syncWorker.test.ts` + `rateLimit.test.ts` | **89/89** (78 + 11, sesuai klaim Blue 6 persis), 13,91 dtk |
| `service.retryLadder.test.ts` (re-run) | **15/15** (20,37 dtk, mesin sepi); 12/15 dan 13/15 di dua run berbeban (timeout, lihat I27) |
| Uji unit worker proxy (`s7-unit-test.mjs`) | **20/20** (meregenerasi `s7-unit-result.json`, artefak tes) |
| E2E Playwright Chromium nyata: `blue6-settings.spec.ts` + `smoke.spec.ts` | **3/3** (1,0 mnt; pesan deleted-recently + pesan umum + smoke beranda) |
| E2E Playwright Chromium nyata: `retry-ladder.spec.ts` | **3/3** (1,7 mnt; tangga mulai + kanari recent-fail 3 request + skip membatalkan) |
| Typecheck `tsc -b` | **0 galat** |
| ESLint (file yang disentuh Blue 6 + resolve) | **0 galat, 0 warning** |
| Verifikasi SQL lokal (SQLite 3.45.1, skrip `/tmp/red7-sql-verify.sql` + `/tmp/red7-budget.db`) | EXPLAIN pull 2 skala (index seek, tanpa temp b-tree); cadangan baca 9 sukses + ke-10 gagal + refund tepat; cadangan tulis pas 20.000 + tolak; refund lantai 0; CAS basi/MAX/cocok; race decrement sapu TERBUKTI (I25); item yatim TERBUKTI (I26); sampel sapu 100 item = 100 playlist berbeda (S14); sapu hanya >30 hari |
| CI | Run 44510696844 (commit d54915e5): completed + success, 12 cek (dinyatakan koordinator; Red 7 tidak menjalankan ulang CI) |

Catatan E2E: jalan pertama gagal karena gelombang TERBATAS
(Vite CLI tidak bisa `mkdir node_modules/.vite-temp`; symlink
ke `/tmp/p5-vite-temp` menggantung karena /tmp dibersihkan
reboot). Perbaikan lingkungan: `mkdir -p /tmp/p5-vite-temp`
(mengikuti pelajaran ronde lalu), bukan perubahan kode; jalan
berikutnya 3/3 + 3/3 hijau.

---

## Probe live (19 Nov 2026, tanpa auth, tanpa data pengguna)

| Probe | Hasil |
|---|---|
| Header `https://laras.adipmusic.my.id/` | 200; CSP persis `_headers` (termasuk `'wasm-unsafe-eval'`, `connect-src` memuat proxy + sync + lrclib + lyrics.ovh), `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` (S2 live) |
| HTML `https://laras.adipmusic.my.id/` | Chunk live `index-aUI1GTTa.js` (sesuai penugasan d54915e5; sama dengan chunk dist CI) |
| OPTIONS `/api/sync/push`, `Origin: http://localhost:5173` | 204 TANPA `Access-Control-Allow-Origin` (R10 TERBUKTI live pasca-redeploy Blue 6) |
| Callback state tak dikenal (cookie cocok, state acak) | 302 `Location: .../settings?auth=error&reason=state` (jalur DELETE berkondisi I19 + tabel `oauth_states` TERBUKTI live) |
| `/api/auth/me` tanpa cookie | 401 `{"success":false,"error":{"code":"UNAUTHORIZED","message":"Belum masuk"}}` |
| Proxy rute tak dikenal `/api/tidak-ada` | 404 `{"success":false,"error":{"code":"NOT_FOUND","message":"Endpoint tidak ditemukan"}}` |
| `/api/spotify-page` tanpa param | 400 `{"success":false,"error":{"code":"BAD_ID","message":"Id playlist tidak valid (22 karakter)"}}` |

Total 9 percobaan (6 berbalas HTTP di percobaan pertama
atau retry; 3 gagal 000 karena egress VM flaky, lalu lolos di
retry). Tidak ada yang menyentuh data pengguna, tidak ada
login, tidak ada penulisan D1 atas nama pengguna (kecuali
1 baris rate-limit callback dari probe state).

---

## Yang TIDAK bisa diverifikasi + alasannya

- **S10/S11/S12 live (anggaran, tombstone, cooldown, tagihan
  pull).** Butuh sesi login sungguhan + benar-benar membakar
  kuota D1 bersama; sengaja TIDAK dilakukan (aturan brief).
  Bukti yang dipakai adalah kode + tes worker (89/89) + SQL
  lokal + perilaku tanpa-auth yang konsisten (401/302/204).
  Pernyataan koordinator bahwa migrasi 0006 diterapkan dan
  worker sync + proxy redeploy (etag 291b59ec sync) diterima
  sebagai bukti deploy live. Menjadi tugas koordinator dengan
  akun uji: hapus + daftar ulang dalam 24 jam harus
  mengembalikan `reason=deleted-recently`; pull ke-13 penuh
  harus 429 `DAILY_READ_BUDGET_EXCEEDED`.
- **S13/S14 live (laju dump hapus + sapu).** Pembuktian live
  butuh membangun akun penuh (6-42 hari persiapan) lalu
  benar-benar membakar kuota bersama; sengaja TIDAK
  dilakukan. Bukti yang dipakai adalah kode + skema +
  aritmetika + SQL lokal (volume UPDATE sapu + penuaan
  30 hari terverifikasi).
- **R21 live (frekuensi pola campuran di jendela buruk).**
  Butuh data uji §5 ulang dari cron laras-resolve-watch
  (milik parent; Red 7 tidak menyentuhnya). Bukti yang
  dipakai adalah 1 probe campuran parent (15:57 WIB, video
  kanari yang diketahui bagus) + inkonsistensi internal kode
  (errors.ts/canary/fast-ladder vs gerbang tangga).
  Keputusan pelonggaran ke mayoritas SUDAH dibuat parent
  (18:43 WIB); frekuensi persis hanya memengaruhi seberapa
  besar manfaatnya, bukan kebenaran temuannya.
- **Tangga retry live di jendela buruk nyata.** Tangga hanya
  terbukti di tes (mock + jam palsu + E2E mock). Bukti live
  butuh deploy (sudah live) + uji §5 di jendela buruk nyata
  (di luar jangkauan VM, seperti P6 K6/K7).
- **Wipe ujung-ke-ujung (R15/R17/R18/R20) dengan sesi login.**
  Sama seperti Red 6: butuh sesi login sungguhan + browser.
  Red 7 hanya memverifikasi kode + tes Vitest. Menjadi tugas
  koordinator dengan akun uji.
- **`npm audit` (gerbang R4).** Endpoint audit npm diblokir
  egress proxy VM (403 `policy_denied`, terverifikasi di ronde
  sebelumnya). CI run adalah bukti sahnya; picomatch GHSA-fc5q
  sudah diketahui dan didokumentasi, bukan temuan baru.
- **Rate limit D1 proxy live (S3, 61+ request).** Pembuktian
  butuh 61+ request live (membakar kuota harian + menembak
  upstream); sengaja tidak dilakukan. Kode + uji unit worker
  + bukti live tidak langsung (rate limit callback sync yang
  memakai helper D1 yang sama terbukti live) adalah bukti
  yang dipakai.
- **Round-trip OAuth live penuh.** Login sungguhan Google dan
  GitHub diverifikasi koordinator 19 Nov 2026; ronde ini
  tidak mengulang login live (butuh kredensial owner) dan
  hanya memverifikasi sisi tanpa-auth.
- **Data sesi/token di D1.** Sengaja TIDAK di-query (sesuai
  penugasan). Skema dibaca dari migrasi; perilaku sesi
  dibuktikan dari kode + endpoint publik tanpa auth.
- **Perilaku SW di browser nyata (serving `/dl/` + Range).**
  E2E bertarget ronde ini (blue6-settings + retry-ladder)
  tidak mencakup unduhan; bukti terbaik adalah E2E P8/Blue 5
  (6/6) + CI + `sw.test.ts` + dist `sw.js` yang terverifikasi
  memuat perbaikan R8.
- **Fungsi Vercel live pasca-audit.** Red 7 tidak mem-probe
  fungsi Vercel (sudah diputuskan DITOLAK JUGA; vonis tim +
  konfirmasi koordinator 16:49 WIB diterima). Audit fungsi
  ini adalah audit kode statis, bukan audit live.

---

## Rekomendasi urutan perbaikan untuk Blue 7 (ronde TERAKHIR)

1. **S14** - tagih sapu tombstone ke anggaran (cadangan atomik
   pra-sapu sebesar biaya sapu persis; lewati sapu bila
   cadangan gagal). Menutup total satu-satunya jalur tulis
   tak tertagih yang besar. Sertakan I25 (pakai
   `meta.changes`) dan I26 (sapu playlist ikut hapus item +
   delete handler hapus yatim) dalam paket yang sama, karena
   ketiganya menyentuh `pruneOldTombstones` + delete handler.
2. **S13** - cooldown daftar ulang sebanding dengan ukuran
   akun (kolom `deleted_rows` di tombstone via migrasi 0007;
   24 jam + 1 hari per 20.000 baris di atas 20.000, maks
   30 hari; redirect membawa tanggal buka kunci + string
   klien menyebut tanggal). Hapus bertahap asinkron dicatat
   sebagai tindak lanjut pasca-RC, bukan Blue 7.
3. **R21** - longgarkan gerbang tangga ke mayoritas
   LOGIN_REQUIRED (keputusan parent 18:43 WIB). Perbarui
   `retryLadder.test.ts` + `service.retryLadder.test.ts`.
4. **I24** - bungkus fase cap/probe push dengan
   `failCountsUnavailable` (refund bila probe gagal).
5. **I27** - naikkan batas timeout tes tangga retry (atau
   kurangi kerja watchdog di tes). Jangan longgarkan asersi.
6. **I28** - benahi fungsi Vercel HANYA bila ada rencana
   wiring; bila tetap dormant, cukup catat sebagai utang
   (XFF, ping, `responded`, nosniff, cleanup bucket).
7. **I29, I30** - opsional, kecil; boleh masuk Blue 7 bila
   sempat, bukan pemblokir RC.
8. **Koordinator (bukan Blue 7):** verifikasi S10/S11 live
   dengan akun uji (deleted-recently + 429 baca); verifikasi
   wipe ujung-ke-ujung; putuskan pemantauan kuota D1
   (peringatan 50%/80%, baca DAN tulis, direkomendasikan
   sejak Red 5 dan makin relevan sesudah S13/S14: persiapan
   6-42 hari di laju maksimal SEHARUSNYA terlihat sebelum
   dump terjadi); cabut `x-proxy-cpu-ms` (I17) dan rancang
   sumber hash remote (I18) saat promosi produksi; kumpulkan
   data frekuensi pola campuran dari laras-resolve-watch
   untuk mengukur manfaat R21 sesudah Blue 7.

**Penutup ronde:** Red 7 adalah ronde verifikasi terakhir
(P9 ronde 5, maks 5). Tidak ada Red 8. Temuan di atas
diteruskan ke Blue 7, lalu koordinator memverifikasi sendiri.
Vonis akhir Red 7: kode d54915e5 layak masuk RC sesudah Blue 7
menutup R21, S13, S14, I24, I25, dan I26; tidak ada temuan
yang memblokir RC secara fundamental.
