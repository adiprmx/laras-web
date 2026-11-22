import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { computeSwVersion } from './src/downloads/swVersion';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Plugin build: ganti placeholder `__LARAS_SW_VERSION__` di
 * `dist/sw.js` dengan versi build. Berjalan di `writeBundle`
 * (sesudah `public/` disalin ke `dist/`). Di mode dev plugin
 * tidak jalan dan placeholder tetap literal — sah sebagai nama
 * cache saat SW didaftarkan manual di E2E.
 */
function larasSwVersion(): Plugin {
  return {
    name: 'laras-sw-version',
    writeBundle(options) {
      const outDir = options.dir ?? join(HERE, 'dist');
      const swPath = join(outDir, 'sw.js');
      const content = readFileSync(swPath, 'utf8');
      if (!content.includes('__LARAS_SW_VERSION__')) return;
      const pkg = JSON.parse(
        readFileSync(join(HERE, 'package.json'), 'utf8'),
      ) as { version: string };
      const version = computeSwVersion(pkg.version, content);
      writeFileSync(
        swPath,
        content.replaceAll('__LARAS_SW_VERSION__', version),
        'utf8',
      );
    },
  };
}

// Laras Web — Vite + React + Tailwind v4 (CSS-first) + Vitest.
// Anggaran bundle awal: maks 200 KB gzip (arsitektur §3). Cek di CI.
export default defineConfig({
  plugins: [react(), tailwindcss(), larasSwVersion()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    // Cakupan (P-Coverage): provider v8, app-only. Kode worker
    // (workers/sync + workers/proxy) TIDAK masuk laporan:
    // @vitest/coverage-v8 tidak mengumpulkan cakupan file di luar
    // root Vite — dibuktikan 2x (pola relatif '../workers' dan
    // path absolut, keduanya 0 file worker di laporan; eksperimen
    // include CLI eksplisit pun kosong). Tes worker tetap jalan
    // di suite (src/worker/*) dan tetap menjadi bukti
    // no-regression worker — hanya angka cakupannya tidak ada.
    // Ambang batas = baseline nyata Vitest 5 (22 Nov 2026:
    // statements 63,82 / branches 56,55 / functions 51,76 /
    // lines 66,04) dikurangi margin — gerbang lunak anti-regresi,
    // bukan target 80% buta. Baseline Vitest 3 (59,29 / 79,6 /
    // 80,35 / 59,29) TIDAK berlaku lagi: Vitest 4+ mengganti
    // v8-to-istanbul dengan remapper baru yang menghitung
    // branches/functions dengan presisi — angka Vitest 3
    // menggelembung karena fungsi/cabang tak teruji di komponen
    // UI kurang terhitung di penyebut. Angka rendah karena
    // komponen UI/pages diuji E2E (Playwright), bukan unit;
    // logika inti (backup 93%, data, sync, extractor) tinggi.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/test/**',
        'src/main.tsx',
        '**/*.d.ts',
      ],
      thresholds: {
        statements: 60,
        branches: 52,
        functions: 48,
        lines: 62,
      },
    },
  },
  build: {
    // Peta sumber terpisah untuk debugging rilis tanpa membebani bundle.
    sourcemap: true,
    // Kosongkan dist/ tiap build — tanpa ini, ekstraksi artefak CI
    // di atas dist/ lama meninggalkan dua generasi chunk (22 Nov:
    // index-C7ct93DI.js + index-BR_4Dkt1.js, ~5 MB sampah).
    emptyOutDir: true,
  },
  worker: {
    // Worker solver dibuat dengan `{ type: 'module' }`; format 'es'
    // wajib karena format default 'iife' ditolak Vite untuk build
    // dengan code-splitting (chunk lazy solverClient).
    format: 'es',
  },
});
