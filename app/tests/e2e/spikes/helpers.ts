// Helper bersama spesifikasi spike S3/S5/S9.
//
// Aturan log: URL stream TIDAK PERNAH dicetak. Log jaringan hanya
// mencatat host tersamar (*.googlevideo.com), header Range, dan status.
import type { Page, Route } from '@playwright/test';
import { GooglevideoRelay } from './relay';
import { resolveViaVr, type ResolvedSong } from './resolve';
import type { CanarySong } from './canary';

export const SPIKE_PAGE = '/spikes/playback.html';
export const TONE_10S = '/spikes/tone-10s.wav';
export const TONE_60S = '/spikes/tone-60s.wav';

export interface AudioState {
  ct: number;
  dur: number | null;
  paused: boolean;
  ended: boolean;
  rs: number;
  ns: number;
  decoded: number;
  bufferedEnd: number;
  err: number;
  src: string;
}

export interface AudioEvent {
  ev: string;
  t: number;
  ct: number;
  rs: number;
  err: number;
}

export interface MediaSessionInfo {
  supported: boolean;
  title: string | null;
  artist: string | null;
  album: string | null;
  playbackState: string;
  invocations: string[];
}

export interface AnalyserResult {
  ok: boolean;
  samples?: number;
  max?: number;
  avg?: number;
  nonZeroBinsMax?: number;
  bins?: number;
  reason?: string;
}

export interface CorsProbeResult {
  ok: boolean;
  status?: number;
  bytes?: number;
  name?: string;
  message?: string;
}

export interface SpikeApi {
  newAudio(): boolean;
  load(url: string): boolean;
  play(): Promise<{ ok: boolean; name?: string; message?: string }>;
  pause(): boolean;
  seekTo(seconds: number): boolean;
  setRate(rate: number): number;
  state(): AudioState;
  events(): AudioEvent[];
  resetEvents(): boolean;
  setMediaSession(meta: { title: string; artist: string; album: string }): {
    supported: boolean;
  };
  mediaSessionInfo(): MediaSessionInfo;
  connectGraph(): { ok: boolean; reused?: boolean; ctxState?: string; reason?: string };
  resumeGraph(): Promise<{ ok: boolean; ctxState?: string }>;
  analyserSample(durationMs: number): Promise<AnalyserResult>;
  disconnectGraph(): boolean;
  probeFetchCors(url: string, withRange: boolean): Promise<CorsProbeResult>;
  registerSW(): Promise<{
    supported: boolean;
    registered?: boolean;
    scope?: string;
    active?: boolean;
    error?: string;
  }>;
  swInfo(): Promise<{
    supported: boolean;
    hasRegistration?: boolean;
    active?: boolean;
    controlling?: boolean;
  }>;
  manifestInfo(): Promise<{ ok: boolean; status?: number; manifest?: Record<string, unknown>; error?: string }>;
  visibility(): { state: string; hidden: boolean };
}

declare global {
  interface Window {
    __spike: SpikeApi;
  }
}

export async function openSpikePage(page: Page): Promise<void> {
  await page.goto(SPIKE_PAGE);
  await page.waitForFunction(() => Boolean(window.__spike), undefined, {
    timeout: 30000,
  });
}

export function spikeState(page: Page): Promise<AudioState> {
  return page.evaluate(() => window.__spike.state());
}

export function spikeEvents(page: Page): Promise<AudioEvent[]> {
  return page.evaluate(() => window.__spike.events());
}

/**
 * Pasang route relay googlevideo. Menangani pola **\/relay/* untuk host
 * apa pun (localhost = same-origin, 127.0.0.1 = lintas origin untuk S5).
 */
export function installRelayRoute(
  page: Page,
  relay: GooglevideoRelay,
  log: (msg: string) => void,
): Promise<void> {
  return page.route('**/relay/*', async (route: Route) => {
    const range = route.request().headers().range ?? '(tanpa Range)';
    try {
      const served = await relay.serve(range === '(tanpa Range)' ? undefined : range);
      log(
        `relay layani range=${range} ${served.body.length} byte ` +
          `(cache=${served.fromCache})`,
      );
      await route.fulfill({
        status: served.status,
        contentType: served.headers['Content-Type'],
        headers: {
          'Content-Range': served.headers['Content-Range'],
          'Accept-Ranges': 'bytes',
        },
        body: served.body,
      });
    } catch (e) {
      log(`relay GAGAL range=${range}: ${String(e).slice(0, 160)}`);
      await route.fulfill({
        status: 502,
        contentType: 'text/plain',
        body: 'relay upstream gagal',
      });
    }
  });
}

export function makeRelay(
  resolved: ResolvedSong,
  visitorData: string | null,
): GooglevideoRelay {
  const song: CanarySong = resolved.song;
  return new GooglevideoRelay(
    song,
    resolved.itag,
    resolved.mimeType.split(';')[0],
    resolved.url,
    async () => {
      const fresh = await resolveViaVr(song, visitorData);
      return { url: fresh.url, ms: fresh.ms };
    },
  );
}

/** Ringkasan stall dari log event: jumlah waiting + total durasi stall. */
export function summarizeStalls(events: AudioEvent[]): {
  waitingCount: number;
  stallMsTotal: number;
} {
  let waitingCount = 0;
  let stallMsTotal = 0;
  let waitingSince: number | null = null;
  for (const e of events) {
    if (e.ev === 'waiting' && waitingSince === null) {
      waitingSince = e.t;
      waitingCount++;
    } else if (e.ev === 'playing' && waitingSince !== null) {
      stallMsTotal += e.t - waitingSince;
      waitingSince = null;
    }
  }
  return { waitingCount, stallMsTotal };
}

export function formatRelayStats(relay: GooglevideoRelay): string {
  const s = relay.stats;
  return (
    `upstream fetch=${s.upstreamFetches} (${s.upstreamMs} ms, ${s.upstreamBytes} byte), ` +
    `dilayani=${s.servedRequests} req (${s.servedBytes} byte, cache hit=${s.cacheHits}), ` +
    `re-resolve=${s.reresolves} [${s.reresolveReasons.join('; ') || 'tidak ada'}], ` +
    `adaptasi=[${s.adaptations.join('; ') || 'tidak ada'}], ` +
    `gagal=${s.failures.length}`
  );
}

/**
 * Sampel state audio berkala sampai predikat terpenuhi atau timeout.
 * Mengembalikan semua sampel + state terakhir.
 *
 * Opsi failFastOnError (perbaikan S3 17 Nov 2026): bila elemen audio
 * mencatat error media (err !== 0), sampling berhenti SEGERA dan
 * mengembalikan failedFast=true, alih-alih membakar seluruh timeout
 * menunggu predikat yang tidak akan pernah terpenuhi. Pemanggil WAJIB
 * menguji failedFast dan menggagalkan uji dengan pesan yang jelas.
 * Jangan dipakai pada uji yang MENGGUNAKAN err sebagai predikat
 * (mis. uji jalur langsung S3, yang memang mengharapkan error).
 */
export async function sampleUntil(
  page: Page,
  predicate: (s: AudioState) => boolean,
  opts: {
    intervalMs: number;
    timeoutMs: number;
    log?: (s: AudioState, i: number) => void;
    failFastOnError?: boolean;
  },
): Promise<{
  samples: AudioState[];
  last: AudioState;
  timedOut: boolean;
  failedFast: boolean;
}> {
  const samples: AudioState[] = [];
  const deadline = Date.now() + opts.timeoutMs;
  let i = 0;
  for (;;) {
    const s = await spikeState(page);
    samples.push(s);
    if (opts.log) opts.log(s, i);
    i++;
    if (predicate(s)) {
      return { samples, last: s, timedOut: false, failedFast: false };
    }
    if (opts.failFastOnError && s.err !== 0) {
      return { samples, last: s, timedOut: false, failedFast: true };
    }
    if (Date.now() >= deadline) {
      return { samples, last: s, timedOut: true, failedFast: false };
    }
    await page.waitForTimeout(
      Math.min(opts.intervalMs, Math.max(0, deadline - Date.now())),
    );
  }
}
