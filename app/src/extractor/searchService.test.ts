/**
 * Tes layanan pencarian/browse: request yang dikirim ke proxy,
 * klasifikasi galat, dan tangkapan visitorData. `fetch` global
 * di-mock; tidak ada jaringan nyata.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROXY_BASE_URL } from '../spike/config';
import searchPeterpanJson from './test-fixtures/search-peterpan.json';
import browseHomeJson from './test-fixtures/browse-home.json';
import suggestNoahJson from './test-fixtures/suggest-noah.json';
import {
  SearchError,
  SearchService,
  resetSearchService,
} from './searchService';

function jsonResponse(
  body: unknown,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('SearchService', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    resetSearchService();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('search mengirim satu POST ke proxy dengan body WEB_REMIX', async () => {
    fetchMock.mockResolvedValue(jsonResponse(searchPeterpanJson));
    const service = new SearchService();
    const results = await service.search('peterpan semua tentang kita');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${PROXY_BASE_URL}/api/innertube/search`);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-YouTube-Client-Name']).toBe('67');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.query).toBe('peterpan semua tentang kita');
    expect(
      (body.context as { client: { clientName: string } }).client.clientName,
    ).toBe('WEB_REMIX');
    expect(results.songs.length).toBe(7);
    expect(results.artists.length).toBe(1);
  });

  it('search dengan params filter mengirim params apa adanya', async () => {
    fetchMock.mockResolvedValue(jsonResponse(searchPeterpanJson));
    const service = new SearchService();
    await service.search('noah', { params: 'EgWKAQIIAWoSEAQQAxAF' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.params).toBe('EgWKAQIIAWoSEAQQAxAF');
  });

  it('browse mengirim browseId + params ke endpoint browse', async () => {
    fetchMock.mockResolvedValue(jsonResponse(browseHomeJson));
    const service = new SearchService();
    const page = await service.browse('FEmusic_home');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${PROXY_BASE_URL}/api/innertube/browse`);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.browseId).toBe('FEmusic_home');
    expect(page.shelves.length).toBe(2);
  });

  it('browseHome memakai browseId FEmusic_home', async () => {
    fetchMock.mockResolvedValue(jsonResponse(browseHomeJson));
    const service = new SearchService();
    await service.browseHome();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.browseId).toBe('FEmusic_home');
  });

  it('suggestions mengirim input dan membatasi 8 saran', async () => {
    fetchMock.mockResolvedValue(jsonResponse(suggestNoahJson));
    const service = new SearchService();
    const out = await service.suggestions('noah');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${PROXY_BASE_URL}/api/innertube/suggestions`);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.input).toBe('noah');
    expect(out).toEqual([
      'noah kahan',
      'noah graves',
      'noah kahan the great divide',
      'noah cyrus',
      'noah nine',
      'noah thorne',
    ]);
    expect(out.length).toBeLessThanOrEqual(8);
  });

  it('visitorData dari respons dipakai di request berikut', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        ...searchPeterpanJson,
        responseContext: { visitorData: 'VISITOR-ABC' },
      }),
    );
    const service = new SearchService();
    await service.search('noah');
    fetchMock.mockResolvedValue(jsonResponse(browseHomeJson));
    await service.browseHome();
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    const client = (body.context as { client: Record<string, unknown> })
      .client;
    expect(client.visitorData).toBe('VISITOR-ABC');
  });

  it('respons search tanpa contents -> galat parse, bukan hasil kosong', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ foo: 1 }));
    const service = new SearchService();
    const error = await service
      .search('noah')
      .then(
        () => null,
        (e: unknown) => e as SearchError,
      );
    expect(error).toBeInstanceOf(SearchError);
    expect(error?.kind).toBe('parse');
  });

  it('respons browse tanpa contents -> galat parse', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ foo: 1 }));
    const service = new SearchService();
    const error = await service
      .browse('FEmusic_home')
      .then(
        () => null,
        (e: unknown) => e as SearchError,
      );
    expect(error?.kind).toBe('parse');
  });

  it('HTTP 500 -> galat http dengan pesan pengguna', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'UPSTREAM_ERROR' } }, 500),
    );
    const service = new SearchService();
    const error = await service
      .search('noah')
      .then(
        () => null,
        (e: unknown) => e as SearchError,
      );
    expect(error?.kind).toBe('http');
    expect(error?.causeText).toContain('Coba lagi nanti');
  });

  it('HTTP 429 -> galat rate-limited', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'RATE_LIMITED' } }, 429),
    );
    const service = new SearchService();
    const error = await service
      .search('noah')
      .then(
        () => null,
        (e: unknown) => e as SearchError,
      );
    expect(error?.kind).toBe('rate-limited');
    expect(error?.causeText).toContain('Terlalu banyak permintaan');
  });

  it('balasan bukan JSON -> galat parse', async () => {
    fetchMock.mockResolvedValue(
      new Response('bukan json', { status: 200 }),
    );
    const service = new SearchService();
    const error = await service
      .search('noah')
      .then(
        () => null,
        (e: unknown) => e as SearchError,
      );
    expect(error?.kind).toBe('parse');
  });

  it('fetch melempar (jaringan putus) -> galat network', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const service = new SearchService();
    const error = await service
      .search('noah')
      .then(
        () => null,
        (e: unknown) => e as SearchError,
      );
    expect(error?.kind).toBe('network');
    expect(error?.causeText).toContain('koneksi internet');
  });

  it('timeout (AbortError) -> galat network', async () => {
    const abort = new Error('The operation timed out');
    abort.name = 'TimeoutError';
    fetchMock.mockRejectedValue(abort);
    const service = new SearchService();
    const error = await service
      .search('noah')
      .then(
        () => null,
        (e: unknown) => e as SearchError,
      );
    expect(error?.kind).toBe('network');
  });

  it('kolektor toleran dipakai bila parser terstruktur tidak menemukan lagu', async () => {
    // Respons valid (punya contents) tapi bentuknya tidak dikenal
    // parser terstruktur — videoId tetap ditemukan kolektor.
    fetchMock.mockResolvedValue(
      jsonResponse({
        contents: {
          aneh: {
            daftar: [
              {
                videoId: 'hhn-nGSuenM',
                title: { simpleText: 'Semua Tentang Kita' },
              },
            ],
          },
        },
      }),
    );
    const service = new SearchService();
    const results = await service.search('noah');
    expect(results.songs.length).toBe(1);
    expect(results.songs[0]?.videoId).toBe('hhn-nGSuenM');
    expect(results.songs[0]?.title).toBe('Semua Tentang Kita');
  });
});
