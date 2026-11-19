/**
 * Tes klien Invidious cadangan-terakhir (invidious.ts).
 *
 * Fixture meniru bentuk respons asli /api/v1/videos (tangkapan P4,
 * hidden_files/koordinator/p4-invidious-full.json): itag/bitrate
 * berupa string, `type` membawa suffix codecs, URL googlevideo
 * membawa param `expire` (epoch detik).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  INVIDIOUS_CLIENT_NAME,
  INVIDIOUS_INSTANCE_URL,
  fetchInvidiousStream,
  parseInvidiousStream,
} from './invidious';

const VIDEO_ID = 'hhn-nGSuenM';
const NOW_MS = Date.UTC(2026, 10, 20, 0, 0, 0);
const EXPIRE_SEC = Math.floor(NOW_MS / 1000) + 3600;

function audioUrl(itag: number, expireSec: number = EXPIRE_SEC): string {
  return (
    `https://rr1---sn-ajab55-cx.googlevideo.com/videoplayback` +
    `?expire=${expireSec}&ei=test${itag}`
  );
}

function audioFormat(itag: number, expireSec: number = EXPIRE_SEC) {
  const opus = itag >= 249;
  return {
    itag: String(itag),
    type: opus ? 'audio/webm; codecs="opus"' : 'audio/mp4; codecs="mp4a.40.2"',
    bitrate: String(itag * 1000),
    url: audioUrl(itag, expireSec),
    container: opus ? 'webm' : 'm4a',
    encoding: opus ? 'opus' : 'aac',
  };
}

function invidiousJson(itags: number[], expireSec: number = EXPIRE_SEC) {
  return {
    videoId: VIDEO_ID,
    title: 'Semua Tentang Kita',
    adaptiveFormats: itags.map((itag) => audioFormat(itag, expireSec)),
    formatStreams: [],
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('parseInvidiousStream', () => {
  it('respons valid -> itag 251 (urutan kanonis pertama)', () => {
    const out = parseInvidiousStream(
      invidiousJson([139, 140, 249, 250, 251]),
      VIDEO_ID,
      NOW_MS,
    );
    expect(out).not.toBeNull();
    expect(out?.itag).toBe(251);
    expect(out?.bitrate).toBe(251000);
    expect(out?.client).toBe(INVIDIOUS_CLIENT_NAME);
    expect(out?.videoId).toBe(VIDEO_ID);
    expect(out?.title).toBe('Semua Tentang Kita');
    expect(out?.url).toBe(audioUrl(251));
    expect(out?.expiresAtMs).toBe(EXPIRE_SEC * 1000);
    expect(out?.resolvedAtMs).toBe(NOW_MS);
  });

  it('251 tidak ada -> jatuh ke 140', () => {
    const out = parseInvidiousStream(
      invidiousJson([139, 140, 249]),
      VIDEO_ID,
      NOW_MS,
    );
    expect(out?.itag).toBe(140);
  });

  it('URL 251 bukan googlevideo -> dilewati, pakai 140', () => {
    const json = invidiousJson([140, 251]);
    const f251 = json.adaptiveFormats.find((f) => f.itag === '251');
    if (f251) f251.url = 'https://evil.example.com/videoplayback?expire=9999999999';
    const out = parseInvidiousStream(json, VIDEO_ID, NOW_MS);
    expect(out?.itag).toBe(140);
  });

  it('semua URL bukan googlevideo -> null', () => {
    const json = invidiousJson([140, 251]);
    for (const f of json.adaptiveFormats) {
      f.url = 'https://evil.example.com/videoplayback?expire=9999999999';
    }
    expect(parseInvidiousStream(json, VIDEO_ID, NOW_MS)).toBeNull();
  });

  it('URL 251 kedaluwarsa -> dilewati, pakai 140 yang segar', () => {
    const json = invidiousJson([140, 251]);
    const f251 = json.adaptiveFormats.find((f) => f.itag === '251');
    if (f251) {
      f251.url = audioUrl(251, Math.floor(NOW_MS / 1000) - 10);
    }
    const out = parseInvidiousStream(json, VIDEO_ID, NOW_MS);
    expect(out?.itag).toBe(140);
  });

  it('URL tinggal < 60 detik (margin aman) -> null', () => {
    const expireSoon = Math.floor(NOW_MS / 1000) + 30;
    const out = parseInvidiousStream(
      invidiousJson([251], expireSoon),
      VIDEO_ID,
      NOW_MS,
    );
    expect(out).toBeNull();
  });

  it('URL tanpa param expire -> null', () => {
    const json = invidiousJson([251]);
    const f251 = json.adaptiveFormats.find((f) => f.itag === '251');
    if (f251) {
      f251.url =
        'https://rr1---sn-ajab55-cx.googlevideo.com/videoplayback?ei=test251';
    }
    expect(parseInvidiousStream(json, VIDEO_ID, NOW_MS)).toBeNull();
  });

  it('balasan error Invidious -> null', () => {
    expect(
      parseInvidiousStream({ error: 'Video is unavailable' }, VIDEO_ID, NOW_MS),
    ).toBeNull();
  });

  it('tanpa adaptiveFormats -> null', () => {
    expect(
      parseInvidiousStream({ videoId: VIDEO_ID }, VIDEO_ID, NOW_MS),
    ).toBeNull();
  });

  it('hanya format video -> null', () => {
    const json = {
      videoId: VIDEO_ID,
      adaptiveFormats: [
        {
          itag: '137',
          type: 'video/mp4; codecs="avc1.640028"',
          bitrate: '5000000',
          url: audioUrl(137),
        },
      ],
    };
    expect(parseInvidiousStream(json, VIDEO_ID, NOW_MS)).toBeNull();
  });

  it('JSON bukan objek -> null', () => {
    expect(parseInvidiousStream(null, VIDEO_ID, NOW_MS)).toBeNull();
    expect(parseInvidiousStream('x', VIDEO_ID, NOW_MS)).toBeNull();
    expect(parseInvidiousStream([1, 2], VIDEO_ID, NOW_MS)).toBeNull();
  });
});

describe('fetchInvidiousStream', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetch OK -> stream ter-parse, URL endpoint benar', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(invidiousJson([139, 140, 251])),
    );
    vi.stubGlobal('fetch', fetchMock);
    const out = await fetchInvidiousStream(VIDEO_ID, { nowMs: NOW_MS });
    expect(out?.itag).toBe(251);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `${INVIDIOUS_INSTANCE_URL}/api/v1/videos/${VIDEO_ID}`,
    );
  });

  it('HTTP 500 -> null', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ error: 'boom' }, 500),
    );
    vi.stubGlobal('fetch', fetchMock);
    const out = await fetchInvidiousStream(VIDEO_ID, { nowMs: NOW_MS });
    expect(out).toBeNull();
  });

  it('fetch melempar -> null (tidak pernah melempar)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new Error('jaringan mati');
    });
    vi.stubGlobal('fetch', fetchMock);
    const out = await fetchInvidiousStream(VIDEO_ID, { nowMs: NOW_MS });
    expect(out).toBeNull();
  });

  it('balasan bukan JSON -> null', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response('bukan json', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const out = await fetchInvidiousStream(VIDEO_ID, { nowMs: NOW_MS });
    expect(out).toBeNull();
  });
});
