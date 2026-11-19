-- Migrasi 0006: tombstone identitas terhapus + anggaran baca pull + indeks sapu tombstone (Blue 6, Red 6 S10/S11/I22)
-- Database: laras-web-sync (uuid 3a2cb6d6-5481-42a1-b213-070215cd2ce5)
--
-- KOORDINATOR WAJIB MENERAPKAN MIGRASI INI SEBELUM DEPLOY WORKER PASCA-BLUE 6.
-- Tanpa tabel-tabel ini Worker fail-open ke perilaku Blue 5 (anggaran tulis
-- tetap jalan lewat 0005, tetapi S10/S11 kembali terbuka: daftar ulang
-- me-reset anggaran, pull tanpa anggaran baca, tombstone tidak disapu).
-- Jangan deploy dulu, migrasi dulu.
--
-- S10: sync_deleted_identities mencatat identitas provider yang akunnya
-- dihapus — HANYA hash identitas + angka, tanpa nama/email/data pengguna
-- apa pun (hapus akun tetap benar-benar menghapus data pribadi).
--   identity_hash = SHA-256 hex dari "provider:provider_id" (dihitung
--   Worker; provider_id tidak pernah disimpan di tabel ini).
--   deleted_at    = milidetik epoch penghapusan (cooldown daftar ulang
--   24 jam dihitung dari sini).
--   budget_day / budget_rows = pemakaian anggaran TULIS hari penghapusan
--   (diwariskan ke akun baru bila daftar ulang di hari UTC yang sama —
--   hanya mungkin bila cooldown gagal; pertahanan berlapis).
--   read_rows     = pemakaian anggaran BACA hari penghapusan (sama).
--   history_cleared_at = stempel hapus riwayat terakhir (diwariskan,
--   supaya gerbang clear 24 jam tidak ikut di-reset).
-- Baris dikonsumsi (dihapus) saat identitas mendaftar lagi sesudah
-- cooldown; baris yang lebih tua dari 30 hari disapu malas tiap
-- callback (1 pernyataan best-effort) supaya tabel tidak tumbuh
-- tanpa batas. Satu baris kecil per penghapusan akun.
--
-- S11: sync_read_budget mencatat baris yang dikembalikan pull per
-- pengguna per hari (hari UTC, kunci 'YYYY-MM-DD'), analog dengan
-- sync_write_budget (0005). Anggaran 40.000 baris/hari/akun
-- (DAILY_READ_BUDGET di Worker): sinkronisasi penuh akun di batas
-- koleksi skalar (~12.100 baris) muat 3x; akun ekstrem 100.000 item
-- tersinkron bertahap ~3 hari (simetris dengan sisi tulis yang
-- butuh ~6 hari); satu akun paling banyak memakai 0,8% kuota baca
-- bersama (5.000.000/hari). Cadangan bersifat ATOMIK (satu upsert
-- berkondisi, seperti anggaran tulis): pull mencadangkan maksimum
-- per pull (4.002 = 4.001 baris + 1 baris rate-limit) SEBELUM
-- query jalan, lalu selisih yang tidak terpakai dikembalikan.
-- Baris anggaran hari lama tidak pernah dibaca lagi (kunci hari
-- berubah); tidak ada sapu terjadwal.
--
-- I22: indeks sapu tombstone malas — tiap push mengambil sampel
-- paling banyak 100 tombstone lama (>30 hari) per koleksi milik
-- pendorong untuk dihapus, supaya cap tidak tersumbat permanen.
-- Tanpa indeks ini, sapu memindai seluruh koleksi per push.
-- Indeks (user_id, deleted_at) membuat sapu hanya menyentuh
-- tombstone yang cocok (dan LIMIT 100 membatasinya).

CREATE TABLE IF NOT EXISTS sync_deleted_identities (
  identity_hash TEXT PRIMARY KEY,
  deleted_at INTEGER NOT NULL,
  budget_day TEXT NOT NULL,
  budget_rows INTEGER NOT NULL DEFAULT 0,
  read_rows INTEGER NOT NULL DEFAULT 0,
  history_cleared_at INTEGER
);

CREATE TABLE IF NOT EXISTS sync_read_budget (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  rows_read INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

CREATE INDEX IF NOT EXISTS idx_playlists_user_deleted
  ON sync_playlists(user_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_likes_user_deleted
  ON sync_likes(user_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_items_user_deleted
  ON sync_playlist_items(user_id, deleted_at);
