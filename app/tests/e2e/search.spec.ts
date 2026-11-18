/**
 * Tes E2E Pencarian P4: kirim eksplisit (tanpa search-as-you-type),
 * saran riwayat + lokal + jaringan, riwayat 100 kueri, hasil
 * berkelompok, "Lihat semua", putar dari hasil, galat, offline.
 *
 * Semua jaringan di-mock (p4-helpers, fixture rekaman nyata).
 * Riwayat disimpan di IndexedDB — tiap tes memakai konteks baru
 * sehingga riwayat mulai kosong.
 */
import { test, expect } from '@playwright/test';
import {
  mockP4Network,
  newCounters,
  playerStatus,
  seedP4,
} from './p4-helpers';

test.describe('pencarian (mock)', () => {
  test('mengetik tidak memanggil server; kirim menampilkan hasil berkelompok', async ({
    page,
  }) => {
    const counters = newCounters();
    await mockP4Network(page.context(), { counters });
    await page.goto('/search');
    await expect(page.getByTestId('search-page')).toBeVisible();
    // Resolver init malas (hanya sebelum putar pertama): sebelum
    // kirim, TIDAK ADA panggilan search sama sekali.
    await page.waitForTimeout(800);
    const before = counters.search;
    expect(before).toBe(0);
    await page.getByTestId('search-input').pressSequentially('noah', {
      delay: 60,
    });
    // Lewati debounce saran (300 ms): saran BOLEH memanggil
    // endpoint saran, tapi search TIDAK BOLEH terpanggil.
    await page.waitForTimeout(1200);
    expect(counters.search).toBe(before);
    expect(counters.suggestions).toBeGreaterThanOrEqual(1);
    await expect(page.getByTestId('search-suggestions')).toBeVisible();
    await expect(page.getByTestId('search-suggestions')).toContainText(
      'noah kahan',
    );
    await page.getByTestId('search-submit').click();
    await expect(page).toHaveURL(/\/search\?q=noah/);
    await expect(page.getByTestId('search-results')).toBeVisible();
    expect(counters.search).toBe(before + 1);
    await expect(page.getByTestId('search-group-songs')).toBeVisible();
    await expect(
      page.getByTestId('search-song-hhn-nGSuenM'),
    ).toContainText('Semua Tentang Kita');
    await expect(page.getByTestId('search-group-albums')).toBeVisible();
    await expect(page.getByTestId('search-group-artists')).toBeVisible();
    await expect(page.getByTestId('search-group-playlists')).toBeVisible();
  });

  test('saran riwayat muncul saat mengetik dan bisa diketuk', async ({
    page,
  }) => {
    await mockP4Network(page.context());
    await page.goto('/search?q=noah');
    await expect(page.getByTestId('search-results')).toBeVisible();
    await page.goto('/search');
    await expect(page.getByTestId('search-page')).toBeVisible();
    await page.getByTestId('search-input').pressSequentially('no', {
      delay: 60,
    });
    await expect(page.getByTestId('search-suggestions')).toBeVisible();
    // Saran pertama = riwayat ("noah"), saran jaringan menyusul.
    await expect(page.getByTestId('search-suggestion-0')).toContainText(
      'noah',
    );
    await page.getByTestId('search-suggestion-0').click();
    await expect(page).toHaveURL(/\/search\?q=noah/);
    await expect(page.getByTestId('search-results')).toBeVisible();
  });

  test('riwayat tersimpan, dibuka lagi, dihapus satu dan semua', async ({
    page,
  }) => {
    await mockP4Network(page.context());
    await page.goto('/search?q=noah');
    await expect(page.getByTestId('search-results')).toBeVisible();
    await page.goto('/search');
    await expect(page.getByTestId('search-recent')).toBeVisible();
    await expect(page.getByTestId('search-recent-0')).toContainText('noah');
    await page.getByTestId('search-recent-0').click();
    await expect(page).toHaveURL(/\/search\?q=noah/);
    await expect(page.getByTestId('search-results')).toBeVisible();
    // Hapus satu.
    await page.goto('/search');
    await page.getByTestId('search-recent-delete-0').click();
    await expect(page.getByTestId('search-recent')).toHaveCount(0);
    // Dua kueri lalu hapus semua (dengan dialog konfirmasi).
    await page.goto('/search?q=noah');
    await expect(page.getByTestId('search-results')).toBeVisible();
    await page.goto('/search?q=peterpan');
    await expect(page.getByTestId('search-results')).toBeVisible();
    await page.goto('/search');
    await expect(page.getByTestId('search-recent-0')).toContainText(
      'peterpan',
    );
    await expect(page.getByTestId('search-recent-1')).toContainText('noah');
    await page.getByTestId('search-clear-history').click();
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('search-recent')).toHaveCount(0);
  });

  test('"Lihat semua" lagu menampilkan 21 lagu dari pratinjau 10', async ({
    page,
  }) => {
    await mockP4Network(page.context());
    await page.goto('/search?q=banyak');
    await expect(page.getByTestId('search-results')).toBeVisible();
    const rows = page
      .getByTestId('search-group-songs')
      .locator('[data-testid^="search-song-"]');
    await expect(rows).toHaveCount(10);
    await page.getByTestId('search-view-all-songs').click();
    await expect(rows).toHaveCount(21);
    await expect(page.getByTestId('search-view-all-songs')).toContainText(
      'Lihat lebih sedikit',
    );
  });

  test('kueri tanpa hasil menampilkan keadaan kosong yang jujur', async ({
    page,
  }) => {
    await mockP4Network(page.context());
    await page.goto('/search?q=kosong');
    await expect(page.getByTestId('search-empty')).toBeVisible();
    await expect(page.getByTestId('search-empty')).toContainText('kosong');
  });

  test('memutar lagu dari hasil pencarian', async ({ page }) => {
    await mockP4Network(page.context());
    await page.goto('/search?q=noah');
    await page.getByTestId('search-song-hhn-nGSuenM').click();
    await expect(page.getByTestId('mini-player')).toBeVisible();
    await expect(page.getByTestId('mini-player')).toContainText(
      'Semua Tentang Kita',
    );
    await expect
      .poll(async () => playerStatus(page), { timeout: 15000 })
      .toBe('playing');
  });

  test('hasil lokal tampil bersama hasil jaringan dan bisa diputar', async ({
    page,
  }) => {
    await mockP4Network(page.context());
    await seedP4(page);
    await page.goto('/search?q=favorit');
    await expect(page.getByTestId('search-results')).toBeVisible();
    await expect(page.getByTestId('search-group-local')).toBeVisible();
    await expect(
      page.getByTestId('search-local-song-p4-song-a'),
    ).toContainText('Favorit A');
    await page.getByTestId('search-local-song-p4-song-a').click();
    await expect(page.getByTestId('mini-player')).toContainText('Favorit A');
    await expect
      .poll(async () => playerStatus(page), { timeout: 15000 })
      .toBe('playing');
  });

  test('search gagal: hasil lokal tetap tampil; gagal total ada tombol coba lagi', async ({
    page,
  }) => {
    let failing = true;
    await mockP4Network(page.context(), {
      searchFails: () => failing,
    });
    await seedP4(page);
    // Kueri cocok lokal: catatan jaringan + grup lokal tampil.
    await page.goto('/search?q=favorit');
    await expect(page.getByTestId('search-network-note')).toBeVisible();
    await expect(
      page.getByTestId('search-local-song-p4-song-a'),
    ).toContainText('Favorit A');
    // Kueri tanpa hasil lokal: galat penuh + tombol coba lagi.
    await page.goto('/search?q=noah');
    await expect(page.getByTestId('search-error')).toBeVisible();
    await page.getByTestId('search-retry').click();
    await expect(page.getByTestId('search-error')).toBeVisible();
    failing = false;
    await page.getByTestId('search-retry').click();
    await expect(page.getByTestId('search-results')).toBeVisible();
    await expect(
      page.getByTestId('search-song-hhn-nGSuenM'),
    ).toContainText('Semua Tentang Kita');
  });

  test('sampul gagal dimuat menampilkan ubin huruf awal, bukan kotak kosong', async ({
    page,
  }) => {
    await mockP4Network(page.context(), { thumbnailsFail: true });
    await page.goto('/search?q=noah');
    await expect(page.getByTestId('search-results')).toBeVisible();
    const row = page.getByTestId('search-song-hhn-nGSuenM');
    await expect(row).toBeVisible();
    // Ubin huruf awal "S" (Semua Tentang Kita) menggantikan <img>.
    await expect(row.locator('span[aria-hidden="true"]')).toHaveText('S');
    await expect(row.locator('img')).toHaveCount(0);
  });

  test('offline: spanduk offline + hasil lokal tetap tampil', async ({
    page,
  }) => {
    await mockP4Network(page.context());
    await seedP4(page);
    await page.goto('/search');
    await expect(page.getByTestId('search-page')).toBeVisible();
    await page.context().setOffline(true);
    await page.getByTestId('search-input').fill('favorit');
    await page.getByTestId('search-submit').click();
    await expect(page.getByTestId('search-offline')).toBeVisible();
    await expect(
      page.getByTestId('search-local-song-p4-song-a'),
    ).toContainText('Favorit A');
    await page.context().setOffline(false);
  });
});
