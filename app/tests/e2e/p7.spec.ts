/**
 * Tes E2E fitur Should P7: lirik tersinkron (cache + sorot
 * baris aktif), EQ tersimpan antar reload, timer tidur (sisa
 * waktu + batal + sampai lagu selesai), sinkronisasi mock
 * (masuk + tarik/dorong + belum masuk).
 *
 * Semua jaringan di-mock: config gagal (nilai bawaan), nada
 * WAV lokal dari fixture, Worker sync kalengan. Tidak ada
 * jaringan nyata. Pola mock mengikuti player.spec.ts
 * (context.route untuk <audio>, regex untuk localhost).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page, type Route } from '@playwright/test';

const CONFIG_URL =
  'https://raw.githubusercontent.com/adiprmx/laras/config-v1/player-config.json';
const SYNC_BASE_URL =
  'https://laras-sync.hiroohengkerr.workers.dev';

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'spikes',
  'fixtures',
);
const TONE_10S = readFileSync(path.join(FIXTURES, 'tone-10s.wav'));
const TONE_60S = readFileSync(path.join(FIXTURES, 'tone-60s.wav'));

/** Sajikan byte audio dengan dukungan Range (yang dipakai <audio>). */
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

interface DebugState {
  status: string;
  position: number;
  duration: number;
}

async function debugState(page: Page): Promise<DebugState | null> {
  return page.evaluate(() => {
    const hook = (
      window as unknown as {
        __larasPlayer?: { getState: () => DebugState };
      }
    ).__larasPlayer;
    return hook?.getState() ?? null;
  });
}

/** Buka /p7-test, mainkan nada, tunggu status playing. */
async function playTone(
  page: Page,
  which: 'p7-test-play-60' | 'p7-test-play-10',
): Promise<void> {
  await page.goto('/p7-test', { waitUntil: 'commit' });
  await page.getByTestId('p7-test-status').waitFor({ timeout: 60000 });
  await page.getByTestId(which).click();
  await expect(page.getByTestId('mini-player')).toBeVisible({
    timeout: 30000,
  });
  await page.waitForFunction(
    () => {
      const hook = (
        window as unknown as {
          __larasPlayer?: { getState: () => { status: string } };
        }
      ).__larasPlayer;
      return hook?.getState().status === 'playing';
    },
    { timeout: 30000 },
  );
}

async function openFullPlayer(page: Page): Promise<void> {
  await page.getByTestId('mini-open').click();
  await expect(page.getByTestId('full-player')).toBeVisible({
    timeout: 15000,
  });
}

test.describe('P7: lirik', () => {
  test('lirik tersimpan tampil + baris aktif mengikuti waktu putar', async ({
    page,
  }) => {
    await mockNetwork(page);
    await page.goto('/p7-test', { waitUntil: 'commit' });
    await page.getByTestId('p7-test-status').waitFor({ timeout: 60000 });
    await page.getByTestId('p7-test-seed-lyrics').click();
    await expect(page.getByTestId('p7-test-status')).toHaveText('Lirik siap.', {
      timeout: 30000,
    });
    await page.getByTestId('p7-test-play-60').click();
    await expect(page.getByTestId('mini-player')).toBeVisible({
      timeout: 30000,
    });
    await openFullPlayer(page);
    await page.getByTestId('full-lyrics').click();
    await expect(page.getByTestId('lyrics-synced')).toBeVisible({
      timeout: 15000,
    });
    await expect(
      page.getByTestId('lyrics-line').filter({ hasText: 'Baris uji satu' }),
    ).toBeVisible();
    // Tunggu posisi >= 6 detik: baris ketiga (mulai 5 detik)
    // harus aktif, baris pertama sudah tidak aktif.
    await page.waitForFunction(
      () => {
        const hook = (
          window as unknown as {
            __larasPlayer?: { getState: () => { position: number } };
          }
        ).__larasPlayer;
        return (hook?.getState().position ?? 0) >= 6;
      },
      { timeout: 30000 },
    );
    await expect(
      page.getByTestId('lyrics-line').filter({ hasText: 'Baris uji tiga' }),
    ).toHaveAttribute('data-active', 'true', { timeout: 5000 });
    await expect(
      page.getByTestId('lyrics-line').filter({ hasText: 'Baris uji satu' }),
    ).toHaveAttribute('data-active', 'false');
  });

  test('tanpa seed lirik: pemberitahuan privasi muncul sebelum fetch', async ({
    page,
  }) => {
    await mockNetwork(page);
    await playTone(page, 'p7-test-play-60');
    await openFullPlayer(page);
    await page.getByTestId('full-lyrics').click();
    await expect(page.getByTestId('lyrics-notice')).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByTestId('lyrics-accept')).toBeVisible();
  });
});

test.describe('P7: EQ', () => {
  test('ubah band tersimpan dan bertahan sesudah reload', async ({ page }) => {
    await mockNetwork(page);
    await playTone(page, 'p7-test-play-60');
    await openFullPlayer(page);
    await page.getByTestId('full-eq').click();
    await expect(page.getByTestId('eq-panel')).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByTestId('eq-unavailable')).toHaveCount(0);
    await page.getByTestId('eq-band-0').fill('6');
    await expect(page.getByTestId('eq-preset-custom')).toBeVisible({
      timeout: 5000,
    });
    // Reload: pengaturan EQ dibaca dari IndexedDB.
    await page.reload({ waitUntil: 'commit' });
    await page.getByTestId('p7-test-status').waitFor({ timeout: 60000 });
    await page.getByTestId('p7-test-play-60').click();
    await expect(page.getByTestId('mini-player')).toBeVisible({
      timeout: 30000,
    });
    await openFullPlayer(page);
    await page.getByTestId('full-eq').click();
    await expect(page.getByTestId('eq-panel')).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByTestId('eq-band-0')).toHaveValue('6');
  });
});

test.describe('P7: timer tidur', () => {
  test('timer 5 menit menampilkan sisa waktu dan bisa dibatalkan', async ({
    page,
  }) => {
    await mockNetwork(page);
    await playTone(page, 'p7-test-play-60');
    await openFullPlayer(page);
    await page.getByTestId('full-sleep-timer').click();
    await expect(page.getByTestId('sleep-timer-panel')).toBeVisible({
      timeout: 15000,
    });
    await page.getByTestId('sleep-option-5').click();
    await expect(page.getByTestId('sleep-timer-active')).toHaveText(
      'Berhenti dalam 5 menit',
      { timeout: 5000 },
    );
    await expect(page.getByTestId('sleep-remaining')).toBeVisible();
    await page.getByTestId('sleep-cancel').click();
    await expect(page.getByTestId('sleep-timer-active')).toHaveCount(0);
    await expect(page.getByTestId('sleep-remaining')).toHaveCount(0);
  });

  test('timer sampai lagu selesai menghentikan putaran di ujung nada 10 detik', async ({
    page,
  }) => {
    await mockNetwork(page);
    await playTone(page, 'p7-test-play-10');
    await openFullPlayer(page);
    await page.getByTestId('full-sleep-timer').click();
    await expect(page.getByTestId('sleep-timer-panel')).toBeVisible({
      timeout: 15000,
    });
    await page.getByTestId('sleep-option-end').click();
    await expect(page.getByTestId('sleep-timer-active')).toBeVisible({
      timeout: 5000,
    });
    // Nada 10 detik berakhir: status harus paused (bukan
    // playing/loading) dan timer sudah tidak aktif.
    await page.waitForFunction(
      () => {
        const hook = (
          window as unknown as {
            __larasPlayer?: { getState: () => { status: string } };
          }
        ).__larasPlayer;
        return hook?.getState().status === 'paused';
      },
      { timeout: 30000 },
    );
    await expect(page.getByTestId('sleep-timer-active')).toHaveCount(0);
    const state = await debugState(page);
    expect(state?.status).toBe('paused');
  });
});

test.describe('P7: sinkronisasi (mock)', () => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': 'http://localhost:4173',
    'Access-Control-Allow-Credentials': 'true',
  };

  async function mockSignedIn(
    page: Page,
    pushed: Array<Record<string, unknown>>,
  ): Promise<void> {
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
    await page.context().route(`${SYNC_BASE_URL}/api/sync/pull*`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: corsHeaders,
        body: JSON.stringify({
          success: true,
          data: {
            serverTime: 1794784800000,
            playlists: [],
            playlistItems: [],
            likes: [],
            history: [],
            settings: null,
          },
        }),
      }),
    );
    await page
      .context()
      .route(`${SYNC_BASE_URL}/api/sync/push`, (route) => {
        if (route.request().method() === 'OPTIONS') {
          return route.fulfill({
            status: 204,
            headers: {
              ...corsHeaders,
              'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
              'Access-Control-Allow-Headers': 'Content-Type',
            },
          });
        }
        const body = route.request().postDataJSON() as Record<
          string,
          unknown
        >;
        pushed.push(body);
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: corsHeaders,
          body: JSON.stringify({
            success: true,
            data: { serverTime: 1794784801000, applied: 0 },
          }),
        });
      });
  }

  test('sudah masuk: nama tampil, tombol sinkron menarik + mendorong', async ({
    page,
  }) => {
    const pushed: Array<Record<string, unknown>> = [];
    await mockNetwork(page);
    await mockSignedIn(page, pushed);
    await page.goto('/settings', { waitUntil: 'commit' });
    await expect(page.getByTestId('settings-account-name')).toHaveText(
      'Masuk sebagai Nama Uji',
      { timeout: 30000 },
    );
    await expect(page.getByTestId('settings-last-sync')).toHaveText(
      'Belum pernah sinkron',
    );
    await page.getByTestId('settings-sync-now').click();
    await expect(page.getByTestId('settings-last-sync')).not.toHaveText(
      'Belum pernah sinkron',
      { timeout: 30000 },
    );
    expect(pushed.length).toBeGreaterThanOrEqual(1);
    expect(typeof pushed[0].deviceId).toBe('string');
    expect((pushed[0].deviceId as string).length).toBeGreaterThan(0);
  });

  test('belum masuk: tombol masuk tampil dengan tautan Worker yang benar', async ({
    page,
  }) => {
    await mockNetwork(page);
    await page.context().route(`${SYNC_BASE_URL}/api/auth/me`, (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Belum masuk' },
        }),
      }),
    );
    await page.goto('/settings', { waitUntil: 'commit' });
    await expect(page.getByTestId('settings-signin-google')).toBeVisible({
      timeout: 30000,
    });
    await expect(page.getByTestId('settings-signin-google')).toHaveAttribute(
      'href',
      `${SYNC_BASE_URL}/api/auth/login?provider=google`,
    );
    await expect(page.getByTestId('settings-signin-github')).toHaveAttribute(
      'href',
      `${SYNC_BASE_URL}/api/auth/login?provider=github`,
    );
  });
});
