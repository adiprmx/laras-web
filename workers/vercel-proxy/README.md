# Proxy InnerTube player via Vercel (egress kedua Laras Web)

Serverless function minimal yang mem-proxy `POST /api/innertube/player`
ke `https://www.youtube.com/youtubei/v1/player` — jalan keluar kedua
bila egress Cloudflare Workers ditolak YouTube (`LOGIN_REQUIRED`).

Pola sama dengan `workers/proxy` (Cloudflare): byte-only forward —
teruskan body + header client, kembalikan status + body apa adanya.
TIDAK mengeksekusi base.js, TIDAK memecahkan cipher, TIDAK menyimpan
data pengguna, TIDAK mencatat body request/response (log hanya status
+ ukuran + durasi, tanpa videoId).

## Batas

- Body POST maks 1 MB, JSON youtubei maks 10 MB, timeout upstream
  30 dtk, rate limit 60/menit per IP (in-memory per instance —
  best-effort, bukan pengganti rate limit D1 di proxy CF).
- Penjaga keras 28 dtk: fungsi WAJIB merespons dalam 28 dtk apa pun
  yang terjadi di upstream (maxDuration fungsi 30 dtk, `vercel.json`).
- CORS: hanya `https://laras.adipmusic.my.id`,
  `https://laras-web.pages.dev`, `https://preview.laras-web.pages.dev`.

## Proyek Vercel

- Nama proyek: `laras-proxy-vercel` (proyek BARU, terpisah dari
  proyek lain; JANGAN sentuh `dokter-hp-web` atau proyek lain).
- ID proyek: `prj_F9PSuRV113OTiSBDm7UGs8BwLAGW`
- Tim: `Adip Fvnky's projects` (`team_tDEfHrtDtl7q1Q2gyvuCoaxs`),
  plan Hobby (gratis).
- URL produksi: `https://laras-proxy-vercel-adiprmx.vercel.app`
  (alias kedua: `https://laras-proxy-vercel.vercel.app`).
- Deployment awal: `dpl_FU18EPWuYy1u5ug9cyido7mEadve` (19 Nov 2026);
  redeploy penjaga keras: `dpl_9q6vkaHoMJVXZMf31KGygDk5CFnv`.

## Deploy (via REST API, tanpa CLI)

Skrip deploy ada di `/tmp/vercel-egress/deploy_vercel_proxy.py`
(di luar repo karena memakai helper kredensial; koordinator bisa
memintanya bila perlu redeploy). Intinya:

```
POST /v13/deployments?teamId=team_tDEfHrtDtl7q1Q2gyvuCoaxs
{
  "name": "laras-proxy-vercel",
  "project": "laras-proxy-vercel",
  "target": "production",
  "files": [
    {"file": "api/innertube/player.js", "data": "<isi>", "encoding": "utf-8"},
    {"file": "vercel.json", "data": "<isi>", "encoding": "utf-8"}
  ],
  "projectSettings": {"framework": null}
}
```

Kredensial lewat helper `vercel_api.py`
(`~/workspace/custom-connectors/custom.legacy-vercel/bin/`, credential
`custom.vercel`) — nilai mentah tidak pernah dicetak/disimpan.
Jalankan dengan
`PYTHONPATH=/opt/muse/skills/custom-connector-setup/bin` (jalur
template lama di helper sudah tidak ada).

## Jebakan yang terbukti (19 Nov 2026)

1. **Deployment Protection (SSO) AKTIF secara default** untuk proyek
   baru via API (`ssoProtection.deploymentType =
   "all_except_custom_domains"`): semua URL `*.vercel.app` me-redirect
   302 ke `vercel.com/sso-api` sampai dimatikan. Perintah yang
   mematikan (HANYA proyek ini):
   `PATCH /v9/projects/prj_F9PSuRV113OTiSBDm7UGs8BwLAGW?teamId=...`
   dengan `{"ssoProtection": null}`. Berlaku langsung ke deployment
   yang sudah READY (tanpa redeploy). Catatan: `dokter-hp-web` punya
   setelan yang sama — mirror `*.vercel.app`-nya kemungkinan juga
   di balik SSO; akses publiknya lewat custom domain.
2. **Egress VM ke `*.vercel.app` lambat + flapping**: round trip
   15–23 dtk saat sehat, kadang hang total (HTTP 000) sampai
   timeout 60–90 dtk. Probe 000 BUKAN bukti fungsi mati — ulangi
   2–3x dengan `--max-time` ≥ 120 dtk.
3. **Fungsi WAJIB punya penjaga timeout keras**: versi pertama
   (hanya `AbortSignal.timeout(30s)` di fetch) 6/6 probe POST
   menggantung sampai batas curl 70 dtk tanpa respons. Dengan
   penjaga `setTimeout` 28 dtk yang memaksa respons 502, POST
   kembali dengan jawaban nyata.

## Jalur diagnosis

`POST /api/innertube/player?ping=1` membalas `{"success":true,
"ping":"ok"}` langsung tanpa menyentuh YouTube — membedakan
"transport macet" dari "upstream macet". Dipakai probe deploy,
bukan jalur produksi.

## Hasil uji egress

Lihat `docs/vercel-egress.md` (tabel bukti + vonis).
