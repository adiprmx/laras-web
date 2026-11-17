#!/usr/bin/env python3
"""S10 probe langsung: 50 request LRCLIB berurutan dengan header pengenal client.
Mencatat status, header rate limit, dan header CORS. Tanpa dependensi baru."""
import json
import subprocess
import sys
import time

BASE = "https://lrclib.net"
CLIENT = "LarasWeb/1.0 (spike-s10; +https://github.com/adiprmx/laras-web)"
# Kueri bervariasi supaya tiap request adalah pencarian nyata yang berbeda.
QUERIES = [
    "Bohemian Rhapsody", "Imagine", "Hotel California", "Shape of You",
    "Blinding Lights", "Someone Like You", "Rolling in the Deep",
    "Uptown Funk", "Despacito", "Perfect", "Thinking Out Loud",
    "Bad Guy", "Levitating", "Watermelon Sugar", "drivers license",
    "Stay", "As It Was", "Anti-Hero", "Flowers", "Kill Bill",
    "Viva la Vida", "Yellow", "Fix You", "The Scientist", "Clocks",
    "Hallelujah", "Let It Be", "Hey Jude", "Yesterday", "Come Together",
    "Stairway to Heaven", "Sweet Child O Mine", "November Rain",
    "Smells Like Teen Spirit", "Come As You Are", "Wonderwall",
    "Don't Look Back in Anger", "Champagne Supernova", "Creep",
    "Karma Police", "No Surprises", "Paranoid Android", "Fake Plastic Trees",
    "High and Dry", "Exit Music", "Let Down", "Idioteque", "Everything in Its Right Place",
    "Pyramid Song", "Weird Fishes",
]

def one(i, q):
    url = f"{BASE}/api/search?track_name={q.replace(' ', '%20')}"
    cmd = ["curl", "-s", "-o", "/tmp/s10_body.json", "-w",
           "%{http_code} %{time_total} %{size_download}",
           "--max-time", "30",
           "-H", f"X-User-Agent: {CLIENT}",
           "-H", f"Lrclib-Client: {CLIENT}",
           "-D", "/tmp/s10_headers.txt", url]
    r = subprocess.run(cmd, capture_output=True, text=True)
    parts = r.stdout.strip().split()
    code = int(parts[0]) if parts and parts[0].isdigit() else -1
    secs = float(parts[1]) if len(parts) > 1 else -1.0
    size = int(parts[2]) if len(parts) > 2 else -1
    headers = {}
    try:
        with open("/tmp/s10_headers.txt", encoding="utf-8", errors="replace") as f:
            for line in f:
                if ":" in line:
                    k, v = line.split(":", 1)
                    headers[k.strip().lower()] = v.strip()
    except OSError:
        pass
    rl = {k: v for k, v in headers.items()
          if "ratelimit" in k or "retry-after" in k or k == "access-control-allow-origin"}
    return {"n": i + 1, "query": q, "status": code, "seconds": round(secs, 3),
            "bytes": size, "headers": rl}

def main():
    results = []
    t0 = time.time()
    for i, q in enumerate(QUERIES):
        res = one(i, q)
        results.append(res)
        print(f"{res['n']:>2}/50 {res['status']} {res['seconds']:>6.3f}s "
              f"{res['bytes']:>6}B {res['query'][:40]:40} {res['headers']}",
              flush=True)
    total = time.time() - t0
    codes = {}
    for r in results:
        codes[r["status"]] = codes.get(r["status"], 0) + 1
    print(json.dumps({"total_seconds": round(total, 2),
                      "status_counts": codes,
                      "rate_limited_429": codes.get(429, 0)}, indent=2))
    with open("/tmp/s10_direct_results.json", "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    print("saved /tmp/s10_direct_results.json")

if __name__ == "__main__":
    main()
