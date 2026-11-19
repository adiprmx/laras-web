# Worker sinkronisasi Laras (`laras-sync`)

Worker Cloudflare untuk login OAuth (Google/GitHub) + sinkronisasi
D1 (suka, playlist, riwayat putar, pengaturan). Protokol mengikuti
spike S8 yang sudah terbukti (`docs/spikes/s8-s10-data.md`).

## Endpoint

| Metode | Jalur | Keterangan |
| ------ | ----- | ---------- |
| GET | `/api/auth/login?provider=google\|github` | 302 ke provider |
| GET | `/api/auth/callback` | tukar kode, buat sesi, 302 ke `/settings?auth=ok` |
| GET | `/api/auth/me` | status sesi (401 bila belum masuk) |
| POST | `/api/auth/logout` | hapus sesi + bersihkan cookie |
| POST | `/api/auth/delete` | hapus akun + seluruh data sync pengguna |
| GET | `/api/sync/pull?since=<ms>` | tarik perubahan sejak `since` |
| POST | `/api/sync/push` | dorong perubahan (body maks 1 MB, 100 entri/koleksi) |

Batas total per pengguna (arsitektur §4.3, ditegakkan server
saat push sejak Blue 4): maks 100 playlist, 1.000 item per
playlist, 10.000 suka, 1.000 riwayat. Kelebihan dilewati per
koleksi dan dilaporkan di respons push (`skippedOverLimit` +
`limits`); update entri lama dan penghapusan tidak pernah
dibatasi. Tombstone memakai UPDATE (bukan INSERT) sehingga
tidak pernah menambah baris. Sejak Blue 5, cek batas memakai
tabel penghitung (1 baris baca per koleksi, bukan COUNT per
push) + tiap INSERT entri baru dijaga klausa guard-WHERE,
anggaran tulis harian per akun 20.000 baris (push yang
melewatinya ditolak 429 + `Retry-After`), dan hapus riwayat
dihonori paling sering sekali per 24 jam (clear yang terlalu
sering diabaikan + dilaporkan `historyClearIgnored`).
Detail + aritmetika kuota: `docs/blue5-red5-fixes.md`.
Sejak Blue 6: anggaran BACA pull harian per akun 40.000 baris
(pull yang melewatinya ditolak 429 `DAILY_READ_BUDGET_EXCEEDED`
+ `Retry-After`); hapus akun dibatasi 3/jam per IP + 1/jam per
akun, dan daftar ulang dengan identitas yang sama ditolak
selama 24 jam sesudah hapus (redirect
`?auth=error&reason=deleted-recently`, lalu mewarisi anggaran
+ stempel clear lama); tiap push menyapu paling banyak 100
tombstone berumur >30 hari per koleksi yang disentuh supaya
cap kembali longgar (tanpa cron — tidak ada perubahan deploy).
Detail + aritmetika kuota: `docs/blue6-red6-fixes.md`.
Sejak Blue 7: sapu tombstone DITAGIH ke anggaran tulis lewat
cadangan atomik sebesar biaya PERSIS (hapus + UPDATE penghitung
+ 1); bila cadangan gagal, sapu dilewati dan push tetap jalan.
Sapu playlist ikut menghapus itemnya (maks total 1.000 baris
per push), dan hapus akun ikut menghapus item yatim. Cooldown
daftar ulang SEBANDING ukuran akun (24 jam + 1 hari per 20.000
baris di atas 20.000, maks 30 hari); redirect membawa tanggal
buka kunci (`reason=deleted-recently&until=<tanggal ISO>`).
Detail + aritmetika kuota: `docs/blue7-red7-fixes.md`.

## Checklist deploy (koordinator)

1. **Migrasi D1** (urutan penting, database `laras-web-sync`):
   ```sh
   wrangler d1 migrations apply laras-web-sync --local=false
   # atau satu per satu:
   wrangler d1 execute laras-web-sync --file=workers/sync/0001_init.sql --remote
   wrangler d1 execute laras-web-sync --file=workers/sync/0002_ratelimit.sql --remote
   wrangler d1 execute laras-web-sync --file=workers/sync/0003_item_meta.sql --remote
   wrangler d1 execute laras-web-sync --file=workers/sync/migrations/0004_oauth_states_item_owner.sql --remote
   wrangler d1 execute laras-web-sync --file=workers/sync/migrations/0005_sync_quotas.sql --remote
   wrangler d1 execute laras-web-sync --file=workers/sync/migrations/0006_blue6_quotas.sql --remote
   wrangler d1 execute laras-web-sync --file=workers/sync/migrations/0007_blue7_deleted_rows.sql --remote
   ```
   Migrasi 0003 WAJIB sebelum deploy Worker ini — SQL push/pull
   memakai kolom `title`/`artist` dari 0003. Migrasi 0004 WAJIB
   sebelum deploy Worker pasca-Blue 3 — SQL callback memakai tabel
   `oauth_states` dan SQL push item memakai kolom `user_id` dari
   0004 (tanpa tabelnya, login fail-open tanpa single-use).
   Migrasi 0005 WAJIB sebelum deploy Worker pasca-Blue 5 — SQL
   kuota memakai tabel `sync_counts`, `sync_write_budget`, dan
   `sync_user_meta` dari 0005 (tanpa tabelnya, Worker fail-open
   ke perilaku Blue 4: COUNT per push + tanpa anggaran tulis,
   sehingga S8/S9 kembali terbuka sampai 0005 diterapkan).
   Migrasi 0006 WAJIB sebelum deploy Worker pasca-Blue 6 — SQL
   kuota memakai tabel `sync_read_budget` dan
   `sync_deleted_identities` dari 0006 (tanpa tabelnya, Worker
   fail-open ke perilaku Blue 5: tanpa anggaran baca, tanpa
   tombstone identitas/cooldown daftar-ulang, sehingga S10/S11
   kembali terbuka sampai 0006 diterapkan).
   Migrasi 0007 WAJIB sebelum deploy Worker pasca-Blue 7 — SQL
   tombstone memakai kolom `deleted_rows` dari 0007 (tanpa
   kolomnya, tulis tombstone gagal dan Worker fail-open ke
   perilaku Blue 6: cooldown tetap 24 jam untuk semua akun,
   tanpa tanggal buka kunci di redirect, sehingga mitigasi S13
   tidak aktif sampai 0007 diterapkan).
2. **Aplikasi OAuth (langkah owner — BELUM DIBUAT saat P7 ditulis).**
   Buat aplikasi OAuth Google + GitHub, daftarkan redirect URI:
   `https://laras-sync.hiroohengkerr.workers.dev/api/auth/callback`
   (satu URI untuk kedua provider).
3. **Secrets** (client id/secret lewat Secure Vault, jangan chat):
   ```sh
   wrangler secret put GOOGLE_CLIENT_ID
   wrangler secret put GOOGLE_CLIENT_SECRET
   wrangler secret put GITHUB_CLIENT_ID
   wrangler secret put GITHUB_CLIENT_SECRET
   ```
4. **Deploy**: `wrangler deploy` dari folder ini.
5. **Smoke test**: `GET /api/auth/me` tanpa cookie harus 401;
   `/api/auth/login?provider=google` harus 302 ke Google
   (503 bila secret belum dipasang — itu perilaku yang benar,
   bukan galat).

## Catatan keamanan

- Sesi: token acak 256-bit, hash SHA-256 di D1, cookie HttpOnly
  + Secure, 30 hari, maks 10 sesi per pengguna.
- Cookie sesi memakai `SameSite=None` karena Worker di domain
  workers.dev dan app di adipmusic.my.id (cookie Lax tidak
  dikirim fetch lintas situs). Mitigasi CSRF: semua POST
  memvalidasi header `Origin` terhadap `ALLOWED_ORIGINS`.
  Bila Worker pindah ke subdomain app (same-site), set
  `COOKIE_SAMESITE=Lax` di vars untuk memperketat.
- Rate limit D1 fail-open: auth 10/mnt/IP, auth-callback
  10/mnt/IP, sync 30/mnt/user, me 60/mnt/IP. Bila D1 mati,
  request diizinkan (layanan tetap jalan, bukan mati total).
- State OAuth sekali pakai: hash state disimpan di D1 saat login
  (tabel `oauth_states`, TTL 10 menit) dan dihapus saat callback
  memakainya — satu DELETE berkondisi atomik (`meta.changes`),
  jadi dua callback bersamaan dengan state yang sama tidak bisa
  sama-sama lolos. State yang sudah dipakai atau tidak dikenal ditolak.
- `ALLOWED_ORIGINS` produksi hanya domain app (tanpa localhost).
  Dev lokal: `wrangler dev --env dev` (localhost hanya di
  `[env.dev.vars]` di `wrangler.toml`).
- Penghapusan akun menghapus data secara eksplisit berurutan
  (tidak mengandalkan ON DELETE CASCADE).
