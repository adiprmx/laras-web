#!/usr/bin/env python3
"""Uji rate limit S7 via curl paralel (fetch Node tidak bisa egress).
- InnerTube: 70x POST {} ke /api/innertube/player, konkurensi 20.
  Batas: 60/menit per IP -> harap 429 muncul sekitar request ke-61
  (bucket in-memory per isolate: penyebaran antar isolate bisa
  menggeser angka persisnya; yang dibuktikan adalah 429 TERJADI).
- Media: 12x GET Range 0-1023 ke /api/media (URL googlevideo S6),
  konkurensi 6. Batas: 10/menit per IP -> harap 429 setelah ke-10.
Hasil ke s7-ratelimit-result.json.
"""
import json
import subprocess
import tempfile
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

PROXY = "https://laras-proxy-spike.hiroohengkerr.workers.dev"
ORIGIN = "http://127.0.0.1:4173"
OUT = "/home/hatch/workspace/music-app-web/app/tests/spikes/s7-ratelimit-result.json"

with open("/home/hatch/workspace/music-app-web/app/tests/spikes/s6-result.json") as f:
    s6 = json.load(f)
GV_URL = s6["tests"]["B_googlevideo"]["stateAfterOnline"]["src"]
MEDIA_URL = f"{PROXY}/api/media?u=" + urllib.parse.quote(GV_URL, safe="")


def one(args):
    i, kind = args
    with tempfile.NamedTemporaryFile(delete=False) as hf:
        hpath = hf.name
    if kind == "innertube":
        cmd = ["curl", "-s", "-D", hpath, "-o", "/dev/null", "-w", "%{http_code} %{time_total}",
               "--max-time", "90", "-X", "POST", f"{PROXY}/api/innertube/player",
               "-H", "Content-Type: application/json", "-H", f"Origin: {ORIGIN}",
               "-d", "{}"]
    else:
        cmd = ["curl", "-s", "-D", hpath, "-o", "/dev/null", "-w", "%{http_code} %{time_total}",
               "--max-time", "90", MEDIA_URL, "-H", f"Origin: {ORIGIN}", "-H", "Range: bytes=0-1023"]
    t0 = datetime.now(timezone.utc)
    try:
        p = subprocess.run(cmd, capture_output=True, timeout=120)
        out = p.stdout.decode().strip().split()
        status, total = int(out[0]), float(out[1])
    except Exception as e:  # noqa: BLE001
        return {"i": i, "kind": kind, "status": "ERR", "error": str(e)[:80]}
    retry_after, cpu = None, None
    try:
        with open(hpath, "rb") as f:
            raw = f.read().decode("latin1")
        blocks = [b for b in raw.replace("\r\n", "\n").split("\n\n") if b.strip()]
        if blocks:
            for line in blocks[-1].splitlines()[1:]:
                if ":" in line:
                    k, v = line.split(":", 1)
                    if k.strip().lower() == "retry-after":
                        retry_after = v.strip()
                    if k.strip().lower() == "x-proxy-cpu-ms":
                        cpu = v.strip()
    except (OSError, IndexError):
        pass
    return {"i": i, "kind": kind, "status": status, "ms": round(total * 1000),
            "retry_after": retry_after, "cpu_ms": cpu,
            "at": t0.isoformat()}


def run(kind, n, conc):
    print(f"--- {kind}: {n} request, konkurensi {conc} ---", flush=True)
    t0 = datetime.now(timezone.utc)
    with ThreadPoolExecutor(max_workers=conc) as ex:
        results = list(ex.map(one, [(i + 1, kind) for i in range(n)]))
    results.sort(key=lambda r: r["i"])
    total_ms = (datetime.now(timezone.utc) - t0).total_seconds() * 1000
    dist = {}
    for r in results:
        dist[str(r["status"])] = dist.get(str(r["status"]), 0) + 1
    first429 = next((r for r in results if r["status"] == 429), None)
    print(f"total: {round(total_ms)} ms; distribusi: {json.dumps(dist)}", flush=True)
    print(f"429 pertama: #{first429['i']} Retry-After={first429['retry_after']} cpu={first429['cpu_ms']}"
          if first429 else "429 pertama: tidak ada", flush=True)
    print("urutan: " + " ".join(f"{r['i']}:{r['status']}" for r in results), flush=True)
    return {"kind": kind, "n": n, "conc": conc, "total_ms": round(total_ms),
            "dist": dist, "first429": first429, "results": results}


report = {
    "proxy": PROXY,
    "at": datetime.now(timezone.utc).isoformat(),
    "innertube_limit_per_min": 60,
    "media_limit_per_min": 10,
    "innertube": run("innertube", 70, 20),
    "media": run("media", 12, 6),
}
with open(OUT, "w") as f:
    json.dump(report, f, indent=2)
print(f"tersimpan: {OUT}", flush=True)
