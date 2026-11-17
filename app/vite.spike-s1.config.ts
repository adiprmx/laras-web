import { defineConfig } from 'vite';

// Konfigurasi Vite KHUSUS server spike S1: HMR DIMATIKAN supaya halaman
// spike tidak pernah me-reload di tengah pengukuran (tim lain bekerja
// paralel di workdir yang sama; satu save mereka me-reload halaman dan
// menghancurkan konteks evaluasi Playwright - terbukti di run pertama).
// Hanya dipakai server spike: `npx vite -c vite.spike-s1.config.ts`.
export default defineConfig({
  server: {
    hmr: false,
  },
});
