# Proxy InnerTube player via Render (egress ketiga Laras Web)

Server Node TANPA dependensi yang mem-proxy
`POST /api/innertube/player` ke
`https://www.youtube.com/youtubei/v1/player`, jalan keluar ketiga
bila egress Cloudflare Workers DAN Vercel sama-sama ditolak
YouTube (`LOGIN_REQUIRED`). Render dipilih karena sebagian
egress-nya GCP, keluarga IP yang belum pernah diuji Laras (lihat
`docs/egress-riset-lanjutan.md` Bagian B.1).

Pola sama dengan `workers/proxy` (Cloudflare) dan
`workers/vercel-proxy`: byte-only forward, teruskan body +
header client, kembalikan status + body apa adanya. TIDAK
mengeksekusi base.js, TIDAK memecahkan cipher, TIDAK menyimpan
data pengguna, TIDAK mencatat body request/response (log hanya
status + ukuran + durasi, tanpa videoId).

## Status (19 Nov 2026, ~20:00 WIB)

**LAYANAN BELUM DIBUAT. Terblokir: tidak ada API key Render.**
Tidak ada connector Render, tidak ada `custom.render`, dan
Secure Vault tidak menyimpan login render.com (dicek 19:55 WIB).
Kode di direktori ini SIAP; yang kurang hanya key + push ke
GitHub (koordinator yang push; Render deploy dari repo, jadi
kode harus ada di GitHub dulu sebelum layanan bisa dibuat).

Cara mendapatkan key (parent via browser, bukan agen ini):
dashboard Render -> menu akun kanan atas -> Account settings ->
API Keys -> Create API Key. Workspace ID (dibutuhkan API
sebagai `ownerId`, format `tea_...`) ada di halaman Settings
workspace. Key disimpan lewat Secure Vault sebagai
`custom.render` (Bearer, host `api.render.com`), tidak pernah
di chat polos atau di repo.

## Batas

- Body POST maks 1 MB, JSON youtubei maks 10 MB, timeout
  upstream 30 dtk, rate limit 60/menit per IP (in-memory,
  best-effort, bukan pengganti rate limit D1 di proxy CF).
- Penjaga keras 28 dtk: server WAJIB merespons dalam 28 dtk apa
  pun yang terjadi di upstream (pelajaran Vercel: hanya
  `AbortSignal.timeout` saja tidak cukup, 6/6 POST menggantung).
- CORS: hanya `https://laras.adipmusic.my.id`,
  `https://laras-web.pages.dev`, `https://preview.laras-web.pages.dev`.
- Tier gratis tidur sesudah 15 menit tanpa traffic; bangun
  sekitar 1 menit. Keep-alive ping tiap 10 menit ke `/healthz`
  mencegah tidur (satu layanan always-on memakai ~744 dari 750
  jam/bulan per workspace, jadi hanya muat satu).

## Layanan Render (rencana, belum dibuat)

- Nama: `laras-proxy-render`
- URL yang diharapkan: `https://laras-proxy-render.onrender.com`
- Plan: Free. Region: Oregon. Runtime: Node 24.x.
- Repo: `https://github.com/adiprmx/laras-web`, branch `main`,
  root dir `workers/render-proxy`.
- Build: `true` (no-op, tanpa dependensi). Start: `node server.js`.
- Auto-deploy: tiap push ke `main`. Health check: `/healthz`.

JANGAN SENTUH layanan yang sudah ada di akun ini: `laras-backend`,
`laras-frontend`, `laras-backend-db`, `laras-frontend-c1`,
`adip-cinema-web`, `adip-cinema-terabox-node`. Skrip deploy di
bawah memverifikasi daftar ini sebelum membuat apa pun, dan
tidak pernah memanggil DELETE/PATCH.

## Deploy (via REST API, tanpa CLI)

Skrip: `hidden_files/koordinator/render_deploy.py` (di luar
repo app, memakai key dari environment, tidak pernah mencetak
atau menyimpan nilai key). Intinya:

```
GET /v1/services  (verifikasi daftar no-touch dulu)

POST /v1/services
Authorization: Bearer <RENDER_API_KEY>
{
  "type": "web_service",
  "name": "laras-proxy-render",
  "ownerId": "<RENDER_OWNER_ID, dari Settings workspace>",
  "repo": "https://github.com/adiprmx/laras-web",
  "branch": "main",
  "rootDir": "workers/render-proxy",
  "autoDeployTrigger": "commit",
  "serviceDetails": {
    "runtime": "node",
    "plan": "free",
    "region": "oregon",
    "envSpecificDetails": {
      "buildCommand": "true",
      "startCommand": "node server.js"
    },
    "healthCheckPath": "/healthz"
  }
}

GET /v1/services/{id}/deploys/{deployId}  (poll sampai status live)
GET /healthz + POST ?ping=1               (warm-up sampai 200 stabil)
```

Bentuk payload terverifikasi dari dokumentasi resmi Render
(`api-docs.render.com/reference/create-service`, dibaca
19 Nov 2026) dan tutorial API Render (keithweaver.ca).

## Jebakan yang sudah diketahui (sebelum deploy)

1. **Plan default BUKAN gratis.** API Render memakai compute
   berbayar bila field `plan` dihilangkan. `plan: "free"` WAJIB
   eksplisit di setiap pembuatan layanan.
2. **Kode harus ada di GitHub dulu.** Render deploy dari repo;
   membuat layanan sebelum push koordinator mendarat berarti
   deploy pertama gagal (root dir tidak ditemukan). Skrip deploy
   TIDAK memeriksa ini; fase 2 wajib cek
   `api.github.com/repos/adiprmx/laras-web/contents/workers/render-proxy`
   sebelum POST create.
3. **Tidur 15 menit.** Probe yang memvonis layanan "mati" tanpa
   warm-up dulu adalah vonis palsu. Selalu panggil `/healthz`
   sampai 200 stabil SEBELUM probe egress.
4. **Workspace ID bukan API key.** `ownerId` diambil dari halaman
   Settings workspace di dashboard, format `tea_...`. Tanpa itu
   POST create ditolak.
5. **Satu layanan always-on per workspace.** 750 jam/bulan dibagi
   semua layanan gratis; keep-alive untuk proxy ini memakai
   ~744 jam. Bila layanan gratis lain di workspace yang sama
   juga di-keep-alive, kuota habis sebelum akhir bulan.
6. **Bandwidth 5 GB/bulan.** Cukup untuk jalur `/player` (JSON
   kecil); TIDAK cukup bila media audio ikut di-proxy lewat
   layanan ini. Arsitektur Laras tidak mem-proxy media lewat
   Render.

## Jalur diagnosis

- `GET /healthz` membalas `{"status":"ok"}`, health check
  Render + target keep-alive + warm-up.
- `POST /api/innertube/player?ping=1` membalas
  `{"success":true,"ping":"ok"}` langsung tanpa menyentuh
  YouTube, membedakan "transport macet" dari "upstream macet".
  Dipakai probe deploy, bukan jalur produksi.

## Uji egress (fase 2, sesudah layanan live)

Runner: `hidden_files/koordinator/render_egress_probe.sh`.
Protokol sama seperti Vercel (`docs/vercel-egress.md` §3):
CF diapit sebelum + sesudah, Render 3x per klien (WEB_REMIX,
MWEB, ANDROID_VR) untuk lagu kanari. Vonis BERSIH hanya bila
OK + format audio pada min 2 sel independen SAAT CF ditolak di
jendela yang sama. Bila CF lolos saat probe berjalan (jendela
terbuka), runner menolak memvonis.

## Hasil uji egress

Lihat `docs/render-egress.md` (tabel bukti + vonis; saat ini
draf berstatus BLOCKED_NO_API_KEY).
