/**
 * Tes klien lirik LRCLIB (P7). Fetch di-mock penuh; tidak ada
 * jaringan nyata. Spike S10 sudah membuktikan layanan aslinya.
 */
import { describe, expect, it } from 'vitest';
import {
  fetchLyricsFromNetwork,
  pickSearchResult,
  type LyricsFetchDeps,
} from './lrclib';

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function mockFetch(
  handler: (url: string) => Response | Promise<Response>,
): LyricsFetchDeps['fetchFn'] {
  return (async (input: RequestInfo | URL) =>
    handler(String(input))) as LyricsFetchDeps['fetchFn'];
}

const QUERY = { artist: 'Peterpan', title: 'Semua Tentang Kita', durationSeconds: 268 };

describe('pickSearchResult', () => {
  it('memilih durasi cocok plus minus 2 detik', () => {
    const best = pickSearchResult(
      [
        { duration: 300, plainLyrics: 'salah' },
        { duration: 269, syncedLyrics: '[00:01.00]benar', plainLyrics: 'benar' },
      ],
      268,
    );
    expect(best?.plainLyrics).toBe('benar');
  });

  it('tanpa durasi cocok, memilih yang tersinkron dulu', () => {
    const best = pickSearchResult([
      { duration: 100, plainLyrics: 'polos' },
      { duration: 200, syncedLyrics: '[00:01.00]x', plainLyrics: 'sinkron' },
    ]);
    expect(best?.plainLyrics).toBe('sinkron');
  });

  it('tanpa lirik sama sekali mengembalikan null', () => {
    expect(pickSearchResult([{ duration: 100 }, {}])).toBeNull();
    expect(pickSearchResult([])).toBeNull();
  });
});

describe('fetchLyricsFromNetwork', () => {
  it('/api/get 200 dengan lirik tersinkron', async () => {
    const seen: string[] = [];
    const result = await fetchLyricsFromNetwork(QUERY, {
      fetchFn: mockFetch((url) => {
        seen.push(url);
        return jsonResponse({
          syncedLyrics: '[00:01.00]Halo',
          plainLyrics: 'Halo',
          duration: 268,
        });
      }),
    });
    expect(result).toEqual({
      status: 'ok',
      syncedLyrics: '[00:01.00]Halo',
      plainLyrics: 'Halo',
      source: 'lrclib',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('/api/get?');
    expect(seen[0]).toContain('duration=268');
  });

  it('/api/get 404 lalu /api/search menemukan lirik', async () => {
    const seen: string[] = [];
    const result = await fetchLyricsFromNetwork(QUERY, {
      fetchFn: mockFetch((url) => {
        seen.push(url);
        if (url.includes('/api/get')) return jsonResponse({}, 404);
        return jsonResponse([
          { duration: 269, syncedLyrics: '[00:02.00]Ketemu', plainLyrics: 'Ketemu' },
        ]);
      }),
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.plainLyrics).toBe('Ketemu');
      expect(result.source).toBe('lrclib');
    }
    expect(seen.some((u) => u.includes('/api/search?'))).toBe(true);
  });

  it('LRCLIB kosong lalu lyrics.ovh memberi lirik polos', async () => {
    const result = await fetchLyricsFromNetwork(QUERY, {
      fetchFn: mockFetch((url) => {
        if (url.includes('/api/get')) return jsonResponse({}, 404);
        if (url.includes('/api/search')) return jsonResponse([]);
        return jsonResponse({ lyrics: 'Lirik polos dari ovh' });
      }),
    });
    expect(result).toEqual({
      status: 'ok',
      syncedLyrics: null,
      plainLyrics: 'Lirik polos dari ovh',
      source: 'ovh',
    });
  });

  it('ketiga jalur kosong berarti tidak ditemukan', async () => {
    const result = await fetchLyricsFromNetwork(QUERY, {
      fetchFn: mockFetch((url) => {
        if (url.includes('/api/get')) return jsonResponse({}, 404);
        if (url.includes('/api/search')) return jsonResponse([]);
        return jsonResponse({ error: 'No lyrics found' }, 404);
      }),
    });
    expect(result).toEqual({ status: 'not-found' });
  });

  it('lagu instrumental berarti tidak ditemukan', async () => {
    const result = await fetchLyricsFromNetwork(QUERY, {
      fetchFn: mockFetch(() =>
        jsonResponse({ instrumental: true, plainLyrics: '', duration: 268 }),
      ),
    });
    expect(result).toEqual({ status: 'not-found' });
  });

  it('429 dihormati lewat Retry-After lalu coba ulang sekali', async () => {
    let calls = 0;
    const slept: number[] = [];
    const result = await fetchLyricsFromNetwork(QUERY, {
      fetchFn: mockFetch(() => {
        calls += 1;
        if (calls === 1) {
          return jsonResponse({}, 429, { 'Retry-After': '2' });
        }
        return jsonResponse({ plainLyrics: 'Sesudah tunggu', duration: 268 });
      }),
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
      random: () => 0,
    });
    expect(result.status).toBe('ok');
    expect(calls).toBe(2);
    expect(slept).toEqual([2000]);
  });

  it('429 dua kali berarti rate-limited dengan angka Retry-After', async () => {
    const result = await fetchLyricsFromNetwork(QUERY, {
      fetchFn: mockFetch(() =>
        jsonResponse({}, 429, { 'Retry-After': '5' }),
      ),
      sleep: () => Promise.resolve(),
      random: () => 0,
    });
    expect(result).toEqual({
      status: 'rate-limited',
      retryAfterSeconds: 5,
    });
  });

  it('Retry-After di atas 60 detik dibatasi 60', async () => {
    const slept: number[] = [];
    await fetchLyricsFromNetwork(QUERY, {
      fetchFn: mockFetch(() =>
        jsonResponse({}, 429, { 'Retry-After': '3600' }),
      ),
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
      random: () => 0,
    });
    expect(slept[0]).toBe(60000);
  });

  it('galat jaringan berarti error', async () => {
    const result = await fetchLyricsFromNetwork(QUERY, {
      fetchFn: mockFetch(() => {
        throw new TypeError('Failed to fetch');
      }),
    });
    expect(result).toEqual({ status: 'error' });
  });

  it('jitter sampai 30 persen ditambahkan ke waktu tunggu', async () => {
    const slept: number[] = [];
    await fetchLyricsFromNetwork(QUERY, {
      fetchFn: mockFetch(() =>
        jsonResponse({}, 429, { 'Retry-After': '10' }),
      ),
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
      random: () => 1,
    });
    expect(slept[0]).toBe(13000);
  });

  it('mengirim header pengenal client LRCLIB', async () => {
    let headers: Record<string, string> | null = null;
    const fetchFn = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      headers = (init?.headers ?? {}) as Record<string, string>;
      return jsonResponse({ plainLyrics: 'x' });
    }) as LyricsFetchDeps['fetchFn'];
    await fetchLyricsFromNetwork(QUERY, { fetchFn });
    expect(headers).toMatchObject({
      'X-User-Agent': expect.stringContaining('LarasWeb/1.0'),
      'Lrclib-Client': expect.stringContaining('LarasWeb/1.0'),
    });
  });

  it('hanya lirik tersinkron tetap menghasilkan teks polos turunan', async () => {
    const result = await fetchLyricsFromNetwork(QUERY, {
      fetchFn: mockFetch(() =>
        jsonResponse({
          syncedLyrics: '[00:01.00]Baris satu\n[00:05.00]Baris dua',
          plainLyrics: '',
        }),
      ),
    });
    expect(result).toEqual({
      status: 'ok',
      syncedLyrics: '[00:01.00]Baris satu\n[00:05.00]Baris dua',
      plainLyrics: 'Baris satu\nBaris dua',
      source: 'lrclib',
    });
  });
});

describe('fetchLyricsFromNetwork (Blue 3, I13)', () => {
  it('/api/get mengembalikan JSON null -> not-found, bukan TypeError', async () => {
    const result = await fetchLyricsFromNetwork(QUERY, {
      fetchFn: mockFetch(() => jsonResponse(null)),
    });
    expect(result).toEqual({ status: 'not-found' });
  });
});
