# Egress Ketiga: Proxy InnerTube via Render, Draf (19 Nov 2026)

**Status: BLOCKED_NO_API_KEY.** Tidak ada API key Render di mana
pun (dicek 19:55 WIB): tidak ada connector Render, tidak ada
`custom.render`, Secure Vault tidak menyimpan login render.com.
Kode proxy SIAP dan TERUJI LOKAL, skrip deploy + probe SIAP,
kerangka failover SIAP (tes 13/13). Yang kurang hanya key +
push kode ke GitHub. **Belum ada vonis egress:** layanan Render
belum dibuat, belum ada satu pun probe dari IP Render. Dokumen
ini draf fase 1; tabel bukti diisi fase 2 sesudah key ada.

Semua jam WIB, 19 Nov 2026. Aturan penulisan dokumen ini: tanpa
em dash.

## 1. Akun Render (per brief tugas + MEMORY.md, parent 19:51 WIB)

Fakta akun di bawah ini berasal dari brief tugas dan catatan
parent, BELUM terverifikasi via API Render (tidak bisa: key
belum ada). Verifikasi via `GET /v1/services` adalah langkah
pertama skrip deploy fase 2.

| Item | Nilai |
|---|---|
| Akun | GitHub adiprmx, email adiprmx@gmail.com |
| Tier | Hobby (GRATIS), tanpa kartu |
| Git Deployment Credentials | GitHub adiprmx terhubung, termasuk repo laras-web |
| API key | TIDAK ADA (lihat §1.1) |
| Workspace ID (`ownerId`) | BELUM DIKETAHUI (dari Settings workspace, format `tea_...`) |

Layanan YANG SUDAH ADA, JANGAN SENTUH SAMA SEKALI:

| Grup | Layanan |
|---|---|
| My project | laras-backend, laras-frontend, laras-backend-db, laras-frontend-c1 |
| Ungrouped | adip-cinema-web, adip-cinema-terabox-node |

### 1.1 Bukti tidak ada API key (19:55 WIB)

| Cek | Hasil |
|---|---|
| `connector_search` ("render", "Render API key", "render.com deploy") | Tidak ada connector Render (hasil hanya Vercel, Lovable, Supabase, dll. yang tidak relevan) |
| `~/workspace/custom-connectors/` (daftar isi) | 10 konektor, tidak ada `custom.render` |
| Secure Vault `credentials.list` (filter render.com) | Kosong |
| Secure Vault `credentials.list` (tanpa filter) | 17 login username/password, tidak satu pun render.com dan tidak satu pun API key |

Catatan pagar: secret `render-deploy-hook` di
`~/workspace/home-server-cinema/secrets/` TIDAK dipakai dan
tidak dibaca (milik layanan lain; deploy hook tidak bisa
membuat layanan baru).

## 2. Kode proxy siap (teruji lokal, 19:58 WIB)

Sumber: `workers/render-proxy/` (server.js + package.json +
render.yaml + README.md). Server Node TANPA dependensi (modul
`http` bawaan; buildCommand no-op `true`, tanpa `npm install`).

Pola byte-only cermin proxy CF/Vercel: teruskan body + header
`X-YouTube-Client-Name/Version`, kembalikan status + body apa
adanya. Batas: body 1 MB, respons 10 MB, timeout upstream 30
dtk, rate limit 60/menit per IP (in-memory, best-effort), CORS
hanya tiga origin Laras (salinan persis dari kode Vercel).
Penjaga keras `setTimeout` 28 dtk (pelajaran Vercel: hanya
`AbortSignal.timeout` tidak cukup, 6/6 POST menggantung).
Hanya POST (metode lain 405 + envelope JSON). TIDAK log body/URL
stream. Tambahan dibanding Vercel: `GET /healthz` (health check
Render + target keep-alive).

Rencana layanan (belum dibuat): nama `laras-proxy-render`,
URL yang diharapkan
`https://laras-proxy-render.onrender.com`, plan Free, region
Oregon, repo `adiprmx/laras-web` branch `main`, root dir
`workers/render-proxy`, start `node server.js`, auto-deploy
tiap push ke `main`, health check `/healthz`.

### 2.1 Bukti tes lokal (server dijalankan di VM, PORT 18099)

| Waktu | Tes | Hasil |
|---|---|---|
| 19:57 WIB | `GET /healthz` | 200 `{"status":"ok"}` |
| 19:57 WIB | OPTIONS preflight, origin `https://laras.adipmusic.my.id` | 204 + ACAO benar |
| 19:57 WIB | OPTIONS, origin `https://jahat.example.com` | 204 TANPA header ACAO (benar) |
| 19:57 WIB | `GET /api/innertube/player` | 405 envelope `METHOD_NOT_ALLOWED` |
| 19:57 WIB | `POST .../player?ping=1` | 200 `{"success":true,"ping":"ok"}` |
| 19:57 WIB | `GET /nope` | 404 envelope `NOT_FOUND` |
| 19:58 WIB | POST nyata ke YouTube via proxy lokal (WEB_REMIX, `hhn-nGSuenM`) | HTTP 200, 22,9 dtk, playability OK, 4 format audio, visitorData ada |
| 19:58 WIB | POST body 1,1 MB | 413 envelope `BODY_TOO_BIG` |
| 19:58 WIB | Isi log server | Hanya status + byte + durasi, tanpa videoId/body |

**Baca hasil ini dengan benar:** tes POST nyata membuktikan
LOGIKA proxy (forward byte + header + cap + guard) bekerja
ujung ke ujung. Tes itu keluar dari IP VM ini, BUKAN dari IP
Render, jadi BUKAN bukti egress Render bersih. Vonis egress
hanya dari probe fase 2 lewat layanan Render live.

### 2.2 Pemeriksaan statis (19:59 WIB)

| Cek | Hasil |
|---|---|
| `node --check` server.js (CommonJS, tepercaya) | Lolos |
| Sintaks Python `render_deploy.py` (ast.parse) | Lolos |
| `bash -n` `render_egress_probe.sh` | Lolos |
| YAML `render.yaml` (pyyaml safe_load) | Lolos |
| JSON `package.json` | Lolos |
| Vitest `proxyFailover.test.ts` | 13/13 lolos (19:59:38 WIB) |
| `tsc --noEmit` (seluruh app) | Bersih, exit 0 |
| `eslint` dua file failover baru | Bersih, exit 0 |

## 3. Tabel bukti uji egress

BELUM ADA. Layanan Render belum dibuat (terblokir key), jadi
belum ada satu pun probe dari egress Render. Tabel ini diisi
fase 2 dengan protokol berikut (sama seperti Vercel,
`docs/vercel-egress.md` §3):

1. Warm-up `/healthz` sampai 200 stabil (layanan gratis tidur
   sesudah 15 menit idle; vonis tanpa warm-up adalah vonis
   palsu).
2. CF SEBELUM: WEB_REMIX + ANDROID_VR, lagu `hhn-nGSuenM`.
   Bila CF LOLOS, runner BERHENTI tanpa vonis (jendela terbuka;
   Render OK di jendela terbuka tidak membuktikan apa-apa).
3. Render 3x per klien (WEB_REMIX, MWEB, ANDROID_VR) untuk lagu
   kanari. Default satu lagu (`hhn-nGSuenM`, cermin Vercel);
   `ALL_CANARY=1` menjalankan kelima lagu kanari.
4. CF SESUDAH: WEB_REMIX + ANDROID_VR (jendela buruk harus
   bertahan sepanjang uji).

Klien: WEB_REMIX (clientId 67, v1.20261110.04.00), MWEB
(clientId 2, v2.20260708.05.00), ANDROID_VR (clientId 14,
v1.65.10, androidSdkVersion 34). Lagu kanari: `hhn-nGSuenM`,
`qkC4waEZVt4`, `k2XdBPv0D3Y`, `NL8WUtq_NDY`, `YsGwU8vTRsE`.
Proxy CF:
`https://laras-proxy-spike.hiroohengkerr.workers.dev/api/innertube/player`.

Kriteria vonis (dari mandat): BERSIH = OK + format audio pada
min 2 sel independen (pasangan lagu x klien berbeda) SAAT CF
ditolak di jendela yang sama. DITOLAK = semua LOGIN_REQUIRED
seperti Vercel.

## 4. Vonis: BELUM ADA VONIS

Bukan BERSIH, bukan DITOLAK. Terblokir di key. Failover
`proxyFailover.ts` ditulis sebagai KERANGKA DRAFT (saklar
`RENDER_FAILOVER_ENABLED = false`, tidak diimpor modul mana
pun) dan TIDAK di-wire ke `resolve.ts`. Wiring hanya sesudah
vonis BERSIH, oleh koordinator.

## 5. Yang dibutuhkan untuk fase 2

### 5.1 Mendapatkan API key (parent via browser)

1. Buka dashboard Render (render.com), login sebagai adiprmx
   (GitHub adiprmx / adiprmx@gmail.com).
2. Menu akun kanan atas, lalu Account settings, gulir ke API
   Keys, lalu Create API Key. Beri nama yang jelas (mis.
   `laras-egress`). Salin key saat Render menampilkannya (key
   hanya tampil sekali).
3. Di halaman Settings workspace, salin Workspace ID (format
   `tea_...`). Ini `ownerId` untuk API, TERPISAH dari key.
4. Key diserahkan ke agen lewat Secure Vault sebagai
   `custom.render` (Bearer, host `api.render.com`). JANGAN
   kirim key di chat polos, JANGAN simpan di repo.
5. Jangan buat akun baru, jangan pakai kartu, jangan ubah
   layanan yang sudah ada.

### 5.2 Urutan fase 2 (koordinator)

1. Push kode `workers/render-proxy/` + `docs/render-egress.md`
   + kerangka failover ke GitHub (koordinator yang push;
   Render deploy dari repo, jadi kode harus ada di GitHub
   dulu). Verifikasi:
   `api.github.com/repos/adiprmx/laras-web/contents/workers/render-proxy`
   memuat `server.js`, `render.yaml`, `package.json`.
2. Jalankan `hidden_files/koordinator/render_deploy.py` dengan
   `RENDER_API_KEY` + `RENDER_OWNER_ID` dari environment.
   Skrip memverifikasi daftar no-touch, menolak duplikat,
   membuat layanan (plan free eksplisit), poll deploy sampai
   live, lalu warm-up. Skrip TIDAK PERNAH memanggil
   DELETE/PATCH.
3. Jalankan `hidden_files/koordinator/render_egress_probe.sh`
   (baca URL dari state deploy). Runner menolak memvonis bila
   jendela terbuka.
4. Isi §3 dokumen ini dengan tabel bukti + stempel waktu, lalu
   tetapkan vonis di §4.
5. Bila BERSIH: koordinator wiring failover (ubah saklar +
   panggil `postInnertubeWithFailover` dari `postViaProxy`),
   lalu siapkan keep-alive ping tiap 10 menit ke `/healthz`
   (dari Worker CF atau cron eksternal). Bila DITOLAK:
   lanjut ke §7 (Fly.io).

## 6. Jebakan yang sudah diketahui (sebelum deploy)

1. **Plan default BUKAN gratis.** API Render memakai compute
   berbayar bila field `plan` dihilangkan. `plan: "free"`
   WAJIB eksplisit di setiap pembuatan layanan.
2. **Kode harus ada di GitHub dulu.** Membuat layanan sebelum
   push koordinator mendarat berarti deploy pertama gagal
   (root dir tidak ditemukan). Skrip deploy memeriksa ini
   dulu dan berhenti bila kode belum ada.
3. **Tidur 15 menit.** Probe yang memvonis layanan "mati"
   tanpa warm-up dulu adalah vonis palsu. Selalu panggil
   `/healthz` sampai 200 stabil SEBELUM probe egress.
4. **Workspace ID bukan API key.** `ownerId` diambil dari
   halaman Settings workspace di dashboard. Tanpa itu POST
   create ditolak.
5. **Satu layanan always-on per workspace.** 750 jam/bulan
   dibagi semua layanan gratis; keep-alive untuk proxy ini
   memakai sekitar 744 jam. Bila layanan gratis lain di
   workspace yang sama juga di-keep-alive, kuota habis
   sebelum akhir bulan.
6. **Bandwidth 5 GB/bulan.** Cukup untuk jalur `/player`
   (JSON kecil); TIDAK cukup bila media audio ikut di-proxy
   lewat layanan ini. Arsitektur Laras tidak mem-proxy media
   lewat Render.
7. **Bentuk payload create terverifikasi** dari dokumentasi
   resmi Render (`api-docs.render.com/reference/create-service`,
   dibaca 19 Nov 2026) dan tutorial API Render
   (keithweaver.ca): `serviceDetails` memuat `runtime`,
   `plan`, `region`, `envSpecificDetails` (buildCommand +
   startCommand), dan `healthCheckPath`; `rootDir` dan
   `autoDeployTrigger` adalah field tingkat atas.
8. **`render.yaml` di repo TIDAK memuat repo/branch sebagai
   field** (Blueprint terikat ke repo tempat file itu berada);
   repo/branch hanya ada di payload API dan di komentar file.

## 7. Evaluasi Fly.io sebagai langkah berikut (RISET SAJA)

Ringkasan dari `docs/egress-riset-lanjutan.md` §B.2 (riset
19 Nov 2026, ~18:45-19:00 WIB). Tidak ada akun dibuat, tidak
ada pendaftaran apa pun.

**Kenapa Fly.io:** independensi IP terbaik dari semua kandidat
(server bare metal sendiri dari CacheNetworks, DataPacket,
Latitude.sh, NetActuate, Vultr; AWS/GCP hanya control plane).
Dari sudut penanda IP YouTube, ini keluarga paling berbeda
dari semua yang sudah ditolak (CF, Vercel/AWS, GitHub Actions).

**Kenapa bukan jalur utama:** TIDAK ADA tier gratis untuk
organisasi baru (sejak 7 Okt 2024). Trial akun baru: $1
kredit, 7 hari, TANPA kartu, cukup untuk protokol probe
lengkap (belasan request). Sesudah trial, kartu kredit wajib
sebelum Machines jalan lagi (atau prepaid minimum $25).
Mesin terkecil always-on $2,19/30 hari; halaman pricing
menyatakan tagihan di bawah $5 ditiadakan (belum dibuktikan
dengan tagihan nyata); tidak ada spending cap bawaan.

**Keputusan:** coba Fly.io HANYA bila Render DITOLAK (atau
terblokir terlalu lama dan koordinator memutuskan paralel).
Trial tanpa kartu untuk probe; kartu HANYA bila owner setuju
SESUDAH probe BERSIH. Jangan daftarkan kartu tanpa
persetujuan owner.

## 8. Langkah koordinator yang masih diperlukan

1. Ambil API key + Workspace ID (lihat §5.1), simpan sebagai
   `custom.render` di Secure Vault.
2. Push artefak paket ini ke GitHub, lalu luncurkan fase 2
   (deploy + probe) sesuai §5.2.
3. Bila vonis BERSIH: wiring failover + keep-alive (§5.2
   langkah 5). Bila DITOLAK: putuskan soal trial Fly.io (§7)
   dengan owner.
4. Perbarui `docs/spikes/egress-dan-opsi-resolve.md` §3.3 bila
   koordinator mau: Render kini berstatus TERBLOKIR KEY
   (bukan "BELUM DIUJI" tanpa kualifikasi).

## 9. Artefak

- Proxy + README: `workers/render-proxy/` (server.js,
  package.json, render.yaml, README.md).
- Skrip fase 2 (di luar bundle app):
  `hidden_files/koordinator/render_deploy.py` (buat layanan +
  warm-up) dan `hidden_files/koordinator/render_egress_probe.sh`
  (protokol uji + vonis otomatis). Keduanya memakai
  `hidden_files/koordinator/egress_probe.py` + template body
  `hidden_files/koordinator/probe-bodies/` yang sudah ada
  (mendukung ketiga klien: WEB_REMIX, MWEB, ANDROID_VR).
- Kerangka failover (DRAFT, tidak di-wire):
  `app/src/resilience/proxyFailover.ts` +
  `app/src/resilience/proxyFailover.test.ts` (13/13 lolos).
- Laporan ini: `docs/render-egress.md`.
