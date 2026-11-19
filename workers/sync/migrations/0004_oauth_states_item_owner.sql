-- Migrasi 0004: state OAuth sekali pakai + kepemilikan item (Blue 3, Red 3 S6/R11)
-- Database: laras-web-sync (uuid 3a2cb6d6-5481-42a1-b213-070215cd2ce5)
--
-- S6: tabel oauth_states menyimpan HASH SHA-256 state OAuth yang
-- dikeluarkan login (bukan state mentah — bocor tabel tidak memberi
-- penyerang state yang bisa dipakai). Callback menghapus baris saat
-- state dipakai, jadi state tidak bisa dipakai dua kali. TTL
-- 10 menit (sama dengan cookie state); baris kedaluwarsa disapu
-- tiap login. Tanpa tabel ini Worker fail-open (login tetap jalan,
-- single-use nonaktif) — koordinator WAJIB menerapkan migrasi ini
-- SEBELUM deploy Worker yang memakai tabel ini.
--
-- R11: kolom user_id di sync_playlist_items mencatat pemilik item
-- (sebelumnya kepemilikan item hanya bisa ditebak lewat join ke
-- playlist induk). Backfill mengisi baris lama dari user_id
-- playlist induknya; item yatim (playlist induk tidak ada) tetap
-- NULL dan tidak lagi bisa dibuat baru (push menolak item untuk
-- playlist yang bukan milik pendorong atau tidak ada).

CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'github')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_states_expires
  ON oauth_states(expires_at);

ALTER TABLE sync_playlist_items ADD COLUMN user_id TEXT;
UPDATE sync_playlist_items SET user_id = (
  SELECT user_id FROM sync_playlists
  WHERE sync_playlists.id = sync_playlist_items.playlist_id
) WHERE user_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_items_user
  ON sync_playlist_items(user_id, updated_at);
