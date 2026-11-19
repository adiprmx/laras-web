# Proxy InnerTube player via Appwrite Cloud Functions (egress P2b Laras Web)

Fungsi serverless Node.js 22 yang mem-proxy
`POST /api/innertube/player` ke
`https://www.youtube.com/youtubei/v1/player`, cermin
`workers/render-proxy/server.js` dalam format Appwrite Functions
(`functions/laras-proxy/src/main.js`, ESM + `package.json`
`"type": "module"` sesuai template resmi Appwrite). Byte-only forward,
teruskan body + header client, kembalikan status + body apa adanya.
TIDAK mengeksekusi base.js, TIDAK memecahkan cipher, TIDAK menyimpan
data pengguna, TIDAK mencatat body request/response (log hanya status +
ukuran + durasi, tanpa videoId).

## Status

**TERBLOKIR — AKUN SUDAH ADA (19 Nov 2026 23:20 WIB).** Percobaan deploy
via API gagal BUKAN karena kartu/browser: akun `adiprmx@gmail.com` SUDAH
ADA di Appwrite Cloud sejak ±Sep 2026 (org "Personal projects", proyek
"adipmusic-backup" — terverifikasi via Gmail). Bukti API:
`POST /v1/account` → 409 `user_already_exists`;
`POST /v1/account/sessions/email` → 401 `user_invalid_credentials`.
Kata sandi akun itu tidak diketahui agen ini (tidak ada di Secure Vault
maupun memori); reset password TIDAK dilakukan (tidak diizinkan tugas).

Unblock: tugas browser login ke `cloud.appwrite.io` (owner isi kata
sandi via kartu aman) → buat proyek `laras-proxy` di org "Personal
projects" (jatah proyek ke-2 Free masih kosong) → buat fungsi → deploy
kode `functions/laras-proxy/` (lihat "Deploy via browser" di bawah).
Alternatif: browser task cukup membuat project API key + mencatat
project ID, lalu agen lanjutan menjalankan fase API driver
(`function` → `deploy` → `poll` → `warmup`).

Driver fase: `hidden_files/koordinator/appwrite_attempt.py`
(`--phase account|org|project|key|function|deploy|poll|warmup`,
idempotent, state di `p2b-appwrite-state.json`). Vonis lengkap +
bukti: `hidden_files/koordinator/p2b.md`.

## Batas paket Free (gratis, $0, tanpa kartu)

Sumber: `appwrite.io/pricing` + `appwrite.io/docs/advanced/billing/free`
(dibaca via ringkasan terverifikasi 2–19 Nov 2026; halaman pricing
Appwrite me-render kartu plan di browser sehingga angka dikutip dari
pengumuman resmi Start plan 21 Sep 2026 + halaman billing):

- $0, tanpa kartu kredit ("Create a free account at cloud.appwrite.io
  without entering payment details" — terverifikasi 19 Nov 2026).
- 2 proyek per organisasi (resource dipakai bersama), 5 GB bandwidth,
  2 GB storage, 750 ribu eksekusi fungsi/bln, 75 ribu MAU.
- Per proyek: 1 database, 1 bucket, 2 fungsi; build maks 15 menit.
- **Proyek Free dijeda sesudah 1 minggu tanpa aktivitas** di Console
  (bisa dipulihkan; dihapus sesudah 90 hari terjeda). Traffic pengguna
  saja belum tentu dihitung aktivitas — pantau status proyek.
- Bila melewati batas, proyek Free membeku + Console read-only sampai
  upgrade atau siklus reset (tidak ada tagihan kejutan — tidak ada
  kartu yang bisa ditagih).

## Batas fungsi (Appwrite Cloud)

Sumber: `appwrite.io/products/functions` +
`appwrite.io/docs/products/functions/execute` (dibaca 19 Nov 2026):

- Runtime Node.js 22 (juga 23/24/25), 0,5 vCPU / 512 MB.
- Setiap fungsi dapat domain hasil generate
  (`https://<functionId>.fra.appwrite.run`) + custom domain opsional.
- Eksekusi sinkron via domain: batas keras 60 dtk (via endpoint
  Create execution: 30 dtk). Timeout fungsi diset 30 dtk; penjaga
  keras Laras 28 dtk tetap berlaku di dalam kode.
- Akses eksekusi WAJIB `any` agar domain bisa dipanggil publik
  (diset saat create function).

## Batas proxy (cermin Render/CF/Vercel)

- Body POST maks 1 MB, JSON youtubei maks 10 MB, timeout upstream
  30 dtk, penjaga keras 28 dtk, rate limit 60/menit per IP
  (in-memory per instance, best-effort — fungsi bisa pindah instance
  tiap eksekusi, jadi ini bukan pengganti rate limit D1 di proxy CF).
- CORS: hanya `https://laras.adipmusic.my.id`,
  `https://laras-web.pages.dev`, `https://preview.laras-web.pages.dev`.

## Deploy via API (jalur agen, tanpa browser)

```
python3 hidden_files/koordinator/appwrite_attempt.py --phase <fase>
```

Fase: `account` → `org` → `project` → `key` → `function` → `deploy`
→ `poll` (ulangi sampai ready) → `warmup` (ulangi sampai 200).
Idempotent: fase melewati langkah yang sudah ada di state
(`p2b-appwrite-state.json`) atau secret tersimpan.

Prasyarat: `secrets/appwrite-password` (0600, kata sandi akun
`adiprmx@gmail.com`) — SAAT INI TIDAK ADA karena kata sandi akun
yang sudah ada tidak diketahui (lihat Status). Bila owner memberikan
akses, fase `account` memakai kata sandi itu untuk login; ATAU bila
browser task sudah membuat project API key, simpan key ke
`secrets/appwrite-api-key` (0600) + isi `project_id` di state, lalu
jalankan langsung fase `function` → `deploy` → `poll` → `warmup`.

Driver memakai endpoint resmi: `POST /v1/account` +
`/v1/account/sessions/email` (project `console`),
`POST /v1/organizations` (`billingPlan: free`),
`POST /v1/organization/projects` (region `fra`),
`POST /v1/organization/projects/{id}/keys`,
`POST /v1/functions` + `POST /v1/functions/{id}/deployments`
(endpoint region `fra.cloud.appwrite.io`). Bentuk endpoint
terverifikasi dari `appwrite-console` SDK 0.17.0 (PyPI) + referensi API
Appwrite. Log: `hidden_files/koordinator/p2b-appwrite-attempt.jsonl`.

Catatan: `appwrite login` ke Cloud MEMBUKA BROWSER (kode sekali pakai)
— itulah sebabnya jalur ini memakai REST API langsung, bukan CLI.
Login email/password di CLI hanya untuk instance self-hosted.

## Deploy via browser (jalur unblock, parent)

**JANGAN buat akun baru** — akun `adiprmx@gmail.com` sudah ada
(org "Personal projects").

1. Buka `cloud.appwrite.io`, masuk dengan `adiprmx@gmail.com`
   (owner mengisi kata sandi via kartu aman).
2. Buka organisasi "Personal projects" (jatah proyek ke-2 Free masih
   kosong; proyek lama `adipmusic-backup` terjeda sejak 11 Sep 2026).
3. Buat proyek `laras-proxy` (region Frankfurt).
4. Functions → Create function: nama `laras-proxy`, runtime Node.js
   22, Execute access `Any`, timeout 30, entrypoint `src/main.js`.
5. Deploy kode: unggah `functions/laras-proxy/` (atau via CLI:
   `npm i -g appwrite-cli`, `appwrite login`, `appwrite init function`,
   `appwrite push function`).
6. Catat domain fungsi, serahkan ke koordinator untuk probe egress.

## Uji egress (sesudah live)

Runner: `hidden_files/koordinator/p2b_egress_probe.sh appwrite <URL>`.
Protokol sama seperti Render: CF diapit sebelum + sesudah, kandidat
3x per klien (WEB_REMIX, MWEB, ANDROID_VR) untuk lagu kanari. Vonis
BERSIH hanya bila OK + format audio pada min 2 sel independen SAAT CF
ditolak di jendela yang sama. Warm-up `/healthz` sampai 200 stabil
dulu (cold start fungsi 200–800 ms; tanpa warm-up, vonis palsu).

## Jebakan yang sudah diketahui

1. **Proyek dijeda sesudah 1 minggu idle** — untuk pemakaian panjang,
   butuh aktivitas Console berkala atau terima jeda + pulihkan manual.
2. **Domain fungsi = ID fungsi** (`<functionId>.fra.appwrite.run`) —
   jangan ganti nama/ID fungsi sesudah probe (URL berubah).
3. **Timeout sinkron 60 dtk via domain** — penjaga 28 dtk di kode
   memastikan respons selalu lebih cepat dari batas platform.
4. **Rate limit pembuatan akun 10/jam per IP** — jangan ulangi
   create-account berkali-kali bila gagal; baca pesan error dulu.
