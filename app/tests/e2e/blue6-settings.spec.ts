/**
 * E2E Blue 6 (S10c): daftar ulang dalam 24 jam sesudah hapus
 * akun menampilkan pesan khusus di Pengaturan, bukan galat umum.
 * /api/auth/me di-mock 401 (belum masuk) supaya deterministik.
 */
import { test, expect, type Page } from '@playwright/test';

const SYNC_BASE_URL = 'https://laras-sync.hiroohengkerr.workers.dev';

async function mockSignedOut(page: Page) {
  await page.context().route(`${SYNC_BASE_URL}/api/auth/me`, (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      headers: {
        'Access-Control-Allow-Origin': 'http://localhost:4173',
        'Access-Control-Allow-Credentials': 'true',
      },
      body: JSON.stringify({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Belum masuk' },
      }),
    }),
  );
}

test('?auth=error&reason=deleted-recently menampilkan pesan "masuk lagi besok"', async ({
  page,
}) => {
  await mockSignedOut(page);
  await page.goto('/settings?auth=error&reason=deleted-recently');
  await expect(page.getByTestId('settings-account-error')).toHaveText(
    'Akun ini baru saja dihapus. Kamu bisa masuk lagi besok.',
  );
  // Query dibersihkan dari URL (refresh tidak mengulang pesan).
  expect(page.url()).not.toContain('reason=deleted-recently');
  expect(page.url()).not.toContain('auth=error');
});

test('?auth=error tanpa reason deleted-recently menampilkan pesan galat umum', async ({
  page,
}) => {
  await mockSignedOut(page);
  await page.goto('/settings?auth=error&reason=state');
  await expect(page.getByTestId('settings-account-error')).toHaveText(
    'Sinkronisasi belum bisa dihubungi. Coba lagi nanti.',
  );
});
