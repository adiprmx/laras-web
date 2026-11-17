-- Migrasi 0001: skema sinkronisasi Laras Web (D1)
-- Sumber spesifikasi: docs/arsitektur.md §4.3 dan §5.3
-- Database: laras-web-sync (uuid 3a2cb6d6-5481-42a1-b213-070215cd2ce5)
-- Akun Cloudflare: 05928ed4e4ed9643a5665d1e59315abe
--
-- Catatan desain:
-- - Semua timestamp adalah milidetik epoch UTC, diisi SERVER (Worker),
--   bukan jam perangkat. Ini yang membuat last-write-wins bisa diandalkan.
-- - Kolom device_id ada di tabel sync untuk pemecah seri deterministik
--   bila dua tulis punya updated_at yang sama persis (§4.3).
-- - Hapus memakai tombstone (deleted_at terisi, baris dipertahankan
--   30 hari lalu dibersihkan job terjadwal). Baris tombstone tetap
--   dikembalikan oleh tarik inkremental supaya perangkat lain ikut hapus.
-- - Indeks wajib di semua kolom filter karena D1 menghitung baris yang
--   dipindai, bukan baris yang dikembalikan (§2.1).
-- - Server TIDAK menyimpan katalog lagu, lirik, file audio, atau URL
--   stream. Hanya data sinkronisasi milik pengguna yang memilih akun.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'github')),
  provider_id TEXT NOT NULL,
  display_name TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (provider, provider_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_hash ON sessions(token_hash);

CREATE TABLE IF NOT EXISTS sync_playlists (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  nama TEXT NOT NULL,
  deskripsi TEXT,
  device_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_playlists_user_updated
  ON sync_playlists(user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_playlists_client
  ON sync_playlists(user_id, client_id);

CREATE TABLE IF NOT EXISTS sync_playlist_items (
  playlist_id TEXT NOT NULL REFERENCES sync_playlists(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL,
  posisi INTEGER NOT NULL,
  added_at INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY (playlist_id, video_id)
);
CREATE INDEX IF NOT EXISTS idx_items_playlist
  ON sync_playlist_items(playlist_id, posisi);
CREATE INDEX IF NOT EXISTS idx_items_updated
  ON sync_playlist_items(playlist_id, updated_at);

CREATE TABLE IF NOT EXISTS sync_likes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL,
  liked_at INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY (user_id, video_id)
);
CREATE INDEX IF NOT EXISTS idx_likes_user_updated
  ON sync_likes(user_id, updated_at);

CREATE TABLE IF NOT EXISTS sync_history (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL,
  played_at INTEGER NOT NULL,
  seconds_played INTEGER NOT NULL DEFAULT 0,
  device_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, video_id, played_at)
);
CREATE INDEX IF NOT EXISTS idx_history_user_played
  ON sync_history(user_id, played_at);

CREATE TABLE IF NOT EXISTS sync_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  settings_json TEXT NOT NULL CHECK (length(settings_json) <= 4096),
  device_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
