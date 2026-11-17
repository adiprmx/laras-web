// Spike S5: vonis Web Audio CORS, createMediaElementSource pada URL
// googlevideo + deteksi runtime (arsitektur.md §3.4, §8).
//
// Pertanyaan: apakah graph Web Audio (EQ) bisa dipakai untuk streaming
// langsung? createMediaElementSource hanya mengeluarkan suara bila
// respons membawa header CORS yang mengizinkan. Bila tidak, output
// graph sunyi.
//
// Bukti berlapis (tidak satu pun berdiri sendiri):
// 1. Probe header sisi Node: apakah googlevideo mengirim
//    Access-Control-Allow-Origin sama sekali.
// 2. Fetch CORS dari halaman browser ke URL googlevideo.
// 3. Kontrol positif: graph same-origin (nada lokal + relay same-origin)
//    WAJIB mengeluarkan suara (membuktikan pengukuran analyser valid).
// 4. Uji penentu: graph pada sumber lintas origin TANPA header CORS
//    (relay lewat origin kedua 127.0.0.1, tanpa ACAO) WAJIB sunyi
//    sementara elemennya sendiri terbukti memutar (decoded bertambah).
//    Ini mengisolasi efek CORS dari efek "audio tidak termuat".
//
// Urutan sengaja: kontrol positif dulu, baru uji penentu. Bila kontrol
// gagal, angka nol pada uji penentu tidak berarti apa-apa.
import { expect, test } from '@playwright/test';
import { CANARY_SONGS } from './canary';

// Di bawah konfigurasi E2E utama (preview build, port 4173) spesifikasi
// ini MELEWATI dirinya sendiri — halaman spike tidak ada di build
// produksi. Dijalankan dengan: npx playwright test -c playwright.spikes.config.ts
test.skip(
  async ({ baseURL }) => (baseURL ?? '').includes('4173'),
  'spike S5 hanya jalan di server spike (port 5229), bukan preview build',
);
import { createResolver, resolveViaVr, type Resolver } from './resolve';
import { GooglevideoRelay, probeGooglevideoCorsHeaders } from './relay';
import {
  TONE_60S,
  installRelayRoute,
  openSpikePage,
  sampleUntil,
  spikeState,
} from './helpers';

test.describe('S5 Web Audio CORS', () => {
  let resolver: Resolver;

  test.beforeAll(async () => {
    if (test.info().project.name !== 'chromium') {
      test.skip(true, 'S5: mesin Blink sama di kedua proyek, cukup desktop');
    }
    test.setTimeout(120000);
    resolver = await createResolver();
    console.log(
      `resolver siap: sts=${resolver.sts} visitorData=${resolver.visitorData ? 'ada' : 'tidak ada'}`,
    );
  });

  test('header CORS googlevideo dari sisi Node: tidak ada ACAO', async () => {
    test.setTimeout(180000);
    const song = CANARY_SONGS[1];
    const fresh = await resolveViaVr(song, resolver.visitorData);
    const h = await probeGooglevideoCorsHeaders(fresh.url);
    console.log(
      `header CORS: GET Range status=${h.getStatus} bytes=${h.getBytes} ` +
        `ACAO=${h.getAcao ?? 'TIDAK ADA'}`,
    );
    console.log(
      `header CORS: OPTIONS preflight status=${h.optionsStatus} ` +
        `ACAO=${h.optionsAcao ?? 'TIDAK ADA'} ` +
        `Allow-Methods=${h.optionsAllowMethods ?? 'TIDAK ADA'}`,
    );
    // googlevideo tidak mengirim header CORS untuk fetch audio.
    expect(h.getAcao).toBeNull();
    expect(h.optionsAcao).toBeNull();
  });

  test('fetch CORS dari browser ke googlevideo ditolak; same-origin lolos', async ({
    page,
  }) => {
    test.setTimeout(180000);
    const song = CANARY_SONGS[1];
    const fresh = await resolveViaVr(song, resolver.visitorData);
    await openSpikePage(page);
    const noRange = await page.evaluate(
      (url) => window.__spike.probeFetchCors(url, false),
      fresh.url,
    );
    console.log(`fetch CORS googlevideo tanpa Range: ${JSON.stringify(noRange)}`);
    const withRange = await page.evaluate(
      (url) => window.__spike.probeFetchCors(url, true),
      fresh.url,
    );
    console.log(`fetch CORS googlevideo dengan Range: ${JSON.stringify(withRange)}`);
    expect(noRange.ok).toBe(false);
    expect(withRange.ok).toBe(false);
    // Kontrol: fetch same-origin ke nada lokal harus lolos (membuktikan
    // helper probeFetchCors sendiri berfungsi).
    const local = await page.evaluate(
      (src) => window.__spike.probeFetchCors(src, true),
      TONE_60S,
    );
    console.log(`fetch CORS same-origin nada lokal: ${JSON.stringify(local)}`);
    expect(local.ok).toBe(true);
    expect(local.status).toBe(206);
  });

  test('kontrol positif: graph same-origin mengeluarkan suara', async ({
    page,
  }) => {
    test.setTimeout(300000);
    await openSpikePage(page);
    // Kontrol A: nada lokal 60 detik.
    await page.evaluate((src) => window.__spike.load(src), TONE_60S);
    const playA = await page.evaluate(() => window.__spike.play());
    expect(playA.ok).toBe(true);
    const graphA = await page.evaluate(() => window.__spike.connectGraph());
    expect(graphA.ok).toBe(true);
    const resumedA = await page.evaluate(() => window.__spike.resumeGraph());
    console.log(`kontrol nada: graph ctx=${resumedA.ctxState}`);
    expect(resumedA.ctxState).toBe('running');
    const sampleA = await page.evaluate(() => window.__spike.analyserSample(3000));
    console.log(`kontrol nada: analyser=${JSON.stringify(sampleA)}`);
    expect(sampleA.ok).toBe(true);
    expect(sampleA.max).toBeGreaterThan(0);
    // Kontrol B: byte Opus asli lewat relay SAME-ORIGIN.
    await page.evaluate(() => window.__spike.newAudio());
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
    await page.evaluate(
      (vid) => window.__spike.load(`http://localhost:5229/relay/${vid}`),
      song.videoId,
    );
    const playB = await page.evaluate(() => window.__spike.play());
    expect(playB.ok).toBe(true);
    const { timedOut } = await sampleUntil(page, (s) => s.decoded > 0, {
      intervalMs: 1000,
      timeoutMs: 180000,
    });
    expect(timedOut).toBe(false);
    const graphB = await page.evaluate(() => window.__spike.connectGraph());
    expect(graphB.ok).toBe(true);
    const resumedB = await page.evaluate(() => window.__spike.resumeGraph());
    expect(resumedB.ctxState).toBe('running');
    const sampleB = await page.evaluate(() => window.__spike.analyserSample(5000));
    console.log(`kontrol relay same-origin: analyser=${JSON.stringify(sampleB)}`);
    expect(sampleB.ok).toBe(true);
    expect(sampleB.max).toBeGreaterThan(0);
  });

  test('graph pada sumber lintas origin tanpa CORS: sunyi', async ({ page }) => {
    test.setTimeout(300000);
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
    // Halaman di http://localhost:5229; sumber di http://127.0.0.1:5229
    // = lintas origin. Relay TIDAK mengirim header CORS (sama seperti
    // googlevideo yang terbukti tidak mengirim ACAO).
    await page.evaluate(
      (vid) => window.__spike.load(`http://127.0.0.1:5229/relay/${vid}`),
      song.videoId,
    );
    const playResult = await page.evaluate(() => window.__spike.play());
    expect(playResult.ok).toBe(true);
    const { timedOut } = await sampleUntil(page, (s) => s.decoded > 0, {
      intervalMs: 1000,
      timeoutMs: 180000,
    });
    expect(timedOut).toBe(false);
    const before = await spikeState(page);
    console.log(
      `lintas origin: elemen memutar ct=${before.ct} decoded=${before.decoded} (audio mengalir ke elemen)`,
    );
    const graph = await page.evaluate(() => window.__spike.connectGraph());
    expect(graph.ok).toBe(true);
    const resumed = await page.evaluate(() => window.__spike.resumeGraph());
    expect(resumed.ctxState).toBe('running');
    const sample = await page.evaluate(() => window.__spike.analyserSample(5000));
    const after = await spikeState(page);
    console.log(`lintas origin: analyser=${JSON.stringify(sample)}`);
    console.log(
      `lintas origin: sesudah sampling ct=${after.ct} decoded=${after.decoded} ` +
        `(decoded bertambah ${after.decoded - before.decoded} selama graph tersambung)`,
    );
    // Elemen terbukti memutar (decoded bertambah) tetapi graph sunyi:
    // itulah perilaku sumber tercemar CORS.
    expect(after.decoded).toBeGreaterThan(before.decoded);
    expect(sample.ok).toBe(true);
    expect(sample.max).toBe(0);
    expect(sample.nonZeroBinsMax).toBe(0);
  });
});
