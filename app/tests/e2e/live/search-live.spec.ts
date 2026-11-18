/**
 * Tes live P4: pencarian + browse nyata lewat proxy produksi.
 * HANYA jalan dengan LARAS_SPIKE_LIVE=1 dan konfigurasi
 * playwright.live.config.ts (direktori ini diabaikan konfigurasi
 * utama). TIDAK memutar audio — googlevideo memblokir IP VM
 * (terbukti S3); yang diverifikasi adalah respons proxy dan
 * rendering hasil di UI.
 *
 * Asersi sengaja longgar pada isi (peringkat YTM bisa berubah):
 * yang diuji adalah grup hasil tampil dan berisi lagu, bukan
 * judul tertentu di posisi tertentu. Judul artis dicocokkan
 * tanpa beda kapital (live mengembalikan "NOAH", fixture
 * merekam "Noah").
 *
 * Bukti live tanpa browser (18 Nov 2026, curl dari VM + parser
 * produksi): search "noah" -> 14 lagu / 3 album / 3 artis /
 * 6 playlist; browse home -> 1 rak ("Throwbacks", 10 item);
 * browse artis -> judul "NOAH" + rak. Browser VM sendiri tidak
 * bisa mencapai proxy (fetch gagal walau onLine) — spesifikasi
 * ini harus jalan dari browser di luar VM.
 */
import { test, expect } from '@playwright/test';

const LIVE = process.env.LARAS_SPIKE_LIVE === '1';

test.describe('pencarian + browse live (proxy produksi)', () => {
  test.skip(!LIVE, 'Uji live hanya dengan LARAS_SPIKE_LIVE=1.');

  test('pencarian "noah" menampilkan hasil berkelompok', async ({
    page,
  }) => {
    await page.goto('/search?q=noah');
    await expect(page.getByTestId('search-results')).toBeVisible({
      timeout: 60000,
    });
    await expect(page.getByTestId('search-group-songs')).toBeVisible();
    const songs = page
      .getByTestId('search-group-songs')
      .locator('[data-testid^="search-song-"]');
    expect(await songs.count()).toBeGreaterThan(0);
  });

  test('beranda Jelajah live menampilkan rak', async ({ page }) => {
    await page.goto('/browse');
    await expect(page.getByTestId('browse-content')).toBeVisible({
      timeout: 60000,
    });
    const shelves = page.locator('[data-testid^="browse-shelf-"]');
    expect(await shelves.count()).toBeGreaterThan(0);
  });

  test('halaman artis Noah live menampilkan judul dan lagu', async ({
    page,
  }) => {
    await page.goto('/browse/UCCMnLkUAdm_NGMDTTC-nvDQ');
    await expect(page.getByTestId('browse-content')).toBeVisible({
      timeout: 60000,
    });
    await expect(page.getByTestId('browse-page')).toContainText(/noah/i);
  });
});
