import { defineConfig, devices } from '@playwright/test';

// E2E Laras Web — berjalan terhadap SERVER DEV (`vite`, bukan
// `vite preview`). Sejak Blue 1 (Red 1 H1), halaman uji
// (/library-test, /player-test, /p4-test) adalah DEV-only: rute +
// chunk-nya tidak ada di build produksi, padahal seeder E2E
// (library.spec, player.spec, home.spec, p4-helpers) mengisinya
// lewat halaman-halaman itu. Menjalankan E2E terhadap preview
// produksi akan mematahkan semua seeder. Build produksi tetap
// diuji: gerbang H1 di CI (job check) menggagalkan build bila
// chunk *TestPage* lolos ke dist/, dan tests/e2e/security.spec.ts
// menyajikan dist/ sendiri untuk membuktikan rute uji jatuh ke
// beranda + header CSP di build produksi.
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
  // Spesifikasi live (tests/e2e/live/) juga diabaikan di sini:
  // hanya jalan dengan LARAS_SPIKE_LIVE=1 lewat
  // playwright.live.config.ts.
  testIgnore: ['**/spikes/**', '**/live/**'],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Satu worker, lokal maupun CI: server dev mentransformasi modul
  // per permintaan dari satu proses Vite; dua worker paralel +
  // dua browser di CPU bersama membuat muat halaman melewati
  // 60 detik (terbukti Blue 1 run 2: 3 timeout di 116 tes, semua
  // page.goto/locator di bawah beban paralel, lolos saat diuji
  // terpisah). Serial lebih lambat tapi stabil; CI memang sudah
  // memakai 1 worker, jadi lokal == CI.
  workers: 1,
  // Server dev mentransformasi modul per permintaan (bukan bundle
  // jadi seperti preview): muat pertama bisa jauh lebih lambat,
  // terutama di CPU bersama VM. Batas 30 detik default membuat
  // page.goto timeout saat beban paralel tinggi (terbukti Blue 1:
  // 7+ timeout di run penuh pertama). 60 detik memberi ruang untuk
  // transformasi dingin tanpa menyembunyikan bug produk (tes yang
  // benar-benar macet tetap gagal, hanya lebih lambat).
  timeout: 60000,
  expect: { timeout: 10000 },
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
    command: 'npm run dev:e2e',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
