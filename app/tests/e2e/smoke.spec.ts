/**
 * Tes asap P4: beranda 6 seksi tampil dengan navigasi utama.
 * Jaringan di-mock (pola p4-helpers) supaya deterministik.
 */
import { test, expect } from '@playwright/test';
import { mockP4Network, seedP4 } from './p4-helpers';

test('beranda tampil dengan 6 seksi dan navigasi utama', async ({
  page,
}) => {
  await mockP4Network(page.context());
  await seedP4(page);
  await page.goto('/');
  await expect(page).toHaveTitle(/Laras/);
  await expect(page.getByTestId('home-page')).toBeVisible();
  await expect(page.getByTestId('bottom-nav')).toBeVisible();
  await expect(page.getByTestId('nav-home')).toBeVisible();
  await expect(page.getByTestId('nav-search')).toBeVisible();
  await expect(page.getByTestId('nav-library')).toBeVisible();
  for (const section of [
    'home-section-recent',
    'home-section-for-you',
    'home-section-most-played',
    'home-section-playlists',
    'home-section-downloads',
    'home-section-browse',
  ]) {
    await expect(page.getByTestId(section)).toBeVisible();
  }
  await expect(page.getByTestId('browse-shelves')).toBeVisible();
  await page.screenshot({ path: 'test-results/screenshot-home.png' });
});
