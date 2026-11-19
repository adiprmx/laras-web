/**
 * Tes Vitest klien baca cache resolve (P3).
 *
 * Menutup: parse + validasi balasan worker (bentuk, allowlist
 * URL, kedaluwarsa + margin aman) dan perilaku fetch (404 dan
 * galat jaringan = null, tidak pernah melempar).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  fetchCachedStream,
  parseCachedStream,
  RESOLVE_CACHE_SAFETY_MS,
} from './resolveCache';

const NOW_MS = 1795046400000; // 19 Nov 2026 00:00:00 UTC
const NOW_S = NOW_MS / 1000;
const STREAM_URL =
  'https://rr1---sn-a.googlevideo.com/videoplayback?expire=1999999999&itag=251';

function entry(overrides: Record<string, unknown> = {}): unknown {
  return {
    success: true,
    data: {
      videoId: 'hhn-nGSuenM',
      streamUrl: STREAM_URL,
      itag: 251,
      bitrate: 160000,
      client: 'ANDROID_VR',
      title: 'Semua Tentang Kita',
      expiresAt: NOW_S + 3600,
      resolvedAt: NOW_S - 60,
      ...overrides,
    },
  };
}

describe('parseCachedStream', () => {
  it('entri valid -> CachedStream dengan waktu milidetik', () => {
    const out = parseCachedStream(entry(), NOW_MS);
    expect(out).not.toBeNull();
    expect(out?.videoId).toBe('hhn-nGSuenM');
    expect(out?.url).toBe(STREAM_URL);
    expect(out?.itag).toBe(251);
    expect(out?.bitrate).toBe(160000);
    expect(out?.client).toBe('ANDROID_VR');
    expect(out?.expiresAtMs).toBe((NOW_S + 3600) * 1000);
    expect(out?.resolvedAtMs).toBe((NOW_S - 60) * 1000);
  });

  it('bitrate null tetap valid', () => {
    expect(parseCachedStream(entry({ bitrate: null }), NOW_MS)).not.toBeNull();
  });

  it('entri kedaluwarsa -> null (jangan pernah memutar URL basi)', () => {
    expect(
      parseCachedStream(entry({ expiresAt: NOW_S - 1 }), NOW_MS),
    ).toBeNull();
  });

  it('URL tinggal di bawah margin aman -> null', () => {
    // Sisa 30 detik < margin 60 detik: dianggap basi.
    expect(
      parseCachedStream(
        entry({ expiresAt: NOW_S + 30 }),
        NOW_MS,
      ),
    ).toBeNull();
    // Sisa tepat margin + 1 detik: masih dipakai.
    expect(
      parseCachedStream(
        entry({ expiresAt: NOW_S + RESOLVE_CACHE_SAFETY_MS / 1000 + 1 }),
        NOW_MS,
      ),
    ).not.toBeNull();
  });

  it('URL di luar allowlist -> null', () => {
    expect(
      parseCachedStream(
        entry({ streamUrl: 'https://evil.example.com/videoplayback' }),
        NOW_MS,
      ),
    ).toBeNull();
    expect(
      parseCachedStream(
        entry({ streamUrl: 'http://rr1---sn-a.googlevideo.com/x' }),
        NOW_MS,
      ),
    ).toBeNull();
  });

  it('bentuk balasan salah -> null', () => {
    expect(parseCachedStream(null, NOW_MS)).toBeNull();
    expect(parseCachedStream({ success: false }, NOW_MS)).toBeNull();
    expect(parseCachedStream({ success: true }, NOW_MS)).toBeNull();
    expect(parseCachedStream(entry({ videoId: 42 }), NOW_MS)).toBeNull();
    expect(parseCachedStream(entry({ itag: '251' }), NOW_MS)).toBeNull();
    expect(parseCachedStream(entry({ client: '' }), NOW_MS)).toBeNull();
    expect(parseCachedStream(entry({ expiresAt: 'nanti' }), NOW_MS)).toBeNull();
    expect(parseCachedStream(entry({ bitrate: 'kencang' }), NOW_MS)).toBeNull();
  });
});

describe('fetchCachedStream', () => {
  it('200 + entri valid -> CachedStream; URL dipanggil dengan videoId', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify(entry()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const out = await fetchCachedStream('hhn-nGSuenM', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      nowMs: NOW_MS,
      baseUrl: 'https://proxy.example.test',
    });
    expect(out?.videoId).toBe('hhn-nGSuenM');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(
      'https://proxy.example.test/api/resolve-cache?videoId=hhn-nGSuenM',
    );
  });

  it('404 (cache miss) -> null, tanpa melempar', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 404 }));
    const out = await fetchCachedStream('hhn-nGSuenM', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      nowMs: NOW_MS,
    });
    expect(out).toBeNull();
  });

  it('500 / JSON rusak / galat jaringan -> null, tanpa melempar', async () => {
    const cases: Array<() => Promise<Response>> = [
      async () => new Response('{}', { status: 500 }),
      async () => new Response('bukan-json', { status: 200 }),
      async () => {
        throw new Error('jaringan putus');
      },
    ];
    for (const impl of cases) {
      const out = await fetchCachedStream('hhn-nGSuenM', {
        fetchImpl: impl as unknown as typeof fetch,
        nowMs: NOW_MS,
      });
      expect(out).toBeNull();
    }
  });

  it('200 dengan entri kedaluwarsa -> null (lapis kedua sesudah SQL)', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(entry({ expiresAt: NOW_S - 10 })), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const out = await fetchCachedStream('hhn-nGSuenM', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      nowMs: NOW_MS,
    });
    expect(out).toBeNull();
  });
});
