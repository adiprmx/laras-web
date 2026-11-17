import { defineConfig } from '@playwright/test';

// Konfigurasi KHUSUS spike S1 (solver): berjalan terhadap `vite dev`
// (bukan preview build) supaya halaman spike + worker solver terbaru
// ikut terlayani tanpa build. Dipakai hanya oleh:
//   npx playwright test -c playwright.spike-s1.config.ts
// Konfigurasi E2E utama (playwright.config.ts) tidak diubah.
export default defineConfig({
  testDir: './tests/e2e/spikes',
  testMatch: 's1-solver.spec.ts',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 300000,
  use: {
    baseURL: 'http://localhost:5199',
  },
  projects: [{ name: 'chromium' }],
  webServer: {
    command: 'npx vite -c vite.spike-s1.config.ts --port 5199 --strictPort',
    url: 'http://localhost:5199/spike-s1.html',
    reuseExistingServer: true,
    timeout: 120000,
  },
});
