/**
 * Tes klien HTTP sinkronisasi (P7): envelope sukses/galat,
 * credentials include, timeout, pemetaan status ke SyncApiError.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  fetchAuthMe,
  fetchLogout,
  fetchPull,
  fetchPush,
  SyncApiError,
} from './syncClient';
import { SYNC_API_BASE_URL } from './config';

function jsonResponse(
  body: unknown,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('syncClient', () => {
  it('fetchAuthMe mengembalikan data + memakai credentials include', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        success: true,
        data: { displayName: 'Adip', provider: 'google' },
      }),
    );
    const me = await fetchAuthMe(fetchMock as unknown as typeof fetch);
    expect(me).toEqual({ displayName: 'Adip', provider: 'google' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`${SYNC_API_BASE_URL}/api/auth/me`);
    expect(init.credentials).toBe('include');
    expect(init.method).toBe('GET');
  });

  it('401 dipetakan ke SyncApiError dengan status + kode', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        { success: false, error: { code: 'UNAUTHORIZED', message: 'Belum masuk' } },
        401,
      ),
    );
    await expect(
      fetchAuthMe(fetchMock as unknown as typeof fetch),
    ).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHORIZED',
    } as Partial<SyncApiError>);
  });

  it('429 dipetakan dengan status 429', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        { success: false, error: { code: 'RATE_LIMITED', message: 'Terlalu banyak' } },
        429,
      ),
    );
    await expect(
      fetchPull(0, fetchMock as unknown as typeof fetch),
    ).rejects.toMatchObject({ status: 429, code: 'RATE_LIMITED' });
  });

  it('jaringan putus dipetakan ke status 0 + kode NETWORK', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(
      fetchLogout(fetchMock as unknown as typeof fetch),
    ).rejects.toMatchObject({ status: 0, code: 'NETWORK' });
  });

  it('fetchPush mengirim JSON + since di URL pull', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ success: true, data: { serverTime: 1, applied: 2 } }),
    );
    await fetchPush(
      { deviceId: 'dev-1', likes: [] },
      fetchMock as unknown as typeof fetch,
    );
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`${SYNC_API_BASE_URL}/api/sync/push`);
    expect(init.method).toBe('POST');
    expect(
      (init.headers as Record<string, string>)['Content-Type'],
    ).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      deviceId: 'dev-1',
      likes: [],
    });

    const pullMock = vi.fn(async () =>
      jsonResponse({
        success: true,
        data: {
          serverTime: 1,
          playlists: [],
          playlistItems: [],
          likes: [],
          history: [],
          settings: null,
        },
      }),
    );
    await fetchPull(12345, pullMock as unknown as typeof fetch);
    expect(
      (pullMock.mock.calls[0] as unknown as [string])[0],
    ).toBe(`${SYNC_API_BASE_URL}/api/sync/pull?since=12345`);
  });

  it('respons sukses tanpa data ditolak sebagai BAD_RESPONSE', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ success: true }),
    );
    await expect(
      fetchAuthMe(fetchMock as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });
});
