/**
 * Tes Vitest rute /health + log terstruktur di worker proxy (P-Health).
 *
 * Worker (`workers/proxy/src/index.js`) diimpor langsung dengan D1
 * palsu minimal (hanya SELECT 1 untuk cek /health). Ini menguji
 * kontrak respons /health + header x-request-id + format satu baris
 * JSON log request — tanpa Cloudflare.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import worker from '../../../workers/proxy/src/index.js';

const WORKER_ORIGIN = 'https://laras-proxy-spike.hiroohengkerr.workers.dev';
const APP_ORIGIN = 'https://laras.adipmusic.my.id';

/** D1 palsu minimal: hanya SELECT 1 (cek /health). */
class FakeD1 {
  prepare(query: string) {
    return {
      bind() {
        return this;
      },
      async first() {
        if (query.startsWith('SELECT 1')) return { ok: 1 };
        throw new Error(`select tak dikenal: ${query}`);
      },
      async run() {
        return { success: true };
      },
    };
  }
}

/** D1 yang selalu gagal (meniru D1 mati). */
class ThrowingD1 {
  prepare() {
    return {
      bind() {
        return this;
      },
      async first(): Promise<never> {
        throw new Error('D1 mati (simulasi)');
      },
      async run(): Promise<never> {
        throw new Error('D1 mati (simulasi)');
      },
    };
  }
}

function getHealth(
  env: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return worker.fetch(
    new Request(`${WORKER_ORIGIN}/health`, { headers }),
    env as never,
  );
}

describe('GET /health (proxy)', () => {
  // Tipe presisi (bukan ReturnType<typeof vi.spyOn>): sejak Vitest 5
  // ReturnType overload vi.spyOn kehilangan inferensi argumen
  // console.log, sehingga mock.calls tak bisa di-map tanpa anotasi.
  let logSpy: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    // Bungkam log request supaya output tes bersih; spy dipakai
    // tes format JSON di bawah.
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('DB sehat -> 200, db ok, failOpen false, x-request-id ada', async () => {
    const res = await getHealth({
      ALLOWED_ORIGINS: APP_ORIGIN,
      DB: new FakeD1(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBeTruthy();
    const body = (await res.json()) as {
      success: boolean;
      data: {
        ok: boolean;
        worker: string;
        version: string;
        db: string;
        failOpen: boolean;
        time: string;
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.ok).toBe(true);
    expect(body.data.worker).toBe('proxy');
    expect(body.data.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(body.data.db).toBe('ok');
    expect(body.data.failOpen).toBe(false);
    expect(Date.parse(body.data.time)).not.toBeNaN();
  });

  it('tanpa binding DB -> 200, db unbound, failOpen true', async () => {
    const res = await getHealth({ ALLOWED_ORIGINS: APP_ORIGIN });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { db: string; failOpen: boolean };
    };
    expect(body.data.db).toBe('unbound');
    expect(body.data.failOpen).toBe(true);
  });

  it('D1 gagal -> 200, db fail, failOpen true', async () => {
    const res = await getHealth({
      ALLOWED_ORIGINS: APP_ORIGIN,
      DB: new ThrowingD1(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { db: string; failOpen: boolean };
    };
    expect(body.data.db).toBe('fail');
    expect(body.data.failOpen).toBe(true);
  });

  it('metode bukan GET -> 405', async () => {
    const res = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/health`, { method: 'POST' }),
      { ALLOWED_ORIGINS: APP_ORIGIN, DB: new FakeD1() } as never,
    );
    expect(res.status).toBe(405);
  });

  it('CF-Ray dipakai sebagai x-request-id', async () => {
    const res = await getHealth(
      { ALLOWED_ORIGINS: APP_ORIGIN, DB: new FakeD1() },
      { 'CF-Ray': 'ray-korelasi-123' },
    );
    expect(res.headers.get('x-request-id')).toBe('ray-korelasi-123');
  });

  it('log request satu baris JSON valid dengan field korelasi', async () => {
    await getHealth({ ALLOWED_ORIGINS: APP_ORIGIN, DB: new FakeD1() }, {
      'CF-Ray': 'ray-log-456',
    });
    const lines = logSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.startsWith('{'));
    expect(lines.length).toBeGreaterThan(0);
    const parsed = lines.map((s) => JSON.parse(s)) as Array<
      Record<string, unknown>
    >;
    const req = parsed.find((p) => p.msg === 'request');
    expect(req).toBeDefined();
    expect(req!.level).toBe('info');
    expect(req!.requestId).toBe('ray-log-456');
    expect(req!.method).toBe('GET');
    expect(req!.path).toBe('/health');
    expect(req!.status).toBe(200);
    expect(typeof req!.ms).toBe('number');
  });
});
