-- Migrasi 0005: kuota sinkronisasi per akun + penghitung batas total (Blue 5, Red 5 S8/S9/R19)
-- Database: laras-web-sync (uuid 3a2cb6d6-5481-42a1-b213-070215cd2ce5)
--
-- KOORDINATOR WAJIB MENERAPKAN MIGRASI INI SEBELUM DEPLOY WORKER PASCA-BLUE 5.
-- Tanpa tabel-tabel ini Worker fail-open ke perilaku Blue 4 (COUNT per push +
-- tanpa anggaran tulis) supaya sinkronisasi tidak mati total — tetapi S8/S9
-- kembali terbuka sampai migrasi diterapkan. Jangan deploy dulu, migrasi dulu.
--
-- S8a: sync_user_meta mencatat stempel hapus riwayat terakhir per pengguna.
-- Hapus riwayat (historyClearedBefore) hanya dihonori sekali per 24 jam;
-- clear yang terlalu sering diabaikan dengan respons jelas. Tanpa ini satu
-- akun memutar insert-100 + DELETE-keras tanpa henti dan menguras kuota
-- tulis D1 bersama (100.000 baris/hari) dalam 17-33 menit.
--
-- S8b: sync_write_budget mencatat baris yang ditulis per pengguna per hari
-- (hari UTC, kunci 'YYYY-MM-DD'). Anggaran 20.000 baris/hari/akun
-- (DAILY_WRITE_BUDGET di Worker): longgar untuk pemakaian normal (sinkron
-- penuh akun maksimal ~12.100 baris: 100 playlist + 1.000 item + 10.000
-- suka + 1.000 riwayat — masih di bawah anggaran), tetapi satu akun paling
-- banyak memakai 20% kuota tulis bersama per hari, jadi tidak bisa
-- mengurasnya sendirian. Cadangan anggaran bersifat ATOMIK (satu upsert
-- berkondisi; lihat verifikasi SQLite di docs/blue5-red5-fixes.md):
-- push bersamaan tidak bisa sama-sama lolos sesudah anggaran habis.
-- Baris anggaran hari lama tidak pernah dibaca lagi (kunci hari berubah);
-- tidak ada sapu terjadwal — satu baris kecil per pengguna per hari aktif.
--
-- S9: sync_counts menyimpan jumlah baris per pengguna per koleksi
-- (playlists/likes/history skalar; items per playlist) supaya cek batas
-- total menjadi lookup 1 baris (PK), bukan COUNT(*) yang memindai sampai
-- 10.000 baris indeks per push. Penghitung diperbarui di batch yang sama
-- dengan upsert (SEBELUM upsert, supaya arah melencengnya AMAN: penghitung
-- yang terlalu tinggi hanya menolak penambahan sah, tidak pernah
-- mengizinkan pelampauan batas). Nilai n = -1 berarti "basi, hitung ulang"
-- (disetel saat hapus riwayat massal, yang menghapus jumlah baris yang
-- tidak diketahui tanpa COUNT). Backfill di bawah mengisi penghitung dari
-- data yang sudah ada, jadi pengguna lama langsung benar tanpa COUNT
-- per push. Rekonsiliasi: Worker menghitung ulang via COUNT bila penghitung
-- basi (n < 0), melenceng di atas batas + 30, atau lebih tua dari 24 jam
-- saat sudah dekat batas (dalam 500 baris dari batas) — ketiganya
-- terbatas (lihat aritmetika di docs/blue5-red5-fixes.md).
--
-- R19: penghitung yang sama dipakai klausa guard-WHERE di tiap INSERT
-- entri baru, sehingga batas ditegakkan per pernyataan secara atomik
-- (bukan hanya check-then-act di level push).

CREATE TABLE IF NOT EXISTS sync_counts (
  user_id TEXT NOT NULL,
  collection TEXT NOT NULL CHECK (collection IN ('playlists', 'likes', 'history', 'items')),
  playlist_id TEXT NOT NULL DEFAULT '',
  n INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, collection, playlist_id)
);

CREATE TABLE IF NOT EXISTS sync_write_budget (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  rows_written INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS sync_user_meta (
  user_id TEXT PRIMARY KEY,
  history_cleared_at INTEGER NOT NULL
);

-- Backfill penghitung dari data yang sudah ada (pengguna lama).
-- updated_at diisi waktu migrasi supaya rekonsiliasi usia-24-jam
-- tidak langsung menyala di push pertama sesudah migrasi.
INSERT OR IGNORE INTO sync_counts (user_id, collection, playlist_id, n, updated_at)
  SELECT user_id, 'playlists', '', COUNT(*), CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM sync_playlists GROUP BY user_id;
INSERT OR IGNORE INTO sync_counts (user_id, collection, playlist_id, n, updated_at)
  SELECT user_id, 'likes', '', COUNT(*), CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM sync_likes GROUP BY user_id;
INSERT OR IGNORE INTO sync_counts (user_id, collection, playlist_id, n, updated_at)
  SELECT user_id, 'history', '', COUNT(*), CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM sync_history GROUP BY user_id;
INSERT OR IGNORE INTO sync_counts (user_id, collection, playlist_id, n, updated_at)
  SELECT user_id, 'items', playlist_id, COUNT(*), CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM sync_playlist_items WHERE user_id IS NOT NULL GROUP BY user_id, playlist_id;
