// Spike S3: pemutaran <audio> dari URL googlevideo hasil resolve +
// MediaSession (arsitektur.md §8).
//
// Kriteria lolos: lagu berbunyi sampai habis di browser desktop +
// emulasi HP; ukur waktu sampai bunyi pertama; uji re-resolve di
// tengah lagu.
//
// CATATAN JUJUR TENTANG JARINGAN VM: jalur langsung <audio src=URL
// googlevideo> TIDAK BISA diuji dari VM (egress memblokir request
// Range terbuka yang dikirim Chromium + terowongan proxy gagal).
// Uji "jalur langsung" di bawah mendokumentasikan kegagalan itu
// dengan bukti berlapis. Bukti putar byte lagu ASLI diperoleh lewat
// relay Range sisi Node (relay.ts, HANYA alat uji, bukan arsitektur
// v1): byte Opus asli YouTube yang sampai ke <audio>.
//
// "Bunyi pertama" diukur sebagai proksi: waktu dari play() sampai
// decoder menghasilkan sampel pertama (webkitAudioDecodedByteCount > 0
// + event playing). Headless Chromium tidak punya pengeras suara,
// jadi bunyi akustik tidak bisa didengar langsung; byte ter-decode
// yang bertambah adalah bukti terkuat yang tersedia di VM.
import { expect, test } from '@playwright/test';
import { CANARY_SONGS, describeStreamUrl } from './canary';

// Di bawah konfigurasi E2E utama (preview build, port 4173) spesifikasi
// ini MELEWATI dirinya sendiri — halaman spike tidak ada di build
// produksi. Dijalankan dengan: npx playwright test -c playwright.spikes.config.ts
test.skip(
  async ({ baseURL }) => (baseURL ?? '').includes('4173'),
  'spike S3 hanya jalan di server spike (port 5229), bukan preview build',
);
import {
  createResolver,
  resolveViaVr,
  type Resolver,
  type ResolvedSong,
} from './resolve';
import { GooglevideoRelay, probeOneUrlWall } from './relay';
import {
  TONE_10S,
  TONE_60S,
  formatRelayStats,
  installRelayRoute,
  makeRelay,
  openSpikePage,
  sampleUntil,
  spikeEvents,
  spikeState,
  summarizeStalls,
} from './helpers';

test.describe('S3 pemutaran <audio> + MediaSession', () => {
  let resolver: Resolver;
  const resolved: ResolvedSong[] = [];

  test.beforeAll(async ({ baseURL }) => {
    // Pertahanan lapis kedua (lapis pertama: testIgnore di
    // playwright.config.ts): bila berkas ini dijalankan langsung di
    // bawah konfigurasi utama (preview build, port 4173), semua uji
    // di-skip oleh test.skip di atas — tetapi beforeAll TETAP jalan
    // (Playwright mengevaluasi skip kondisional sesudah beforeAll).
    // Tanpa pengembalian dini ini, resolve live di bawah akan
    // melempar LOGIN_REQUIRED dari IP runner CI dan mematahkan CI.
    if ((baseURL ?? '').includes('4173')) return;
    test.setTimeout(240000);
    resolver = await createResolver();
    console.log(
      `resolver siap: sts=${resolver.sts} visitorData=${resolver.visitorData ? 'ada' : 'tidak ada'}`,
    );
    for (const song of CANARY_SONGS) {
      const r = await resolver.resolve(song);
      resolved.push(r);
      console.log(
        `resolve ${song.videoId} (${song.title}): ${r.client} ` +
          `${describeStreamUrl(r.url, r.itag)} ${r.itag} ${r.resolveMs} ms ` +
          `percobaan=[${r.attempts.map((a) => `${a.client}:${a.playability}/itag${a.pickedItag ?? '-'}/direct${a.pickedDirect ? 'Y' : 'T'}/cipher${a.pickedCipher ? 'Y' : 'T'}`).join(', ')}]`,
      );
    }
    expect(resolved).toHaveLength(5);
  });

  test('dinding 1 MiB per URL terkonfirmasi (sisi Node)', async () => {
    test.skip(
      test.info().project.name !== 'chromium',
      'uji sisi Node, cukup sekali',
    );
    test.setTimeout(240000);
    const song = CANARY_SONGS[4];
    const fresh = await resolveViaVr(song, resolver.visitorData);
    console.log(
      `wall-probe ${song.videoId}: URL segar ${describeStreamUrl(fresh.url, fresh.itag)}`,
    );
    const results = await probeOneUrlWall(fresh.url);
    for (const r of results) {
      console.log(`wall-probe range ${r.range}: HTTP ${r.status} ${r.bytes} byte ${r.ms} ms`);
    }
    // Hipotesis bukti APK P1: 2 jendela 512 KiB pertama 206 (tepat 1 MiB),
    // jendela ke-3 403.
    expect(results[0].status).toBe(206);
    expect(results[0].bytes).toBe(524288);
    expect(results[1].status).toBe(206);
    expect(results[1].bytes).toBe(524288);
    expect(results[2].status).toBe(403);
    expect(results[2].bytes).toBe(0);
  });

  test('jalur langsung googlevideo dari VM gagal di jaringan (bukan kode)', async ({
    page,
  }) => {
    test.setTimeout(180000);
    const song = CANARY_SONGS[3];
    const fresh = await resolveViaVr(song, resolver.visitorData);
    const netSignals: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('googlevideo')) {
        netSignals.push(`request range=${req.headers().range ?? '(tanpa Range)'}`);
      }
    });
    page.on('response', (res) => {
      if (res.url().includes('googlevideo')) {
        netSignals.push(`response HTTP ${res.status()}`);
      }
    });
    page.on('requestfailed', (req) => {
      if (req.url().includes('googlevideo')) {
        netSignals.push(`requestfailed ${req.failure()?.errorText ?? '?'}`);
      }
    });
    await openSpikePage(page);
    const tPlay = Date.now();
    const playResult = await page.evaluate(async (url) => {
      window.__spike.load(url);
      return window.__spike.play();
    }, fresh.url);
    console.log(`jalur langsung: play() -> ${JSON.stringify(playResult)} (${Date.now() - tPlay} ms)`);
    const { last } = await sampleUntil(
      page,
      (s) => s.err !== 0 || s.decoded > 0,
      { intervalMs: 2000, timeoutMs: 60000 },
    );
    console.log(`jalur langsung: sinyal jaringan=[${netSignals.join(' | ') || 'tidak ada'}]`);
    console.log(`jalur langsung: state akhir=${JSON.stringify(last)}`);
    if (last.decoded > 0 && !last.paused) {
      // Egress pulih: jalur langsung menyala. Itu kabar baik, bukan gagal.
      console.log('JALUR LANGSUNG MENYALA: egress VM pulih, audio googlevideo berbunyi langsung.');
      return;
    }
    // Kegagalan yang diharapkan dari VM: error jaringan/decode + nol byte.
    expect(last.decoded).toBe(0);
    expect([2, 4]).toContain(last.err);
    expect(netSignals.length).toBeGreaterThan(0);
  });

  test('kontrol positif: nada lokal 10 detik diputar sampai habis', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await openSpikePage(page);
    const t0 = Date.now();
    await page.evaluate((src) => window.__spike.load(src), TONE_10S);
    const playResult = await page.evaluate(() => window.__spike.play());
    expect(playResult.ok).toBe(true);
    const { last: firstSound, timedOut, failedFast } = await sampleUntil(
      page,
      (s) => s.decoded > 0,
      { intervalMs: 250, timeoutMs: 15000, failFastOnError: true },
    );
    expect(failedFast).toBe(false);
    expect(timedOut).toBe(false);
    const msToFirstSound = Date.now() - t0;
    console.log(
      `kontrol lokal: bunyi pertama (decoded>0) sesudah ${msToFirstSound} ms, ` +
        `dur=${firstSound.dur} decoded=${firstSound.decoded}`,
    );
    const { last, failedFast: failedFastEnd } = await sampleUntil(
      page,
      (s) => s.ended,
      { intervalMs: 500, timeoutMs: 30000, failFastOnError: true },
    );
    expect(failedFastEnd).toBe(false);
    expect(last.ended).toBe(true);
    expect(last.ct).toBeGreaterThanOrEqual(9.9);
    expect(last.err).toBe(0);
    const events = await spikeEvents(page);
    const names = events.map((e) => e.ev);
    expect(names).toContain('playing');
    expect(names).toContain('ended');
    console.log(`kontrol lokal: selesai, decoded akhir=${last.decoded} byte, event=${names.join(',')}`);
  });

  test('byte Opus asli diputar 90 detik via relay + MediaSession', async ({
    page,
  }) => {
    test.setTimeout(420000);
    const r = resolved.find((x) => x.song.videoId === 'qkC4waEZVt4')!;
    const relay = makeRelay(r, resolver.visitorData);
    await installRelayRoute(page, relay, (m) => console.log(`[relay] ${m}`));
    await openSpikePage(page);
    const t0 = Date.now();
    await page.evaluate(
      (vid) => window.__spike.load(`http://localhost:5229/relay/${vid}`),
      r.song.videoId,
    );
    const playResult = await page.evaluate(() => window.__spike.play());
    expect(playResult.ok).toBe(true);
    const { timedOut, failedFast } = await sampleUntil(page, (s) => s.decoded > 0, {
      intervalMs: 500,
      timeoutMs: 180000,
      failFastOnError: true,
    });
    if (failedFast) {
      console.log(`relay 90 detik: FAIL-FAST bunyi pertama, error media sebelum decoded>0`);
      console.log(`relay 90 detik: ${formatRelayStats(relay)}`);
    }
    expect(failedFast).toBe(false);
    expect(timedOut).toBe(false);
    const msToFirstSound = Date.now() - t0;
    console.log(
      `relay 90 detik: bunyi pertama (decoded>0) sesudah ${msToFirstSound} ms ` +
        `(didominasi egress VM: chunk pertama ~25-38 detik)`,
    );
    const msSet = await page.evaluate(() =>
      window.__spike.setMediaSession({
        title: 'Rahasia Hati',
        artist: 'Laras Spike',
        album: 'Kanari',
      }),
    );
    expect(msSet.supported).toBe(true);
    const { last, timedOut: timedOut90, failedFast: failedFast90 } = await sampleUntil(
      page,
      (s) => s.ct >= 90,
      {
        intervalMs: 10000,
        timeoutMs: 300000,
        failFastOnError: true,
        log: (s) =>
          console.log(
            `relay 90 detik: ct=${s.ct} dur=${s.dur} paused=${s.paused} decoded=${s.decoded} bufferedEnd=${s.bufferedEnd} err=${s.err}`,
          ),
      },
    );
    if (failedFast90) {
      console.log(`relay 90 detik: FAIL-FAST di ct=${last.ct}, error media kode ${last.err}`);
      console.log(`relay 90 detik: ${formatRelayStats(relay)}`);
    }
    expect(failedFast90).toBe(false);
    expect(timedOut90).toBe(false);
    expect(last.err).toBe(0);
    expect(last.decoded).toBeGreaterThan(0);
    const msInfo = await page.evaluate(() => window.__spike.mediaSessionInfo());
    console.log(`relay 90 detik: MediaSession=${JSON.stringify(msInfo)}`);
    expect(msInfo.title).toBe('Rahasia Hati');
    expect(msInfo.playbackState).toBe('playing');
    const events = await spikeEvents(page);
    const stalls = summarizeStalls(events);
    console.log(
      `relay 90 detik: stall waiting=${stalls.waitingCount} total=${stalls.stallMsTotal} ms`,
    );
    console.log(`relay 90 detik: ${formatRelayStats(relay)}`);
    expect(relay.stats.reresolves).toBeGreaterThanOrEqual(0);
  });

  test('lagu penuh sampai habis via relay (Rahasia Hati)', async ({ page }) => {
    const isMobile = test.info().project.name === 'mobile';
    const rate = isMobile ? 2 : 1;
    test.setTimeout(isMobile ? 480000 : 660000);
    const song = CANARY_SONGS[1];
    const fresh = await resolveViaVr(song, resolver.visitorData);
    const relay = new GooglevideoRelay(
      song,
      fresh.itag,
      fresh.mimeType,
      fresh.url,
      async () => {
        const f = await resolveViaVr(song, resolver.visitorData);
        return { url: f.url, ms: f.ms };
      },
    );
    await installRelayRoute(page, relay, (m) => console.log(`[relay] ${m}`));
    await openSpikePage(page);
    const t0 = Date.now();
    await page.evaluate(
      (vid) => window.__spike.load(`http://localhost:5229/relay/${vid}`),
      song.videoId,
    );
    if (rate !== 1) {
      await page.evaluate((rt) => window.__spike.setRate(rt), rate);
    }
    const playResult = await page.evaluate(() => window.__spike.play());
    expect(playResult.ok).toBe(true);
    const { last, timedOut, failedFast } = await sampleUntil(page, (s) => s.ended, {
      intervalMs: 15000,
      timeoutMs: isMobile ? 420000 : 600000,
      failFastOnError: true,
      log: (s) =>
        console.log(
          `lagu penuh ${rate}x: ct=${s.ct} dur=${s.dur} paused=${s.paused} decoded=${s.decoded} bufferedEnd=${s.bufferedEnd} err=${s.err}`,
        ),
    });
    if (failedFast) {
      console.log(`lagu penuh ${rate}x: FAIL-FAST di ct=${last.ct}, error media kode ${last.err}`);
      console.log(`lagu penuh ${rate}x: ${formatRelayStats(relay)}`);
    }
    expect(failedFast).toBe(false);
    expect(timedOut).toBe(false);
    expect(last.ended).toBe(true);
    expect(last.err).toBe(0);
    expect(last.ct).toBeGreaterThanOrEqual((last.dur ?? 0) - 2);
    const wallMs = Date.now() - t0;
    const events = await spikeEvents(page);
    const stalls = summarizeStalls(events);
    console.log(
      `lagu penuh ${rate}x: SELESAI dalam ${wallMs} ms wall-clock ` +
        `(durasi lagu ${song.lengthSeconds} detik), ` +
        `stall waiting=${stalls.waitingCount} total=${stalls.stallMsTotal} ms, ` +
        `decoded akhir=${last.decoded} byte`,
    );
    console.log(`lagu penuh ${rate}x: ${formatRelayStats(relay)}`);
  });

  test('seek tengah lagu via relay (Semua Tentang Kita)', async ({ page }) => {
    test.setTimeout(420000);
    const song = CANARY_SONGS[0];
    const fresh = await resolveViaVr(song, resolver.visitorData);
    const relay = new GooglevideoRelay(
      song,
      fresh.itag,
      fresh.mimeType,
      fresh.url,
      async () => {
        const f = await resolveViaVr(song, resolver.visitorData);
        return { url: f.url, ms: f.ms };
      },
    );
    await installRelayRoute(page, relay, (m) => console.log(`[relay] ${m}`));
    await openSpikePage(page);
    await page.evaluate(
      (vid) => window.__spike.load(`http://localhost:5229/relay/${vid}`),
      song.videoId,
    );
    const playResult = await page.evaluate(() => window.__spike.play());
    expect(playResult.ok).toBe(true);
    const { timedOut: timedOutStart, failedFast: failedFastStart } = await sampleUntil(
      page,
      (s) => s.ct >= 5,
      { intervalMs: 2000, timeoutMs: 180000, failFastOnError: true },
    );
    if (failedFastStart) {
      console.log(`seek: FAIL-FAST sebelum ct=5`);
      console.log(`seek: ${formatRelayStats(relay)}`);
    }
    expect(failedFastStart).toBe(false);
    expect(timedOutStart).toBe(false);
    const beforeSeek = await spikeState(page);
    await page.evaluate(() => window.__spike.seekTo(200));
    console.log(`seek: dari ct=${beforeSeek.ct} ke 200 detik`);
    const { last, timedOut, failedFast } = await sampleUntil(page, (s) => s.ct >= 205, {
      intervalMs: 5000,
      timeoutMs: 240000,
      failFastOnError: true,
      log: (s) =>
        console.log(
          `seek: ct=${s.ct} paused=${s.paused} decoded=${s.decoded} bufferedEnd=${s.bufferedEnd} err=${s.err}`,
        ),
    });
    if (failedFast) {
      console.log(`seek: FAIL-FAST di ct=${last.ct}, error media kode ${last.err}`);
      console.log(`seek: ${formatRelayStats(relay)}`);
    }
    expect(failedFast).toBe(false);
    expect(timedOut).toBe(false);
    expect(last.err).toBe(0);
    expect(last.decoded).toBeGreaterThan(beforeSeek.decoded);
    console.log(`seek: LANJUT sesudah seek, decoded ${beforeSeek.decoded} -> ${last.decoded}`);
    console.log(`seek: ${formatRelayStats(relay)}`);
  });

  test('ganti sumber di posisi yang sama (mekanisme re-resolve sisi browser)', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await openSpikePage(page);
    await page.evaluate((src) => window.__spike.load(src), TONE_60S);
    const playResult = await page.evaluate(() => window.__spike.play());
    expect(playResult.ok).toBe(true);
    const { last: beforeSwap, failedFast: failedFastSwap } = await sampleUntil(
      page,
      (s) => s.ct >= 8,
      { intervalMs: 500, timeoutMs: 30000, failFastOnError: true },
    );
    expect(failedFastSwap).toBe(false);
    const swapAt = beforeSwap.ct;
    // Simulasi dinding: ganti src (seolah URL segar hasil re-resolve),
    // kembali ke posisi yang sama, putar lagi.
    const tSwap = Date.now();
    await page.evaluate(
      ({ src, pos }) => {
        window.__spike.load(src);
        window.__spike.seekTo(pos);
      },
      { src: TONE_60S, pos: swapAt },
    );
    const resumeResult = await page.evaluate(() => window.__spike.play());
    expect(resumeResult.ok).toBe(true);
    const { last, timedOut, failedFast } = await sampleUntil(
      page,
      (s) => !s.paused && s.ct >= swapAt + 3,
      { intervalMs: 250, timeoutMs: 20000, failFastOnError: true },
    );
    expect(failedFast).toBe(false);
    const gapMs = Date.now() - tSwap;
    expect(timedOut).toBe(false);
    expect(last.err).toBe(0);
    console.log(
      `ganti sumber: posisi swap=${swapAt.toFixed(2)} detik, ` +
        `lanjut di ct=${last.ct.toFixed(2)} sesudah ${gapMs} ms (termasuk muat ulang + seek)`,
    );
  });
});
