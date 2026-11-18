/**
 * Tes Playwright halaman spike integrasi P1 (rute /spike).
 *
 * Berjalan terhadap server dev lewat konfigurasi utama (sejak
 * Blue 1, E2E tidak lagi memakai `vite preview` — lihat
 * playwright.config.ts). Uji UI selalu jalan. Uji live (resolve via proxy + putar
 * lagu) HANYA jalan bila LARAS_SPIKE_LIVE=1: dari VM uji itu gagal
 * jaringan (googlevideo memblokir IP VM, terbukti S3), jadi tidak
 * pernah dipalsukan hijau. Jalankan uji live dari browser di luar VM.
 */
import { test, expect } from '@playwright/test';

const SONGS = [
  'Semua Tentang Kita',
  'Rahasia Hati',
  'Surat Cinta Untuk Starla',
  'Ya Sudahlah',
  'Tak Ingin Usai',
];

test.describe('halaman spike /spike', () => {
  test('menampilkan lima lagu kanari dan dua mode', async ({ page }) => {
    await page.goto('/spike');
    await expect(
      page.getByRole('heading', { name: 'Uji putar lima lagu' }),
    ).toBeVisible();
    for (const title of SONGS) {
      await expect(
        page.getByTestId('spike-song-list').getByText(title, { exact: false }),
      ).toBeVisible();
    }
    await expect(page.getByTestId('spike-mode-cepat')).toBeVisible();
    await expect(page.getByTestId('spike-mode-penuh')).toBeVisible();
    await expect(page.getByTestId('spike-audio')).toBeVisible();
    await expect(page.getByTestId('spike-summary')).toHaveCount(0);
  });

  test('beranda tidak menautkan ke /spike', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('a[href*="spike"]')).toHaveCount(0);
    await expect(page.getByText('Uji putar lima lagu')).toHaveCount(0);
  });

  test('tombol hentikan muncul saat uji berjalan', async ({ page }) => {
    await page.goto('/spike');
    await page.getByTestId('spike-mode-cepat').click();
    await expect(page.getByTestId('spike-stop')).toBeVisible();
    await expect(page.getByTestId('spike-elapsed')).toBeVisible();
    await page.getByTestId('spike-stop').click();
    await expect(page.getByTestId('spike-summary')).toBeVisible();
  });
});

test.describe('uji live spike (butuh browser di luar VM)', () => {
  test.skip(
    process.env.LARAS_SPIKE_LIVE !== '1',
    'Uji live butuh browser di luar VM (googlevideo memblokir IP VM).',
  );

  test('periksa cepat: 5/5 lagu selesai', async ({ page }) => {
    test.setTimeout(10 * 60 * 1000);
    await page.goto('/spike');
    await page.getByTestId('spike-mode-cepat').click();
    await expect(page.getByTestId('spike-summary')).toBeVisible({
      timeout: 9 * 60 * 1000,
    });
    await expect(page.getByTestId('spike-summary')).toContainText(
      'Hasil: 5/5 lagu selesai',
    );
    const report = await page.getByTestId('spike-report').textContent();
    expect(report ?? '').toContain('Hasil: 5/5 lagu selesai');
    expect(report ?? '').not.toContain('googlevideo.com');
    expect(report ?? '').not.toContain('videoplayback');
  });
});
