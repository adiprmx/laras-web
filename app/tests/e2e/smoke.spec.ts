import { test, expect } from '@playwright/test';

test('beranda skeleton tampil dengan judul kosong yang jujur', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/Laras/);
  await expect(page.getByRole('heading', { name: 'Belum ada lagu di sini' })).toBeVisible();
  await expect(page.getByPlaceholder('Cari lagu, artis, atau album')).toBeDisabled();
  await page.screenshot({ path: 'test-results/screenshot-home.png' });
});
