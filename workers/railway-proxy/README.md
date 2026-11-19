# Proxy InnerTube player via Railway (egress P2b Laras Web)

Server Node TANPA dependensi yang mem-proxy
`POST /api/innertube/player` ke
`https://www.youtube.com/youtubei/v1/player`, cermin
`workers/render-proxy/server.js`. Byte-only forward, teruskan body +
header client, kembalikan status + body apa adanya. TIDAK mengeksekusi
base.js, TIDAK memecahkan cipher, TIDAK menyimpan data pengguna, TIDAK
mencatat body request/response (log hanya status + ukuran + durasi,
tanpa videoId). Deploy via `Dockerfile` di direktori ini (Railway
mendeteksi Dockerfile otomatis).

## Status (19 Nov 2026)

**TERBLOKIR-BUTUH-BROWSER + GERBANG BAYAR SEMENTARA.** Kode di direktori
ini SIAP, tetapi dua hal menghalangi:

1. Pendaftaran + deploy Railway butuh browser (daftar via web, CLI
   `railway login` memakai OAuth browser; tidak ada API signup).
   Email akun: `adiprmx@gmail.com` (aturan tugas).
2. **Gerbang bayar sementara (yang menentukan):** sesudah insiden
   keamanan 21 Okt 2026, Railway membuka ulang pendaftaran 2 Nov 2026
   dengan syarat: *"new customers will be required to subscribe to a
   paid plan (Hobby or Pro) before deploying. Free trial deployments
   remain temporarily unavailable."* (status.railway.com, insiden
   ditandai resolved 2 Nov 19:19 UTC; masih tercantum di ToolVerdict
   yang terverifikasi 18 Nov 2026). Hobby ($5/bln) dan Pro ($20/bln)
   butuh kartu kredit → **HARD STOP** menurut kendala tugas sampai
   Railway membuka lagi deploy trial gratis. **JANGAN subscribe Hobby
   untuk membuka deploy** — itu melanggar aturan tanpa-kartu.
   Cek `status.railway.com` sebelum mencoba lagi.

## Batas paket gratis (bila gerbang dibuka lagi)

Sumber: `railway.com/pricing` + `docs.railway.com` (dibaca via
ringkasan terverifikasi 9–12 Nov 2026):

- Free Trial: kredit $5 sekali pakai, 30 hari, tanpa kartu; maks
  2 vCPU / 1 GB per service, 2 replika.
- Sesudah trial: Free $0/bln dengan kredit $1/bln (tidak rollover),
  maks 1 vCPU / 0,5 GB per service, 1 proyek, 3 service, tanpa
  custom domain.
- Tarif meteran: ~$20/vCPU-bln, ~$10/GB-bln, egress $0,05/GB.
  Service kecil always-on (~0,1 vCPU + 0,5 GB) melewati kredit $1/bln
  Free — Free permanen TIDAK cukup untuk always-on; hanya trial $5
  yang muat untuk uji probe. Trial BUKAN "forever".

## Batas proxy (cermin Render/CF/Vercel)

- Body POST maks 1 MB, JSON youtubei maks 10 MB, timeout upstream
  30 dtk, penjaga keras 28 dtk, rate limit 60/menit per IP
  (in-memory, best-effort).
- CORS: hanya `https://laras.adipmusic.my.id`,
  `https://laras-web.pages.dev`, `https://preview.laras-web.pages.dev`.
- Railway tidak menidurkan service (berhenti hanya bila kredit habis),
  jadi keep-alive tidak sepenting di Render — health check tetap ada
  untuk warm-up + monitoring.

## Deploy (browser, parent — HANYA bila trial deploy sudah dibuka lagi)

1. Cek `status.railway.com`: pastikan tidak ada lagi catatan "free
   trial deployments remain temporarily unavailable". Bila masih ada,
   BERHENTI — jangan lanjut ke langkah 2.
2. Buka `railway.com`, daftar/masuk dengan `adiprmx@gmail.com`.
3. New Project → Deploy from GitHub repo `adiprmx/laras-web`
   (sesudah koordinator push), root directory `workers/railway-proxy`.
   Railway mendeteksi `Dockerfile` dan build dari situ. (Alternatif:
   service kosong + drag-drop file.)
4. Di service: Settings → Networking → Generate Domain. Catat URL
   publiknya (`https://<nama>.up.railway.app`).
5. Cek `GET /healthz` membalas `{"status":"ok"}`.
6. Serahkan URL ke koordinator untuk probe egress.

## Uji egress (sesudah live)

Runner: `hidden_files/koordinator/p2b_egress_probe.sh railway <URL>`.
Protokol sama seperti Render: CF diapit sebelum + sesudah, kandidat
3x per klien (WEB_REMIX, MWEB, ANDROID_VR) untuk lagu kanari. Vonis
BERSIH hanya bila OK + format audio pada min 2 sel independen SAAT CF
ditolak di jendela yang sama.

## Jebakan yang sudah diketahui

1. **Gerbang bayar sementara** (di atas) — cek status dulu, selalu.
2. **Kredit trial hangus 30 hari** — deploy + probe segera sesudah
   akun dibuat; jangan buat akun jauh sebelum siap probe.
3. **Volume trial dihapus** 30 hari sesudah kredit habis (tidak relevan
   untuk proxy stateless ini, tapi jangan simpan data di Railway).
4. **Insiden 21 Okt 2026:** pihak tak berwenang mengakses env var
   terenkripsi (sebagian terdekripsi). Jangan pernah simpan secret
   penting di Railway; proxy ini tidak memakai secret apa pun
   (kunci InnerTube adalah kunci publik).
