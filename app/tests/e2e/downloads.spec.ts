/**
 * Tes E2E unduhan + offline (P5): unduh 10 lagu, putar semua
 * tanpa internet (K8), eviction tidak menghapus unduhan (K9),
 * rekonsiliasi, hapus per lagu + hapus semua.
 *
 * Semua jaringan di-mock: resolve lewat mock player P4 (itag
 * 251), unduhan lewat mock `/api/media` yang melayani nada
 * WAV lokal 10 detik (160.044 byte). Tidak ada unduhan live:
 * googlevideo memblokir IP VM (S3), jadi verifikasi live
 * dicatat sebagai utang luar-VM di docs/p5-downloads-offline.md.
 *
 * WAJIB `context.route`, BUKAN `page.route` (pelajaran P2).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  fulfillRange,
  mockP4Network,
  playerStatus,
  PROXY_BASE_URL,
} from './p4-helpers';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TONE_10S = readFileSync(
  path.join(HERE, 'spikes', 'fixtures', 'tone-10s.wav'),
);

const SONG_IDS = [
  'p5test0001',
  'p5test0002',
  'p5test0003',
  'p5test0004',
  'p5test0005',
  'p5test0006',
  'p5test0007',
  'p5test0008',
  'p5test0009',
  'p5test0010',
] as const;

/** Penghitung request proxy media + googlevideo langsung. */
interface MediaCounters {
  media: number;
  googlevideo: number;
}

async function mockMedia(
  context: BrowserContext,
  counters: MediaCounters,
  opts: { delayMs?: number } = {},
): Promise<void> {
  await context.route(`${PROXY_BASE_URL}/api/media*`, async (route) => {
    counters.media += 1;
    if (opts.delayMs) {
      await new Promise((r) => setTimeout(r, opts.delayMs));
    }
    await fulfillRange(route, TONE_10S, 'audio/wav');
  });
  await context.route('**googlevideo.com/videoplayback*', async (route) => {
    counters.googlevideo += 1;
    await fulfillRange(route, TONE_10S, 'audio/wav');
  });
}

/**
 * Navigasi yang tahan event lifecycle hilang: di VM ini event
 * `load`/`domcontentloaded` kadang tidak pernah sampai ke
 * Playwright (readyState sudah `complete` tapi goto timeout) —
 * pakai `commit` lalu tunggu elemen kunci, bukan lifecycle.
 */
async function gotoCommit(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'commit' });
}

async function seedP5(page: Page): Promise<void> {
  await gotoCommit(page, '/p5-test');
  // Render awal butuh 15-30 dtk di VM berbagi CPU (diukur
  // 18 Nov) — tunggu eksplisit, jangan andalkan timeout aksi.
  await page.getByTestId('p5-test-seed').waitFor({ timeout: 120000 });
  await page.getByTestId('p5-test-seed').click();
  await expect(page.getByTestId('p5-test-status')).toHaveText('Selesai.', {
    timeout: 30000,
  });
}

async function downloadAll(page: Page): Promise<void> {
  await page.getByTestId('p5-test-download-all').click();
  await expect(page.getByTestId('p5-test-status')).toHaveText(
    '10 lagu diantrekan.',
    { timeout: 30000 },
  );
}

/** Tunggu N baris unduhan tampil di /downloads. */
async function waitForDownloadRows(page: Page, count: number): Promise<void> {
  await gotoCommit(page, '/downloads');
  await expect(page.getByTestId('downloads-page')).toBeVisible({
    timeout: 120000,
  });
  for (const id of SONG_IDS.slice(0, count)) {
    await expect(page.getByTestId(`download-row-${id}`)).toBeVisible({
      timeout: 60000,
    });
  }
}

/**
 * Daftarkan SW lalu muat ulang supaya halaman dikendalikan SW.
 * PENTING: tunggu SW AKTIF dulu (install + activate selesai)
 * SEBELUM reload — reload langsung sesudah register() membuat
 * halaman termuat sebelum SW siap, dan poll controller 30 dtk
 * bisa habis duluan di VM berbagi CPU (K8 gagal 2x karena ini).
 */
async function registerServiceWorker(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.register('/sw.js');
    if (reg.active?.state === 'activated') return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 60000);
      const sw = reg.installing ?? reg.waiting;
      if (!sw) {
        clearTimeout(timer);
        resolve();
        return;
      }
      if (sw.state === 'activated') {
        clearTimeout(timer);
        resolve();
        return;
      }
      sw.addEventListener('statechange', () => {
        if (sw.state === 'activated') {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  });
  await page.reload({ waitUntil: 'commit' });
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          navigator.serviceWorker.controller ? 'controlled' : 'none',
        ),
      { timeout: 60000 },
    )
    .toBe('controlled');
}

async function playerDebug(page: Page): Promise<{
  status: string;
  currentVideoId: string | null;
  audioPath: string | null;
}> {
  return page.evaluate(() => {
    const hook = (
      window as unknown as {
        __larasPlayer?: {
          getState: () => {
            status: string;
            currentVideoId: string | null;
            audioPath: string | null;
          };
        };
      }
    ).__larasPlayer;
    return (
      hook?.getState() ?? {
        status: 'none',
        currentVideoId: null,
        audioPath: null,
      }
    );
  });
}

test.describe('unduhan (P5)', () => {
  // 10 lagu x (resolve + 4 chunk) + muat modul dev server di CPU
  // bersama — 60 dtk tidak cukup di VM ini (di CI jauh lebih cepat).
  test.setTimeout(180000);

  test('mengunduh 10 lagu: semua selesai, ukuran tampil', async ({
    page,
    context,
  }) => {
    const counters: MediaCounters = { media: 0, googlevideo: 0 };
    await mockP4Network(context);
    await mockMedia(context, counters);
    await seedP5(page);
    await downloadAll(page);
    await waitForDownloadRows(page, 10);

    // Total: 10 x 160.044 byte = 1.600.440 byte = 1,5 MB.
    await expect(page.getByTestId('storage-download-total')).toContainText(
      '1,5 MB',
    );
    // Per lagu: 160.044 byte = 156 KB.
    await expect(page.getByTestId('download-row-p5test0001')).toContainText(
      '156 KB',
    );
    // Semua unduhan lewat proxy — tidak satu pun request
    // langsung ke googlevideo.
    expect(counters.googlevideo).toBe(0);
    expect(counters.media).toBeGreaterThan(0);
  });

  test('K8: memutar 10 lagu tanpa internet (offline)', async ({
    page,
    context,
  }) => {
    const counters: MediaCounters = { media: 0, googlevideo: 0 };
    await mockP4Network(context);
    await mockMedia(context, counters);
    await seedP5(page);
    await downloadAll(page);
    await waitForDownloadRows(page, 10);
    await registerServiceWorker(page);
    await waitForDownloadRows(page, 10);

    const mediaBeforeOffline = counters.media;
    await context.setOffline(true);
    // TANPA muat ulang: dev server tidak bisa dijangkau offline
    // (JS dari /src/* tidak di-cache), jadi halaman yang sudah
    // dimuat dipakai apa adanya — persis skenario PWA offline.
    for (const id of SONG_IDS) {
      await page.getByTestId(`download-row-${id}`).click();
      await expect
        .poll(() => playerStatus(page), { timeout: 30000 })
        .toBe('playing');
      const debug = await playerDebug(page);
      expect(debug.currentVideoId).toBe(id);
      // Unduhan diputar lewat jalur lokal (graf audio), bukan
      // stream jaringan.
      expect(debug.audioPath).toBe('graph');
    }
    // Selama offline tidak ada satu pun request media keluar:
    // semua audio datang dari Cache Storage lewat SW.
    expect(counters.media).toBe(mediaBeforeOffline);
    expect(counters.googlevideo).toBe(0);
    await context.setOffline(false);
  });

  test('K9: eviction runtime tidak menghapus unduhan', async ({
    page,
    context,
  }) => {
    await mockP4Network(context);
    await mockMedia(context, { media: 0, googlevideo: 0 });
    await seedP5(page);
    await downloadAll(page);
    await waitForDownloadRows(page, 10);

    await gotoCommit(page, '/p5-test');
    await page.getByTestId('p5-test-eviction').waitFor({ timeout: 120000 });
    await page.getByTestId('p5-test-eviction').click();
    await expect(page.getByTestId('p5-test-status')).toContainText(
      'runtime dihapus 3/3',
      { timeout: 30000 },
    );
    await expect(page.getByTestId('p5-test-status')).toContainText(
      'unduhan utuh 10',
    );

    await gotoCommit(page, '/downloads');
    for (const id of SONG_IDS) {
      await expect(page.getByTestId(`download-row-${id}`)).toBeVisible({
        timeout: 60000,
      });
    }
  });

  test('rekonsiliasi: file hilang dibersihkan, file yatim dihapus', async ({
    page,
    context,
  }) => {
    await mockP4Network(context);
    await mockMedia(context, { media: 0, googlevideo: 0 });
    await seedP5(page);
    await downloadAll(page);
    await waitForDownloadRows(page, 10);

    await gotoCommit(page, '/p5-test');
    await page.getByTestId('p5-test-make-orphan').waitFor({ timeout: 120000 });
    await page.getByTestId('p5-test-make-orphan').click();
    await expect(page.getByTestId('p5-test-status')).toHaveText(
      'File yatim dibuat.',
      { timeout: 30000 },
    );
    await page.getByTestId('p5-test-remove-first-file').click();
    await expect(page.getByTestId('p5-test-status')).toHaveText(
      'File lagu 1 dihapus dari cache.',
      { timeout: 30000 },
    );

    // Muat ulang menjalankan rekonsiliasi di App init.
    await page.reload({ waitUntil: 'commit' });
    await gotoCommit(page, '/downloads');
    await expect(page.getByTestId('downloads-page')).toBeVisible({
      timeout: 120000,
    });
    // Lagu 1 kehilangan file: tidak lagi terdaftar sebagai unduhan.
    await expect(
      page.getByTestId('download-row-p5test0001'),
    ).toHaveCount(0);
    // 9 lagu lain tetap ada.
    for (const id of SONG_IDS.slice(1)) {
      await expect(page.getByTestId(`download-row-${id}`)).toBeVisible({
        timeout: 60000,
      });
    }
    // File yatim sudah dibersihkan dari Cache Storage.
    const orphanGone = await page.evaluate(async () => {
      const cache = await caches.open('laras-downloads-v1');
      const keys = await cache.keys();
      return !keys.some((r) => r.url.includes('/dl/p5orphan01'));
    });
    expect(orphanGone).toBe(true);
  });

  test('hapus per lagu lalu hapus semua (2 konfirmasi)', async ({
    page,
    context,
  }) => {
    await mockP4Network(context);
    await mockMedia(context, { media: 0, googlevideo: 0 });
    await seedP5(page);
    await downloadAll(page);
    await waitForDownloadRows(page, 10);

    // Hapus satu lagu (dialog konfirmasi 1 langkah).
    await page.getByTestId('download-delete-p5test0001').click();
    await expect(page.getByTestId('delete-download-dialog')).toBeVisible();
    await page
      .getByTestId('delete-download-dialog')
      .getByRole('button', { name: 'Hapus', exact: true })
      .click();
    await expect(
      page.getByTestId('download-row-p5test0001'),
    ).toHaveCount(0);
    await expect(
      page.getByTestId('download-row-p5test0002'),
    ).toBeVisible();

    // Hapus semua: dua dialog konfirmasi berurutan.
    await page.getByTestId('storage-delete-all').click();
    await expect(page.getByTestId('delete-all-dialog-1')).toBeVisible();
    await page
      .getByTestId('delete-all-dialog-1')
      .getByRole('button', { name: 'Hapus', exact: true })
      .click();
    await expect(page.getByTestId('delete-all-dialog-2')).toBeVisible();
    await page
      .getByTestId('delete-all-dialog-2')
      .getByRole('button', { name: 'Ya, hapus semua' })
      .click();
    await expect(page.getByTestId('downloads-empty')).toBeVisible();
    await expect(page.getByTestId('storage-download-total')).toContainText(
      '0 B',
    );
  });

  test('aktivasi SW tidak menghapus cache unduhan', async ({
    page,
    context,
  }) => {
    await mockP4Network(context);
    await mockMedia(context, { media: 0, googlevideo: 0 });
    await seedP5(page);
    await downloadAll(page);
    await waitForDownloadRows(page, 10);

    // Daftarkan SW: activate-nya menghapus cache shell lama —
    // cache unduhan wajib selamat.
    await registerServiceWorker(page);
    await waitForDownloadRows(page, 10);
    const downloadCount = await page.evaluate(async () => {
      const cache = await caches.open('laras-downloads-v1');
      const keys = await cache.keys();
      return keys.filter((r) => r.url.includes('/dl/')).length;
    });
    expect(downloadCount).toBe(10);
  });

  test('tab Unduhan + "Lihat semua" Unduhan di beranda (utang P4)', async ({
    page,
    context,
  }) => {
    await mockP4Network(context);
    await mockMedia(context, { media: 0, googlevideo: 0 });
    await seedP5(page);
    await downloadAll(page);
    await waitForDownloadRows(page, 10);

    // Tab Unduhan di navigasi bawah.
    await page.getByTestId('nav-downloads').click();
    await expect(page).toHaveURL(/\/downloads$/);
    await expect(page.getByTestId('downloads-page')).toBeVisible({
      timeout: 60000,
    });

    // Beranda: seksi Unduhan + "Lihat semua" menuju /downloads.
    await gotoCommit(page, '/');
    await expect(
      page.getByTestId('home-section-downloads'),
    ).toBeVisible({ timeout: 60000 });
    await expect(
      page.getByTestId('home-section-downloads'),
    ).toContainText('Lagu Uji P5', { timeout: 60000 });
    await page.getByTestId('home-downloads-view-all').click();
    await expect(page).toHaveURL(/\/downloads$/);
  });

  test('PWA: manifest + SW terpasang', async ({ page, context }) => {
    await mockP4Network(context);
    await gotoCommit(page, '/');
    const manifestHref = await page
      .locator('link[rel="manifest"]')
      .getAttribute('href');
    expect(manifestHref).toBeTruthy();
    const manifest = await page.evaluate(async (href) => {
      const res = await fetch(href);
      return res.json() as Promise<{
        name?: string;
        icons?: Array<{ src: string; sizes: string }>;
      }>;
    }, manifestHref);
    expect(manifest.name).toBeTruthy();
    expect(manifest.icons?.length).toBeGreaterThan(0);
    // SW bisa didaftarkan dan aktif.
    await registerServiceWorker(page);
    const swState = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return reg?.active?.state ?? 'none';
    });
    expect(swState).toBe('activated');
  });
});
