# Laras Web App Full-Stack — Dokumentasi Fase 1

Laras Web adalah aplikasi musik gratis, tanpa iklan, dan bisa dipakai offline — versi WEB dari APK Flutter Laras (repo `adiprmx/laras`). Web ini berjalan PARALEL dengan APK, bukan penggantinya: satu control plane config remote, satu merek, dua permukaan (HP Android dan browser).

Visi: satu pemutar musik web yang gratis, tanpa iklan, dan bisa dipakai offline, untuk orang Indonesia yang sering kehabisan kuota atau sinyal. App ini adalah client: tidak menyimpan lagu sendiri, mengambil audio dari YouTube dan YouTube Music lewat InnerTube, menyimpan lagu di browser lewat unduhan dan cache, dan tidak punya server berbayar, akun wajib, atau telemetri. Biaya Rp0.

## Peta dokumen

| File | Isi |
|---|---|
| `riset-kompetitor-web.md` | Riset 14 produk web (Spotify Web Player, YouTube Music web, Musike, Cantio, Decibel, Vibentra, Feishin, Nuclear, Muffon, dsb.) + 5 fitur pembeda Laras Web. |
| `transfer-ekstraktor.md` | Pengetahuan ekstraktor APK yang dipakai ulang di web: client fallback, alur resolve, itag, SABR, config remote, kanari, pelajaran P0-2. |
| `keputusan-solver.md` | Keputusan mengikat: solver di browser (QuickJS-WASM di Web Worker); Worker hanya proxy byte-only bila perlu. |
| `arsitektur.md` | Arsitektur full-stack: stack Cloudflare, frontend React + Vite + TypeScript + Tailwind + Zustand, backend proxy + sync, model data, keamanan, spike S1–S10. |
| `prd-v1.md` | PRD v1 web: visi, persona, journey, MoSCoW, spesifikasi B1–B11, K1–K15, milestone M0–M10, risiko, keputusan. |
| `rencana-fase-2.md` | Rencana pembangunan Fase 2 per paket (P0–P10) + CI + strategi tes + rilis. |
| `roster-tim.md` | Roster 102 tim senior (A=30, B=28, C=21, D=23) + 1 Koordinator + 4 Ketua Grup + 7 Ketua Divisi. |

## Keputusan kunci Fase 1

- **Stack:** Cloudflare Pages + Workers + D1 + KV baca (satu vendor, tanpa kartu, reset kuota harian). Cadangan: Vercel Hobby + Supabase organisasi kedua.
- **Frontend:** React + Vite + TypeScript + Tailwind + Zustand. PWA. Bundle awal maks 200 KB gzip.
- **Solver:** di browser (QuickJS-WASM di Web Worker khusus). Solver di server dilarang platform dan tidak layak CPU.
- **Config remote:** pakai ulang `config-v1` repo `adiprmx/laras` (satu control plane untuk APK dan web).
- **Akun:** opsional, OAuth Google/GitHub saja, tanpa kata sandi. Login tidak pernah wajib untuk memutar lagu.
- **Repo:** `adiprmx/laras-web` (publik, GPL-3.0-only). Domain produksi: USULAN `laras.adipmusic.my.id` (menunggu parent/owner).
- **Design lock:** hitam murni #000000 + aksen putih; warna hanya fungsi/status. V1 hanya mode gelap + Bahasa Indonesia.
- **Larangan permanen:** API Spotify dalam bentuk apa pun; iklan; pembayaran; telemetri; akun wajib.

## Status

Fase 1 SELESAI 17 November 2026: 7 dokumen di atas lengkap dan terverifikasi koordinator (ukuran file + isi). Fase 2 (pembangunan per paket P0–P10 + siklus keamanan Red→Blue→Red) mengikuti `rencana-fase-2.md`.
