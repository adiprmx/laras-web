/**
 * Tes E2E Beranda P4: 6 seksi (urutan PRD), rumus "Lagu untukmu"
 * (contoh hitung PRD: B 9 putaran, A 3 putaran + favorit, C 1
 * putaran + unduh), "Lihat semua", pengguna baru, Jelajah
 * (cache, offline, galat), putar dari beranda.
 *
 * Skenario deterministik dari /p4-test; jaringan di-mock.
 */
import { test, expect } from '@playwright/test';
import {
  mockP4Network,
  newCounters,
  playerStatus,
  seedP4,
} from './p4-helpers';

test.describe('beranda (mock)', () => {
  test('6 seksi tampil sesuai urutan PRD dengan isi skenario', async ({
    page,
  }) => {
    await mockP4Network(page.context());
    await seedP4(page);
    await page.goto('/');
    await expect(page.getByTestId('home-page')).toBeVisible();
    // Tunggu semua seksi selesai dimuat sebelum membaca urutan
    // (evaluateAll tidak menunggu otomatis seperti expect).
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
    const order = await page
      .locator('section[data-testid^="home-section-"]')
      .evaluateAll((els) =>
        els.map((el) => el.getAttribute('data-testid')),
      );
    expect(order).toEqual([
      'home-section-recent',
      'home-section-for-you',
      'home-section-most-played',
      'home-section-playlists',
      'home-section-downloads',
      'home-section-browse',
    ]);
    // "Lagu untukmu": B(9) > A(3+favorit=8) > C(1+unduh=3) >
    // E(2) > D(1) > F(pengisi, terbaru ditambahkan).
    const forYou = page.getByTestId('home-section-for-you');
    const forYouTitles = await forYou
      .locator('li button span.truncate.text-sm')
      .allTextContents();
    expect(forYouTitles).toEqual([
      'Sering Didengar B',
      'Favorit A',
      'Unduhan C',
      'Lama E',
      'Baru Saja D',
      'Tanpa Putar F',
    ]);
    // "Baru diputar": D paling baru, lalu C, B, A, E.
    const recentTitles = await page
      .getByTestId('home-section-recent')
      .locator('li button span.truncate.text-sm')
      .allTextContents();
    expect(recentTitles).toEqual([
      'Baru Saja D',
      'Unduhan C',
      'Sering Didengar B',
      'Favorit A',
      'Lama E',
    ]);
    // "Sering diputar": B (9x30 dtk) > A (3x30) > E (2x30).
    const mostTitles = await page
      .getByTestId('home-section-most-played')
      .locator('li button span.truncate.text-sm')
      .allTextContents();
    expect(mostTitles.slice(0, 3)).toEqual([
      'Sering Didengar B',
      'Favorit A',
      'Lama E',
    ]);
    // Playlist + unduhan.
    await expect(
      page.getByTestId('home-section-playlists'),
    ).toContainText('Playlist Uji P4');
    await expect(
      page.getByTestId('home-section-downloads'),
    ).toContainText('Unduhan C');
    // Jelajah: rak dari fixture browse-home.
    await expect(page.getByTestId('browse-shelves')).toBeVisible();
    await expect(page.getByTestId('browse-shelf-0')).toContainText(
      "Today's biggest hits",
    );
  });

  test('"Lihat semua" membuka tujuan yang benar', async ({ page }) => {
    await mockP4Network(page.context());
    await seedP4(page);
    await page.goto('/');
    await expect(page.getByTestId('home-page')).toBeVisible();
    await page.getByTestId('home-recent-view-all').click();
    await expect(page).toHaveURL(/\/library\?tab=history/);
    await expect(page.getByTestId('library-page')).toBeVisible();
    await page.goto('/');
    await page.getByTestId('home-most-played-view-all').click();
    await expect(page).toHaveURL('/library');
    await page.goto('/');
    await page.getByTestId('home-playlists-view-all').click();
    await expect(page).toHaveURL(/\/library\?tab=playlists/);
    await page.goto('/');
    await page.getByTestId('home-browse-view-all').click();
    await expect(page).toHaveURL('/browse');
    await expect(page.getByTestId('browse-page')).toBeVisible();
  });

  test('pengguna baru: tanpa data lokal, Jelajah tetap tampil (tanpa empty state)', async ({
    page,
  }) => {
    await mockP4Network(page.context());
    await page.goto('/');
    await expect(page.getByTestId('browse-shelves')).toBeVisible();
    // Jelajah mengisi beranda pengguna baru: empty state hanya
    // muncul bila Jelajah juga gagal/kosong (uji berikut).
    await expect(page.getByTestId('home-empty')).toHaveCount(0);
    await expect(page.getByTestId('home-section-recent')).toHaveCount(0);
  });

  test('pengguna baru + Jelajah gagal: empty state dengan tombol cari', async ({
    page,
  }) => {
    await mockP4Network(page.context(), {
      browseFails: () => true,
    });
    await page.goto('/');
    await expect(page.getByTestId('home-empty')).toBeVisible();
    await page.getByTestId('home-empty-find').click();
    await expect(page).toHaveURL('/search');
  });

  test('Jelajah di-cache: muat ulang tidak memanggil browse lagi', async ({
    page,
  }) => {
    const counters = newCounters();
    await mockP4Network(page.context(), { counters });
    await page.goto('/');
    await expect(page.getByTestId('browse-shelves')).toBeVisible();
    expect(counters.browse).toBe(1);
    await page.goto('/');
    await expect(page.getByTestId('browse-shelves')).toBeVisible();
    expect(counters.browse).toBe(1);
  });

  test('Jelajah offline menampilkan pesan offline', async ({ page }) => {
    await mockP4Network(page.context());
    await page.goto('/search');
    await expect(page.getByTestId('search-page')).toBeVisible();
    await page.context().setOffline(true);
    await page.getByTestId('nav-home').click();
    await expect(page.getByTestId('browse-offline')).toBeVisible();
    await page.context().setOffline(false);
  });

  test('Jelajah gagal lalu coba lagi berhasil', async ({ page }) => {
    let failing = true;
    await mockP4Network(page.context(), {
      browseFails: () => failing,
    });
    await page.goto('/');
    await expect(page.getByTestId('browse-error')).toBeVisible();
    failing = false;
    await page.getByTestId('browse-retry').click();
    await expect(page.getByTestId('browse-shelves')).toBeVisible();
  });

  test('memutar lagu dari "Lagu untukmu"', async ({ page }) => {
    await mockP4Network(page.context());
    await seedP4(page);
    await page.goto('/');
    await page.getByTestId('home-for-you-p4-song-b').click();
    await expect(page.getByTestId('mini-player')).toContainText(
      'Sering Didengar B',
    );
    await expect
      .poll(async () => playerStatus(page), { timeout: 15000 })
      .toBe('playing');
  });

  test('"Lagu untukmu" mengembang 10 menjadi 20 saat library besar', async ({
    page,
  }) => {
    await mockP4Network(page.context());
    // 120 lagu contoh tanpa riwayat putar: "Lagu untukmu" diisi
    // 20 lagu terbaru dari library (pengisi FOR_YOU_LIMIT).
    await page.goto('/library-test');
    await page.getByTestId('library-test-seed-120').click();
    await expect(page.getByTestId('library-test-songs')).toHaveText('120', {
      timeout: 60000,
    });
    await page.goto('/');
    await expect(page.getByTestId('home-page')).toBeVisible();
    const rows = page
      .getByTestId('home-section-for-you')
      .locator('li button[data-testid^="home-for-you-"]');
    await expect(rows).toHaveCount(10);
    await page.getByTestId('home-for-you-view-all').click();
    await expect(rows).toHaveCount(20);
    await expect(page.getByTestId('home-for-you-view-all')).toContainText(
      'Lihat lebih sedikit',
    );
  });
});
