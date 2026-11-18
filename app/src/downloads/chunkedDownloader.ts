/**
 * Mesin unduh ber-chunk lewat proxy (P5).
 *
 * Satu file diunduh sebagai rangkaian request Range 1 MiB lewat
 * `/api/media`. Chunking ada karena dua alasan yang terbukti:
 * URL googlevideo bisa mati sesudah sekitar 1 MiB dialirkan
 * (dinding S2/S3), dan resume harus bisa lanjut dari byte
 * terakhir tanpa mengulang seluruh file.
 *
 * Modul ini murni logika loop + retry; ia tidak tahu tentang
 * Dexie, Cache Storage, atau UI. Pengambilan byte disuntikkan
 * lewat `fetchRange` (manager mengisinya dengan fetch ke proxy),
 * penyimpanan part lewat `onChunk` (manager menulis part ke
 * Cache Storage). Pemisahan ini membuat loop bisa diuji penuh
 * dengan fetch palsu.
 *
 * Aturan retry: tiap chunk dicoba sampai 3 kali sesudah gagal
 * (backoff 1 dtk, lalu 2 dtk, + jitter); URL yang mati
 * (403/404/410) memicu re-resolve (maks 2x per file) lalu chunk
 * yang sama diulang dengan URL segar; 429 ditangani DI DALAM
 * `fetchRange` (tunggu Retry-After) dan tidak menghabiskan
 * percobaan chunk.
 *
 * Total file biasanya datang dari Content-Range, tetapi header
 * itu TIDAK terekspos ke fetch lintas origin bila proxy tidak
 * mengirim `Access-Control-Expose-Headers: Content-Range`
 * (proxy /api/media saat ini tidak mengirimnya — P5, 18 Nov).
 * Bila total tidak diketahui, ujung file dikenali dari chunk
 * PENDEK (server selalu memenuhi penuh kecuali di ujung) atau
 * chunk KOSONG sesudah ada kemajuan. Tanpa fallback ini semua
 * unduhan gagal di chunk kosong sesudah chunk terakhir.
 */

import {
  DOWNLOAD_CHUNK_BYTES,
  DOWNLOAD_MAX_CHUNK_RETRIES,
  DOWNLOAD_MAX_FILE_BYTES,
  DOWNLOAD_MAX_RERESOLVES,
} from './constants';

/** URL stream mati (403/404/410): perlu re-resolve, bukan retry. */
export class UrlExpiredError extends Error {
  constructor(message = 'URL stream sudah tidak berlaku') {
    super(message);
    this.name = 'UrlExpiredError';
  }
}

/** File melewati cap ukuran: berhenti, tidak bisa dilanjutkan. */
export class TooBigError extends Error {
  constructor(message = 'File melewati batas ukuran unduhan') {
    super(message);
    this.name = 'TooBigError';
  }
}

/** Gagal jaringan/5xx: boleh dicoba ulang. */
export class RetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableError';
  }
}

/** Unduhan dibatalkan pengguna (AbortSignal). */
export class DownloadAbortedError extends Error {
  constructor(message = 'Unduhan dibatalkan') {
    super(message);
    this.name = 'DownloadAbortedError';
  }
}

/** Hasil satu request Range dari `fetchRange`. */
export interface RangeResult {
  /** 206 (Range dipenuhi) atau 200 (Range diabaikan, isi penuh). */
  status: number;
  /** Total byte file, dari Content-Range/Content-Length. */
  totalBytes: number | null;
  contentType: string | null;
  bytes: Uint8Array;
}

/**
 * Ambil byte `start..end` (inklusif) dari `url`. Implementasi
 * WAJIB: kirim header Range, lempar UrlExpiredError untuk
 * 403/404/410, lempar RetryableError untuk galat jaringan/5xx,
 * lempar TooBigError bila body melewati cap, dan menangani 429
 * sendiri (tunggu Retry-After, maks 3 kali tunggu) sebelum
 * menyerah dengan RetryableError.
 */
export type FetchRange = (
  url: string,
  start: number,
  end: number,
  signal: AbortSignal,
) => Promise<RangeResult>;

export interface ChunkedDownloadOptions {
  /** URL stream googlevideo (hanya di memori, jangan dicetak). */
  streamUrl: string;
  /** Byte awal (0 untuk baru; > 0 untuk resume dari part lama). */
  startByte: number;
  chunkSizeBytes?: number;
  maxChunkRetries?: number;
  maxReresolves?: number;
  maxFileBytes?: number;
  fetchRange: FetchRange;
  /** URL segar sesudah URL lama mati (resolve ulang). */
  reResolve: () => Promise<string>;
  /** Dipanggil tiap chunk berhasil (manager menyimpan part). */
  onChunk: (bytes: Uint8Array, offset: number) => Promise<void>;
  /** Dipanggil tiap chunk berhasil (manager memperbarui job). */
  onProgress: (downloaded: number, total: number | null) => void;
  signal: AbortSignal;
  /** Tidur antar percobaan (disuntikkan supaya tes tidak menunggu). */
  sleep?: (ms: number) => Promise<void>;
}

export interface ChunkedDownloadResult {
  totalBytes: number;
  contentType: string | null;
  /** Jumlah chunk yang diunduh dalam pemanggilan ini. */
  chunksDownloaded: number;
  /** Jumlah re-resolve yang dipakai. */
  reresolvesUsed: number;
}

const sleepDefault = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Backoff antar percobaan chunk: 1 dtk, 2 dtk, 4 dtk (+ jitter). */
export function retryDelayMs(attempt: number): number {
  const base = [1000, 2000, 4000][attempt] ?? 4000;
  return base + Math.floor(Math.random() * 500);
}

function isAbort(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === 'AbortError') ||
    error instanceof DownloadAbortedError
  );
}

/**
 * Unduh satu file penuh secara ber-chunk. Mengembalikan total
 * byte + tipe konten sesudah chunk terakhir. Melempar
 * UrlExpiredError (re-resolve habis), TooBigError (cap),
 * RetryableError (percobaan habis), atau DownloadAbortedError.
 */
export async function downloadChunked(
  opts: ChunkedDownloadOptions,
): Promise<ChunkedDownloadResult> {
  const chunkSize = opts.chunkSizeBytes ?? DOWNLOAD_CHUNK_BYTES;
  const maxRetries = opts.maxChunkRetries ?? DOWNLOAD_MAX_CHUNK_RETRIES;
  const maxReresolves = opts.maxReresolves ?? DOWNLOAD_MAX_RERESOLVES;
  const maxFileBytes = opts.maxFileBytes ?? DOWNLOAD_MAX_FILE_BYTES;
  const sleep = opts.sleep ?? sleepDefault;

  let url = opts.streamUrl;
  let offset = opts.startByte;
  let total: number | null = null;
  let contentType: string | null = null;
  let chunksDownloaded = 0;
  let reresolvesUsed = 0;

  const throwIfAborted = (): void => {
    if (opts.signal.aborted) throw new DownloadAbortedError();
  };

  while (total === null || offset < total) {
    throwIfAborted();
    const end =
      total === null
        ? offset + chunkSize - 1
        : Math.min(offset + chunkSize - 1, total - 1);
    let attempt = 0;
    let result: RangeResult | null = null;
    // Loop percobaan satu chunk: retry untuk galat sementara,
    // re-resolve untuk URL mati (tidak menghabiskan percobaan).
    for (;;) {
      throwIfAborted();
      try {
        result = await opts.fetchRange(url, offset, end, opts.signal);
        break;
      } catch (error) {
        if (isAbort(error)) throw new DownloadAbortedError();
        if (error instanceof TooBigError) throw error;
        if (error instanceof UrlExpiredError) {
          if (reresolvesUsed >= maxReresolves) throw error;
          reresolvesUsed += 1;
          url = await opts.reResolve();
          // Ulang chunk yang sama dengan URL segar.
          continue;
        }
        // Galat sementara: coba ulang sampai batas.
        if (attempt >= maxRetries) {
          throw error instanceof RetryableError
            ? error
            : new RetryableError(
                error instanceof Error ? error.message : 'Unduhan gagal',
              );
        }
        await sleep(retryDelayMs(attempt));
        attempt += 1;
      }
    }

    if (result === null) throw new RetryableError('Chunk kosong');
    if (result.bytes.length === 0) {
      // Chunk kosong sesudah ada kemajuan = ujung file: server
      // kehabisan byte (terjadi bila total tidak diketahui dan
      // ukuran file pas kelipatan ukuran chunk). Tanpa kemajuan
      // sama sekali, ini galat nyata.
      if (chunksDownloaded > 0) {
        total = offset;
        break;
      }
      throw new RetryableError('Server membalas tanpa byte');
    }
    // Server mengabaikan Range (200): hanya sah di offset 0,
    // dan isinya adalah SELURUH file, bukan satu chunk.
    if (result.status === 200) {
      if (offset !== 0) {
        throw new RetryableError('Server mengabaikan Range di tengah file');
      }
      if (result.bytes.length > maxFileBytes) throw new TooBigError();
      total = result.bytes.length;
      contentType = result.contentType;
      await opts.onChunk(result.bytes, 0);
      chunksDownloaded += 1;
      opts.onProgress(result.bytes.length, total);
      return { totalBytes: total, contentType, chunksDownloaded, reresolvesUsed };
    }
    if (result.status !== 206) {
      throw new RetryableError(`Status tidak terduga: ${result.status}`);
    }
    if (result.totalBytes !== null) {
      if (result.totalBytes > maxFileBytes) throw new TooBigError();
      total = result.totalBytes;
    }
    if (offset + result.bytes.length > maxFileBytes) {
      throw new TooBigError();
    }
    contentType = contentType ?? result.contentType;
    const requested = end - offset + 1;
    await opts.onChunk(result.bytes, offset);
    offset += result.bytes.length;
    chunksDownloaded += 1;
    // Tanpa total: chunk pendek adalah chunk terakhir (server
    // Range selalu memenuhi penuh kecuali di ujung file).
    if (total === null && result.bytes.length < requested) {
      total = offset;
    }
    opts.onProgress(offset, total);
    // Pengaman loop: chunk 206 tanpa total dan tanpa kemajuan
    // tidak mungkin terjadi (byte 0 sudah dilempar di atas).
  }

  return {
    totalBytes: total ?? offset,
    contentType,
    chunksDownloaded,
    reresolvesUsed,
  };
}
