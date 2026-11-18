/**
 * Tes E2E Player Core P2 (rute pencarian + /player-test).
 *
 * Semua jaringan di-mock: config (gagal -> nilai bawaan), proxy
 * search/player (respons kalengan itag 251 URL langsung), dan
 * googlevideo (nada WAV 10 detik, sadar Range). Sejak P4, lagu
 * diputar dari hasil pencarian (fixture search Peterpan) karena
 * seksi "Coba pemutar" di beranda sudah diganti beranda 6 seksi.
 * Uji live HANYA jalan dengan LARAS_SPIKE_LIVE=1 (pola yang sama
 * seperti spike.spec.ts); tanpa guard itu, tes tidak pernah
 * menyentuh jaringan nyata.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page, type Route } from '@playwright/test';
import { SEARCH_PETERPAN } from './p4-helpers';

const PROXY_BASE_URL =
  'https://laras-proxy-spike.hiroohengkerr.workers.dev';
const CONFIG_URL =
  'https://raw.githubusercontent.com/adiprmx/laras/config-v1/player-config.json';
const FAKE_STREAM_URL =
  'https://rr2---sn-q4flrnes.googlevideo.com/videoplayback?expire=1999999999&itag=251&mock=1';

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'spikes',
  'fixtures',
);
const TONE_10S = readFileSync(path.join(FIXTURES, 'tone-10s.wav'));
const TONE_60S = readFileSync(path.join(FIXTURES, 'tone-60s.wav'));
// PNG 1x1 warna #18181b (surface elevated) untuk thumbnail mock
// (hindari jaringan nyata; kotak sampul tampil gelap, bukan hijau).
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQkJAGAACXAEzalQ3FAAAAAElFTkSuQmCC',
  'base64',
);

interface DebugState {
  status: string;
  currentVideoId: string | null;
  audioPath: string | null;
  reResolveCount: number;
  consecutiveFailures: number;
  playbackRate: number;
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

async function mediaSessionState(page: Page): Promise<{
  title: string | null;
  state: string;
}> {
  return page.evaluate(() => ({
    title: navigator.mediaSession.metadata?.title ?? null,
    state: navigator.mediaSession.playbackState,
  }));
}

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

interface MockOptions {
  /** Bila true, endpoint player proxy membalas 500 (uji galat). */
  playerFails?: () => boolean;
}

/** Pasang semua mock jaringan untuk satu halaman.
 *
 * WAJIB `context.route`, BUKAN `page.route`: terbukti empiris
 * (debug-route5.mjs, 2/2 tiap arah) `page.route` TIDAK PERNAH
 * mencegat request elemen `<audio>` ke localhost, sementara
 * `context.route` selalu mencegatnya. Tiap tes memakai konteks
 * baru, jadi rute tidak bocor antar tes. */
async function mockNetwork(page: Page, opts: MockOptions = {}): Promise<void> {
  // Config gagal -> resolver memakai nilai bawaan (deterministik).
  await page.context().route(CONFIG_URL, (route) =>
    route.fulfill({ status: 500, body: 'mock config gagal' }),
  );
  // Fixture search Peterpan (rekaman nyata): membawa visitorData
  // untuk init resolver sekaligus hasil untuk halaman pencarian.
  await page.context().route(`${PROXY_BASE_URL}/api/innertube/search`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: SEARCH_PETERPAN,
    }),
  );
  await page.context().route(`${PROXY_BASE_URL}/api/innertube/player`, (route) => {
    if (opts.playerFails?.()) {
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'MOCK_FAIL' } }),
      });
    }
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
  await page.context().route('**googlevideo.com/videoplayback*', (route) =>
    fulfillRange(route, TONE_10S, 'audio/wav'),
  );
  await page.context().route('**i.ytimg.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: PIXEL_PNG,
    }),
  );
  // Sampul YTM juga dari yt3/lh3 (lihat p4-helpers).
  await page.context().route('**yt3.googleusercontent.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: PIXEL_PNG,
    }),
  );
  await page.context().route('**lh3.googleusercontent.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: PIXEL_PNG,
    }),
  );
  // Regex, bukan glob `**/...`: pola glob yang diawali `**/` tidak
  // cocok dengan URL localhost di Playwright 1.65.1 (terbukti di
  // debug-route2.mjs: hit=0, fallback SPA mengembalikan HTML).
  await page.context().route(/\/__player-test__\/(.+)\.wav/, (route) => {
    const name = route.request().url().split('/').pop() ?? '';
    const buffer = name === 'tone-60s.wav' ? TONE_60S : TONE_10S;
    return fulfillRange(route, buffer, 'audio/wav');
  });
}

/** Putar lagu pertama dari hasil pencarian, tunggu status playing. */
async function playFirstSong(page: Page): Promise<void> {
  await page.goto('/search?q=noah');
  await page.getByTestId('search-song-hhn-nGSuenM').click();
  await expect(page.getByTestId('mini-player')).toBeVisible();
  await expect
    .poll(async () => (await debugState(page))?.status)
    .toBe('playing');
}

test.describe('pemutar (mock resolve + nada lokal)', () => {
  test('memutar, jeda, dan lanjut dari hasil pencarian', async ({ page }) => {
    await mockNetwork(page);
    await playFirstSong(page);
    await expect(page.getByTestId('mini-player')).toContainText(
      'Semua Tentang Kita',
    );
    const first = await debugState(page);
    expect(first?.currentVideoId).toBe('hhn-nGSuenM');
    expect(first?.audioPath).toBe('direct');
    // Posisi maju saat memutar.
    await page.waitForTimeout(1500);
    const second = await debugState(page);
    expect(second?.position ?? 0).toBeGreaterThan(first?.position ?? 0);
    // Jeda lewat bar bawah, lalu lanjut lagi.
    await page.getByTestId('mini-play').click();
    await expect
      .poll(async () => (await debugState(page))?.status)
      .toBe('paused');
    await page.getByTestId('mini-play').click();
    await expect
      .poll(async () => (await debugState(page))?.status)
      .toBe('playing');
  });

  test('next, prev, dan prev sebagai ulang dari awal', async ({ page }) => {
    await mockNetwork(page);
    await playFirstSong(page);
    await page.getByTestId('mini-open').click();
    await expect(page.getByTestId('full-player')).toBeVisible();
    // Next -> lagu kedua.
    await page.getByTestId('full-next').click();
    await expect
      .poll(async () => (await debugState(page))?.currentVideoId)
      .toBe('IQilJm--6cw');
    await expect(page.getByTestId('full-player')).toContainText(
      'Kota Mati',
    );
    // Jeda supaya posisi beku, setel posisi 0, prev -> lagu pertama.
    await page.getByTestId('full-play').click();
    await expect
      .poll(async () => (await debugState(page))?.status)
      .toBe('paused');
    await page.getByTestId('full-seek').fill('0');
    await page.getByTestId('full-prev').click();
    await expect
      .poll(async () => (await debugState(page))?.currentVideoId)
      .toBe('hhn-nGSuenM');
    // Prev saat posisi > 3 detik: mulai ulang lagu yang sama.
    await page.getByTestId('full-seek').fill('5');
    await expect(page.getByTestId('position-label')).toHaveText('0:05');
    await page.getByTestId('full-prev').click();
    await expect(page.getByTestId('position-label')).toHaveText('0:00');
    expect((await debugState(page))?.currentVideoId).toBe('hhn-nGSuenM');
  });

  test('seek, acak, ulang, dan kecepatan', async ({ page }) => {
    await mockNetwork(page);
    await playFirstSong(page);
    await page.getByTestId('mini-open').click();
    await page.getByTestId('full-play').click();
    await expect
      .poll(async () => (await debugState(page))?.status)
      .toBe('paused');
    // Seek ke 5 detik.
    await page.getByTestId('full-seek').fill('5');
    await expect(page.getByTestId('position-label')).toHaveText('0:05');
    // Acak nyala: lagu saat ini tetap pertama di antrean.
    await page.getByTestId('full-shuffle').click();
    await expect(page.getByTestId('full-shuffle')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByTestId('queue-current-mark')).toBeVisible();
    await expect(page.getByTestId('queue-list').locator('li')).toHaveCount(7);
    await page.getByTestId('full-shuffle').click();
    await expect(page.getByTestId('full-shuffle')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    // Ulang: mati -> semua -> satu -> mati.
    await page.getByTestId('full-repeat').click();
    await expect(page.getByTestId('full-repeat')).toHaveAttribute(
      'aria-label',
      'Ulang semua',
    );
    await page.getByTestId('full-repeat').click();
    await expect(page.getByTestId('full-repeat')).toHaveAttribute(
      'aria-label',
      'Ulang satu lagu',
    );
    await page.getByTestId('full-repeat').click();
    await expect(page.getByTestId('full-repeat')).toHaveAttribute(
      'aria-label',
      'Ulang mati',
    );
    // Kecepatan 1,5x.
    await page.getByTestId('full-speed').click();
    await page.getByTestId('speed-option-1.5').click();
    await expect(page.getByTestId('full-speed')).toHaveText('1.5x');
    expect((await debugState(page))?.playbackRate).toBe(1.5);
  });

  test('MediaSession: metadata dan status putar', async ({ page }) => {
    await mockNetwork(page);
    await playFirstSong(page);
    await expect
      .poll(async () => (await mediaSessionState(page)).state)
      .toBe('playing');
    const playing = await mediaSessionState(page);
    expect(playing.title).toBe('Semua Tentang Kita');
    await page.getByTestId('mini-play').click();
    await expect
      .poll(async () => (await mediaSessionState(page)).state)
      .toBe('paused');
  });

  test('antrean bertahan sesudah muat ulang halaman', async ({ page }) => {
    await mockNetwork(page);
    await playFirstSong(page);
    await page.getByTestId('mini-play').click();
    await expect
      .poll(async () => (await debugState(page))?.status)
      .toBe('paused');
    await page.reload();
    await expect(page.getByTestId('mini-player')).toBeVisible();
    await expect(page.getByTestId('mini-player')).toContainText(
      'Semua Tentang Kita',
    );
    expect((await debugState(page))?.status).toBe('paused');
    await page.getByTestId('mini-open').click();
    await expect(page.getByTestId('queue-list').locator('li')).toHaveCount(7);
  });

  test('galat resolve menampilkan pesan dan tombol coba lagi', async ({
    page,
  }) => {
    let failing = true;
    await mockNetwork(page, { playerFails: () => failing });
    await page.goto('/search?q=noah');
    await page.getByTestId('search-song-hhn-nGSuenM').click();
    await page.getByTestId('mini-open').click();
    // Tiga lagu gagal berturut-turut -> berhenti dengan pesan.
    await expect(page.getByTestId('player-error')).toBeVisible({
      timeout: 30000,
    });
    await expect(page.getByTestId('player-error')).toContainText(
      'Lagu tidak bisa diputar sekarang',
    );
    expect((await debugState(page))?.consecutiveFailures).toBe(3);
    // Jaringan pulih -> tombol coba lagi memutar lagu.
    failing = false;
    await page.getByTestId('retry-button').click();
    await expect
      .poll(async () => (await debugState(page))?.status)
      .toBe('playing');
    await expect(page.getByTestId('player-error')).toHaveCount(0);
  });

  test('pengatur suara saat streaming: pesan jujur', async ({ page }) => {
    await mockNetwork(page);
    await playFirstSong(page);
    await page.getByTestId('mini-open').click();
    await page.getByTestId('full-eq').click();
    await expect(page.getByTestId('eq-note')).toContainText(
      'Pengatur suara hanya bisa dipakai untuk lagu yang tersimpan di perangkat.',
    );
  });

  test('nada lokal: jalur graph + pesan pengatur suara lokal', async ({
    page,
  }) => {
    await mockNetwork(page);
    await page.goto('/player-test');
    await page.getByTestId('player-test-play').click();
    await expect(page.getByTestId('player-test-status')).toHaveText(
      'playing',
      { timeout: 10000 },
    );
    await expect(page.getByTestId('player-test-audio-path')).toHaveText(
      'graph',
    );
    await page.getByTestId('player-test-eq').click();
    await expect(page.getByTestId('player-test-eq-note')).toHaveText(
      'Pengatur suara belum tersedia di versi ini.',
    );
  });

  test('cuplikan layar pemutar penuh 360 px dan 1440 px', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'chromium',
      'Cuplikan layar hanya di proyek chromium.',
    );
    await mockNetwork(page);
    await playFirstSong(page);
    await page.getByTestId('mini-open').click();
    await expect(page.getByTestId('full-player')).toBeVisible();
    await page.setViewportSize({ width: 360, height: 640 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'test-results/player-360.png' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'test-results/player-1440.png' });
  });
});

test.describe('uji live pemutar (butuh browser di luar VM)', () => {
  test.skip(
    process.env.LARAS_SPIKE_LIVE !== '1',
    'Uji live butuh browser di luar VM (googlevideo memblokir IP VM).',
  );

  test('lagu kanari pertama memutar dari proxy nyata', async ({ page }) => {
    test.setTimeout(3 * 60 * 1000);
    await page.goto('/search?q=noah');
    await page.getByTestId('search-song-hhn-nGSuenM').click();
    await expect
      .poll(async () => (await debugState(page))?.status, {
        timeout: 120000,
      })
      .toBe('playing');
    await page.waitForTimeout(3000);
    const state = await debugState(page);
    expect(state?.position ?? 0).toBeGreaterThan(0);
  });
});
