-- Migrasi 0002: tabel rate limit proxy (D1)
-- Sumber spesifikasi: docs/arsitektur.md §4.1 (rate limit di D1,
-- bukan KV — KV tulis hanya 1.000/hari) dan Red 1 S3.
-- Database: laras-web-sync (uuid 3a2cb6d6-5481-42a1-b213-070215cd2ce5)
-- Akun Cloudflare: 05928ed4e4ed9643a5665d1e59315abe
--
-- Catatan desain:
-- - Satu baris per (kunci, jendela menit). Kunci `innertube:<ip>`
--   atau `media:<ip>`; window_start = awal menit (epoch ms).
--   Jendela selaras (fixed window), bukan sliding.
-- - Baris kedaluwarsa disapu probabilistik oleh worker (1% request);
--   indeks window_start membuat sapu itu tidak memindai tabel.
-- - Biaya kuota: 1 baris tulis + 1 baris baca per request proxy.
--   Tulis 100.000/hari seorde dengan kuota request Workers.
-- - Tidak ada data pengguna di sini selain alamat IP (kunci rate
--   limit); baris hidup paling lama ~1 menit sesudah jendelanya
--   lewat, lalu disapu.
-- - Diterapkan koordinator saat redeploy proxy (Blue tidak deploy):
--   wrangler d1 execute laras-web-sync --file=workers/sync/0002_ratelimit.sql
--   (atau setara via API), lalu redeploy worker dengan binding DB.

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (key, window_start)
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_window
  ON rate_limits(window_start);
