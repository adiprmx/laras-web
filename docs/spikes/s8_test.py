#!/usr/bin/env python3
"""Uji spike S8: sync D1 end-to-end SEJAUH YANG BISA DIUJI TANPA OAuth nyata.
Identitas pengguna di sini adalah SIMULASI (baris users yang disisipkan
langsung, seolah-olah OAuth sudah mengembalikan provider_id). Alur OAuth
Google/GitHub yang sesungguhnya TIDAK diuji di sini karena butuh kredensial
owner; celah itu dicatat jujur di laporan.

Menggunakan token Cloudflare yang sama dengan helper cfw_t.py (file 0600),
tidak pernah mencetak isi token.
"""
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

TOKEN_FILE = Path.home() / "workspace/temp-mail/secrets/cf-api-token"
BASE = "https://api.cloudflare.com/client/v4"
ACCOUNT = "05928ed4e4ed9643a5665d1e59315abe"
DB = "3a2cb6d6-5481-42a1-b213-070215cd2ce5"

TOTALS = {"rows_read": 0, "rows_written": 0, "queries": 0}
CHECKS = []


def check(name, ok, detail=""):
    CHECKS.append((name, bool(ok), detail))
    print(f"[{'LOLOS' if ok else 'GAGAL'}] {name}" + (f" -- {detail}" if detail else ""),
          flush=True)


def d1(sql, params=None):
    """Satu statement ke D1 lewat REST API. Mengembalikan (results, meta)."""
    token = TOKEN_FILE.read_text(encoding="utf-8").strip()
    body = json.dumps({"sql": sql, "params": params or []})
    cmd = ["curl", "-s", "--max-time", "60", "-X", "POST",
           "-H", "Authorization: Bearer " + token,
           "-H", "Content-Type: application/json",
           "-d", body,
           f"{BASE}/accounts/{ACCOUNT}/d1/database/{DB}/query"]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"curl gagal: {r.stderr.strip()[:200]}")
    try:
        payload = json.loads(r.stdout)
    except json.JSONDecodeError:
        raise RuntimeError(f"respons bukan JSON: {r.stdout[:200]}")
    if not payload.get("success"):
        raise RuntimeError(f"D1 error: {json.dumps(payload.get('errors'))} | sql={sql[:120]}")
    res = payload["result"][0]
    meta = res.get("meta", {})
    TOTALS["rows_read"] += meta.get("rows_read", 0)
    TOTALS["rows_written"] += meta.get("rows_written", 0)
    TOTALS["queries"] += 1
    return res.get("results", []), meta


def d1_batch(statements):
    token = TOKEN_FILE.read_text(encoding="utf-8").strip()
    body = json.dumps({"queries": [{"sql": s, "params": []} for s in statements]})
    cmd = ["curl", "-s", "--max-time", "120", "-X", "POST",
           "-H", "Authorization: Bearer " + token,
           "-H", "Content-Type: application/json",
           "-d", body,
           f"{BASE}/accounts/{ACCOUNT}/d1/database/{DB}/batch"]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"curl gagal: {r.stderr.strip()[:200]}")
    payload = json.loads(r.stdout)
    if not payload.get("success"):
        raise RuntimeError(f"D1 batch error: {json.dumps(payload.get('errors'))}")
    for res in payload["result"]:
        meta = res.get("meta", {})
        TOTALS["rows_read"] += meta.get("rows_read", 0)
        TOTALS["rows_written"] += meta.get("rows_written", 0)
        TOTALS["queries"] += 1
    return payload["result"]


def now_ms():
    return int(time.time() * 1000)


# ---------------------------------------------------------------- migrasi
def apply_migration():
    sql = Path.home().joinpath(
        "workspace/music-app-web/workers/sync/0001_init.sql").read_text(encoding="utf-8")
    # Buang baris komentar, pecah per statement. File ini tidak mengandung
    # titik koma di dalam string, jadi pemecahan sederhana aman.
    lines = [ln for ln in sql.splitlines() if not ln.strip().startswith("--")]
    stmts = [s.strip() for s in "\n".join(lines).split(";") if s.strip()]
    # Endpoint /batch mengembalikan "Route not found" di API ini, jadi
    # tiap statement dijalankan satu per satu lewat /query.
    for s in stmts:
        d1(s)
    rows, _ = d1("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    names = sorted(r["name"] for r in rows)
    expected = ["sessions", "sync_history", "sync_likes", "sync_playlist_items",
                "sync_playlists", "sync_settings", "users"]
    check("Migrasi: 7 tabel dibuat", names == expected, f"tabel={names}")
    rows, _ = d1("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name")
    check("Migrasi: indeks filter dibuat", len(rows) >= 7,
          f"{len(rows)} indeks: {[r['name'] for r in rows]}")


# ---------------------------------------------------------------- helpers
def upsert_playlist(pid, uid, client_id, nama, device, updated_at, deleted_at=None):
    d1("""INSERT INTO sync_playlists
          (id, user_id, client_id, nama, deskripsi, device_id, updated_at, deleted_at)
          VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            nama = excluded.nama, device_id = excluded.device_id,
            updated_at = excluded.updated_at, deleted_at = excluded.deleted_at
          WHERE excluded.updated_at > sync_playlists.updated_at
             OR (excluded.updated_at = sync_playlists.updated_at
                 AND excluded.device_id > sync_playlists.device_id)""",
       [pid, uid, client_id, nama, device, updated_at, deleted_at])


def pull_playlists(uid, since):
    rows, _ = d1("SELECT id, nama, device_id, updated_at, deleted_at "
                 "FROM sync_playlists WHERE user_id = ? AND updated_at > ? "
                 "ORDER BY updated_at ASC", [uid, since])
    return rows


# ---------------------------------------------------------------- uji
def main():
    apply_migration()

    # --- T1: CRUD dasar + identitas simulasi (pengganti hasil OAuth) ---
    t0 = now_ms()
    d1("INSERT INTO users (id, provider, provider_id, display_name, created_at) "
       "VALUES (?, 'google', ?, ?, ?)",
       ["user-sim-001", "google-sim-123456789", "Pengguna Simulasi", t0])
    rows, _ = d1("SELECT id, provider, provider_id FROM users WHERE id = ?",
                 ["user-sim-001"])
    check("CRUD: pengguna simulasi dibuat dan dibaca", len(rows) == 1
          and rows[0]["provider"] == "google",
          f"provider={rows[0]['provider'] if rows else None}")

    # Sesi: token acak 256-bit, yang disimpan hanya hash SHA-256 (§4.3).
    raw_token = "spike-s8-token-" + hashlib.sha256(b"s8-seed").hexdigest()
    token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
    d1("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) "
       "VALUES (?, ?, ?, ?, ?)",
       ["sess-001", "user-sim-001", token_hash, t0 + 30 * 86400 * 1000, t0])
    rows, _ = d1("SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?",
                 [token_hash, now_ms()])
    check("Sesi: lookup lewat hash token menemukan pengguna", len(rows) == 1
          and rows[0]["user_id"] == "user-sim-001")
    rows, _ = d1("SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?",
                 [hashlib.sha256(b"token-salah").hexdigest(), now_ms()])
    check("Sesi: hash token yang salah tidak menemukan sesi", len(rows) == 0)
    d1("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) "
       "VALUES ('sess-exp', 'user-sim-001', ?, ?, ?)",
       [hashlib.sha256(b"kedaluwarsa").hexdigest(), t0 - 1000, t0])
    rows, _ = d1("SELECT id FROM sessions WHERE token_hash = ? AND expires_at > ?",
                 [hashlib.sha256(b"kedaluwarsa").hexdigest(), now_ms()])
    check("Sesi: sesi kedaluwarsa ditolak lookup", len(rows) == 0)
    d1("DELETE FROM sessions WHERE id = 'sess-exp'")
    rows, _ = d1("SELECT id FROM sessions WHERE id = 'sess-exp'")
    check("CRUD: DELETE sesi berjalan", len(rows) == 0)

    # --- T2: simulasi dua perangkat, tarik/dorong inkremental ---
    # Perangkat A mendorong playlist P1 + 2 item + 1 like + 1 riwayat.
    ta = now_ms()
    upsert_playlist("pl-001", "user-sim-001", "client-A-001", "Lagu Santai",
                    "device-A", ta)
    d1("INSERT INTO sync_playlist_items (playlist_id, video_id, posisi, added_at, device_id, updated_at) "
       "VALUES ('pl-001', 'dQw4w9WgXcQ', 0, ?, 'device-A', ?)", [ta, ta])
    d1("INSERT INTO sync_playlist_items (playlist_id, video_id, posisi, added_at, device_id, updated_at) "
       "VALUES ('pl-001', 'eY52ZikdyYg', 1, ?, 'device-A', ?)", [ta, ta])
    d1("INSERT INTO sync_likes (user_id, video_id, liked_at, device_id, updated_at) "
       "VALUES ('user-sim-001', 'dQw4w9WgXcQ', ?, 'device-A', ?)", [ta, ta])
    d1("INSERT INTO sync_history (user_id, video_id, played_at, seconds_played, device_id, updated_at) "
       "VALUES ('user-sim-001', 'dQw4w9WgXcQ', ?, 187, 'device-A', ?)", [ta, ta])
    d1("INSERT INTO sync_settings (user_id, settings_json, device_id, updated_at) "
       "VALUES ('user-sim-001', '{\"theme\":\"dark\",\"quality\":\"best\"}', 'device-A', ?)", [ta])

    # Perangkat B menarik sejak 0: harus menerima semua yang didorong A.
    got = pull_playlists("user-sim-001", 0)
    check("Sync: perangkat B menarik playlist A (since=0)",
          len(got) == 1 and got[0]["nama"] == "Lagu Santai",
          f"diterima={len(got)} playlist")
    rows, _ = d1("SELECT video_id FROM sync_playlist_items WHERE playlist_id = 'pl-001' "
                 "AND deleted_at IS NULL ORDER BY posisi")
    check("Sync: item playlist ikut tersinkron",
          [r["video_id"] for r in rows] == ["dQw4w9WgXcQ", "eY52ZikdyYg"])
    rows, _ = d1("SELECT video_id FROM sync_likes WHERE user_id = ? AND deleted_at IS NULL",
                 ["user-sim-001"])
    check("Sync: favorit ikut tersinkron", len(rows) == 1)
    rows, _ = d1("SELECT video_id, seconds_played FROM sync_history WHERE user_id = ?",
                 ["user-sim-001"])
    check("Sync: riwayat ikut tersinkron",
          len(rows) == 1 and rows[0]["seconds_played"] == 187)

    # Perangkat B mendorong playlist baru P2 dan mengubah nama P1.
    tb = now_ms()
    while tb <= ta:
        time.sleep(0.01)
        tb = now_ms()
    upsert_playlist("pl-002", "user-sim-001", "client-B-001", "Lagu Kerja",
                    "device-B", tb)
    upsert_playlist("pl-001", "user-sim-001", "client-A-001", "Lagu Santai Malam",
                    "device-B", tb)
    # Perangkat A menarik sejak ta: hanya perubahan sesudah ta yang kembali.
    got = pull_playlists("user-sim-001", ta)
    names = {r["id"]: r["nama"] for r in got}
    check("Sync inkremental: A hanya menerima perubahan sesudah since",
          names == {"pl-001": "Lagu Santai Malam", "pl-002": "Lagu Kerja"},
          f"diterima={names}")
    got = pull_playlists("user-sim-001", tb)
    check("Sync inkremental: since=terbaru mengembalikan nol baris", len(got) == 0)

    # --- T3: konflik last-write-wins ---
    tc = now_ms()
    while tc <= tb:
        time.sleep(0.01)
        tc = now_ms()
    # A menulis duluan (tc), B menulis kemudian (tc+50): yang kemudian menang.
    upsert_playlist("pl-001", "user-sim-001", "client-A-001", "Nama dari A",
                    "device-A", tc)
    upsert_playlist("pl-001", "user-sim-001", "client-A-001", "Nama dari B",
                    "device-B", tc + 50)
    rows, _ = d1("SELECT nama, device_id FROM sync_playlists WHERE id = 'pl-001'")
    check("LWW: tulis yang lebih baru menang",
          rows[0]["nama"] == "Nama dari B", f"nama={rows[0]['nama']}")
    # Tulis lama yang datang terlambat (out-of-order) harus ditolak.
    upsert_playlist("pl-001", "user-sim-001", "client-A-001", "Nama lama terlambat",
                    "device-A", tc)
    rows, _ = d1("SELECT nama FROM sync_playlists WHERE id = 'pl-001'")
    check("LWW: tulis lama yang datang terlambat ditolak",
          rows[0]["nama"] == "Nama dari B", f"nama={rows[0]['nama']}")
    # Seri updated_at yang sama persis: device_id terbesar menang, deterministik.
    tt = tc + 1000
    upsert_playlist("pl-002", "user-sim-001", "client-B-001", "Seri dari A",
                    "device-A", tt)
    upsert_playlist("pl-002", "user-sim-001", "client-B-001", "Seri dari B",
                    "device-B", tt)
    rows, _ = d1("SELECT nama, device_id FROM sync_playlists WHERE id = 'pl-002'")
    check("LWW seri: device_id terbesar menang (B sesudah A)",
          rows[0]["nama"] == "Seri dari B" and rows[0]["device_id"] == "device-B",
          f"nama={rows[0]['nama']}, device={rows[0]['device_id']}")
    # Ulangi urutan terbalik pada playlist lain: pemenang harus sama (B).
    upsert_playlist("pl-001", "user-sim-001", "client-A-001", "Seri B dulu",
                    "device-B", tt + 10)
    upsert_playlist("pl-001", "user-sim-001", "client-A-001", "Seri A kemudian",
                    "device-A", tt + 10)
    rows, _ = d1("SELECT nama, device_id FROM sync_playlists WHERE id = 'pl-001'")
    check("LWW seri: pemenang sama bila urutan dibalik (deterministik)",
          rows[0]["nama"] == "Seri B dulu" and rows[0]["device_id"] == "device-B",
          f"nama={rows[0]['nama']}, device={rows[0]['device_id']}")

    # --- T4: tombstone hapus ---
    td = now_ms()
    while td <= tt + 10:
        time.sleep(0.01)
        td = now_ms()
    d1("UPDATE sync_playlists SET deleted_at = ?, updated_at = ?, device_id = 'device-A' "
       "WHERE id = 'pl-002'", [td, td])
    # Perangkat B menarik sejak tb: tombstone harus ikut terkirim.
    got = pull_playlists("user-sim-001", tb)
    tomb = [r for r in got if r["id"] == "pl-002"]
    check("Tombstone: hapus terkirim lewat tarik inkremental",
          len(tomb) == 1 and tomb[0]["deleted_at"] == td,
          f"deleted_at={tomb[0]['deleted_at'] if tomb else None}")
    # Baris masih ada di server (retensi 30 hari), tetapi daftar aktif menyembunyikannya.
    rows, _ = d1("SELECT id, deleted_at FROM sync_playlists WHERE id = 'pl-002'")
    check("Tombstone: baris dipertahankan di server (retensi)",
          len(rows) == 1 and rows[0]["deleted_at"] == td)
    rows, _ = d1("SELECT id FROM sync_playlists WHERE user_id = ? AND deleted_at IS NULL",
                 ["user-sim-001"])
    check("Tombstone: daftar aktif menyembunyikan yang terhapus",
          [r["id"] for r in rows] == ["pl-001"])
    # Hapus yang sudah di-tombstone tidak bisa dihidupkan lagi oleh tulis lama.
    upsert_playlist("pl-002", "user-sim-001", "client-B-001", "Bangkit dari lama",
                    "device-B", tb)
    rows, _ = d1("SELECT deleted_at FROM sync_playlists WHERE id = 'pl-002'")
    check("Tombstone: tulis lama tidak menghidupkan yang terhapus",
          rows[0]["deleted_at"] == td)

    # --- T5: batas skema ---
    try:
        d1("INSERT INTO sync_settings (user_id, settings_json, device_id, updated_at) "
           "VALUES ('user-sim-001', ?, 'device-A', ?)", ["x" * 5000, now_ms()])
        check("Batas: settings_json di atas 4 KB ditolak", False,
              "insert 5000 karakter lolos (seharusnya gagal CHECK)")
    except RuntimeError as e:
        check("Batas: settings_json di atas 4 KB ditolak", "CHECK" in str(e),
              str(e)[:120])

    # --- Ringkasan ---
    failed = [c for c in CHECKS if not c[1]]
    print()
    print(f"TOTAL: {len(CHECKS) - len(failed)}/{len(CHECKS)} cek lolos; "
          f"{len(failed)} gagal")
    print(f"D1 terpakai spike ini: {TOTALS['queries']} query, "
          f"{TOTALS['rows_read']} baris dibaca, {TOTALS['rows_written']} baris ditulis")
    print("Batas harian D1 free-tier: 5.000.000 baris dibaca, 100.000 baris ditulis")
    if TOTALS["rows_read"]:
        print(f"Pemakaian baca: {TOTALS['rows_read'] / 5000000 * 100:.4f}% dari batas harian")
    if TOTALS["rows_written"]:
        print(f"Pemakaian tulis: {TOTALS['rows_written'] / 100000 * 100:.4f}% dari batas harian")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
