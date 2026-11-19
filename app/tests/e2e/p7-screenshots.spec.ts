/**
 * Screenshot P7 untuk docs/p7/ (bukan tes asersi): panel lirik
 * tersinkron, panel EQ, panel timer tidur di pemutar penuh, dan
 * seksi Akun di Pengaturan — masing-masing 360px + 1440px.
 *
 * Dijalankan lawan server dev + mock (pola p7.spec.ts). Hanya
 * proyek chromium (pola P2/P5/P6). File ditulis ke
 * <repo>/docs/p7/*.png — butuh sandbox TERBUKA.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type Route } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, '..', '..', '..', 'docs', 'p7');
const CONFIG_URL =
  'https://raw.githubusercontent.com/adiprmx/laras/config-v1/player-config.json';
const SYNC_BASE_URL =
  'https://laras-sync.hiroohengkerr.workers.dev';

const FIXTURES = path.join(HERE, 'spikes', 'fixtures');
const TONE_10S = readFileSync(path.join(FIXTURES, 'tone-10s.wav'));
const TONE_60S = readFileSync(path.join(FIXTURES, 'tone-60s.wav'));

async function fulfillRange(
  route: Route,
  buffer: Buffer,
  contentType: string,
): Promise<void> {
  const range = route.request().headers()['range'];
  const match = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
  if (match) {
    const start = match[1] ? parseInt(match[1], 10) : 0;
    const end = match[2]
      ? Math.min(parseInt(match[2], 10), buffer.length - 1)
      : buffer.length - 1;
    const slice = buffer.subarray(start, end + 1);
    await route.fulfill({
      status: 206,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(slice.length),
        'Content-Range': `bytes ${start}-${start + slice.length - 1}/${buffer.length}`,
        'Accept-Ranges': 'bytes',
      },
      body: slice,
    });
    return;
  }
  await route.fulfill({
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(buffer.length),
      'Accept-Ranges': 'bytes',
    },
    body: buffer,
  });
}

async function mockNetwork(page: Page): Promise<void> {
  await page.context().route(CONFIG_URL, (route) =>
    route.fulfill({ status: 500, body: 'mock config gagal' }),
  );
  await page.context().route(/\/__player-test__\/(.+)\.wav/, (route) => {
    const name = route.request().url().split('/').pop() ?? '';
    const buffer = name === 'tone-60s.wav' ? TONE_60S : TONE_10S;
    return fulfillRange(route, buffer, 'audio/wav');
  });
}

async function seedAndPlay(
  page: Page,
  seedId: 'p7-test-seed-lyrics' | 'p7-test-seed-eq',
  doneText: string,
): Promise<void> {
  await page.goto('/p7-test', { waitUntil: 'commit' });
  await page.getByTestId('p7-test-status').waitFor({ timeout: 60000 });
  await page.getByTestId(seedId).click();
  await expect(page.getByTestId('p7-test-status')).toHaveText(doneText, {
    timeout: 30000,
  });
  await page.getByTestId('p7-test-play-60').click();
  await expect(page.getByTestId('mini-player')).toBeVisible({
    timeout: 30000,
  });
  await page.getByTestId('mini-open').click();
  await expect(page.getByTestId('full-player')).toBeVisible({
    timeout: 15000,
  });
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

test.describe('Screenshot P7', () => {
  test('lirik tersinkron di pemutar penuh (360 + 1440)', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'chromium',
      'Screenshot hanya di proyek chromium.',
    );
    await mockNetwork(page);
    await seedAndPlay(page, 'p7-test-seed-lyrics', 'Lirik siap.');
    await page.getByTestId('full-lyrics').click();
    await expect(page.getByTestId('lyrics-synced')).toBeVisible({
      timeout: 15000,
    });
    // Biarkan posisi berjalan sampai baris kedua aktif.
    await page.waitForTimeout(2500);
    await shotBoth(page, 'lyrics', 800, 900);
  });

  test('EQ 10 band di pemutar penuh (360 + 1440)', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'chromium',
      'Screenshot hanya di proyek chromium.',
    );
    await mockNetwork(page);
    await seedAndPlay(page, 'p7-test-seed-eq', 'EQ siap.');
    await page.getByTestId('full-eq').click();
    await expect(page.getByTestId('eq-panel')).toBeVisible({
      timeout: 15000,
    });
    // Seed menulis app_meta, tetapi store EQ dimuat sekali saat
    // init (sebelum seed) — preset Bass dipilih lewat UI supaya
    // screenshot menunjukkan kurva Bass yang sesungguhnya.
    await page.getByTestId('eq-preset-bass').click();
    await expect(page.getByTestId('eq-band-0')).toHaveValue('6', {
      timeout: 5000,
    });
    await page.getByTestId('eq-panel').scrollIntoViewIfNeeded();
    await shotBoth(page, 'eq', 1000, 1000);
  });

  test('timer tidur di pemutar penuh (360 + 1440)', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'chromium',
      'Screenshot hanya di proyek chromium.',
    );
    await mockNetwork(page);
    await page.goto('/p7-test', { waitUntil: 'commit' });
    await page.getByTestId('p7-test-status').waitFor({ timeout: 60000 });
    await page.getByTestId('p7-test-play-60').click();
    await expect(page.getByTestId('mini-player')).toBeVisible({
      timeout: 30000,
    });
    await page.getByTestId('mini-open').click();
    await expect(page.getByTestId('full-player')).toBeVisible({
      timeout: 15000,
    });
    await page.getByTestId('full-sleep-timer').click();
    await expect(page.getByTestId('sleep-timer-panel')).toBeVisible({
      timeout: 15000,
    });
    await page.getByTestId('sleep-option-30').click();
    await expect(page.getByTestId('sleep-timer-active')).toBeVisible({
      timeout: 5000,
    });
    await shotBoth(page, 'sleep-timer', 800, 900);
  });

  test('Pengaturan: seksi Akun sudah masuk (360 + 1440)', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'chromium',
      'Screenshot hanya di proyek chromium.',
    );
    await mockNetwork(page);
    const corsHeaders = {
      'Access-Control-Allow-Origin': 'http://localhost:4173',
      'Access-Control-Allow-Credentials': 'true',
    };
    await page.context().route(`${SYNC_BASE_URL}/api/auth/me`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: corsHeaders,
        body: JSON.stringify({
          success: true,
          data: { displayName: 'Nama Uji', provider: 'google' },
        }),
      }),
    );
    await page.goto('/settings', { waitUntil: 'commit' });
    await expect(page.getByTestId('settings-account-name')).toHaveText(
      'Masuk sebagai Nama Uji',
      { timeout: 30000 },
    );
    // Halaman Pengaturan kini memuat seksi Akun + Lirik di atas
    // seksi lama; viewport tinggi supaya seluruh halaman muat
    // dalam satu tangkapan (bukan fullPage — pola P6).
    await shotBoth(page, 'settings-account', 2200, 2000);
  });
});
