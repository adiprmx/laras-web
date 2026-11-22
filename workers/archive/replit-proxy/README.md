# Proxy InnerTube player via Replit (egress P2b Laras Web)

Server Node TANPA dependensi yang mem-proxy
`POST /api/innertube/player` ke
`https://www.youtube.com/youtubei/v1/player`, cermin
`workers/render-proxy/server.js`. Byte-only forward, teruskan body +
header client, kembalikan status + body apa adanya. TIDAK mengeksekusi
base.js, TIDAK memecahkan cipher, TIDAK menyimpan data pengguna, TIDAK
mencatat body request/response (log hanya status + ukuran + durasi,
tanpa videoId).

## Status (19 Nov 2026)

**TERBLOKIR-BUTUH-BROWSER.** Kode di direktori ini SIAP; yang kurang
hanya akun + deploy via browser (Replit tidak punya jalur daftar/deploy
tanpa browser — tidak ada CLI/API deploy publik). Pendaftaran memakai
email `adiprmx@gmail.com` (aturan tugas).

**Catatan batas 30 hari:** paket gratis Replit (Starter) hanya memberi
1 published app dan link-nya **otomatis mati sesudah 30 hari** (bisa
di-publish ulang, URL baru). Jadi Replit TIDAK memenuhi "free tier
forever" sebagai egress permanen — hanya layak sebagai kandidat uji +
egress darurat jangka pendek. Koordinator yang memutuskan.

## Batas paket Starter (gratis, $0)

Sumber: `docs.replit.com/billing/plans/starter-plan` (diperbarui
18 Nov 2026, dibaca 19 Nov 2026) + `replit.com/pricing`:

- 1 published app, link mati otomatis sesudah 30 hari; badge
  "Made with Replit" (tidak bisa dihapus di Starter).
- Kredit harian Agent (jumlah tidak dipublikasikan) + kredit bulanan
  kecil untuk database/storage/publishing; Lite build saja.
- Database produksi 1 GiB.
- Tanpa kartu kredit untuk Starter (tidak ada permintaan kartu di
  dokumen Starter; kartu baru muncul di Core $20/bln ke atas).

## Batas proxy (cermin Render/CF/Vercel)

- Body POST maks 1 MB, JSON youtubei maks 10 MB, timeout upstream
  30 dtk, penjaga keras 28 dtk, rate limit 60/menit per IP
  (in-memory, best-effort).
- CORS: hanya `https://laras.adipmusic.my.id`,
  `https://laras-web.pages.dev`, `https://preview.laras-web.pages.dev`.

## Deploy (browser, parent)

1. Buka `replit.com`, daftar/masuk dengan `adiprmx@gmail.com`.
2. Buat Repl Node.js kosong (atau Import from GitHub
   `adiprmx/laras-web` sesudah koordinator push — bila import repo,
   jalankan dari root dir `workers/replit-proxy`).
3. Salin 3 file dari direktori ini ke Repl: `server.js`,
   `package.json`, `.replit` (bila import GitHub, ketiganya sudah ada).
4. Tekan Run; buka webview Repl, cek `GET /healthz` membalas
   `{"status":"ok"}`.
5. Publish: tombol Deploy/Publish → pilih deployment yang tersedia di
   Starter (1 app gratis). Catat URL publiknya
   (`https://<nama>.<username>.replit.app`).
6. Serahkan URL ke koordinator untuk probe egress.

## Uji egress (sesudah live)

Runner: `hidden_files/koordinator/p2b_egress_probe.sh replit <URL>`.
Protokol sama seperti Render: CF diapit sebelum + sesudah, kandidat
3x per klien (WEB_REMIX, MWEB, ANDROID_VR) untuk lagu kanari. Vonis
BERSIH hanya bila OK + format audio pada min 2 sel independen SAAT CF
ditolak di jendela yang sama. Warm-up `/healthz` sampai 200 stabil
dulu — layanan yang tidur tanpa warm-up menghasilkan vonis palsu.

## Jebakan yang sudah diketahui

1. **Link mati 30 hari.** Jadwalkan publish ulang sebelum habis bila
   Replit dipakai lebih lama; URL berubah tiap publish ulang.
2. **Hanya 1 published app** per akun Starter — jangan publish app lain
   dari akun yang sama selama proxy ini dipakai.
3. **Tidur saat idle.** Selalu warm-up sebelum probe.
4. **Badge "Made with Replit"** menempel di app yang di-publish —
   tidak berpengaruh ke fungsi proxy (bukan UI).
