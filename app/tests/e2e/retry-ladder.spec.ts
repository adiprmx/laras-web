/**
 * Tes E2E tangga retry latar (hotfix resolve): tangga mulai
 * sesudah tangga cepat P6 gagal LOGIN_REQUIRED murni (notice
 * jujur + lagu tetap di antrean + tenggat +60 dtk), sinyal
 * kanari gagal-baru melewati putaran cepat (3 request, bukan 9),
 * dan skip membatalkan retry.
 *
 * Percobaan latar yang MENYALA (+60 dtk / +5 mnt) TIDAK diuji di
 * sini — menunggu 60 dtk nyata per tes terlalu lambat dan rapuh
 * di VM berbeban; penembakan tangga dibuktikan tes unit Vitest
 * dengan jam palsu (service.retryLadder.test.ts). E2E membuktikan
 * penjadwalan + UI + pembatalan di browser nyata.
 *
 * Mock jaringan sendiri (pola resilience.spec.ts): config V1
 * disajikan, search memakai fixture Peterpan, player memakai
 * skenario per tes, googlevideo memakai nada WAV lokal.
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
  SEARCH_PETERPAN,
} from './p4-helpers';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TONE_10S = readFileSync(
  path.join(HERE, 'spikes', 'fixtures', 'tone-10s.wav'),
);
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQkJAGAACXAEzalQ3FAAAAAElFTkSuQmCC',
  'base64',
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

const SONG_1 = 'hhn-nGSuenM';
const SONG_2 = 'IQilJm--6cw';

interface PlayerCall {
  videoId: string;
  clientId: string;
}

interface MockState {
  /** Playability per videoId ('LOGIN_REQUIRED' = jendela buruk). */
  statusFor: (videoId: string) => 'LOGIN_REQUIRED' | 'OK';
  playerCalls: PlayerCall[];
}

interface DebugState {
  status: string;
  currentVideoId: string | null;
  retryLadder: {
    videoId: string;
    step: number;
    nextAttemptAt: number;
  } | null;
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

async function mockLadderNetwork(
  context: BrowserContext,
  state: MockState,
): Promise<void> {
  await context.route(CONFIG_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(CONFIG_V1),
    }),
  );
  await context.route(`${PROXY_BASE_URL}/api/innertube/search`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: SEARCH_PETERPAN,
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
    const body = route.request().postDataJSON() as {
      videoId?: unknown;
    } | null;
    const videoId =
      typeof body?.videoId === 'string' ? body.videoId : '?';
    const clientId =
      route.request().headers()['x-youtube-client-name'] ?? '?';
    state.playerCalls.push({ videoId, clientId });
    const status = state.statusFor(videoId);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        playabilityStatus: { status },
        streamingData: {
          adaptiveFormats:
            status === 'OK'
              ? [
                  {
                    itag: 251,
                    mimeType: 'audio/webm; codecs="opus"',
                    bitrate: 160000,
                    url: FAKE_STREAM_URL,
                  },
                ]
              : [],
        },
      }),
    });
  });
  await context.route('**googlevideo.com/videoplayback*', (route) =>
    fulfillRange(route, TONE_10S, 'audio/wav'),
  );
  for (const host of [
    '**i.ytimg.com/**',
    '**yt3.googleusercontent.com/**',
    '**lh3.googleusercontent.com/**',
  ]) {
    await context.route(host, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: PIXEL_PNG,
      }),
    );
  }
}

async function gotoCommit(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'commit' });
}

/** Putar lagu pertama dari hasil pencarian, buka pemutar penuh. */
async function playFirstSong(page: Page): Promise<void> {
  await gotoCommit(page, '/search?q=noah');
  await page.getByTestId(`search-song-${SONG_1}`).click();
  await expect(page.getByTestId('mini-player')).toBeVisible({
    timeout: 30000,
  });
  await page.getByTestId('mini-open').click();
  await expect(page.getByTestId('full-player')).toBeVisible();
}

async function seedCanaryBroken(page: Page): Promise<void> {
  await gotoCommit(page, '/p6-test');
  await page.getByTestId('p6-test-page').waitFor({ timeout: 60000 });
  await page.getByTestId('p6-test-seed-canary-broken').click();
  await expect(page.getByTestId('p6-test-status')).toHaveText(
    'Kanari broken tersimpan.',
    { timeout: 30000 },
  );
}

/**
 * Seed kanari NORMAL (segar): menonaktifkan cek kanari harian
 * selama tes (rekaman segar = belum jatuh tempo). WAJIB di tes
 * yang menghitung request player lagu pertama — lagu itu
 * (hhn-nGSuenM) adalah lagu kanari #1, dan cek kanari latar
 * (StrictMode double-mount di dev = 2x jalan) akan menambah
 * 6 request untuk videoId yang sama sehingga hitungan kacau.
 * Sinyalnya 'recent-pass', jadi resolve berjalan normal.
 */
async function seedCanaryOk(page: Page): Promise<void> {
  await gotoCommit(page, '/p6-test');
  await page.getByTestId('p6-test-page').waitFor({ timeout: 60000 });
  await page.getByTestId('p6-test-seed-canary-ok').click();
  await expect(page.getByTestId('p6-test-status')).toHaveText(
    'Kanari ok tersimpan.',
    { timeout: 30000 },
  );
}

test.describe('tangga retry latar', () => {
  test('tangga mulai: notice jujur + lagu tetap + tenggat +60 dtk', async ({
    page,
    context,
  }) => {
    test.setTimeout(120000);
    const state: MockState = {
      statusFor: () => 'LOGIN_REQUIRED',
      playerCalls: [],
    };
    await mockLadderNetwork(context, state);
    await seedCanaryOk(page);
    await playFirstSong(page);
    // Tangga cepat P6 (~20 dtk) lalu notice tangga latar muncul.
    const notice = page.getByTestId('player-notice');
    await expect(notice).toContainText(
      'YouTube sedang membatasi, mencoba lagi otomatis.',
      { timeout: 60000 },
    );
    // Lagu tetap di antrean sebagai lagu saat ini, status loading.
    const debug = await debugState(page);
    expect(debug?.status).toBe('loading');
    expect(debug?.currentVideoId).toBe(SONG_1);
    // Tangga latar dijadwalkan: langkah 0, tenggat ~60 dtk ke depan.
    expect(debug?.retryLadder).not.toBeNull();
    expect(debug?.retryLadder?.videoId).toBe(SONG_1);
    expect(debug?.retryLadder?.step).toBe(0);
    const now = Date.now();
    expect(debug?.retryLadder?.nextAttemptAt ?? 0).toBeGreaterThan(
      now + 30_000,
    );
    expect(debug?.retryLadder?.nextAttemptAt ?? 0).toBeLessThanOrEqual(
      now + 70_000,
    );
    // Tangga cepat: 3 putaran x 3 client = 9 request untuk lagu ini
    // (panggilan kanari latar untuk videoId lain tidak dihitung).
    const songCalls = state.playerCalls.filter(
      (c) => c.videoId === SONG_1,
    );
    expect(songCalls).toHaveLength(9);
  });

  test('kanari gagal baru-baru ini: putaran cepat dilewati (3 request)', async ({
    page,
    context,
  }) => {
    test.setTimeout(120000);
    const state: MockState = {
      statusFor: () => 'LOGIN_REQUIRED',
      playerCalls: [],
    };
    await mockLadderNetwork(context, state);
    await seedCanaryBroken(page);
    await playFirstSong(page);
    const notice = page.getByTestId('player-notice');
    await expect(notice).toContainText(
      'YouTube sedang membatasi, mencoba lagi otomatis.',
      { timeout: 60000 },
    );
    // Hanya 1 putaran (3 request): putaran cepat yang hampir pasti
    // gagal tidak dibuang saat kanari baru saja gagal menolak.
    const songCalls = state.playerCalls.filter(
      (c) => c.videoId === SONG_1,
    );
    expect(songCalls).toHaveLength(3);
    const debug = await debugState(page);
    expect(debug?.retryLadder).not.toBeNull();
    expect(debug?.currentVideoId).toBe(SONG_1);
  });

  test('skip saat tangga berjalan membatalkan retry', async ({
    page,
    context,
  }) => {
    test.setTimeout(120000);
    const state: MockState = {
      statusFor: (videoId) =>
        videoId === SONG_1 ? 'LOGIN_REQUIRED' : 'OK',
      playerCalls: [],
    };
    await mockLadderNetwork(context, state);
    await seedCanaryOk(page);
    await playFirstSong(page);
    await expect(page.getByTestId('player-notice')).toContainText(
      'YouTube sedang membatasi, mencoba lagi otomatis.',
      { timeout: 60000 },
    );
    await expect
      .poll(async () => (await debugState(page))?.retryLadder)
      .not.toBeNull();
    const callsBefore = state.playerCalls.filter(
      (c) => c.videoId === SONG_1,
    ).length;
    expect(callsBefore).toBe(9);
    // Skip ke lagu berikut: lagu 2 langsung diputar, tangga batal.
    await page.getByTestId('full-next').click();
    await expect
      .poll(async () => (await debugState(page))?.currentVideoId)
      .toBe(SONG_2);
    await expect
      .poll(async () => (await debugState(page))?.status)
      .toBe('playing');
    expect((await debugState(page))?.retryLadder).toBeNull();
    // Tidak ada percobaan latar susulan untuk lagu 1.
    await page.waitForTimeout(3000);
    const callsAfter = state.playerCalls.filter(
      (c) => c.videoId === SONG_1,
    ).length;
    expect(callsAfter).toBe(callsBefore);
  });
});
