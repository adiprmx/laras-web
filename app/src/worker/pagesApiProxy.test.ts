/**
 * Tes proxy Pages Functions same-origin (P-SameSite): /api/*
 * di domain app -> sync worker. Fetch di-stub; tidak ada
 * jaringan. Proxy ini TIDAK AKTIF di produksi sampai
 * aktivasi eksplisit (docs/same-site-sync.md).
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  FORWARDED_IP_HEADER,
  PROXY_SECRET_HEADER,
  UPSTREAM_BASE,
  onRequest,
} from '../../../workers/pages-api-proxy/functions/_lib/proxy.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function context(
  url: string,
  init: RequestInit = {},
  env: Record<string, string> = {},
) {
  return {
    request: new Request(url, init),
    env,
  };
}

describe('Pages API proxy (P-SameSite)', () => {
  it('teruskan method + path + query + header ke upstream', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ success: true, data: {} }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const res = await onRequest(
      context('https://laras.adipmusic.my.id/api/sync/pull?since=123', {
        headers: {
          Cookie: 'laras_session=tok-1',
          Origin: 'https://laras.adipmusic.my.id',
          'CF-Connecting-IP': '203.0.113.7',
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      URL,
      RequestInit & { redirect?: string },
    ];
    expect(String(url)).toBe(
      `${UPSTREAM_BASE}/api/sync/pull?since=123`,
    );
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('manual');
    const headers = init.headers as Headers;
    expect(headers.get('Cookie')).toBe('laras_session=tok-1');
    expect(headers.get('Origin')).toBe('https://laras.adipmusic.my.id');
    expect(headers.get('host')).toBeNull();
  });

  it('teruskan IP klien + secret proxy bila secret terpasang', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ success: true, data: {} }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await onRequest(
      context(
        'https://laras.adipmusic.my.id/api/auth/me',
        { headers: { 'CF-Connecting-IP': '198.51.100.9' } },
        { LARAS_PROXY_SECRET: 'rahasia-proxy' },
      ),
    );
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ];
    const headers = init.headers as Headers;
    expect(headers.get(FORWARDED_IP_HEADER)).toBe('198.51.100.9');
    expect(headers.get(PROXY_SECRET_HEADER)).toBe('rahasia-proxy');
  });

  it('tanpa secret env, header secret tidak dikirim', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ success: true, data: {} }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await onRequest(
      context('https://laras.adipmusic.my.id/api/auth/me', {
        headers: { 'CF-Connecting-IP': '198.51.100.9' },
      }),
    );
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ];
    const headers = init.headers as Headers;
    expect(headers.get(FORWARDED_IP_HEADER)).toBe('198.51.100.9');
    expect(headers.get(PROXY_SECRET_HEADER)).toBeNull();
  });

  it('teruskan Set-Cookie ganda + status + header lain', async () => {
    const upstream = new Response('ok', { status: 302 });
    upstream.headers.set('Location', 'https://example.com/x');
    upstream.headers.append('Set-Cookie', 'laras_session=abc; HttpOnly');
    upstream.headers.append('Set-Cookie', 'laras_oauth_state=def; HttpOnly');
    const fetchMock = vi.fn(async () => upstream);
    vi.stubGlobal('fetch', fetchMock);
    const res = await onRequest(
      context('https://laras.adipmusic.my.id/api/auth/callback?code=1'),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('https://example.com/x');
    expect(res.headers.getSetCookie()).toEqual([
      'laras_session=abc; HttpOnly',
      'laras_oauth_state=def; HttpOnly',
    ]);
  });

  it('POST teruskan body; GET tanpa body', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ success: true, data: {} }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await onRequest(
      context('https://laras.adipmusic.my.id/api/sync/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: 'dev-1' }),
      }),
    );
    const [, postInit] = fetchMock.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ];
    expect(postInit.method).toBe('POST');
    expect(postInit.body).toBeDefined();
    await onRequest(
      context('https://laras.adipmusic.my.id/api/auth/me'),
    );
    const [, getInit] = fetchMock.mock.calls[1] as unknown as [
      URL,
      RequestInit,
    ];
    expect(getInit.method).toBe('GET');
    expect(getInit.body).toBeUndefined();
  });

  it('upstream mati -> 502 envelope (bukan throw)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const res = await onRequest(
      context('https://laras.adipmusic.my.id/api/auth/me'),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      success: boolean;
      error: { code: string };
    };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('UPSTREAM_UNAVAILABLE');
  });
});
