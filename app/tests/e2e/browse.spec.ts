/**
 * Tes E2E Jelajah P4: beranda Jelajah, navigasi kartu ke detail
 * (playlist/artis/album/mood), "Putar semua", putar lagu dari
 * rak, tombol kembali, galat + coba lagi.
 *
 * Semua jaringan di-mock (p4-helpers, fixture rekaman nyata).
 */
import { test, expect } from '@playwright/test';
import { mockP4Network, playerStatus } from './p4-helpers';

test.describe('jelajah (mock)', () => {
  test('/browse menampilkan rak-rak beranda Jelajah', async ({ page }) => {
    await mockP4Network(page.context());
    await page.goto('/browse');
    await expect(page.getByTestId('browse-content')).toBeVisible();
    await expect(page.getByTestId('browse-shelf-0')).toContainText(
      "Today's biggest hits",
    );
    await expect(page.getByTestId('browse-shelf-1')).toContainText(
      'Trending community playlists',
    );
  });

  test('ketuk kartu membuka detail playlist dan "Putar semua" memutar', async ({
    page,
  }) => {
    await mockP4Network(page.context());
    await page.goto('/browse');
    await expect(page.getByTestId('browse-content')).toBeVisible();
    await page
      .getByTestId('browse-shelf-0')
      .locator('[data-testid^="browse-card-"]')
      .first()
      .click();
    await expect(page).toHaveURL(/\/browse\/VL/);
    await expect(page.getByTestId('browse-content')).toBeVisible();
    await expect(page.getByTestId('browse-page')).toContainText(
      'Vibe: Clean & Feel-Good',
    );
    await page.getByTestId('browse-play-all').click();
    await expect(page.getByTestId('mini-player')).toBeVisible();
    await expect
      .poll(async () => playerStatus(page), { timeout: 15000 })
      .toBe('playing');
  });

  test('halaman artis menampilkan lagu teratas dan album', async ({
    page,
  }) => {
    await mockP4Network(page.context());
    await page.goto('/browse/UCCMnLkUAdm_NGMDTTC-nvDQ');
    await expect(page.getByTestId('browse-content')).toBeVisible();
    await expect(page.getByTestId('browse-page')).toContainText('Noah');
    await expect(page.getByTestId('browse-shelf-0')).toContainText(
      'Top songs',
    );
    await expect(page.getByTestId('browse-shelf-1')).toContainText('Albums');
    // Ketuk lagu pertama di "Top songs": memutar.
    await page
      .getByTestId('browse-shelf-0')
      .locator('[data-testid^="browse-song-"]')
      .first()
      .click();
    await expect(page.getByTestId('mini-player')).toBeVisible();
    await expect
      .poll(async () => playerStatus(page), { timeout: 15000 })
      .toBe('playing');
  });

  test('halaman album menampilkan judul dan daftar lagu', async ({
    page,
  }) => {
    await mockP4Network(page.context());
    await page.goto('/browse/MPREb_CjVCffe6rk9');
    await expect(page.getByTestId('browse-content')).toBeVisible();
    await expect(page.getByTestId('browse-page')).toContainText(
      'A Camp Family Christmas (feat. Egan Camp)',
    );
    await expect(
      page.locator('[data-testid^="browse-song-"]'),
    ).toHaveCount(3);
  });

  test('halaman mood menampilkan kategori dan bisa dibuka', async ({
    page,
  }) => {
    await mockP4Network(page.context());
    await page.goto('/browse/FEmusic_moods_and_genres');
    await expect(page.getByTestId('browse-content')).toBeVisible();
    await expect(page.getByTestId('browse-shelf-0')).toContainText(
      'Moods & moments',
    );
    await expect(page.getByTestId('browse-shelf-0')).toContainText('Chill');
    await expect(page.getByTestId('browse-shelf-1')).toContainText('Genres');
    await page
      .getByTestId('browse-shelf-0')
      .locator('[data-testid^="browse-card-"]')
      .first()
      .click();
    await expect(page).toHaveURL(
      /\/browse\/FEmusic_moods_and_genres_category\?params=/,
    );
    await expect(page.getByTestId('browse-content')).toBeVisible();
  });

  test('tombol kembali dari detail ke /browse, lalu ke beranda', async ({
    page,
  }) => {
    await mockP4Network(page.context());
    await page.goto('/browse/MPREb_CjVCffe6rk9');
    await expect(page.getByTestId('browse-content')).toBeVisible();
    await page.getByTestId('browse-back').click();
    await expect(page).toHaveURL('/browse');
    await expect(page.getByTestId('browse-content')).toBeVisible();
    await page.getByTestId('browse-back').click();
    await expect(page).toHaveURL('/');
    await expect(page.getByTestId('home-page')).toBeVisible();
  });

  test('browse gagal menampilkan galat dan tombol coba lagi', async ({
    page,
  }) => {
    let failing = true;
    await mockP4Network(page.context(), {
      browseFails: () => failing,
    });
    await page.goto('/browse');
    await expect(page.getByTestId('browse-error')).toBeVisible();
    failing = false;
    await page.getByTestId('browse-retry').click();
    await expect(page.getByTestId('browse-content')).toBeVisible();
  });
});
