import { test, expect } from '@playwright/test';

test('beranda tampil dengan seksi Coba pemutar', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/Laras/);
  await expect(
    page.getByRole('heading', { name: 'Coba pemutar' }),
  ).toBeVisible();
  await expect(page.getByTestId('try-songs')).toBeVisible();
  await expect(page.getByPlaceholder('Cari lagu, artis, atau album')).toBeDisabled();
  await page.screenshot({ path: 'test-results/screenshot-home.png' });
});
