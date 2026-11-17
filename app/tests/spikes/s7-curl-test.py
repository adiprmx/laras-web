#!/usr/bin/env python3
"""Uji curl S7 (v2): preflight, 404/405/413, gerbang media, Range media,
dan sampel header x-proxy-cpu-ms. Hasil ke s7-curl-result.json.
Perbaikan v2: status dibaca dari -w %{http_code} dan header diambil dari
BLOK TERAKHIR file -D, karena CONNECT proxy menulis blok header
"200 Connection Established" di depan respons asli.
"""
import json
import subprocess
import tempfile
import urllib.parse
from datetime import datetime, timezone

PROXY = "https://laras-proxy-spike.hiroohengkerr.workers.dev"
ORIGIN = "http://127.0.0.1:4173"
OUT = "/home/hatch/workspace/music-app-web/app/tests/spikes/s7-curl-result.json"

with open("/home/hatch/workspace/music-app-web/app/tests/spikes/s6-result.json") as f:
    s6 = json.load(f)
GV_URL = s6["tests"]["B_googlevideo"]["stateAfterOnline"]["src"]


def curl(args, data=None):
    with tempfile.NamedTemporaryFile(delete=False) as hf, tempfile.NamedTemporaryFile(delete=False) as bf:
        hpath, bpath = hf.name, bf.name
    cmd = ["curl", "-s", "-D", hpath, "-o", bpath, "-w", "%{http_code}",
           "--max-time", "90"] + args
    if data is not None:
        cmd += ["--data-binary", "@-"]
    p = subprocess.run(cmd, input=data, capture_output=True, timeout=120)
    status = int(p.stdout.decode().strip() or 0)
    with open(hpath, "rb") as f:
        raw = f.read().decode("latin1")
    with open(bpath, "rb") as f:
        body = f.read()
    # Blok header terakhir = respons asli (blok pertama milik CONNECT).
    blocks = [b for b in raw.replace("\r\n", "\n").split("\n\n") if b.strip()]
    headers = {}
    for line in blocks[-1].splitlines()[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()
    return {"status": status, "headers": headers, "body": body}


def rec(label, r, expect, extra=None):
    d = {
        "label": label,
        "status": r["status"],
        "expect": expect,
        "pass": r["status"] == expect,
        "cpu_ms": r["headers"].get("x-proxy-cpu-ms"),
        "acao": r["headers"].get("access-control-allow-origin"),
        "body_preview": r["body"][:200].decode("latin1"),
    }
    if extra:
        d.update(extra)
    print(f"{label}: status={r['status']} (harap {expect}) cpu={d['cpu_ms']} lolos={d['pass']}", flush=True)
    return d


results = []
t0 = datetime.now(timezone.utc).isoformat()

r = curl(["-X", "OPTIONS", f"{PROXY}/api/innertube/player",
          "-H", f"Origin: {ORIGIN}",
          "-H", "Access-Control-Request-Method: POST",
          "-H", "Access-Control-Request-Headers: content-type"])
results.append(rec("OPTIONS preflight player", r, 204, {
    "allow_methods": r["headers"].get("access-control-allow-methods"),
    "allow_headers": r["headers"].get("access-control-allow-headers"),
    "expose_headers": r["headers"].get("access-control-expose-headers"),
}))

r = curl([f"{PROXY}/api/tidak-ada", "-H", f"Origin: {ORIGIN}"])
results.append(rec("GET rute tidak dikenal", r, 404))

r = curl([f"{PROXY}/api/innertube/player", "-H", f"Origin: {ORIGIN}"])
results.append(rec("GET /api/innertube/player", r, 405))

big = b'{"x":"' + b"a" * (1024 * 1024) + b'"}'
r = curl(["-X", "POST", f"{PROXY}/api/innertube/player",
          "-H", "Content-Type: application/json",
          "-H", f"Origin: {ORIGIN}"], data=big)
results.append(rec("POST body 1 MB + 7 byte", r, 413, {"body_bytes_sent": len(big)}))

r = curl([f"{PROXY}/api/media", "-H", f"Origin: {ORIGIN}"])
results.append(rec("GET /api/media tanpa u", r, 400))

evil = urllib.parse.quote("https://example.com/audio.webm", safe="")
r = curl([f"{PROXY}/api/media?u={evil}", "-H", f"Origin: {ORIGIN}"])
results.append(rec("GET /api/media host example.com", r, 403))

r = curl([f"{PROXY}/api/player-script?hash=00000000", "-H", f"Origin: {ORIGIN}"])
results.append(rec("GET player-script hash 00000000", r, 403))

media_url = f"{PROXY}/api/media?u=" + urllib.parse.quote(GV_URL, safe="")
r = curl([media_url, "-H", f"Origin: {ORIGIN}", "-H", "Range: bytes=0-1023"])
results.append(rec("GET /api/media Range 0-1023 googlevideo", r, 206, {
    "content_range": r["headers"].get("content-range"),
    "content_type": r["headers"].get("content-type"),
    "bytes_received": len(r["body"]),
}))

cpus = []
for i in range(5):
    r = curl(["-X", "OPTIONS", f"{PROXY}/api/innertube/player", "-H", f"Origin: {ORIGIN}"])
    cpus.append(r["headers"].get("x-proxy-cpu-ms"))
    print(f"  sampel CPU OPTIONS #{i+1}: {cpus[-1]} ms (status {r['status']})", flush=True)
results.append({"label": "Sampel CPU 5x OPTIONS", "cpu_samples_ms": cpus})

report = {
    "proxy": PROXY,
    "at_start": t0,
    "at_end": datetime.now(timezone.utc).isoformat(),
    "parser": "v2 (-w http_code + blok header terakhir)",
    "gv_url_host": urllib.parse.urlparse(GV_URL).hostname,
    "gv_url_expire_utc": "2026-11-17T20:41:37Z",
    "results": results,
    "passed": sum(1 for x in results if x.get("pass")),
    "total_checks": sum(1 for x in results if "pass" in x),
}
with open(OUT, "w") as f:
    json.dump(report, f, indent=2)
print(f"lolos {report['passed']}/{report['total_checks']} cek; tersimpan: {OUT}", flush=True)
