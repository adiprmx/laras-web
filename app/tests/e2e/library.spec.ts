/**
 * Tes E2E Library P3 (IndexedDB + pencarian lokal + playlist +
 * antrean persisten).
 *
 * Semua data berasal dari generator contoh deterministik
 * (src/data/sampleData.ts) yang diimpor langsung, sehingga
 * ekspektasi dihitung dari sumber yang sama dengan app.
 * Tidak ada jaringan live: nada lokal disajikan dari fixture
 * (pola player.spec.ts), config dimock gagal.
 *
 * Uji tutup-buka browser memakai `launchPersistentContext`
 * dengan userDataDir di /tmp: menutup context biasa akan
 * menghapus IndexedDB, jadi persistent context adalah satu
 * satunya cara yang sah untuk membuktikan antrean utuh.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chromium,
  devices,
  expect,
  test,
  type BrowserContext,
  type Page,
  type Route,
} from '@playwright/test';
import { generateSampleSongs } from '../../src/data/sampleData';
import { tokenize } from '../../src/data/tokens';
import { PROXY_BASE_URL, SEARCH_PETERPAN } from './p4-helpers';

const CONFIG_URL =
  'https://raw.githubusercontent.com/adiprmx/laras/config-v1/player-config.json';
const BASE_URL = 'http://localhost:4173';

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

/** Mock jaringan minimal: config gagal + nada lokal (context.route). */
async function mockNetwork(context: BrowserContext): Promise<void> {
  await context.route(CONFIG_URL, (route) =>
    route.fulfill({ status: 500, body: 'mock config gagal' }),
  );
  await context.route(/\/__player-test__\/(.+)\.wav/, (route) => {
    const name = route.request().url().split('/').pop() ?? '';
    const buffer = name === 'tone-60s.wav' ? TONE_60S : TONE_10S;
    return fulfillRange(route, buffer, 'audio/wav');
  });
  // Beranda (dikunjungi uji migrasi antrean) memuat Jelajah dan
  // init resolver memanggil search: keduanya dilayani fixture
  // supaya tidak ada jaringan live di tes ini.
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
      body: JSON.stringify({ contents: {} }),
    }),
  );
}

/** Isi database lewat /library-test, tunggu hitungan sesuai. */
async function seed(page: Page, count: 120 | 1000): Promise<void> {
  await page.goto('/library-test');
  await page
    .getByTestId(`library-test-seed-${count}`)
    .click();
  await expect(page.getByTestId('library-test-songs')).toHaveText(
    String(count),
    { timeout: 60000 },
  );
  await expect(page.getByTestId('library-test-status')).toContainText(
    'Selesai',
    { timeout: 60000 },
  );
}

/** Buka Library dan tunggu daftar lagu selesai dimuat. */
async function openLibrary(page: Page): Promise<void> {
  await page.goto('/library');
  await expect(page.getByTestId('library-page')).toBeVisible();
  await expect(page.getByTestId('library-loading')).toHaveCount(0, {
    timeout: 15000,
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

test.describe('Library kosong', () => {
  test('menampilkan empty state yang jujur', async ({ page }) => {
    await mockNetwork(page.context());
    await openLibrary(page);
    await expect(page.getByTestId('library-empty')).toBeVisible();
    await expect(page.getByTestId('library-empty')).toContainText(
      'Library kamu masih kosong',
    );
  });
});

test.describe('Seed 1.000 lagu contoh', () => {
  test('menyimpan 1.000 lagu, pagination 50 per halaman', async ({ page }) => {
    test.setTimeout(120000);
    await mockNetwork(page.context());
    await seed(page, 1000);
    await openLibrary(page);
    await expect(page.getByTestId('library-song-count')).toContainText(
      '1.000 lagu',
    );
    await expect(page.getByTestId('song-list').locator('> li')).toHaveCount(50);
    // Lagu terbaru dulu: sample-0000 adalah yang terbaru.
    await expect(
      page.getByTestId('song-list').locator('> li').first(),
    ).toContainText(generateSampleSongs(1)[0]?.song.title ?? '');
    await page.getByTestId('load-more').click();
    await expect(page.getByTestId('song-list').locator('> li')).toHaveCount(
      100,
    );
    // Tab Favorit terisi (setiap lagu ke-10 difavoritkan = 100 lagu).
    await page.getByTestId('tab-favorites').click();
    await expect(page.getByTestId('song-list').locator('> li')).toHaveCount(50);
    await page.getByTestId('load-more').click();
    await expect(page.getByTestId('song-list').locator('> li')).toHaveCount(
      100,
    );
  });

  test('urut nama menaruh judul pertama sesuai abjad', async ({ page }) => {
    test.setTimeout(120000);
    await mockNetwork(page.context());
    await seed(page, 120);
    await openLibrary(page);
    await page.getByTestId('sort-by-name').click();
    const expected = generateSampleSongs(120)
      .map((s) => s.song.title)
      .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1))[0];
    await expect(
      page.getByTestId('song-list').locator('> li').first(),
    ).toContainText(expected ?? '');
  });
});

test.describe('Pencarian lokal', () => {
  test('mencari judul lewat awalan token, AND lalu OR', async ({ page }) => {
    test.setTimeout(120000);
    await mockNetwork(page.context());
    await seed(page, 120);
    await openLibrary(page);
    const songs = generateSampleSongs(120);
    // "rindu": semua lagu yang judulnya mengandung token "rindu".
    const rinduCount = songs.filter((s) =>
      tokenize(s.song.title).some((t) => t.startsWith('rindu')),
    ).length;
    expect(rinduCount).toBeGreaterThan(0);
    await page.getByTestId('library-search').fill('rindu');
    await expect(page.getByTestId('search-results')).toBeVisible({
      timeout: 15000,
    });
    await expect(
      page.getByTestId('search-results').locator('li[data-testid^="search-song-"]'),
    ).toHaveCount(rinduCount);
    // AND: "rindu di" hanya lagu yang mengandung kedua kata.
    const andCount = songs.filter((s) => {
      const tokens = tokenize(s.song.title);
      return (
        tokens.some((t) => t.startsWith('rindu')) &&
        tokens.some((t) => t.startsWith('di'))
      );
    }).length;
    await page.getByTestId('library-search').fill('rindu di');
    await expect(
      page.getByTestId('search-results').locator('li[data-testid^="search-song-"]'),
    ).toHaveCount(andCount);
  });

  test('kueri tanpa hasil menampilkan keadaan kosong yang jujur', async ({
    page,
  }) => {
    await mockNetwork(page.context());
    await seed(page, 120);
    await openLibrary(page);
    await page.getByTestId('library-search').fill('zzzqqq tidak ada');
    await expect(page.getByTestId('search-results')).toHaveCount(0);
    await expect(page.getByTestId('library-empty')).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByTestId('library-empty')).toContainText(
      'Tidak ditemukan',
    );
  });

  test('mencari artis contoh menampilkan artisnya', async ({ page }) => {
    await mockNetwork(page.context());
    await seed(page, 120);
    await openLibrary(page);
    await page.getByTestId('library-search').fill('artis contoh 07');
    await expect(page.getByTestId('search-results')).toBeVisible({
      timeout: 15000,
    });
    await expect(
      page.getByTestId('search-results').locator('[data-testid^="search-artist-"]'),
    ).toHaveCount(1);
    await expect(
      page.getByTestId('search-results').locator('[data-testid^="search-artist-"]').first(),
    ).toContainText('Artis Contoh 07');
  });
});

test.describe('Playlist', () => {
  test('buat, tambah lagu, ubah nama, pindah posisi, hapus lagu, hapus playlist', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await mockNetwork(page.context());
    await seed(page, 120);
    await openLibrary(page);

    // Buat playlist.
    await page.getByTestId('tab-playlists').click();
    await page.getByTestId('create-playlist').click();
    await page.getByTestId('playlist-name-input').fill('Campuran Uji');
    await page.getByTestId('playlist-description-input').fill('Deskripsi uji');
    await page.getByTestId('playlist-submit').click();
    await expect(page.getByTestId('playlist-detail')).toBeVisible();
    await expect(page.getByTestId('playlist-detail')).toContainText(
      'Campuran Uji',
    );
    await expect(page.getByTestId('playlist-detail')).toContainText(
      'Deskripsi uji',
    );

    // Tambah dua lagu dari tab Lagu lewat menu titik tiga.
    await page.getByTestId('nav-library').click();
    await expect(page.getByTestId('song-list').locator('> li')).toHaveCount(50);
    const firstRow = page.getByTestId('song-list').locator('> li').first();
    const secondRow = page.getByTestId('song-list').locator('> li').nth(1);
    const firstTitle = (await firstRow.textContent()) ?? '';
    const secondTitle = (await secondRow.textContent()) ?? '';
    await firstRow.getByTestId(/-menu$/).click();
    await page.getByTestId('menu-add-to-playlist').click();
    await page.getByTestId('add-to-playlist-dialog').waitFor();
    await page
      .getByRole('button', { name: /Campuran Uji/ })
      .click();
    await expect(page.getByTestId('library-toast')).toContainText(
      'Ditambahkan ke playlist',
    );
    await secondRow.getByTestId(/-menu$/).click();
    await page.getByTestId('menu-add-to-playlist').click();
    await page
      .getByRole('button', { name: /Campuran Uji/ })
      .click();
    await expect(page.getByTestId('library-toast')).toContainText(
      'Ditambahkan ke playlist',
    );

    // Buka playlist: dua lagu ada, urut tambah.
    await page.getByTestId('tab-playlists').click();
    await page.getByRole('button', { name: /Campuran Uji/ }).click();
    await expect(page.getByTestId('playlist-detail')).toBeVisible();
    const playlistRows = page
      .getByTestId('playlist-song-list')
      .locator('> li');
    await expect(playlistRows).toHaveCount(2);
    await expect(playlistRows.first()).toContainText(
      firstTitle.trim().slice(0, 20),
    );

    // Pindah lagu pertama ke bawah lewat menu: urutan bertukar.
    await playlistRows.first().getByTestId(/-menu$/).click();
    await page.getByTestId('menu-move-down').click();
    await expect(playlistRows.first()).toContainText(
      secondTitle.trim().slice(0, 20),
    );

    // Ubah nama playlist.
    await page.getByTestId('playlist-edit').click();
    await page.getByTestId('playlist-name-input').fill('Campuran Baru');
    await page.getByTestId('playlist-submit').click();
    await expect(page.getByTestId('playlist-detail')).toContainText(
      'Campuran Baru',
    );

    // Hapus satu lagu lewat menu.
    await playlistRows.first().getByTestId(/-menu$/).click();
    await page.getByTestId('menu-remove-from-playlist').click();
    await expect(playlistRows).toHaveCount(1);

    // Hapus playlist.
    await page.getByTestId('playlist-delete').click();
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('library-page')).toBeVisible();
    await page.getByTestId('tab-playlists').click();
    await expect(page.getByTestId('library-empty')).toBeVisible();
  });
});

test.describe('Favorit dan riwayat', () => {
  test('suka dari menu lagu masuk tab Favorit, batal suka menghilangkannya', async ({
    page,
  }) => {
    await mockNetwork(page.context());
    await seed(page, 120);
    await openLibrary(page);
    const firstRow = page.getByTestId('song-list').locator('> li').first();
    const firstTitle = (await firstRow.textContent()) ?? '';
    await firstRow.getByTestId(/-menu$/).click();
    // Lagu pertama (sample-0000) sudah difavoritkan generator;
    // batal suka dulu lalu suka lagi untuk menguji kedua arah.
    await page.getByTestId('menu-toggle-like').click();
    await page.getByTestId('tab-favorites').click();
    // Polling sampai daftar favorit selesai dimuat ulang: toggle
    // berjalan async dan daftar diperbarui lewat bump versi.
    await expect
      .poll(
        async () =>
          (await page
            .getByTestId('song-list')
            .locator('> li')
            .allTextContents()
          ).some((t) => t.includes(firstTitle.trim().slice(0, 20))),
        { timeout: 15000 },
      )
      .toBe(false);
    await page.getByTestId('tab-songs').click();
    await page
      .getByTestId('song-list')
      .locator('> li')
      .first()
      .getByTestId(/-menu$/)
      .click();
    await page.getByTestId('menu-toggle-like').click();
    await page.getByTestId('tab-favorites').click();
    await expect
      .poll(
        async () =>
          (await page
            .getByTestId('song-list')
            .locator('> li')
            .allTextContents()
          ).some((t) => t.includes(firstTitle.trim().slice(0, 20))),
        { timeout: 15000 },
      )
      .toBe(true);
  });

  test('lagu yang selesai diputar tercatat di Riwayat', async ({ page }) => {
    test.setTimeout(90000);
    await mockNetwork(page.context());
    await page.goto('/player-test');
    await page.getByTestId('player-test-play').click();
    await expect
      .poll(async () => (await debugState(page))?.status, { timeout: 15000 })
      .toBe('playing');
    // Nada 10 detik selesai, lalu lagu kedua (60 detik) mulai.
    // Tunggu status playing pada lagu kedua sebagai tanda lagu
    // pertama selesai.
    await expect
      .poll(async () => (await debugState(page))?.duration, { timeout: 30000 })
      .toBeGreaterThan(30);
    await openLibrary(page);
    await page.getByTestId('tab-history').click();
    await expect(page.getByTestId('history-list').locator('> li')).toHaveCount(
      1,
      { timeout: 15000 },
    );
    await expect(page.getByTestId('history-list')).toContainText(
      'Nada 10 detik',
    );
  });
});

test.describe('Migrasi localStorage P2', () => {
  test('antrean lama dipindah ke IndexedDB dan kunci lama dihapus', async ({
    page,
  }) => {
    await mockNetwork(page.context());
    await page.addInitScript(() => {
      window.localStorage.setItem(
        'laras.player.v1',
        JSON.stringify({
          version: 1,
          queue: [
            {
              id: '/__player-test__/tone-10s.wav',
              title: 'Nada 10 detik',
              durationSeconds: 10,
              source: {
                kind: 'local',
                url: '/__player-test__/tone-10s.wav',
              },
            },
            {
              id: '/__player-test__/tone-60s.wav',
              title: 'Nada 60 detik',
              durationSeconds: 60,
              source: {
                kind: 'local',
                url: '/__player-test__/tone-60s.wav',
              },
            },
          ],
          order: [0, 1],
          orderPos: 0,
          // 5 detik dari nada 10 detik: di tengah, jadi
          // decideRestorePosition mempertahankannya (posisi di
          // bawah ambang sepertiga awal sengaja mulai dari 0).
          positionSeconds: 5,
          shuffle: false,
          repeat: 'off',
          rate: 1,
          volume: 1,
          updatedAt: 1000,
        }),
      );
    });
    await page.goto('/');
    // Antrean pulih dari migrasi: mini player menampilkan lagunya.
    await expect(page.getByTestId('mini-player')).toContainText(
      'Nada 10 detik',
      { timeout: 15000 },
    );
    // Kunci lama sudah dihapus.
    const legacy = await page.evaluate(() =>
      window.localStorage.getItem('laras.player.v1'),
    );
    expect(legacy).toBeNull();
    // Posisi pulih (5 detik) lewat hook debug.
    await expect
      .poll(async () => (await debugState(page))?.position, { timeout: 15000 })
      .toBeCloseTo(5, 0);
  });
});

test.describe('Antrean utuh setelah tutup-buka browser', () => {
  // Playwright WAJIB pola objek sebagai argumen pertama (fixtures);
  // tes ini tidak memakai fixture apa pun (konteks persistent dibuat
  // sendiri) jadi polanya memang kosong. Identifier biasa ditolak
  // Playwright (validasi signature fixture).
  test('memutar nada, tutup browser, buka lagi: antrean dan posisi utuh', async (
    // eslint-disable-next-line no-empty-pattern
    {},
    testInfo,
  ) => {
    test.setTimeout(120000);
    const userDataDir = mkdtempSync(path.join(tmpdir(), 'laras-p3-queue-'));
    const isMobile = testInfo.project.name === 'mobile';
    try {
      const context = await chromium.launchPersistentContext(userDataDir, {
        headless: true,
        ...(isMobile ? devices['Pixel 7'] : devices['Desktop Chrome']),
      });
      try {
        await mockNetwork(context);
        const page = await context.newPage();
        await page.goto(`${BASE_URL}/player-test`);
        await page.getByTestId('player-test-play').click();
        await expect
          .poll(async () => (await debugState(page))?.status, {
            timeout: 15000,
          })
          .toBe('playing');
        // Tunggu posisi melewati 5 detik: simpan berkala sudah
        // menulis posisi ke IndexedDB.
        await expect
          .poll(async () => (await debugState(page))?.position, {
            timeout: 30000,
          })
          .toBeGreaterThan(5);
        // Beri waktu tulis IndexedDB selesai (debounce 500 ms).
        await page.waitForTimeout(1500);
      } finally {
        await context.close();
      }

      // Buka lagi dengan profil yang sama: antrean wajib utuh.
      const context2 = await chromium.launchPersistentContext(userDataDir, {
        headless: true,
        ...(isMobile ? devices['Pixel 7'] : devices['Desktop Chrome']),
      });
      try {
        await mockNetwork(context2);
        const page2 = await context2.newPage();
        await page2.goto(BASE_URL);
        await expect(page2.getByTestId('mini-player')).toContainText(
          'Nada 10 detik',
          { timeout: 15000 },
        );
        const state = await debugState(page2);
        expect(state).not.toBeNull();
        // Posisi pulih dari simpan berkala: tick 5 detik dinding
        // menyala saat audio di sekitar detik ke-4 (muat ~1 detik),
        // jadi ambang 3 detik membuktikan posisi pulih, bukan 0.
        expect(state?.position ?? 0).toBeGreaterThan(3);
        // Antrean berisi 3 nada: buka pemutar penuh dan hitung.
        await page2.getByTestId('mini-open').click();
        await expect(page2.getByTestId('full-player')).toBeVisible();
        await expect(
          page2.locator('[data-testid^="queue-item-"]'),
        ).toHaveCount(3);
      } finally {
        await context2.close();
      }
    } finally {
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
