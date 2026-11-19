# Egress: 1 JUTA CARA (program 19 Nov 2026)

Perintah owner 19 Nov 2026 22:37 WIB: akali blokir resolve YouTube dengan
semua cara, effort maksimal, FREE TIER FOREVER (tanpa kartu kredit, tanpa
bayar, tanpa prepaid, tanpa trial yang butuh kartu untuk lanjut). Trial
hanya boleh untuk probing, bukan fondasi solusi. Garis keras tetap berlaku:
tanpa solver CAPTCHA / bypass anti-bot / bypass paywall-DRM, tanpa Tor,
tanpa proxy residensial berbayar, tanpa API pihak ketiga sebagai jalur
utama (terakhir saja, dengan alasan tercatat).

Protokol vonis standar: kontrol CF sebelum + sesudah ditolak, kandidat
3x/klien (WEB_REMIX, MWEB, ANDROID_VR; lagu kanari hhn-nGSuenM), BERSIH
butuh min 2 sel OK independen saat CF ditolak. Jendela BERKEDIP (OK
sesaat, masing-masing <1 menit: 18:50, 19:00, 19:57, 22:30, 22:50-22:56).

## Matriks master

| # | Cara | Vonis | Bukti | Tanggal |
|---|---|---|---|---|
| 0 | CF Workers (laras-proxy-spike) | DITOLAK | §5 0/5 x2; watcher 12x tanpa flip | 19 Nov |
| 0 | Vercel / AWS | DITOLAK | 7/7 LOGIN_REQUIRED | 19 Nov 16:48 |
| 0 | GitHub Actions runner | DITOLAK | ditolak di jendela buruk | 19 Nov |
| 0 | Render / Oregon | DITOLAK | 0/18 lintas siklus 3+4 | 19 Nov 22:33 |
| 0 | poToken | DITOLAK | spike: token 1/8 vs tanpa 1/11; tidak replikasi | 19 Nov 19:11 |
| 0 | visitorData via proxy | DITOLAK | tidak membantu | 19 Nov |
| P0 | Fly.io | TAK MEYAKINKAN (0 probe) | deploy terhenti: kartu tak terjawab + egress mati; kode siap | 19 Nov 23:18 |
| P1 | Klien IOS / ANDROID / TVHTML5 / TVHTML5_SAMSUNG / WEB_EMBEDDED_PLAYER (+embedUrl) | DITOLAK (6 varian) | 0/54 sel proxy (18 CF + 36 Render) | 19 Nov 23:07 |
| P2a | Supabase Edge Functions | DITOLAK | 0/9 (5 LOGIN_REQUIRED + 4x HTTP 403) | 19 Nov 22:55 |
| P2a | Hugging Face Spaces | TERBLOKIR (butuh token via browser) | token tidak ditemukan; artefak siap | 19 Nov |
| P2b | Koyeb | DITOLAK (kartu wajib) | FAQ resmi: kartu + hold $29 | 19 Nov |
| P2b | Appwrite Cloud | TERBLOKIR (akun ada, kata sandi tak diketahui) | signup 409, login 401 | 19 Nov |
| P2b | Replit | TERBLOKIR (butuh browser; tautan mati 30 hari) | docs resmi | 19 Nov |
| P2b | Glitch | DITOLAK (platform mati) | HTTP 410 live | 19 Nov |
| P2b | Railway | TERBLOKIR (butuh browser + gerbang bayar sementara) | status page 18 Nov | 19 Nov |
| P3 | Cache resolve D1 | DIBANGUN (di-wire koordinator #8) | migrasi 0008 + endpoint + populator | 19 Nov |
| P3 | Fallback IFrame Player | DIBANGUN (di-wire koordinator #8) | docs/iframe-fallback.md + komponen | 19 Nov |
| P4 | Invidious (yt.chocolatemoo53.com) | BERSIH (cadangan terakhir saja) | 6/6 OK_AUDIO, braket CF sah | 19 Nov 22:52 |
| P4 | Piped (8 instance) | DITOLAK (0/8 hidup) | 522/502/403/empty | 19 Nov |

## P0: Fly.io (TAK MEYAKINKAN)

Token org valid (org ADIP RMX, slug `personal`, 1 member ADMIN).
flyctl v0.5.13 terpasang di `~/.fly/bin` (installer resmi gagal chown
sandbox; jalan keluar tarball GitHub + `tar --no-same-owner`). Kode proxy
siap di `workers/fly-proxy/` (server.js cermin Render, fly.toml app
`laras-proxy-fly` region sin, Dockerfile node:24-alpine). `apps create`
gagal transport (`context deadline exceeded` ke api.machines.dev) dan
kartu persetujuan tidak dijawab; egress VM mati total ~22:58-23:04 WIB;
`apps list` susulan timeout + kartu ke-2 tak terjawab. Belum ada bukti
blokir kartu. Status create ambigu: cek `apps list` dulu sebelum create
ulang. Lanjut HANYA saat owner hadir menyetujui kartu (masa hidup
~10 menit). Bukti: `hidden_files/koordinator/fly-egress.md`, `p0-log.md`.

## P1: Klien InnerTube tambahan (DITOLAK, 6 varian)

Parameter terverifikasi dari yt-dlp master `2d596f48` (17 Nov 2026).
75 sel probe, 0 transport error. Via proxy: 0 OK dari 54 sel (semua
HTTP 200 dari proxy). IOS/ANDROID lolos langsung dari VM tapi formatnya
SABR-only (0 URL + 0 cipher) sehingga tidak terpakai tanpa dukungan
SABR/poToken. WEB_EMBEDDED_PLAYER mati total untuk video kanari di semua
host, dengan/tanpa embedUrl. Temuan penting: blokir bukan murni IP (dari
IP VM yang sama dalam 30 detik, WEB_REMIX/IOS/ANDROID lolos sementara
TVHTML5 ditolak). Braket kontrol CF sah; braket Render tercemar kedipan
(WEB_REMIX OK 3x lalu menutup) tapi tidak mengubah kesimpulan karena
0 sel OK kandidat. Tidak ada patch config.ts. Bukti:
`hidden_files/koordinator/p1-clients.md`, `p1-clients-probes.jsonl`
(79 baris), `p1-log.md`.

Tindak lanjut (bukan P1): config memakai ANDROID_VR id 14
(= ANDROID_CREATOR), sementara yt-dlp/YouTube.js/MeeTube sepakat
ANDROID_VR id = 28. Perlu verifikasi + koreksi terpisah (perubahan
perilaku, jangan asal ubah).

## P2a: Supabase Edge Functions (DITOLAK) + HF Spaces (TERBLOKIR)

Supabase: fungsi `laras-proxy` live di proyek `adipmusic`
(`jebafddwupyqpwevhsqn`), ACTIVE v3, `verify_jwt=false`, `/healthz`
200, tanpa auth. Probe 22:53-22:55 WIB: 5x LOGIN_REQUIRED + 4x HTTP 403
halaman "Sorry..." Google (blokir level IP). Kontrol CF saat itu
berkedip terbuka (WEB_REMIX OK 2/2) sehingga vonis justru diperkuat.
Free tier terverifikasi dari dok resmi ($0 tanpa kartu, 500 ribu
invokasi/bulan). Fungsi dibiarkan live ($0). Proyek AyoQris tidak
disentuh. Kode: `workers/supabase-proxy/`.

Hugging Face Spaces: token tidak ditemukan di mana pun (cache, secrets,
konektor, env, memori). Butuh token peran Write via browser (Settings
-> Access Tokens, akun adiprmx@gmail.com). Artefak deploy siap di
`workers/hf-proxy/` (server.js port 7860, Dockerfile, README langkah
token + deploy). Bukti: `hidden_files/koordinator/p2a.md`,
`p2a-log.md`, `p2a-supabase.jsonl`, `p2a-hf.log`.

Temuan samping: `deploy_function.py` konektor legacy tidak mengirim
`?slug=` (deploy pertama membuat fungsi slug UUID, sudah dihapus).
Deploy benar wajib `?slug=` seperti `deploy_all.py`. Gateway Supabase
meneruskan `/<slug>/...` ke fungsi (routing `endsWith`).

## P2b: Koyeb / Appwrite / Replit / Glitch / Railway

- Koyeb DITOLAK (kendala keras): FAQ resmi "We require a credit card
  to prevent fraud and abuse" + hold $29 + tagih pro-rata Pro $29/bln
  saat daftar. 5 sumber sekunder sepakat. Tanpa artefak deploy.
- Appwrite TERBLOKIR: signup API 409 `user_already_exists`, login 401
  `user_invalid_credentials`. Akun adiprmx@gmail.com sudah ada sejak
  ~Sep 2026 (org "Personal projects", proyek `adipmusic-backup`).
  Kata sandi tidak ada di Vault maupun memori; reset tidak dilakukan.
  Artefak siap: `workers/appwrite-proxy/` (handler lokal 6/6 lolos) +
  driver deploy resumable `hidden_files/koordinator/appwrite_attempt.py`
  (fase account/org/project/key/function/deploy/poll/warmup).
  Jalur unblock: browser login cloud.appwrite.io (owner isi kata
  sandi) -> proyek `laras-proxy` (Frankfurt) -> fungsi `laras-proxy`
  (Node 22, timeout 30) -> deploy kode -> catat domain. JANGAN buat
  akun baru. Peringatan: proyek `adipmusic-backup` terjeda sejak
  11 Sep 2026; Appwrite menghapus proyek terjeda sesudah 90 hari
  (~10 Des 2026). Owner mungkin mau memulihkan/menghapusnya.
- Replit TERBLOKIR-BUTUH-BROWSER: Starter $0 tanpa kartu (docs resmi,
  update 18 Nov) tapi daftar + deploy 100% via IDE browser (tanpa
  CLI/API deploy). Batasan: 1 published app, tautan mati 30 hari
  (bukan "forever"). Artefak: `workers/replit-proxy/`.
- Glitch DITOLAK (platform mati): hosting dimatikan 8 Jul 2025; cek
  live 19 Nov `hello-webpage.glitch.me` -> HTTP 410.
- Railway TERBLOKIR-BUTUH-BROWSER (+ gerbang bayar sementara): sejak
  dibuka lagi 2 Nov pasca-insiden 21 Okt, pelanggan baru wajib
  subscribe paket berbayar sebelum deploy; trial deploy sementara
  tidak tersedia (status page, masih tercantum 18 Nov). Artefak:
  `workers/railway-proxy/`. Cek `status.railway.com` dulu sebelum
  mencoba lagi.
- Kontrol CF saat P2b jalan (23:09 WIB): WEB_REMIX + ANDROID_VR
  LOGIN_REQUIRED (jendela buruk aktif). Bukti:
  `hidden_files/koordinator/p2b.md`, `p2b-log.md`,
  `p2b-*-docs.log`, `p2b-appwrite-attempt.jsonl`,
  `p2b_egress_probe.sh` (runner generik, `bash -n` lolos).

## P3: Cache resolve D1 + Fallback IFrame Player (DIBANGUN)

Cache D1: migrasi 0008 (`resolve_cache` + `cache_targets`, benih 5
kanari); endpoint di worker proxy `GET /api/resolve-cache?videoId=`
(publik, 60/menit/IP, hanya entri belum kedaluwarsa) + `POST` (wajib
`X-Cache-Key` == secret `RESOLVE_CACHE_KEY`, 10/menit/IP; URL harus
https `*.googlevideo.com`, expiry maks 24 jam; sapu basi tiap tulis);
logika app `resolveCache.ts` (margin aman 60 dtk; URL basi tidak
pernah diputar; cache dicoba sesudah semua putaran resolve gagal);
populator `hidden_files/koordinator/cache-populator.py` (probe jendela
-> resolve target via ANDROID_VR dulu lalu WEB_REMIX format URL
langsung -> simpan; `--dry-run` didukung; tidak me-resolve cipher).
Cron populator tiap 5 menit (~11 request saat terbuka, 1 probe saat
tertutup). Jalur populator saat jendela terbuka BELUM terbukti live
(egress VM ke CF mati saat smoke test); fail-fast + `window_closed`
+ exit 0 terbukti.

Fallback IFrame: desain `docs/iframe-fallback.md` (urutan resolve ->
cache -> tangga retry -> fallback iframe; batasan jujur: tanpa putar
latar/layar kunci, tanpa unduh, tanpa EQ, tanpa antrean mulus;
kepatuhan YouTube terverifikasi dari dokumen resmi: viewport min
200x200, pemutar selalu terlihat, tanpa overlay, kontrol bawaan
tampil). Implementasi `iframeFallback.ts` +
`IframeFallbackPlayer.tsx` + wiring service (masuk saat tangga habis,
keluar otomatis saat resolve pulih / lagu lokal / tombol "Coba cara
biasa lagi"). Tes: Vitest 911/911, tsc 0, ESLint 0 (verifikasi
koordinator #8 menyusul sebelum push).

Status wiring: migrasi 0008 diterapkan koordinator #8 (8/8 OK);
secret `RESOLVE_CACHE_KEY` dibuat (secrets/, 0600) + disetel ke
worker; deploy worker + verifikasi endpoint + push + CI + deploy
Pages + cron populator dikerjakan koordinator #8 sesudah dokumen ini.

## P4: Invidious BERSIH (cadangan terakhir saja) + Piped mati

Invidious `yt.chocolatemoo53.com`: 6/6 OK_AUDIO, HTTP 200, 5 format
audio (itag 139/140/249/250/251), latensi 6-16 dtk; URL audio
terverifikasi mengalir (Range -> HTTP 206, 4096 byte, `audio/mp4`).
Siklus 1 tanpa-vonis (kontrol-sesudah WEB_REMIX OK = kedipan);
siklus 2 braket BERSIH (kontrol sebelum + sesudah keduanya
LOGIN_REQUIRED di kedua klien, Invidious 3/3 OK di tengahnya).
Satu-satunya `api:true` sehat dari 10 entri daftar resmi.
Rekomendasi tim: JANGAN PAKAI sebagai cadangan utama (satu instance
tak dikenal, ekosistem tipis, lambat, respons kemungkinan dari cache
(6 respons identik 64676 byte, `expire` sama); paling jauh cadangan
terakhir dengan re-probe berkala. Keputusan di parent. Vonis hanya
berlaku 19 Nov 2026 22:51-22:52 WIB; instance publik berganti status
cepat dan wajib diprobe ulang sebelum keputusan apa pun.

Piped: 0 dari 8 hidup (522/502/403/empty reply). Kegagalan bukan
sekadar egress sandbox (4 instance mengembalikan kode HTTP nyata
sementara Invidious, proxy CF, dan GitHub merespons normal dari
sandbox yang sama). Bukti: `hidden_files/koordinator/p4-invidious-piped.md`,
`p4-probes.jsonl`, `p4-control.jsonl`, `p4-health.jsonl`.

## Yang belum dicoba / berikutnya

1. Fly.io retry saat owner hadir (kartu persetujuan) — kode siap,
   cek `apps list` dulu (create ambigu).
2. HF Spaces sesudah token Write dibuat via browser.
3. Appwrite sesudah login via browser (proyek `laras-proxy`).
4. Railway sesudah trial deploy dibuka lagi (cek status page).
5. Invidious sebagai cadangan terakhir — HANYA bila parent putuskan,
   dengan re-probe berkala + failover terpisah (bukan jalur utama).
6. Koreksi ANDROID_VR clientId 14 -> 28 (verifikasi dulu).
7. Perbaiki `deploy_function.py` konektor legacy (tambah `?slug=`).
