-- Migrasi 0008: cache resolve + daftar target cache (P3, 19 Nov 2026)
-- Database: laras-web-sync (uuid 3a2cb6d6-5481-42a1-b213-070215cd2ce5)
--
-- KOORDINATOR WAJIB MENERAPKAN MIGRASI INI SEBELUM DEPLOY WORKER
-- PROXY PASCA-P3. Tanpa tabel ini, endpoint /api/resolve-cache
-- (GET + POST) gagal dan app jatuh ke perilaku lama (tanpa cache).
--
-- Latar: YouTube menolak IP pusat data di jendela buruk
-- (LOGIN_REQUIRED) tetapi jendelanya BERKEDIP — sesekali terbuka
-- kurang dari satu menit. Saat jendela terbuka, populator
-- (hidden_files/koordinator/cache-populator.py) me-resolve lagu
-- dan menyimpan URL stream-nya di sini; app memakai entri itu
-- bila resolve langsung gagal, selama belum kedaluwarsa.
--
-- Isi tabel HANYA URL publik googlevideo + metadata lagu (videoId,
-- judul, itag, client). BUKAN data pengguna: tanpa id akun, tanpa
-- alamat IP, tanpa riwayat putar. URL googlevideo kedaluwarsa
-- (parameter `expire`); kolom expires_at menyimpan batas itu
-- dikurangi margin aman 5 menit (populator yang menghitung).
-- App + worker TIDAK PERNAH melayani entri kedaluwarsa: GET
-- memfilter expires_at > sekarang di SQL, dan app memeriksa lagi
-- di sisi client sebelum memutar.
--
-- resolve_cache: satu baris per videoId (PK). Populator menimpa
-- (INSERT OR REPLACE) tiap kali jendela terbuka.
-- cache_targets: lagu yang wajib di-cache populator. Benih awal =
-- 5 lagu kanari (sumber yang sama dengan CANARY_SONGS di
-- app/src/spike/config.ts). Koordinator boleh menambah lagu
-- populer lewat INSERT biasa tanpa ubah kode populator.

CREATE TABLE IF NOT EXISTS resolve_cache (
  video_id TEXT PRIMARY KEY,
  stream_url TEXT NOT NULL,
  itag INTEGER NOT NULL,
  bitrate INTEGER,
  client TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL,
  resolved_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_resolve_cache_expires ON resolve_cache(expires_at);

CREATE TABLE IF NOT EXISTS cache_targets (
  video_id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO cache_targets (video_id, title, priority, added_at) VALUES ('hhn-nGSuenM', 'Semua Tentang Kita', 1, 1795046400);
INSERT OR IGNORE INTO cache_targets (video_id, title, priority, added_at) VALUES ('qkC4waEZVt4', 'Rahasia Hati', 2, 1795046400);
INSERT OR IGNORE INTO cache_targets (video_id, title, priority, added_at) VALUES ('k2XdBPv0D3Y', 'Surat Cinta Untuk Starla', 3, 1795046400);
INSERT OR IGNORE INTO cache_targets (video_id, title, priority, added_at) VALUES ('NL8WUtq_NDY', 'Ya Sudahlah', 4, 1795046400);
INSERT OR IGNORE INTO cache_targets (video_id, title, priority, added_at) VALUES ('YsGwU8vTRsE', 'Tak Ingin Usai', 5, 1795046400);
