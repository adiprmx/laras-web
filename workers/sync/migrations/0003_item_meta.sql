-- Migrasi 0003: metadata lagu di tabel sinkronisasi (P7)
-- Database: laras-web-sync (uuid 3a2cb6d6-5481-42a1-b213-070215cd2ce5)
--
-- Masalah yang dipecahkan: baris sync hanya membawa video_id.
-- Saat perangkat kedua menarik playlist/favorit/riwayat, lagu
-- yang belum ada di library lokalnya tidak punya judul/artis
-- untuk ditampilkan — client terpaksa mengarang judul atau
-- menghilangkan lagunya dari daftar. Kolom nullable ini membawa
-- judul + artis apa adanya dari perangkat pengirim (metadata
-- tampilan saja, bukan sumber kebenaran katalog).
--
-- Kolom nullable: baris lama (dari spike S8) tetap valid, dan
-- Worker sync P7 WAJIB diterapkan sesudah migrasi ini (SQL-nya
-- memakai kolom-kolom ini). Bila koordinator deploy Worker
-- sebelum migrasi, endpoint push/pull gagal dengan galat D1
-- "no such column" — itu terdeteksi di smoke test deploy.
-- Batas: judul maks 500 karakter, artis maks 500 karakter
-- (ditegakkan Worker saat validasi body, bukan CHECK di sini,
-- supaya pesan galatnya bisa menyebut kolomnya).

ALTER TABLE sync_playlist_items ADD COLUMN title TEXT;
ALTER TABLE sync_playlist_items ADD COLUMN artist TEXT;
ALTER TABLE sync_likes ADD COLUMN title TEXT;
ALTER TABLE sync_likes ADD COLUMN artist TEXT;
ALTER TABLE sync_history ADD COLUMN title TEXT;
ALTER TABLE sync_history ADD COLUMN artist TEXT;
