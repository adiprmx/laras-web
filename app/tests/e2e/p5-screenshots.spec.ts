/**
 * Screenshot P5 untuk docs/p5/ (bukan tes asersi): layar
 * Penyimpanan berisi 10 unduhan, unduhan sedang berjalan, dan
 * main offline — masing-masing 360px + 1440px.
 *
 * Dijalankan lawan server dev + mock (pola downloads.spec.ts).
 * Hanya proyek chromium (pola P2): screenshot di mobile diskip.
 * File ditulis ke <repo>/docs/p5/*.png — butuh sandbox TERBUKA
 * (tulis exec diblokir saat TERBATAS; lihat p5-log.md).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { mockP4Network, playerStatus, PROXY_BASE_URL } from './p4-helpers';
import { readFileSync } from 'node:fs';
import { fulfillRange } from './p4-helpers';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, '..', '..', '..', 'docs', 'p5');
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

/** Navigasi tahan event lifecycle hilang (lihat downloads.spec.ts). */
async function gotoCommit(page: import('@playwright/test').Page, url: string) {
  await page.goto(url, { waitUntil: 'commit' });
}

async function seedAndQueue(page: import('@playwright/test').Page) {
  await gotoCommit(page, '/p5-test');
  await page.getByTestId('p5-test-seed').waitFor({ timeout: 120000 });
  await page.getByTestId('p5-test-seed').click();
  await expect(page.getByTestId('p5-test-status')).toHaveText('Selesai.', {
    timeout: 30000,
  });
  await page.getByTestId('p5-test-download-all').click();
  await expect(page.getByTestId('p5-test-status')).toHaveText(
    '10 lagu diantrekan.',
    { timeout: 30000 },
  );
}

async function waitForDownloadRows(
  page: import('@playwright/test').Page,
  count: number,
) {
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

test.describe('screenshot P5', () => {
  // Sama seperti downloads.spec.ts: 10 unduhan + CPU bersama.
  test.setTimeout(180000);

  test('layar Penyimpanan berisi 10 unduhan', async (
    { page, context },
    testInfo,
  ) => {
    test.skip(
      testInfo.project.name !== 'chromium',
      'Screenshot hanya di proyek chromium (pola P2).',
    );
    await mockP4Network(context);
    await context.route(`${PROXY_BASE_URL}/api/media*`, async (route) => {
      await fulfillRange(route, TONE_10S, 'audio/wav');
    });
    await seedAndQueue(page);
    await waitForDownloadRows(page, 10);

    await page.setViewportSize({ width: 360, height: 640 });
    await page.waitForTimeout(500);
    // 360px: foto viewport SAJA (bukan fullPage) — fullPage
    // menempel nav bawah (fixed) di tengah gambar.
    await page.screenshot({
      path: path.join(SHOTS, 'storage-360.png'),
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(500);
    await page.screenshot({
      path: path.join(SHOTS, 'storage-1440.png'),
      fullPage: true,
    });
  });

  test('unduhan sedang berjalan', async ({ page, context }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'chromium',
      'Screenshot hanya di proyek chromium (pola P2).',
    );
    await mockP4Network(context);
    // Perlambat tiap chunk supaya kartu progres sempat difoto.
    await context.route(`${PROXY_BASE_URL}/api/media*`, async (route) => {
      await new Promise((r) => setTimeout(r, 4000));
      await fulfillRange(route, TONE_10S, 'audio/wav');
    });
    await gotoCommit(page, '/p5-test');
    await page.getByTestId('p5-test-seed').waitFor({ timeout: 120000 });
    await page.getByTestId('p5-test-seed').click();
    await expect(page.getByTestId('p5-test-status')).toHaveText('Selesai.', {
      timeout: 30000,
    });
    await page.getByTestId('p5-test-download-all').click();
    await gotoCommit(page, '/downloads');
    await expect(
      page.getByTestId('download-active-p5test0001'),
    ).toBeVisible({ timeout: 60000 });

    await page.setViewportSize({ width: 360, height: 640 });
    await page.waitForTimeout(500);
    await page.screenshot({
      path: path.join(SHOTS, 'downloading-360.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(500);
    await page.screenshot({
      path: path.join(SHOTS, 'downloading-1440.png'),
      fullPage: true,
    });
  });

  test('main offline', async ({ page, context }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'chromium',
      'Screenshot hanya di proyek chromium (pola P2).',
    );
    await mockP4Network(context);
    await context.route(`${PROXY_BASE_URL}/api/media*`, async (route) => {
      await fulfillRange(route, TONE_10S, 'audio/wav');
    });
    await seedAndQueue(page);
    await waitForDownloadRows(page, 10);
    // Tunggu SW AKTIF sebelum reload (pola registerServiceWorker
    // di downloads.spec.ts — poll 30 dtk tanpa ini gagal 2x).
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
    await gotoCommit(page, '/downloads');
    await expect(page.getByTestId('download-row-p5test0001')).toBeVisible({
      timeout: 60000,
    });
    await context.setOffline(true);
    await page.getByTestId('download-row-p5test0001').click();
    await expect
      .poll(() => playerStatus(page), { timeout: 30000 })
      .toBe('playing');

    await page.setViewportSize({ width: 360, height: 640 });
    await page.waitForTimeout(500);
    // 360px: foto viewport saja (nav bawah fixed menempel di
    // tengah gambar bila fullPage — artefak screenshot).
    await page.screenshot({
      path: path.join(SHOTS, 'offline-360.png'),
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(500);
    await page.screenshot({
      path: path.join(SHOTS, 'offline-1440.png'),
      fullPage: true,
    });
    await context.setOffline(false);
  });
});
