/**
 * Helper E2E P4 (pencarian + beranda + browse): mock jaringan
 * bersama dan seeder skenario /p4-test.
 *
 * Semua respons search/browse/saran berasal dari rekaman nyata
 * (src/extractor/test-fixtures/, direkam 15–16 Nov 2026 dari
 * akun APK — dipakai juga oleh tes unit parser). Tidak ada
 * jaringan live: config gagal (nilai bawaan), stream dari nada
 * WAV lokal, thumbnail dari PNG 1x1 warna #18181b (bukan hijau).
 *
 * WAJIB `context.route`, BUKAN `page.route` (pelajaran P2:
 * page.route tidak mencegat request <audio> ke localhost).
 * Pola glob yang diawali bintang ganda tidak cocok dengan URL
 * localhost — pakai regex untuk rute lokal.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type BrowserContext, type Page, type Route } from '@playwright/test';

export const PROXY_BASE_URL =
  'https://laras-proxy-spike.hiroohengkerr.workers.dev';
export const CONFIG_URL =
  'https://raw.githubusercontent.com/adiprmx/laras/config-v1/player-config.json';
export const FAKE_STREAM_URL =
  'https://rr2---sn-q4flrnes.googlevideo.com/videoplayback?expire=1999999999&itag=251&mock=1';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTRACTOR_FIXTURES = path.join(HERE, '..', '..', 'src', 'extractor', 'test-fixtures');
const TONE_FIXTURES = path.join(HERE, 'spikes', 'fixtures');

export const SEARCH_PETERPAN = readFileSync(
  path.join(EXTRACTOR_FIXTURES, 'search-peterpan.json'),
  'utf8',
);
const BROWSE_HOME = readFileSync(
  path.join(EXTRACTOR_FIXTURES, 'browse-home.json'),
  'utf8',
);
const BROWSE_MOODS = readFileSync(
  path.join(EXTRACTOR_FIXTURES, 'browse-moods.json'),
  'utf8',
);
const BROWSE_ARTIST = readFileSync(
  path.join(EXTRACTOR_FIXTURES, 'browse-artist.json'),
  'utf8',
);
const BROWSE_ALBUM = readFileSync(
  path.join(EXTRACTOR_FIXTURES, 'browse-album.json'),
  'utf8',
);
const BROWSE_PLAYLIST = readFileSync(
  path.join(EXTRACTOR_FIXTURES, 'browse-playlist.json'),
  'utf8',
);
const SUGGEST_NOAH = readFileSync(
  path.join(EXTRACTOR_FIXTURES, 'suggest-noah.json'),
  'utf8',
);

const TONE_10S = readFileSync(path.join(TONE_FIXTURES, 'tone-10s.wav'));
// PNG 1x1 warna #18181b (surface elevated) — pola player.spec.ts.
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQkJAGAACXAEzalQ3FAAAAAElFTkSuQmCC',
  'base64',
);

/** Penghitung permintaan per endpoint (untuk uji "tanpa panggil server"). */
export interface P4Counters {
  search: number;
  browse: number;
  suggestions: number;
  player: number;
}

export function newCounters(): P4Counters {
  return { search: 0, browse: 0, suggestions: 0, player: 0 };
}

/** Sajikan byte audio dengan dukungan Range (yang dipakai <audio>). */
export async function fulfillRange(
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

/**
 * Perluas fixture search menjadi 21 lagu: tiap item daftar lagu
 * digandakan 2x dengan videoId bersufiks (-c1/-c2), begitu juga
 * kartu hasil teratas (1 lagu dari musicCardShelfRenderer).
 * 7 lagu asli x 3 = 21. Dipakai uji "Lihat semua" (tombol hanya
 * muncul bila hasil > 10). Judul dibiarkan sama — yang diuji
 * jumlah baris dan perilaku tombol, bukan keragaman judul.
 */
export function expandSearchFixture(): string {
  const root: unknown = JSON.parse(SEARCH_PETERPAN);
  const cloneWithNewId = (item: unknown, suffix: string): unknown => {
    const text = JSON.stringify(item);
    const idMatch = /"videoId":"([^"]+)"/.exec(text);
    if (!idMatch) return JSON.parse(text) as unknown;
    const replaced = text.replaceAll(
      `"${idMatch[1]}"`,
      `"${idMatch[1]}${suffix}"`,
    );
    return JSON.parse(replaced) as unknown;
  };
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      const listItems = node.filter(
        (child) =>
          typeof child === 'object' &&
          child !== null &&
          'musicResponsiveListItemRenderer' in child,
      );
      for (const item of listItems) {
        node.push(cloneWithNewId(item, '-c1'));
        node.push(cloneWithNewId(item, '-c2'));
      }
      // Kartu hasil teratas (musicCardShelfRenderer) juga menyumbang
      // satu lagu — gandakan bagiannya supaya ikut terhitung.
      const cardSections = node.filter(
        (child) =>
          typeof child === 'object' &&
          child !== null &&
          'musicCardShelfRenderer' in child,
      );
      for (const item of cardSections) {
        node.push(cloneWithNewId(item, '-c1'));
        node.push(cloneWithNewId(item, '-c2'));
      }
      for (const child of node) walk(child);
    } else if (typeof node === 'object' && node !== null) {
      for (const value of Object.values(node)) walk(value);
    }
  };
  walk(root);
  return JSON.stringify(root);
}

export interface MockP4Options {
  counters?: P4Counters;
  /** Bila true, endpoint search membalas 500 (uji galat/offline). */
  searchFails?: () => boolean;
  /** Bila true, endpoint browse membalas 500. */
  browseFails?: () => boolean;
  /** Bila true, endpoint saran membalas 500 (saran hilang diam-diam). */
  suggestionsFail?: () => boolean;
  /** Bila true, endpoint player membalas 500. */
  playerFails?: () => boolean;
  /** Bila true, semua host sampul membalas 500 (uji fallback ubin huruf). */
  thumbnailsFail?: boolean;
}

function jsonResponse(body: string) {
  return { status: 200, contentType: 'application/json', body };
}

/** Pasang semua mock P4 untuk satu konteks browser. */
export async function mockP4Network(
  context: BrowserContext,
  opts: MockP4Options = {},
): Promise<void> {
  const counters = opts.counters;
  await context.route(CONFIG_URL, (route) =>
    route.fulfill({ status: 500, body: 'mock config gagal' }),
  );
  await context.route(`${PROXY_BASE_URL}/api/innertube/search`, (route) => {
    if (counters) counters.search += 1;
    if (opts.searchFails?.()) {
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'MOCK_FAIL' } }),
      });
    }
    const body = route.request().postDataJSON() as
      | { query?: unknown }
      | null;
    // Kueri init visitorData resolver ("lagu indonesia populer",
    // malas: hanya sebelum putar pertama) dan kueri biasa
    // sama-sama dilayani fixture Peterpan: isinya membawa
    // visitorData asli dari rekaman.
    if (body?.query === 'banyak') {
      return route.fulfill(jsonResponse(expandSearchFixture()));
    }
    if (body?.query === 'kosong') {
      // Respons valid tanpa hasil: `contents` WAJIB ada (tanpa
      // itu layanan menganggap respons rusak, bukan kosong).
      return route.fulfill(jsonResponse('{"contents":{}}'));
    }
    return route.fulfill(jsonResponse(SEARCH_PETERPAN));
  });
  await context.route(`${PROXY_BASE_URL}/api/innertube/browse`, (route) => {
    if (counters) counters.browse += 1;
    if (opts.browseFails?.()) {
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'MOCK_FAIL' } }),
      });
    }
    const body = route.request().postDataJSON() as
      | { browseId?: unknown }
      | null;
    const browseId = typeof body?.browseId === 'string' ? body.browseId : '';
    const byId: Record<string, string> = {
      FEmusic_home: BROWSE_HOME,
      FEmusic_moods_and_genres: BROWSE_MOODS,
      // Halaman kategori mood/genre: bentuknya rak-rak seperti
      // playlist — fixture playlist dipakai sebagai pengganti.
      FEmusic_moods_and_genres_category: BROWSE_PLAYLIST,
      'UCCMnLkUAdm_NGMDTTC-nvDQ': BROWSE_ARTIST,
      MPREb_CjVCffe6rk9: BROWSE_ALBUM,
      VLPLUDw6LIBdqtzMOnmH4PxbdaVZ746IzI7v: BROWSE_PLAYLIST,
    };
    if (byId[browseId] !== undefined) {
      return route.fulfill(jsonResponse(byId[browseId]));
    }
    // Radio (VLRD...) dan playlist lain: bentuk halaman playlist.
    if (browseId.startsWith('VL')) {
      return route.fulfill(jsonResponse(BROWSE_PLAYLIST));
    }
    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'MOCK_NOT_FOUND' } }),
    });
  });
  await context.route(
    `${PROXY_BASE_URL}/api/innertube/suggestions`,
    (route) => {
      if (counters) counters.suggestions += 1;
      if (opts.suggestionsFail?.()) {
        return route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'MOCK_FAIL' } }),
        });
      }
      return route.fulfill(jsonResponse(SUGGEST_NOAH));
    },
  );
  await context.route(`${PROXY_BASE_URL}/api/innertube/player`, (route) => {
    if (counters) counters.player += 1;
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
  await context.route('**googlevideo.com/videoplayback*', (route) =>
    fulfillRange(route, TONE_10S, 'audio/wav'),
  );
  const thumbnailResponse = opts.thumbnailsFail
    ? { status: 500, body: 'mock thumbnail gagal' }
    : { status: 200, contentType: 'image/png', body: PIXEL_PNG };
  await context.route('**i.ytimg.com/**', (route) =>
    route.fulfill(thumbnailResponse),
  );
  // Sampul YTM juga datang dari dua host ini (album/artis/playlist
  // di fixture: yt3 11x, lh3 2x) — tanpa mock, gambar gagal dan
  // kartu tampil kosong di browser VM.
  await context.route('**yt3.googleusercontent.com/**', (route) =>
    route.fulfill(thumbnailResponse),
  );
  await context.route('**lh3.googleusercontent.com/**', (route) =>
    route.fulfill(thumbnailResponse),
  );
}

/** Isi skenario beranda deterministik lewat /p4-test. */
export async function seedP4(page: Page): Promise<void> {
  await page.goto('/p4-test');
  await page.getByTestId('p4-test-seed').click();
  await expect(page.getByTestId('p4-test-status')).toHaveText('Selesai.', {
    timeout: 30000,
  });
}

/** Status pemutar lewat hook debug (pola player.spec.ts). */
export async function playerStatus(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const hook = (
      window as unknown as {
        __larasPlayer?: { getState: () => { status: string } };
      }
    ).__larasPlayer;
    return hook?.getState().status ?? null;
  });
}
