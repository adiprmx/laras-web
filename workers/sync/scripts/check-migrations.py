#!/usr/bin/env python3
"""Cek migrasi D1 (P-Shared): terapkan 0001-0008 ke SQLite fresh.

Menangkap migrasi yang rusak SEBELUM merge: kesalahan sintaks,
urutan salah (kolom/tabel belum ada), atau tabel yang gagal dibuat.
Dipakai CI (job `check`) dan lokal:

    python3 workers/sync/scripts/check-migrations.py

Hanya stdlib (sqlite3) — tanpa dependensi. Exit 0 = semua migrasi
diterapkan + 16 tabel ada + integrity_check ok + foreign_key_check
kosong. Exit 1 = gagal, dengan pesan yang menyebut file penyebab.
"""

import sqlite3
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
MIGRATIONS = HERE.parent / "migrations"

# Tabel yang WAJIB ada sesudah 0001-0008 (diukur dari CREATE TABLE
# di 8 file migrasi, 22 Nov 2026). Bila migrasi baru menambah tabel,
# tambahkan namanya di sini.
EXPECTED_TABLES = {
    "cache_targets",
    "oauth_states",
    "rate_limits",
    "resolve_cache",
    "sessions",
    "sync_counts",
    "sync_deleted_identities",
    "sync_history",
    "sync_likes",
    "sync_playlist_items",
    "sync_playlists",
    "sync_read_budget",
    "sync_settings",
    "sync_user_meta",
    "sync_write_budget",
    "users",
}


def main() -> int:
    files = sorted(MIGRATIONS.glob("*.sql"))
    if not files:
        print(f"GAGAL: tidak ada *.sql di {MIGRATIONS}")
        return 1
    print(f"migrasi: {len(files)} file ({files[0].name} .. {files[-1].name})")

    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "fresh.sqlite"
        conn = sqlite3.connect(db_path)
        try:
            for f in files:
                try:
                    conn.executescript(f.read_text(encoding="utf-8"))
                except sqlite3.Error as e:
                    print(f"GAGAL: {f.name}: {e}")
                    return 1
                print(f"  ok: {f.name}")
            # PRAGMA integrity_check harus 'ok'.
            integrity = conn.execute("PRAGMA integrity_check").fetchall()
            if integrity != [("ok",)]:
                print(f"GAGAL: integrity_check: {integrity}")
                return 1
            # PRAGMA foreign_key_check harus kosong (saat ini tanpa
            # FK eksplisit — penjaga untuk migrasi mendatang).
            fk = conn.execute("PRAGMA foreign_key_check").fetchall()
            if fk:
                print(f"GAGAL: foreign_key_check: {fk}")
                return 1
            tables = {
                r[0]
                for r in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
            missing = EXPECTED_TABLES - tables
            if missing:
                print(f"GAGAL: tabel hilang: {sorted(missing)}")
                return 1
            print(f"OK: {len(files)} migrasi, {len(tables)} tabel, "
                  f"integrity ok, foreign_key_check kosong")
            return 0
        finally:
            conn.close()


if __name__ == "__main__":
    sys.exit(main())
