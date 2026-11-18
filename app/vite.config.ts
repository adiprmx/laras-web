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
  },
  build: {
    // Peta sumber terpisah untuk debugging rilis tanpa membebani bundle.
    sourcemap: true,
  },
  worker: {
    // Worker solver dibuat dengan `{ type: 'module' }`; format 'es'
    // wajib karena format default 'iife' ditolak Vite untuk build
    // dengan code-splitting (chunk lazy solverClient).
    format: 'es',
  },
});
