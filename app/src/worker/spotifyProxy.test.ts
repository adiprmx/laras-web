/**
 * Tes Vitest rute /api/spotify-page di worker proxy (P8).
 *
 * Worker (`workers/proxy/src/index.js`) diimpor langsung; fetch
 * global di-stub supaya tidak ada jaringan sungguhan. Env tanpa
 * binding DB (rate limit fail-open — perilaku rate limit sendiri
 * sudah ditutup rateLimit.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../../workers/proxy/src/index.js';
import FIXTURE_HTML from '../backup/test-fixtures/spotify_playlist.html?raw';

const WORKER_ORIGIN = 'https://laras-proxy-spike.hiroohengkerr.workers.dev';
const APP_ORIGIN = 'https://laras.adipmusic.my.id';
const VALID_ID = '37i9dQZF1DXcBWIGoYBM5M';

function makeEnv(): { ALLOWED_ORIGINS: string } {
  return { ALLOWED_ORIGINS: APP_ORIGIN };
}

function call(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return worker.fetch(
    new Request(`${WORKER_ORIGIN}${path}`, {
      headers: { Origin: APP_ORIGIN, 'CF-Connecting-IP': '203.0.113.7' },
      ...init,
    }),
    makeEnv(),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/api/spotify-page', () => {
  it('id valid -> 200, HTML diteruskan + nosniff + CORS', async () => {
    const seen: Array<{ url: string; ua: string | null }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        seen.push({
          url: String(input),
          ua: headers.get('User-Agent'),
        });
        return new Response(FIXTURE_HTML, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }),
    );
    const res = await call(`/api/spotify-page?id=${VALID_ID}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(APP_ORIGIN);
    expect(await res.text()).toBe(FIXTURE_HTML);
    expect(seen.length).toBe(1);
    expect(seen[0]?.url).toBe(
      `https://open.spotify.com/playlist/${VALID_ID}`,
    );
    expect(seen[0]?.ua).toContain('Android 13; Pixel 7');
  });

  it('id tidak valid -> 400 tanpa fetch upstream', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    for (const id of ['', 'abc123', '37i9dQZF1DXcBWIGoYBM5M-extra', 'x'.repeat(23)]) {
      const res = await call(`/api/spotify-page?id=${encodeURIComponent(id)}`);
      expect(res.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    const missing = await call('/api/spotify-page');
    expect(missing.status).toBe(400);
  });

  it('metode bukan GET -> 405', async () => {
    const res = await call(`/api/spotify-page?id=${VALID_ID}`, { method: 'POST' });
    expect(res.status).toBe(405);
  });

  it('redirect dalam open.spotify.com/playlist diikuti (maks 2 hop)', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        seen.push(url);
        if (seen.length === 1) {
          return new Response(null, {
            status: 302,
            headers: { Location: `/playlist/${VALID_ID}?locale=id` },
          });
        }
        return new Response(FIXTURE_HTML, { status: 200 });
      }),
    );
    const res = await call(`/api/spotify-page?id=${VALID_ID}`);
    expect(res.status).toBe(200);
    expect(seen.length).toBe(2);
    expect(await res.text()).toBe(FIXTURE_HTML);
  });

  it('redirect ke host lain -> 502 (tidak pernah diikuti)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(null, {
          status: 302,
          headers: { Location: 'https://accounts.spotify.com/login' },
        }),
      ),
    );
    const res = await call(`/api/spotify-page?id=${VALID_ID}`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('REDIRECT_NOT_ALLOWED');
  });

  it('redirect ke path bukan playlist -> 502', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(null, {
          status: 302,
          headers: { Location: 'https://open.spotify.com/track/abc' },
        }),
      ),
    );
    const res = await call(`/api/spotify-page?id=${VALID_ID}`);
    expect(res.status).toBe(502);
  });

  it('redirect berantai > 2 hop -> 502', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(null, {
          status: 302,
          headers: { Location: `https://open.spotify.com/playlist/${VALID_ID}` },
        }),
      ),
    );
    const res = await call(`/api/spotify-page?id=${VALID_ID}`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('TOO_MANY_REDIRECTS');
  });

  it('upstream bukan 200 -> 502', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 })),
    );
    const res = await call(`/api/spotify-page?id=${VALID_ID}`);
    expect(res.status).toBe(502);
  });

  it('Content-Length di atas cap -> 502 tanpa membaca body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x', {
        status: 200,
        headers: { 'Content-Length': String(3 * 1024 * 1024) },
      })),
    );
    const res = await call(`/api/spotify-page?id=${VALID_ID}`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UPSTREAM_TOO_BIG');
  });

  it('body melebihi cap saat dibaca -> 502', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024 + 1);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(big, { status: 200 })),
    );
    const res = await call(`/api/spotify-page?id=${VALID_ID}`);
    expect(res.status).toBe(502);
  });

  it('origin di luar allowlist tidak dapat header CORS', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(FIXTURE_HTML, { status: 200 })),
    );
    const res = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/spotify-page?id=${VALID_ID}`, {
        headers: { Origin: 'https://evil.example.com' },
      }),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
