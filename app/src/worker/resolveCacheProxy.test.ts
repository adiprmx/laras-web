/**
 * Tes Vitest rute /api/resolve-cache di worker proxy (P3).
 *
 * Worker (`workers/proxy/src/index.js`) diimpor langsung dengan
 * D1 palsu in-memory yang meniru pernyataan SQL yang dipakai
 * rute ini + rate limit (rate_limits). Ini menguji logika
 * validasi + kedaluwarsa + otorisasi tanpa Cloudflare; perilaku
 * D1 aslinya diverifikasi koordinator saat redeploy proxy.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../../../workers/proxy/src/index.js';

const WORKER_ORIGIN = 'https://laras-proxy-spike.hiroohengkerr.workers.dev';
const APP_ORIGIN = 'https://laras.adipmusic.my.id';
const CACHE_KEY = 'kunci-tes-cache';
const STREAM_URL =
  'https://rr1---sn-a.googlevideo.com/videoplayback?expire=1999999999&itag=251';

interface CacheRow {
  video_id: string;
  stream_url: string;
  itag: number;
  bitrate: number | null;
  client: string;
  title: string;
  expires_at: number;
  resolved_at: number;
}

/** D1 palsu: rate_limits + resolve_cache. */
class FakeD1 {
  counts = new Map<string, number>();
  cache = new Map<string, CacheRow>();

  prepare(query: string) {
    const sql = query;
    // Tangkap Map-nya langsung (bukan `this`): mutasi lewat
    // referensi Map terlihat di instance tanpa alias `this`.
    const counts = this.counts;
    const cache = this.cache;
    let values: unknown[] = [];
    const stmt = {
      bind(...v: unknown[]) {
        values = v;
        return stmt;
      },
      async run(): Promise<unknown> {
        if (sql.startsWith('INSERT INTO rate_limits')) {
          const k = `${String(values[0])}|${Number(values[1])}`;
          counts.set(k, (counts.get(k) ?? 0) + 1);
          return { success: true };
        }
        if (sql.startsWith('DELETE FROM rate_limits')) {
          const cutoff = Number(values[0]);
          for (const [k] of [...counts]) {
            if (Number(k.split('|')[1]) < cutoff) counts.delete(k);
          }
          return { success: true };
        }
        if (sql.startsWith('INSERT OR REPLACE INTO resolve_cache')) {
          const row: CacheRow = {
            video_id: String(values[0]),
            stream_url: String(values[1]),
            itag: Number(values[2]),
            bitrate:
              values[3] === null ? null : Number(values[3]),
            client: String(values[4]),
            title: String(values[5]),
            expires_at: Number(values[6]),
            resolved_at: Number(values[7]),
          };
          cache.set(row.video_id, row);
          return { success: true };
        }
        if (sql.startsWith('DELETE FROM resolve_cache')) {
          const nowS = Number(values[0]);
          for (const [k, row] of [...cache]) {
            if (row.expires_at <= nowS) cache.delete(k);
          }
          return { success: true };
        }
        throw new Error(`pernyataan tak dikenal: ${sql}`);
      },
      async first<T>(): Promise<T | null> {
        if (sql.startsWith('SELECT count')) {
          const count = counts.get(
            `${String(values[0])}|${Number(values[1])}`,
          );
          if (count === undefined) return null;
          return { count } as T;
        }
        if (sql.startsWith('SELECT video_id')) {
          const row = cache.get(String(values[0]));
          if (!row || row.expires_at <= Number(values[1])) return null;
          return row as T;
        }
        throw new Error(`pernyataan tak dikenal: ${sql}`);
      },
    };
    return stmt;
  }
}

let db: FakeD1;

function makeEnv(): { ALLOWED_ORIGINS: string; DB: FakeD1; RESOLVE_CACHE_KEY: string } {
  return {
    ALLOWED_ORIGINS: APP_ORIGIN,
    DB: db,
    RESOLVE_CACHE_KEY: CACHE_KEY,
  };
}

let callCount = 0;

function call(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  // IP unik per panggilan: tes ini menguji logika cache, bukan
  // rate limit (rate limit sendiri sudah ditutup
  // rateLimit.test.ts). Tanpa ini, loop 11 entri tidak valid
  // menabrak batas tulis 10/menit dan mengembalikan 429.
  callCount += 1;
  const ip = `203.0.113.${(callCount % 250) + 1}`;
  // Gabung header, jangan timpa: init membawa Content-Type +
  // X-Cache-Key untuk POST; pola lama `...init` menghapus
  // CF-Connecting-IP sehingga semua request terbaca satu IP
  // 'unknown' dan menabrak rate limit.
  const headers = new Headers({
    Origin: APP_ORIGIN,
    'CF-Connecting-IP': ip,
  });
  for (const [k, v] of new Headers(init.headers ?? {})) {
    headers.set(k, v);
  }
  return worker.fetch(
    new Request(`${WORKER_ORIGIN}${path}`, { ...init, headers }),
    makeEnv(),
  );
}

function nowS(): number {
  return Math.floor(Date.now() / 1000);
}

function validEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    videoId: 'hhn-nGSuenM',
    streamUrl: STREAM_URL,
    itag: 251,
    bitrate: 160000,
    client: 'ANDROID_VR',
    title: 'Semua Tentang Kita',
    expiresAt: nowS() + 3600,
    resolvedAt: nowS() - 60,
    ...overrides,
  };
}

async function postEntry(
  body: Record<string, unknown>,
  key: string | null = CACHE_KEY,
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (key !== null) headers['X-Cache-Key'] = key;
  return call('/api/resolve-cache', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  db = new FakeD1();
});

describe('GET /api/resolve-cache', () => {
  it('entri ada + belum kedaluwarsa -> 200 dengan data lengkap', async () => {
    const post = await postEntry(validEntry());
    expect(post.status).toBe(200);
    const res = await call('/api/resolve-cache?videoId=hhn-nGSuenM');
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(APP_ORIGIN);
    const body = (await res.json()) as {
      success: boolean;
      data: Record<string, unknown>;
    };
    expect(body.success).toBe(true);
    expect(body.data.videoId).toBe('hhn-nGSuenM');
    expect(body.data.streamUrl).toBe(STREAM_URL);
    expect(body.data.itag).toBe(251);
    expect(body.data.client).toBe('ANDROID_VR');
  });

  it('entri tidak ada -> 404 CACHE_MISS', async () => {
    const res = await call('/api/resolve-cache?videoId=hhn-nGSuenM');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('CACHE_MISS');
  });

  it('entri kedaluwarsa -> 404 CACHE_MISS (tidak pernah dilayani)', async () => {
    // Simpan entri yang berlaku, lalu majukan jam dengan menimpa
    // langsung lewat fake D1 (expires di masa lalu).
    db.cache.set('hhn-nGSuenM', {
      video_id: 'hhn-nGSuenM',
      stream_url: STREAM_URL,
      itag: 251,
      bitrate: 160000,
      client: 'ANDROID_VR',
      title: 'Semua Tentang Kita',
      expires_at: nowS() - 1,
      resolved_at: nowS() - 3600,
    });
    const res = await call('/api/resolve-cache?videoId=hhn-nGSuenM');
    expect(res.status).toBe(404);
  });

  it('videoId tidak valid -> 400', async () => {
    for (const id of ['', 'abc', 'hhn-nGSuenM-extra', 'hhn nGSuenM']) {
      const res = await call(
        `/api/resolve-cache?videoId=${encodeURIComponent(id)}`,
      );
      expect(res.status).toBe(400);
    }
    const missing = await call('/api/resolve-cache');
    expect(missing.status).toBe(400);
  });

  it('tanpa binding DB -> 503 CACHE_UNAVAILABLE', async () => {
    const res = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/resolve-cache?videoId=hhn-nGSuenM`, {
        headers: { Origin: APP_ORIGIN },
      }),
      { ALLOWED_ORIGINS: APP_ORIGIN },
    );
    expect(res.status).toBe(503);
  });
});

describe('POST /api/resolve-cache', () => {
  it('entri valid + kunci benar -> 200, lalu GET menemukannya', async () => {
    const res = await postEntry(validEntry());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
    const get = await call('/api/resolve-cache?videoId=hhn-nGSuenM');
    expect(get.status).toBe(200);
  });

  it('tulis kedua menimpa entri lama (INSERT OR REPLACE)', async () => {
    await postEntry(validEntry({ itag: 251 }));
    await postEntry(validEntry({ itag: 140, bitrate: 128000 }));
    const get = await call('/api/resolve-cache?videoId=hhn-nGSuenM');
    const body = (await get.json()) as {
      data: { itag: number; bitrate: number };
    };
    expect(body.data.itag).toBe(140);
    expect(body.data.bitrate).toBe(128000);
  });

  it('tanpa kunci / kunci salah -> 401, tidak ada yang tersimpan', async () => {
    const noKey = await postEntry(validEntry(), null);
    expect(noKey.status).toBe(401);
    const wrongKey = await postEntry(validEntry(), 'salah');
    expect(wrongKey.status).toBe(401);
    expect(db.cache.size).toBe(0);
  });

  it('secret belum dikonfigurasi -> 503', async () => {
    const res = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/api/resolve-cache`, {
        method: 'POST',
        headers: {
          Origin: APP_ORIGIN,
          'Content-Type': 'application/json',
          'X-Cache-Key': CACHE_KEY,
        },
        body: JSON.stringify(validEntry()),
      }),
      { ALLOWED_ORIGINS: APP_ORIGIN, DB: db },
    );
    expect(res.status).toBe(503);
  });

  it('entri tidak valid -> 400, tidak ada yang tersimpan', async () => {
    const bad = [
      validEntry({ videoId: 'pendek' }),
      validEntry({ streamUrl: 'https://evil.example.com/x' }),
      validEntry({ streamUrl: 'http://rr1---sn-a.googlevideo.com/x' }),
      validEntry({ itag: -1 }),
      validEntry({ itag: '251' }),
      validEntry({ bitrate: -5 }),
      validEntry({ client: '' }),
      validEntry({ expiresAt: nowS() - 10 }),
      validEntry({ expiresAt: nowS() + 25 * 3600 }),
      validEntry({ resolvedAt: 0 }),
      validEntry({ title: 'x'.repeat(201) }),
    ];
    for (const entry of bad) {
      const res = await postEntry(entry);
      expect(res.status).toBe(400);
    }
    expect(db.cache.size).toBe(0);
  });

  it('body bukan JSON -> 400', async () => {
    const res = await call('/api/resolve-cache', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cache-Key': CACHE_KEY,
      },
      body: 'bukan-json{',
    });
    expect(res.status).toBe(400);
  });

  it('tulis menyapu entri kedaluwarsa lain', async () => {
    db.cache.set('qkC4waEZVt4', {
      video_id: 'qkC4waEZVt4',
      stream_url: STREAM_URL,
      itag: 251,
      bitrate: null,
      client: 'ANDROID_VR',
      title: 'Rahasia Hati',
      expires_at: nowS() - 100,
      resolved_at: nowS() - 3600,
    });
    await postEntry(validEntry());
    expect(db.cache.has('qkC4waEZVt4')).toBe(false);
    expect(db.cache.has('hhn-nGSuenM')).toBe(true);
  });
});

describe('metode lain', () => {
  it('PUT -> 405', async () => {
    const res = await call('/api/resolve-cache', { method: 'PUT' });
    expect(res.status).toBe(405);
  });
});
