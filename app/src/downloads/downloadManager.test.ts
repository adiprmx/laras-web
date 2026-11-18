/**
 * Tes manajer unduhan dengan resolver/fetch/storage palsu
 * (tanpa jaringan) + IndexedDB palsu. Tes end-to-end manajer
 * memakai fixture 2.500 byte dan chunk 1.000 byte.
 */
import 'fake-indexeddb/auto';
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LarasDatabase } from '../data/database';
import { LibraryService } from '../data/library';
import { DownloadJobStatus, DownloadState } from '../data/types';
import { PROXY_BASE_URL } from '../spike/config';
import type { ResolvedTrack } from '../extractor/resolve';
import { DownloadStore, type CacheLike, type CacheStorageLike } from './downloadStore';
import {
  downloadErrorMessage,
  DownloadManager,
  fetchRangeViaProxy,
  getDownloadStorageStats,
  parseContentRangeTotal,
  parseRetryAfterSeconds,
  readBodyWithWatchdog,
  reconcileDownloads,
  type DownloadResolver,
} from './downloadManager';
import { RetryableError, TooBigError, UrlExpiredError } from './chunkedDownloader';

// Blob global jsdom di lingkungan tes ini minimal (tanpa
// arrayBuffer/text/stream) dan `new Response(blobJsdom)`
// mengubahnya menjadi string "[object Blob]". Pakai Blob Node
// (kelas yang sama dengan Response undici) supaya jalur
// Blob -> Response -> blob() bekerja seperti di browser — ini
// juga memengaruhi `new Blob()` di dalam manajer yang diuji.
(globalThis as { Blob: typeof Blob }).Blob =
  NodeBlob as unknown as typeof Blob;

// ---------- Cache Storage palsu (duplikat kecil dari tes store) ----------

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

// ---------- Bantuan ----------

const FIXTURE = new Uint8Array(2500).map((_, i) => i % 251);
const STREAM_URL = 'https://rr1.googlevideo.com/videoplayback?x=1';
const sleepInstant = (): Promise<void> => Promise.resolve();

let counter = 0;
const openDbs: LarasDatabase[] = [];

async function makeLibrary(): Promise<LibraryService> {
  counter += 1;
  const db = new LarasDatabase(`laras-dl-test-${counter}`);
  openDbs.push(db);
  await db.open();
  return new LibraryService(db);
}

afterEach(async () => {
  // Jeda drain: manajer menulis progres lewat updateDownloadJob
  // fire-and-forget di onProgress — tanpa jeda, tulis itu bisa
  // masih tertunda saat database ditutup dan melempar
  // DatabaseClosedError sebagai unhandled rejection.
  await new Promise((r) => setTimeout(r, 50));
  while (openDbs.length > 0) {
    const db = openDbs.pop();
    db?.close();
  }
});

function fakeResolver(url = STREAM_URL): DownloadResolver {
  return {
    init: () => Promise.resolve(undefined),
    resolve: (song) =>
      Promise.resolve({
        videoId: song.videoId,
        title: song.title,
        url,
        itag: 251,
        bitrate: 160000,
        client: 'WEB_REMIX',
        usedSolver: false,
        hash: null,
        resolveMs: 1,
      } satisfies ResolvedTrack),
  };
}

/**
 * Baca header Range dari init fetch TANPA `new Headers()`: global
 * `Headers` di lingkungan jsdom Vitest adalah stub yang
 * mengabaikan init dari objek polos (terbukti 18 Nov 2026:
 * `new Headers({Range}).get('Range')` menghasilkan null),
 * sementara fetchRangeViaProxy selalu mengirim objek polos.
 */
function rangeFromInit(init: { headers?: unknown } | undefined): string | null {
  const headers = init?.headers;
  if (!headers || typeof headers !== 'object') return null;
  if (
    'get' in headers &&
    typeof (headers as { get: unknown }).get === 'function'
  ) {
    const value = (headers as { get: (name: string) => unknown }).get('Range');
    if (typeof value === 'string') return value;
  }
  for (const [key, value] of Object.entries(
    headers as Record<string, unknown>,
  )) {
    if (key.toLowerCase() === 'range' && typeof value === 'string') {
      return value;
    }
  }
  return null;
}

/** fetch palsu yang melayani Range atas FIXTURE lewat bentuk proxy. */
function makeProxyFetch(opts: { status?: number } = {}): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; range: string | null }>;
} {
  const calls: Array<{ url: string; range: string | null }> = [];
  const fetchImpl = (async (input: unknown, init?: { headers?: unknown }) => {
    const url = String(input);
    const range = rangeFromInit(init);
    calls.push({ url, range });
    const status = opts.status ?? 206;
    if (status !== 206 && status !== 200) {
      return new Response('gagal', { status });
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
    const start = match ? Number(match[1]) : 0;
    const end = match ? Number(match[2]) : FIXTURE.length - 1;
    const slice = FIXTURE.slice(start, Math.min(end + 1, FIXTURE.length));
    return new Response(slice as unknown as BodyInit, {
      status: 206,
      headers: {
        'Content-Range': `bytes ${start}-${start + slice.length - 1}/${FIXTURE.length}`,
        'Content-Type': 'audio/webm',
      },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** Baca byte Blob (Blob Node punya arrayBuffer asli). */
async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

async function waitFor(
  cond: () => Promise<boolean>,
  label: string,
): Promise<void> {
  // Batas 25 dtk (di bawah timeout tes 30 dtk): fake-indexeddb
  // lambat saat seluruh suite jalan paralel di VM berbagi CPU.
  const deadline = Date.now() + 25000;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error(`Timeout menunggu: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function seedSong(
  library: LibraryService,
  id: string,
  title = `Lagu ${id}`,
): Promise<void> {
  await library.upsertSong(
    {
      id,
      title,
      albumId: null,
      durationSeconds: 10,
      thumbnailUrl: null,
      liked: 0,
      totalPlayTimeMs: 0,
      inLibrary: 1,
      downloadState: DownloadState.notDownloaded,
      filePath: null,
      fileSizeBytes: null,
      downloadedAt: null,
      formatId: null,
      unplayable: 0,
    },
    { artistNames: ['Artis Uji'], addToLibrary: true },
  );
}

// ---------- Parser ----------

describe('parseContentRangeTotal', () => {
  it('memparse total dari Content-Range', () => {
    expect(parseContentRangeTotal('bytes 0-999/2500')).toBe(2500);
    expect(parseContentRangeTotal('bytes 1000-1999/2500')).toBe(2500);
  });

  it('menolak header rusak/null', () => {
    expect(parseContentRangeTotal(null)).toBeNull();
    expect(parseContentRangeTotal('')).toBeNull();
    expect(parseContentRangeTotal('bytes 0-999/*')).toBeNull();
    expect(parseContentRangeTotal('bytes 0-999/abc')).toBeNull();
    expect(parseContentRangeTotal('0-999/2500')).toBeNull();
  });
});

describe('parseRetryAfterSeconds', () => {
  it('memparse detik dan membatasi maks', () => {
    expect(parseRetryAfterSeconds('5', 65)).toBe(5);
    expect(parseRetryAfterSeconds('120', 65)).toBe(65);
    expect(parseRetryAfterSeconds('1.5', 65)).toBe(2);
  });

  it('header hilang/rusak memakai default 60 (dibatasi maks)', () => {
    expect(parseRetryAfterSeconds(null, 65)).toBe(60);
    expect(parseRetryAfterSeconds('nanti', 65)).toBe(60);
    expect(parseRetryAfterSeconds('-3', 65)).toBe(60);
    expect(parseRetryAfterSeconds(null, 30)).toBe(30);
  });
});

// ---------- readBodyWithWatchdog ----------

describe('readBodyWithWatchdog', () => {
  const signal = new AbortController().signal;

  it('membaca body utuh', async () => {
    const res = new Response(new Uint8Array([1, 2, 3]));
    const bytes = await readBodyWithWatchdog(res.body, {
      capBytes: 1000,
      stallMs: 1000,
      signal,
    });
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('body null menjadi byte kosong', async () => {
    const bytes = await readBodyWithWatchdog(null, {
      capBytes: 1000,
      stallMs: 1000,
      signal,
    });
    expect(bytes.length).toBe(0);
  });

  it('melewati cap berarti TooBig', async () => {
    const res = new Response(new Uint8Array(100));
    await expect(
      readBodyWithWatchdog(res.body, {
        capBytes: 50,
        stallMs: 1000,
        signal,
      }),
    ).rejects.toBeInstanceOf(TooBigError);
  });

  it('stream yang macet ditolak sebagai Retryable (bukan diam-diam utuh)', async () => {
    const hanging = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        // Tidak pernah enqueue lagi, tidak pernah close.
      },
    });
    await expect(
      readBodyWithWatchdog(hanging, {
        capBytes: 1000,
        stallMs: 10,
        signal,
      }),
    ).rejects.toBeInstanceOf(RetryableError);
  });
});

// ---------- fetchRangeViaProxy ----------

describe('fetchRangeViaProxy', () => {
  const signal = new AbortController().signal;

  it('memanggil proxy dengan URL ter-encode + header Range', async () => {
    const { fetchImpl, calls } = makeProxyFetch();
    const result = await fetchRangeViaProxy(STREAM_URL, 0, 999, signal, {
      fetchImpl,
      sleep: sleepInstant,
    });
    expect(result.status).toBe(206);
    expect(result.totalBytes).toBe(2500);
    expect(result.bytes.length).toBe(1000);
    expect(result.contentType).toBe('audio/webm');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      `${PROXY_BASE_URL}/api/media?u=${encodeURIComponent(STREAM_URL)}`,
    );
    expect(calls[0].range).toBe('bytes=0-999');
  });

  it('429 menunggu Retry-After lalu mencoba lagi (tanpa gagal)', async () => {
    let tries = 0;
    const fetchImpl = (async () => {
      tries += 1;
      if (tries <= 2) {
        return new Response('rate limited', {
          status: 429,
          headers: { 'Retry-After': '1' },
        });
      }
      return new Response(new Uint8Array([9]) as unknown as BodyInit, {
        status: 206,
        headers: {
          'Content-Range': 'bytes 0-0/1',
          'Content-Type': 'audio/webm',
        },
      });
    }) as unknown as typeof fetch;
    const sleep = vi.fn(() => Promise.resolve());
    const result = await fetchRangeViaProxy(STREAM_URL, 0, 0, signal, {
      fetchImpl,
      sleep,
    });
    expect(result.bytes).toEqual(new Uint8Array([9]));
    expect(tries).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it('429 keempat kalinya menyerah sebagai Retryable', async () => {
    const fetchImpl = (async () =>
      new Response('rate limited', {
        status: 429,
        headers: { 'Retry-After': '0' },
      })) as unknown as typeof fetch;
    await expect(
      fetchRangeViaProxy(STREAM_URL, 0, 0, signal, {
        fetchImpl,
        sleep: sleepInstant,
      }),
    ).rejects.toBeInstanceOf(RetryableError);
  });

  it('403/404/410 berarti URL mati (UrlExpired)', async () => {
    for (const status of [403, 404, 410]) {
      const fetchImpl = (async () =>
        new Response('mati', { status })) as unknown as typeof fetch;
      await expect(
        fetchRangeViaProxy(STREAM_URL, 0, 0, signal, {
          fetchImpl,
          sleep: sleepInstant,
        }),
      ).rejects.toBeInstanceOf(UrlExpiredError);
    }
  });

  it('URL di luar allowlist ditolak TANPA memanggil fetch', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      fetchRangeViaProxy('https://evil.example.com/audio.opus', 0, 0, signal, {
        fetchImpl,
        sleep: sleepInstant,
      }),
    ).rejects.toBeInstanceOf(UrlExpiredError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('gagal jaringan menjadi Retryable', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(
      fetchRangeViaProxy(STREAM_URL, 0, 0, signal, {
        fetchImpl,
        sleep: sleepInstant,
      }),
    ).rejects.toBeInstanceOf(RetryableError);
  });
});

// ---------- reconcileDownloads ----------

describe('reconcileDownloads', () => {
  it('membersihkan semua ketidakcocokan Dexie vs cache', async () => {
    const library = await makeLibrary();
    const store = new DownloadStore({
      caches: new FakeCaches(),
      origin: 'https://app.test',
    });
    // Lagu A: job running (stale) -> antrean.
    await seedSong(library, 'a');
    await library.upsertDownloadJob({
      songId: 'a',
      status: DownloadJobStatus.running,
      quality: 251,
      bytesDownloaded: 100,
      totalBytes: 2500,
      attempts: 1,
      errorMessage: null,
      createdAt: 1,
    });
    // Lagu B: diklaim terunduh, file hilang -> status dibersihkan.
    await seedSong(library, 'b');
    await library.markDownloaded({
      songId: 'b',
      filePath: '/dl/b',
      fileSizeBytes: 2500,
    });
    // Lagu C: diklaim terunduh + file ada -> utuh.
    await seedSong(library, 'c');
    await library.markDownloaded({
      songId: 'c',
      filePath: '/dl/c',
      fileSizeBytes: 2500,
    });
    await store.putDownload('c', new Blob(['data']), 'audio/webm');
    // File yatim (tanpa baris Dexie) -> dihapus.
    await store.putDownload('orphan', new Blob(['yatim']), 'audio/webm');
    // Part yatim (tanpa job, bukan unduhan) -> dihapus.
    await store.putPart('stale', 0, new Uint8Array([1]));
    // Part milik job A (berjalan) -> dipertahankan.
    await store.putPart('a', 0, new Uint8Array([1]));

    const result = await reconcileDownloads({ library, store });

    expect(result.jobsRequeued).toBe(1);
    expect(result.missingCleared).toBe(1);
    expect(result.orphansRemoved).toBe(1);
    expect(result.stalePartsRemoved).toBe(1);

    expect((await library.downloadJobBySongId('a'))?.status).toBe(
      DownloadJobStatus.queued,
    );
    expect(await library.isDownloaded('b')).toBe(false);
    expect(await library.isDownloaded('c')).toBe(true);
    expect(await store.hasDownload('orphan')).toBe(false);
    expect(await store.hasDownload('c')).toBe(true);
    expect(await store.listPartIndexes('stale')).toEqual([]);
    expect(await store.listPartIndexes('a')).toEqual([0]);
  });
});

// ---------- getDownloadStorageStats / downloadErrorMessage ----------

describe('getDownloadStorageStats', () => {
  it('menggabungkan statistik Dexie + estimate', async () => {
    const library = await makeLibrary();
    await seedSong(library, 'a');
    await library.markDownloaded({
      songId: 'a',
      filePath: '/dl/a',
      fileSizeBytes: 2500,
    });
    const stats = await getDownloadStorageStats({
      library,
      storageEstimate: () => Promise.resolve({ usage: 5000, quota: 100000 }),
    });
    expect(stats.downloadCount).toBe(1);
    expect(stats.downloadBytes).toBe(2500);
    expect(stats.usageBytes).toBe(5000);
    expect(stats.quotaBytes).toBe(100000);
  });

  it('estimate gagal tetap menampilkan statistik unduhan', async () => {
    const library = await makeLibrary();
    const stats = await getDownloadStorageStats({
      library,
      storageEstimate: () => Promise.reject(new Error('gagal')),
    });
    expect(stats.downloadCount).toBe(0);
    expect(stats.usageBytes).toBeNull();
    expect(stats.quotaBytes).toBeNull();
  });
});

describe('downloadErrorMessage', () => {
  it('pesan per jenis galat, tanpa URL dan tanpa jargon', () => {
    expect(downloadErrorMessage(new TooBigError())).toContain('terlalu besar');
    expect(downloadErrorMessage(new UrlExpiredError('x'))).toContain(
      'tidak bisa ditemukan',
    );
    expect(downloadErrorMessage(new Error('apa pun'))).toContain(
      'Periksa koneksi',
    );
    for (const msg of [
      downloadErrorMessage(new TooBigError()),
      downloadErrorMessage(new UrlExpiredError('https://rahasia/x')),
      downloadErrorMessage(new Error('https://rahasia/y')),
    ]) {
      expect(msg).not.toContain('http');
    }
  });
});

// ---------- DownloadManager end-to-end ----------

function makeManager(library: LibraryService, opts: {
  fetchImpl?: typeof fetch;
  storageEstimate?: () => Promise<{ usage?: number; quota?: number }>;
  chunkSizeBytes?: number;
} = {}): { manager: DownloadManager; store: DownloadStore } {
  const store = new DownloadStore({
    caches: new FakeCaches(),
    origin: 'https://app.test',
  });
  const manager = new DownloadManager({
    library,
    store,
    resolver: fakeResolver(),
    fetchImpl: opts.fetchImpl ?? makeProxyFetch().fetchImpl,
    sleep: sleepInstant,
    storageEstimate: opts.storageEstimate,
    chunkSizeBytes: opts.chunkSizeBytes ?? 1000,
  });
  return { manager, store };
}

describe('DownloadManager', () => {
  it('mengunduh 2 lagu SERIAL, file utuh dan cocok byte', async () => {
    const library = await makeLibrary();
    await seedSong(library, 's1');
    await seedSong(library, 's2');
    const { fetchImpl, calls } = makeProxyFetch();
    const { manager, store } = makeManager(library, { fetchImpl });

    expect(await manager.enqueue('s1', 'best', { title: 'Lagu s1' })).toBe(
      'queued',
    );
    expect(await manager.enqueue('s2', 'best', { title: 'Lagu s2' })).toBe(
      'queued',
    );
    await waitFor(async () => library.isDownloaded('s2'), 's2 terunduh');

    // Serial: 3 chunk s1 (0-999, 1000-1999, 2000-2499) selesai
    // sebelum chunk pertama s2 — urutan Range membuktikannya.
    expect(calls.map((c) => c.range)).toEqual([
      'bytes=0-999',
      'bytes=1000-1999',
      'bytes=2000-2499',
      'bytes=0-999',
      'bytes=1000-1999',
      'bytes=2000-2499',
    ]);
    for (const id of ['s1', 's2']) {
      const blob = await store.getDownload(id);
      expect(blob).not.toBeNull();
      expect(await blobBytes(blob!)).toEqual(FIXTURE);
      const song = await library.songById(id);
      expect(song?.song.downloadState).toBe(DownloadState.downloaded);
      expect(song?.song.fileSizeBytes).toBe(2500);
      expect(song?.song.formatId).toBe('251');
      expect(await library.downloadJobBySongId(id)).toBeNull();
      expect(await store.listPartIndexes(id)).toEqual([]);
    }
  });

  it('enqueue lagu terunduh / sudah antre ditolak dengan benar', async () => {
    const library = await makeLibrary();
    await seedSong(library, 's1');
    await seedSong(library, 's2');
    await library.markDownloaded({
      songId: 's2',
      filePath: '/dl/s2',
      fileSizeBytes: 2500,
    });
    const { manager } = makeManager(library);
    expect(await manager.enqueue('s2', 'best', { title: 'Lagu s2' })).toBe(
      'already-downloaded',
    );
    expect(await manager.enqueue('s1', 'best', { title: 'Lagu s1' })).toBe(
      'queued',
    );
    expect(await manager.enqueue('s1', 'best', { title: 'Lagu s1' })).toBe(
      'already-queued',
    );
    // Tunggu unduhan s1 selesai sebelum tes berakhir: pompa yang
    // masih berjalan saat afterEach menutup database melempar
    // DatabaseClosedError.
    await waitFor(async () => library.isDownloaded('s1'), 's1 terunduh');
  });

  it('resume memakai part lama (tidak mengunduh ulang prefix)', async () => {
    const library = await makeLibrary();
    await seedSong(library, 's1');
    const { fetchImpl, calls } = makeProxyFetch();
    const { manager, store } = makeManager(library, { fetchImpl });
    // Part 0 (byte 0-999) sudah ada dari sesi sebelumnya.
    await store.putPart('s1', 0, FIXTURE.slice(0, 1000));

    await manager.enqueue('s1', 'best', { title: 'Lagu s1' });
    await waitFor(async () => library.isDownloaded('s1'), 's1 terunduh');

    expect(calls.map((c) => c.range)).toEqual([
      'bytes=1000-1999',
      'bytes=2000-2499',
    ]);
    const blob = await store.getDownload('s1');
    expect(await blobBytes(blob!)).toEqual(FIXTURE);
  });

  it('resume tahan ukuran chunk berubah antar sesi (regresi P5)', async () => {
    // Part lama ditulis chunk 1000 byte; sesi baru memakai chunk
    // 2500 byte (E2E: chunk kecil di /p5-test, chunk normal
    // sesudah navigasi ke /downloads). Part baru WAJIB berindeks
    // berurutan dari part lama — rumus offset/chunk menimpa
    // part 0 dan rakitan gagal cocok ukurannya (18 Nov).
    const library = await makeLibrary();
    await seedSong(library, 's1');
    const { fetchImpl, calls } = makeProxyFetch();
    const { manager, store } = makeManager(library, {
      fetchImpl,
      chunkSizeBytes: 2500,
    });
    await store.putPart('s1', 0, FIXTURE.slice(0, 1000));

    await manager.enqueue('s1', 'best', { title: 'Lagu s1' });
    await waitFor(async () => library.isDownloaded('s1'), 's1 terunduh');

    expect(calls.map((c) => c.range)).toEqual(['bytes=1000-3499']);
    const blob = await store.getDownload('s1');
    expect(await blobBytes(blob!)).toEqual(FIXTURE);
  });

  it('job gagal (HTTP 500) lalu retry berhasil', async () => {
    const library = await makeLibrary();
    await seedSong(library, 's1');
    let healthy = false;
    const { fetchImpl: goodFetch } = makeProxyFetch();
    const flakyFetch = (async (...args: unknown[]) => {
      if (!healthy) return new Response('gagal', { status: 500 });
      return (goodFetch as (...a: unknown[]) => Promise<Response>)(...args);
    }) as unknown as typeof fetch;
    const { manager } = makeManager(library, { fetchImpl: flakyFetch });

    await manager.enqueue('s1', 'best', { title: 'Lagu s1' });
    await waitFor(
      async () =>
        (await library.downloadJobBySongId('s1'))?.status ===
        DownloadJobStatus.failed,
      'job gagal',
    );
    const failed = await library.downloadJobBySongId('s1');
    expect(failed?.errorMessage).toContain('Periksa koneksi');
    expect(failed?.quality).toBe(251);

    healthy = true;
    await manager.retry('s1');
    await waitFor(async () => library.isDownloaded('s1'), 's1 terunduh');
  });

  it('cancel job antre menghapus job + part + status', async () => {
    const library = await makeLibrary();
    await seedSong(library, 's1');
    await seedSong(library, 's2');
    // Gerbang: chunk s1 tertahan sampai test melepas.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { fetchImpl: baseFetch } = makeProxyFetch();
    let firstCall = true;
    const gatedFetch = (async (...args: unknown[]) => {
      if (firstCall) {
        firstCall = false;
        await gate;
      }
      return (baseFetch as (...a: unknown[]) => Promise<Response>)(...args);
    }) as unknown as typeof fetch;
    const { manager, store } = makeManager(library, { fetchImpl: gatedFetch });

    await manager.enqueue('s1', 'best', { title: 'Lagu s1' });
    await manager.enqueue('s2', 'best', { title: 'Lagu s2' });
    // s2 masih antre (s1 tertahan di gerbang).
    await waitFor(
      async () =>
        (await library.downloadJobBySongId('s2'))?.status ===
        DownloadJobStatus.queued,
      's2 antre',
    );
    await manager.cancel('s2');
    expect(await library.downloadJobBySongId('s2')).toBeNull();
    const song2 = await library.songById('s2');
    expect(song2?.song.downloadState).toBe(DownloadState.notDownloaded);
    expect(await store.listPartIndexes('s2')).toEqual([]);

    release();
    await waitFor(async () => library.isDownloaded('s1'), 's1 terunduh');
  });

  it('ruang tidak cukup menggagalkan job sebelum byte pertama', async () => {
    const library = await makeLibrary();
    await seedSong(library, 's1');
    const { fetchImpl, calls } = makeProxyFetch();
    const { manager } = makeManager(library, {
      fetchImpl,
      storageEstimate: () => Promise.resolve({ usage: 0, quota: 1000 }),
    });
    await manager.enqueue('s1', 'best', { title: 'Lagu s1' });
    await waitFor(
      async () =>
        (await library.downloadJobBySongId('s1'))?.status ===
        DownloadJobStatus.failed,
      'job gagal karena ruang',
    );
    const job = await library.downloadJobBySongId('s1');
    expect(job?.errorMessage).toContain('Ruang di perangkat tidak cukup');
    // Tidak ada satu pun byte diunduh.
    expect(calls).toHaveLength(0);
  });

  it('deleteDownload + deleteAllDownloads membersihkan semua jejak', async () => {
    const library = await makeLibrary();
    await seedSong(library, 's1');
    await seedSong(library, 's2');
    const { manager, store } = makeManager(library);
    await manager.enqueue('s1', 'best', { title: 'Lagu s1' });
    await manager.enqueue('s2', 'best', { title: 'Lagu s2' });
    await waitFor(async () => library.isDownloaded('s2'), 's2 terunduh');

    await manager.deleteDownload('s1');
    expect(await store.hasDownload('s1')).toBe(false);
    expect(await library.isDownloaded('s1')).toBe(false);
    expect(await store.hasDownload('s2')).toBe(true);

    expect(await manager.deleteAllDownloads()).toBe(1);
    expect(await store.hasDownload('s2')).toBe(false);
    expect(await library.isDownloaded('s2')).toBe(false);
    expect(await store.listDownloads()).toEqual([]);
  });

  it('init() merekonsiliasi lalu melanjutkan antrean tertunda', async () => {
    const library = await makeLibrary();
    await seedSong(library, 's1');
    // Job antre dari sesi sebelumnya (app ditutup sebelum selesai).
    await library.upsertDownloadJob({
      songId: 's1',
      status: DownloadJobStatus.queued,
      quality: 251,
      bytesDownloaded: 0,
      totalBytes: null,
      attempts: 0,
      errorMessage: null,
      createdAt: 1,
    });
    const { manager, store } = makeManager(library);
    await store.putDownload('orphan', new Blob(['yatim']), 'audio/webm');

    const result = await manager.init();
    expect(result?.orphansRemoved).toBe(1);
    await waitFor(async () => library.isDownloaded('s1'), 's1 terunduh');
    // init kedua tidak-op (idempotent).
    expect(await manager.init()).toBeNull();
  });
  // Timeout 30 dtk: fake-indexeddb lambat saat suite paralel
  // (lihat catatan di library.test.ts) — anggaran lingkungan.
}, 30000);
