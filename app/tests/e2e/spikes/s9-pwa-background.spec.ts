// Spike S9: PWA install + audio latar di Android Chrome dan iOS Safari
// (arsitektur.md §8).
//
// Yang BISA dibuktikan di VM (Playwright + Chromium):
// - Manifest valid + semua field installability.
// - Installability tanpa error (CDP Page.getInstallabilityErrors).
// - Service Worker terdaftar + shell dimuat saat offline.
// - MediaSession metadata + playbackState.
//
// Yang TIDAK BISA dibuktikan di VM ini (diukur, bukan diasumsikan):
// - Audio saat TAB LATAR: mesin tab-latar Chromium tidak berfungsi di
//   VM ini (tanpa window manager/compositor). Dibuktikan 17 Nov 2026:
//   sesudah ganti tab (bringToFront + Target.activateTarget, headless
//   maupun headed+Xvfb, dengan maupun tanpa argumen backgrounding
//   bawaan Playwright), visibilityState tetap 'visible', hasFocus()
//   true di kedua tab, DAN timer setInterval 100 ms tetap jalan penuh
//   (100 tick/10 detik, tanpa throttling latar). CDP
//   Page.setWebLifecycleState menolak 'hidden' ("Unidentified lifecycle
//   state"); 'frozen' diterima tetapi tidak mengubah visibility.
//   Karena kondisi "latar" tidak pernah terbentuk, audio latar TIDAK
//   BISA diklaim terbukti dari VM. Uji di bawah mencatat keterbatasan
//   ini secara eksplisit dan HANYA membuktikan audio tetap jalan saat
//   tab lain diaktifkan (bukan bukti latar). Tes perangkat nyata WAJIB.
// - Instalasi PWA sungguhan + prompt install di Android Chrome.
// - Audio saat layar terkunci + kontrol di lock screen.
// - Seluruh perilaku iOS Safari (tidak ada WebKit di VM ini, dan
//   WebKit desktop pun bukan iOS Safari).
import { chromium, devices, expect, test } from '@playwright/test';
import {
  TONE_60S,
  openSpikePage,
  sampleUntil,
  spikeEvents,
  spikeState,
} from './helpers';

// Di bawah konfigurasi E2E utama (preview build, port 4173) spesifikasi
// ini MELEWATI dirinya sendiri — halaman spike tidak ada di build
// produksi. Dijalankan dengan: npx playwright test -c playwright.spikes.config.ts
test.skip(
  async ({ baseURL }) => (baseURL ?? '').includes('4173'),
  'spike S9 hanya jalan di server spike (port 5229), bukan preview build',
);

test.describe('S9 PWA install + audio latar', () => {
  test('manifest valid + semua field installability', async ({ page, request }) => {
    test.setTimeout(120000);
    await openSpikePage(page);
    const info = await page.evaluate(() => window.__spike.manifestInfo());
    expect(info.ok).toBe(true);
    const m = info.manifest as Record<string, unknown>;
    console.log(`manifest: ${JSON.stringify(m)}`);
    expect(m.name).toBeTruthy();
    expect(m.short_name).toBeTruthy();
    expect(m.start_url).toBe('/');
    expect(m.display).toBe('standalone');
    expect(m.theme_color).toBe('#000000');
    expect(m.background_color).toBe('#000000');
    const icons = m.icons as Array<{ src: string; sizes: string; type: string }>;
    const sizes = icons.map((i) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    // Ikon wajib benar-benar bisa diunduh (bukan hanya tertulis).
    for (const icon of icons.filter((i) => i.sizes === '192x192' || i.sizes === '512x512')) {
      const res = await request.get(icon.src);
      console.log(`ikon ${icon.sizes} ${icon.src}: HTTP ${res.status()} ${res.headers()['content-length'] ?? '?'} byte`);
      expect(res.ok()).toBe(true);
    }
  });

  test('installability tanpa error (CDP) + beforeinstallprompt tercatat', async ({
    page,
  }) => {
    test.setTimeout(180000);
    await page.addInitScript(() => {
      (window as unknown as { __bipFired: boolean }).__bipFired = false;
      window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        (window as unknown as { __bipFired: boolean }).__bipFired = true;
      });
    });
    await openSpikePage(page);
    // Daftarkan SW dulu: installability mensyaratkan SW aktif.
    const reg = await page.evaluate(() => window.__spike.registerSW());
    console.log(`installability: registerSW=${JSON.stringify(reg)}`);
    expect(reg.registered).toBe(true);
    // Tunggu SW aktif.
    let active = false;
    for (let i = 0; i < 15; i++) {
      const info = await page.evaluate(() => window.__spike.swInfo());
      if (info.active) {
        active = true;
        break;
      }
      await page.waitForTimeout(2000);
    }
    console.log(`installability: SW aktif=${active}`);
    expect(active).toBe(true);
    // Beri waktu kriteria installability dievaluasi browser.
    await page.waitForTimeout(10000);
    const cdp = await page.context().newCDPSession(page);
    const result = (await cdp.send('Page.getInstallabilityErrors')) as {
      errors: Array<{ errorArguments: string[]; errorText: string }>;
    };
    const errors = result.errors ?? [];
    console.log(
      `installability: CDP errors=${errors.length} ` +
        errors.map((e) => e.errorText).join(' | '),
    );
    expect(errors).toHaveLength(0);
    const bipFired = await page.evaluate(
      () => (window as unknown as { __bipFired: boolean }).__bipFired,
    );
    console.log(
      `installability: beforeinstallprompt menyala=${bipFired} ` +
        `(di headless Chromium event ini sering tidak menyala; CDP adalah patokan)`,
    );
  });

  test('Service Worker terdaftar + shell dimuat saat offline', async ({
    page,
    context,
  }) => {
    test.setTimeout(180000);
    await openSpikePage(page);
    const reg = await page.evaluate(() => window.__spike.registerSW());
    expect(reg.registered).toBe(true);
    let info = await page.evaluate(() => window.__spike.swInfo());
    for (let i = 0; i < 15 && !info.active; i++) {
      await page.waitForTimeout(2000);
      info = await page.evaluate(() => window.__spike.swInfo());
    }
    console.log(`offline: SW info=${JSON.stringify(info)}`);
    expect(info.active).toBe(true);
    // Muat ulang online SEKALI lewat SW: muatan awal terjadi sebelum SW
    // terdaftar sehingga tidak pernah masuk cache runtime. Reload ini
    // mengisi cache lewat fetch handler SW (cache-first sesudah fetch).
    await page.reload();
    await page.waitForFunction(() => Boolean(window.__spike), undefined, {
      timeout: 30000,
    });
    info = await page.evaluate(() => window.__spike.swInfo());
    console.log(`offline: SW info sesudah reload=${JSON.stringify(info)}`);
    expect(info.controlling).toBe(true);
    // Pastikan halaman benar-benar ada di cache sebelum offline.
    let cached = false;
    for (let i = 0; i < 10 && !cached; i++) {
      cached = await page.evaluate(async () =>
        Boolean(await caches.match('/spikes/playback.html')),
      );
      if (!cached) await page.waitForTimeout(1000);
    }
    console.log(`offline: halaman ada di cache SW=${cached}`);
    expect(cached).toBe(true);
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Halaman spike pemutaran Laras' })).toBeVisible({
      timeout: 30000,
    });
    const spikeAlive = await page.evaluate(() => Boolean(window.__spike));
    console.log(`offline: halaman dimuat dari cache=${spikeAlive}`);
    expect(spikeAlive).toBe(true);
    await context.setOffline(false);
  });

  test('audio saat tab lain diaktifkan + keterbatasan latar VM dicatat', async () => {
    test.setTimeout(180000);
    // Browser khusus tanpa argumen penonaktif throttling bawaan Playwright
    // (--disable-background-timer-throttling dkk.): pengukuran tick hanya
    // bermakna bila throttling latar Chrome AKTIF seperti di browser nyata.
    const isMobile = test.info().project.name === 'mobile';
    const baseURL =
      test.info().project.use.baseURL ?? 'http://localhost:5229';
    const browser = await chromium.launch({
      ignoreDefaultArgs: [
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
      ],
      args: ['--autoplay-policy=no-user-gesture-required'],
    });
    try {
      const context = await browser.newContext(
        isMobile
          ? { ...devices['Pixel 7'] }
          : { viewport: { width: 1280, height: 720 } },
      );
      const page = await context.newPage();
      await page.goto(`${baseURL}/spikes/playback.html`);
      await page.waitForFunction(() => Boolean(window.__spike), undefined, {
        timeout: 30000,
      });
      await runBackgroundProbe(page, context, baseURL);
    } finally {
      await browser.close();
    }
  });
});

async function runBackgroundProbe(
  page: import('@playwright/test').Page,
  context: import('@playwright/test').BrowserContext,
  baseURL: string,
): Promise<void> {
    // Penghitung tick untuk mengukur throttling latar (tab latar sejati
    // di-throttle Chrome ke ~1 tick/detik; tab depan ~10 tick/detik
    // pada interval 100 ms).
    await page.evaluate(() => {
      const w = window as unknown as { __ticks: number };
      w.__ticks = 0;
      setInterval(() => {
        w.__ticks++;
      }, 100);
    });
    await page.evaluate((src) => window.__spike.load(src), TONE_60S);
    const playResult = await page.evaluate(() => window.__spike.play());
    expect(playResult.ok).toBe(true);
    const { timedOut: timedOutStart } = await sampleUntil(page, (s) => s.ct >= 5, {
      intervalMs: 500,
      timeoutMs: 30000,
    });
    expect(timedOutStart).toBe(false);
    const msSet = await page.evaluate(() =>
      window.__spike.setMediaSession({
        title: 'Nada Uji Latar',
        artist: 'Laras Spike',
        album: 'Kanari',
      }),
    );
    expect(msSet.supported).toBe(true);
    const before = await spikeState(page);
    // Aktifkan tab kedua. Di VM ini (tanpa window manager) langkah ini
    // TIDAK membuat tab pertama 'hidden' (terbukti di semua konfigurasi
    // yang dicoba); uji ini mengukur dan mencatat fakta itu.
    const page2 = await context.newPage();
    await page2.goto(`${baseURL}/spikes/playback.html`);
    await page2.bringToFront();
    await page.evaluate(() => {
      (window as unknown as { __ticks: number }).__ticks = 0;
    });
    await page.waitForTimeout(10000);
    const vis = await page.evaluate(() => window.__spike.visibility());
    const ticksAfter = await page.evaluate(
      () => (window as unknown as { __ticks: number }).__ticks,
    );
    const after = await spikeState(page);
    console.log(
      `audio latar: sesudah tab lain diaktifkan 10 detik: ` +
        `visibility=${JSON.stringify(vis)}, tick=${ticksAfter}/10 detik ` +
        `(latar sejati ~10, depan ~100), ct ${before.ct} -> ${after.ct}, ` +
        `paused=${after.paused}, decoded ${before.decoded} -> ${after.decoded}`,
    );
    // Yang TERBUKTI: audio tetap jalan saat tab lain diaktifkan.
    expect(after.err).toBe(0);
    expect(after.paused).toBe(false);
    expect(after.ct).toBeGreaterThan(before.ct + 5);
    expect(after.decoded).toBeGreaterThan(before.decoded);
    // Yang TIDAK TERBUKTI di VM: kondisi latar itu sendiri.
    if (!vis.hidden && ticksAfter > 50) {
      console.log(
        'audio latar: KONDISI LATAR TIDAK TERBENTUK DI VM (visibility tetap ' +
          'visible + timer tidak di-throttle). Audio latar BUTUH TES ' +
          'PERANGKAT NYATA; uji ini tidak mengklaimnya terbukti.',
      );
    }
    const events = await spikeEvents(page);
    const pauseEvents = events.filter((e) => e.ev === 'pause');
    console.log(`audio latar: event pause selama uji=${pauseEvents.length}`);
    expect(pauseEvents).toHaveLength(0);
    const msInfo = await page.evaluate(() => window.__spike.mediaSessionInfo());
    console.log(`audio latar: MediaSession=${JSON.stringify(msInfo)}`);
    expect(msInfo.title).toBe('Nada Uji Latar');
    expect(msInfo.playbackState).toBe('playing');
    await page2.close();
}
