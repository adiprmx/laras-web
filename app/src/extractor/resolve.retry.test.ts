import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ResolveError,
  StreamResolver,
} from './resolve';
import {
  createConfigLoader,
  createMemoryStorage,
} from '../resilience/configStore';
import { RESOLVE_RETRY_BACKOFF_MS } from '../resilience/retry';

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

/** Config tanpa client utama (K6: WEB_REMIX dimatikan di config). */
const CONFIG_NO_WEB_REMIX = {
  clients: [
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

/**
 * Buat resolver terkonfigurasi: config dari loader injeksi (tanpa
 * IndexedDB, tanpa fetch global), visitorData dari search mock
 * (kosong, tidak memblokir).
 */
async function makeResolver(
  configJson: unknown = CONFIG_JSON,
): Promise<StreamResolver> {
  const loader = createConfigLoader({
    fetchFn: (async () =>
      jsonResponse(configJson)) as unknown as typeof fetch,
    storage: createMemoryStorage(),
  });
  const resolver = new StreamResolver({ configLoader: loader });
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

describe('StreamResolver retry lintas waktu (P6)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lolos di putaran ke-2 sesudah semua client LOGIN_REQUIRED (bukti §5)', async () => {
    const resolver = await makeResolver();
    let playerCalls = 0;
    const waits: number[] = [];
    const rounds: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/innertube/player')) {
          playerCalls += 1;
          // Putaran 1 (3 client): semua LOGIN_REQUIRED.
          // Putaran 2: WEB_REMIX lolos (jendela berbalik).
          const refused = playerCalls <= 3;
          return jsonResponse(playerBody(refused ? 'LOGIN_REQUIRED' : 'OK', !refused));
        }
        throw new Error(`fetch tak terduga: ${url}`);
      }),
    );
    const resolved = await resolver.resolve(
      { videoId: 'hhn-nGSuenM', title: 'Semua Tentang Kita' },
      {
        delay: async (ms) => {
          waits.push(ms);
        },
        onRetryRound: (round, waitMs) => {
          rounds.push(round);
          expect(waitMs).toBe(RESOLVE_RETRY_BACKOFF_MS[0]);
        },
      },
    );
    expect(resolved.client).toBe('WEB_REMIX');
    expect(resolved.url).toBe(STREAM_URL);
    expect(playerCalls).toBe(4);
    expect(waits).toEqual([5000]);
    expect(rounds).toEqual([2]);
    expect(resolver.lastResolve?.rounds).toBe(2);
  });

  it('menyerah sesudah 3 putaran: maks 9 request, backoff 5 dtk + 15 dtk', async () => {
    const resolver = await makeResolver();
    let playerCalls = 0;
    const waits: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/innertube/player')) {
          playerCalls += 1;
          return jsonResponse(playerBody('LOGIN_REQUIRED', false));
        }
        throw new Error(`fetch tak terduga: ${url}`);
      }),
    );
    let caught: unknown;
    try {
      await resolver.resolve(
        { videoId: 'hhn-nGSuenM', title: 'Semua Tentang Kita' },
        { delay: async (ms) => { waits.push(ms); } },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ResolveError);
    expect(playerCalls).toBe(9);
    expect(waits).toEqual([5000, 15000]);
    expect(resolver.lastResolve?.rounds).toBe(3);
    expect(resolver.lastResolve?.clientsTried).toEqual([
      'WEB_REMIX',
      'MWEB',
      'ANDROID_VR',
    ]);
    const attempts = (caught as ResolveError).attempts;
    expect(attempts).toHaveLength(9);
    expect(attempts.every((a) => a.endsWith('=LOGIN_REQUIRED'))).toBe(true);
  });

  it('UNPLAYABLE tanpa format juga di-retry', async () => {
    const resolver = await makeResolver();
    let playerCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/innertube/player')) {
          playerCalls += 1;
          return jsonResponse(playerBody('UNPLAYABLE', false));
        }
        throw new Error(`fetch tak terduga: ${url}`);
      }),
    );
    await expect(
      resolver.resolve(
        { videoId: 'hhn-nGSuenM', title: 'x' },
        { delay: async () => undefined },
      ),
    ).rejects.toBeInstanceOf(ResolveError);
    expect(playerCalls).toBe(9);
  });

  it('TIDAK retry bila proxy gagal (bukan penolakan semua client)', async () => {
    const resolver = await makeResolver();
    let playerCalls = 0;
    const waits: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/innertube/player')) {
          playerCalls += 1;
          return jsonResponse(
            { error: { code: 'MOCK_FAIL' } },
            500,
          );
        }
        throw new Error(`fetch tak terduga: ${url}`);
      }),
    );
    await expect(
      resolver.resolve(
        { videoId: 'hhn-nGSuenM', title: 'x' },
        { delay: async (ms) => { waits.push(ms); } },
      ),
    ).rejects.toBeInstanceOf(ResolveError);
    expect(playerCalls).toBe(3);
    expect(waits).toEqual([]);
  });

  it('TIDAK retry bila OK tanpa format (SABR saja: format tidak akan muncul)', async () => {
    const resolver = await makeResolver();
    let playerCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/innertube/player')) {
          playerCalls += 1;
          return jsonResponse({
            playabilityStatus: { status: 'OK' },
            streamingData: {
              serverAbrStreamingUrl: 'https://example.test/sabr',
              adaptiveFormats: [
                { itag: 251, mimeType: 'audio/webm', bitrate: 160000 },
              ],
            },
          });
        }
        throw new Error(`fetch tak terduga: ${url}`);
      }),
    );
    await expect(
      resolver.resolve(
        { videoId: 'hhn-nGSuenM', title: 'x' },
        { delay: async () => undefined },
      ),
    ).rejects.toBeInstanceOf(ResolveError);
    expect(playerCalls).toBe(3);
  });

  it('maxRounds 1 mematikan retry (mode kanari)', async () => {
    const resolver = await makeResolver();
    let playerCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/innertube/player')) {
          playerCalls += 1;
          return jsonResponse(playerBody('LOGIN_REQUIRED', false));
        }
        throw new Error(`fetch tak terduga: ${url}`);
      }),
    );
    await expect(
      resolver.resolve(
        { videoId: 'hhn-nGSuenM', title: 'x' },
        { maxRounds: 1, delay: async () => undefined },
      ),
    ).rejects.toBeInstanceOf(ResolveError);
    expect(playerCalls).toBe(3);
  });

  it('K6: client utama dimatikan di config, 10 lagu tetap jalan', async () => {
    const resolver = await makeResolver(CONFIG_NO_WEB_REMIX);
    const seenClients = new Set<string>();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes('/api/innertube/player')) {
          const headers = init?.headers as Record<string, string>;
          const clientName = headers['X-YouTube-Client-Name'];
          seenClients.add(clientName);
          // MWEB (clientId 2) lolos; VR tidak pernah dicoba.
          return jsonResponse(playerBody('OK', true));
        }
        throw new Error(`fetch tak terduga: ${url}`);
      }),
    );
    const ids = [
      'hhn-nGSuenM',
      'qkC4waEZVt4',
      'k2XdBPv0D3Y',
      'NL8WUtq_NDY',
      'YsGwU8vTRsE',
      'song000006',
      'song000007',
      'song000008',
      'song000009',
      'song000010',
    ];
    for (const videoId of ids) {
      const resolved = await resolver.resolve(
        { videoId, title: `lagu ${videoId}` },
        { delay: async () => undefined },
      );
      expect(resolved.client).toBe('MWEB');
      expect(resolved.url).toBe(STREAM_URL);
    }
    // WEB_REMIX (clientId 67) tidak pernah dicoba: config yang
    // mematikannya dihormati, fallback ke MWEB jalan 10/10.
    expect(seenClients.has('67')).toBe(false);
    expect(seenClients.has('2')).toBe(true);
  });

  it('snapshot resolve terakhir mencatat playability per client', async () => {
    const resolver = await makeResolver();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/innertube/player')) {
          return jsonResponse(playerBody('LOGIN_REQUIRED', false));
        }
        throw new Error(`fetch tak terduga: ${url}`);
      }),
    );
    await expect(
      resolver.resolve(
        { videoId: 'hhn-nGSuenM', title: 'x' },
        { maxRounds: 1, delay: async () => undefined },
      ),
    ).rejects.toBeInstanceOf(ResolveError);
    expect(resolver.lastResolve?.playabilityByClient).toEqual({
      WEB_REMIX: 'LOGIN_REQUIRED',
      MWEB: 'LOGIN_REQUIRED',
      ANDROID_VR: 'LOGIN_REQUIRED',
    });
    expect(resolver.primaryClientVersion).toBe('1.20261110.04.00');
    expect(resolver.playerHash).toBe('b559f50c');
  });
});
