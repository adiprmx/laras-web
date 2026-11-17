# P0 — Fondasi (selesai + terverifikasi)

Status: **SELESAI** — 17 Nov 2026 ~20:58 WIB.
Pengerjaan: koordinator langsung (spawn tim subagent terblokir secara struktural — lihat §5).

## 1. Hasil verifikasi

| Gerbang | Hasil |
|---|---|
| `npm run typecheck` (`tsc -b`) | Bersih (setelah menambah `src/vite-env.d.ts`, lihat §3) |
| `npm run lint` (ESLint 9 flat) | Bersih, 0 warning |
| `npm test` (Vitest) | **2/2 lulus** — beranda kosong jujur + tanpa jargon di copy |
| `npm run build` (Vite) | Berhasil, 7,22 dtk |
| Bundle JS gzip | **70.278 byte (68,6 KB)** dari batas 200 KB — 34% anggaran |
| `npm run test:e2e` (Playwright) | **2/2 lulus** — Chromium desktop + Pixel 7, 12 dtk |
| Tangkapan layar | `app/test-results/screenshot-home.png` (76.339 byte) — beranda kosong tampil benar di viewport HP |

## 2. Versi terinstal (terkunci di package-lock.json)

| Paket | Versi |
|---|---|
| react / react-dom | 19.3.1 |
| zustand | 5.1.0 |
| vite | 6.4.6 |
| @vitejs/plugin-react | 5.2.0 |
| typescript | 5.9.3 |
| tailwindcss / @tailwindcss/vite | 4.3.5 |
| vitest | 3.2.7 |
| jsdom | 26.1.0 |
| @playwright/test | 1.65.1 (pin eksak — browsers.json memakai Chromium rev 1255, cocok dengan cache VM) |
| eslint | 9.39.5 |
| typescript-eslint | 8.73.0 |
| eslint-plugin-react-hooks | 5.2.0 |
| eslint-plugin-react-refresh | 0.4.26 |
| globals | 16.5.0 |

Node v24.22.1, npm 10.9.4. `npm install`: 263 paket, 8 menit (registry lambat ~15 dtk/request), exit 0.

## 3. Keputusan & perbaikan selama P0

- **`src/vite-env.d.ts` ditambahkan** — scaffold awal lupa menyertakan `/// <reference types="vite/client" />`, sehingga `import './index.css'` dan `import.meta.env` gagal di typecheck. Perbaikan 1 baris, typecheck lalu bersih.
- **Ikon PNG 192/512 dibuat dengan PIL** (huruf L putih di latar hitam murni) — `public/icons/icon-192.png` (397 byte), `icon-512.png` (1.393 byte). Ikon final bergaya brand adalah utang P10/design.
- **Service Worker shell-only** (`public/sw.js`, cache `laras-shell-v1`, same-origin GET saja) — audio/offline penuh di P5.
- **Bundle check CI** (`.github/workflows/ci.yml`): total JS gzip ≤ 200 KB, dihitung dari `dist/assets/*.js` dengan `zlib.gzipSync`.
- **ESLint 9.39.5 sudah deprecated** (peringatan npm saat install) — upgrade ke ESLint 10 adalah utang P9/P10, bukan penghambat P0.

## 4. Utang P0

- Tag action CI memakai `v4` (bukan SHA-pin) — SHA-pin utang P9.
- Ikon PNG adalah placeholder fungsional, bukan identitas final.
- Sourcemap build 1 MB (sourcemap: true) — evaluasi kembali di P10.
- Repo `adiprmx/laras-web` BELUM dibuat — langkah koordinator sesudah P0 terverifikasi (cek 404 dulu via API, seperti adiprmx/laras).

## 5. Catatan spawn (kendala struktural)

Spawn subagent di sesi koordinator ini GAGAL 3x dengan error yang sama:
`database error: subagent reservation owner is terminal or structurally invalid: parent=6cd8014b-03c0-475d-811c-9830c319687f`.
P0 dikerjakan langsung oleh koordinator (sesuai aturan "1 juta cara" — jangan diam saat jalur buntu).
Fase 2 paket P1+ membutuhkan **sesi koordinator baru yang di-spawn parent** agar tim paket bisa dibentuk.
