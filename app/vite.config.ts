import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Laras Web — Vite + React + Tailwind v4 (CSS-first) + Vitest.
// Anggaran bundle awal: maks 200 KB gzip (arsitektur §3). Cek di CI.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
  },
  build: {
    // Peta sumber terpisah untuk debugging rilis tanpa membebani bundle.
    sourcemap: true,
  },
});
