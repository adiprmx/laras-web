/**
 * Tes E2E Backup dan Ekspor P8: round-trip ekspor -> hapus ->
 * impor kembali (library + playlist pulih utuh, file unduhan
 * TIDAK pulih — sesuai desain), impor file rusak ditolak tanpa
 * mengubah database, impor Spotify dari file + dari tautan
 * publik (mock proxy).
 *
 * Semua jaringan di-mock: config gagal (nilai bawaan), search
 * fixture Peterpan (mockP4Network), Worker sync 401 (belum
 * masuk), halaman Spotify dari fixture HTML APK. Tidak ada
 * jaringan nyata.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { mockP4Network, PROXY_BASE_URL } from './p4-helpers';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPOTIFY_HTML = readFileSync(
  path.join(
    HERE,
    '..',
    '..',
    'src',
    'backup',
    'test-fixtures',
    'spotify_playlist.html',
  ),
  'utf-8',
);

const SYNC_BASE_URL = 'https://laras-sync.hiroohengkerr.workers.dev';
// Seed berisi 5 lagu, tapi hitungan "Lagu" hanya menghitung yang
// ada di Library (inLibrary): p8vid-004 sengaja history-only
// (tidak di playlist mana pun, inLibrary false di file seed).
const SEED_COUNTS =
  'Lagu: 4 | Playlist: 1 | Favorit: 1 | Riwayat: 2 | Antrean: 2 | Unduhan: 1';
const EMPTY_COUNTS =
  'Lagu: 0 | Playlist: 0 | Favorit: 0 | Riwayat: 0 | Antrean: 0 | Unduhan: 0';

async function mockNetwork(page: Page): Promise<void> {
  await mockP4Network(page.context());
  // Belum masuk (401): seksi Akun tampil tanpa menunda tes.
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
  await expect(page.getByTestId('p8-test-counts')).toHaveText(SEED_COUNTS, {
    timeout: 30000,
  });
}

async function readCounts(page: Page): Promise<string> {
  await page.goto('/p8-test', { waitUntil: 'commit' });
  await page.getByTestId('p8-test-status').waitFor({ timeout: 60000 });
  await page.getByTestId('p8-test-refresh').click();
  await expect(page.getByTestId('p8-test-status')).toHaveText('Selesai.', {
    timeout: 30000,
  });
  return (await page.getByTestId('p8-test-counts').textContent()) ?? '';
}

async function openSettings(page: Page): Promise<void> {
  await page.goto('/settings', { waitUntil: 'commit' });
  await page.getByTestId('settings-page').waitFor({ timeout: 60000 });
  await page.getByTestId('settings-backup').scrollIntoViewIfNeeded();
}

test.describe('P8: round-trip backup', () => {
  test('ekspor -> hapus -> impor kembali memulihkan library dan playlist', async ({
    page,
  }) => {
    await mockNetwork(page);
    await seedP8(page);
    await openSettings(page);

    // 1. Ekspor: unduh file, periksa isi JSON-nya.
    const downloadPromise = page.waitForEvent('download', {
      timeout: 30000,
    });
    await page.getByTestId('backup-export').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(
      /^backup-musik-\d{8}-\d{6}\.json$/,
    );
    const downloadPath = await download.path();
    expect(downloadPath).not.toBeNull();
    const backupText = readFileSync(downloadPath!, 'utf-8');
    const backup = JSON.parse(backupText) as {
      backupVersion: number;
      songs: Array<{ id: string; downloaded: boolean }>;
      playlists: Array<{ name: string; songIds: string[] }>;
      queue: Array<{ songId: string }>;
    };
    expect(backup.backupVersion).toBe(1);
    expect(backup.songs.length).toBe(5);
    expect(backup.playlists.length).toBe(1);
    expect(backup.playlists[0]?.name).toBe('Favoritku P8');
    expect(backup.playlists[0]?.songIds).toEqual(['p8vid-001', 'p8vid-002']);
    expect(backup.queue.map((q) => q.songId)).toEqual([
      'p8vid-001',
      'p8vid-003',
    ]);
    // Lagu yang terunduh ditandai di salinan (bukan filenya).
    expect(
      backup.songs.find((s) => s.id === 'p8vid-001')?.downloaded,
    ).toBe(true);
    // URL stream TIDAK PERNAH masuk salinan.
    expect(backupText).not.toContain('googlevideo');
    await expect(page.getByTestId('backup-export-result')).toHaveText(
      'Salinan tersimpan. Simpan file-nya baik-baik.',
      { timeout: 15000 },
    );

    // 2. Hapus semua data (dua konfirmasi), dengan "Simpan salinan
    // dulu" di dialog pertama (unduhan kedua membuktikan tombolnya
    // jalan).
    await page.getByTestId('backup-wipe-open').click();
    await expect(page.getByTestId('wipe-dialog')).toBeVisible({
      timeout: 15000,
    });
    const secondDownloadPromise = page.waitForEvent('download', {
      timeout: 30000,
    });
    await page.getByTestId('wipe-save-first').click();
    await secondDownloadPromise;
    await expect(page.getByTestId('wipe-save-note')).toHaveText(
      'Salinan tersimpan. Kamu bisa lanjut menghapus.',
      { timeout: 15000 },
    );
    await page.getByTestId('wipe-next').click();
    await expect(page.getByTestId('wipe-confirm')).toBeVisible({
      timeout: 15000,
    });
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'commit', timeout: 30000 }),
      page.getByTestId('wipe-confirm').click(),
    ]);
    await expect(page.getByTestId('settings-page')).toBeVisible({
      timeout: 30000,
    });

    // 3. Sesudah hapus: app kembali kosong total (database,
    // cache, localStorage).
    expect(await readCounts(page)).toBe(EMPTY_COUNTS);
    // Cache BOLEH bangkit kosong: App membuka laras-downloads-v1
    // di setiap boot (P5, rekonsiliasi unduhan) — sama seperti
    // IndexedDB yang dibuat ulang kosong sesudah dihapus. Yang
    // diverifikasi: tidak ada ISI tersisa di cache mana pun.
    const cacheEntries = await page.evaluate(async () => {
      const names = await caches.keys();
      let total = 0;
      for (const name of names) {
        const cache = await caches.open(name);
        total += (await cache.keys()).length;
      }
      return total;
    });
    expect(cacheEntries).toBe(0);
    const localLeft = await page.evaluate(() =>
      Object.keys(localStorage).filter((k) => k.startsWith('laras.')),
    );
    expect(localLeft).toEqual([]);

    // 4. Impor kembali file salinan: pratinjau -> pulihkan.
    await openSettings(page);
    await page.getByTestId('backup-import-open').click();
    await expect(page.getByTestId('import-backup-dialog')).toBeVisible({
      timeout: 15000,
    });
    await page
      .getByTestId('import-backup-file-input')
      .setInputFiles(downloadPath!);
    await expect(page.getByTestId('import-backup-preview')).toBeVisible({
      timeout: 15000,
    });
    await page.getByTestId('import-backup-restore').click();
    await expect(page.getByTestId('import-report')).toBeVisible({
      timeout: 30000,
    });
    // 5 lagu + 1 playlist + 2 lagu di playlist + 2 riwayat putar
    // + 2 riwayat pencarian + 2 antrean = 14 hal baru.
    await expect(page.getByTestId('import-report-added')).toHaveText(
      '14 hal baru ditambahkan.',
      { timeout: 15000 },
    );
    // Tombol unduh ulang muncul (1 lagu dulu terunduh).
    await expect(
      page.getByTestId('import-backup-redownload'),
    ).toBeVisible({ timeout: 15000 });
    await page.getByTestId('import-backup-close').click();

    // 5. Library + playlist pulih utuh (Lagu 4: p8vid-004 tetap
    // history-only seperti sebelum hapus); file unduhan TIDAK
    // pulih (tidak ikut salinan — pengguna mengunduh ulang manual).
    expect(await readCounts(page)).toBe(
      'Lagu: 4 | Playlist: 1 | Favorit: 1 | Riwayat: 2 | Antrean: 2 | Unduhan: 0',
    );
    await page.goto('/library?tab=playlists', { waitUntil: 'commit' });
    await expect(page.getByText('Favoritku P8')).toBeVisible({
      timeout: 30000,
    });
  });

  test('impor file rusak ditolak tanpa mengubah database', async ({
    page,
  }) => {
    await mockNetwork(page);
    await seedP8(page);
    await openSettings(page);
    await page.getByTestId('backup-import-open').click();
    await expect(page.getByTestId('import-backup-dialog')).toBeVisible({
      timeout: 15000,
    });

    // Bukan JSON sama sekali.
    await page.getByTestId('import-backup-file-input').setInputFiles({
      name: 'rusak.json',
      mimeType: 'application/json',
      buffer: Buffer.from('bukan json sama sekali'),
    });
    await expect(page.getByTestId('import-backup-error')).toHaveText(
      'File ini bukan file salinan yang bisa dibaca.',
      { timeout: 15000 },
    );

    // Versi dari masa depan.
    await page.getByTestId('import-backup-file-input').setInputFiles({
      name: 'baru.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({ backupVersion: 99, appVersion: '9.9.9' }),
      ),
    });
    await expect(page.getByTestId('import-backup-error')).toHaveText(
      'File ini dibuat app yang lebih baru. Perbarui app ini dulu.',
      { timeout: 15000 },
    );

    // Database tidak berubah.
    expect(await readCounts(page)).toBe(SEED_COUNTS);
  });
});

test.describe('P8: impor Spotify', () => {
  test('dari file: yang cocok masuk playlist, yang tidak cocok dilaporkan', async ({
    page,
  }) => {
    await mockNetwork(page);
    await openSettings(page);
    await page.getByTestId('backup-spotify-open').click();
    await expect(page.getByTestId('spotify-import-dialog')).toBeVisible({
      timeout: 15000,
    });
    await page
      .getByTestId('spotify-paste')
      .fill('Peterpan - Semua Tentang Kita\nArtis Tak Ada - Lagu Tak Ada');
    await page.getByTestId('spotify-read-pasted').click();
    await expect(page.getByTestId('spotify-track-count')).toHaveText(
      '2 lagu',
      { timeout: 15000 },
    );
    await expect(page.getByTestId('spotify-playlist-name')).toHaveValue(
      'Impor Spotify',
    );
    await page.getByTestId('spotify-start').click();
    await expect(page.getByTestId('import-report')).toBeVisible({
      timeout: 30000,
    });
    await expect(page.getByTestId('import-report-added')).toHaveText(
      '1 hal baru ditambahkan.',
      { timeout: 15000 },
    );
    await expect(page.getByTestId('import-report-failed')).toHaveText(
      '1 hal tidak bisa masuk.',
      { timeout: 15000 },
    );
    await expect(page.getByTestId('import-report')).toContainText(
      'Artis Tak Ada - Lagu Tak Ada: tidak ketemu di YouTube Music',
    );
    await page.getByTestId('spotify-close').click();

    // Playlist baru berisi 1 lagu yang cocok.
    expect(await readCounts(page)).toBe(
      'Lagu: 1 | Playlist: 1 | Favorit: 0 | Riwayat: 0 | Antrean: 0 | Unduhan: 0',
    );
    await page.goto('/library?tab=playlists', { waitUntil: 'commit' });
    await expect(page.getByText('Impor Spotify')).toBeVisible({
      timeout: 30000,
    });
  });

  test('dari tautan publik (mock proxy): draf terbaca, tidak ada yang cocok', async ({
    page,
  }) => {
    await mockNetwork(page);
    await page.context().route(
      `${PROXY_BASE_URL}/api/spotify-page*`,
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: SPOTIFY_HTML,
        }),
    );
    await openSettings(page);
    await page.getByTestId('backup-spotify-open').click();
    await expect(page.getByTestId('spotify-import-dialog')).toBeVisible({
      timeout: 15000,
    });
    await page.getByTestId('spotify-tab-link').click();
    await page
      .getByTestId('spotify-link-input')
      .fill('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M');
    await page.getByTestId('spotify-fetch-link').click();
    await expect(page.getByTestId('spotify-track-count')).toHaveText(
      '3 lagu',
      { timeout: 30000 },
    );
    await expect(page.getByTestId('spotify-playlist-name')).toHaveValue(
      'Chill Hits',
    );
    await page.getByTestId('spotify-start').click();
    await expect(page.getByTestId('import-report')).toBeVisible({
      timeout: 60000,
    });
    await expect(page.getByTestId('import-report-added')).toHaveText(
      '0 hal baru ditambahkan.',
      { timeout: 15000 },
    );
    // Tidak ada yang cocok -> playlist TIDAK dibuat.
    await expect(page.getByTestId('spotify-import-dialog')).toContainText(
      'Tidak ada lagu yang cocok, jadi playlist tidak dibuat.',
    );
    await page.getByTestId('spotify-close').click();
    expect(await readCounts(page)).toBe(EMPTY_COUNTS);
  });

  test('tautan bukan playlist ditolak dengan pesan jelas', async ({
    page,
  }) => {
    await mockNetwork(page);
    await openSettings(page);
    await page.getByTestId('backup-spotify-open').click();
    await page.getByTestId('spotify-tab-link').click();
    await page
      .getByTestId('spotify-link-input')
      .fill('https://open.spotify.com/track/abc123');
    await page.getByTestId('spotify-fetch-link').click();
    await expect(page.getByTestId('spotify-error')).toHaveText(
      'Tautan ini bukan tautan playlist Spotify.',
      { timeout: 15000 },
    );
  });
});
