/**
 * Tes DownloadStore dengan Cache Storage palsu in-memory
 * (jsdom tidak menyediakan `caches`).
 */
import { Blob as NodeBlob } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  DownloadStore,
  safeDownloadContentType,
  type CacheLike,
  type CacheStorageLike,
} from './downloadStore';
import { DOWNLOADS_CACHE_NAME } from './constants';

// Blob global jsdom di lingkungan tes ini minimal (tanpa
// arrayBuffer/text/stream) dan `new Response(blobJsdom)`
// mengubahnya menjadi string "[object Blob]". Pakai Blob Node
// (kelas yang sama dengan Response undici) supaya jalur
// Blob -> Response -> blob() bekerja seperti di browser.
(globalThis as { Blob: typeof Blob }).Blob =
  NodeBlob as unknown as typeof Blob;

class FakeCache implements CacheLike {
  private entries = new Map<string, Response>();

  private key(request: RequestInfo | URL): string {
    if (typeof request === 'string') return request;
    if (request instanceof URL) return request.toString();
    return request.url;
  }

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    const found = this.entries.get(this.key(request));
    return found ? found.clone() : undefined;
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    this.entries.set(this.key(request), response.clone());
  }

  async delete(request: RequestInfo | URL): Promise<boolean> {
    return this.entries.delete(this.key(request));
  }

  async keys(): Promise<Request[]> {
    return [...this.entries.keys()].map((url) => new Request(url));
  }
}

class FakeCaches implements CacheStorageLike {
  readonly caches = new Map<string, FakeCache>();

  async open(cacheName: string): Promise<CacheLike> {
    let cache = this.caches.get(cacheName);
    if (!cache) {
      cache = new FakeCache();
      this.caches.set(cacheName, cache);
    }
    return cache;
  }

  async delete(cacheName: string): Promise<boolean> {
    return this.caches.delete(cacheName);
  }
}

function makeStore(): { store: DownloadStore; caches: FakeCaches } {
  const caches = new FakeCaches();
  const store = new DownloadStore({
    caches,
    origin: 'https://app.test',
  });
  return { store, caches };
}

/** Baca byte Blob (Blob Node punya arrayBuffer asli). */
async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

describe('DownloadStore unduhan', () => {
  it('put + has + get + delete satu file', async () => {
    const { store } = makeStore();
    expect(await store.hasDownload('vid1')).toBe(false);
    await store.putDownload(
      'vid1',
      new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }),
      'audio/webm',
    );
    expect(await store.hasDownload('vid1')).toBe(true);
    const blob = await store.getDownload('vid1');
    expect(blob).not.toBeNull();
    expect(await blobBytes(blob!)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await store.deleteDownload('vid1')).toBe(true);
    expect(await store.hasDownload('vid1')).toBe(false);
    expect(await store.getDownload('vid1')).toBeNull();
  });

  it('listDownloads mengembalikan videoId urut', async () => {
    const { store } = makeStore();
    await store.putDownload('b', new Blob(['x']), 'audio/webm');
    await store.putDownload('a', new Blob(['y']), 'audio/webm');
    await store.putPart('a', 0, new Uint8Array([1]));
    // Part tidak ikut terdaftar sebagai unduhan.
    expect(await store.listDownloads()).toEqual(['a', 'b']);
  });

  it('deleteAllDownloads menghapus file, bukan part', async () => {
    const { store } = makeStore();
    await store.putDownload('a', new Blob(['x']), 'audio/webm');
    await store.putDownload('b', new Blob(['y']), 'audio/webm');
    await store.putPart('c', 0, new Uint8Array([1]));
    expect(await store.deleteAllDownloads()).toBe(2);
    expect(await store.listDownloads()).toEqual([]);
    expect(await store.getPart('c', 0)).not.toBeNull();
  });
});

describe('DownloadStore part', () => {
  it('put + get + list + delete part', async () => {
    const { store } = makeStore();
    await store.putPart('vid1', 0, new Uint8Array([1, 2]));
    await store.putPart('vid1', 2, new Uint8Array([5]));
    await store.putPart('vid1', 1, new Uint8Array([3, 4]));
    expect(await store.listPartIndexes('vid1')).toEqual([0, 1, 2]);
    expect(await store.getPart('vid1', 1)).toEqual(new Uint8Array([3, 4]));
    expect(await store.getPart('vid1', 9)).toBeNull();
    expect(await store.deleteParts('vid1')).toBe(3);
    expect(await store.listPartIndexes('vid1')).toEqual([]);
  });

  it('listAllParts mengelompokkan per lagu', async () => {
    const { store } = makeStore();
    await store.putPart('a', 1, new Uint8Array([1]));
    await store.putPart('a', 0, new Uint8Array([1]));
    await store.putPart('b', 0, new Uint8Array([1]));
    const parts = await store.listAllParts();
    expect(parts.get('a')).toEqual([0, 1]);
    expect(parts.get('b')).toEqual([0]);
  });
});

describe('evictRuntimeCache (K9)', () => {
  it('menghapus runtime LRU sampai di bawah batas, unduhan utuh', async () => {
    const { store } = makeStore();
    // Unduhan: 2 file.
    await store.putDownload('dl1', new Blob(['aaaa']), 'audio/webm');
    await store.putDownload('dl2', new Blob(['bbbb']), 'audio/webm');
    // Runtime: 3 entri x 1000 byte, akses tertua dulu.
    for (const key of ['rt1_251', 'rt2_251', 'rt3_251']) {
      await store.putRuntimeEntry(key, new Uint8Array(1000));
    }
    const manifest = [
      { key: 'rt1_251', sizeBytes: 1000, lastAccessed: 100 },
      { key: 'rt2_251', sizeBytes: 1000, lastAccessed: 200 },
      { key: 'rt3_251', sizeBytes: 1000, lastAccessed: 300 },
    ];
    const removed = await store.evictRuntimeCache(manifest, 1500);
    // Total 3000 -> hapus tertua (rt1) = 2000, masih > 1500 ->
    // hapus rt2 = 1000 <= 1500, berhenti. rt3 bertahan.
    expect(removed).toEqual(['rt1_251', 'rt2_251']);
    expect(await store.hasRuntimeEntry('rt1_251')).toBe(false);
    expect(await store.hasRuntimeEntry('rt2_251')).toBe(false);
    expect(await store.hasRuntimeEntry('rt3_251')).toBe(true);
    // Unduhan tidak tersentuh eviction.
    expect(await store.hasDownload('dl1')).toBe(true);
    expect(await store.hasDownload('dl2')).toBe(true);
    expect(await store.listDownloads()).toEqual(['dl1', 'dl2']);
  });

  it('tidak menghapus apa pun bila total sudah di bawah batas', async () => {
    const { store } = makeStore();
    await store.putRuntimeEntry('rt1_251', new Uint8Array(100));
    const removed = await store.evictRuntimeCache(
      [{ key: 'rt1_251', sizeBytes: 100, lastAccessed: 1 }],
      1000,
    );
    expect(removed).toEqual([]);
    expect(await store.hasRuntimeEntry('rt1_251')).toBe(true);
  });

  it('batas 0 menghapus seluruh runtime, unduhan tetap utuh', async () => {
    const { store } = makeStore();
    await store.putDownload('dl1', new Blob(['aaaa']), 'audio/webm');
    await store.putRuntimeEntry('rt1_251', new Uint8Array(100));
    const removed = await store.evictRuntimeCache(
      [{ key: 'rt1_251', sizeBytes: 100, lastAccessed: 1 }],
      0,
    );
    expect(removed).toEqual(['rt1_251']);
    expect(await store.hasDownload('dl1')).toBe(true);
  });
});

describe('safeDownloadContentType (R8)', () => {
  it('audio/*, video/*, octet-stream dipertahankan (termasuk parameter)', () => {
    expect(safeDownloadContentType('audio/webm')).toBe('audio/webm');
    expect(safeDownloadContentType('audio/webm; codecs=opus')).toBe(
      'audio/webm; codecs=opus',
    );
    expect(safeDownloadContentType('video/mp4')).toBe('video/mp4');
    expect(safeDownloadContentType('application/octet-stream')).toBe(
      'application/octet-stream',
    );
    // Perbandingan tidak peka huruf besar/kecil, nilai asli dipertahankan.
    expect(safeDownloadContentType('AUDIO/OPUS')).toBe('AUDIO/OPUS');
  });

  it('tipe lain diganti application/octet-stream', () => {
    expect(safeDownloadContentType('text/html')).toBe(
      'application/octet-stream',
    );
    expect(safeDownloadContentType('text/html; charset=utf-8')).toBe(
      'application/octet-stream',
    );
    expect(safeDownloadContentType('application/json')).toBe(
      'application/octet-stream',
    );
    expect(safeDownloadContentType('')).toBe('application/octet-stream');
  });
});

describe('putDownload menyaring Content-Type (R8)', () => {
  it('text/html dari upstream tidak pernah masuk cache', async () => {
    const { store, caches } = makeStore();
    await store.putDownload('vid1', new Blob(['<html>']), 'text/html');
    const cache = await caches.open(DOWNLOADS_CACHE_NAME);
    const stored = await cache.match('https://app.test/dl/vid1');
    expect(stored?.headers.get('Content-Type')).toBe(
      'application/octet-stream',
    );
  });

  it('audio/webm tetap tersimpan apa adanya', async () => {
    const { store, caches } = makeStore();
    await store.putDownload(
      'vid1',
      new Blob(['data']),
      'audio/webm; codecs=opus',
    );
    const cache = await caches.open(DOWNLOADS_CACHE_NAME);
    const stored = await cache.match('https://app.test/dl/vid1');
    expect(stored?.headers.get('Content-Type')).toBe(
      'audio/webm; codecs=opus',
    );
  });
});
