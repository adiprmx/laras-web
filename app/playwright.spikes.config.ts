import { defineConfig, devices } from '@playwright/test';

// Konfigurasi khusus spike S3/S5/S9 Laras Web. Terpisah dari
// playwright.config.ts (yang memakai server dev) karena spike tidak
// boleh menjalankan build dan tidak boleh mengganggu tim lain: server di sini adalah server statis kecil (serve.mjs) yang
// melayani aset public/ + fixture spike di port 5229.
//
// Jalankan:  npx playwright test --config=playwright.spikes.config.ts
// Satu file: npx playwright test --config=playwright.spikes.config.ts s3-playback
export default defineConfig({
  testDir: './tests/e2e/spikes',
  // Hanya spesifikasi S3/S5/S9 (tim Pemutaran). Spesifikasi spike tim
  // lain di direktori yang sama punya konfigurasinya sendiri.
  testMatch: [
    's3-playback.spec.ts',
    's5-webaudio-cors.spec.ts',
    's9-pwa-background.spec.ts',
  ],
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Egress VM lambat (satu chunk 768 KiB bisa 30 detik); uji lagu penuh
  // butuh menit. Batas per uji diatur ulang di tiap spesifikasi.
  timeout: 180000,
  expect: { timeout: 15000 },
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5229',
    trace: 'on-first-retry',
    launchOptions: {
      // Tanpa ini, play() dari evaluate ditolak kebijakan autoplay.
      args: ['--autoplay-policy=no-user-gesture-required'],
    },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'node ./tests/e2e/spikes/serve.mjs',
    url: 'http://localhost:5229/spikes/playback.html',
    reuseExistingServer: true,
    timeout: 60000,
  },
});
