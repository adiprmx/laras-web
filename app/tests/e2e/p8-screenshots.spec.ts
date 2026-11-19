/**
 * Screenshot P8 untuk docs/p8/ (bukan tes asersi): seksi Salinan
 * data di Pengaturan, dialog impor salinan (pratinjau), dialog
 * hapus data, dan dialog impor Spotify — masing-masing 360px +
 * 1440px.
 *
 * Dijalankan lawan server dev + mock (pola p8.spec.ts). Hanya
 * proyek chromium (pola P2/P5/P6/P7). File ditulis ke
 * <repo>/docs/p8/*.png — butuh sandbox TERBUKA.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { mockP4Network } from './p4-helpers';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, '..', '..', '..', 'docs', 'p8');

const SYNC_BASE_URL = 'https://laras-sync.hiroohengkerr.workers.dev';

async function mockNetwork(page: Page): Promise<void> {
  await mockP4Network(page.context());
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
        error: { code: 'UNAUTHENTICATED', message: 'Belum masuk' },
      }),
    }),
  );
}

async function seedP8(page: Page): Promise<void> {
  await page.goto('/p8-test', { waitUntil: 'commit' });
  await page.getByTestId('p8-test-status').waitFor({ timeout: 60000 });
  await page.getByTestId('p8-test-seed').click();
  await expect(page.getByTestId('p8-test-status')).toHaveText('Selesai.', {
    timeout: 30000,
  });
}

async function openSettings(page: Page): Promise<void> {
  await page.goto('/settings', { waitUntil: 'commit' });
  await page.getByTestId('settings-page').waitFor({ timeout: 60000 });
  await page.getByTestId('settings-backup').scrollIntoViewIfNeeded();
}

async function shotBoth(
  page: Page,
  file: string,
  height360: number,
  height1440: number,
): Promise<void> {
  await page.setViewportSize({ width: 360, height: height360 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, `${file}-360.png`) });
  await page.setViewportSize({ width: 1440, height: height1440 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, `${file}-1440.png`) });
}

const SAMPLE_BACKUP = JSON.stringify({
  backupVersion: 1,
  appVersion: '0.9.0',
  exportedAt: '2026-11-19T02:00:00.000Z',
  songs: [
    {
      id: 'p8vid-001',
      title: 'Lagu Uji P8 Satu',
      artists: [{ id: 'UC-P8-1', name: 'Artis Uji P8' }],
      albumId: null,
      durationSeconds: 200,
      thumbnailUrl: null,
      liked: true,
      inLibrary: true,
      totalPlayTimeMs: 60000,
      dateAdded: 1791926400000,
      downloaded: false,
      unplayable: false,
    },
    {
      id: 'p8vid-002',
      title: 'Lagu Uji P8 Dua',
      artists: [{ id: 'UC-P8-1', name: 'Artis Uji P8' }],
      albumId: null,
      durationSeconds: 180,
      thumbnailUrl: null,
      liked: false,
      inLibrary: true,
      totalPlayTimeMs: 0,
      dateAdded: 1791926400000,
      downloaded: false,
      unplayable: false,
    },
  ],
  albums: [],
  artists: [{ id: 'UC-P8-1', name: 'Artis Uji P8' }],
  playlists: [
    {
      name: 'Favoritku P8',
      description: 'Playlist uji P8',
      songIds: ['p8vid-001', 'p8vid-002'],
      createdAt: 1792099200000,
    },
  ],
  playEvents: [
    { songId: 'p8vid-001', timestamp: 1792519200000, playTimeMs: 120000 },
  ],
  searchHistory: [{ query: 'p8 uji', timestamp: 1792515600000 }],
  queue: [{ songId: 'p8vid-001', source: 'library' }],
  playbackState: null,
  settings: { sortSongs: 'byName' },
});

test.describe('Screenshot P8', () => {
  test('seksi Salinan data di Pengaturan (360 + 1440)', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'chromium',
      'Screenshot hanya di proyek chromium.',
    );
    await mockNetwork(page);
    await seedP8(page);
    await openSettings(page);
    // Gulir seksi ke ATAS viewport: scrollIntoViewIfNeeded
    // menaruhnya di bawah, tertutup mini-player di 360px.
    await page
      .getByTestId('settings-backup')
      .evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(300);
    await shotBoth(page, 'backup-section', 800, 900);
  });

  test('dialog impor salinan, pratinjau isi (360 + 1440)', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'chromium',
      'Screenshot hanya di proyek chromium.',
    );
    await mockNetwork(page);
    await openSettings(page);
    await page.getByTestId('backup-import-open').click();
    await expect(page.getByTestId('import-backup-dialog')).toBeVisible({
      timeout: 15000,
    });
    await page.getByTestId('import-backup-file-input').setInputFiles({
      name: 'backup-musik-20261119-020000.json',
      mimeType: 'application/json',
      buffer: Buffer.from(SAMPLE_BACKUP),
    });
    await expect(page.getByTestId('import-backup-preview')).toBeVisible({
      timeout: 15000,
    });
    await shotBoth(page, 'import-dialog', 800, 900);
  });

  test('dialog hapus data, konfirmasi pertama (360 + 1440)', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'chromium',
      'Screenshot hanya di proyek chromium.',
    );
    await mockNetwork(page);
    await seedP8(page);
    await openSettings(page);
    await page.getByTestId('backup-wipe-open').click();
    await expect(page.getByTestId('wipe-dialog')).toBeVisible({
      timeout: 15000,
    });
    await shotBoth(page, 'wipe-dialog', 800, 900);
  });

  test('dialog impor Spotify, draf dari teks tempel (360 + 1440)', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'chromium',
      'Screenshot hanya di proyek chromium.',
    );
    await mockNetwork(page);
    await openSettings(page);
    await page.getByTestId('backup-spotify-open').click();
    await expect(page.getByTestId('spotify-import-dialog')).toBeVisible({
      timeout: 15000,
    });
    await page
      .getByTestId('spotify-paste')
      .fill('Peterpan - Semua Tentang Kita\nNOAH - Separuh Aku');
    await page.getByTestId('spotify-read-pasted').click();
    await expect(page.getByTestId('spotify-track-count')).toHaveText(
      '2 lagu',
      { timeout: 15000 },
    );
    await shotBoth(page, 'spotify-dialog', 800, 900);
  });
});
