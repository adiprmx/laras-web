#!/usr/bin/env python3
"""S10 uji burst: 30 request /api/get konkuren (maks 10 bersamaan) dengan
header pengenal client, untuk melihat apakah batas laju teridentifikasi
(~90/menit menurut dokumentasi resmi) memberi 429. Tetap di dalam batas
yang didokumentasikan; bukan flood."""
import json
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

BASE = "https://lrclib.net"
CLIENT = "LarasWeb/1.0 (spike-s10; +https://github.com/adiprmx/laras-web)"
# (artis, judul, durasi detik) - lagu terkenal supaya /api/get menemukan lirik.
TRACKS = [
    ("Coldplay", "Yellow", 269), ("Coldplay", "Viva la Vida", 242),
    ("Coldplay", "Fix You", 295), ("Coldplay", "The Scientist", 309),
    ("Coldplay", "Clocks", 307), ("Queen", "Bohemian Rhapsody", 355),
    ("Queen", "We Will Rock You", 122), ("Queen", "We Are the Champions", 180),
    ("The Beatles", "Hey Jude", 431), ("The Beatles", "Let It Be", 243),
    ("The Beatles", "Yesterday", 125), ("Adele", "Someone Like You", 285),
    ("Adele", "Rolling in the Deep", 228), ("Adele", "Hello", 295),
    ("Ed Sheeran", "Shape of You", 234), ("Ed Sheeran", "Perfect", 263),
    ("Ed Sheeran", "Thinking Out Loud", 281), ("Billie Eilish", "Bad Guy", 194),
    ("Dua Lipa", "Levitating", 203), ("Harry Styles", "As It Was", 167),
    ("Radiohead", "Creep", 237), ("Radiohead", "Karma Police", 262),
    ("Radiohead", "No Surprises", 229), ("Oasis", "Wonderwall", 259),
    ("Oasis", "Don't Look Back in Anger", 289), ("Nirvana", "Smells Like Teen Spirit", 279),
    ("Guns N' Roses", "Sweet Child O' Mine", 356), ("Eagles", "Hotel California", 391),
    ("John Lennon", "Imagine", 183), ("ABBA", "Dancing Queen", 231),
]

def one(track):
    artist, title, dur = track
    url = (f"{BASE}/api/get?artist_name={artist.replace(' ', '%20').replace(chr(39), '%27')}"
           f"&track_name={title.replace(' ', '%20').replace(chr(39), '%27')}&duration={dur}")
    cmd = ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code} %{time_total} %{size_download}",
           "--max-time", "30",
           "-H", f"X-User-Agent: {CLIENT}",
           "-H", f"Lrclib-Client: {CLIENT}", url]
    r = subprocess.run(cmd, capture_output=True, text=True)
    parts = r.stdout.strip().split()
    code = int(parts[0]) if parts and parts[0].isdigit() else -1
    secs = float(parts[1]) if len(parts) > 1 else -1.0
    size = int(parts[2]) if len(parts) > 2 else -1
    return {"track": f"{artist} - {title}", "status": code, "seconds": round(secs, 3), "bytes": size}

def main():
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=10) as ex:
        results = list(ex.map(one, TRACKS))
    total = time.time() - t0
    counts = {}
    for r in results:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
        print(f"{r['status']} {r['seconds']:>6.3f}s {r['bytes']:>6}B {r['track']}")
    print(json.dumps({"total_seconds": round(total, 2), "concurrency": 10,
                      "status_counts": counts, "rate_limited_429": counts.get(429, 0)},
                     indent=2))
    with open("/tmp/s10_burst_results.json", "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)

if __name__ == "__main__":
    main()
