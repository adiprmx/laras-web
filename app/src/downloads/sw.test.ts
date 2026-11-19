/**
 * Tes konsistensi Service Worker (`public/sw.js`) dengan modul
 * unduhan. SW adalah file statis yang tidak bisa mengimpor
 * konstanta TypeScript, jadi nama cache diduplikasi di sana;
 * tes ini memaksa kedua salinan tetap sama.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { Blob as NodeBlob } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { computeSwVersion } from './swVersion';
import {
  DOWNLOADS_CACHE_NAME,
  RUNTIME_CACHE_NAME,
} from './constants';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SW_PATH = path.join(HERE, '..', '..', 'public', 'sw.js');

// Blob global jsdom di lingkungan tes ini minimal dan `new
// Response(blobJsdom)` mengubahnya menjadi string "[object
// Blob]" (penyebab sama seperti di downloadStore.test.ts —
// jalur 206 SW memakai cached.blob() + blob.slice()).
// Pakai Blob Node supaya jalur Blob -> Response -> text()
// bekerja seperti di browser.
(globalThis as { Blob: typeof Blob }).Blob =
  NodeBlob as unknown as typeof Blob;

function readSw(): string {
  return readFileSync(SW_PATH, 'utf8');
}

describe('public/sw.js', () => {
  it('memakai placeholder versi build (diganti plugin Vite)', () => {
    const sw = readSw();
    expect(sw).toContain('__LARAS_SW_VERSION__');
    expect(sw).toContain('laras-shell-${SW_VERSION}');
    // Tidak ada lagi versi manual hardcode.
    expect(sw).not.toContain('laras-shell-v2');
  });

  it('nama cache sama dengan konstanta TypeScript', () => {
    const sw = readSw();
    expect(sw).toContain(`'${DOWNLOADS_CACHE_NAME}'`);
    expect(sw).toContain(`'${RUNTIME_CACHE_NAME}'`);
  });

  it('aktivasi melindungi cache unduhan (K9)', () => {
    const sw = readSw();
    expect(sw).toContain('function isProtectedCache');
    expect(sw).toContain('function isDeletableOnActivate');
    // Predikat lindung dipakai SEBELUM penghapusan di activate.
    expect(sw).toContain('keys.filter(isDeletableOnActivate)');
    expect(sw).toContain('if (isProtectedCache(cacheName)) return false;');
  });

  it('melayani /dl/ dari cache unduhan dengan potong Range', () => {
    const sw = readSw();
    expect(sw).toContain("url.pathname.startsWith('/dl/')");
    expect(sw).toContain('function serveDownload');
    expect(sw).toContain('status: 206');
    expect(sw).toContain('Content-Range');
    expect(sw).toContain('function parseRange');
  });

  it('navigasi tetap network-first (perbaikan Red 1 R3)', () => {
    const sw = readSw();
    expect(sw).toContain("request.mode === 'navigate'");
    expect(sw).toContain('caches.match(request)');
  });

  it('serveDownload memaksa tipe aman + nosniff (R8)', () => {
    const sw = readSw();
    expect(sw).toContain('function safeDownloadContentType');
    expect(sw).toContain('X-Content-Type-Options');
    expect(sw).toContain("'nosniff'");
    // Jalur 200 tidak lagi mengembalikan respons tersimpan apa adanya.
    expect(sw).not.toContain('if (!range) return cached;');
  });
});

// ---------- Harness perilaku SW (R8): jalankan sw.js asli ----------
//
// sw.js dieksekusi di konteks VM dengan `self` + `caches` palsu,
// lalu handler `fetch` dipanggil untuk request /dl/ nyata.
// Kelas Response/Headers/Request diambil dari instance nyata
// (bukan global jsdom) supaya perilaku stream/blob sama seperti
// di browser dan konsisten dengan respons yang disimpan harness.

const RealResponse = new Response('').constructor as typeof Response;
const RealHeaders = new Response('', { headers: {} }).headers
  .constructor as typeof Headers;
const RealRequest = new Request('https://app.test/').constructor as typeof Request;

class FakeSwCache {
  private entries = new Map<string, Response>();

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    const key =
      typeof request === 'string'
        ? request
        : request instanceof URL
          ? request.toString()
          : request.url;
    const found = this.entries.get(key);
    return found ? found.clone() : undefined;
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    const key =
      typeof request === 'string'
        ? request
        : request instanceof URL
          ? request.toString()
          : request.url;
    this.entries.set(key, response.clone());
  }

  async delete(request: RequestInfo | URL): Promise<boolean> {
    const key =
      typeof request === 'string'
        ? request
        : request instanceof URL
          ? request.toString()
          : request.url;
    return this.entries.delete(key);
  }

  async keys(): Promise<Request[]> {
    return [...this.entries.keys()].map((url) => new RealRequest(url));
  }
}

type SwEventHandler = (event: {
  request: Request;
  respondWith: (promise: Promise<Response>) => void;
}) => void;

interface SwHarness {
  fetchHandler: SwEventHandler;
  seedDownload: (videoId: string, body: string, contentType: string) => void;
}

function loadSw(): SwHarness {
  const handlers = new Map<string, SwEventHandler>();
  const cachesByName = new Map<string, FakeSwCache>();
  const fakeCaches = {
    open: async (name: string): Promise<FakeSwCache> => {
      let cache = cachesByName.get(name);
      if (!cache) {
        cache = new FakeSwCache();
        cachesByName.set(name, cache);
      }
      return cache;
    },
    keys: async (): Promise<string[]> => [...cachesByName.keys()],
    delete: async (name: string): Promise<boolean> =>
      cachesByName.delete(name),
  };
  const fakeSelf = {
    location: { origin: 'https://app.test' },
    addEventListener: (type: string, handler: SwEventHandler): void => {
      handlers.set(type, handler);
    },
    skipWaiting: (): void => undefined,
    clients: { claim: (): Promise<void> => Promise.resolve() },
  };
  runInNewContext(readSw(), {
    self: fakeSelf,
    caches: fakeCaches,
    Response: RealResponse,
    Headers: RealHeaders,
    Request: RealRequest,
    URL,
    console,
  });
  const fetchHandler = handlers.get('fetch');
  if (!fetchHandler) throw new Error('sw.js tidak mendaftarkan handler fetch');
  return {
    fetchHandler,
    seedDownload: (videoId, body, contentType): void => {
      let cache = cachesByName.get(DOWNLOADS_CACHE_NAME);
      if (!cache) {
        cache = new FakeSwCache();
        cachesByName.set(DOWNLOADS_CACHE_NAME, cache);
      }
      void cache.put(
        `https://app.test/dl/${videoId}`,
        new RealResponse(body, {
          headers: {
            'Content-Type': contentType,
            'Content-Length': String(body.length),
          },
        }),
      );
    },
  };
}

async function fetchViaSw(
  harness: SwHarness,
  url: string,
  headers?: Record<string, string>,
): Promise<Response> {
  let captured: Promise<Response> | null = null;
  const request = new RealRequest(url, { headers });
  harness.fetchHandler({
    request,
    respondWith: (promise): void => {
      captured = promise;
    },
  });
  if (!captured) throw new Error('SW tidak memanggil respondWith');
  return captured;
}

describe('serveDownload (R8, perilaku SW asli)', () => {
  it('200: text/html tersimpan disajikan sebagai octet-stream + nosniff', async () => {
    const sw = loadSw();
    sw.seedDownload('vid1', '<html>jahat</html>', 'text/html');
    const res = await fetchViaSw(sw, 'https://app.test/dl/vid1');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(await res.text()).toBe('<html>jahat</html>');
  });

  it('200: audio/webm tersimpan dipertahankan + nosniff', async () => {
    const sw = loadSw();
    sw.seedDownload('vid1', 'bayt-audio', 'audio/webm; codecs=opus');
    const res = await fetchViaSw(sw, 'https://app.test/dl/vid1');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('audio/webm; codecs=opus');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(await res.text()).toBe('bayt-audio');
  });

  it('206 (Range): tipe dipaksa aman + nosniff + potongan benar', async () => {
    const sw = loadSw();
    sw.seedDownload('vid1', '0123456789', 'text/html');
    const res = await fetchViaSw(sw, 'https://app.test/dl/vid1', {
      Range: 'bytes=2-5',
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Range')).toBe('bytes 2-5/10');
    expect(await res.text()).toBe('2345');
  });

  it('404 bila tidak ada di cache (perilaku lama utuh)', async () => {
    const sw = loadSw();
    const res = await fetchViaSw(sw, 'https://app.test/dl/tidak-ada');
    expect(res.status).toBe(404);
  });
});

describe('computeSwVersion', () => {
  it('format <versi>-<8 heksadesimal>', () => {
    const version = computeSwVersion('0.9.0', 'isi sw.js');
    expect(version).toMatch(/^0\.9\.0-[0-9a-f]{8}$/);
  });

  it('deterministik untuk isi yang sama, berubah bila isi berubah', () => {
    const a = computeSwVersion('0.9.0', 'isi sw.js');
    const b = computeSwVersion('0.9.0', 'isi sw.js');
    const c = computeSwVersion('0.9.0', 'isi sw.js berubah');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('berubah bila versi package naik', () => {
    expect(computeSwVersion('0.9.0', 'x')).not.toBe(
      computeSwVersion('0.9.1', 'x'),
    );
  });
});
