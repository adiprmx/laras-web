/**
 * Tes E2E ketahanan P6: banner status 3 tingkat, tombol Periksa
 * pembaruan, kode diagnostik LRS1 + snapshot, K6 (client utama
 * dimatikan di config, lagu tetap jalan).
 *
 * Mock jaringan sendiri (bukan mockP4Network) supaya CONFIG_URL
 * bisa dikendalikan per tes. Semua endpoint lain dimock juga:
 * tanpa mock, request browse/search lolos ke jaringan live dan
 * memperlambat tes dari VM.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  CONFIG_URL,
  FAKE_STREAM_URL,
  fulfillRange,
  PROXY_BASE_URL,
  playerStatus,
  seedP4,
} from './p4-helpers';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TONE_10S = readFileSync(
  path.join(HERE, 'spikes', 'fixtures', 'tone-10s.wav'),
);

const CONFIG_V1 = {
  clients: [
    { clientId: '67', name: 'WEB_REMIX', version: '1.20261110.04.00' },
    { clientId: '2', name: 'MWEB', version: '2.20260708.05.00' },
    {
      clientId: '14',
      name: 'ANDROID_VR',
      requiresScript: false,
      version: '1.65.10',
    },
  ],
  playerHashes: { b559f50c: { signatureTimestamp: 20770 } },
  version: 1,
};

const CONFIG_V2 = {
  ...CONFIG_V1,
  clients: [
    { clientId: '67', name: 'WEB_REMIX', version: '1.20261118.01.00' },
    { clientId: '2', name: 'MWEB', version: '2.20260708.05.00' },
    {
      clientId: '14',
      name: 'ANDROID_VR',
      requiresScript: false,
      version: '1.65.10',
    },
  ],
};

/** Config K6: WEB_REMIX dimatikan (hanya MWEB + ANDROID_VR). */
const CONFIG_NO_WEB_REMIX = {
  clients: [
    { clientId: '2', name: 'MWEB', version: '2.20260708.05.00' },
    {
      clientId: '14',
      name: 'ANDROID_VR',
      requiresScript: false,
      version: '1.65.10',
    },
  ],
  playerHashes: { b559f50c: { signatureTimestamp: 20770 } },
  version: 1,
};

interface MockState {
  /** Config yang disajikan rute CONFIG_URL (bisa diganti per tes). */
  config: unknown;
  /** ClientId yang terlihat di endpoint player (uji K6). */
  playerClients: string[];
  playerCalls: number;
}

function newMockState(config: unknown = CONFIG_V1): MockState {
  return { config, playerClients: [], playerCalls: 0 };
}

async function mockP6Network(
  context: BrowserContext,
  state: MockState,
): Promise<void> {
  await context.route(CONFIG_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(state.config),
    }),
  );
  await context.route(`${PROXY_BASE_URL}/api/innertube/search`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{}',
    }),
  );
  await context.route(`${PROXY_BASE_URL}/api/innertube/browse`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{"contents":{}}',
    }),
  );
  await context.route(`${PROXY_BASE_URL}/api/innertube/player`, (route) => {
    state.playerCalls += 1;
    const clientId = route
      .request()
      .headers()['x-youtube-client-name'];
    if (clientId) state.playerClients.push(clientId);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        playabilityStatus: { status: 'OK' },
        streamingData: {
          adaptiveFormats: [
            {
              itag: 251,
              mimeType: 'audio/webm; codecs="opus"',
              bitrate: 160000,
              url: FAKE_STREAM_URL,
            },
          ],
        },
      }),
    });
  });
  await context.route('**googlevideo.com/videoplayback*', (route) =>
    fulfillRange(route, TONE_10S, 'audio/wav'),
  );
}

async function gotoCommit(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'commit' });
}

async function seed(page: Page, testId: string, doneText: string): Promise<void> {
  await gotoCommit(page, '/p6-test');
  await page.getByTestId('p6-test-page').waitFor({ timeout: 60000 });
  await page.getByTestId(testId).click();
  await expect(page.getByTestId('p6-test-status')).toHaveText(doneText, {
    timeout: 30000,
  });
}

test.describe('Pengaturan + Periksa pembaruan', () => {
  test('halaman Pengaturan terbuka dari header, kode LRS1 tampil', async ({
    page,
    context,
  }) => {
    await mockP6Network(context, newMockState());
    await gotoCommit(page, '/');
    await page.getByTestId('home-page').waitFor({ timeout: 60000 });
    await page.getByTestId('nav-settings').click();
    await page.getByTestId('settings-page').waitFor({ timeout: 30000 });
    await expect(page.getByTestId('check-update')).toBeVisible();
    const code = await page.getByTestId('diagnostic-code').textContent();
    expect(code).toMatch(/^LRS1-[A-Z]{3}-\d{8}-[WMV?X]+-\d+-[RB]\d*-?[ODB?]$/);
    await expect(page.getByTestId('diagnostic-no-failure')).toBeVisible();
    await expect(page.getByTestId('settings-app-version')).toHaveText('0.9.0');
  });

  test('Periksa pembaruan: Diperbarui saat config berubah, Sudah yang terbaru bila sama', async ({
    page,
    context,
  }) => {
    const state = newMockState(CONFIG_V1);
    await mockP6Network(context, state);
    await gotoCommit(page, '/settings');
    await page.getByTestId('settings-page').waitFor({ timeout: 60000 });
    // Klik pertama: mengisi cache (hasilnya tergantung keadaan
    // latar, jadi cukup pastikan ada laporan hasil).
    await page.getByTestId('check-update').click();
    await expect(page.getByTestId('check-update-result')).toHaveText(
      /Diperbarui\.|Sudah yang terbaru\./,
      { timeout: 60000 },
    );
    // Ubah config yang disajikan mock, lalu periksa: isi berbeda
    // dari cache berarti "Diperbarui."
    state.config = CONFIG_V2;
    await page.getByTestId('check-update').click();
    await expect(page.getByTestId('check-update-result')).toHaveText(
      'Diperbarui.',
      { timeout: 60000 },
    );
    // Periksa lagi tanpa perubahan: "Sudah yang terbaru."
    await page.getByTestId('check-update').click();
    await expect(page.getByTestId('check-update-result')).toHaveText(
      'Sudah yang terbaru.',
      { timeout: 60000 },
    );
  });

  test('tombol salin menyalin kode diagnostik ke clipboard', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await mockP6Network(context, newMockState());
    await gotoCommit(page, '/settings');
    await page.getByTestId('settings-page').waitFor({ timeout: 60000 });
    const code = await page.getByTestId('diagnostic-code').textContent();
    await page.getByTestId('copy-diagnostic-code').click();
    await expect(page.getByTestId('copy-diagnostic-code')).toHaveText(
      'Kode tersalin.',
    );
    const pasted = await page.evaluate(() =>
      navigator.clipboard.readText(),
    );
    expect(pasted).toBe(code);
    expect(pasted).not.toContain('http');
  });
});

test.describe('Banner status 3 tingkat', () => {
  test('kanari rusak: banner gangguan + tombol Periksa pembaruan jalan', async ({
    page,
    context,
  }) => {
    await mockP6Network(context, newMockState());
    await seed(page, 'p6-test-seed-canary-broken', 'Kanari broken tersimpan.');
    await gotoCommit(page, '/');
    const banner = page.getByTestId('status-banner');
    await banner.waitFor({ timeout: 30000 });
    await expect(banner).toHaveAttribute('data-level', 'outage');
    await expect(banner).toContainText('Layanan musik sedang bermasalah');
    // Tombol menjalankan pemeriksaan (config + kanari ulang):
    // kanari mock lolos, layanan pulih, banner menghilang.
    await page.getByTestId('status-banner-update').click();
    await expect(banner).toHaveCount(0, { timeout: 60000 });
  });

  test('kanari terganggu: banner peringatan tanpa tombol', async ({
    page,
    context,
  }) => {
    await mockP6Network(context, newMockState());
    await seed(
      page,
      'p6-test-seed-canary-degraded',
      'Kanari degraded tersimpan.',
    );
    await gotoCommit(page, '/');
    const banner = page.getByTestId('status-banner');
    await banner.waitFor({ timeout: 30000 });
    await expect(banner).toHaveAttribute('data-level', 'warning');
    await expect(banner).toContainText('Sebagian lagu mungkin sulit diputar');
    await expect(page.getByTestId('status-banner-update')).toHaveCount(0);
  });

  test('config basi: banner info', async ({ page, context }) => {
    await mockP6Network(context, newMockState());
    await seed(page, 'p6-test-seed-stale-config', 'Config basi tersimpan.');
    await gotoCommit(page, '/');
    const banner = page.getByTestId('status-banner');
    await banner.waitFor({ timeout: 30000 });
    await expect(banner).toHaveAttribute('data-level', 'info');
    await expect(banner).toContainText('Pengaturan lagu memakai cadangan');
  });

  test('kanari normal: tanpa banner', async ({ page, context }) => {
    await mockP6Network(context, newMockState());
    await seed(page, 'p6-test-seed-canary-ok', 'Kanari ok tersimpan.');
    await gotoCommit(page, '/');
    await page.getByTestId('home-page').waitFor({ timeout: 60000 });
    await expect(page.getByTestId('status-banner')).toHaveCount(0);
  });
});

test.describe('Kode diagnostik + snapshot', () => {
  test('snapshot resolve: kode ULR + rincian + log tampil', async ({
    page,
    context,
  }) => {
    await mockP6Network(context, newMockState());
    await seed(
      page,
      'p6-test-seed-snapshot-resolve',
      'Snapshot resolve tersimpan.',
    );
    await gotoCommit(page, '/settings');
    await page.getByTestId('settings-page').waitFor({ timeout: 60000 });
    const code = await page.getByTestId('diagnostic-code').textContent();
    expect(code).toMatch(/^LRS1-ULR-\d{8}-WMV-/);
    await expect(page.getByTestId('snapshot-layer')).toHaveText(
      'Mencari lagu',
    );
    await expect(page.getByTestId('snapshot-client')).toHaveText(
      'ANDROID_VR',
    );
    await expect(page.getByTestId('snapshot-playability')).toHaveText(
      'LOGIN_REQUIRED',
    );
    await expect(page.getByTestId('snapshot-hash')).toHaveText('b559f50c');
    await expect(page.getByTestId('diagnostic-log')).toContainText(
      'gagal cari lagu: WEB_REMIX=LOGIN_REQUIRED',
    );
  });

  test('snapshot engine: kode EFH + letak Memutar lagu (celah APK tertutup)', async ({
    page,
    context,
  }) => {
    await mockP6Network(context, newMockState());
    await seed(
      page,
      'p6-test-seed-snapshot-engine',
      'Snapshot engine tersimpan.',
    );
    await gotoCommit(page, '/settings');
    await page.getByTestId('settings-page').waitFor({ timeout: 60000 });
    const code = await page.getByTestId('diagnostic-code').textContent();
    expect(code).toMatch(/^LRS1-EFH-\d{8}-W-/);
    await expect(page.getByTestId('snapshot-layer')).toHaveText(
      'Memutar lagu',
    );
    await expect(page.getByTestId('diagnostic-log')).toContainText(
      'pemutar gagal kode 4 di 0:42',
    );
  });
});

test.describe('K6: client utama dimatikan di config', () => {
  test('WEB_REMIX tidak dicoba, lagu tetap jalan lewat MWEB', async ({
    page,
    context,
  }) => {
    const state = newMockState(CONFIG_NO_WEB_REMIX);
    await mockP6Network(context, state);
    await seedP4(page);
    await gotoCommit(page, '/');
    await page.getByTestId('home-page').waitFor({ timeout: 60000 });
    // Lagu pertama di "Lagu untukmu" (seed P4 deterministik).
    const firstTrack = page.locator('[data-testid^="home-for-you-"]').first();
    await firstTrack.waitFor({ timeout: 30000 });
    await firstTrack.click();
    await expect
      .poll(async () => playerStatus(page), { timeout: 60000 })
      .toBe('playing');
    expect(state.playerClients.length).toBeGreaterThan(0);
    expect(state.playerClients).not.toContain('67');
    expect(state.playerClients).toContain('2');
  });
});
