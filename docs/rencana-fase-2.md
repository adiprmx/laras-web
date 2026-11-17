# Rencana Fase 2: Build Laras Web

**Tanggal tulis:** 17 November 2026.
**Status:** Fase 1 selesai untuk dokumen ini. Build dimulai setelah dokumen ini dibaca dan repo dibuat.
**Dokumen acuan:** `docs/prd-v1.md`, `docs/arsitektur.md`, `docs/riset-kompetitor-web.md`, `docs/transfer-ekstraktor.md`, `docs/keputusan-solver.md`, `docs/roster-tim.md`.

## Keputusan yang sudah diputuskan (dibawa dari Fase 1)

- **Nama app:** Laras (sama dengan APK). **Repo:** `adiprmx/laras-web` (publik, diputuskan koordinator). **Lisensi:** GPL-3.0-only (selaras APK). **Domain produksi:** USULAN `laras.adipmusic.my.id` — menunggu parent/owner.
- **Stack:** Cloudflare Pages + Workers + D1 + KV baca (satu vendor, tanpa kartu, reset kuota harian). Cadangan: Vercel Hobby + Supabase organisasi kedua, hanya bila pemicu terpenuhi.
- **Frontend:** React + Vite + TypeScript + Tailwind + Zustand. PWA (Service Worker + manifest). Anggaran bundle awal maks 200 KB gzip (arsitektur menang atas USULAN 1 MB di PRD).
- **Solver signature:** DI BROWSER — QuickJS-WASM di Web Worker khusus (port dari APK). Worker hanya proxy CORS/config byte-only bila spike S2 membuktikan fetch langsung diblokir. Solver di server DILARANG (platform Workers melarang eval; CPU free-tier tidak cukup).
- **Config remote:** pakai ulang `config-v1` repo `adiprmx/laras` (satu control plane untuk APK dan web).
- **Akun:** opsional, OAuth Google/GitHub saja, tanpa kata sandi; sinkronisasi D1 last-write-wins + tombstone. Login TIDAK PERNAH wajib untuk memutar lagu.
- **EQ:** graph Web Audio masuk Must (fondasi pemutar); kontrol EQ 10 band Should prioritas tertinggi, aktif penuh hanya bila spike S5 membuktikan googlevideo mengirim header CORS (bila tidak, EQ hanya untuk audio lokal/cache).
- **Penomoran:** 0.9.x untuk build uji, v1.0.0 rilis publik pertama.
- **Tanpa server berbayar, tanpa akun wajib, tanpa telemetri, tanpa iklan, tanpa pembayaran di v1.** Tanpa API Spotify dalam bentuk apa pun (permanen).

## Urutan paket kerja (P0-P10, memetakan milestone M0-M10 di PRD)

Aturan yang mengikat: scope freeze setelah P4; login tidak boleh menyelinap lewat P3 atau P8; tiap paket diakhiri preview live yang bisa owner nilai (paket tanpa preview yang bisa diuji owner dianggap belum selesai); tim bekerja BERGILIRAN per paket, bukan serentak; tidak ada tanggal (estimasi waktu tanpa bukti build pertama adalah tebakan; ukuran paket dinyatakan relatif di bagian akhir).

### P0. Fondasi repo

- Tim: A1, A2, A30, A21, A22, C13, D1.
- Buat repo publik `adiprmx/laras-web` (main branch, README, LICENSE GPL-3.0-only, CONTRIBUTING, SECURITY, .gitignore, CHANGELOG).
- Skeleton React + Vite + TypeScript + Tailwind + Zustand: struktur folder (src/features, src/core, src/data, src/player, src/extractor, src/workers), token desain (hitam murni #000000 + aksen putih), pemisahan string sejak awal, `tsc` + lint bersih.
- CI dasar (bagian CI) hijau di push pertama. Preview deploy Cloudflare Pages jalan (URL preview per push).
- Mirror repo cadangan ke forge kedua saat rilis pertama (mengikuti APK).
- **Kriteria selesai:** repo publik + CI hijau + preview skeleton bisa dibuka owner di browser.

### P1. Spike ekstraksi web (gate go atau no-go)

- Tim: A13, A7, A6, A11, A17, A5, A16, A14, A15, A29, A26, C18.
- 10 spike arsitektur bagian 8 (S1 QuickJS-WASM ketiga hash; S2 vonis CORS final; S3 pemutaran `<audio>` + MediaSession; S4 port `buildPlayerScript` ke TypeScript; S5 Web Audio CORS; S6 cache media opaque + Range; S7 proxy byte-only CPU di bawah 10 ms; S8 sync D1; S9 PWA + audio latar Android Chrome dan iOS Safari; S10 LRCLIB dari browser). Tiap spike punya kriteria lolos terukur dan jalur cadangan bila gagal (S6 gagal berarti v1 hanya unduhan eksplisit; S8 gagal berarti sync pindah ke pasca-v1).
- **Gate:** bila spike inti (S1, S3, S4) gagal tanpa cadangan yang terbukti, proyek berhenti dan koordinator melapor ke parent dengan bukti — tidak ada komitmen buta.
- **Kriteria selesai:** 10 spike diputuskan (lolos atau cadangan dipilih dengan bukti); preview memutar 5 lagu kanari dari YouTube Music sampai habis.

### P2. Player core (bisa paralel dengan P1 setelah interface port pemutar disepakati)

- Tim: A6, B6, B7, B9, B10, A3, A10, C2.
- Port pemutar milik app (interface, bukan panggilan elemen audio langsung dari komponen), elemen `<audio>` + graph Web Audio, MediaSession, notifikasi media browser, antrean 200 item, shuffle, repeat, kecepatan, re-resolve tengah lagu (pelajaran dinding googlevideo 1 MiB).
- **Kriteria selesai:** preview memutar lagu, jeda, lanjut, next, prev, dengan MediaSession benar di lock screen HP.

### P3. Database dan library

- Tim: A16, A17, A3, B11, B12, B13, B4 (pencarian lokal).
- IndexedDB: port 15 tabel APK + 3 store tambahan (token_index, playback_state, app_meta), migrasi berversi, library (lagu, album, artis), playlist, favorit, riwayat putar, pencarian lokal via indeks token, pagination 50 per halaman.
- **Kriteria selesai:** preview menyimpan 1.000 lagu contoh, pencarian lokal jalan, playlist bisa dibuat dan diedit, antrean utuh setelah browser ditutup lalu dibuka lagi.

### P4. Pencarian dan browse

- Tim: B4, B5, B1, B2, B3, A13, A12.
- Pencarian YTM (hanya saat kueri dikirim eksplisit), saran pencarian, riwayat 100 query, beranda (6 seksi), Jelajah dari browse YTM, rumus "Lagu untukmu" lokal.
- **Scope freeze setelah paket ini.**
- **Kriteria selesai:** preview mencari lagu, menampilkan beranda, dan membuka hasil browse; Red 1 keamanan jalan setelah paket ini.

### P5. Unduhan dan offline

- Tim: B16, B17, B18, A5, A17, A7.
- Download jobs (serial 1 file, resume Range, retry 3 kali), kualitas unduhan 3 opsi, Service Worker + Cache Storage (bila S6 lolos; bila tidak, hanya unduhan eksplisit), layar Penyimpanan, rekonsiliasi saat start, PWA bisa dipasang.
- **Kriteria selesai:** preview mengunduh 10 lagu, memutar semuanya tanpa internet (K8), dan eviction tidak menghapus unduhan (K9).

### P6. Ketahanan

- Tim: A13, A11, A23, B21 (bagian Pengaturan), C7.
- Config remote (pakai ulang config-v1, TTL 6 jam), deteksi kanari (cek sekali sehari di latar), klasifikasi error 6 penyebab, banner status 3 tingkat, tombol "Periksa pembaruan", kode diagnostik LRS1 + snapshot pemutar (menutup celah APK: snapshot kegagalan engine).
- **Kriteria selesai:** matikan client utama di config, 10 lagu tetap jalan tanpa error terlihat (K6); ubah entri config, app mengambil dalam 6 jam (K7).

### P7. Fitur Should

- Tim: B19, B22, B23, B24, B25, A14, A15, A16.
- Lirik LRCLIB tersinkron (cache lokal + atribusi persisten), EQ 10 band (sesuai vonis S5), sleep timer (preset + akhir-lagu, pause saat habis), akun opsional OAuth + sinkronisasi D1 (bila S8 lolos; bila tidak, pindah ke pasca-v1 dan backup file tetap jadi jalan pindah perangkat).
- **Kriteria selesai:** lirik tersinkron tampil untuk lagu yang punya lirik; sleep timer menjeda sesuai PRD; dua perangkat sinkron playlist/favorit/riwayat (bila sync masuk v1).

### P8. Backup dan ekspor

- Tim: B25, B15, B21, C7, C8.
- Backup JSON berversi (format kompatibel APK, backupVersion, batas 10 MB), impor merge satu transaksi, hapus semua data (2 konfirmasi + tombol "Simpan salinan dulu"), impor Spotify tanpa API (jalur file utama, jalur tautan publik maks 30 lagu — port bukti APK).
- **Kriteria selesai:** ekspor backup, hapus data, impor kembali, library dan playlist pulih utuh; impor playlist Spotify dari file dan dari tautan publik jalan.

### P9. Keamanan (Red-Blue-Red)

- Tim: A19 (Red), A18 (Blue), A20 (Purple), C10, C9, D5, D22.
- Red 1 setelah P4, Red 2 setelah P5 dan P6, Red 3 di release candidate + Red fokus sesudah tiap Blue bila perlu. Kerangka OWASP (web: ASVS + WSTG; port kontrol APK: allowlist URL, cap respons, timeout, CSP, CSRF, cookie HttpOnly). Berhenti di nol temuan kritis, tinggi, sedang; maks 5 ronde.
- **Kriteria selesai:** nol temuan kritis, tinggi, dan sedang (K12).

### P10. Rilis v1.0.0

- Tim: C19, C7, C8, C5, C13, C14, D11, D13, D14, A21, D1.
- Dokumen rilis (README, PRIVACY_POLICY.md dengan kanal kontak adiprmx@gmail.com + menyebut LRCLIB, CHANGELOG), situs live di domain produksi (menunggu keputusan domain), PWA terverifikasi (skor Lighthouse PWA), GitHub Release v1.0.0 dengan checksum, pengajuan direktori aplikasi web dan open source.
- Verifikasi K1-K15 lengkap sebelum rilis.
- **Kriteria selesai:** owner menyetujui situs rilis setelah mencoba sendiri (gate terakhir PRD).

### Tim yang TIDAK ditugaskan di Fase 2 (pasca-v1)

B8 Radio/Autoplay (Could), B14 Playlist berbagi dan kolaboratif (Won't v1), B20 Terjemahan lirik (Won't v1), C11 AI dan Otomasi (tanpa ML di v1; rekomendasi memakai rumus lokal), C12 Lokalisasi (v1 hanya Bahasa Indonesia). Pengecualian: perilaku "Putar Berikutnya" B8 masuk lewat B9 (antrean) sebagai bagian v1. Tim D lainnya (D2-D10, D12, D15-D23) aktif pasca-rilis, kecuali yang disebut di P10.

## Repo (publik, diputuskan)

- **Publik.** Alasan: selaras APK (GPL-3.0-only mewajibkan source tersedia); copyleft GPL adalah perlindungan terhadap pencurian source (fork wajib share-alike); kepercayaan komunitas.
- **Mirror cadangan** ke forge kedua saat rilis pertama (mitigasi takedown).
- **Branch:** main sebagai satu-satunya branch kerja di awal; tag `v0.9.x` dan `v1.0.0` untuk rilis. Preview deploy per push dari main (Cloudflare Pages).
- **Secrets:** token Cloudflare, secret OAuth, dan secret apa pun TIDAK PERNAH masuk repo; secrets di Cloudflare dashboard + GitHub Actions secrets; tidak ada secret di kode atau di file yang ter-commit (cek dengan skill check_secrets_before_push sebelum tiap push).

## CI GitHub Actions

- **Workflow `ci.yml` (setiap push dan pull request):** checkout, setup Node (versi dipin), `npm ci`, `tsc --noEmit`, lint (gagal bila ada warning), tes unit + integrasi (Vitest), build (gagal bila bundle awal di atas 200 KB gzip), tes E2E Playwright (Chromium), audit Lighthouse (PWA + performa, ambang di PRD K2), upload preview sebagai artifact.
- **Workflow deploy (push ke main):** deploy ke Cloudflare Pages (produksi) + Workers (proxy/config/sync) via Wrangler; D1 migrasi otomatis; KV config publish bila berubah.
- **Workflow `release.yml` (saat tag `v*` dibuat):** build produksi, hitung checksum SHA-256, buat GitHub Release dengan CHANGELOG dan checksum.
- **Cache:** npm cache dan Playwright browser cache diaktifkan supaya build tidak mengunduh ulang tiap kali.
- **Node version pin:** versi Node dipin di workflow; bump versi adalah perubahan yang disengaja, bukan otomatis.

## Strategi tes

- **Typecheck + lint:** `tsc --noEmit` dan lint tanpa warning di CI (K13). Warning sama dengan gagal.
- **Unit test (Vitest):** logika murni (pemilih itag, rumus skor "lagu untukmu", klasifikasi error, merge backup, migrasi backup, LRU eviction, port solver: kasus Vm, helper builtin String, delimiter tabel, kelas URL tf/bs/JH). Target: semua fungsi murni punya tes.
- **Integration test:** alur resolve end-to-end terhadap fixture base.js asli ketiga hash; sync D1 dua perangkat (simulasi).
- **E2E Playwright:** alur ujung ke ujung J1-J7 (cari dan putar, unduh lalu offline, buat playlist, lanjutkan setelah tutup browser, hadapi kerusakan, pasang PWA, sinkronisasi opsional) di Chromium desktop + emulasi HP; tiap paket menambah tes E2E untuk fiturnya.
- **Screenshot per layar:** layar utama dipotret di 2 ukuran (360 px dan desktop 1440 px) tiap rilis; owner memeriksa hasil potret sebelum menyetujui rilis. Klaim "sudah fix" wajib bukti screenshot gejala nyata, bukan bacaan kode.
- **Perangkat dan browser nyata:** uji di Chrome Android, Safari iOS (batas audio latar), Firefox desktop; uji stress 10.000 lagu (K11); uji pasang PWA dari nol.
- **Uji pemahaman copy:** owner + 4 orang membaca pesan error dan label tombol tanpa penjelasan; label "Periksa pembaruan" wajib dipahami.
- **Uji aksesibilitas:** navigasi keyboard di 3 alur utama, pembaca layar, skala font, target sentuh 44 px, kontras AA.
- **Keamanan:** Red-Blue-Red sesuai P9; audit dependensi (`npm audit`) sebelum tiap rilis.

## Rilis

- **Penomoran:** 0.9.x build uji, v1.0.0 rilis publik pertama.
- **Checklist rilis:** K1-K15 lolos; Red-Blue-Red nol temuan kritis, tinggi, sedang; README + PRIVACY_POLICY.md + CHANGELOG mutakhir; checksum SHA-256 di catatan rilis; PWA terverifikasi; domain produksi live.
- **Hotfix config:** config remote bisa diperbarui tanpa rilis app (TTL 6 jam, control plane bersama APK); bila owner tidak bisa dihubungi lebih dari 30 hari saat kerusakan aktif, tim menerbitkan hotfix config sesuai otorisasi delegasi.

## Risiko yang dibawa ke Fase 2 (ringkas, detail di PRD bagian 9)

R1 YouTube berubah; R2 satu maintainer paket audio; R3 rotasi hash dan kerapuhan solver; R4 config remote dan allowlist; R5 batas free-tier Cloudflare; R6 kerentanan QuickJS-WASM; R7 tindakan hukum; R8 scope creep; R9 ketergantungan satu owner; R10 pengguna mengira app rusak total; R11 impor Spotify jalur A; R12 eviction browser (storage bisa dihapus browser); R13 iOS Safari (audio latar + PWA terbatas); R14 CORS/proxy (bila S2 dan S7 sama-sama gagal, web tidak bisa resolve).

## Ukuran paket (relatif, tanpa tanggal)

PRD memutuskan tanpa tanggal karena estimasi waktu tanpa bukti build pertama adalah tebakan. Ukuran relatif di bawah ini untuk urutan dan perencanaan, bukan janji:

| Paket | Ukuran relatif | Alasan |
|-------|---------------|--------|
| P0 Fondasi | Kecil | Repo + skeleton + CI dasar + preview |
| P1 Spike | Besar | 10 spike, ketidakpastian tertinggi, gate go atau no-go |
| P2 Player core | Sedang | Elemen audio + MediaSession terverifikasi pola web; re-resolve butuh uji |
| P3 Database dan library | Sedang | Skema port APK sudah dirancang; migrasi IndexedDB butuh tes |
| P4 Pencarian dan browse | Sedang | Parser respons InnerTube butuh penyesuaian dengan respons nyata |
| P5 Unduhan dan offline | Sedang | Service Worker + Cache Storage + rekonsiliasi |
| P6 Ketahanan | Kecil sampai sedang | Config remote + kanari + klasifikasi (port APK) |
| P7 Fitur Should | Sedang | Lirik bergantung S10; sync bergantung S8 |
| P8 Backup dan ekspor | Kecil | Format JSON sudah dirancang (port APK) |
| P9 Keamanan | Sedang | 3 ronde Red, perbaikan temuan |
| P10 Rilis | Kecil | Dokumen + metadata + pengajuan |

Setelah P1 selesai, ukuran paket berikutnya dihitung ulang dengan bukti (kecepatan build nyata, kesulitan parser nyata). Revisi ukuran dicatat, bukan disembunyikan.

## Checklist 7 skill anti-slop

- **local-design-taste-frontend**: tidak relevan langsung (dokumen rencana, bukan desain); token desain dirujuk, tidak dibuat ulang.
- **local-impeccable**: tiap paket punya kriteria selesai yang bisa diuji; tidak ada paket "selesai" tanpa preview live.
- **local-humanizer**: rencana ditulis dengan kalimat biasa; istilah teknis dijelaskan saat pertama muncul.
- **local-stop-slop**: tidak ada kata haram; tidak ada klaim kecepatan tanpa bukti.
- **local-no-ai-slop**: tidak ada tanggal karangan; ukuran relatif dinyatakan sebagai ukuran relatif, bukan janji hari.
- **local-avoid-ai-writing**: kalimat aktif dan pendek.
- **local-anti-slop (rulebook)**: tanpa em dash, tanpa en dash, tanpa karakter persen; tanpa emoji.
