# Laras Web App Full-Stack — Dokumentasi

Laras Web adalah aplikasi musik gratis, tanpa iklan, dan bisa dipakai offline — versi WEB dari APK Flutter Laras (repo `adiprmx/laras`). Web ini berjalan PARALEL dengan APK, bukan penggantinya: satu control plane config remote, satu merek, dua permukaan (HP Android dan browser).

Visi: satu pemutar musik web yang gratis, tanpa iklan, dan bisa dipakai offline, untuk orang Indonesia yang sering kehabisan kuota atau sinyal. App ini adalah client: tidak menyimpan lagu sendiri, mengambil audio dari YouTube dan YouTube Music lewat InnerTube, menyimpan lagu di browser lewat unduhan dan cache, dan tidak punya server berbayar, akun wajib, atau telemetri. Biaya Rp0.

## Peta dokumen

### Fase 1 — riset & rancangan

| File | Isi |
|---|---|
| `riset-kompetitor-web.md` | Riset 14 produk web (Spotify Web Player, YouTube Music web, Musike, Cantio, Decibel, Vibentra, Feishin, Nuclear, Muffon, dsb.) + 5 fitur pembeda Laras Web. |
| `transfer-ekstraktor.md` | Pengetahuan ekstraktor APK yang dipakai ulang di web: client fallback, alur resolve, itag, SABR, config remote, kanari, pelajaran P0-2. |
| `keputusan-solver.md` | Keputusan mengikat: solver di browser (QuickJS-WASM di Web Worker); Worker hanya proxy byte-only bila perlu. |
| `arsitektur.md` | Arsitektur full-stack: stack Cloudflare, frontend React + Vite + TypeScript + Tailwind + Zustand, backend proxy + sync, model data, keamanan, spike S1–S10. |
| `prd-v1.md` | PRD v1 web: visi, persona, journey, MoSCoW, spesifikasi B1–B11, K1–K15, milestone M0–M10, risiko, keputusan. |
| `rencana-fase-2.md` | Rencana pembangunan Fase 2 per paket (P0–P10) + CI + strategi tes + rilis. |
| `roster-tim.md` | Roster 102 tim senior (A=30, B=28, C=21, D=23) + 1 Koordinator + 4 Ketua Grup + 7 Ketua Divisi. |

### Fase 2 — laporan paket (P0–P8)

| File | Isi |
|---|---|
| `p0-notes.md` | P0 — Fondasi (selesai + terverifikasi). |
| `p2-player-core.md` | P2 Player Core: laporan. Bukti visual di `p2/`. |
| `p3-database-library.md` | P3: Database dan Library (IndexedDB). Bukti visual di `p3/`. |
| `p4-search-browse.md` | P4: Pencarian dan Browse. Bukti visual di `p4/`. |
| `p5-downloads-offline.md` | P5 — Unduhan dan Offline. Bukti visual di `p5/`. |
| `p6-resilience.md` | P6 Ketahanan — Laporan. Bukti visual di `p6/`. |
| `p7-should-features.md` | P7 — Fitur Should: Lirik, EQ, Timer Tidur, Sinkronisasi Opsional. Bukti visual di `p7/`. |
| `p8-backup-export.md` | P8 — Backup dan Ekspor. Bukti visual di `p8/`. |

### Fase 2 — audit keamanan Red & perbaikan Blue (P9)

| File | Isi |
|---|---|
| `red1-audit.md` + `blue1-red1-fixes.md` | Red 1 audit keamanan (P0–P4) + perbaikan Blue 1. |
| `red2-audit.md` + `blue2-red2-fixes.md` | Red 2 audit keamanan (P5 + P6) + perbaikan Blue 2. |
| `red3-audit.md` + `blue3-red3-fixes.md` | Red 3 audit keamanan (P7 + P8, Release Candidate) + perbaikan Blue 3. |
| `red4-audit.md` + `blue4-red4-fixes.md` | Red 4 audit keamanan (P9, sesudah Blue 3) + perbaikan Blue 4. |
| `red5-audit.md` + `blue5-red5-fixes.md` | Red 5 audit keamanan (P9, sesudah Blue 4) + perbaikan Blue 5. |
| `red6-audit.md` + `blue6-red6-fixes.md` | Red 6 audit keamanan (P9, sesudah Blue 5) + perbaikan Blue 6. |
| `red7-audit.md` + `blue7-red7-fixes.md` | Red 7 audit keamanan (P9, ronde TERAKHIR, sesudah Blue 6) + perbaikan Blue 7. |

### Egress, resolve & spike

| File | Isi |
|---|---|
| `egress-riset-lanjutan.md` | Egress Ketiga Laras: riset lanjutan (Deno, Netlify, Render, Fly.io). |
| `egress-1-juta-cara.md` | Program "1 Juta Cara" 19 Nov 2026: matriks semua jalur egress yang diuji. |
| `vercel-egress.md` | Egress Kedua: proxy InnerTube via Vercel — hasil uji (19 Nov 2026). |
| `render-egress.md` | Egress Ketiga: proxy InnerTube via Render (19 Nov 2026). |
| `iframe-fallback.md` | Fallback Pemutar YouTube (P3). |
| `retry-ladder.md` | Tangga Retry Lebih Panjang — hotfix resolve. |
| `potoken-brief.md` + `potoken-spike.md` | Brief keputusan + hasil spike poToken (vonis: tidak membantu, jalur DITUTUP). |
| `spikes/` | Bukti spike P1: pengukuran S1–S4, log S3, jaringan S2/S6/S7, playback S3/S5/S9, data S8/S10 + skrip probe. |

## Keputusan kunci Fase 1

- **Stack:** Cloudflare Pages + Workers + D1 + KV baca (satu vendor, tanpa kartu, reset kuota harian). Cadangan: Vercel Hobby + Supabase organisasi kedua.
- **Frontend:** React + Vite + TypeScript + Tailwind + Zustand. PWA. Bundle awal maks 200 KB gzip.
- **Solver:** di browser (QuickJS-WASM di Web Worker khusus). Solver di server dilarang platform dan tidak layak CPU.
- **Config remote:** pakai ulang `config-v1` repo `adiprmx/laras` (satu control plane untuk APK dan web).
- **Akun:** opsional, OAuth Google/GitHub saja, tanpa kata sandi. Login tidak pernah wajib untuk memutar lagu.
- **Repo:** `adiprmx/laras-web` (publik, GPL-3.0-only). Domain produksi: `laras.adipmusic.my.id` (live sejak 19 Nov 2026).
- **Design lock:** hitam murni #000000 + aksen putih; warna hanya fungsi/status. V1 hanya mode gelap + Bahasa Indonesia.
- **Larangan permanen:** API Spotify dalam bentuk apa pun; iklan; pembayaran; telemetri; akun wajib.

## Status

Fase 1 SELESAI 17 November 2026: 7 dokumen Fase 1 lengkap dan terverifikasi koordinator (ukuran file + isi). Fase 2 SELESAI 19 November 2026: pembangunan per paket P0–P8 + siklus keamanan Red→Blue→Red sampai Red 7 (ronde terakhir, 0 temuan kritikal/tinggi/sedang) + domain produksi live. Log kerja koordinator (termasuk perbaikan pasca-Fase 2) ada di `hidden_files/koordinator/log.md` — bukan bagian dokumen publik ini.
