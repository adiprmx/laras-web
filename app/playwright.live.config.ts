import { defineConfig, devices } from '@playwright/test';

// Konfigurasi khusus uji live P4 (pencarian + browse lewat proxy
// produksi). Terpisah dari playwright.config.ts supaya CI tidak
// pernah menyentuh jaringan live: direktori tests/e2e/live/
// diabaikan konfigurasi utama (testIgnore) dan hanya jalan di
// sini, dengan LARAS_SPIKE_LIVE=1.
//
// Jalankan:  LARAS_SPIKE_LIVE=1 npx playwright test -c playwright.live.config.ts
// Catatan: uji live TIDAK memutar audio (googlevideo memblokir
// IP VM — terbukti S3); yang diverifikasi adalah search/browse
// lewat proxy dan rendering hasilnya.
export default defineConfig({
  testDir: './tests/e2e/live',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 120000,
  expect: { timeout: 30000 },
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
