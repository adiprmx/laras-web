# Blue 6 — Perbaikan Temuan Red 6

**Tanggal:** 19 Nov 2026. **Remote HEAD:** `b5edcf7e` (Blue 5).
**Status: keenam temuan DITUTUP** (S10 + S11 wajib terpenuhi).
**Tidak di-push, tidak di-deploy** — koordinator yang memverifikasi,
menerapkan migrasi 0006, push, dan deploy.

Kuota bersama (arsitektur §2.1): D1 **100.000 baris tulis/hari**,
**5.000.000 baris baca/hari**. Anggaran per akun (Blue 5):
tulis 20.000/hari; Blue 6 menambah baca 40.000/hari.

| Temuan | Status | Inti perbaikan |
| ------ | ------ | -------------- |
| S10 (sedang, wajib) | **Ditutup** | Rate limit hapus 3/jam/IP + 1/jam/akun; tombstone identitas (hash + angka); cooldown daftar-ulang 24 jam; warisan anggaran + stempel |
| S11 (sedang, wajib) | **Ditutup** | Query pull item filter `i.user_id` langsung (EXPLAIN terverifikasi 2 skala); anggaran baca 40.000/hari/akun |
| S12 (rendah) | **Ditutup** | Pra-cek anggaran sebelum rate limit; baris rate-limit ditagih ke anggaran tulis; SELECT dulu (request yang sudah dibatasi tidak menulis); **+ tagihan tulis pull 4/pull (lubang baru ditemukan saat verifikasi, lihat §3)** |
| I21 (info) | **Ditutup** | `storeCount` compare-and-swap + fallback MAX atomik |
| I22 (info) | **Ditutup** | Sapu tombstone malas (lazy prune) tiap push — tanpa cron, tanpa perubahan deploy |
| I23 (info) | **Ditutup** | Penghitung item fail-open ke COUNT; refund anggaran bila push gagal |

## §0. Koreksi atas Red 6: tidak ada auto-sync tiap 20 detik

Red 6 menghitung laju serang dengan asumsi "auto-sync tiap 20 detik".
**Asumsi itu salah:** di `app/src` tidak ada `setInterval` untuk sync
sama sekali. Sync jalan sekali 20 detik sesudah aplikasi dimuat
(one-shot `setTimeout` di `App.tsx`), sesudah redirect OAuth
(`?auth=ok`), atau manual lewat tombol Pengaturan. Pengguna normal
hanya melakukan segelintir pull/hari — ini yang membuat desain
anggaran baca S11 (cadangan + refund per pull) terjangkau, dan
membuat tagihan tulis pull 4/pull (§3) tidak terasa pengguna normal.

## §1. S10 — Hapus akun + daftar lagi me-reset anggaran

### Sebelum
Anggaran terikat `user_id`; delete menghapus semua tabel 0005;
daftar ulang dapat UUID baru. Satu manusia + satu akun Google
menguras kuota tulis 100.000 dalam ~6–10 menit (~7 siklus ×
~15.400 baris). `/api/auth/delete` tanpa rate limit.

### Sesudah (tiga lapis, semuanya diimplementasikan)
- **(a) Rate limit hapus** — `workers/sync/src/index.js:163-165`
  (konstanta), `:2487-2509` (penegakan):
  `delete-ip:<ip>` **3/jam**, `delete-acct:<user.id>` **1/jam**,
  jendela 1 jam, 429 + `Retry-After: 3600`. Alasan angka: hapus
  akun adalah tindakan sekali seumur hidup akun; 3/jam/IP memberi
  ruang satu rumah tangga/NAT yang menghapus beberapa akun
  berdekatan, 1/jam/akun menahan percobaan ulang bila hapus gagal
  di tengah (akun yang berhasil dihapus tidak bisa dihapus lagi
  karena sesinya sudah hilang). Jendela per jam didukung
  `windowStartFor(nowMs, windowMs)` + `isRateLimited(..., windowMs)`
  di `workers/proxy/src/rateLimit.js:47,67` (dipakai bersama proxy).
- **(b) Tombstone identitas + warisan anggaran** — migrasi
  `workers/sync/migrations/0006_blue6_quotas.sql:1-30` (tabel
  `sync_deleted_identities`); tulis tombstone di delete handler
  `index.js:2516-2570`; baca + warisan di callback
  `index.js:830-861`; helper `identityHashFor` (`:685`),
  `readDeletedIdentity` (`:690`), `restoreFromTombstone` (`:729`).
  Tombstone menyimpan **hanya** SHA-256 dari
  `"provider:provider_id"` + `deleted_at` + `budget_day` +
  `budget_rows` + `read_rows` + `history_cleared_at` — tanpa nama,
  email, atau data pengguna apa pun (persyaratan privasi).
  Dipilih warisan-di-pendaftaran (bukan re-keying tabel anggaran
  ke hash identitas) supaya hot path push byte-identik dan
  binding ditegakkan di satu-satunya titik `user_id` berubah.
  Warisan anggaran hanya bila `budget_day` sama dengan hari UTC
  daftar-ulang (sesudah cooldown 24 jam hari selalu berganti —
  cabang ini pertahanan berlapis bila cooldown gagal ditegakkan);
  stempel clear selalu diwariskan. Tombstone dikonsumsi (dihapus)
  saat dipakai, dan disapu malas bila >30 hari
  (`index.js:832-840`, 1 pernyataan best-effort tiap pendaftaran
  baru).
- **(c) Cooldown daftar-ulang 24 jam** — `index.js:178`
  (`RE_REGISTER_COOLDOWN_MS`), penegakan `:842-844`:
  daftar ulang dalam 24 jam ditolak dengan redirect
  `?auth=error&reason=deleted-recently`. Dipilih **tolak**
  (bukan izinkan-tapi-warisi): penolakan juga menutup reset
  anggaran BACA lewat daftar-ulang, dan cooling-off 24 jam
  adalah UX standar dengan pesan jelas. Pesan klien:
  string baru `settingsAccountDeletedRecently`
  (`app/src/strings/id.ts:333`) + wiring
  `app/src/components/settings/SettingsPage.tsx:93-94,107-108,184`
  ("Akun ini baru saja dihapus. Kamu bisa masuk lagi besok.").
  Catatan wilayah: SettingsPage di luar wilayah terdaftar Blue 6
  (tidak ada tim lain yang menyentuhnya; tidak ada tes untuknya
  sebelum ini) — perubahan minimal, hanya untuk pesan ini.
- Delete juga menghapus `sync_read_budget` (`index.js:2590`).

### Aritmetika sesudah perbaikan
Satu identitas: maks **20.000 tulis/hari** (anggaran) + ~13 baris
hapus + ~4 baris tombstone ≈ 20.020/hari = **20% kuota**.
Daur ulang identitas yang sama diblokir 24 jam; daur ulang
identitas BARU dibatasi 3/jam/IP. **Butuh 5 identitas terkoordinasi
untuk menguras kuota** — bar yang sama dengan klaim asli S8
(5 akun), dan tiap identitas butuh akun Google/GitHub berbeda +
menunggu cooldown. Satu manusia tidak lagi bisa melakukannya
sendirian dalam hitungan menit.

### Tes (semua di `app/src/worker/syncWorker.test.ts`, describe Blue 6)
- `:3112` hapus + daftar ulang dalam 24 jam → 302
  `reason=deleted-recently`, `users.size` tetap 0.
- `:3134` daftar ulang sesudah 25 jam berhasil; anggaran hari lama
  TIDAK diwariskan (hari berganti); tombstone dikonsumsi.
- `:3170` warisan tombstone (white-box): tombstone 25 jam lalu
  dengan `budget_day` hari ini, 19.999 tulis + 39.999 baca +
  stempel clear → daftar ulang mewarisi ketiganya, tombstone
  dikonsumsi, lalu push 1 like → 429 `DAILY_WRITE_BUDGET_EXCEEDED`
  dan pull → 429 `DAILY_READ_BUDGET_EXCEEDED`.
- `:3218` hapus ke-4 dari satu IP dalam sejam → 429 +
  `Retry-After: 3600`; akun ke-4 tidak terhapus.
- `:3238` hapus ke-2 satu akun dalam sejam → 429 (walau hapus
  ke-1 gagal 500 karena batch D1 sesaat).
- `:3265` privasi: sesudah hapus, users/playlists/items/likes/
  history/settings/counts/sessions/anggaran/stempel = 0; hanya
  tombstone tersisa, kuncinya SHA-256 `'google:google-1'`, dan
  serialisasinya tidak mengandung provider_id mentah / nama.
- E2E `app/tests/e2e/blue6-settings.spec.ts:27,40` (Chromium nyata,
  2/2): pesan khusus tampil untuk `reason=deleted-recently`,
  pesan umum untuk reason lain; query dibersihkan dari URL.

## §2. S11 — Pull read-burning

### (a) Perbaikan query (EXPLAIN terverifikasi, SQLite 3.45.1, 2 skala)
Query pull item baru (`index.js:982`): filter `i.user_id = ?`
langsung (kolom + `idx_items_user` dari 0004); JOIN ke playlist
hanya lookup PK untuk `client_id`.

| | SEBELUM (`p.user_id`) | SESUDAH (`i.user_id`) |
|---|---|---|
| Skala kecil (10 playlist / 1.000 item) | `SCAN p` + `SEARCH i USING INDEX idx_items_updated (playlist_id=? AND updated_at>?)` + `USE TEMP B-TREE FOR ORDER BY` | `SEARCH i USING INDEX idx_items_user (user_id=? AND updated_at>?)` + `SEARCH p USING INDEX sqlite_autoindex_sync_playlists_1 (id=?)`, tanpa temp b-tree |
| Skala besar (100 playlist / 100.000 item) | sama (scan + temp b-tree) | sama (index seek + PK lookup) |

Himpunan hasil identik (0 selisih dua arah di kedua skala).
Benih + query: `/tmp/blue6-seed-small.sql`, `/tmp/blue6-seed-big.sql`,
`/tmp/blue6-explain.sql` (artefak verifikasi, bukan deliverable).

### (b) Anggaran baca pull
- Konstanta `index.js:138,144`: `DAILY_READ_BUDGET = 40.000`,
  cadangan per pull `4.002` (= 4 × 1.000 + settings 1 + 1 baris
  rate-limit). Cadangan atomik SEBELUM query
  (`index.js:927-968`, upsert berkondisi seperti S8b); refund
  selisih sesudah query (`:1003-1025`, dilewati bila 0).
  Melewati anggaran → 429 `DAILY_READ_BUDGET_EXCEEDED` +
  `Retry-After` sampai tengah malam UTC. Tabel
  `sync_read_budget` di migrasi 0006 (tabel baru — dipilih atas
  generalisasi `sync_write_budget` karena semantiknya berbeda:
  baca punya refund per pull, tulis tidak).
- **Aritmetika angka 40.000:** sinkronisasi penuh akun di batas
  skalar ≈ 12.101 baris (100 playlist + 1.000 item + 10.000 suka
  + 1.000 riwayat + settings; koreksi Red 6: 12.643–14.623
  termasuk overhead) → anggaran mengizinkan **~2,7–3,2× sinkronisasi
  penuh/hari**. Akun ekstrem 100.000 item (111.101 baris)
  tersinkron inkremental ~3 hari — simetris dengan ~6 hari yang
  dibutuhkan untuk mendorongnya. Satu akun = **0,8% kuota baca
  5 juta**; butuh **125 akun** yang kompak menghabiskan anggaran
  penuh untuk membunuh kuota (sebelum: 1 akun, 49 pull, ~1,6 menit
  pada 100.000 item; 226 pull ~7,5 menit pada 20.000 item;
  1.612 pull ~54 menit pada 1.000 item).

### Tes
- `syncWorker.test.ts:3333` pull hanya mengembalikan item milik
  pemanggil (1.000 item sendiri, 0 dari pengguna lain).
- `:3367` pull penuh (3.101 baris kembali, tagihan bersih 3.102)
  × 12 jalan (37.224), ke-13 → 429 + `Retry-After` ≤ 86400;
  besok (+25 jam) pull jalan lagi. Juga mengasersi tagihan tulis
  pull 12 × 4 = 48 (§3).
- `:3451` batas persis: anggaran terpakai 36.000 → 429
  (36.000 + 4.002 > 40.000); 35.998 → 200, bersih 35.999.
- Verifikasi SQL reservasi/refund di SQLite lokal
  (`/tmp/blue6-sql-verify.sql`, 6 bagian, semua lolos): 9 × 4.002
  = 36.018 lalu ke-10 gagal (`changes=0`); refund 36.018 − 3.997
  = 32.021.

## §3. S12 — Tulis rate-limit residual

### Sebelum
`isRateLimited` menulis 1 baris per request termasuk yang sudah
dibatasi. Per akun 63.200/hari (20.000 anggaran + 43.200 baris
rate-limit); 2 akun > kuota dalam ~19 jam.

### Sesudah
- **(b) SELECT dulu** — `workers/proxy/src/rateLimit.js:67-108`
  (ditulis ulang): SELECT hitungan dulu; bila sudah > limit,
  tolak TANPA menulis; bila belum, UPSERT lalu baca ulang untuk
  vonis eksak di bawah konkurensi (race tersisa fail-closed:
  dua request di batas bisa sama-sama ditolak, tidak pernah
  sama-sama lolos). Retensi sapu diubah ke **1 jam**
  (`:41`, `SWEEP_RETENTION_MS = MAX_WINDOW_MS`) — jendela
  terpanjang di sistem — supaya sapu proxy tidak menghapus baris
  jendela per jam (hapus akun); satu kunci aktif memegang paling
  banyak ~60 baris menit.
- **(a) Tagih ke anggaran tulis + pra-cek router** —
  `index.js:1480` (`computePushCharge`, termasuk +1 baris
  rate-limit; tagihan maks per push kini **1.911**, mengoreksi
  1.909 Blue 5 → 1.910 Red 6 → 1.911); router memeriksa anggaran
  SEBELUM `checkRateLimit` (`:2611-2660` pull, `:2667-2722` push)
  sehingga request yang pasti ditolak tidak menulis baris
  rate-limit. Body push dibaca di router (`parsePushBody`,
  `:1450`) supaya pra-cek memakai tagihan persis; sudut sempit
  yang didokumentasikan: pra-cek memakai batas ATAS (clear
  ditagih penuh bila diminta) — push di ambang anggaran + clear
  yang diabaikan gerbang 24 jam bisa ditolak pra-cek walau
  tagihan persisnya muat (pengguna kehilangan sisa <1.000
  anggaran hari itu; diterima, hanya di ambang + clear diabaikan).
  Rate limit login/callback/me memakai kunci IP tanpa akun —
  untuknya hanya (b) yang berlaku, sesuai spesifikasi.
- **Tagihan tulis pull (lubang baru, ditemukan Blue 6 saat
  verifikasi — BUKAN di Red 6):** anggaran baca saja tidak
  membatasi JUMLAH pull. Pull kosong menagih bersih 1 baris baca
  (cadangan 4.002, refund 4.001) tapi menulis 3 baris D1
  (rate-limit + reservasi + refund) → 36.000 pull kosong =
  108.000 tulis: satu akun masih bisa membunuh kuota tulis.
  Perbaikan: tiap pull ditagih **4 baris anggaran tulis**
  (`PULL_WRITE_CHARGE`, `index.js:153`; reservasi atomik di
  `handlePull` `:889-920`; pra-cek router `:2630-2648`) —
  menutup semua tulis yang disebabkan satu pull (rate-limit 1 +
  cadangan tulis 1 + cadangan baca 1 + refund 1). Pull + push
  kini berbagi anggaran 20.000. Pengguna normal (~5 pull/hari =
  20 baris) tidak terasa; sinkronisasi penuh (~10 pull = 40
  baris) tidak terasa.

### Aritmetika sesudah perbaikan
Per akun/hari: push + pull berbagi anggaran tulis 20.000
(termasuk semua baris rate-limit + cadangan + refund);
tulis di luar anggaran yang tersisa: hapus akun (~13 baris,
dibatasi 1/jam/akun) + sapu tombstone (§5, dibatasi stok yang
sudah dibayar) + kebocoran race pra-cek↔reservasi (beberapa
baris, bukan per volume penyerang). Total ≈ **20.030/hari** —
**butuh 5 akun terkoordinasi** untuk menguras kuota 100.000
(sebelum: 2 akun, ~19 jam).

### Tes
- `rateLimit.test.ts:143` (S12b): 70 panggilan batas 60 →
  hitungan tersimpan 61 (bukan 70); `:157` jendela per jam batas 1;
  `:207` sapu menahan baris 2 menit (retensi 1 jam); tes sapu lama
  diperbarui (baris lama kini 2 jam, bukan 2 menit).
- `syncWorker.test.ts:3472` 35 pull cepat → baris rate-limit
  berhenti di 31; `:3504` pull kehabisan anggaran tulis → 429
  `DAILY_WRITE_BUDGET_EXCEEDED` tanpa baris rate-limit (dan sisa
  4 persis → lolos, habis tepat 20.000); `:3530` push yang pasti
  ditolak anggaran → 429 tanpa baris rate-limit.
- Angka eksak S8 diperbarui karena +1/push (perubahan perilaku,
  bukan pelonggaran): tes siklus 3.625 → **3.650**
  (1.106 + 24×106); tes anggaran 19.936 → **19.964** (28×713),
  sisa 64 → 36.

## §4. I21 — Race rekonsiliasi COUNT + storeCount

### Sebelum
`storeCount` menimpa absolut. Bump push bersamaan yang mendarat
di antara COUNT dan store ditimpa nilai COUNT basi → penghitung
turun di bawah jumlah nyata → cap longgar ~100 baris per kejadian.

### Sesudah
`storeCount` menjadi compare-and-swap (`index.js:1297-1335`):
`INSERT ... ON CONFLICT DO UPDATE ... WHERE sync_counts.n = ?
AND sync_counts.updated_at = ?` memakai baris yang dibaca
`resolveCount` (`reconcileCount` kini menerima baris itu,
`:1336-1365`). Bila CAS gagal (0 baris berubah), satu pernyataan
atomik `UPDATE ... SET n = MAX(n, ?)` menyimpan max(nilai
tersimpan, nilai hitung). **Dipilih MAX + satu percobaan** (bukan
baca-ulang + hitung-ulang): COUNT ulang sesudah CAS gagal membuka
lagi jendela race yang sama tanpa batas, sementara MAX satu
pernyataan bersifat atomik dan langsung benar (nilai tersimpan
sudah mencakup bump yang menyela; bila COUNT lebih besar — mis.
baris dibuat tanpa bump — MAX memakai COUNT). Arah melenceng yang
aman adalah penghitung TERLALU TINGGI (hanya menolak penambahan
sah, tidak pernah mengizinkan pelampauan batas). Koreksi drift
ke bawah tetap jalan: CAS sukses menulis nilai COUNT persis
(mis. 5.000 → 100, terverifikasi di SQLite lokal). Baris yang
belum ada saat dibaca memakai `MAX(sync_counts.n, excluded.n)`
pada konflik (bump yang menyela dipertahankan).
Verifikasi SQL (`/tmp/blue6-sql-verify.sql`): CAS basi `changes=0`,
penghitung tetap 10.000 (bukan 9.900); MAX mempertahankan 10.000;
CAS cocok `changes=1` mengoreksi 5.000 → 100; baris hilang
di-INSERT dengan benar.

### Tes
`syncWorker.test.ts:3555` — `RacingFakeD1` menyela bump +100 suka
+ 100 suka nyata persis di antara COUNT dan store: penghitung
akhir 10.001 (10.000 race + 1 bump sendiri, BUKAN 9.901);
guard-WHERE memblokir insert (`likes.size` tetap 10.000);
push susulan dilewati cap (`skippedOverLimit.likes` 1).

## §5. I22 — Tombstone server tidak pernah dibersihkan

### Keputusan: sapu malas (opsi b), BUKAN cron
Dipilih lazy prune: tiap push menghapus paling banyak 100
tombstone berumur >30 hari per koleksi **yang disentuh push itu**
(`pruneOldTombstones`, `index.js:1601-1695`; pemanggilan `:1816`,
sesudah reservasi anggaran, sebelum fase cap). Alasan: tanpa
perubahan deploy (tanpa scheduled handler, tanpa trigger wrangler,
tanpa perluasan metadata `deploy_sync.py` koordinator), tanpa job
diam-diam-gagal; cap hanya penting saat mendorong, jadi sapu
saat mendorong adalah titik yang tepat. Sapu memakai indeks baru
0006 (`idx_playlists_user_deleted`, `idx_likes_user_deleted`,
`idx_items_user_deleted` — pemakaian indeks terverifikasi
`EXPLAIN QUERY PLAN` di SQLite lokal, sampel mengembalikan persis
tombstone lama, bukan yang baru).
Tombstone **dihitung** di `sync_counts` (terverifikasi) — karena
itu sapu mengurangi penghitung sejumlah yang terhapus
(`UPDATE ... SET n = MAX(0, n - ?)`, tanpa INSERT supaya tidak
membuat baris 0 untuk pengguna yang belum punya baris).
Tulis sapu TIDAK ditagih ke anggaran push: jumlahnya dibatasi
tombstone yang sudah ada (tiap tombstone menelan anggaran saat
dibuat), dan penghapusan massal lewat hapus akun sudah merupakan
jalur yang lebih cepat — sapu tidak membuka kelas serang baru.
Lihat residual §8 untuk batas analisis ini.

### Tes
`syncWorker.test.ts:3648` — 50 hidup + 50 tombstone lama (31 hari)
+ 1 tombstone baru (1 hari), penghitung di cap 100 → push 1
playlist baru: tombstone lama hilang, penghitung 51
(100 − 50 + 1), applied 1, tombstone baru bertahan.
`:3687` — sapu item mengurangi penghitung per playlist (100 → 51).

## §6. I23 — Penghitung item fail-closed + anggaran hangus saat push gagal

### (a) Fail-open disamakan
Blok penghitung item dibungkus try/catch seperti skalar
(`index.js:2055-2090`): gagal baca → fallback `countItemsPerPlaylist`
(COUNT); bila COUNT juga gagal → 500 yang JELAS
`SYNC_TEMPORARILY_UNAVAILABLE` + refund (bukan diam-diam).
Fallback COUNT skalar dibungkus sama (`:1905-1914`), begitu pula
cabang else COUNT item (`:2083-2087`). Helper
`failCountsUnavailable` (`:1577`).

### (b) Refund, bukan pindah-tagihan
Dipilih **refund tepat sebesar reservasi push itu**
(`refundWriteBudget`, `index.js:1559-1576`; pemanggilan batch
`:2356`, jalur penghitung `:1912,2079,2086`). Alasan: reservasi
HARUS sebelum batch supaya push bersamaan tidak bisa sama-sama
lolos sesudah anggaran habis (TOCTOU S8b); memindahkan pemotongan
ke sesudah batch sukses membuka lagi race itu. Refund tidak bisa
menggandakan anggaran: dipanggil sekali per push yang gagal,
tanpa retry, dijaga lantai 0 (`MAX(0, rows_written - ?)`),
tepat sebesar reservasi push itu (terverifikasi di SQLite:
5.000 − 712 = 4.288; kelebihan-refund dilantai 0).
Catatan yang didokumentasikan di kode: `db.batch` bukan transaksi
atomik — bila batch gagal DI TENGAH, sebagian pernyataan sudah
diterapkan sementara anggaran dikembalikan penuh. Diterima:
kegagalan mid-batch adalah galat D1 (transien/kuota), bukan
sesuatu yang bisa dipicu penyerang per pernyataan (validasi body
+ guard-WHERE membuat pernyataan gagal-validasi tidak pernah
masuk batch; CHECK settings tidak bisa gagal sesudah validasi
byte-length worker karena karakter ≤ byte di UTF-8), dan
"gratis" yang didapat dibatasi satu push per kegagalan.

### Tes
`syncWorker.test.ts:3731` — `throwOnItemCounters` → COUNT fallback,
push 200, item ke playlist penuh dilewati, ke playlist kosong
diterapkan. `:3773` — penghitung + COUNT sama-sama gagal → 500
`SYNC_TEMPORARILY_UNAVAILABLE` + `budgetUsed` 0 (refund),
coba lagi sesudah pulih → 200, tagihan 7. `:3798` — batch gagal
→ 500 + refund, coba lagi → 200 dengan satu tagihan (7).

## §7. Batas baca S9 tetap berlaku sesudah perubahan

Perubahan Blue 6 menambah baca per push: pra-cek anggaran (+1
SELECT), rate limit kini 2 SELECT (pra + pasca, +1), sampel sapu
(+0 baris bila tidak ada tombstone lama). Tes batas S9 yang ada
(mengasersi batas, bukan angka eksak) tetap lolos tanpa perubahan:
push 1 update ≤ 10 baca, push 100 update ≤ 110 baca, tanpa COUNT
(`syncWorker.test.ts` suite Blue 5, 60/60 hijau).

## §8. Residual yang ditemukan Blue 6 (BUKAN temuan Red 6 — untuk Red 7)

Dua jalur tulis tidak ditagih anggaran yang ditemukan saat
verifikasi aritmetika, didokumentasikan jujur di sini (bukan
disembunyikan), keduanya bermitigasi biaya-persiapan:

1. **Hapus akun bermuatan penuh (~111.200 tulis sekali).** Batch
   hapus menghapus semua baris pengguna; akun di batas penuh
   (100 playlist + 100.000 item + 10.000 suka + 1.000 riwayat)
   menulis ~111.200 baris dalam satu hapus ≈ seluruh kuota harian.
   Mitigasi: membangun data itu menelan ≥111.101 anggaran tulis
   (~6 hari di batas maksimal) — penyerang sudah menghabiskan
   6 hari × 20% kuota sebelum bisa melakukan dump sekali ini;
   hapus dibatasi 1/jam/akun + 3/jam/IP; daftar ulang terkunci
   24 jam + mewarisi anggaran. Perbaikan sejati (hapus bertahap
   asinkron / antrean) adalah perubahan desain besar — keputusan
   koordinator + Red 7.
2. **Dump stok tombstone via sapu (~110.100 tulis sekali).**
   Sapu I22 tidak ditagih; penyerang yang sudah menyiapkan
   110.100 tombstone (≥6 hari di batas maksimal, tiap tombstone
   menelan anggaran saat dibuat) bisa menyapu semuanya dalam
   sehari lewat ~1.100 push. Mitigasi sama: stok terbatas pada
   yang sudah dibayar saat pembuatan (rasio steady-state ~14
   anggaran per 1 tulis sapu — penyerang merugi); dump hanya
   sekali per stok. Opsi Red 7: tagih sapu ke anggaran
   (perlu cadangan pra-sapu atau tunjangan tetap per push).

Di luar itu, jalur tulis yang tersisa sudah ditagih atau dibatasi
laju per IP (login/callback/me: baris rate-limit + state OAuth,
dibatasi 10–30/menit/IP oleh S12b — desain pra-Red 6, di luar
cakupan temuan ini).

## §9. Yang ditunda

**Tidak ada temuan Red 6 yang ditunda** — keenamnya ditutup.
Satu celah kecil yang sengaja tidak ditutup (didokumentasikan,
bukan diabaikan): bila query probe (kunci/kepemilikan) melempar
SESUDAH reservasi anggaran, push gagal tanpa refund (di luar
cakupan I23 — I23 mencakup blok penghitung + batch; probe gagal
adalah galat D1 transien yang sama langkanya, dan pengguna
kehilangan paling banyak satu tagihan push).

## §10. Verifikasi

- **Vitest penuh: 842/842, 52 file** (baseline 820 + 22 baru:
  18 syncWorker + 4 rateLimit). Tidak ada tes yang dihapus /
  dilonggarkan; 2 angka eksak S8 diperbarui karena perubahan
  perilaku yang disengaja (+1 baris rate-limit/push, §3).
- **Worker sync:** `syncWorker.test.ts` 78/78.
  **Proxy:** `rateLimit.test.ts` 11/11 + `s7-unit-test.mjs` 20/20.
- **E2E Playwright (Chromium nyata):** `blue6-settings.spec.ts`
  2/2 + `smoke.spec.ts` 1/1 (sanity harness).
- **Typecheck** `tsc -b` bersih; **lint** bersih untuk file yang
  disentuh. (Sempat ada 5 galat TS: `rateLimit.d.ts` belum
  mendeklarasikan parameter `windowMs` baru — diperbaiki di
  `workers/proxy/src/rateLimit.d.ts`.)
- **EXPLAIN QUERY PLAN** sebelum vs sesudah di SQLite 3.45.1
  pada 2 skala (§2a); verifikasi SQL reservasi/refund/CAS/sapu
  di SQLite lokal (6 bagian, semua lolos).
- **Build** `npm run build` sukses; **bundle awal 175.799 byte
  gzip** dari batas 204.800 (sisa 29.001; naik 984 dari baseline
  174.815 — perubahan app hanya 1 string + edit chunk lazy
  SettingsPage; gate CI lolos).
- **Tidak ada `api.spotify.com`** di file yang disentuh
  (diperiksa dengan grep).

## §11. Langkah koordinator yang masih diperlukan

1. **Terapkan migrasi 0006 SEBELUM redeploy worker sync:**
   `wrangler d1 execute laras-web-sync --file=workers/sync/migrations/0006_blue6_quotas.sql --remote`
   (atau `wrangler d1 migrations apply`). Tanpa 0006, worker
   fail-open ke perilaku Blue 5 (S10/S11 kembali terbuka).
   Migrasi 0006 terverifikasi terap bersih di atas 0001–0005
   (SQLite lokal).
2. Redeploy worker sync + proxy (proxy memakai `rateLimit.js`
   yang ditulis ulang — perilaku kompatibel, retensi sapu 1 jam).
3. Push + deploy preview seperti biasa.
4. **TIDAK ADA** perluasan metadata `deploy_sync.py` — I22
   memilih lazy prune (tanpa scheduled handler / trigger cron).
5. Putuskan tindak lanjut §8 (residual hapus-akun + dump sapu)
   bersama Red 7 — bukan pemblokir rilis (mitigasi biaya-persiapan
   sudah quantified di atas).

## Berkas yang diubah

| Berkas | Perubahan |
| ------ | --------- |
| `workers/sync/migrations/0006_blue6_quotas.sql` | **Baru** (70 baris): `sync_deleted_identities`, `sync_read_budget`, 3 indeks sapu |
| `workers/sync/src/index.js` | S10/S11/S12/I21/I22/I23 (2.667 → 2.733 baris) |
| `workers/proxy/src/rateLimit.js` | Ditulis ulang: SELECT-dulu, jendela variabel, retensi sapu 1 jam |
| `workers/proxy/src/rateLimit.d.ts` | Deklarasi `windowMs` + `MAX_WINDOW_MS` |
| `workers/sync/README.md` | Checklist 0006 + paragraf batas Blue 6 |
| `app/src/worker/syncWorker.test.ts` | FakeD1 Blue 6 + 18 tes baru + 2 angka S8 diperbarui |
| `app/src/worker/rateLimit.test.ts` | 4 tes baru + tes sapu diperbarui (retensi 1 jam) |
| `app/tests/e2e/blue6-settings.spec.ts` | **Baru**: 2 tes E2E pesan deleted-recently |
| `app/src/strings/id.ts` | +1 string `settingsAccountDeletedRecently` |
| `app/src/components/settings/SettingsPage.tsx` | Wiring pesan `deleted-recently` |
| `docs/blue6-red6-fixes.md` | Laporan ini |
