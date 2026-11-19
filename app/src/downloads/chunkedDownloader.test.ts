/**
 * Tes mesin unduh ber-chunk dengan fetchRange palsu (tanpa
 * jaringan). Setiap tes memakai sleep instan supaya tidak ada
 * tunggu nyata.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  downloadChunked,
  RetryableError,
  retryDelayMs,
  TooBigError,
  UrlExpiredError,
  type FetchRange,
} from './chunkedDownloader';

const sleepInstant = (): Promise<void> => Promise.resolve();
const abortSignal = new AbortController().signal;

function bytesOf(length: number, fill = 7): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

/** fetchRange palsu atas buffer tetap (mendukung Range + total). */
function fakeRangeFetch(
  buffer: Uint8Array,
  opts: {
    failTimes?: number;
    expireAtChunk?: number;
    /** Total disembunyikan (Content-Range tidak terekspos CORS). */
    hideTotal?: boolean;
  } = {},
): { fetchRange: FetchRange; calls: Array<{ start: number; end: number }> } {
  const calls: Array<{ start: number; end: number }> = [];
  let failuresLeft = opts.failTimes ?? 0;
  const fetchRange: FetchRange = async (_url, start, end) => {
    calls.push({ start, end });
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      throw new RetryableError('jaringan putus (palsu)');
    }
    if (
      opts.expireAtChunk !== undefined &&
      calls.length === opts.expireAtChunk
    ) {
      throw new UrlExpiredError('URL mati (palsu)');
    }
    const slice = buffer.slice(start, Math.min(end + 1, buffer.length));
    return {
      status: 206,
      totalBytes: opts.hideTotal ? null : buffer.length,
      contentType: 'audio/webm',
      bytes: slice,
    };
  };
  return { fetchRange, calls };
}

describe('downloadChunked', () => {
  it('mengunduh file kecil dalam satu chunk', async () => {
    const buffer = bytesOf(1000);
    const { fetchRange, calls } = fakeRangeFetch(buffer);
    const chunks: Array<{ bytes: Uint8Array; offset: number }> = [];
    const result = await downloadChunked({
      streamUrl: 'https://rr1.googlevideo.com/videoplayback?x=1',
      startByte: 0,
      chunkSizeBytes: 1024,
      fetchRange,
      reResolve: () => Promise.resolve('https://rr1.googlevideo.com/baru'),
      onChunk: async (bytes, offset) => {
        chunks.push({ bytes, offset });
      },
      onProgress: () => undefined,
      signal: abortSignal,
      sleep: sleepInstant,
    });
    expect(result.totalBytes).toBe(1000);
    expect(result.chunksDownloaded).toBe(1);
    // Chunk pertama meminta rentang penuh (total belum dikenal);
    // server mengembalikan 1000 byte yang ada.
    expect(calls).toEqual([{ start: 0, end: 1023 }]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].bytes.length).toBe(1000);
    expect(chunks[0].offset).toBe(0);
  });

  it('memecah file besar menjadi chunk 1 MiB + sisa', async () => {
    const buffer = bytesOf(2_500_000);
    const { fetchRange, calls } = fakeRangeFetch(buffer);
    const offsets: number[] = [];
    const result = await downloadChunked({
      streamUrl: 'https://rr1.googlevideo.com/videoplayback?x=1',
      startByte: 0,
      chunkSizeBytes: 1024 * 1024,
      fetchRange,
      reResolve: () => Promise.resolve('https://rr1.googlevideo.com/baru'),
      onChunk: async (_bytes, offset) => {
        offsets.push(offset);
      },
      onProgress: () => undefined,
      signal: abortSignal,
      sleep: sleepInstant,
    });
    expect(result.chunksDownloaded).toBe(3);
    expect(calls).toEqual([
      { start: 0, end: 1048575 },
      { start: 1048576, end: 2097151 },
      { start: 2097152, end: 2499999 },
    ]);
    expect(offsets).toEqual([0, 1048576, 2097152]);
  });

  it('resume dari byte awal (part lama tidak diunduh ulang)', async () => {
    const buffer = bytesOf(3000);
    const { fetchRange, calls } = fakeRangeFetch(buffer);
    const offsets: number[] = [];
    const result = await downloadChunked({
      streamUrl: 'https://rr1.googlevideo.com/videoplayback?x=1',
      startByte: 2000,
      chunkSizeBytes: 1000,
      fetchRange,
      reResolve: () => Promise.resolve('https://rr1.googlevideo.com/baru'),
      onChunk: async (_bytes, offset) => {
        offsets.push(offset);
      },
      onProgress: () => undefined,
      signal: abortSignal,
      sleep: sleepInstant,
    });
    expect(result.chunksDownloaded).toBe(1);
    expect(calls).toEqual([{ start: 2000, end: 2999 }]);
    expect(offsets).toEqual([2000]);
  });

  it('resume di ujung file (semua part sudah ada) selesai tanpa fetch byte', async () => {
    // Regresi P6 (CI 18 Nov): reload halaman sesudah semua chunk
    // terambil tapi sebelum rakit membuat resume mengambil chunk
    // di ujung file (balasan kosong) — dulu dilempar sebagai
    // 'Server membalas tanpa byte' dan job gagal padahal semua
    // byte sudah ada. startByte > 0 adalah kemajuan.
    const buffer = bytesOf(3000);
    const { fetchRange, calls } = fakeRangeFetch(buffer);
    const offsets: number[] = [];
    const result = await downloadChunked({
      streamUrl: 'https://rr1.googlevideo.com/videoplayback?x=1',
      startByte: 3000,
      chunkSizeBytes: 1000,
      fetchRange,
      reResolve: () => Promise.resolve('https://rr1.googlevideo.com/baru'),
      onChunk: async (_bytes, offset) => {
        offsets.push(offset);
      },
      onProgress: () => undefined,
      signal: abortSignal,
      sleep: sleepInstant,
    });
    expect(result.totalBytes).toBe(3000);
    expect(result.chunksDownloaded).toBe(0);
    expect(calls).toEqual([{ start: 3000, end: 3999 }]);
    expect(offsets).toEqual([]);
  });

  it('unduhan baru dari 0 yang dibalas kosong tetap galat', async () => {
    const buffer = bytesOf(0);
    const { fetchRange } = fakeRangeFetch(buffer);
    await expect(
      downloadChunked({
        streamUrl: 'https://rr1.googlevideo.com/videoplayback?x=1',
        startByte: 0,
        chunkSizeBytes: 1000,
        fetchRange,
        reResolve: () =>
          Promise.resolve('https://rr1.googlevideo.com/baru'),
        onChunk: () => Promise.resolve(),
        onProgress: () => undefined,
        signal: abortSignal,
        sleep: sleepInstant,
      }),
    ).rejects.toThrow('Server membalas tanpa byte');
  });

  it('mencoba ulang chunk gagal sampai 3 kali lalu berhasil', async () => {
    const buffer = bytesOf(500);
    const { fetchRange, calls } = fakeRangeFetch(buffer, { failTimes: 3 });
    const result = await downloadChunked({
      streamUrl: 'https://rr1.googlevideo.com/videoplayback?x=1',
      startByte: 0,
      chunkSizeBytes: 1024,
      fetchRange,
      reResolve: () => Promise.resolve('https://rr1.googlevideo.com/baru'),
      onChunk: async () => undefined,
      onProgress: () => undefined,
      signal: abortSignal,
      sleep: sleepInstant,
    });
    expect(result.chunksDownloaded).toBe(1);
    expect(calls).toHaveLength(4);
  });

  it('menyerah sesudah 3 retry (4 percobaan total)', async () => {
    const buffer = bytesOf(500);
    const { fetchRange, calls } = fakeRangeFetch(buffer, { failTimes: 99 });
    await expect(
      downloadChunked({
        streamUrl: 'https://rr1.googlevideo.com/videoplayback?x=1',
        startByte: 0,
        chunkSizeBytes: 1024,
        fetchRange,
        reResolve: () => Promise.resolve('https://rr1.googlevideo.com/baru'),
        onChunk: async () => undefined,
        onProgress: () => undefined,
        signal: abortSignal,
        sleep: sleepInstant,
      }),
    ).rejects.toBeInstanceOf(RetryableError);
    expect(calls).toHaveLength(4);
  });

  it('URL mati memicu re-resolve lalu chunk diulang dengan URL baru', async () => {
    const buffer = bytesOf(2500);
    const seenUrls: string[] = [];
    let expiredOnce = false;
    const fetchRange: FetchRange = async (url, start, end) => {
      seenUrls.push(url);
      if (!expiredOnce && start >= 1000) {
        expiredOnce = true;
        throw new UrlExpiredError('URL mati (palsu)');
      }
      return {
        status: 206,
        totalBytes: buffer.length,
        contentType: 'audio/webm',
        bytes: buffer.slice(start, Math.min(end + 1, buffer.length)),
      };
    };
    const reResolve = vi.fn(() =>
      Promise.resolve('https://rr2.googlevideo.com/segar'),
    );
    const result = await downloadChunked({
      streamUrl: 'https://rr1.googlevideo.com/lama',
      startByte: 0,
      chunkSizeBytes: 1000,
      fetchRange,
      reResolve,
      onChunk: async () => undefined,
      onProgress: () => undefined,
      signal: abortSignal,
      sleep: sleepInstant,
    });
    expect(result.reresolvesUsed).toBe(1);
    expect(reResolve).toHaveBeenCalledTimes(1);
    expect(seenUrls).toContain('https://rr2.googlevideo.com/segar');
    expect(result.chunksDownloaded).toBe(3);
  });

  it('re-resolve habis (2x) berarti gagal', async () => {
    const alwaysExpired: FetchRange = async () => {
      throw new UrlExpiredError('URL mati terus (palsu)');
    };
    const reResolve = vi.fn(() =>
      Promise.resolve('https://rr2.googlevideo.com/segar'),
    );
    await expect(
      downloadChunked({
        streamUrl: 'https://rr1.googlevideo.com/lama',
        startByte: 0,
        chunkSizeBytes: 1000,
        fetchRange: alwaysExpired,
        reResolve,
        onChunk: async () => undefined,
        onProgress: () => undefined,
        signal: abortSignal,
        sleep: sleepInstant,
      }),
    ).rejects.toBeInstanceOf(UrlExpiredError);
    expect(reResolve).toHaveBeenCalledTimes(2);
  });

  it('file melewati cap ditolak sebelum chunk kedua', async () => {
    const buffer = bytesOf(3000);
    const { fetchRange } = fakeRangeFetch(buffer);
    await expect(
      downloadChunked({
        streamUrl: 'https://rr1.googlevideo.com/videoplayback?x=1',
        startByte: 0,
        chunkSizeBytes: 1000,
        maxFileBytes: 2000,
        fetchRange,
        reResolve: () => Promise.resolve('https://rr1.googlevideo.com/baru'),
        onChunk: async () => undefined,
        onProgress: () => undefined,
        signal: abortSignal,
        sleep: sleepInstant,
      }),
    ).rejects.toBeInstanceOf(TooBigError);
  });

  it('server mengabaikan Range (200) di offset 0 diterima sebagai file utuh', async () => {
    const buffer = bytesOf(800);
    const fetchRange: FetchRange = async () => ({
      status: 200,
      totalBytes: null,
      contentType: 'audio/webm',
      bytes: buffer,
    });
    const chunks: number[] = [];
    const result = await downloadChunked({
      streamUrl: 'https://rr1.googlevideo.com/videoplayback?x=1',
      startByte: 0,
      chunkSizeBytes: 1024,
      fetchRange,
      reResolve: () => Promise.resolve('https://rr1.googlevideo.com/baru'),
      onChunk: async (bytes) => {
        chunks.push(bytes.length);
      },
      onProgress: () => undefined,
      signal: abortSignal,
      sleep: sleepInstant,
    });
    expect(result.totalBytes).toBe(800);
    expect(chunks).toEqual([800]);
  });

  it('200 di tengah file ditolak (bukan retry tanpa akhir)', async () => {
    let calls = 0;
    // Callback tanpa parameter: perilaku hanya bergantung pada
    // urutan panggilan (chunk 1 = 206, chunk 2 = 200).
    const fetchRange: FetchRange = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          status: 206,
          totalBytes: 3000,
          contentType: 'audio/webm',
          bytes: bytesOf(1000),
        };
      }
      return {
        status: 200,
        totalBytes: null,
        contentType: 'audio/webm',
        bytes: bytesOf(3000),
      };
    };
    await expect(
      downloadChunked({
        streamUrl: 'https://rr1.googlevideo.com/videoplayback?x=1',
        startByte: 0,
        chunkSizeBytes: 1000,
        fetchRange,
        reResolve: () => Promise.resolve('https://rr1.googlevideo.com/baru'),
        onChunk: async () => undefined,
        onProgress: () => undefined,
        signal: abortSignal,
        sleep: sleepInstant,
      }),
    ).rejects.toBeInstanceOf(RetryableError);
    expect(calls).toBeGreaterThan(1);
  });

  it('abort membatalkan unduhan', async () => {
    const controller = new AbortController();
    const buffer = bytesOf(5000);
    const fetchRange: FetchRange = async (_url, start, end) => {
      if (start >= 2000) controller.abort();
      return {
        status: 206,
        totalBytes: buffer.length,
        contentType: 'audio/webm',
        bytes: buffer.slice(start, Math.min(end + 1, buffer.length)),
      };
    };
    await expect(
      downloadChunked({
        streamUrl: 'https://rr1.googlevideo.com/videoplayback?x=1',
        startByte: 0,
        chunkSizeBytes: 1000,
        fetchRange,
        reResolve: () => Promise.resolve('https://rr1.googlevideo.com/baru'),
        onChunk: async () => undefined,
        onProgress: () => undefined,
        signal: controller.signal,
        sleep: sleepInstant,
      }),
    ).rejects.toThrow('Unduhan dibatalkan');
  });

  it('I11: DOMException AbortError dari fetchRange dikenali sebagai batal', async () => {
    const controller = new AbortController();
    const fetchRange: FetchRange = async () => {
      controller.abort();
      throw new DOMException('The operation was aborted.', 'AbortError');
    };
    await expect(
      downloadChunked({
        streamUrl: 'https://rr1.googlevideo.com/videoplayback?x=1',
        startByte: 0,
        chunkSizeBytes: 1000,
        fetchRange,
        reResolve: () => Promise.resolve('https://rr1.googlevideo.com/baru'),
        onChunk: async () => undefined,
        onProgress: () => undefined,
        signal: controller.signal,
        sleep: sleepInstant,
      }),
    ).rejects.toThrow('Unduhan dibatalkan');
  });

  it('melaporkan progres per chunk', async () => {
    const buffer = bytesOf(2500);
    const { fetchRange } = fakeRangeFetch(buffer);
    const progress: Array<{ downloaded: number; total: number | null }> = [];
    await downloadChunked({
      streamUrl: 'https://rr1.googlevideo.com/videoplayback?x=1',
      startByte: 0,
      chunkSizeBytes: 1000,
      fetchRange,
      reResolve: () => Promise.resolve('https://rr1.googlevideo.com/baru'),
      onChunk: async () => undefined,
      onProgress: (downloaded, total) => {
        progress.push({ downloaded, total });
      },
      signal: abortSignal,
      sleep: sleepInstant,
    });
    expect(progress).toEqual([
      { downloaded: 1000, total: 2500 },
      { downloaded: 2000, total: 2500 },
      { downloaded: 2500, total: 2500 },
    ]);
  });

  it('tanpa total: chunk pendek menandai ujung file', async () => {
    // Regresi P5 (18 Nov): Content-Range tersembunyi CORS —
    // total null; chunk terakhir 500 dari 1000 yang diminta.
    const buffer = bytesOf(2500);
    const { fetchRange, calls } = fakeRangeFetch(buffer, {
      hideTotal: true,
    });
    const result = await downloadChunked({
      streamUrl: 'https://rr1.googlevideo.com/videoplayback?x=1',
      startByte: 0,
      chunkSizeBytes: 1000,
      fetchRange,
      reResolve: () => Promise.resolve('https://rr1.googlevideo.com/baru'),
      onChunk: async () => undefined,
      onProgress: () => undefined,
      signal: abortSignal,
      sleep: sleepInstant,
    });
    expect(result.totalBytes).toBe(2500);
    expect(result.chunksDownloaded).toBe(3);
    expect(calls).toHaveLength(3);
  });

  it('tanpa total: file pas kelipatan chunk selesai di chunk kosong', async () => {
    // 2000 byte = 2 chunk penuh; chunk ke-3 kosong sesudah
    // kemajuan berarti ujung file, bukan galat.
    const buffer = bytesOf(2000);
    const { fetchRange, calls } = fakeRangeFetch(buffer, {
      hideTotal: true,
    });
    const result = await downloadChunked({
      streamUrl: 'https://rr1.googlevideo.com/videoplayback?x=1',
      startByte: 0,
      chunkSizeBytes: 1000,
      fetchRange,
      reResolve: () => Promise.resolve('https://rr1.googlevideo.com/baru'),
      onChunk: async () => undefined,
      onProgress: () => undefined,
      signal: abortSignal,
      sleep: sleepInstant,
    });
    expect(result.totalBytes).toBe(2000);
    expect(result.chunksDownloaded).toBe(2);
    expect(calls).toHaveLength(3);
  });

  it('tanpa total: chunk pertama kosong tetap galat', async () => {
    const buffer = bytesOf(0);
    const { fetchRange } = fakeRangeFetch(buffer, { hideTotal: true });
    await expect(
      downloadChunked({
        streamUrl: 'https://rr1.googlevideo.com/videoplayback?x=1',
        startByte: 0,
        chunkSizeBytes: 1000,
        fetchRange,
        reResolve: () => Promise.resolve('https://rr1.googlevideo.com/baru'),
        onChunk: async () => undefined,
        onProgress: () => undefined,
        signal: abortSignal,
        sleep: sleepInstant,
      }),
    ).rejects.toBeInstanceOf(RetryableError);
  });
});

describe('retryDelayMs', () => {
  it('backoff naik 1 dtk, 2 dtk, 4 dtk (+ jitter < 500 ms)', () => {
    expect(retryDelayMs(0)).toBeGreaterThanOrEqual(1000);
    expect(retryDelayMs(0)).toBeLessThan(1500);
    expect(retryDelayMs(1)).toBeGreaterThanOrEqual(2000);
    expect(retryDelayMs(1)).toBeLessThan(2500);
    expect(retryDelayMs(2)).toBeGreaterThanOrEqual(4000);
    expect(retryDelayMs(2)).toBeLessThan(4500);
    expect(retryDelayMs(9)).toBeLessThan(4500);
  });
});

describe('RangeResult passthrough', () => {
  it('contentType dari chunk pertama dipakai', async () => {
    const buffer = bytesOf(100);
    const fetchRange: FetchRange = async () => ({
      status: 206,
      totalBytes: 100,
      contentType: 'audio/mp4',
      bytes: buffer,
    });
    const result = await downloadChunked({
      streamUrl: 'https://rr1.googlevideo.com/videoplayback?x=1',
      startByte: 0,
      chunkSizeBytes: 1024,
      fetchRange,
      reResolve: () => Promise.resolve('https://rr1.googlevideo.com/baru'),
      onChunk: async () => undefined,
      onProgress: () => undefined,
      signal: abortSignal,
      sleep: sleepInstant,
    });
    expect(result.contentType).toBe('audio/mp4');
  });
});
