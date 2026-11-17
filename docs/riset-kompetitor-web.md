# Riset Kompetitor Web — Laras Web App Full-Stack

Fase 1, proyek Laras versi web: aplikasi musik gratis, tanpa iklan, bisa
offline, di browser. Tanggal cek: 17 November 2026. Semua klaim faktual di
dokumen ini berasal dari sumber yang dibuka pada tanggal itu dan dicantumkan
URL-nya. Bila suatu fakta tidak berhasil diverifikasi, ditulis
"belum terverifikasi" — bukan ditebak.

Laporan ini adalah pendamping, bukan salinan, dari riset APK di
`~/workspace/music-app/docs/riset-kompetitor.md` (15 November 2026). Riset
APK membahas InnerTune, OuterTune, Spotube, ViMusic, dan SimpMusic sebagai
aplikasi Android; dokumen ini hanya memakai riset APK itu sebagai rujukan
status proyek, dan fokusnya adalah: apa yang ada — dan tidak ada — di web.

Konteks Laras yang menjadi patokan: Laras APK memakai InnerTube kustom
(player/search/browse) + solver signature QuickJS + config remote; audio
terbaik itag 251 Opus ~160 kbps; tanpa login, tanpa server, tanpa iklan,
tanpa telemetri, budget nol rupiah. Laras Web jalan paralel dengan APK,
bukan penggantinya.

## Ringkasan eksekutif

- **Tidak satu pun dari keluarga InnerTune punya versi web.** InnerTune,
  OuterTune, dan ViMusic adalah aplikasi Android saja; tidak ada build web
  resmi. Spotube juga tidak punya web build — yang ada hanya Docker yang
  menayangkan aplikasi desktop-nya ke browser lewat streaming layar
  (Selkies), bukan aplikasi web. Artinya: ceruk "client YouTube Music
  gratis di browser" masih terbuka, dan Laras Web tidak berhadapan langsung
  dengan nama-nama besar APK itu di web.
- **Pesaing web yang nyata justru proyek baru berumur hitungan minggu.**
  Musike (dibuat 12 Oktober 2026, MIT, 687 bintang saat dicek) dan Cantio
  (MIT, PWA + backend Vercel) adalah referensi arsitektur terdekat: keduanya
  memutar katalog YouTube Music di browser tanpa akun dan tanpa iklan.
  Decibel dan Vibentra (keduanya MIT, Oktober–November 2026) memakai pola
  yang sama. Semuanya masih sangat muda — belum ada yang mapan.
- **Kendala teknis nomor satu di web adalah CORS + proxy.** Dokumentasi
  youtubei.js menyatakan tegas: memakai library itu di browser WAJIB
  mem-proxy request lewat server sendiri, termasuk untuk streaming audio.
  Ini berlawanan langsung dengan prinsip Laras "tanpa server". Setiap
  proyek web yang diteliti menyelesaikan ini dengan satu dari tiga cara:
  server proxy sendiri (Musike, Decibel), backend serverless (Cantio di
  Vercel), atau IFrame Player API resmi YouTube (Cantio untuk pemutaran).
  Tidak ada proyek yang berhasil memutar audio YouTube Music murni dari
  browser tanpa perantara apa pun — kecuali lewat IFrame resmi.
- **Spotify Web Player dan YouTube Music web adalah patokan UX, bukan
  patokan arsitektur.** Keduanya butuh login, keduanya tidak punya unduhan
  offline di web (Spotify: unduhan hanya di aplikasi desktop/mobile;
  YouTube Music: unduhan hanya di aplikasi mobile, Premium), dan Spotify
  Web Player memakai DRM Widevine sehingga EQ dan visualizer asli tidak
  mungkin dibuat di atasnya. Kelemahan-kelemahan inilah yang menjadi ruang
  pembeda Laras Web.
- **Lirik adalah kemenangan gratis.** LRCLIB adalah API lirik gratis tanpa
  kunci dan tanpa akun, mengembalikan lirik tersinkron format LRC, dan
  mengirim header `Access-Control-Allow-Origin: *` sehingga bisa dipanggil
  langsung dari browser tanpa proxy. Sementara itu YouTube Music justru
  membatasi lirik untuk pengguna gratis (batas lima lagu per bulan sejak
  Februari 2026, menurut satu sumber sekunder). Lirik tersinkron tanpa
  batas adalah pembeda yang murah dan langsung terasa.
- **Pola stack web yang berulang:** React + Vite + Tailwind di frontend;
  Fastify/Express + youtubei.js atau yt-dlp di backend; Zustand untuk
  state; IndexedDB untuk cache/library lokal; Media Session API untuk
  kontrol dari lock screen dan tombol headset.

## 1. Spotify Web Player

Situs: https://open.spotify.com — pemutar Spotify di browser tanpa instalasi.

### Fitur inti

- Putar, cari, jelajah, perpustakaan, playlist, dan antrean: lengkap.
  Antrean bisa dilihat, ditambah, disusun ulang dengan drag, dan
  dikosongkan dari ikon antrean di pemutar bawah.
- Lirik: tersedia untuk pengguna Free maupun Premium, tersinkron, tetapi
  tidak dijamin untuk setiap lagu, wilayah, atau perangkat — ketersediaan
  tergantung lisensi. Lirik offline adalah fitur Premium (pengumuman
  Februari 2026).
- Offline: TIDAK ADA di Web Player, untuk Free maupun Premium. Unduhan
  offline hanya ada di aplikasi desktop dan mobile. Unduhan di aplikasi
  tersimpan terenkripsi, tidak bisa diekspor sebagai MP3, dan kedaluwarsa
  bila tidak terhubung internet minimal sekali dalam 30 hari.
- EQ: tidak ada di Web Player. Equalizer dan pemutaran file lokal hanya
  ada di aplikasi desktop.
- Kualitas audio di web: AAC 128 kbps (Free) dan 256 kbps (Premium),
  menurut satu sumber sekunder; setelan kualitas "Very High" 320 kbps dan
  Lossless hanya ada di aplikasi. Angka bitrate ini belum terverifikasi
  dari sumber resmi Spotify.
- Spotify Connect: mengontrol pemutaran di satu perangkat dari perangkat
  lain; Jam session (teman ikut mengendalikan antrean dari HP-nya) tersedia.

### Arsitektur yang diketahui

- Frontend web di open.spotify.com; pemutaran audio lewat Spotify Web
  Playback SDK (`https://sdk.scdn.co/spotify-player.js`), yang membuat tab
  browser terdaftar sebagai perangkat Spotify Connect.
- Audio DRM: stream Spotify terenkripsi dan hanya bisa diputar lewat
  Widevine Content Decryption Module (EME) di browser. Bila Widevine
  mati atau tidak ada, pemutar menampilkan pesan "Playback of protected
  content is not enabled". Chromium di Linux tanpa Widevine tidak bisa
  memutar sama sekali.
- Web Playback SDK hanya berfungsi untuk akun Premium; akun Free ditolak
  streaming oleh SDK. Login memakai OAuth 2.0 + PKCE, tanpa server
  (client-side saja) untuk aplikasi pihak ketiga.
- Konsekuensi DRM yang penting: audio yang diputar SDK berjalan lewat
  decoder tersandbox dan tidak pernah mengekspos sampel mentah atau node
  Web Audio — jadi TIDAK ADA cara bagi aplikasi berbasis browser untuk
  membuat visualizer FFT asli atau EQ asli di atas pemutaran Spotify.
  Lirik juga tidak diekspos lewat Spotify Web API untuk aplikasi pihak
  ketiga; aplikasi pihak ketiga harus memakai sumber lirik lain
  (misalnya lyrics.ovh).
- Sejak Februari 2026, Spotify menurunkan batas pengguna Dev Mode dari 25
  menjadi 5 pengguna per Client ID, dan repo Web Playback SDK di GitHub
  sudah diarsipkan sejak 29 Juni 2020 — arah Spotify adalah mengetatkan,
  bukan membuka, akses developer.

### Keunggulan dan kelemahan

- Keunggulan: katalog resmi dan legal; sinkronisasi library/playlist/
  antrean antar perangkat; rekomendasi dan radio yang matang; lirik
  tersinkron untuk Free dan Premium; tanpa instalasi.
- Kelemahan: wajib login; iklan dan batasan di Free; tidak ada offline di
  web; tidak ada EQ di web; kualitas audio web dibatasi; butuh Widevine
  (gagal total di browser tanpa DRM); tidak ada pemutaran file lokal di
  web.

### Lisensi

Proprietary, layanan komersial Spotify. Bukan open source.

### Pelajaran untuk Laras Web

- Patokan UX antrean: tambah, hapus, susun ulang dengan drag, kosongkan —
  ini standar minimum yang diharapkan pengguna web.
- "Tanpa login + offline di web + EQ" adalah kombinasi yang Spotify Web
  Player secara struktural tidak bisa tandingi (DRM + kebijakan produk).
  Itu ruang pembeda utama.
- Jangan sentuh API Spotify dalam bentuk apa pun — sudah menjadi keputusan
  proyek sejak preseden cease-and-desist Spotify ke Spotube (2025), dan
  pengetatan Dev Mode 2026 memperkuatnya.

Sumber:

- https://umatechnology.org/spotify-web-player-how-to-use-and-access-it/
- https://sekin.in/spotify-web-player-how-to-use-and-access-it/
- https://www.slpotify.com/news/spotify-web-player-login.html
- https://guides.emudesk.com/spotify-on-pc-guide-2026/
- https://www.audfun.com/spotify/spotify-web-player-vs-desktop.html
- https://deus-soft.com/blog/spotify-protected-content/
- https://github.com/yaniv3487/spotiamp/blob/HEAD/CLAUDE.md
- https://github.com/vossjona/buzz/blob/HEAD/docs/MUSIC-PROVIDER-RESEARCH.md

## 2. YouTube Music web

Situs: https://music.youtube.com — pemutar web resmi Google. Tidak ada
aplikasi desktop resmi YouTube Music sampai 2026; jawaban resmi Google di
komputer adalah web player ditambah PWA yang bisa diinstal lewat Chrome
atau Edge.

### Fitur inti

- Putar, cari (termasuk cari berdasarkan lirik), jelajah (Home, Charts,
  Moods & Genre), perpustakaan, playlist, dan antrean "Up Next" yang bisa
  disusun ulang dan dihapus isinya.
- Lirik: ada lirik bawaan; lirik real-time (tersinkron, baris menyala
  mengikuti lagu) terutama tersedia di aplikasi mobile — web player
  umumnya menampilkan lirik statis. Sejak September 2024 banyak lagu
  kehilangan sinkronisasi saat Google mengganti backend lirik dari
  Musixmatch ke LyricFind; sejak akhir 2025 Google mulai memayungi lirik
  di balik Premium. Menurut satu sumber sekunder, sejak Februari 2026
  pengguna gratis dibatasi lima lagu penuh per bulan, selebihnya lirik
  diburamkan. Batas lima lagu ini belum terverifikasi dari sumber resmi
  Google.
- Offline: TIDAK ADA di web. Unduhan dan Smart Downloads hanya ada di
  aplikasi mobile, dan umumnya butuh Premium.
- EQ: tidak ada equalizer bawaan di web player. Riset fitur pihak ketiga
  mencatat EQ + normalisasi loudness sebagai fitur yang harus ditambahkan
  lewat ekstensi browser, memakai satu AudioContext bersama di atas
  elemen `<video>` pemutar.
- Audio dan video: bisa beralih antara mode audio dan video; YT Music
  memutar stream lewat MSE dengan URL `blob:` same-origin.
- Login Google wajib untuk sinkronisasi playlist dan like; pemutaran
  biasanya melanjutkan posisi terakhir saat login.

### Arsitektur yang diketahui

- Aplikasi web (SPA) yang berbicara ke API InnerTube privat Google
  (`/youtubei/v1/...`) sebagai client `WEB_REMIX`, numeric clientName 67.
  `clientVersion` bersifat sensitif waktu (format `1.YYYYMMDD.XX.XX`)
  dan harus dibaca dari traffic live, bukan di-hardcode; halaman
  mengekspos konteks client lengkap lewat `ytcfg` (`INNERTUBE_CONTEXT`).
- Pemutar mengisi `navigator.mediaSession` sendiri (judul, artis, album,
  sampul, status putar), sehingga kontrol media OS bisa membaca dan
  mengendalikannya.
- Karena stream memakai MSE `blob:` same-origin, `createMediaElementSource`
  tidak terkena masalah cross-origin — ini yang memungkinkan ekstensi
  memasang EQ Web Audio di atas pemutar resmi.

### Keunggulan dan kelemahan

- Keunggulan: katalog YouTube Music lengkap termasuk video musik dan
  konten kreator; rekomendasi dan radio berbasis perilaku dengar;
  gratis (dengan iklan) tanpa instalasi; PWA resmi bisa diinstal.
- Kelemahan: wajib login Google untuk library; iklan di Free; tidak ada
  pemutaran background di mobile Free; tidak ada offline di web; tidak
  ada EQ; lirik di web statis dan makin dibatasi untuk pengguna gratis;
  tidak ada aplikasi desktop resmi.

### Lisensi

Proprietary, layanan Google. Bukan open source.

### Pelajaran untuk Laras Web

- Client `WEB_REMIX` (67) adalah referensi perilaku InnerTube versi web —
  berguna saat merancang client web Laras, termasuk soal `clientVersion`
  yang harus segar.
- `navigator.mediaSession` adalah kewajiban, bukan hiasan: kontrol lock
  screen dan headset adalah ekspektasi dasar pemutar web.
- Lirik tersinkron tanpa batas + EQ Web Audio + offline adalah tiga
  kelemahan resmi yang bisa langsung dijadikan pembeda.

Sumber:

- https://github.com/animeshkundu/youtube-audio/blob/HEAD/docs/research/12-youtube-music-features.md
- https://www.viwizard.com/youtube-music-tips/youtube-music-lyrics.html
- https://umatechnology.org/what-is-youtube-music-everything-you-need-to-know/
- https://www.simpmusic.org/blogs/youtube-music-desktop-app
- https://www.drmare.com/audio-recorder/youtube-music-to-desktop.html

## 3. InnerTune — tidak ada versi web

Repo: https://github.com/z-huang/InnerTune (GPL-3.0). Client YouTube Music
Android (Kotlin, Jetpack Compose). Rilis terakhir v0.5.10 (1 September
2024); status "jalan pelan" menurut riset APK.

Tidak ditemukan versi web, PWA, atau build browser apa pun dari InnerTune,
baik di repo resmi maupun di sumber sekunder yang dibuka. Proyek ini
Android saja. Satu-satunya cara memakainya di komputer adalah emulator
Android — bukan versi web.

Pelajaran untuk Laras Web: modul `innertube` InnerTune yang terpisah dari
modul aplikasi adalah pola yang tetap relevan di web — pisahkan lapisan
pengambilan katalog/stream dari lapisan UI, supaya satu jalur bisa diganti
tanpa merombak aplikasi. Lirik tersinkron + penerjemah lirik InnerTune
adalah standar fitur yang harus ditandingi.

Sumber:

- ~/workspace/music-app/docs/riset-kompetitor.md (riset APK, 15 Nov 2026)
- https://rajendra7169.github.io/blazify/compare/ (tabel: InnerTune Android saja)

## 4. OuterTune — tidak ada versi web

Repo: https://github.com/OuterTune/OuterTune (GPL-3.0). Fork InnerTune yang
menambah pemutar file lokal. README menyatakan "This app is no longer in
active development"; v0.11.x menghapus YouTube Music dan menjadi pemutar
lokal saja; rilis YTM terakhir v0.10.1 (19 Desember 2025).

Satu sumber sekunder menyatakan eksplisit: "No native iOS, Windows,
macOS, or browser edition is documented in the original repository"
— tidak ada edisi browser. Klaim situs pihak ketiga soal versi PC/web
tidak terverifikasi dan tidak berasal dari repo resmi. Cara PC yang
disebut hanyalah emulator Android.

Pelajaran untuk Laras Web: penyatuan lagu streaming dan file lokal dalam
satu antrean (ciri khas OuterTune) adalah fitur yang sangat cocok
diterjemahkan ke web — browser bisa memutar file lokal pengguna lewat
File API / File System Access API tanpa mengunggah apa pun. Lirik kata
per kata (LRC/TTML) OuterTune adalah patokan kualitas lirik.

Sumber:

- https://outertune.com.in/
- https://h5.2113.net/apps/outertune.html
- ~/workspace/music-app/docs/riset-kompetitor.md (riset APK, 15 Nov 2026)

## 5. ViMusic — tidak ada versi web resmi

Repo: https://github.com/vfsfitvnm/ViMusic (GPL-3.0). Pelopor client YouTube
Music Android (Kotlin, Jetpack Compose). Rilis terakhir v0.5.4
(4 November 2022); repo diarsipkan pemiliknya 15 Maret 2026 dan kini
read-only.

Tidak ada versi web resmi. Situs-situs pihak ketiga (vimusicapk.com)
mengklaim ada "akses web browser", tetapi klaim itu tidak menunjuk ke
produk nyata apa pun — tidak ada URL aplikasi web, tidak ada repo web —
dan situs yang sama juga mengklaim ViMusic tersedia untuk iOS, yang
bertentangan dengan fakta proyek Android saja. Klaim web ViMusic
dinilai tidak kredibel. Ada satu hasil pencarian yang menyebut
`vimusic.vercel.app` sebagai "Free Online Music & Video Player", tetapi
keterkaitannya dengan proyek ViMusic asli (vfsfitvnm) belum
terverifikasi — nama yang sama belum tentu proyek yang sama.

Pelajaran untuk Laras Web: ViMusic membuktikan cache audio otomatis
(2 GB LRU di disk) membuat lagu yang pernah diputar bisa diputar offline
tanpa langkah unduh eksplisit. Padanan web-nya adalah Cache Storage /
IndexedDB: lagu yang sudah diputar tersimpan otomatis dan bisa diputar
offline. Ini pola offline yang lebih halus daripada tombol unduh.

Sumber:

- https://vimusicapk.com/what-platforms-is-the-vimusic-app-available-on/
- https://vimusicapk.com/vimusic-app-compatibility-unleashing-music-across-devices/
- http://gitdiagram.com/vaginessa/vitune
- ~/workspace/music-app/docs/riset-kompetitor.md (riset APK, 15 Nov 2026)

## 6. Spotube — tidak ada web build

Repo: https://github.com/team-spotube/spotube (AGPL-3.0-or-later sejak
v6.0.0, 9 November 2026). Platform: Android, Windows, macOS, Linux, iOS.
Tidak ada target web dalam daftar platform maupun dalam instruksi build
(dokumen build menyebut Desktop JVM, Android, dan rilis installer
per-platform — tidak ada build web).

Yang ada dan sering membingungkan:

- `linuxserver/spotube` (Docker): menayangkan aplikasi desktop Spotube
  ke browser lewat Docker Baseimage Selkies — streaming desktop/GUI ke
  browser di port 3001 (HTTPS). Ini BUKAN aplikasi web: butuh server
  Docker sendiri, tanpa autentikasi secara default, dan antarmuka web-nya
  menyertakan terminal dengan sudo tanpa kata sandi. Tidak relevan sebagai
  produk web untuk pengguna umum.
- Entri "SpoTube for Web Apps" di Softonic dan add-on Firefox "SpotTube"
  adalah produk/nama berbeda, bukan Spotube resmi.

Pelajaran untuk Laras Web: arsitektur plugin Spotube (app inti terpisah
dari sumber audio) adalah pola ketahanan yang bagus — bila satu sumber
audio bermasalah, app inti tetap hidup. Di web, pola ini bisa diterjemahkan
sebagai lapisan "penyedia stream" yang bisa diganti (InnerTube langsung,
IFrame API, proxy serverless) tanpa mengubah UI. Peringatan yang sama
berlaku: jangan sentuh API Spotify.

Sumber:

- https://hub.docker.com/r/linuxserver/spotube
- https://git.opnkty.uk/kitty/spotube (cermin README: target build tanpa web)
- ~/workspace/music-app/docs/riset-kompetitor.md (riset APK, 15 Nov 2026)

## 7. Musike — PWA open-source (referensi utama)

Repo: https://github.com/Ernani1234/musike (MIT). Dibuat 12 Oktober 2026;
saat dicek 17 November 2026: 687 bintang, 77 fork, 8 rilis, 22 commit.
Proyek paling relevan untuk Laras Web: pemutar katalog YouTube Music
tanpa iklan, tanpa akun, tanpa langganan, yang berjalan di browser
sebagai PWA yang bisa diinstal — plus aplikasi Windows, macOS, Linux,
Android, Android TV, iPhone, dan Docker.

### Fitur inti

- Putar lagu atau video musik sebagai audio atau video, bisa beralih
  kapan saja dari titik yang sama; video musik resmi ditemukan otomatis
  (hanya dari channel artis sendiri); mode Cinema; video SD (cepat) atau
  HD 720p (di-cache lokal).
- Cari YouTube Music dengan tab Lagu, Video, dan Album, plus saran saat
  mengetik; tempel link YouTube untuk langsung memutar; "Search a list"
  — ketik beberapa lagu dipisah koma, semuanya ditemukan sekaligus.
- Jelajah genre (Rock, Pop, Hip-hop, Indie, Metal, Jazz, dst.) dengan
  daftar band/artis dan semua lagu per genre; halaman artis (greatest
  hits + semua album dan single); halaman album (putar berurutan,
  shuffle, atau simpan jadi playlist sekali klik).
- Antrean dengan play-next, shuffle, repeat (antrean atau lagu);
  autoplay radio saat antrean habis; seeking instan (streaming HTTP
  Range) dan lagu berikutnya di-preload.
- Perpustakaan: playlist, Favorit, riwayat baru diputar; pilih banyak
  lagu sekaligus; backup library ke file (gabung atau ganti, dengan
  pratinjau sebelum impor).
- Offline: TIDAK ada fitur unduh/offline eksplisit di README. Yang ada:
  cache video HD (2 GB, least-recently-played first) dan audio tidak
  ditulis ke disk sama sekali. Jadi PWA-nya butuh server dan koneksi.
- Lirik: TIDAK disebut di README — tidak ada fitur lirik yang
  terdokumentasi.
- EQ: TIDAK disebut di README.
- Kustomisasi: tema gelap/terang, 8 warna aksen preset atau warna
  kustom; panel bisa ditampilkan/disembunyikan; responsif dari HP 320 px
  sampai monitor ultrawide; kontrol Media Session (lock screen, headset,
  tombol media); antrean dilanjutkan dari posisi terakhir.

### Arsitektur yang diketahui

- Monorepo TypeScript penuh: `server/` (Fastify 5 + yt-dlp + youtubei.js),
  `web/` (React 19 + Vite 8 + Tailwind CSS 4 + Motion + Zustand +
  React Router + Phosphor Icons, PWA), `desktop/` (Electron 44),
  `mobile/` (Capacitor 8).
- Alur: server menanyakan katalog YouTube Music lewat youtubei.js
  (cari, saran, genre, artis, album, radio, pilih video musik resmi);
  yt-dlp menyelesaikan URL stream (audio AAC, video MP4) dengan
  menjalankan kode player YouTube lewat Deno; karena URL stream terikat
  IP yang menyelesaikannya, server MEM-PROXY byte-nya ke pemutar sambil
  meneruskan header `Range` agar seeking instan. Audio tidak ditulis ke
  disk; video HD diunduh + digabung dengan FFmpeg lalu di-cache (2 GB).
- Library (playlist, favorit, riwayat) tersimpan di `library.json`,
  ditulis secara atomik.
- Di Android/iPhone TIDAK ADA server: aplikasi menjalankan kode server
  itu sendiri di HP (katalog + library) dan meminta stream audio
  langsung dari HP, sehingga URL stream milik koneksi HP sendiri dan
  pemutar membacanya langsung tanpa proxy. Client YouTube yang dipakai
  untuk stream dibaca dari `mobile/streaming.json`, bisa diubah tanpa
  rilis aplikasi baru — pola config remote yang sama dengan Laras APK.
- Web: satu elemen `<video>` yang berpindah-pindah tempat di halaman
  (panel, fullscreen, mini player, cinema mode) tanpa memutus pemutaran.
- Self-hosting: image Docker (amd64 + arm64, termasuk Raspberry Pi);
  dibuka dari perangkat lain di jaringan yang sama, atau dari mana saja
  lewat Tailscale.

### Keunggulan dan kelemahan

- Keunggulan: satu codebase TypeScript untuk semua platform; PWA
  installable; tanpa akun, tanpa iklan; arsitektur proxy Range yang
  membuat seeking instan; config stream remote tanpa rilis ulang;
  backup library berbasis file yang bisa dipindah antar perangkat.
- Kelemahan: WAJIB server sendiri (atau Docker) untuk versi web/PWA —
  tidak ada versi web yang bisa dibuka langsung tanpa menjalankan
  server; tidak ada lirik; tidak ada EQ; tidak ada offline audio;
  proyek berumur 5 minggu (22 commit) — sangat muda, risiko
  keberlanjutan belum teruji; installer desktop belum code-signed /
  belum notarized.

### Lisensi

MIT.

### Pelajaran untuk Laras Web

- Ini cetak biru arsitektur terdekat: React + Vite + Tailwind + Zustand
  untuk web, Fastify + youtubei.js + yt-dlp untuk server, proxy Range
  untuk seeking instan.
- Pola "satu elemen media yang berpindah tempat" untuk mode video/mini
  player patut ditiru bila Laras Web menambah mode video.
- Celah Musike adalah peluang Laras Web: lirik tersinkron, EQ, dan
  offline audio — ketiganya tidak dimiliki Musike.
- Peringatan: model "wajib server sendiri" bertentangan dengan janji
  Laras "tanpa server". Laras Web harus memutuskan: serverless tipis
  (fungsi proxy di Vercel/Cloudflare, gratis) atau IFrame API — bukan
  server yang harus dijalankan pengguna.

Sumber:

- https://github.com/Ernani1234/musike (README dibaca langsung, 17 Nov 2026)
- https://dev.to/itxtayab/musike-a-free-open-source-music-player-for-youtube-music-with-no-ads-and-no-account-6fo

## 8. Cantio — PWA open-source (serverless)

Repo: https://github.com/akshay-k-a-dev/Cantio (MIT). Situs live:
https://music.akshayka.dev — bisa dicoba langsung tanpa daftar.

### Fitur inti

- Putar dari YouTube Music tanpa iklan; skip tanpa batas; shuffle,
  repeat lagu, repeat antrean; susun ulang antrean dengan drag-and-drop
  + auto-scroll; panel lirik tersinkron.
- Perpustakaan: lagu disukai, banyak playlist, "Blends" (gabung selera
  dengan teman jadi playlist bersama), riwayat putar dengan
  reverse-queue (tombol previous yang benar-benar berfungsi).
- Mode tamu: berfungsi penuh tanpa login; akun opsional hanya untuk
  sinkronisasi antar perangkat (lagu disukai, playlist, riwayat).
- Offline: klaim README "Guest mode — works fully offline, no login
  ever needed" — tetapi yang dimaksud "offline" di sini adalah tanpa
  akun, bukan pemutaran audio tanpa internet; tidak ada fitur unduh
  audio atau cache offline yang terdokumentasi di README. Pemutaran
  offline sejati: belum terverifikasi.
- EQ: tidak disebut di README.
- Platform: web app (PWA, bisa diinstal di perangkat apa pun), desktop
  (Windows, Linux; macOS dalam roadmap), mobile (dalam pengerjaan).

### Arsitektur yang diketahui

- Frontend: React 18, Vite, Tailwind CSS, Zustand, Framer Motion.
- Backend: Fastify, TypeScript, Prisma, PostgreSQL — di-deploy sebagai
  serverless di Vercel.
- Cari/metadata: Innertube lewat youtubei.js (di backend).
- Pemutaran: YouTube IFrame Player API resmi — ini keputusan arsitektur
  kunci: audio diputar lewat player resmi YouTube, sehingga Cantio
  mengklaim pemutarannya berada di bawah Terms of Service YouTube
  ("Streaming uses the official YouTube IFrame Player API under
  YouTube's terms of service").
- Penyimpanan lokal: Zustand stores + cache IndexedDB di frontend.
- API backend: `/search`, `/track/:id` tanpa auth; `/likes`,
  `/playlists`, `/recommendations`, `/blends` dengan JWT.
- Desktop: wrapper Electron.

### Keunggulan dan kelemahan

- Keunggulan: PWA live yang bisa langsung dibuka tanpa instalasi server;
  tanpa akun untuk fungsi inti; tanpa telemetri/analytics/iklan;
  pemutaran lewat IFrame resmi (posisi ToS lebih aman daripada
  ekstraksi stream); Blends adalah fitur sosial yang tidak dimiliki
  kompetitor web lain; stack modern dan umum.
- Kelemahan: butuh backend + database PostgreSQL (akun/sinkronisasi);
  IFrame Player berarti kualitas audio dan perilaku pemutaran
  dikendalikan YouTube (tidak ada itag pilihan, tidak ada akses byte
  audio untuk EQ/visualizer); tidak ada EQ; offline audio tidak
  terdokumentasi; proyek muda (versi desktop 1.0.0).

### Lisensi

MIT.

### Pelajaran untuk Laras Web

- IFrame Player API adalah satu-satunya jalur pemutaran "tanpa server
  proxy" yang sah di browser — kandidat jalur fallback bila proxy
  InnerTube bermasalah, dengan konsekuensi tidak ada EQ dan tidak ada
  kontrol kualitas audio.
- Pola "tamu penuh + akun opsional hanya untuk sinkronisasi" adalah
  kompromi privasi yang elegan; Laras Web bisa mengadopsi pola yang
  sama (sinkronisasi opsional di fase lanjut, bukan di awal).
- Reverse-queue (previous yang benar-benar kembali ke lagu sebelumnya,
  bukan restart lagu) adalah detail kecil yang disebut eksplisit sebagai
  fitur — standar kualitas yang patut ditiru.
- Blends menunjukkan fitur sosial ringan bisa dibangun tanpa mengubah
  arsitektur inti.

Sumber:

- https://github.com/akshay-k-a-dev/cantio/blob/HEAD/README.md (dibaca langsung, 17 Nov 2026)

## 9. Decibel — PWA open-source (self-hosted)

Repo: https://github.com/EduardGilM/Decibel (MIT). Dibuat 18 Oktober 2026.
Pemutar gaya Spotify yang self-hosted.

### Fitur inti

- Katalog YouTube Music: cari dengan saran (lagu, album, artis), halaman
  album dan artis.
- Bisa juga memutar library sendiri dari Navidrome/Subsonic, mengikuti
  podcast lewat RSS, dan profil per orang.
- Platform: web app/PWA, aplikasi Android (Tauri), aplikasi desktop
  Windows dan Linux (Tauri v2).
- Antarmuka aplikasi saat ini berbahasa Spanyol.
- Detail fitur lirik, EQ, antrean, dan offline: belum terverifikasi —
  README yang terindeks tidak merincinya dalam hasil yang dibuka.

### Arsitektur yang diketahui

- Katalog YouTube Music lewat ytmusicapi (Python), audio di-stream
  lewat yt-dlp; jembatan katalog di `server/ytmusic.{mjs,py}`.
- Browser/PWA/aplikasi Tauri berbicara ke server; server yang
  berhubungan dengan YouTube.
- Disclaimer: proyek tidak resmi, non-komersial, tidak berafiliasi
  dengan YouTube/Google, untuk pemakaian pribadi.

### Keunggulan dan kelemahan

- Keunggulan: menggabungkan katalog YouTube Music + library sendiri
  (Navidrome/Subsonic) + podcast dalam satu aplikasi; profil per orang;
  PWA + Tauri (lebih ringan daripada Electron).
- Kelemahan: self-hosted (pengguna harus menjalankan server); UI hanya
  bahasa Spanyol; proyek berumur satu bulan; detail fitur belum
  terverifikasi.

### Lisensi

MIT.

### Pelajaran untuk Laras Web

- Kombinasi "katalog YouTube Music + library sendiri" dalam satu
  aplikasi adalah pola yang sama dengan visi OuterTune — dan Decibel
  membuktikan pola itu bisa hidup di web/PWA.
- Dukungan Navidrome/Subsonic menunjukkan ada standar terbuka
  (API Subsonic) untuk library sendiri; Laras Web bisa mempertimbangkannya
  sebagai jalur library lokal di fase lanjut.

Sumber:

- https://github.com/EduardGilM/Decibel

## 10. Vibentra — PWA open-source (Vercel)

Repo: https://github.com/srivatsan2007/Vibentra (MIT). Situs live:
https://vibentra.vercel.app/.

### Fitur inti

- Streaming multi-sumber (JioSaavn, YouTube Music, tangga lagu global).
- Equalizer grafis 10 band, Sound DSP Studio, smart sleep timer,
  AI DJ Queue Engine, mosaik Spotify 2x2, pemutaran background native
  tanpa putus.
- Platform: Web, PWA, dan APK Android native.
- Detail lirik, perpustakaan, dan offline: belum terverifikasi dari
  README yang dibuka (klaim fitur di atas berasal dari README repo).

### Arsitektur yang diketahui

- Client Web/PWA/APK Android (Capacitor 8 + Service Worker) memanggil
  backend Node.js/Express lewat REST API; backend tersambung ke
  "YouTube Music Audio Engine" untuk cari dan stream.
- Deploy di Vercel Edge (CDN global) + GitHub Actions.
- PWA diinstal dari `https://vibentra.vercel.app/` di Chrome (Android)
  atau Safari (iOS).

### Keunggulan dan kelemahan

- Keunggulan: satu-satunya PWA dalam riset ini yang mengklaim EQ 10
  band + DSP + sleep timer; PWA live yang bisa langsung dibuka; MIT.
- Kelemahan: klaim fitur (AI DJ, DSP studio) belum diverifikasi dengan
  pengujian langsung; butuh backend Node/Express sendiri; proyek muda.

### Lisensi

MIT.

### Pelajaran untuk Laras Web

- EQ 10 band di PWA adalah pembuktian konsep bahwa EQ Web Audio bisa
  jadi fitur utama pemutar web — bukan sekadar tambahan.
- "AI DJ Queue Engine" (antrean cerdas) adalah ide pembeda yang murah:
  antrean yang diisi otomatis berdasarkan lagu yang sedang diputar,
  tanpa server rekomendasi berat.

Sumber:

- https://github.com/srivatsan2007/vibentra/blob/HEAD/README.md

## 11. Feishin + Navidrome — pemutar web self-hosted

Feishin: https://feishin.vercel.app/ (instance web ter-hosting),
repo https://github.com/jeffvli/feishin. Navidrome:
https://github.com/navidrome/navidrome (GPL-3.0, server musik berbasis
Go). Keduanya TIDAK memutar YouTube Music — mereka memutar library
milik pengguna dari server sendiri — tetapi Feishin adalah pemutar web
open-source paling matang yang diteliti, sehingga arsitektur web-nya
sangat relevan.

### Fitur inti (Feishin)

- Jelajah: dashboard dengan carousel unggulan, shortcut genre, paling
  sering diputar, rilisan terbaru; browse album, artis, genre, folder,
  stasiun radio.
- Antrean, panel lirik, dan visualizer di sidebar pemutar; lirik
  tersinkron dan tidak tersinkron (lirik Jepang bisa tampil furigana
  dan romaji).
- Playlist cerdas berbasis aturan (Navidrome) dengan editor aturan
  visual; playlist bisa diorganisasi ke folder.
- Auto DJ: mengisi antrean yang menipis dengan lagu atau album penuh;
  radio internet dari server.
- EQ parametrik, kompresor, ReplayGain, transkoding opsional.
- Rating bintang, favorit, scrobbling ke server; tema (32 tema bawaan)
  dan 39 bahasa antarmuka; multi-server (Jellyfin, Navidrome,
  Subsonic/OpenSubsonic).
- Dua backend pemutar: MPV (desktop, gapless, bit-perfect) dan web
  player backend (browser). Aplikasi desktop bisa memakai keduanya;
  client web memakai backend web player.
- Offline: tidak ada fitur unduh offline yang terdokumentasi untuk
  client web; satu direktori menyebut lagu dan lirik di-cache di
  perangkat untuk pemutaran offline — belum terverifikasi dari sumber
  primer Feishin.

### Arsitektur yang diketahui

- Feishin ditulis TypeScript, memakai Electron untuk build desktop;
  tersedia sebagai aplikasi desktop, aplikasi web, dan Docker.
  Instance web ter-hosting di feishin.vercel.app.
- Navidrome adalah server Go yang ringan: mengindeks folder file audio
  dan melayani koleksi lewat web player + API Subsonic/OpenSubsonic,
  sehingga banyak client (Feishin, Symfonium, DSub, dsb.) bisa tersambung.
- Feishin adalah rewrite dari pemutar Sonixd yang lebih lama.
- Rilis terakhir yang tercatat di direktori: v1.17.0 (November 2026);
  satu halaman lain menyebut v1.15.1 (19 Juli 2026). Angka rilis
  terbaru belum terverifikasi dari halaman rilis GitHub.

### Keunggulan dan kelemahan

- Keunggulan: pemutar web paling matang dan paling lengkap fiturnya
  dalam riset ini; EQ parametrik + ReplayGain + Auto DJ + playlist
  cerdas; multi-server; tema dan bahasa melimpah; instance web bisa
  langsung dibuka.
- Kelemahan: HANYA memutar library sendiri — pengguna harus punya
  server + koleksi file musik; tanpa katalog streaming; butuh
  username/password server; tidak ada katalog YouTube Music.

### Lisensi

- Navidrome: GPL-3.0 (konsisten di semua sumber).
- Feishin: BERTENTANGAN — direktori Enlisted dan feishin.com menyebut
  GPL-3.0, sedangkan situs feishin.net menyebut MIT ("Feishin is free
  and MIT-licensed"). Lisensi Feishin belum terverifikasi dari file
  LICENSE repo.

### Pelajaran untuk Laras Web

- Feishin adalah patokan kualitas pemutar web: Auto DJ, EQ parametrik,
  playlist cerdas, lirik tersinkron dengan furigana/romaji, dan panel
  sidebar (antrean/lirik/visualizer) adalah fitur-fitur yang bisa
  diadopsi satu per satu.
- Pemisahan "backend MPV vs backend web player" menunjukkan pemutar web
  harus dirancang dengan lapisan pemutaran yang bisa diganti.
- Model "client + server terpisah lewat API terbuka" memungkinkan
  banyak client hidup dari satu server — pelajaran untuk desain API
  Laras Web bila suatu hari ada backend.

Sumber:

- https://feishin.net/
- https://www.feishin.com/
- https://enlisted.directory/alternatives/youtube-music
- https://repocloud.io/results/?searchAppsForm=&category=Music&explore=
- https://docs.alexlebens.dev/Applications/cl01tl/navidrome/
- https://freeinsteadof.com/blog/open-source-music-app

## 12. Nuclear — desktop Tauri (bukan web, pelajaran plugin)

Repo: https://github.com/nukeop/nuclear (AGPL-3.0). Dibuat 2016; saat
dicek 17 November 2026: 18.961 bintang, 1.359 fork, 92 rilis. TIDAK ADA
versi web — aplikasi desktop Windows, macOS, Linux. Diteliti karena
arsitektur plugin dan kematangan fiturnya.

### Fitur inti

- Cari dan streaming dari sumber mana pun (plugin); halaman artis
  (biografi, diskografi, artis mirip); halaman album; antrean dengan
  shuffle, repeat, drag-and-drop; favorit (album, artis, lagu);
  playlist (buat, impor, ekspor, impor dari berbagai layanan); lirik
  tersinkron (termasuk furigana dan terjemahan); riwayat dengar dan
  statistik; tema bawaan + tema CSS kustom; update otomatis; shortcut
  keyboard; multi-bahasa; Nuclear Jam (kendalikan pemutar dari HP
  lewat server web kecil di LAN, port 4120–4129, dengan kode QR);
  server MCP lokal (127.0.0.1:8800) agar AI agent bisa mengendalikan
  pemutar.
- Offline: tidak ada fitur unduh/offline yang terdokumentasi di README.
- EQ: tidak disebut di README.

### Arsitektur yang diketahui

- Monorepo pnpm + Turborepo; aplikasi utama Tauri (Rust + React) +
  TypeScript. Node.js >= 22, pnpm >= 9, Rust stable.
- Sistem plugin: SEMUA fungsi digerakkan plugin — plugin menyediakan
  sumber streaming, metadata, playlist, konten dashboard, dan lain-lain.
  Ada plugin store bawaan; plugin diinstal dari rilis GitHub masing-masing
  plugin; SDK plugin tersedia sebagai `@nuclearplayer/plugin-sdk`.
- Nuclear tidak men-host musik; apa yang bisa diputar sepenuhnya
  tergantung plugin yang diaktifkan dan layanan yang dijangkau plugin itu.
- Rilis terbaru yang tercatat di direktori: player@1.55.0 (7 Juli 2026)
  menurut satu sumber, 1.54.2 (6 November 2026) menurut sumber lain —
  angka rilis terbaru belum terverifikasi dari halaman rilis GitHub.

### Keunggulan dan kelemahan

- Keunggulan: proyek paling matang dan paling lama hidup dalam riset
  ini (sejak 2016, masih commit aktif November 2026); arsitektur plugin
  memisahkan app inti dari sumber audio; tanpa iklan dan tanpa tracking;
  Nuclear Jam dan MCP adalah fitur kendali jarak jauh yang unik.
- Kelemahan: desktop saja, tidak ada web/PWA; kualitas dan
  ketersediaan sumber bergantung pada plugin komunitas; build macOS
  tidak ditandatangani sertifikat Apple Developer (Gatekeeper memblokir
  peluncuran pertama); sebagai proyek komunitas, ada risiko stabilitas
  dan bug.

### Lisensi

AGPL-3.0.

### Pelajaran untuk Laras Web

- Arsitektur plugin adalah jawaban jangka panjang untuk ketahanan:
  bila satu sumber stream mati, plugin lain mengambil alih tanpa
  merombak app. Laras Web bisa merancang lapisan "penyedia" yang
  bisa ditambah/diganti sejak awal, walau v1 hanya punya satu penyedia.
- Nuclear Jam membuktikan server web kecil di LAN + kode QR adalah cara
  murah membuat remote control HP — ide yang bisa dipakai Laras Web
  (kendalikan pemutar desktop dari HP) di fase lanjut.
- Lirik tersinkron + terjemahan + furigana adalah standar emas tampilan
  lirik.

Sumber:

- https://github.com/nukeop/nuclear (README dibaca langsung, 17 Nov 2026)
- https://www.ithub.directory/media-players-streaming/nuclear
- https://appsgit.com/desktop-apps/nuclear

## 13. Muffon — desktop Electron + Vue (bukan web)

Repo: https://github.com/staniel359/muffon (AGPL-3.0). Client streaming
musik desktop lintas platform (Windows 10/11, macOS, Linux). TIDAK ADA
versi web. Diteliti karena kelengkapan fitur dan pola multi-sumbernya.

### Fitur inti

- Mendengarkan (artis/album/lagu) + offline + equalizer + automatch
  lagu/audio; artis (lagu/album/mirip/konser); album; lagu; tag;
  antrean (+ shuffle/loop + tambah album); library musik (+ impor dari
  akun); integrasi Last.fm dan Spotify; rekomendasi (artis/lagu,
  berdasarkan library, + filter); cari (artis/album/lagu/lirik/tag/
  video/channel video/playlist video) lewat semua sumber; video
  (YouTube, YouTube Music); lirik (+ anotasi) dari Genius dan MusixMatch;
  Discord Rich Presence.
- Sumber audio/video/metadata: Last.fm, Spotify, Deezer, Bandcamp,
  SoundCloud, YouTube, YouTube Music, Discogs, Genius, Musixmatch,
  MusicBrainz, Amazon Music, Audius, dan lain-lain.
- Gratis, tanpa iklan, tanpa login (login diperlukan untuk fitur
  tertentu saja).
- TIDAK ada fitur unduh — README menyatakan eksplisit: muffon dibuat
  untuk penemuan musik, tidak memakai akun premium layanan streaming,
  dan tidak punya fitur download.
- Versi 2.5.0 (27 Oktober 2026) menurut satu direktori sekunder; angka
  versi terbaru belum terverifikasi dari halaman rilis GitHub.

### Arsitektur yang diketahui

- Vue + Electron; electron-builder untuk packaging; CI/CD lewat GitHub
  Actions. Ada repo pendamping `muffon-api` (REST API untuk client).
- Logika pencocokan audio ke lagu yang diputar dipindahkan ke server
  (menurut catatan rilis).

### Keunggulan dan kelemahan

- Keunggulan: sumber terbanyak dalam riset ini (14+); EQ bawaan;
  rekomendasi berbasis library; multi-bahasa (12+ bahasa); tanpa iklan
  dan tanpa login untuk fungsi inti.
- Kelemahan: desktop saja; tanpa unduh; integrasi Spotify pernah rusak
  (issue #134); kualitas audio terbatas pada kualitas akun gratis
  layanan sumber; proyek komunitas dengan dukungan terbatas.

### Lisensi

AGPL-3.0 (menurut DeepWiki dari file LICENSE repo; belum diverifikasi
langsung dari file LICENSE).

### Pelajaran untuk Laras Web

- Pola "automatch" (mencocokkan audio dari satu sumber ke metadata lagu
  dari sumber lain) relevan bila Laras Web suatu hari memakai banyak
  sumber metadata.
- EQ + rekomendasi berbasis library lokal (tanpa server) adalah dua
  fitur yang bisa dibangun sepenuhnya di sisi client web — tanpa
  melanggar prinsip tanpa server.
- Sikap eksplisit soal unduh ("kami tidak punya fitur download karena
  alasan anti-pembajakan") adalah contoh positioning legal yang jujur;
  Laras Web perlu memutuskan dan menuliskan posisinya sendiri soal
  offline/unduh dengan sama terbukanya.

Sumber:

- https://github.com/staniel359/muffon/blob/HEAD/README.md
- https://github.com/staniel359/muffon/tree/v2.0.3
- https://deepwiki.com/staniel359/muffon
- https://www.softwareswave.com/muffon/

## 14. Wrapper Electron YouTube Music — th-ch / Pear Desktop dan ytmdesktop

Dua proyek open-source lama membungkus pemutar web resmi YouTube Music
di dalam shell desktop Electron dan menambah plugin. Bukan aplikasi web,
tetapi relevan karena mereka MEMBANGUN DI ATAS web player resmi — pola
yang berlawanan dengan Laras Web (membangun pemutar web sendiri).

- **th-ch/youtube-music** (MIT, 30.000+ bintang menurut satu sumber
  sekunder): Electron wrapper dengan framework plugin — puluhan plugin
  komunitas menambah lirik tersinkron, unduhan, pemblokir iklan, dan
  lain-lain. Menurut satu sumber, proyek ini kini berlanjut sebagai
  "Pear Desktop" (pear-devs). Status nama/proyek terbaru belum
  terverifikasi dari repo resmi.
- **ytmdesktop** (GPL-3.0): Electron wrapper dengan media key native,
  mini-player, Discord Rich Presence, dan remote control.
- Keduanya memakai sesi YouTube Music asli pengguna, sehingga semua
  konten akun terbawa — tetapi pengalaman tetap bergantung pada web
  player di bawahnya, dan fitur yang memodifikasi web player bisa rusak
  sementara saat Google mengubah antarmuka. Keduanya menghabiskan RAM
  ratusan MB (Electron).

Pelajaran untuk Laras Web: plugin lirik tersinkron th-ch adalah sumber
spesifikasi lirik yang bagus — plugin itu mendaftarkan provider
YTMusic, LRCLib, MusixMatch, dan LyricsGenius, dengan LRCLIB sebagai
sumber yang direkomendasikan (GET anonim, tanpa kunci, tanpa akun).
Pola "bungkus web resmi + tambah fitur" juga membuktikan ada pasar untuk
fitur yang tidak diberikan Google (lirik tersinkron, EQ, unduhan) —
pasar yang sama dengan yang dituju Laras Web, tetapi Laras Web
menjawabnya dengan pemutar sendiri, bukan wrapper.

Sumber:

- https://github.com/johnrijoy/youtube-music-thch
- https://www.simpmusic.org/blogs/youtube-music-desktop-app
- https://www.tutorialpedia.org/blog/download-youtube-music-pc/
- https://github.com/animeshkundu/youtube-audio/blob/HEAD/docs/research/12-youtube-music-features.md

## 15. Folia — pemutar web + PWA (lirik imersif)

Repo: https://github.com/chthollyphile/folia-major (AGPL-3.0). Pemutar
musik TypeScript yang berfokus pada lirik fullscreen imersif beranimasi.
Tersedia sebagai aplikasi Electron (Windows, macOS, Linux) DAN versi web
berbasis Node.js yang bisa di-deploy ke Vercel atau Cloudflare, diinstal
sebagai PWA di HP, atau di-host sendiri dengan Docker Compose. Terakhir
commit 15 November 2026 (aktif dirawat).

Sumber musik versi web: NetEase Cloud Music, Kugou, QQ Music, Navidrome,
dan file audio lokal; build desktop menambah Bodian Music, YouTube Music,
dan Spotify. Jadi YouTube Music HANYA ada di desktop, bukan di web.

Pelajaran untuk Laras Web: Folia membuktikan PWA lirik-imersif (layar
penuh, animasi) adalah arah desain yang hidup dan dirawat aktif — dan
menunjukkan batasnya: sumber YouTube Music sulit dibawa ke web (hanya
ada di desktop). Ini menegaskan kembali bahwa CORS/proxy adalah
pemisah antara fitur desktop dan fitur web.

Sumber:

- https://repolode.com/en/repo/chthollyphile/folia-major

## 16. Pola arsitektur web yang berulang

### 16.1 CORS adalah gerbang utama — proxy hampir selalu wajib

Fakta paling penting dari riset ini: dokumentasi youtubei.js menyatakan
tegas bahwa pemakaian di browser WAJIB mem-proxy request lewat server
sendiri, dengan contoh referensi proxy Deno dan contoh web Vite. Hal
yang sama berlaku untuk streaming: youtubei.js bisa mengubah data
streaming menjadi manifest MPEG-DASH, tetapi lagi-lagi request harus
lewat proxy server sendiri. Satu riset pihak ketiga menambahkan:
mode browser butuh proxy lewat backend sendiri untuk link media itu
sendiri (CORS + gate token PO untuk googlevideo dari IP client).

Tiga pola penyelesaian yang ditemukan di proyek nyata:

1. **Server proxy sendiri** — Musike (Fastify + yt-dlp + proxy Range),
   Decibel (server + yt-dlp). Kelebihan: kontrol penuh, seeking instan
   lewat Range. Kekurangan: pengguna harus menjalankan server; tidak
   cocok untuk "buka link langsung main".
2. **Backend serverless** — Cantio (Vercel + Fastify + youtubei.js),
   Vibentra (Vercel Edge + Express). Kelebihan: gratis dalam batas
   free-tier, tanpa server untuk dijalankan pengguna. Kekurangan:
   batasan runtime/durasi serverless, dan proxy byte audio lewat
   serverless bisa mahal/lambat — Cantio menghindarinya dengan IFrame
   untuk audio.
3. **IFrame Player API resmi** — Cantio untuk pemutaran. Kelebihan:
   tanpa proxy untuk audio, posisi ToS lebih aman. Kekurangan: tidak ada
   kontrol kualitas audio, tidak ada akses byte untuk EQ/visualizer,
   perilaku dikendalikan YouTube.

Implikasi untuk Laras Web: prinsip "tanpa server" dari APK TIDAK bisa
dipertahankan mentah-mentah di web untuk jalur InnerTube langsung.
Keputusan arsitektur yang harus diambil di Fase 1 (oleh tim arsitektur,
bukan dokumen ini): serverless tipis sebagai proxy (Vercel/Cloudflare
Functions, gratis) ATAU IFrame API sebagai jalur utama ATAU keduanya
sebagai fallback berlapis. Yang jelas dari riset: TIDAK ADA proyek yang
memutar audio InnerTube murni dari browser tanpa perantara.

Sumber:

- https://socket.dev/npm/package/youtubei.js/overview/5.2.1
- https://github.com/Imlokzu/blinkbot/blob/HEAD/Virtual%20Bot/docs/YOUTUBE-CLIENTS.md
- https://github.com/grepfs17/mixchat-yt-proxy/blob/HEAD/AGENTS.md

### 16.2 Stack frontend yang dominan

React + Vite + Tailwind adalah kombinasi yang dipakai Musike (React 19 +
Vite 8 + Tailwind 4), Cantio (React 18 + Vite + Tailwind), dan Vibentra.
Zustand dipakai Musike dan Cantio untuk state. Framer Motion / Motion
untuk animasi. Ini stack yang aman dan umum — bukan eksperimen.

### 16.3 Lirik: LRCLIB adalah jawaban standar

LRCLIB (https://lrclib.net) adalah database lirik gratis, terbuka,
berbasis kontribusi komunitas. Fakta yang terverifikasi:

- Tanpa kunci API dan tanpa akun untuk membaca.
- Mengembalikan `plainLyrics` dan `syncedLyrics` (LRC, satu baris per
  timestamp `[mm:ss.xx]`), plus `instrumental`, `duration`, `albumName`.
- Mengirim `Access-Control-Allow-Origin: *`, sehingga `fetch()` langsung
  dari browser berfungsi — TIDAK butuh proxy. Ini yang membuatnya
  berbeda dari InnerTube.
- Endpoint baca: `/api/get` (cocok persis: artis + judul + durasi) dan
  `/api/search` (cari bebas).
- Batas laju tergantung identifikasi client: klien generik ~45
  request/menit per IP, klien teridentifikasi ~90, klien terdaftar
  dengan `Lrclib-App-Id` ~180 per IP + allowance app ~6.000/menit
  (angka dari pengujian Oktober 2026 oleh cors.dev — sekunder, belum
  diverifikasi dari dokumentasi resmi LRCLIB). Browser tidak bisa
  menyetel header `User-Agent`, tetapi LRCLIB juga membaca
  `X-User-Agent`, `Lrclib-Client`, dan `lrclib-app-id`.
- Satu-satunya data yang dikirim adalah artis/judul/album — tanpa akun,
  tanpa cookie, tanpa token perangkat. Paling cocok dengan janji privasi
  Laras.
- Fallback statis: `https://api.lyrics.ovh/v1/<artis>/<judul>`
  mengembalikan JSON `lyrics` tanpa kunci, dengan CORS `*` juga.

Pelajaran: lirik tersinkron Laras Web bisa dibangun sepenuhnya
client-side (LRCLIB langsung + cache IndexedDB), tanpa server, tanpa
biaya, tanpa akun. Ini satu-satunya fitur besar yang bebas dari masalah
CORS/proxy.

Sumber:

- https://lrclib.net/docs
- https://cors.dev/guides/free-lyrics-api
- https://bytetools.bytevancer.com/public-apis/music/lrclib-api
- https://github.com/animeshkundu/youtube-audio/blob/HEAD/docs/research/12-youtube-music-features.md

### 16.4 Offline di web: Cache Storage + IndexedDB

Tidak satu pun pemutar web komersial (Spotify, YT Music) menawarkan
offline di web. Di proyek open-source, pola offline web yang muncul:

- Cache lagu yang sudah diputar secara otomatis (pola ViMusic di
  Android; padanan web: Cache Storage API atau IndexedDB untuk blob
  audio).
- Cache lirik per lagu (satu dokumen teknologi menyebut hasil lirik
  di-cache agar tiap lagu hanya di-fetch sekali).
- PWA + Service Worker untuk shell aplikasi offline (instalasi,
  pembukaan tanpa internet); audio offline tetap butuh penyimpanan blob
  yang eksplisit.
- Catatan: audio dari IFrame Player API TIDAK bisa di-cache offline
  (byte tidak bisa diakses). Offline audio sejati hanya mungkin pada
  jalur InnerTube langsung + proxy, dengan blob disimpan ke IndexedDB/
  Cache Storage. Ini trade-off arsitektur yang harus dicatat: pilih
  IFrame (tanpa proxy, tanpa offline) atau pilih InnerTube + proxy
  (dengan offline).

### 16.5 Media Session API + Web Audio

- Media Session API (`navigator.mediaSession`) adalah standar untuk
  kontrol lock screen/headset/tombol media — dipakai YT Music web,
  Musike, dan diharapkan di semua pemutar web.
- EQ asli hanya mungkin bila aplikasi memegang elemen `<audio>`/`<video>`
  sendiri dan bisa memasang graph Web Audio (`createMediaElementSource`
  + filter biquad). Ini BERHASIL untuk stream same-origin atau
  CORS-enabled, dan GAGAL untuk audio DRM Spotify (decoder tersandbox)
  serta untuk IFrame YouTube (byte tidak terekspos). Feishin (EQ
  parametrik), Muffon (EQ), dan Vibentra (EQ 10 band) membuktikan EQ
  adalah fitur pemutar yang nyata dan diharapkan.
- Normalisasi loudness (ReplayGain) adalah pendamping EQ yang disebut
  Feishin dan riset fitur YT Music.

### 16.6 Tanpa login, tanpa telemetri adalah norma ekosistem

Musike, Cantio (mode tamu), Nuclear, Muffon, dan Spotube semuanya
menawarkan fungsi inti tanpa akun dan menyatakan tanpa telemetri/iklan.
Laras Web tidak perlu membuktikan pola ini — pola ini sudah menjadi
ekspektasi pengguna kategori ini. Yang membedakan adalah eksekusi dan
kelengkapan fitur.

## 17. Tabel perbandingan

Keterangan: ✅ = ada, ❌ = tidak ada, ◐ = sebagian/terbatas,
— = tidak berlaku / tidak ada versi web. "Web" berarti bisa dibuka di
browser sebagai aplikasi web/PWA (bukan streaming desktop lewat Docker).

| Aspek | Spotify Web | YT Music web | InnerTune | OuterTune | ViMusic | Spotube | Musike | Cantio | Decibel | Vibentra | Feishin | Nuclear | Muffon |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Ada versi web/PWA | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Platform utama | Browser | Browser | Android | Android | Android | Android/Desktop/iOS | Browser/PWA/Desktop/Mobile | Browser/PWA/Desktop | Web/PWA/Android/Desktop | Web/PWA/Android | Web/Desktop | Desktop | Desktop |
| Putar | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Cari | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Jelajah | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Perpustakaan | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | blm. terverifikasi | ✅ | ✅ | ✅ |
| Playlist | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | blm. terverifikasi | blm. terverifikasi | ✅ | ✅ | ✅ |
| Antrean | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | blm. terverifikasi | ✅ | ✅ | ✅ | ✅ |
| Offline audio | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ❌ | blm. terverifikasi | blm. terverifikasi | blm. terverifikasi | blm. terverifikasi | ❌ | ◐ (cache) |
| Lirik | ✅ tersinkron | ◐ statis di web | ✅ tersinkron | ✅ kata per kata | ✅ tersinkron | ✅ tersinkron | ❌ | ✅ tersinkron | blm. terverifikasi | blm. terverifikasi | ✅ tersinkron | ✅ tersinkron | ✅ (+ anotasi) |
| EQ | ❌ | ❌ | ❌ | ❌ | ❌ | blm. terverifikasi | ❌ | ❌ | blm. terverifikasi | ✅ 10 band | ✅ parametrik | ❌ | ✅ |
| Pemutar file lokal | ❌ (web) | ❌ | ❌ | ✅ | ❌ | ✅ | ❌ | ❌ | ✅ (via server) | ❌ | ✅ (via server) | ❌ | ❌ |
| Login wajib | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | blm. terverifikasi | ✅ (server) | ❌ | ❌ |
| Tanpa iklan | ❌ (Free) | ❌ (Free) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Butuh server sendiri | — | — | — | — | — | — | ✅ | ❌ (Vercel) | ✅ | ✅ | ✅ | — | — |
| Framework web | blm. terverifikasi | blm. terverifikasi | — | — | — | — | React 19 + Vite | React 18 + Vite | blm. terverifikasi | React + Capacitor | TypeScript + Electron | React + Tauri | Vue + Electron |
| Cara ambil audio | Web Playback SDK + Widevine | InnerTube WEB_REMIX | InnerTube | InnerTube | InnerTube | Plugin/NewPipe | yt-dlp + proxy | IFrame API | yt-dlp + proxy | Backend Express | Server sendiri | Plugin | Multi-sumber |
| Cara atasi CORS | — (resmi) | — (resmi) | — (native) | — (native) | — (native) | — (native) | Proxy server | IFrame + backend | Proxy server | Backend | — (server sendiri) | — (native) | — (native) |
| Lisensi | Proprietary | Proprietary | GPL-3.0 | GPL-3.0 | GPL-3.0 | AGPL-3.0 | MIT | MIT | MIT | MIT | GPL-3.0 / MIT * | AGPL-3.0 | AGPL-3.0 |
| Status | Aktif | Aktif | Jalan pelan | Berhenti (YTM) | Diarsipkan | Aktif | Aktif (baru) | Aktif (baru) | Aktif (baru) | Aktif (baru) | Aktif | Aktif | Aktif |

\* Lisensi Feishin bertentangan antar sumber (GPL-3.0 vs MIT) — belum
terverifikasi dari file LICENSE repo.

Catatan tabel: kolom InnerTune/OuterTune/ViMusic/Spotube diisi dari
riset APK 15 November 2026 untuk fitur Android-nya; baris "Ada versi
web/PWA" adalah temuan riset web ini (tidak ada). "blm. terverifikasi"
berarti fitur tidak disebut dalam sumber yang berhasil dibuka — bukan
bukti fitur tidak ada.

## 18. Rekomendasi: 5 fitur pembeda Laras Web

Dipilih berdasarkan tiga saringan: (1) tidak dimiliki Spotify Web
Player DAN YouTube Music web, (2) tidak dimiliki atau lemah di
kompetitor PWA terdekat (Musike, Cantio), (3) bisa dibangun dengan
budget nol rupiah dan selaras dengan prinsip Laras (tanpa login, tanpa
iklan, tanpa telemetri).

### Pembeda 1 — Offline audio sejati di browser (putar tanpa internet)

Tidak satu pun pemutar web komersial memilikinya, dan tidak satu pun
PWA kompetitor mendokumentasikannya. Laras Web menyimpan lagu yang
sudah diputar secara otomatis ke IndexedDB/Cache Storage (pola cache
otomatis ViMusic), ditambah tombol unduh eksplisit per lagu/playlist.
Saat offline, library yang tersimpan tetap bisa diputar penuh — bukan
sekadar shell aplikasi yang terbuka. Ini pembeda paling kuat karena
menyelesaikan masalah nyata (internet putus, kuota habis, perjalanan)
yang tidak bisa dijawab Spotify Web Player atau YT Music web.

### Pembeda 2 — Lirik tersinkron tanpa batas, gratis, langsung di browser

YouTube Music membatasi lirik untuk pengguna gratis dan hanya
menampilkan lirik statis di web; Musike tidak punya lirik sama sekali.
Laras Web memakai LRCLIB langsung dari browser (tanpa proxy, tanpa
kunci, tanpa akun) + cache IndexedDB, dengan tampilan lirik yang
mengikuti lagu baris demi baris dan ketuk-baris-untuk-loncat. Target
kualitas: setara lirik kata per kata OuterTune dan lirik + terjemahan
Nuclear, tetapi tanpa login dan tanpa batas jumlah lagu.

### Pembeda 3 — Equalizer + normalisasi loudness yang benar-benar bekerja

Tidak ada di Spotify Web Player (mustahil karena DRM) dan tidak ada di
YouTube Music web. Di PWA kompetitor, hanya Vibentra yang mengklaimnya
(belum terverifikasi). Laras Web membangun EQ grafis (10 band, preset
+ profil) dan normalisasi loudness di atas Web Audio graph — mungkin
dilakukan karena Laras memegang elemen audio sendiri (jalur InnerTube),
bukan IFrame atau DRM. Ini pembeda yang langsung terdengar dan tidak
bisa ditiru oleh pemutar berbasis DRM/IFrame.

### Pembeda 4 — Buka link langsung main, tanpa server untuk dijalankan pengguna

Musike dan Decibel mewajibkan pengguna menjalankan server/Docker;
Feishin/Navidrome mewajibkan server + koleksi file. Cantio membuktikan
PWA bisa langsung dibuka (Vercel serverless + IFrame). Laras Web
menargetkan pengalaman yang sama — buka URL, cari lagu, langsung
terdengar — tanpa instalasi, tanpa akun, tanpa server yang harus
dijalankan pengguna. Sisi teknisnya (proxy serverless tipis gratis
dan/atau IFrame sebagai fallback) adalah keputusan arsitektur Fase 1,
tetapi dari sudut pengguna janjinya sederhana: tidak ada yang perlu
diinstal atau dijalankan.

### Pembeda 5 — Satu antrean untuk streaming + file lokal pengguna

OuterTune membuktikan nilai pola ini di Android; belum ada PWA
kompetitor yang menerapkannya di web. Laras Web memutar file audio
milik pengguna (MP3, OGG, FLAC, dan format lain yang didukung browser)
lewat File API — file dibaca lokal di perangkat, TIDAK diunggah ke
server mana pun — dan menempatkannya dalam antrean yang sama dengan
lagu streaming. Ditambah impor playlist (format umum) dan ekspor/
impor library berbasis file (pola `library.json` Musike), pengguna
tidak pernah terkunci: library mereka adalah file mereka.

## 19. Catatan risiko dan batas riset

- Proyek PWA pesaing (Musike, Decibel, Vibentra) semuanya dibuat pada
  Oktober–November 2026 — sangat muda. Status, fitur, dan kelangsungan
  mereka bisa berubah cepat. Angka bintang dan rilis di dokumen ini
  hanya berlaku pada tanggal cek.
- Klaim dari situs direktori sekunder (versi rilis, jumlah bintang
  agregator) dicatat apa adanya dan ditandai bila bertentangan.
  Keputusan yang bergantung pada angka-angka itu perlu verifikasi ulang
  dari repo resmi saat dipakai.
- Isu ToS YouTube sama dengan yang dibahas riset APK: akses InnerTube
  tidak resmi melanggar Terms of Service YouTube; IFrame Player API
  adalah satu-satunya jalur pemutaran yang berada di dalam ToS.
  Dokumen ini bukan nasihat hukum.
- Lisensi Feishin (GPL-3.0 vs MIT) dan lisensi Muffon (AGPL-3.0 dari
  sumber sekunder) belum terverifikasi dari file LICENSE repo
  masing-masing.

## Daftar sumber

Sumber primer (README/repo resmi yang dibuka langsung):

- https://github.com/Ernani1234/musike
- https://github.com/akshay-k-a-dev/cantio/blob/HEAD/README.md
- https://github.com/nukeop/nuclear
- https://github.com/staniel359/muffon/blob/HEAD/README.md
- https://github.com/EduardGilM/Decibel
- https://github.com/srivatsan2007/vibentra/blob/HEAD/README.md
- https://github.com/animeshkundu/youtube-audio/blob/HEAD/docs/research/12-youtube-music-features.md
- https://github.com/yaniv3487/spotiamp/blob/HEAD/CLAUDE.md
- https://github.com/vossjona/buzz/blob/HEAD/docs/MUSIC-PROVIDER-RESEARCH.md
- https://github.com/Imlokzu/blinkbot/blob/HEAD/Virtual%20Bot/docs/YOUTUBE-CLIENTS.md
- https://github.com/grepfs17/mixchat-yt-proxy/blob/HEAD/AGENTS.md
- https://github.com/johnrijoy/youtube-music-thch
- https://lrclib.net/docs

Sumber sekunder dan direktori:

- https://umatechnology.org/spotify-web-player-how-to-use-and-access-it/
- https://sekin.in/spotify-web-player-how-to-use-and-access-it/
- https://www.slpotify.com/news/spotify-web-player-login.html
- https://guides.emudesk.com/spotify-on-pc-guide-2026/
- https://www.audfun.com/spotify/spotify-web-player-vs-desktop.html
- https://deus-soft.com/blog/spotify-protected-content/
- https://www.viwizard.com/youtube-music-tips/youtube-music-lyrics.html
- https://umatechnology.org/what-is-youtube-music-everything-you-need-to-know/
- https://www.simpmusic.org/blogs/youtube-music-desktop-app
- https://www.drmare.com/audio-recorder/youtube-music-to-desktop.html
- https://www.tutorialpedia.org/blog/download-youtube-music-pc/
- https://outertune.com.in/
- https://h5.2113.net/apps/outertune.html
- https://rajendra7169.github.io/blazify/compare/
- https://vimusicapk.com/what-platforms-is-the-vimusic-app-available-on/
- https://vimusicapk.com/vimusic-app-compatibility-unleashing-music-across-devices/
- http://gitdiagram.com/vaginessa/vitune
- https://hub.docker.com/r/linuxserver/spotube
- https://git.opnkty.uk/kitty/spotube
- https://dev.to/itxtayab/musike-a-free-open-source-music-player-for-youtube-music-with-no-ads-and-no-account-6fo
- https://feishin.net/
- https://www.feishin.com/
- https://enlisted.directory/alternatives/youtube-music
- https://repocloud.io/results/?searchAppsForm=&category=Music&explore=
- https://docs.alexlebens.dev/Applications/cl01tl/navidrome/
- https://freeinsteadof.com/blog/open-source-music-app
- https://www.ithub.directory/media-players-streaming/nuclear
- https://appsgit.com/desktop-apps/nuclear
- https://deepwiki.com/staniel359/muffon
- https://www.softwareswave.com/muffon/
- https://repolode.com/en/repo/chthollyphile/folia-major
- https://socket.dev/npm/package/youtubei.js/overview/5.2.1
- https://cors.dev/guides/free-lyrics-api
- https://bytetools.bytevancer.com/public-apis/music/lrclib-api

Rujukan internal:

- ~/workspace/music-app/docs/riset-kompetitor.md (riset APK, 15 Nov 2026)
