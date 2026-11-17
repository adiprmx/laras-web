import { defineConfig, devices } from '@playwright/test';

// E2E Laras Web — berjalan terhadap `vite preview` (build produksi).
// Di CI, browser diunduh segar; lokal memakai browser yang sudah ada.
export default defineConfig({
  testDir: './tests/e2e',
  // Spesifikasi spike (tests/e2e/spikes/) TIDAK PERNAH jalan di bawah
  // konfigurasi utama: mereka butuh server spike khusus (port 5229) dan
  // jaringan live ke YouTube, dan beforeAll mereka tetap jalan walau
  // semua uji di-skip (perilaku Playwright: skip kondisional dievaluasi
  // per uji sesudah beforeAll) — terbukti mematahkan CI 18 Nov 2026
  // (resolve live LOGIN_REQUIRED dari IP runner). Spike dijalankan
  // dengan: npx playwright test -c playwright.spikes.config.ts
  testIgnore: '**/spikes/**',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'npm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
