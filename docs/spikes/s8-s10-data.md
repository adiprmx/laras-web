# Spike S8 dan S10: sinkronisasi D1 dan lirik LRCLIB

**Tim:** Tim Data paket P1 (A16, A17, C18).
**Tanggal uji:** 17 November 2026, 14:21 sampai 15:00 UTC (21:21 sampai 22:00 WIB).
**Acuan:** `docs/arsitektur.md` §2.1, §4.3, §5, §8 dan `docs/prd-v1.md` §5.7 (B7).
**Batasan yang dipatuhi:** tanpa API Spotify, tanpa login wajib, tanpa iklan,
tanpa telemetri, tanpa pembayaran, biaya Rp0 (free-tier Cloudflare saja),
tanpa dependensi npm baru, tanpa `npm run build` atau `npm ci`, tanpa push
ke GitHub.

## Ringkasan vonis

| Spike | Vonis | Bukti singkat |
|---|---|---|
| S8 sync D1 | LOLOS BERSYARAT | Database dibuat, migrasi 7 tabel jalan, 24 dari 24 perilaku teruji lolos (21 dari 22 pada uji utama ditambah 3 dari 3 verifikasi susulan; satu "gagal" pada uji utama adalah bug ekspektasi skrip uji, bukan bug skema, dan sudah dikoreksi). Syarat: OAuth Google/GitHub nyata belum teruji karena butuh kredensial owner. |
| S10 LRCLIB dari browser | LOLOS, dengan satu catatan | 50 dari 50 request langsung berstatus 200 tanpa satu pun 429; header pengenal client diterima dan diizinkan eksplisit oleh preflight CORS. Catatan: kaki uji browser nyata (Playwright) tidak bisa dibuktikan di VM ini karena proxy egress sandbox menolak tunnel Chromium, bukan karena LRCLIB. |

Keputusan S8 yang diminta tugas ini: sync TIDAK pindah ke pasca-v1. Bagian
yang belum terbukti adalah penyediaan kredensial OAuth (langkah prosedural
oleh parent/owner), bukan ketidakpastian teknis. Seluruh perilaku protokol
sync yang berisiko (tarik/dorong inkremental, konflik last-write-wins,
tombstone hapus) sudah terbukti bekerja di D1 nyata. Backup JSON tetap
menjadi jalan pindah perangkat tanpa akun, apa pun hasil OAuth nanti.

## S8: sync D1 end-to-end sejauh yang bisa diuji tanpa OAuth nyata

### Kriteria lolos (arsitektur.md §8)

Dua perangkat sinkron playlist/favorit/riwayat; konflik last-write-wins
terbukti; tombstone hapus terbukti. Bila gagal: sync pindah ke pasca-v1 dan
backup JSON tetap menjadi jalan pindah perangkat.

### Yang diuji dan yang tidak diuji

Diuji langsung terhadap D1 produksi Cloudflare (bukan emulator):

- Pembuatan database, migrasi skema, CRUD semua tabel.
- Sesi: token acak 256-bit yang disimpan sebagai hash SHA-256, lookup lewat
  hash, penolakan hash salah dan sesi kedaluwarsa, hapus sesi (logout).
- Simulasi dua perangkat: dorong dari perangkat A, tarik inkremental oleh
  perangkat B, lalu sebaliknya, memakai parameter `since=timestamp`.
- Konflik last-write-wins: tulis terbaru menang, tulis lama yang datang
  terlambat ditolak, seri `updated_at` yang sama persis dipecah secara
  deterministik oleh `device_id`.
- Tombstone hapus: hapus terkirim lewat tarik inkremental, baris
  dipertahankan di server, daftar aktif menyembunyikan yang terhapus, tulis
  lama tidak bisa menghidupkan kembali yang terhapus.
- Batas skema: `settings_json` di atas 4 KB ditolak oleh CHECK constraint.

TIDAK diuji, dicatat dengan jujur sebagai celah:

- Pembuatan aplikasi OAuth Google dan GitHub (butuh konsol developer dan
  persetujuan owner).
- Penukaran authorization code menjadi token di Worker (butuh client secret
  yang hanya boleh dipegang owner/parent).
- Penerbitan cookie sesi `HttpOnly`, `Secure`, `SameSite=Lax` di browser
  nyata dan alur masuk/keluar di antarmuka.
- Endpoint Worker `/api/auth/*` dan `/api/sync/*` itu sendiri belum
  dibangun; yang diuji adalah lapisan D1 dan protokol SQL-nya lewat REST
  API D1, dengan skrip uji berperan sebagai Worker (mengisi `updated_at`
  dari sisi server).

Identitas pengguna pada uji ini adalah SIMULASI: satu baris `users`
(provider `google`, provider_id `google-sim-123456789`) yang disisipkan
langsung, seolah-olah OAuth sudah mengembalikan identitas tersebut. Tidak
ada akun sungguhan yang dibuat dan tidak ada kredensial yang diminta.

### Hasil uji

Database `laras-web-sync` dibuat 17 November 2026 pukul 14:24:18 UTC.
UUID: `3a2cb6d6-5481-42a1-b213-070215cd2ce5`. Region: ENAM. Ini database D1
ke-5 dari batas 10 per akun (4 lainnya milik temp-mail).

Skrip uji: `docs/spikes/s8_test.py` dan `docs/spikes/s8_verify.py`.
Migrasi: `workers/sync/0001_init.sql` (7 tabel, 8 indeks, 3.622 byte).

Keluaran uji utama (57 query D1):

```text
[GAGAL] Migrasi: 7 tabel dibuat -- tabel=['_cf_KV', 'sessions', ...]
[LOLOS] Migrasi: indeks filter dibuat -- 8 indeks
[LOLOS] CRUD: pengguna simulasi dibuat dan dibaca -- provider=google
[LOLOS] Sesi: lookup lewat hash token menemukan pengguna
[LOLOS] Sesi: hash token yang salah tidak menemukan sesi
[LOLOS] Sesi: sesi kedaluwarsa ditolak lookup
[LOLOS] CRUD: DELETE sesi berjalan
[LOLOS] Sync: perangkat B menarik playlist A (since=0) -- diterima=1 playlist
[LOLOS] Sync: item playlist ikut tersinkron
[LOLOS] Sync: favorit ikut tersinkron
[LOLOS] Sync: riwayat ikut tersinkron
[LOLOS] Sync inkremental: A hanya menerima perubahan sesudah since
[LOLOS] Sync inkremental: since=terbaru mengembalikan nol baris
[LOLOS] LWW: tulis yang lebih baru menang -- nama=Nama dari B
[LOLOS] LWW: tulis lama yang datang terlambat ditolak
[LOLOS] LWW seri: device_id terbesar menang (B sesudah A)
[LOLOS] LWW seri: pemenang sama bila urutan dibalik (deterministik)
[LOLOS] Tombstone: hapus terkirim lewat tarik inkremental
[LOLOS] Tombstone: baris dipertahankan di server (retensi)
[LOLOS] Tombstone: daftar aktif menyembunyikan yang terhapus
[LOLOS] Tombstone: tulis lama tidak menghidupkan yang terhapus
[LOLOS] Batas: settings_json di atas 4 KB ditolak
        (CHECK constraint failed, kode D1 7500)
TOTAL: 21/22 cek lolos; 1 gagal
D1 terpakai spike ini: 57 query, 119 baris dibaca, 80 baris ditulis
```

Satu-satunya "gagal" adalah bug pada ekspektasi skrip uji: D1 membuat tabel
internal `_cf_KV` sendiri, sehingga daftar tabel berisi 8 nama, bukan 7.
Ketujuh tabel app semuanya ada. Verifikasi susulan dengan ekspektasi yang
dikoreksi lolos 3 dari 3:

```text
[LOLOS] Migrasi (koreksi): 7 tabel app ada
[LOLOS] Migrasi (koreksi): tabel ekstra hanya _cf_KV internal D1
[LOLOS] Keadaan akhir: pl-001 aktif, pl-002 tombstone
VERIFIKASI SUSULAN: 3/3 cek lolos
```

Keadaan akhir sebelum pembersihan: `sessions` 1 baris, `sync_history` 1,
`sync_likes` 1, `sync_playlist_items` 2, `sync_playlists` 2 (pl-001 aktif
dengan nama akhir "Seri B dulu", pl-002 tombstone dengan `deleted_at`
1794925988865), `sync_settings` 1, `users` 1. Semua data uji sudah dihapus
sesudah verifikasi; ketujuh tabel kembali ke 0 baris dan skema tetap ada.

### Aturan last-write-wins yang terbukti

Upsert memakai klausa SQLite `ON CONFLICT(id) DO UPDATE ... WHERE`:
tulis masuk hanya bila `updated_at` yang datang lebih besar dari yang
tersimpan, atau sama persis dan `device_id` yang datang lebih besar secara
leksikografis. Tiga perilaku ini masing-masing terbukti dengan data nyata
di atas, termasuk determinisme pemecah seri saat urutan kedatangan dibalik
(pemenang tetap perangkat B pada kedua urutan).

### Pemakaian free-tier D1 (arsitektur.md §2.1)

| Kuota harian free-tier | Terpakai seluruh spike S8 | Persentase |
|---|---|---|
| 5.000.000 baris dibaca/hari | 162 baris (119 uji utama + 43 verifikasi) | 0,0032 persen |
| 100.000 baris ditulis/hari | 80 baris | 0,08 persen |
| Penyimpanan total 5 GB | 106.496 byte (ukuran file database sesudah uji, sebelum pembersihan) | 0,002 persen |
| Maks 10 database per akun | 5 terpakai (4 temp-mail + laras-web-sync) | 5 dari 10 |

Angka baris dibaca/ditulis berasal dari field `meta.rows_read` dan
`meta.rows_written` yang dikembalikan API D1 pada tiap query, dijumlahkan
oleh skrip uji. Proyeksi kasar untuk pemakaian nyata: satu sinkronisasi
penuh pengguna aktif (100 playlist, 1.000 item, 1.000 favorit, 1.000
riwayat) memakai orde ribuan baris, sehingga kuota harian 100.000 baris
tulis masih memberi ruang untuk puluhan sinkronisasi penuh per hari di
seluruh pengguna. Proyeksi ini adalah hitungan kasar dari batas skema
§4.3, bukan hasil ukur beban nyata.

### Temuan sampingan S8

- Endpoint D1 `/batch` mengembalikan `Route not found` pada API ini.
  Migrasi dijalankan statement per statement lewat endpoint `/query`
  (17 statement, semuanya berhasil). Tim implementasi memakai pola yang
  sama atau wrangler.
- Endpoint `/user/tokens/verify` mengembalikan error 1000 "Invalid API
  Token", tetapi semua panggilan D1 (list, create, query) dengan token
  yang sama berhasil. Token ini berfungsi untuk D1; hasil verify yang
  aneh itu tidak menghambat apa pun dan dicatat apa adanya.
- Helper yang dipakai adalah `cfw_t.py` (token file 0600), bukan
  `cfw_api.py`, sesuai instruksi tugas. Isi token tidak pernah dicetak.

### Celah OAuth: langkah yang masih butuh parent/owner

1. Owner membuat OAuth app Google (Google Cloud Console) dan GitHub
   (pengaturan developer GitHub) untuk Laras Web, dengan redirect URI ke
   domain Worker yang sudah diputuskan.
2. Owner menyerahkan client id dan client secret lewat jalur aman (Secure
   Vault), bukan chat. Secret disimpan sebagai Worker secret, tidak
   pernah masuk repo atau bundle.
3. Tim implementasi membangun Worker `/api/auth/*` (tukar kode, buat
   sesi, cookie) dan `/api/sync/*` (tarik/dorong memakai SQL yang sudah
   terbukti di spike ini), lalu menguji masuk nyata satu kali di browser.
4. Sesudah langkah 3 lolos, status S8 naik dari LOLOS BERSYARAT menjadi
   LOLOS penuh. Tidak ada pekerjaan spike tambahan yang dibutuhkan;
   pola OAuth authorization code di Worker adalah pola standar yang
   sudah dikenal.

## S10: LRCLIB dari browser

### Kriteria lolos (arsitektur.md §8)

50 request lirik berurutan tanpa 429; header `X-User-Agent` /
`Lrclib-Client` diterima. Bila gagal: cache lebih agresif ditambah
fallback lyrics.ovh (lirik polos, CORS `*`).

### Uji 1: 50 request berurutan langsung (probe utama)

Skrip: `docs/spikes/s10_probe_direct.py`. Endpoint `/api/search` dengan
50 judul lagu berbeda, header `X-User-Agent` dan `Lrclib-Client` berisi
`LarasWeb/1.0 (spike-s10; +https://github.com/adiprmx/laras-web)`.

Hasil: 50 dari 50 berstatus HTTP 200. Nol 429. Header
`Access-Control-Allow-Origin: *` ada pada ke-50 respons. Tidak ada header
`X-RateLimit-*` atau `Retry-After` pada respons sukses (LRCLIB hanya
mengirim `Retry-After` saat membatasi, menurut dokumentasinya).

| Metrik | Nilai |
|---|---|
| Request sukses | 50 dari 50 (100 persen) |
| Respons 429 | 0 |
| Total waktu 50 request | 392,23 detik (dinding), 390,81 detik (jumlah waktu request) |
| Waktu per request | minimum 3,43 detik, median 7,38 detik, maksimum 16,44 detik |
| Laju efektif | 7,7 request/menit |
| Ukuran respons `/api/search` | minimum 53.404 byte, median 240.753 byte, maksimum 681.487 byte, total 13,23 MB |

Waktu per request yang besar adalah efek proxy egress VM, bukan LRCLIB:
request yang sama dari jaringan biasa jauh lebih cepat. Konsekuensinya,
laju efektif 7,7 request/menit jauh di bawah batas yang
didokumentasikan, sehingga uji berurutan ini membuktikan kriteria spike
(50 tanpa 429) tetapi TIDAK menguji sampai ke ambang batas laju. Uji
burst di bawah menutup sebagian celah itu.

### Uji 2: burst 30 request konkuren `/api/get`

Skrip: `docs/spikes/s10_probe_burst.py`. 30 lagu berbeda, 10 request
bersamaan, endpoint `/api/get` (cocok persis artis + judul + durasi).

Hasil: 28 berstatus 200, 2 timeout (curl mencapai batas 30 detik, status
0, tanpa respons; ini perlambatan proxy egress di bawah konkurensi,
bukan penolakan server). Nol 429. Total waktu 79,26 detik. Ukuran
respons `/api/get`: median 17.754 byte, maksimum 38.780 byte.

Satu request `/api/get` tunggal di luar burst (Coldplay, Yellow, durasi
269 detik) berstatus 200 dalam 3,72 detik. Temuan penting: respons
`/api/get` sekitar 13 kali lebih kecil dari median `/api/search`
(17.754 byte berbanding 240.753 byte), karena `/api/search`
mengembalikan sampai 20 rekaman lengkap beserta teks lirik. Arsitektur
sudah benar menempatkan `/api/get` sebagai jalur utama dan `/api/search`
sebagai fallback.

### Uji 3: preflight CORS dan penerimaan header pengenal

Request OPTIONS dengan `Origin`, `Access-Control-Request-Method: GET`,
dan `Access-Control-Request-Headers: x-user-agent, lrclib-client`
berstatus 200 dengan header:

```text
access-control-allow-origin: *
access-control-allow-methods: *
access-control-allow-headers: content-type, x-user-agent, lrclib-client,
  lrclib-app-id, lrclib-api-key
```

Kedua header pengenal client yang dipakai app diizinkan eksplisit oleh
server. Ini ditambah dokumentasi resmi (di bawah) membuktikan header
pengenal diterima, bukan sekadar diabaikan diam-diam.

### Rate limit yang teramati dan yang terdokumentasi

Tidak ada 429 yang teramati pada total 81 request (50 berurutan + 30
burst + 1 tunggal). Dokumentasi resmi LRCLIB (`https://lrclib.net/docs`,
dibaca 17 November 2026) menyatakan angka yang sebelumnya tercantum
sebagai belum terverifikasi di arsitektur.md §11, sehingga butir itu
sekarang TERVERIFIKASI dari sumber resmi:

| Cara request mengidentifikasi diri | Batas perkiraan |
|---|---|
| Klien generik (tanpa User-Agent, browser, curl) | sekitar 45 request/menit per IP |
| Klien teridentifikasi (User-Agent menyebut nama aplikasi) | sekitar 90 request/menit per IP |
| Aplikasi client-side terdaftar (`Lrclib-App-Id`) | sekitar 180 request/menit per IP, ditambah kuota app sekitar 6.000 request/menit |
| Aplikasi server-side terdaftar (`Lrclib-Api-Key`) | kuota app saja, sekitar 6.000 request/menit |

Dokumentasi juga menyatakan: batas berlaku per IP, terisi ulang secara
bertahap dengan sedikit ruang burst; saat batas terlampaui server
membalas 429 dengan header `Retry-After` dan client WAJIB menghormatinya
(ditambah jitter sampai 30 persen); client diminta mengirim request
secara berurutan dengan jeda 200 sampai 500 ms, terutama untuk operasi
batch. `X-User-Agent` dan `Lrclib-Client` adalah alternatif resmi saat
`User-Agent` tidak bisa disetel (JavaScript browser). Pendaftaran
aplikasi di portal developer bersifat opsional dan menaikkan batas;
`Lrclib-App-Id` bukan secret sehingga aman dikirim di client.

Rekomendasi untuk implementasi: kirim `X-User-Agent` dan `Lrclib-Client`
pada tiap request lirik; patuhi `Retry-After` dengan jitter bila suatu
hari menerima 429; pertahankan cache IndexedDB 7 hari untuk penanda
"tidak ditemukan" (sudah ada di §3.7); daftarkan aplikasi di portal
developer LRCLIB pada saat rilis untuk mendapatkan `Lrclib-App-Id` dan
batas 180/menit (langkah ini butuh parent/owner, gratis, tanpa kartu).

### Uji 4: browser nyata (Playwright) TIDAK BISA dibuktikan di VM ini

Tiga percobaan dengan Playwright 1.65.1 (Chromium 1255), masing-masing
50 request fetch dari konteks halaman:

1. Tanpa proxy: 50 dari 50 `TypeError: Failed to fetch`.
2. Dengan proxy egress VM (URL dari variabel lingkungan): 50 dari 50
   `TypeError: Failed to fetch`, dengan `net::ERR_TUNNEL_CONNECTION_FAILED`
   di konsol browser.
3. Dengan proxy ditambah kredensial yang dipisah (username/password
   terpisah, karena Playwright tidak membaca kredensial dari URL server):
   50 dari 50 `TypeError: Failed to fetch`, kontrol fetch tanpa header
   kustom juga gagal.

Skrip: `docs/spikes/s10_probe_browser.cjs`. Diagnostik lanjutan
(`docs/spikes/s10_netdiag.cjs`) membuktikan penyebabnya bukan LRCLIB:
`page.goto("https://example.com")` dari Chromium yang sama gagal
dengan `net::ERR_TUNNEL_CONNECTION_FAILED` yang persis sama. Proxy
egress VM menerima CONNECT dari curl (terlihat `HTTP/1.1 200 Connection
Established` pada preflight) tetapi menolak CONNECT dari Chromium.
Ini batasan sandbox VM, bukan kegagalan LRCLIB, bukan kegagalan CORS,
dan bukan penolakan header.

Yang masih bisa dinyatakan dari sisi browser: fetch dengan header
`X-User-Agent` dan `Lrclib-Client` berhasil dikonstruksi dan dicoba
oleh Chromium (request mencapai tahap tunnel proxy; tidak ada error
JavaScript tentang header yang dilarang, karena kedua header itu bukan
forbidden header). Bukti CORS dari preflight dan dokumentasi resmi
menunjukkan fetch yang sama akan jalan di perangkat pengguna yang
jaringannya normal.

Tindak lanjut yang jujur: kaki browser S10 WAJIB diuji ulang di luar
VM ini (perangkat nyata atau managed browser yang jalur jaringannya
berbeda) sebelum rilis, memakai skrip yang sama. Vonis S10 tetap LOLOS
karena kriteria spike (50 request tanpa 429, header diterima) terbukti
pada probe langsung dan preflight, dan satu-satunya bagian yang belum
terbukti adalah artefak lingkungan uji, bukan perilaku layanan.

### Fallback lyrics.ovh (terverifikasi sebagai cadangan)

Satu request `https://api.lyrics.ovh/v1/Coldplay/Yellow` berstatus 200
dalam 4,89 detik, ukuran 978 byte, mengembalikan lirik polos lagu
Yellow yang benar (diawali "Look at the stars"). Fallback berfungsi
dan siap dipakai bila LRCLIB suatu hari tidak bisa dijangkau. Fallback
ini TIDAK dibutuhkan sekarang karena S10 lolos; ia tetap dicatat
sebagai cadangan sesuai arsitektur §3.7.

## File yang dihasilkan

| File | Isi | Ukuran |
|---|---|---|
| `docs/spikes/s8-s10-data.md` | Laporan ini | 18.660 byte |
| `workers/sync/0001_init.sql` | Migrasi skema D1 (7 tabel, 8 indeks) | 3.622 byte |
| `docs/spikes/s8_test.py` | Uji utama S8 (22 cek) | 15.755 byte |
| `docs/spikes/s8_verify.py` | Verifikasi susulan S8 (3 cek) | 1.607 byte |
| `docs/spikes/s10_probe_direct.py` | Probe 50 request berurutan | 3.337 byte |
| `docs/spikes/s10_probe_burst.py` | Probe burst 30 request konkuren | 3.237 byte |
| `docs/spikes/s10_probe_browser.cjs` | Probe browser Playwright | 3.829 byte |
| `docs/spikes/s10_netdiag.cjs` | Diagnostik jaringan Chromium | 2.110 byte |

Data mentah hasil probe tersimpan di `/tmp/s10_direct_results.json`,
`/tmp/s10_burst_results.json`, dan `/tmp/s10_browser_results3.json`
(artefak sementara VM, bukan bagian repo).

## Tindak lanjut untuk koordinator

1. S8: minta owner membuat OAuth app Google dan GitHub, lalu serahkan
   client id/secret lewat Secure Vault kepada tim implementasi Worker.
   Sesudah Worker auth/sync dibangun, uji masuk nyata satu kali di
   browser untuk menaikkan S8 menjadi LOLOS penuh.
2. S10: uji ulang kaki browser di luar VM (perangkat nyata atau managed
   browser) sebelum rilis, memakai `docs/spikes/s10_probe_browser.cjs`.
3. S10: daftarkan aplikasi Laras Web di portal developer LRCLIB saat
   rilis untuk mendapatkan `Lrclib-App-Id` (gratis, menaikkan batas ke
   sekitar 180 request/menit per IP).
4. Arsitektur.md §11: butir "Rate limit LRCLIB" sekarang terverifikasi
   dari dokumentasi resmi dan bisa dipindahkan dari daftar belum
   terverifikasi.
5. Database `laras-web-sync` sudah ada dengan skema lengkap dan 0 baris
   data; tim implementasi Worker bisa langsung memakai UUID yang
   tercantum di laporan ini. Jangan membuat database kedua.
