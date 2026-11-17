# Laras (Web)

Pemutar musik web yang gratis, tanpa iklan, dan bisa dipakai offline.

Laras Web memutar lagu dari YouTube dan YouTube Music langsung di browser. Lagu yang kamu unduh tersimpan di perangkat dan bisa diputar tanpa internet. Tidak ada akun wajib, tidak ada iklan, tidak ada pelacak.

[English version](#english)

> **Status:** versi web sedang dikembangkan. Yang sudah jalan saat ini adalah fondasi P0: halaman beranda, tema hitam, dan pipa build + tes. Fitur di bawah ini adalah rencana v1, dikerjakan paket demi paket.

Versi Android (Flutter) ada di repo terpisah: [adiprmx/laras](https://github.com/adiprmx/laras).

## Fitur (rencana v1)

- Cari lagu dari YouTube Music tanpa login, dengan saran saat mengetik dan riwayat pencarian.
- Cari di Library-mu sendiri, termasuk saat offline.
- Putar lagu lewat internet, atau unduh dulu lalu putar tanpa internet.
- Unduhan bisa dijeda dan dilanjutkan, dengan pilihan kualitas dan pilihan unduh WiFi saja.
- Lagu yang pernah diputar bisa diputar lagi tanpa internet, sampai batas ruang yang kamu atur.
- Library, playlist, favorit, dan riwayat putar, semuanya tersimpan di perangkat.
- Antrean putar kembali seperti semula setelah tab ditutup.
- Lirik tersinkron dan lirik biasa, dari LRCLIB.
- Sleep timer, kecepatan dan nada putar.
- Salinan data dalam satu file, bisa dipulihkan di perangkat lain.
- Impor playlist Spotify dari file milikmu, tanpa API Spotify dan tanpa login.
- Bisa dipasang sebagai app (PWA) dan dipakai offline.

## Cara pakai

Buka [laras.adipmusic.my.id](https://laras.adipmusic.my.id) di browser. Tidak perlu pasang apa pun. Untuk dipakai offline, pasang sebagai app lewat menu browser (Tambah ke layar beranda / Install app).

## Bukan produk resmi

Laras adalah client tidak resmi. Laras bukan produk YouTube atau Google, dan tidak berafiliasi dengan keduanya.

Laras memakai akses tidak resmi ke layanan YouTube dan YouTube Music. Cara ini melanggar ketentuan layanan YouTube. YouTube bisa mengubah layanannya kapan saja tanpa pemberitahuan, dan perubahan itu bisa membuat Laras berhenti berfungsi sebagian atau seluruhnya. Lagu yang sudah diunduh tetap bisa diputar bila itu terjadi.

Nama dan logo YouTube adalah milik Google. Laras tidak memakai nama, logo, atau merek YouTube atau Spotify di nama app, ikon, atau judul.

Suka lagu yang kamu dengar? Dukung artisnya dengan mendengarkan di layanan resmi atau membeli karyanya.

## Privasi

- Laras tidak mengumpulkan data pengguna. Tidak ada akun wajib, tidak ada telemetri, tidak ada pelacak.
- Semua data app (library, playlist, favorit, riwayat, antrean, pengaturan, unduhan) tersimpan lokal di perangkat. Data itu tidak dikirim ke server milik app.
- Akun opsional (login Google/GitHub) hanya dipakai untuk sinkronisasi antar perangkat, bila kamu mengaktifkannya. Tanpa akun, semua fitur putar tetap jalan.
- Saat app dipakai, pihak ketiga menerima sebagian data: Google dan YouTube menerima alamat IP, kueri pencarian, dan permintaan stream; LRCLIB menerima alamat IP dan judul, artis, dan durasi lagu saat kamu membuka lirik; GitHub menerima alamat IP saat app memeriksa pembaruan konfigurasi; Cloudflare menerima alamat IP saat app memuat halaman (hosting statis).
- Pengguna bisa menghapus semua data dari dalam app.

Kebijakan privasi lengkap menyusul di `PRIVACY_POLICY.md` (P10).

## Cara build dari source

Prasyarat: Node.js 24 (versi yang dipakai CI; lihat `.github/workflows/ci.yml`).

```sh
git clone https://github.com/adiprmx/laras-web.git
cd laras-web/app
npm ci
npm run dev
```

Build produksi:

```sh
npm run build
```

Target ukuran: bundle JavaScript awal maks 200 KB (gzip). CI memeriksa batas itu pada setiap build.

## Cara kontribusi

Baca [CONTRIBUTING.md](CONTRIBUTING.md) sebelum mengirim pull request. Kode perilaku kontributor ada di [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Laporan keamanan mengikuti [SECURITY.md](SECURITY.md).

## Lisensi

Laras dilisensikan di bawah GNU General Public License v3.0 only (GPL-3.0-only). Lihat [LICENSE](LICENSE) untuk teks lengkapnya.

---

<a id="english"></a>

# Laras Web (English)

A free web music player with no ads that works offline.

Laras Web plays music from YouTube and YouTube Music right in your browser. Songs you download stay on your device and play without internet. No account required, no ads, no trackers.

> **Status:** the web version is under active development. What works today is the P0 foundation: the home page, the black theme, and the build + test pipeline. The features below are the v1 plan, built package by package.

The Android version (Flutter) lives in a separate repo: [adiprmx/laras](https://github.com/adiprmx/laras).

## Features (v1 plan)

- Search YouTube Music without logging in, with suggestions as you type and search history.
- Search your own Library, including offline.
- Stream songs, or download them first and play them without internet.
- Downloads can pause and resume, with quality choices and a WiFi-only option.
- Songs you have played before can play again offline, up to the space limit you set.
- Library, playlists, favorites, and play history, all stored on your device.
- The play queue comes back as it was after the tab is closed.
- Synced and plain lyrics, from LRCLIB.
- Sleep timer, playback speed and pitch.
- Backup of your data in one file, restorable on another device.
- Spotify playlist import from your own file, without any Spotify API and without logging in.
- Installable as an app (PWA) and usable offline.

## How to use

Open [laras.adipmusic.my.id](https://laras.adipmusic.my.id) in your browser. Nothing to install. To use it offline, install it as an app from your browser menu (Add to home screen / Install app).

## Not an official product

Laras is an unofficial client. It is not a YouTube or Google product, and it is not affiliated with either.

Laras uses unofficial access to YouTube and YouTube Music services. This violates YouTube's terms of service. YouTube can change its service at any time without notice, and such a change can partly or fully break Laras. Downloaded songs keep playing if that happens.

YouTube names and logos belong to Google. Laras does not use YouTube or Spotify names, logos, or brands in the app name, icon, or title.

Like a song you hear? Support the artist by listening on an official service or buying their work.

## Privacy

- Laras collects no user data. No required account, no telemetry, no trackers.
- All app data (library, playlists, favorites, history, queue, settings, downloads) stays on your device. None of it goes to an app server.
- An optional account (Google/GitHub login) is only used for syncing across devices, if you turn it on. Without an account, all playback features still work.
- While you use the app, third parties receive some data: Google and YouTube receive your IP address, search queries, and stream requests; LRCLIB receives your IP address and the title, artist, and duration of a song when you open its lyrics; GitHub receives your IP address when the app checks for config updates; Cloudflare receives your IP address when the app loads the page (static hosting).
- You can delete all data from inside the app.

The full privacy policy follows in `PRIVACY_POLICY.md` (P10).

## Build from source

Prerequisite: Node.js 24 (the version CI uses; see `.github/workflows/ci.yml`).

```sh
git clone https://github.com/adiprmx/laras-web.git
cd laras-web/app
npm ci
npm run dev
```

Production build:

```sh
npm run build
```

Size target: initial JavaScript bundle max 200 KB (gzip). CI checks that limit on every build.

## Contribute

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. The contributor code of conduct is in [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Security reports follow [SECURITY.md](SECURITY.md).

## License

Laras is licensed under the GNU General Public License v3.0 only (GPL-3.0-only). See [LICENSE](LICENSE) for the full text.
