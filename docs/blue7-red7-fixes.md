# Blue 7 - Perbaikan Temuan Red 7 (ronde TERAKHIR, P9)

**Tanggal:** 19 Nov 2026. **Remote HEAD:** `d54915e5` (Blue 6 + hotfix
tangga retry + fungsi proxy Vercel + docs).
**Status: seluruh cakupan DITUTUP** - 3 rendah (R21, S13, S14) + 4 info
wajib (I24, I25, I26, I27) + 1 info opsional (I30). I28 DITUNDA
(dicatat sebagai utang, lihat §8); I29 DITERIMA sebagai tradeoff
(tanpa perubahan kode).
**Tidak di-push, tidak di-deploy** - koordinator yang memverifikasi,
menerapkan migrasi 0007, push, dan deploy. Tidak ada Red 8:
sesudah Blue 7, koordinator memverifikasi sendiri.

Kuota bersama (arsitektur §2.1): D1 **100.000 baris tulis/hari**,
**5.000.000 baris baca/hari**. Anggaran per akun: tulis 20.000/hari,
baca 40.000/hari.

| Temuan | Status | Inti perbaikan |
| ------ | ------ | -------------- |
| S14 (rendah) | **Ditutup** | Sapu tombstone ditagih ke anggaran tulis lewat cadangan atomik sebesar biaya PERSIS (hapus + UPDATE penghitung + 1); cadangan gagal = sapu dilewati, push tetap jalan |
| I25 (info) | **Ditutup** | Decrement penghitung sapu memakai `meta.changes` DELETE (bukan ukuran sampel); item dihapus per playlist supaya decrement per playlist eksak |
| I26 (info) | **Ditutup** | Sapu playlist ikut menghapus itemnya + cap total 1.000 baris/push; delete handler ikut menghapus item yatim |
| S13 (rendah) | **Ditutup** | Cooldown daftar ulang sebanding ukuran akun (24 jam + 1 hari/20.000 baris di atas 20.000, maks 30 hari); kolom `deleted_rows` (migrasi 0007); redirect membawa tanggal buka kunci |
| R21 (rendah) | **Ditutup** | Gerbang tangga latar: "SEMUA upaya LOGIN_REQUIRED" menjadi "MAYORITAS upaya LOGIN_REQUIRED (>50%), tanpa OK" (keputusan parent 18:43 WIB) |
| I24 (info) | **Ditutup** | Fase cap/probe push dibungkus try/catch `failCountsUnavailable` (refund + 500 jelas), pola I23 |
| I27 (info) | **Ditutup** | Batas timeout tes tangga retry dinaikkan (kehabisan 60 dtk, jeda 30 dtk, skip 15 dtk); asersi tidak dilonggarkan |
| I30 (info) | **Ditutup** | Guard `typeof URL.revokeObjectURL === 'function'` di ekspor backup (noise jsdom hilang) |
| I28 (info) | **Ditunda** | Fungsi Vercel dormant, tanpa rencana wiring - 5 catatan dicatat sebagai utang di §8 |
| I29 (info) | **Diterima** | Tradeoff urutan pra-cek vs rate limit sudah benar - tanpa perubahan kode |

## §1. S14 + I25 + I26 - Sapu tombstone ditagih, eksak, tanpa yatim (satu paket)

### Sebelum
`pruneOldTombstones` (`workers/sync/src/index.js`, I22) menulis
tanpa tagihan anggaran: DELETE tombstone (sampai 100/koleksi/push)
+ UPDATE penghitung (1 per playlist berbeda) tidak pernah
menyentuh anggaran tulis 20.000. Red 7 mengoreksi volume Blue 6
§8: dump stok tombstone penuh menelan sampai **~210.200 tulis**
(110.100 DELETE + ~100.100 UPDATE penghitung - sampel 100 item
bisa mencakup 100 playlist berbeda), dengan persiapan **~42 hari**
(12 hari anggaran buat+tombstone + 30 hari penuaan wajib).
Decrement penghitung memakai ukuran sampel (`ids.length` /
`found.length`), sehingga dua push bersamaan mengurangi dua kali
untuk tombstone yang sama (I25, TERBUKTI Red 7 di SQLite).
Sapu playlist tidak menghapus itemnya, meninggalkan item yatim
permanen: tidak pernah di-pull, tidak pernah disapu, tidak
terhapus saat hapus akun (I26, TERBUKTI Red 7 di SQLite).

### Sesudah (prune ditulis ulang, `index.js:1684`, 3 fase)
- **Fase 1 - sampling (tanpa tulis):** sampel playlist dulu,
  hitung item per playlist yang disapu (satu GROUP BY), lalu
  sampel suka + item. Sampel item MENGECUALIKAN playlist yang
  disapu push ini (`AND playlist_id NOT IN (...)`) supaya biaya
  yang sama tidak dihitung dua kali. Cap total sapu
  `TOMBSTONE_PRUNE_MAX_ROWS_PER_PUSH = 1.000` baris (termasuk
  item): playlist diambil berurutan sampai cap; **satu playlist
  penuh (1.000 item) selalu disapu utuh (1.001 baris)** supaya
  tidak pernah macet di cap.
- **Fase 2 - cadangan atomik (S14):** biaya PERSIS dihitung dari
  sampel (hapus + UPDATE penghitung + 1 upsert cadangan itu
  sendiri), lalu dicadangkan dengan upsert berkondisi yang sama
  seperti reservasi push, SEBELUM DELETE apa pun. Bila cadangan
  gagal (anggaran habis), sapu push ini DILEWATI dan push tetap
  jalan (`pruned: 0`). Bila tidak ada yang disapu, tidak ada
  cadangan (biaya 0). Maksimum cadangan **1.203**
  (1.000 hapus + 202 UPDATE + 1); satu playlist penuh 1.004.
- **Fase 3 - eksekusi (I25 + I26):** decrement memakai
  `res.meta?.changes` dari DELETE di ketiga cabang (playlist,
  suka, item). Item dihapus PER PLAYLIST (satu DELETE per
  playlist lewat `db.batch` = satu round trip) supaya decrement
  per playlist eksak. Cabang playlist ikut menghapus item dari
  playlist yang disapu (I26a) + mengurangi penghitung items per
  playlist. UPDATE penghitung dilewati bila `changes` 0.
  Fungsi mengembalikan jumlah baris yang disapu (0 bila
  dilewati/gagal); pemanggil melaporkannya di respons push
  (`pruned`, `index.js:2626`, tipe `PushData.pruned?` di
  `app/src/sync/syncClient.ts`).
- **Sabuk pengaman (I26b):** delete handler ikut menghapus item
  yatim (`DELETE ... WHERE user_id = ? AND playlist_id NOT IN
  (SELECT id FROM sync_playlists)`, posisi ke-2 dari 12
  pernyataan batch, selagi playlist masih ada - hanya item yang
  benar-benar yatim yang kena).

### Aritmetika sesudah perbaikan
Invarian "semua tulis ditagih" pulih penuh: total tulis per akun
per hari kembali dibatasi anggaran 20.000 (sapu kini menelan
anggaran yang sama dengan membuatnya - dump sapu mustahil).
Siklus serang S14 (±42 hari persiapan) tidak lagi menghasilkan
dump: stok tetap bisa disiapkan, tetapi menyapunya menelan
anggaran sendiri. Pengguna normal tidak kelebihan-tagih:
cadangan memakai hitungan persis, bukan batas atas.

### Tes (semua di `app/src/worker/syncWorker.test.ts`, describe Blue 7)
- **S14 tagihan persis:** 50 tombstone playlist, push 1 playlist
  → `pruned` 50, anggaran 59 (7 push + 52 sapu: 50 hapus +
  1 UPDATE + 1 cadangan), penghitung 51.
- **S14 cadangan gagal:** anggaran tersisa persis 7 → push 200,
  `pruned` 0, tombstone utuh 50, penghitung 100 (hanya bump),
  anggaran 20.000.
- **S14 cap 1.000:** 2 playlist tombstone x 600 item → `pruned`
  601, playlist ke-2 + 600 itemnya utuh, anggaran 611
  (7 + 604).
- **S14 playlist penuh:** 1 playlist tombstone + 1.000 item →
  `pruned` 1.001, yatim 0, anggaran 1.011 (7 + 1.004).
- **I25 balapan:** D1 `RacingPruneD1` menyela pesaing (hapus 50
  tombstone + decrement 50) persis di antara sampling dan DELETE
  → push ini `pruned` 0, penghitung 51 (100 - 50 - 0 + 1; tanpa
  `meta.changes` menjadi 1), anggaran 59. Catatan metodologi:
  dua push bersamaan TIDAK bisa dipakai untuk tes ini -
  `crypto.subtle.digest` async di `authUser` memecah lockstep
  microtask sehingga push pertama selalu selesai dulu (terbukti
  saat mencoba: anggaran 66, bukan 118); injeksi deterministik
  pola I21 adalah cara yang benar.
- **I26a:** playlist tombstone (10 item hidup + 2 tombstone item)
  + playlist hidup (3 tombstone item) → `pruned` 16, yatim 0,
  penghitung items 0 dan 6, anggaran 30 (10 push + 20 sapu).
- **I26b:** 7 item yatim + data normal → hapus akun: `items.size`
  0, `deleted_rows` 21 (termasuk 7 yatim).
- **Verifikasi SQL lokal** (SQLite 3.45.1, `/tmp/blue7-sql.db`,
  skema 0001–0007): GROUP BY hitung item pl-old = 12; sampel
  item dengan pengecualian = 3 (bukan 5); cadangan 20 sesudah
  7 → 27 (`changes=1`), cadangan 19.974 gagal (`changes=0`);
  DELETE playlist `changes=1`, item pl-old `changes=12`,
  cabang item `changes=3`; hapus yatim `changes=2`, yatim 0.

## §2. S13 - Cooldown daftar ulang sebanding ukuran akun

### Sebelum
Batch hapus akun menghapus SEMUA baris pengguna tanpa batas dan
tanpa tagihan: akun di batas penuh menulis **111.209 baris**
dalam satu panggilan (angka eksak satu hari, terverifikasi tes:
100.000 item + 100 playlist + 10.000 suka + 1.000 riwayat +
1 settings + 103 penghitung + 1 anggaran tulis + 1 stempel +
1 anggaran baca + 1 sesi + 1 user; Red 7 menulis ~111.210
dengan ~6 baris anggaran lintas hari - selisih tidak material),
melebihi kuota tulis harian bersama 100.000 sendirian.
Persiapan 6 hari di laju maksimal; cooldown 24 jam membuat
siklus serang ~8 hari per satu hari kuota mati.

### Sesudah
- **Kolom baru `deleted_rows`** di `sync_deleted_identities`
  (migrasi `workers/sync/migrations/0007_blue7_deleted_rows.sql`,
  SATU ALTER TABLE; **diterapkan koordinator, bukan Blue 7**).
  Delete handler menjumlahkan `meta.changes` dari 12 pernyataan
  DELETE batch (11 lama + 1 yatim I26b) dan mencatatnya di
  tombstone sesudah batch (`index.js:2836,2884`). Tombstone
  tetap ditulis SEBELUM batch (urutan Blue 6 dipertahankan:
  identitas terblokir walau batch gagal di tengah), dengan
  `deleted_rows` 0 dulu lalu diperbarui (1 UPDATE, best-effort).
- **Cooldown sebanding** (`reRegisterCooldownMs`,
  `index.js:729`): 24 jam + 1 hari per 20.000 baris di atas
  20.000, maks 30 hari (= retensi tombstone). Akun normal
  (≤20.000 baris) tetap 24 jam; akun penuh 111.209 baris
  mendapat **6 hari** (24 jam + 5 hari). Batas terverifikasi:
  0 → 1 hari, 20.000 → 1 hari, 20.001 → 2 hari, 40.000 → 2 hari,
  40.001 → 3 hari, 111.209 → 6 hari, 580.001+ → 30 hari (cap).
- **Redirect membawa tanggal buka kunci**
  (`reason=deleted-recently&until=<tanggal ISO>`,
  `index.js:904`); klien menyebut tanggal itu
  (`settingsAccountDeletedRecentlyUntil`, `id.ts:337`;
  `formatUnlockDate`, `SettingsPage.tsx:53` - parse tanggal
  lokal supaya tidak bergeser sehari di zona barat UTC;
  tanpa `until`/tidak valid → pesan "besok" lama).
  Query `until` ikut dibersihkan dari URL.

### Aritmetika sesudah perbaikan
Siklus serang menjadi ~13 hari per satu hari kuota mati
(6 persiapan + 1 dump + 6 cooldown), dan harga dump sebanding
kerusakannya. Sisa risiko (diterima, terdokumentasi): satu
identitas yang sangat tekun MASIH bisa mematikan kuota satu
hari per ~13 hari; menutupnya total butuh hapus bertahap
asinkron - **tindak lanjut pasca-RC, TIDAK dikerjakan Blue 7**.

### Tes
- **S13 akun kecil:** login → hapus (2 baris: 1 sesi + 1 user)
  → daftar ulang ditolak 302 dengan `until` = hapus + 24 jam
  (tanggal ISO eksak dari tombstone); +25 jam berhasil.
- **S13 akun penuh:** seed 100 playlist + 100.000 item + 10.000
  suka + 1.000 riwayat + settings + 103 penghitung + anggaran +
  stempel → hapus → `deleted_rows` **111.209**; +25 jam MASIH
  ditolak dengan `until` = hapus + 6 hari; +6 hari 1 jam
  berhasil.
- **E2E** (`blue6-settings.spec.ts`, Chromium nyata): tes baru
  `until=2026-11-25` menampilkan "Akun ini baru saja dihapus.
  Kamu bisa masuk lagi tanggal 25 November 2026." + query
  dibersihkan (termasuk `until`); tes lama "besok" tetap lolos.

## §3. R21 - Gerbang tangga retry menjadi mayoritas LOGIN_REQUIRED

### Sebelum
`isLoginRequiredOnly` (`app/src/resilience/retryLadder.ts`)
mensyaratkan SEMUA upaya `=LOGIN_REQUIRED`. Satu upaya
`UNPLAYABLE` saja membatalkan tangga latar. Pola campuran
TERBUKTI NYATA (probe parent 19 Nov 2026 15:57 WIB:
`WEB_REMIX=UNPLAYABLE` + `ANDROID_VR=LOGIN_REQUIRED` untuk
video kanari yang diketahui bagus), dan tiga lapis kode lain
(retry cepat P6 `isRefusalPlayability`, klasifikasi
`errors.ts` → `refused`, sinyal kanari `recent-fail`)
sama-sama mendefinisikan "penolakan" LEBIH LONGGAR dari tangga.

### Sesudah (keputusan parent 19 Nov 2026 18:43 WIB)
`isLoginRequiredOnly` (`retryLadder.ts:139`): tangga mulai (dan
lanjut) bila **MAYORITAS upaya adalah LOGIN_REQUIRED**
(>50% dari `allAttempts`), **tanpa satu pun upaya OK**.
`UNPLAYABLE` tetap dihitung sebagai penolakan (konsisten
`isRefusalPlayability`); upaya proxy/jaringan/solver tidak
menghalangi bila mayoritas tetap LOGIN_REQUIRED. Satu upaya OK
berarti setidaknya satu client lolos bot-check - bukan jendela
buruk. Lagu semua-UNPLAYABLE (0 LOGIN_REQUIRED) tetap gagal
cepat. Nama fungsi dipertahankan (gerbang yang sama, ambang
yang berubah); kedua titik pakai (gerbang mulai
`service.ts:1124` + gerbang lanjut `service.ts:1319`) ikut
aturan baru. Komentar `service.ts` diperbarui; perilaku lain
tangga (backoff, penjaga jeda, kanari) TIDAK diubah.
Biaya pelonggaran terbatas: video campuran yang ternyata
permanen hanya menelan maks 6 request tambahan + penantian
maks ~7 menit yang bisa di-skip kapan saja.
Catatan: `docs/retry-ladder.md` §2.3/§7 masih mendokumentasikan
aturan ketat lama - **di luar cakupan Blue 7, untuk koordinator**
(lihat §9).

### Tes
- `retryLadder.test.ts` (12 → 15): mayoritas 2/3 dengan satu
  UNPLAYABLE → benar; mayoritas tipis 5/9 → benar; minoritas
  1/3, seri 1/2, 4/9 → salah; OK hadir walau mayoritas LR →
  salah; proxy/jaringan/solver gagal dengan mayoritas LR →
  benar; semua-UNPLAYABLE → salah; kosong → salah.
- `service.retryLadder.test.ts` (15 → 17): tes campuran lama
  dipertajam menjadi MINORITAS (1 dari 3 client → 3/9, tanpa
  tangga); tes baru MAYORITAS (2 dari 3 client → 6/9, tangga
  mulai, tenggat +60 dtk); tes baru percobaan latar campuran
  mayoritas (2 LR + 1 UNPLAYABLE → maju ke langkah 5 mnt,
  lalu lolos, total 13 request).

## §4. I24 - Fase cap/probe push dibungkus refund

### Sebelum
Fase cap/probe push (`capNewEntries` playlist/suka/riwayat,
`playlistOwned`, probe item) berjalan TANPA try/catch sesudah
reservasi anggaran: galat D1 transien di sana lolos ke router
dan push gagal 500 generik `SERVER_ERROR` TANPA refund
(pengguna kehilangan paling banyak satu tagihan push, maks
1.911 anggaran, 9,6% anggaran harian).

### Sesudah
Seluruh fase (`index.js:2150-2371`) dibungkus satu try/catch
yang mengembalikan `failCountsUnavailable(db, user.id, day,
reservedCharge)` - pola yang sama persis seperti I23.
`skippedNotOwned` dipindahkan ke luar try (dipakai respons).
Cadangan sapu (S14) TIDAK di-refund di jalur ini: sapu sudah
jalan dan barisnya benar-benar terhapus. Blok penghitung item
di dalamnya (I23a) tidak berubah.

### Tes
`throwOnCapProbe` (flag FakeD1 baru): probe melempar → 500
`SYNC_TEMPORARILY_UNAVAILABLE` + `budgetUsed` 0; coba lagi
sesudah pulih → 200, tagihan 7.

## §5. I27 - Tes tangga retry distabilkan (bukan bug produk)

Batas timeout dinaikkan, asersi TIDAK dilonggarkan:
kehabisan 30 → **60 dtk**, jeda 20 → **30 dtk**, skip
(default 5 dtk) → **15 dtk** (`service.retryLadder.test.ts`).
Alasan: tes kehabisan memajukan ~400 dtk jam palsu + ~400
detak watchdog 1 dtk yang masing-masing kerja nyata (17,8 dtk
waktu nyata di run sepi - headroom hanya 1,7x terhadap 30 dtk).

## §6. I30 - Noise jsdom `revokeObjectURL` (trivial, dikerjakan)

Guard satu baris di `app/src/backup/service.ts`:
`typeof URL.revokeObjectURL === 'function'` sebelum memanggil.
Run penuh Vitest tidak lagi mencatat "Errors 1 error"
(terverifikasi: `service.test.ts` 16/16 tanpa noise).

## §7. Perubahan FakeD1 (infrastruktur tes, bukan produk)

`app/src/worker/syncWorker.test.ts` (3.828 → 4.556 baris):
- Tipe tombstone + `deleted_rows`; cabang INSERT/UPDATE/SELECT
  tombstone diperbarui (0007).
- `lastChanges` eksak di SEMUA cabang DELETE (prune +
  hapus akun + clear riwayat + sesi/user/anggaran) - tadinya
  0 di sebagian besar cabang.
- Cabang baru: DELETE item per playlist (`playlist_id = ?`,
  I26a), DELETE item yatim (`NOT IN (SELECT id ...)`, I26b).
- Sampel item menangani bentuk `NOT IN` (limit = bind terakhir,
  pengecualian disaring).
- Flag baru `throwOnCapProbe` (I24).
- Seed literal tombstone Blue 6 diperbarui (+ `deleted_rows: 0`).

## §8. Yang ditunda / diterima

- **I28 (fungsi Vercel dormant): DITUNDA** - fungsi TIDAK
  di-wiring ke app (vonis DITOLAK JUGA, tanpa rencana wiring).
  5 catatan Red 7 dicatat sebagai utang yang WAJIB dibenahi
  SEBELUM wiring apa pun: (1) IP dari entri pertama
  `X-Forwarded-For` bisa dipalsukan - pakai entri terakhir /
  header khusus Vercel; (2) jalur `?ping=1` lolos rate limit -
  pindahkan sesudah rate limit / hapus; (3) tanpa cek
  `responded` sesudah await - tambah `if (responded) return;`;
  (4) tanpa `X-Content-Type-Options: nosniff` - tambah di semua
  respons; (5) cleanup bucket O(n) per request saat map >10.000
  - batasi probabilitas / eviksi paksa.
- **I29 (pra-cek sebelum rate limit): DITERIMA** - urutan saat
  ini adalah tradeoff yang benar (memindahkan rate limit ke
  depan membuka lagi S12a); sisi baca D1 bukan vektor independen
  (butuh membakar seluruh kuota Workers dulu). Tanpa perubahan.
- **Hapus bertahap asinkron (penutup total S13): PASCA-RC** -
  bukan Blue 7, sesuai putusan Red 7.

## §9. Verifikasi

- **Vitest penuh: 857/857, 52 file** (baseline 842 + 15 baru:
  10 syncWorker + 3 retryLadder + 2 service.retryLadder;
  109,79 dtk, tanpa timeout). Tidak ada tes yang dihapus /
  dilonggarkan; 1 tes campuran lama dipertajam (minoritas) +
  2 tes mayoritas baru (R21, perubahan perilaku yang disengaja).
- **Worker sync:** `syncWorker.test.ts` **88/88** (78 + 10).
  **Proxy:** `rateLimit.test.ts` **11/11** + `s7-unit-test.mjs`
  **20/20**. **Tangga:** `retryLadder.test.ts` **15/15** +
  `service.retryLadder.test.ts` **17/17**.
- **E2E Playwright (Chromium nyata):** `blue6-settings.spec.ts`
  **3/3** (termasuk tes tanggal S13 baru) + `retry-ladder.spec.ts`
  **3/3** + `smoke.spec.ts` **1/1** = **7/7** (1,8 mnt).
- **Typecheck** `tsc -b` bersih (0 galat); **lint penuh**
  `npm run lint` bersih (0 galat, 0 warning).
- **Verifikasi SQL lokal** (SQLite 3.45.1, `/tmp/blue7-sql.db`):
  migrasi 0001–0007 terap bersih; 6 bagian (§1) semua lolos.
- **Aritmetika cooldown** terverifikasi di batas-batas (§2).
- **Build** `npm run build` sukses; **bundle awal 175.832 byte
  gzip** dari batas 204.800 (sisa 28.968; naik 33 dari baseline
  175.799 - perubahan app hanya 1 string + edit chunk lazy
  SettingsPage + guard backup; gate CI lolos).
- **Tidak ada `api.spotify.com`** di file yang disentuh
  (diperiksa dengan grep). Kode spike poToken TIDAK disentuh
  (tidak dibaca pun tidak perlu); cron laras-resolve-watch
  TIDAK disentuh.
- Catatan lingkungan: run penuh pertama gagal di gelombang
  TERBATAS (Vite tidak bisa `mkdir node_modules/.vite-temp`;
  symlink ke `/tmp/p5-vite-temp` menggantung karena /tmp
  dibersihkan reboot) - diperbaiki dengan `mkdir -p
  /tmp/p5-vite-temp` (perbaikan lingkungan, bukan kode).
  Satu run gabungan worker sempat gagal 1 tes lalu lolos 99/99
  di dua run ulang (flaky beban, bukan regresi).

## §10. Langkah koordinator yang masih diperlukan

1. **Terapkan migrasi 0007 SEBELUM redeploy worker sync:**
   `wrangler d1 execute laras-web-sync --file=workers/sync/migrations/0007_blue7_deleted_rows.sql --remote`
   (atau `wrangler d1 migrations apply`). Tanpa 0007, worker
   fail-open ke perilaku Blue 6 (cooldown tetap 24 jam, tanpa
   tanggal buka kunci). Migrasi 0007 terverifikasi terap bersih
   di atas 0001–0006 (SQLite lokal).
2. Redeploy worker sync (proxy TIDAK berubah ronde ini).
3. Push + deploy preview seperti biasa.
4. **TIDAK ADA** perluasan metadata `deploy_sync.py` - tidak ada
   scheduled handler / trigger cron baru.
5. Perbarui `docs/retry-ladder.md` §2.3/§7 (aturan ketat "semua
   LOGIN_REQUIRED" sudah diganti mayoritas oleh R21) - di luar
   cakupan Blue 7.
6. Verifikasi live dengan akun uji (dari Red 7 §8, bukan Blue 7):
   hapus + daftar ulang dalam cooldown harus mengembalikan
   `reason=deleted-recently&until=<tanggal>`; hapus akun penuh
   (bila ada akun uji bermuatan) harus mencatat cooldown
   sebanding; wipe ujung-ke-ujung; pemantauan kuota D1
   (peringatan 50%/80%, baca+tulis).
7. Tindak lanjut pasca-RC: hapus bertahap asinkron (penutup
   total S13); benahi fungsi Vercel (I28) bila ada rencana
   wiring; data frekuensi pola campuran dari
   laras-resolve-watch untuk mengukur manfaat R21.

## Berkas yang diubah

| Berkas | Perubahan |
| ------ | --------- |
| `workers/sync/migrations/0007_blue7_deleted_rows.sql` | **Baru** (21 baris): satu ALTER TABLE `deleted_rows` |
| `workers/sync/src/index.js` | S13/S14/I24/I25/I26 (2.733 → 3.034 baris) |
| `workers/sync/README.md` | Checklist 0007 + paragraf batas Blue 7 |
| `app/src/worker/syncWorker.test.ts` | FakeD1 Blue 7 + 10 tes baru (3.828 → 4.556 baris) |
| `app/src/resilience/retryLadder.ts` | R21: gerbang mayoritas + tanpa OK |
| `app/src/resilience/retryLadder.test.ts` | R21: 12 → 15 tes |
| `app/src/player/service.ts` | Komentar gerbang mayoritas (tanpa perubahan kode perilaku) |
| `app/src/player/service.retryLadder.test.ts` | R21 (15 → 17 tes) + I27 (timeout 60/30/15 dtk) |
| `app/src/strings/id.ts` | +1 string `settingsAccountDeletedRecentlyUntil` |
| `app/src/components/settings/SettingsPage.tsx` | Wiring pesan `deleted-recently&until=` |
| `app/src/sync/syncClient.ts` | `PushData.pruned?` (observabilitas sapu) |
| `app/src/backup/service.ts` | I30: guard `revokeObjectURL` |
| `app/tests/e2e/blue6-settings.spec.ts` | +1 tes E2E pesan bertanggal S13 (2 → 3) |
| `app/tests/spikes/s7-unit-result.json` | Diregenerasi saat menjalankan s7-unit-test (artefak tes) |
| `docs/blue7-red7-fixes.md` | Laporan ini |
