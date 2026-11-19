# Hasil spike: poToken untuk Laras

Tanggal: 19 Nov 2026, 18:46-19:11 WIB. Status: SPIKE SELESAI, vonis di bawah.
Konteks: docs/potoken-brief.md. Kode produksi tidak diubah.

## Vonis: TIDAK MEMBANTU

poToken tidak membuat request player dari egress Cloudflare Workers lolos
secara andal saat tanpa token ditolak LOGIN_REQUIRED.

- Dengan token: 1 OK dari 8 probe valid (12,5 persen).
- Tanpa token: 1 OK dari 11 probe valid (9,1 persen).
- Satu-satunya OK dengan token (WEB_REMIX, qkC4waEZVt4, 19:00:50 WIB) tidak
  terulang dengan token yang sama 2 menit 29 detik kemudian (19:03:19 WIB,
  LOGIN_REQUIRED). OK tanpa token juga terjadi (MWEB, 18:50:00 WIB).
- Syarat MEMBANTU (minimal 2 sel independen dengan pola DENGAN token OK
  sementara TANPA token LOGIN_REQUIRED di jendela yang sama) tidak terpenuhi:
  hanya 1 sel yang memenuhi pola itu, dan replikasinya gagal.
- Varian token terikat sesi (hipotesis khusus WEB_REMIX dari README provider)
  juga gagal 0 dari 2.

Rekomendasi: jangan integrasikan poToken ke produksi berdasarkan bukti ini.
Lanjutkan jalur retry + failover egress. Hasil ini cocok dengan peringatan
provider sendiri: token tidak melewati pembatasan login berbasis IP.

## Pertanyaan dan metode

Pertanyaan: apakah poToken membuat request player YouTube dari egress
Cloudflare Workers lolos saat tanpa token ditolak LOGIN_REQUIRED?

- Provider BgUtils (bgutil-ytdlp-pot-provider) v2.0.2 jalan lokal di VM,
  Node v24.22.1, port 4416, localhost saja. Tanpa Docker, tanpa akun baru.
- Request player dikirim lewat proxy CF laras-proxy-spike
  (https://laras-proxy-spike.hiroohengkerr.workers.dev). Proxy meneruskan body
  JSON apa adanya ke youtubei/v1/player, jadi token sampai ke YouTube tanpa
  mengubah proxy.
- Body request meniru resolve.ts fetchPlayer persis: context client, videoId,
  playbackContext dengan signatureTimestamp 20770 (sts terbesar di config),
  racyCheckOk dan contentCheckOk true. Sel dengan token menambah
  serviceIntegrityDimensions.poToken.
- Klien: WEB_REMIX 1.20261110.04.00 (id 67), MWEB 2.20260708.05.00 (id 2),
  ANDROID_VR 1.65.10 (id 14, kontrol tanpa token saja).
- Lagu kanari: hhn-nGSuenM (Semua Tentang Kita), qkC4waEZVt4 (Rahasia Hati).
- Pasangan rapat: sel DENGAN token lalu TANPA token untuk lagu dan klien yang
  sama, selisih puluhan detik, supaya perbandingan terjadi di jendela yang sama.
- Semua penolakan membawa reason "Sign in to confirm you're not a bot" dan
  HTTP 200 dari proxy: penolakan berasal dari YouTube, bukan dari proxy.

## Matriks lengkap

Durasi dalam milidetik (md). "Percobaan" adalah jumlah percobaan fetch
(maksimal 3, karena egress VM flaky; lihat catatan di akhir).

### Baseline tanpa token (konfirmasi jendela buruk)

| Waktu WIB | Lagu | Klien | Token | Playability | Format audio | Itag | Durasi | Percobaan |
|---|---|---|---|---|---|---|---|---|
| 18:46:21 | hhn-nGSuenM | WEB_REMIX | tanpa | LOGIN_REQUIRED | 0 | - | 23413 md | 1 |
| 18:50:00 | hhn-nGSuenM | MWEB | tanpa | OK | 6 | 140,249,250,251,599,600 | 41139 md | 1 |
| 18:53:30 | hhn-nGSuenM | WEB_REMIX | tanpa | LOGIN_REQUIRED | 0 | - | 123420 md | 3 |
| 18:55:06 | qkC4waEZVt4 | WEB_REMIX | tanpa | LOGIN_REQUIRED | 0 | - | 94737 md | 3 |

### Matriks 1: token terikat videoId (18:59:24-19:02:32 WIB)

| Waktu WIB | Lagu | Klien | Token | Playability | Format audio | Itag | Durasi | Percobaan |
|---|---|---|---|---|---|---|---|---|
| 18:59:24 | hhn-nGSuenM | WEB_REMIX | videoId | LOGIN_REQUIRED | 0 | - | 62954 md | 2 |
| 19:00:05 | hhn-nGSuenM | WEB_REMIX | tanpa | LOGIN_REQUIRED | 0 | - | 40593 md | 1 |
| 19:00:50 | qkC4waEZVt4 | WEB_REMIX | videoId | OK | 4 | 140,249,250,251 | 44961 md | 1 |
| 19:01:19 | qkC4waEZVt4 | WEB_REMIX | tanpa | LOGIN_REQUIRED | 0 | - | 28756 md | 1 |
| 19:01:31 | hhn-nGSuenM | MWEB | videoId | LOGIN_REQUIRED | 0 | - | 11792 md | 1 |
| 19:01:48 | qkC4waEZVt4 | MWEB | videoId | LOGIN_REQUIRED | 0 | - | 15569 md | 1 |
| 19:02:05 | qkC4waEZVt4 | MWEB | tanpa | LOGIN_REQUIRED | 0 | - | 16119 md | 1 |
| 19:02:32 | hhn-nGSuenM | ANDROID_VR | tanpa (kontrol) | LOGIN_REQUIRED | 0 | - | 27172 md | 1 |

### Matriks 2: replikasi WEB_REMIX, token yang sama (19:03:19-19:06:42 WIB)

| Waktu WIB | Lagu | Klien | Token | Playability | Format audio | Itag | Durasi | Percobaan |
|---|---|---|---|---|---|---|---|---|
| 19:03:19 | qkC4waEZVt4 | WEB_REMIX | videoId (token sama) | LOGIN_REQUIRED | 0 | - | 24368 md | 1 |
| 19:03:37 | qkC4waEZVt4 | WEB_REMIX | tanpa | LOGIN_REQUIRED | 0 | - | 15007 md | 1 |
| 19:03:44 | hhn-nGSuenM | WEB_REMIX | videoId (token sama) | LOGIN_REQUIRED | 0 | - | 7199 md | 1 |
| 19:06:42 | hhn-nGSuenM | WEB_REMIX | tanpa | NETWORK_ERROR (batal) | - | - | 177687 md | 3 |

Sel 19:06:42 batal total (3 kali timeout egress VM, bukan vonis YouTube) dan
tidak dihitung sebagai bukti ke arah mana pun.

### Matriks 3: token terikat sesi + visitorData, WEB_REMIX (19:10:46-19:11:31 WIB)

| Waktu WIB | Lagu | Klien | Token | Playability | Format audio | Itag | Durasi | Percobaan |
|---|---|---|---|---|---|---|---|---|
| 19:10:46 | hhn-nGSuenM | WEB_REMIX | sesi + visitorData | LOGIN_REQUIRED | 0 | - | 18777 md | 1 |
| 19:10:56 | hhn-nGSuenM | WEB_REMIX | tanpa | LOGIN_REQUIRED | 0 | - | 8531 md | 1 |
| 19:11:08 | qkC4waEZVt4 | WEB_REMIX | sesi + visitorData | LOGIN_REQUIRED | 0 | - | 12648 md | 1 |
| 19:11:31 | qkC4waEZVt4 | WEB_REMIX | tanpa | LOGIN_REQUIRED | 0 | - | 21504 md | 1 |

## Rekap angka

Total 20 probe: 19 vonis YouTube valid + 1 batal (NETWORK_ERROR).

- Dengan token: 8 probe valid, 1 OK, 7 LOGIN_REQUIRED.
  - Token terikat videoId: 6 probe, 1 OK, 5 LOGIN_REQUIRED.
  - Token terikat sesi: 2 probe, 0 OK, 2 LOGIN_REQUIRED.
  - WEB_REMIX dengan token: 6 probe, 1 OK. MWEB dengan token: 2 probe, 0 OK.
- Tanpa token: 11 probe valid, 1 OK, 10 LOGIN_REQUIRED.
- ANDROID_VR (kontrol tanpa token): 1 probe, LOGIN_REQUIRED.

## Analisis

1. Satu OK dengan token tidak membuktikan efek token. OK itu tidak terulang
   dengan token identik 2 menit 29 detik kemudian, dan OK tanpa token juga
   terjadi di jendela yang sama. Blokir berayun per request, bukan saklar
   jendela yang bersih.
2. Varian sesi gagal 0 dari 2, jadi hipotesis "WEB_REMIX butuh token sesi,
   bukan token videoId" tidak menyelamatkan hasil.
3. Kondisi blokir bergerak selama spike: MWEB hhn OK pada 18:50:00 WIB lalu
   ditolak pada 19:01:31, 19:01:48, dan 19:02:05 WIB. Ini memperkuat perlunya
   pasangan rapat, yang dipakai di semua ronde spike ini.
4. Batas bukti: sampel kecil (8 probe dengan token). Manfaat kecil atau
   sesekali tidak bisa disingkirkan sepenuhnya, tapi manfaat andal yang
   dibutuhkan produksi (mengubah jendela buruk menjadi resolve yang jalan)
   tidak terlihat.

## Caveat: IP pembuat token berbeda dengan IP request

Token dibuat dari IP egress VM, sedangkan request player dikirim dari IP
egress Cloudflare Workers. Dokumentasi salah satu provider sejenis mencatat
token sebaiknya dibuat di IP yang sama dengan IP yang diblokir. Dokumentasi
BgUtils tidak menyatakan token terikat IP (IP hanya dipakai sebagai kunci
cache), tapi perbedaan ini belum disingkirkan sebagai penyebab gagal.

Uji lanjutan yang bisa menutup caveat ini: buat token dengan challenge yang
diambil lewat egress CF (opsi `proxy` di endpoint /get_pot), atau bandingkan
token yang dibuat dari dua IP egress berbeda. Keduanya di luar cakupan spike
ini dan butuh jalur egress tambahan. Sampai uji itu ada, vonis ini berlaku
untuk arsitektur "provider di luar CF, request lewat CF".

## Setup provider (terbukti jalan)

- Repo: Brainicism/bgutil-ytdlp-pot-provider, branch 2.0.2, clone depth 1.
- Node v24.22.1 (syarat minimal Node 22). Perintah: `npm ci` (320 paket,
  sekitar 6 menit), `npx tsc`, lalu `node build/main.js --port 4416`.
  Tanpa Docker, tanpa akun baru.
- Server mengikat localhost saja (127.0.0.1 dan ::1). Health check GET /ping
  mengembalikan version 2.0.2.
- Mint token: POST /get_pot dengan body {"content_binding": "<videoId>"}
  untuk token player terikat videoId; POST /get_pot dengan body {} untuk
  token sesi (contentBinding berisi visitorData baru).
- Latensi mint terukur: token pertama (sesi dingin) sekitar 119 detik; token
  kedua dari sesi yang sama kurang dari 1 detik (cache sesi); token sesi baru
  sekitar 202 detik.
- Panjang token: terikat videoId 124 karakter; terikat sesi 724 karakter,
  visitorData 458 karakter. TTL 6 jam (expiresAt dari server).
- Server dihentikan sesudah spike selesai. Menyalakan ulang: perintah yang
  sama dari direktori server.

## Sketsa integrasi

Tidak ada sketsa integrasi produksi, karena vonisnya TIDAK MEMBANTU.
Mengintegrasikan poToken sekarang berarti menambah layanan yang harus dipantau
(provider + perawatan mengikuti perubahan BotGuard) tanpa bukti manfaat untuk
kasus blokir ini.

Bila uji lanjutan (caveat IP di atas) suatu hari membalikkan vonis, bentuk
integrasinya: minta token per lagu ke provider (cache 6 jam per videoId),
selipkan serviceIntegrityDimensions.poToken di fetchPlayer resolve.ts, tanpa
mengubah proxy (proxy sudah meneruskan body apa adanya). Opsi hosting
provider: layanan gratis yang bisa menjalankan Node, dengan catatan provider
butuh canvas dan jsdom sehingga tidak bisa jalan di Workers. Ini sketsa
arsitektur saja, bukan rencana kerja.

## Berkas spike

Semua di hidden_files/koordinator/potoken-spike/ (bukan di bundle app):

- probe.mjs (probe satu sel), matrix.mjs, matrix2.mjs, matrix3.mjs (runner).
- baseline.jsonl, matrix.jsonl, matrix2.jsonl, matrix3.jsonl (data mentah,
  20 baris: 4 baseline + 8 + 4 + 4).
- token-hhn.json, token-qkC4.json, token-session.json (0600, kedaluwarsa
  6 jam; nilai token tidak dicetak di dokumen ini).
- bgutil-ytdlp-pot-provider/ (clone provider + node_modules + build).
- provider.log (log server provider).

Kode produksi tidak diubah: resolve.ts, proxy, config.ts, dan innertube.ts
hanya dibaca.

## Catatan lain

- Probe matriks utama tanpa visitorData (kecuali ronde sesi), sesuai desain
  spike. Resolve produksi memanen visitorData lewat search, tapi perbandingan
  berpasangan membuat perbedaan ini tidak mengubah vonis: kedua sisi
  (dengan dan tanpa token) sama-sama tanpa visitorData di matriks utama.
- Egress VM flaky selama spike: 3 probe gagal jaringan sebelum retry berhasil
  (percobaan 2-3), 1 sel batal total (NETWORK_ERROR 19:06:42 WIB).
- Tidak ada akun baru yang dibuat. Red 7 tidak diganggu: tidak ada perubahan
  di luar folder spike dan dokumen ini.
