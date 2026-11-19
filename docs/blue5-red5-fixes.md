# Blue 5 — Perbaikan Temuan Audit Red 5

19 November 2026. Remote HEAD saat kerja: 5196078a (Blue 4).
Semua 5 temuan Red 5 ditutup. **Tidak ada push / deploy oleh Blue 5** —
koordinator yang memverifikasi, menerapkan migrasi, push, dan deploy.

## Ringkasan

| Temuan | Tingkat | Status | Bukti utama |
|---|---|---|---|
| S8 — `historyClearedBefore` membuka lagi pembakaran kuota tulis | Sedang (wajib RC) | **Ditutup** | Gerbang clear 24 jam + anggaran tulis 20.000 baris/hari/akun; tes siklus 25×, tes 429 |
| S9 — COUNT + `fetchKeys` per push membakar kuota baca | Sedang (wajib RC) | **Ditutup** | Tabel penghitung + probe terbatas ≤100 kunci/koleksi; penyerang maks ~6% kuota baca |
| R19 — COUNT + upsert tidak atomik | Rendah | **Ditutup** | Guard-WHERE per pernyataan berbasis penghitung; terverifikasi di SQLite + tes balapan |
| R20 — `lyrics.setEnabled` tanpa cek `stale()` | Rendah | **Ditutup** | Satu baris cek + tes wipe-di-antara-await |
| I20 — cap item dihitung sebelum cek kepemilikan | Info | **Ditutup** | Cek kepemilikan dipindah sebelum cap; tes notOwned |

## Verifikasi (semua dijalankan 19 Nov 2026)

| Pemeriksaan | Hasil |
|---|---|
| Vitest penuh (`--configLoader runner --pool=threads`) | **784/784 lolos** (50 berkas; baseline 771 + 13 baru, tanpa tes dihapus/dilonggarkan) |
| Tes worker sync (`app/src/worker/syncWorker.test.ts`) | **60/60 lolos** (49 lama + 11 baru Blue 5) |
| Tes klien sync (`app/src/sync/syncService.test.ts`) | **22/22 lolos** (20 lama + 2 baru Blue 5) |
| Tes unit proxy (`tests/spikes/s7-unit-test.mjs`) | **20/20 lolos** |
| Typecheck (`tsc -b`) | 0 galat |
| Lint (`eslint .`) | 0 galat |
| Bundle awal gzip (metrik gerbang CI: JS dirujuk `dist/index.html`) | **174.815 byte** dari batas 204.800 (sisa 29.985; naik 3 byte dari 174.812) |
| Chunk `*TestPage*` di dist | 0 |
| E2E Playwright `tests/e2e/p8.spec.ts` (Chromium, server dev API Vite port 4173) | **6/6 lolos** |
| Verifikasi SQL di SQLite lokal 3.45.1 | Semua 5 perilaku terverifikasi (lihat §6) |

---

## 1. S8 — Pembakaran kuota tulis lewat clear riwayat (SEDANG, wajib)

### Masalah (Red 5)
Riwayat satu-satunya koleksi tanpa tombstone: satu push memasukkan 100
baris lalu DELETE keras menghapus semuanya di batch yang sama, sehingga
COUNT push berikutnya selalu 0. Satu akun menguras 100 ribu baris/hari
dalam ~17 menit (DELETE dihitung) atau ~33 menit (tidak).

### Perbaikan — dua lapis pertahanan, keduanya menutup aritmetikanya

**Lapis (a) — gerbang frekuensi clear riwayat.**
Clear dihonori paling sering **sekali per 24 jam per pengguna**.
Stempel clear terakhir disimpan di tabel baru `sync_user_meta`
(`workers/sync/migrations/0005_sync_quotas.sql`). Clear yang terlalu
sering **diabaikan dengan respons jelas** (`historyClearIgnored: true`
+ `historyClearRetryAfterSeconds`), bukan diam-diam. Alasan angka 24
jam: menghapus riwayat adalah tindakan sadar yang jarang; sekali sehari
jauh melampaui kebutuhan sah, dan gerbang ini menutup siklus S8 bahkan
tanpa anggaran. Klien mempertahankan penanda clear lokal bila server
mengabaikannya, sehingga clear sahih dicoba lagi di sinkronisasi
berikutnya (`app/src/sync/syncService.ts:388,415,431`).

**Lapis (b) — anggaran tulis harian per akun (item §4.3 Blue 4, kini
wajib).** Tabel baru `sync_write_budget` (user_id, day YYYY-MM-DD,
rows_written). Setiap push **memesan** anggarannya dulu secara atomik
(`INSERT ... ON CONFLICT DO UPDATE ... WHERE ... <= 20000`, satu
pernyataan — tanpa race), baru menjalankan batch. Tagihan push =
entri body (termasuk yang dilewati / bukan milik pendorong, supaya
push "gratis" tidak bisa membakar kuota baca) + pengaturan 1 + clear
1.000 (maks baris DELETE) + tunjangan pembukuan
`2*(koleksi skalar tak kosong + playlist item berbeda) + 3`.
Tagihan maks per push **1.909 baris**. Melewati anggaran → **429
`DAILY_WRITE_BUDGET_EXCEEDED` + header `Retry-After` sampai tengah
malam UTC + pesan bahasa Indonesia yang jelas**
(`workers/sync/src/index.js:1130-1190`).

### Aritmetika kuota S8

- Anggaran: **20.000 baris/hari/akun** = **20% kuota tulis bersama**
  (100.000 baris/hari). Satu akun sendirian **mustahil** menguras
  kuota; butuh 5 akun yang kompak menghabiskan anggaran penuh.
- Longgar untuk pemakaian normal: sinkronisasi penuh akun di batas
  koleksi skalar (100 playlist + 10.000 suka + 1.000 riwayat +
  ~1.000 item + pengaturan/hapus ≈ **12.100 baris**) masih menyisakan
  ~40% anggaran. Sudut ekstrem (100 playlist × 1.000 item = 100.000
  item) tersinkron bertahap selama ~5 hari karena push sudah terpecah
  per 100 entri dan sinkronisasi bersifat inkremental — kemajuan
  parsial tersimpan, bukan gagal total.
- Siklus S8 lama (insert 100 + clear, berulang): tiap siklus menelan
  ≥105 anggaran dan clear kedua diabaikan gerbang 24 jam — siklus
  mati di dua lapis sekaligus.

### Yang diubah

- `workers/sync/migrations/0005_sync_quotas.sql` — tabel
  `sync_write_budget` + `sync_user_meta` (baru).
- `workers/sync/src/index.js:101` (`DAILY_WRITE_BUDGET = 20000`),
  `:107` (`HISTORY_CLEAR_MIN_INTERVAL_MS = 24 jam`),
  `:1046` (`secondsUntilMidnightUtc`), `:1090` (gerbang clear S8a),
  `:1130-1190` (reservasi anggaran atomik + 429 S8b),
  `:1699` (respons `historyClearIgnored`), `:1817` (hapus akun ikut
  menghapus tabel 0005).
- `app/src/sync/syncClient.ts:131-133` — tipe respons
  `historyClearIgnored?` / `historyClearRetryAfterSeconds?`.
- `app/src/sync/syncService.ts:68-73,388,415,431` — penanda clear
  dipertahankan bila server mengabaikan.
- `workers/sync/README.md` — paragraf batas + checklist deploy
  (0005 WAJIB diterapkan sebelum deploy worker pasca-Blue-5).

### Tes yang membuktikan

`app/src/worker/syncWorker.test.ts` (FakeD1 diperluas: peta
`counts`/`writeBudget`/`userMeta`, penghitung baris baca +
penghitung COUNT, cabang reservasi anggaran/penghitung/meta):

- `:2186` — clear kedua dalam 24 jam diabaikan, data tidak terhapus.
- `:2238` — siklus insert 100 + clear 25×: riwayat mentok di 1.000,
  anggaran terpakai **tepat 3.625** (= 1.105 + 24×105).
- `:2266` — anggaran habis: 28×712 = 19.936 lalu push berikut 429
  (kode + Retry-After benar); push kecil masih jalan; sesudah +25 jam
  (fake timer) hari berganti dan push bisa lagi.
- `app/src/sync/syncService.test.ts:676` — penanda hapus riwayat
  dipertahankan bila `historyClearIgnored: true`, dihapus bila
  dihonori.

---

## 2. S9 — Pembakaran kuota baca lewat COUNT + `fetchKeys` (SEDANG, wajib)

### Masalah (Red 5)
Pengguna di batas suka 10.000: tiap push berharga COUNT 10.000 +
`fetchKeys` 10.000 = 20.000 baris dibaca; 30 push/mnt = 600 ribu/mnt,
kuota 5 juta baris/hari habis ~8 menit.

### Perbaikan — kedua sumber baca tak terbatas ditutup

**Dipilih: tabel penghitung** (bukan cache memori isolate).
Cache isolate ditolak: perkalian isolate membuka lagi lubangnya
(setiap isolate baru COUNT ulang tanpa batas). Tabel `sync_counts`
(user_id, collection, playlist_id, n, updated_at) memberi **1 baris
baca per koleksi per push**, diperbarui bersama upsert di batch yang
sama. Increment penghitung diletakkan **PALING AWAL di batch**
(`index.js:1472`) supaya arah melencengnya aman: penghitung hanya
bisa kelebihan-hitung (menolak penambahan sahih), tidak pernah
kekurangan-hitung (yang akan mengizinkan over-cap).

**Probe terbatas.** `capNewEntries` ditulis ulang: hanya memeriksa
kunci dari entri yang didorong (`SELECT key ... WHERE user_id = ?
AND key IN (...kunci body, maks 100...)`), jadi baca per push
≤100 baris per koleksi, bukan 10.000. Riwayat memakai row-value IN
`(video_id, played_at) IN (...)` — eksak, tanpa cross-product
(terverifikasi di SQLite).

**Rekonsiliasi bila penghitung melenceng.** COUNT ulang dipicu bila:
n < 0 (sentinel sesudah clear — DELETE keras membuat penghitung
tidak valid, jadi clear menulis n = −1), n > cap + 30 (melenceng ke
atas), atau umur > 24 jam DAN dalam 500 baris dari cap. Baris
penghitung yang hilang → COUNT sekali + simpan (terbatas: sekali per
pengguna/koleksi/playlist selamanya; tulis simpannya ditanggung
tunjangan pembukuan anggaran S8). Konstanta:
`index.js:112-114`.

### Aritmetika kuota S9 (baca terikat anggaran tulis)

Kuncinya: **baca terikat pada anggaran tulis S8** — push yang
banyak membaca juga mahal anggarannya, jadi perkalian naif
"maks baca/push × 43.200 push/hari" tidak berlaku.

- Rasio terburuk ≈ **6–7 baris baca per baris anggaran**
  (push 1 entri: 3 penghitung skalar + probe 1 + meta 1 + anggaran 1).
- Push kosong pun ditagih **3 anggaran** (lantai tagihan), jadi maks
  ~6.666 push/hari — bukan 43.200.
- Batas atas satu penyerang per hari:
  20.000 anggaran × ~7 baca ≈ 140.000
  + baca push kosong ≈ 40.000
  + rekonsiliasi (suka 10.000 + playlist 100 + riwayat 1.000 +
  item ≤100.000/hari) ≈ 111.000
  ≈ **~300.000 baris baca/hari ≈ 6% kuota bersama 5 juta** —
  jauh di bawah target 50% (dan di bawah 55 baris/push rata-rata
  yang diminta tugas: rata-rata efektif ≈ 7 baris/push).
- Bukti empiris (FakeD1 yang menghitung baris baca): update 1 suka
  pada pengguna penuh (10.000 suka) membaca **≤10 baris**; 100
  update berurutan membaca **≤110 baris** dengan **0 COUNT** —
  bandingkan 20.000 baris/push sebelum perbaikan. Baca 10 suka vs
  10.000 suka **identik** (tidak tumbuh dengan ukuran tabel).

### Yang diubah

- `workers/sync/migrations/0005_sync_quotas.sql` — tabel
  `sync_counts` (baru) + backfill dari data yang ada.
- `workers/sync/src/index.js:112-114` (konstanta rekonsiliasi),
  `:867-1050` (helper: `countItemsForPlaylist`,
  `countItemsPerPlaylist` kini difilter pengguna,
  `readScalarCounters`, `readItemCounters`, `storeCount`,
  `reconcileCount`, `resolveCount`, `capNewEntries` baru,
  `secondsUntilMidnightUtc`), `:1472` (increment penghitung di awal
  batch), `:1521` (`applied` hanya menghitung pernyataan data,
  bukan pembukuan).
- Fail-open dipertahankan (konsisten dengan pola rate-limit /
  OAuth-state yang ada): bila tabel 0005 belum ada, worker jatuh
  ke jalur COUNT S7 + insert tanpa guard + anggaran/meta fail-open,
  dengan `console.warn`. S8/S9 terbuka lagi hanya di jendela
  urutan-deploy itu — makanya migrasi WAJIB diterapkan dulu.

### Tes yang membuktikan

`app/src/worker/syncWorker.test.ts`:

- `:2346` — push pada pengguna penuh (10.000 suka): 1 update ≤10
  baris baca, 100 update ≤110 baris, 0 COUNT.
- `:2396` — baca tidak tumbuh dengan ukuran tabel (10 vs 10.000 suka
  identik).
- `:2441` — penghitung benar: 50 masuk dari headroom 50, lalu
  mentok di 10.000; kelebihan dilewati + dilaporkan.
- `:2491` — penghitung pulih sesudah clear (sentinel −1 → COUNT
  ulang sekali, penghitung → 50).
- `:2533` — penghitung melenceng (5.000) memicu rekonsiliasi (→ 100).
- `:2561` — tanpa tabel penghitung, push tetap jalan via COUNT
  (fail-open).

---

## 3. R19 — COUNT + upsert tidak atomik (RENDAH)

### Masalah (Red 5)
30 push bersamaan sama-sama lolos COUNT lalu masing-masing
memasukkan 100 entri baru (sampai ~3.000 playlist, 30× batas).

### Perbaikan — guard-WHERE per pernyataan (terbukti layak)

Setiap INSERT entri baru kini dijaga klausa WHERE berbasis
penghitung:

```sql
INSERT INTO ... SELECT ... WHERE
  (SELECT COALESCE(n, 0) FROM sync_counts
    WHERE user_id = ? AND collection = ? AND playlist_id = ?)
  - ? + ? < ?
```

dengan bind guard (ditempel sesudah nilai baris):
`userId, collection, playlistId, delta, k, cap` — rumusnya
`(penghitung − delta + k) < cap`, disesuaikan delta milik push
itu sendiri supaya entri ke-k dari push yang sama tidak saling
memblokir. Pernyataan batch D1 dieksekusi berurutan dalam satu
koneksi, jadi pernyataan belakangan melihat tulisan sebelumnya —
**terverifikasi di SQLite lokal** (lihat §6): push bersamaan kedua
terblokir total (`changes` 0), push berikutnya merekonsiliasi
penghitung (150 → 51). Guard hanya untuk entri baru; update entri
lama memakai upsert polos (tidak menambah jumlah).

Catatan: anggaran S8 membatasi ledakan total R19 bahkan tanpa guard
(maks 20.000 baris/hari/akun), tetapi guard menutupnya per
pernyataan — batas koleksi ditegakkan atomik, bukan sekadar dibatasi
dampaknya.

### Yang diubah

- `workers/sync/src/index.js:1541` (playlist), `:1581` (item),
  `:1612` (suka), `:1643` (riwayat) — INSERT terjaga; `:1472`
  (increment penghitung di awal batch, arah melenceng aman).

### Tes yang membuktikan

- `app/src/worker/syncWorker.test.ts:2592` — subclass FakeD1 menaikkan
  penghitung di tengah batch (simulasi balapan): semua insert terjaga
  terblokir; push berikutnya merekonsiliasi 150 → 51.

---

## 4. R20 — `lyrics.setEnabled` tanpa cek `stale()` (RENDAH)

### Masalah (Red 5)
Cabang pengaturan `applyPull`: `lyrics.setEnabled`
(`app/src/sync/syncService.ts:175`) menulis meta IndexedDB tanpa cek
`stale()`, padahal dua penulisan di sekitarnya punya cek. Wipe di
antara dua await bisa membangkitkan preferensi lirik di database segar.

### Perbaikan

Satu baris: `if (stale()) return;` tepat sebelum
`lyrics.setEnabled` (`app/src/sync/syncService.ts:179-185`,
beserta komentar penjelas). Kini ketiga penulisan di cabang
pengaturan (EQ → lirik → penanda appliedAt) masing-masing dijaga
cek generasi sesudah await sebelumnya.

### Tes yang membuktikan

- `app/src/sync/syncService.test.ts:390` — spy pada
  `getPlayerService().applySyncedEqSettings` membatalkan generasi
  (simulasi wipe); menegaskan meta lirik tidak ditulis,
  `isEnabled()` tetap true, appliedAt tetap 0.

---

## 5. I20 — Cap item dihitung sebelum cek kepemilikan (INFO)

### Masalah (Red 5)
`skippedOverLimit` bisa membocorkan perkiraan jumlah item playlist
orang lain — cap item dihitung SEBELUM cek kepemilikan.

### Perbaikan

Urutan dibalik: cek kepemilikan dulu (`index.js:1363-1370`), hitung
cap sesudahnya (`:1308` dan seterusnya). Item ke playlist yang bukan
milik pendorong ditolak sebagai `notOwned` tanpa menyentuh
perhitungan cap — tidak ada baris penghitung yang dibuat untuk
playlist korban, dan tidak ada bocoran jumlah lewat
`skippedOverLimit`.

### Tes yang membuktikan

- `app/src/worker/syncWorker.test.ts:2652` — 100 item ke playlist
  orang lain: `skippedOverLimit.playlistItems` 0, tidak ada baris
  penghitung untuk playlist korban.

---

## 6. Migrasi D1 0005 + verifikasi SQLite lokal

Berkas: `workers/sync/migrations/0005_sync_quotas.sql` (81 baris).
**Koordinator yang menerapkan ke D1 `laras-web-sync` — WAJIB
sebelum redeploy worker sync pasca-Blue-5** (worker fail-open ke
COUNT tanpa tabel ini).

| Tabel | Kolom kunci | Keterangan |
|---|---|---|
| `sync_counts` | `user_id, collection, playlist_id, n, updated_at` (PK ketiganya; CHECK collection ∈ playlists/likes/history/items) | Penghitung S9; backfill dari data yang ada |
| `sync_write_budget` | `user_id, day (TEXT YYYY-MM-DD), rows_written` (PK keduanya) | Anggaran S8; reset 00:00 UTC (hari baru = baris baru) |
| `sync_user_meta` | `user_id (PK), history_cleared_at` | Stempel clear terakhir S8a |

Verifikasi di SQLite lokal 3.45.1 sebelum menulis kode (skrip di
`/tmp/blue5-sql-verify.sql`, `/tmp/blue5-mig-verify.sql` — artefak
sementara, tidak di repo):

1. Reservasi anggaran atomik `INSERT...ON CONFLICT DO UPDATE...
   WHERE jumlah<=20000`: changes 1/1/0, nilai mentok di 19.701.
2. Increment penghitung via upsert bekerja.
3. Guard-WHERE: k0/k9 lolos, push bersamaan B terblokir
   (changes 0), upsert-melalui-guard bekerja.
4. Row-value IN `(video_id, played_at) IN (...)` eksak (2 baris,
   tanpa cross-product).
5. Pernyataan berurutan di satu koneksi melihat tulisan sebelumnya.
6. Migrasi 0005 diterapkan bersih di atas 0001–0004; backfill benar
   (data benih: playlist 2, suka 2, riwayat 1, item p1 2, p2 1).
7. `EXPLAIN` 9 kueri baru: semua SEARCH lewat indeks/PK,
   **nol table SCAN**.

---

## 7. Yang ditunda / di luar cakupan (untuk Red 6 / koordinator)

1. **Pembakaran baca lewat `/api/sync/pull` (tidak diperbaiki).**
   Pull (30/mnt/pengguna, kunci rate-limit yang sama) bisa
   mengembalikan sampai ~4.000 baris/pull (4×LIMIT 1000); 43.200
   pull/hari × ~3.100 baris ≈ 134 juta — kelas yang sama dengan S9
   tetapi endpoint berbeda, bukan salah satu dari 5 temuan yang
   ditugaskan. Klaim aritmetika S9 di laporan ini **hanya mencakup
   push**. Rekomendasi: Red 6 membuka temuan tersendiri untuk pull
   (mis. anggaran baca pull per akun, atau LIMIT total per pull).
2. **Tulis rate-limit (residual, desain Blue 1 S3).**
   `isRateLimited` menulis 1 baris per permintaan sync; satu pengguna
   di 30/mnt membakar 43.200 baris tulis/hari lewat baris rate-limit
   saja. Kasus terburuk jujur per akun: 20.000 anggaran push +
   43.200 rate-limit = **63.200 baris (63% kuota tulis bersama)** —
   masih di bawah 100.000 sendirian, tetapi marginnya lebih tipis
   dari 20% anggaran push saja. Rekomendasi: rate-limit berbasis
   memori/TTL atau penghitung teragregasi (di luar cakupan Blue 5).
3. **Permukaan UI klien untuk sinyal server baru (ditunda).**
   `skippedOverLimit`, `historyClearIgnored`, dan pesan 429 sudah
   mengalir ke klien (tipe di `syncClient.ts`), tetapi belum
   ditampilkan ke pengguna sebagai pesan di UI — penanda clear
   dipertahankan diam-diam dan sinkronisasi berikutnya mencoba lagi.
   Alasan: tidak ada spek copy UI untuk ketiga sinyal ini dan tidak
   ada temuan Red 5 yang memintanya; perubahan perilaku diam-diam
   sudah benar (tidak ada data hilang, tidak ada kesalahan sunyi
   yang merusak). Bila koordinator menginginkan pesan UI, itu
   pekerjaan tampilan kecil terpisah.
4. **Tidak ada perubahan skema selain 0005.** Tidak ada perubahan
   pada worker proxy, alur OAuth, atau batas koleksi (§4.3
   arsitektur tidak berubah).

---

## 8. Langkah koordinator yang masih diperlukan

1. **Terapkan migrasi** `workers/sync/migrations/0005_sync_quotas.sql`
   ke D1 `laras-web-sync` — **SEBELUM** redeploy worker sync.
   (Worker fail-open tanpa tabel ini; S8/S9 tidak aktif sampai
   migrasi diterapkan.)
2. **Redeploy worker sync** (`workers/sync/`).
3. **Push** ke `adiprmx/laras-web` (Blue 5 tidak push).
4. **Deploy preview** dan verifikasi: push normal jalan, clear
   riwayat pertama dihonori, clear kedua diabaikan dengan respons
   jelas, penghitung terisi (`SELECT * FROM sync_counts LIMIT 5`
   — hitungan agregat, bukan data sesi/token pengguna).
5. Teruskan §7 butir 1–2 ke Red 6 sebagai temuan kandidat
   (pull read-burning, tulis rate-limit).

---

## 9. Berkas yang diubah (ringkasan)

| Berkas | Perubahan |
|---|---|
| `workers/sync/migrations/0005_sync_quotas.sql` | Baru (81 baris): `sync_counts`, `sync_write_budget`, `sync_user_meta` + backfill |
| `workers/sync/src/index.js` | 1.307 → 1.873 baris: S8a, S8b, S9, R19, I20, hapus akun |
| `workers/sync/README.md` | Paragraf batas + checklist deploy 0005 |
| `app/src/sync/syncClient.ts` | Tipe respons `historyClearIgnored?` / `historyClearRetryAfterSeconds?` |
| `app/src/sync/syncService.ts` | R20 (cek `stale()`), penanda clear S8, tipe `SyncDeps.push` |
| `app/src/worker/syncWorker.test.ts` | 1.918 → 2.704 baris: FakeD1 diperluas + 11 tes baru |
| `app/src/sync/syncService.test.ts` | + 2 tes baru (R20, S8 klien) |
| `docs/blue5-red5-fixes.md` | Laporan ini |

Catatan: `app/tests/spikes/s7-unit-result.json` diregenerasi tiap
run tes worker — itu artefak, abaikan perubahannya.
