/**
 * Tes Vitest cadangan cache D1 di StreamResolver (P3).
 *
 * Menutup: resolve langsung gagal di semua client -> cache
 * dipakai (fromCache true); cache kosong -> ResolveError seperti
 * semula; lookup cache yang melempar tidak menutupi penyebab
 * asli; cache TIDAK disentuh bila resolve langsung berhasil.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ResolveError,
  StreamResolver,
} from './resolve';
import {
  createConfigLoader,
  createMemoryStorage,
} from '../resilience/configStore';
import type { CachedStream } from './resolveCache';

const CONFIG_JSON = {
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

const STREAM_URL =
  'https://rr1---sn-a.googlevideo.com/videoplayback?expire=1999999999&itag=251';
const CACHED_URL =
  'https://rr2---sn-b.googlevideo.com/videoplayback?expire=1999999999&itag=140';

const SONG = { videoId: 'hhn-nGSuenM', title: 'Semua Tentang Kita' };

function playerBody(
  playability: string,
  withUrl: boolean,
): Record<string, unknown> {
  return {
    playabilityStatus: { status: playability },
    streamingData: {
      adaptiveFormats: withUrl
        ? [
            {
              itag: 251,
              mimeType: 'audio/webm; codecs="opus"',
              bitrate: 160000,
              url: STREAM_URL,
            },
          ]
        : [],
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function makeResolver(
  cacheLookup: (videoId: string) => Promise<CachedStream | null>,
): Promise<StreamResolver> {
  const loader = createConfigLoader({
    fetchFn: (async () =>
      jsonResponse(CONFIG_JSON)) as unknown as typeof fetch,
    storage: createMemoryStorage(),
  });
  const resolver = new StreamResolver({ configLoader: loader, cacheLookup });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/api/innertube/search')) return jsonResponse({});
      throw new Error(`fetch tak terduga saat init: ${url}`);
    }),
  );
  await resolver.init();
  return resolver;
}

function stubPlayerRefused(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/api/innertube/player')) {
        return jsonResponse(playerBody('LOGIN_REQUIRED', false));
      }
      throw new Error(`fetch tak terduga: ${url}`);
    }),
  );
}

const CACHED: CachedStream = {
  videoId: 'hhn-nGSuenM',
  title: 'Semua Tentang Kita',
  url: CACHED_URL,
  itag: 140,
  bitrate: 128000,
  client: 'ANDROID_VR',
  expiresAtMs: Date.now() + 3600 * 1000,
  resolvedAtMs: Date.now() - 60 * 1000,
};

describe('StreamResolver cadangan cache (P3)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolve gagal semua -> cache dipakai, fromCache true', async () => {
    const lookup = vi.fn(async () => CACHED);
    const resolver = await makeResolver(lookup);
    stubPlayerRefused();
    const out = await resolver.resolve(SONG, {
      maxRounds: 1,
      delay: async () => undefined,
    });
    expect(out.url).toBe(CACHED_URL);
    expect(out.itag).toBe(140);
    expect(out.client).toBe('ANDROID_VR');
    expect(out.fromCache).toBe(true);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith('hhn-nGSuenM');
  });

  it('resolve gagal + cache kosong -> ResolveError seperti semula', async () => {
    const lookup = vi.fn(async () => null);
    const resolver = await makeResolver(lookup);
    stubPlayerRefused();
    await expect(
      resolver.resolve(SONG, { maxRounds: 1, delay: async () => undefined }),
    ).rejects.toBeInstanceOf(ResolveError);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('lookup cache melempar -> ResolveError asli tetap yang dilempar', async () => {
    const lookup = vi.fn(async () => {
      throw new Error('D1 meledak');
    });
    const resolver = await makeResolver(lookup);
    stubPlayerRefused();
    await expect(
      resolver.resolve(SONG, { maxRounds: 1, delay: async () => undefined }),
    ).rejects.toBeInstanceOf(ResolveError);
  });

  it('resolve langsung berhasil -> cache TIDAK disentuh', async () => {
    const lookup = vi.fn(async () => CACHED);
    const resolver = await makeResolver(lookup);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/innertube/player')) {
          return jsonResponse(playerBody('OK', true));
        }
        throw new Error(`fetch tak terduga: ${url}`);
      }),
    );
    const out = await resolver.resolve(SONG, {
      maxRounds: 1,
      delay: async () => undefined,
    });
    expect(out.url).toBe(STREAM_URL);
    expect(out.fromCache).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });
});
