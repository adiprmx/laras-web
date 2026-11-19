/**
 * Tes kerangka failover CF -> Render (proxyFailover.ts).
 *
 * Modul ini DRAFT dan belum di-wire (RENDER_FAILOVER_ENABLED false);
 * tes memakai opts.enabled untuk membuktikan logika failover tanpa
 * mengubah saklar global.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { PROXY_BASE_URL, type ClientDefinition } from '../spike/config';
import { InnertubeError } from '../extractor/innertube';
import type { CachedStream } from '../extractor/resolveCache';
import {
  INVIDIOUS_FAILOVER_ENABLED,
  RENDER_FAILOVER_ENABLED,
  RENDER_PROXY_BASE_URL,
  fetchCachedStreamWithInvidiousFallback,
  postInnertubeWithFailover,
} from './proxyFailover';

const CLIENT: ClientDefinition = {
  name: 'WEB_REMIX',
  version: '1.20261110.04.00',
  clientId: '67',
  context: {
    clientName: 'WEB_REMIX',
    clientVersion: '1.20261110.04.00',
  },
  requiresScript: true,
};

const BODY = { videoId: 'hhn-nGSuenM' };
const PLAYER_PATH = '/api/innertube/player';
const SEARCH_PATH = '/api/innertube/search';

function playerJson(status: string, audioFormats = 1) {
  return {
    playabilityStatus: { status },
    streamingData: {
      adaptiveFormats: Array.from({ length: audioFormats }, (_, i) => ({
        itag: 140 + i,
        mimeType: 'audio/mp4',
      })),
    },
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('proxyFailover (kerangka, belum di-wire)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('saklar global masih MATI sampai vonis BERSIH', () => {
    expect(RENDER_FAILOVER_ENABLED).toBe(false);
  });

  it('URL Render adalah layanan yang direncanakan', () => {
    expect(RENDER_PROXY_BASE_URL).toBe(
      'https://laras-proxy-render.onrender.com',
    );
  });

  it('default (tanpa failover): CF OK -> satu panggilan, egress cloudflare', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(playerJson('OK')),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await postInnertubeWithFailover(
      PLAYER_PATH,
      BODY,
      CLIENT,
      1000,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `${PROXY_BASE_URL}${PLAYER_PATH}`,
    );
    expect(result.egress).toBe('cloudflare');
    expect(result.tried).toEqual(['cloudflare']);
    expect(result.status).toBe(200);
  });

  it('default: CF LOGIN_REQUIRED -> TIDAK failover (saklar mati)', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(playerJson('LOGIN_REQUIRED', 0)),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await postInnertubeWithFailover(
      PLAYER_PATH,
      BODY,
      CLIENT,
      1000,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.egress).toBe('cloudflare');
    expect(
      (result.json.playabilityStatus as { status: string }).status,
    ).toBe('LOGIN_REQUIRED');
  });

  it('aktif + CF OK -> tetap satu panggilan ke CF', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(playerJson('OK')));
    vi.stubGlobal('fetch', fetchMock);
    const result = await postInnertubeWithFailover(
      PLAYER_PATH,
      BODY,
      CLIENT,
      1000,
      { enabled: true },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.egress).toBe('cloudflare');
  });

  it('aktif + CF LOGIN_REQUIRED -> failover ke Render, hasil Render dipakai', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith(RENDER_PROXY_BASE_URL)) {
        return jsonResponse(playerJson('OK'));
      }
      return jsonResponse(playerJson('LOGIN_REQUIRED', 0));
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await postInnertubeWithFailover(
      PLAYER_PATH,
      BODY,
      CLIENT,
      1000,
      { enabled: true },
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `${PROXY_BASE_URL}${PLAYER_PATH}`,
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `${RENDER_PROXY_BASE_URL}${PLAYER_PATH}`,
    );
    expect(result.egress).toBe('render');
    expect(result.tried).toEqual(['cloudflare', 'render']);
    expect(
      (result.json.playabilityStatus as { status: string }).status,
    ).toBe('OK');
  });

  it('aktif + kedua egress menolak -> hasil Render dikembalikan apa adanya', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(playerJson('LOGIN_REQUIRED', 0)),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await postInnertubeWithFailover(
      PLAYER_PATH,
      BODY,
      CLIENT,
      1000,
      { enabled: true },
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.egress).toBe('render');
    expect(
      (result.json.playabilityStatus as { status: string }).status,
    ).toBe('LOGIN_REQUIRED');
  });

  it('aktif + CF galat jaringan -> failover ke Render', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith(RENDER_PROXY_BASE_URL)) {
        return jsonResponse(playerJson('OK'));
      }
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await postInnertubeWithFailover(
      PLAYER_PATH,
      BODY,
      CLIENT,
      1000,
      { enabled: true },
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.egress).toBe('render');
  });

  it('aktif + CF 429 -> failover ke Render', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith(RENDER_PROXY_BASE_URL)) {
        return jsonResponse(playerJson('OK'));
      }
      return jsonResponse(
        {
          success: false,
          error: { code: 'RATE_LIMITED', message: 'Terlalu banyak' },
        },
        429,
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await postInnertubeWithFailover(
      PLAYER_PATH,
      BODY,
      CLIENT,
      1000,
      { enabled: true },
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.egress).toBe('render');
  });

  it('aktif + CF dan Render sama-sama melempar -> galat Render lolos', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith(RENDER_PROXY_BASE_URL)) {
        throw new TypeError('Render gagal');
      }
      throw new TypeError('CF gagal');
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      postInnertubeWithFailover(PLAYER_PATH, BODY, CLIENT, 1000, {
        enabled: true,
      }),
    ).rejects.toThrow('Render gagal');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('aktif + jalur search: tidak ada playability -> tidak failover dari isi JSON', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ contents: { foo: 'bar' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await postInnertubeWithFailover(
      SEARCH_PATH,
      { query: 'x' },
      CLIENT,
      1000,
      { enabled: true },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.egress).toBe('cloudflare');
  });

  it('aktif + jalur search CF melempar InnertubeError -> failover', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith(RENDER_PROXY_BASE_URL)) {
        return jsonResponse({ contents: {} });
      }
      return jsonResponse(
        { success: false, error: { code: 'UPSTREAM_ERROR', message: 'x' } },
        502,
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await postInnertubeWithFailover(
      SEARCH_PATH,
      { query: 'x' },
      CLIENT,
      1000,
      { enabled: true },
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.egress).toBe('render');
  });

  it('tanpa failover + CF melempar InnertubeError -> galat lolos apa adanya', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        { success: false, error: { code: 'RATE_LIMITED', message: 'x' } },
        429,
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const error = await postInnertubeWithFailover(
      PLAYER_PATH,
      BODY,
      CLIENT,
      1000,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InnertubeError);
    expect((error as InnertubeError).kind).toBe('rate-limited');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('fetchCachedStreamWithInvidiousFallback (cadangan terakhir)', () => {
  const cacheHit: CachedStream = {
    videoId: 'hhn-nGSuenM',
    title: 'Semua Tentang Kita',
    url: 'https://rr1---sn-ajab55-cx.googlevideo.com/videoplayback?expire=9999999999',
    itag: 251,
    bitrate: 155000,
    client: 'ANDROID_VR',
    expiresAtMs: 9999999999000,
    resolvedAtMs: 0,
  };
  const invidiousHit: CachedStream = {
    ...cacheHit,
    client: 'INVIDIOUS',
  };

  it('saklar Invidious AKTIF sesudah vonis BERSIH re-probe', () => {
    expect(INVIDIOUS_FAILOVER_ENABLED).toBe(true);
  });

  it('cache D1 ada -> dipakai, Invidious tidak dipanggil', async () => {
    const cacheLookup = vi.fn(async () => cacheHit);
    const invidiousLookup = vi.fn(async () => invidiousHit);
    const out = await fetchCachedStreamWithInvidiousFallback('hhn-nGSuenM', {
      cacheLookup,
      invidiousLookup,
    });
    expect(out).toBe(cacheHit);
    expect(cacheLookup).toHaveBeenCalledTimes(1);
    expect(invidiousLookup).not.toHaveBeenCalled();
  });

  it('cache kosong + aktif -> Invidious dipanggil', async () => {
    const cacheLookup = vi.fn(async () => null);
    const invidiousLookup = vi.fn(async () => invidiousHit);
    const out = await fetchCachedStreamWithInvidiousFallback('hhn-nGSuenM', {
      cacheLookup,
      invidiousLookup,
    });
    expect(out).toBe(invidiousHit);
    expect(cacheLookup).toHaveBeenCalledTimes(1);
    expect(invidiousLookup).toHaveBeenCalledTimes(1);
    expect(invidiousLookup).toHaveBeenCalledWith('hhn-nGSuenM');
  });

  it('cache kosong + nonaktif -> null, Invidious tidak dipanggil', async () => {
    const cacheLookup = vi.fn(async () => null);
    const invidiousLookup = vi.fn(async () => invidiousHit);
    const out = await fetchCachedStreamWithInvidiousFallback('hhn-nGSuenM', {
      enabled: false,
      cacheLookup,
      invidiousLookup,
    });
    expect(out).toBeNull();
    expect(invidiousLookup).not.toHaveBeenCalled();
  });

  it('keduanya kosong -> null', async () => {
    const out = await fetchCachedStreamWithInvidiousFallback('hhn-nGSuenM', {
      cacheLookup: async () => null,
      invidiousLookup: async () => null,
    });
    expect(out).toBeNull();
  });
});
