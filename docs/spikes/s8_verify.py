#!/usr/bin/env python3
"""Verifikasi susulan S8: koreksi cek daftar tabel (D1 membuat tabel internal
_cf_KV sendiri) + verifikasi ulang keadaan akhir database setelah uji utama.
Tidak mengubah data, hanya membaca."""
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, "/tmp")
from s8_test import d1, check, CHECKS, TOTALS  # noqa: E402  (pakai ulang helper d1)

rows, _ = d1("SELECT name FROM sqlite_master WHERE type='table' "
             "AND name NOT LIKE 'sqlite_%' ORDER BY name")
names = [r["name"] for r in rows]
expected = ["sessions", "sync_history", "sync_likes", "sync_playlist_items",
            "sync_playlists", "sync_settings", "users"]
check("Migrasi (koreksi): 7 tabel app ada",
      all(t in names for t in expected), f"tabel={names}")
check("Migrasi (koreksi): tabel ekstra hanya _cf_KV internal D1",
      [n for n in names if n not in expected] == ["_cf_KV"])

for table in expected:
    rows, _ = d1(f"SELECT COUNT(*) AS c FROM {table}")
    print(f"  {table}: {rows[0]['c']} baris")

rows, _ = d1("SELECT id, nama, deleted_at FROM sync_playlists ORDER BY id")
for r in rows:
    print(f"  playlist {r['id']}: nama={r['nama']!r} deleted_at={r['deleted_at']}")
check("Keadaan akhir: pl-001 aktif, pl-002 tombstone",
      len(rows) == 2 and rows[0]["deleted_at"] is None and rows[1]["deleted_at"] is not None)

failed = [c for c in CHECKS if not c[1]]
print(f"\nVERIFIKASI SUSULAN: {len(CHECKS) - len(failed)}/{len(CHECKS)} cek lolos")
print(f"Query tambahan: {TOTALS['queries']}, baris dibaca: {TOTALS['rows_read']}")
sys.exit(1 if failed else 0)
