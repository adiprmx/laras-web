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

## Checklist deploy (koordinator)

1. **Migrasi D1** (urutan penting, database `laras-web-sync`):
   ```sh
   wrangler d1 migrations apply laras-web-sync --local=false
   # atau satu per satu:
   wrangler d1 execute laras-web-sync --file=workers/sync/0001_init.sql --remote
   wrangler d1 execute laras-web-sync --file=workers/sync/0002_ratelimit.sql --remote
   wrangler d1 execute laras-web-sync --file=workers/sync/0003_item_meta.sql --remote
   ```
   Migrasi 0003 WAJIB sebelum deploy Worker ini — SQL push/pull
   memakai kolom `title`/`artist` dari 0003.
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
- Rate limit D1 fail-open: auth 10/mnt/IP, sync 30/mnt/user,
  me 60/mnt/IP. Bila D1 mati, request diizinkan (layanan
  tetap jalan, bukan mati total).
- Penghapusan akun menghapus data secara eksplisit berurutan
  (tidak mengandalkan ON DELETE CASCADE).
