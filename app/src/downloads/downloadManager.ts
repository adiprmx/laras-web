/**
 * Manajer unduhan (P5): antrean serial, resume, retry, hapus.
 *
 * Satu file diunduh dalam satu waktu (serial). Antrean tahan
 * restart karena job hidup di store `download_jobs` (Dexie) dan
 * part hidup di Cache Storage; sesudah app ditutup lalu dibuka,
 * `init()` merekonsiliasi lalu melanjutkan antrean.
 *
 * Unduhan WAJIB lewat proxy `/api/media` (Range passthrough):
 * fetch langsung ke googlevideo diblokir CORS total dari
 * browser (vonis S2) dan IP VM diblokir googlevideo (S3).
 * URL stream tidak pernah disimpan di database, file, atau log
 * (PRD B2.1); yang disimpan hanya videoId + itag.
 *
 * Dependensi disuntikkan lewat konstruktor supaya manajer bisa
 * diuji dengan resolver/fetch/storage palsu.
 */

import { PROXY_BASE_URL } from '../spike/config';
import { isAllowedStreamUrl } from '../solver/urlAllowlist';
import { StreamResolver, type ResolvedTrack } from '../extractor/resolve';
import type { LibraryService } from '../data/library';
import { DownloadJobStatus, DownloadState } from '../data/types';
import { downloadUrl, DOWNLOAD_CHUNK_BYTES, DOWNLOAD_MAX_FILE_BYTES, DOWNLOAD_MAX_RETRY_AFTER_SECONDS, DOWNLOAD_SPACE_HEADROOM_BYTES, DOWNLOAD_STALL_TIMEOUT_MS, DOWNLOAD_CHUNK_TIMEOUT_MS } from './constants';
import {
  downloadChunked,
  DownloadAbortedError,
  RetryableError,
  TooBigError,
  UrlExpiredError,
  type FetchRange,
  type RangeResult,
} from './chunkedDownloader';
import { DownloadStore, getDownloadStore } from './downloadStore';
import {
  QUALITY_ITAG_PREFERENCE,
  qualityFromItag,
  type DownloadQuality,
} from './quality';

/** Resolver minimal yang dibutuhkan manajer (bisa dipalsukan). */
export interface DownloadResolver {
  init(): Promise<unknown>;
  resolve(
    song: { videoId: string; title: string },
    opts?: { itagPreference?: readonly number[] },
  ): Promise<ResolvedTrack>;
}

export interface DownloadManagerDeps {
  library: LibraryService;
  store?: DownloadStore;
  resolver?: DownloadResolver;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  storageEstimate?: () => Promise<{ usage?: number; quota?: number }>;
  chunkSizeBytes?: number;
}

export interface EnqueueMeta {
  title: string;
  durationSeconds?: number | null;
  artistNames?: string[];
}

export interface ActiveDownload {
  songId: string;
  title: string;
  bytesDownloaded: number;
  totalBytes: number | null;
}

export interface ReconcileResult {
  jobsRequeued: number;
  missingCleared: number;
  orphansRemoved: number;
  stalePartsRemoved: number;
}

/** Parse total byte dari header Content-Range (`bytes a-b/total`). */
export function parseContentRangeTotal(header: string | null): number | null {
  if (!header) return null;
  const match = /^bytes \d+-\d+\/(\d+)$/.exec(header.trim());
  if (!match) return null;
  const total = Number(match[1]);
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
}

/** Parse Retry-After (detik), dibatasi 0..maks. */
export function parseRetryAfterSeconds(
  header: string | null,
  maxSeconds: number,
): number {
  if (!header) return Math.min(60, maxSeconds);
  const value = Number(header.trim());
  if (!Number.isFinite(value) || value < 0) return Math.min(60, maxSeconds);
  return Math.min(Math.ceil(value), maxSeconds);
}

/**
 * Baca body respons dengan watchdog macet + cap ukuran. Tanpa
 * byte baru selama `stallMs`, pembacaan dibatalkan (Retryable).
 * Melewati cap berarti TooBig. Dipakai `fetchRangeViaProxy`.
 */
export async function readBodyWithWatchdog(
  body: ReadableStream<Uint8Array> | null,
  opts: { capBytes: number; stallMs: number; signal: AbortSignal },
): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const armStall = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      // `cancel()` menyelesaikan read() yang tertunda sebagai
      // done:true (bukan reject) — tanpa flag ini, body yang
      // macet diam-diam diterima sebagai potongan utuh.
      stalled = true;
      void reader.cancel(new RetryableError('Unduhan macet'));
    }, opts.stallMs);
    // Di Node, timer tidak boleh menahan proses tes selesai.
    if (typeof (timer as unknown as { unref?: unknown }).unref === 'function') {
      (timer as unknown as { unref: () => void }).unref();
    }
  };
  try {
    armStall();
    for (;;) {
      if (opts.signal.aborted) throw new DownloadAbortedError();
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        total += value.length;
        if (total > opts.capBytes) {
          await reader.cancel(new TooBigError());
          throw new TooBigError();
        }
        chunks.push(value);
        armStall();
      }
    }
    if (stalled) throw new RetryableError('Unduhan macet');
  } finally {
    if (timer) clearTimeout(timer);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function combineSignal(
  signal: AbortSignal,
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  const anyFn = (
    AbortSignal as unknown as {
      any?: (signals: AbortSignal[]) => AbortSignal;
    }
  ).any;
  if (typeof anyFn === 'function') return anyFn([signal, timeout]);
  return signal.aborted ? signal : timeout;
}

/**
 * Satu request Range lewat proxy `/api/media`. Menangani 429
 * sendiri (tunggu Retry-After, maks 3 kali tunggu). URL tujuan
 * divalidasi allowlist SEBELUM dikirim ke proxy (pertahanan
 * lapis kedua; resolver sudah memvalidasi).
 */
export async function fetchRangeViaProxy(
  streamUrl: string,
  start: number,
  end: number,
  signal: AbortSignal,
  deps: {
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    maxFileBytes?: number;
  } = {},
): Promise<RangeResult> {
  if (!isAllowedStreamUrl(streamUrl)) {
    throw new UrlExpiredError('URL stream tidak lolos allowlist');
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxFileBytes = deps.maxFileBytes ?? DOWNLOAD_MAX_FILE_BYTES;
  const proxyUrl = `${PROXY_BASE_URL}/api/media?u=${encodeURIComponent(streamUrl)}`;

  let waits = 0;
  for (;;) {
    if (signal.aborted) throw new DownloadAbortedError();
    let res: Response;
    try {
      res = await fetchImpl(proxyUrl, {
        method: 'GET',
        headers: { Range: `bytes=${start}-${end}` },
        signal: combineSignal(signal, DOWNLOAD_CHUNK_TIMEOUT_MS),
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === 'AbortError' || error.name === 'TimeoutError')
      ) {
        if (signal.aborted) throw new DownloadAbortedError();
        throw new RetryableError('Request chunk melewati batas waktu');
      }
      throw new RetryableError(
        error instanceof Error ? error.message : 'Jaringan gagal',
      );
    }
    if (res.status === 429) {
      if (waits >= 3) {
        throw new RetryableError('Terlalu banyak unduhan, coba lagi nanti');
      }
      waits += 1;
      const waitSeconds = parseRetryAfterSeconds(
        res.headers.get('Retry-After'),
        DOWNLOAD_MAX_RETRY_AFTER_SECONDS,
      );
      await sleep(waitSeconds * 1000);
      continue;
    }
    if (res.status === 403 || res.status === 404 || res.status === 410) {
      throw new UrlExpiredError(`URL stream mati (HTTP ${res.status})`);
    }
    if (res.status !== 200 && res.status !== 206) {
      throw new RetryableError(`Proxy membalas HTTP ${res.status}`);
    }
    const bytes = await readBodyWithWatchdog(res.body, {
      capBytes: maxFileBytes,
      stallMs: DOWNLOAD_STALL_TIMEOUT_MS,
      signal,
    });
    const total =
      res.status === 206
        ? parseContentRangeTotal(res.headers.get('Content-Range'))
        : (() => {
            const len = res.headers.get('Content-Length');
            const n = len === null ? NaN : Number(len);
            return Number.isSafeInteger(n) && n >= 0 ? n : bytes.length;
          })();
    return {
      status: res.status,
      totalBytes: total,
      contentType: res.headers.get('Content-Type'),
      bytes,
    };
  }
}

/**
 * Rekonsiliasi Dexie vs Cache Storage (dijalankan saat start).
 * - Job berstatus mengunduh kembali ke antrean.
 * - Lagu yang diklaim terunduh tetapi filenya hilang dibersihkan
 *   statusnya (lagu tetap di Library).
 * - File cache tanpa baris unduhan di Dexie dihapus (yatim).
 * - Part tanpa job apa pun dihapus.
 */
export async function reconcileDownloads(deps: {
  library: LibraryService;
  store: DownloadStore;
}): Promise<ReconcileResult> {
  const { library, store } = deps;
  const jobsRequeued = await library.resetRunningJobsToQueued();

  const downloaded = await library.downloadedFiles();
  const downloadedIds = new Set(downloaded.map((f) => f.songId));
  const cacheIds = await store.listDownloads();
  const cacheIdSet = new Set(cacheIds);

  let missingCleared = 0;
  for (const file of downloaded) {
    if (!cacheIdSet.has(file.songId)) {
      await library.clearDownloadState(file.songId);
      missingCleared += 1;
    }
  }
  let orphansRemoved = 0;
  for (const id of cacheIds) {
    if (!downloadedIds.has(id)) {
      await store.deleteDownload(id);
      orphansRemoved += 1;
    }
  }

  const jobs = await library.downloadJobs();
  const jobIds = new Set(jobs.map((j) => j.songId));
  const parts = await store.listAllParts();
  const staleOwners: string[] = [];
  for (const videoId of parts.keys()) {
    if (!jobIds.has(videoId) && !downloadedIds.has(videoId)) {
      staleOwners.push(videoId);
    }
  }
  const stalePartsRemoved = await store.deletePartsFor(staleOwners);

  return { jobsRequeued, missingCleared, orphansRemoved, stalePartsRemoved };
}

/** Statistik ruang: unduhan (Dexie) + pemakaian origin (estimate). */
export async function getDownloadStorageStats(deps: {
  library: LibraryService;
  storageEstimate?: () => Promise<{ usage?: number; quota?: number }>;
}): Promise<{
  downloadCount: number;
  downloadBytes: number;
  usageBytes: number | null;
  quotaBytes: number | null;
}> {
  const stats = await deps.library.storageStats();
  let usageBytes: number | null = null;
  let quotaBytes: number | null = null;
  const estimateFn =
    deps.storageEstimate ??
    (typeof navigator !== 'undefined' &&
    navigator.storage &&
    typeof navigator.storage.estimate === 'function'
      ? () => navigator.storage.estimate()
      : null);
  if (estimateFn) {
    try {
      const estimate = await estimateFn();
      usageBytes =
        typeof estimate.usage === 'number' ? estimate.usage : null;
      quotaBytes =
        typeof estimate.quota === 'number' ? estimate.quota : null;
    } catch {
      // estimate() gagal: statistik unduhan tetap tampil.
    }
  }
  return {
    downloadCount: stats.downloadCount,
    downloadBytes: stats.downloadBytes,
    usageBytes,
    quotaBytes,
  };
}

/** Pesan galat unduhan untuk pengguna (tanpa URL, tanpa jargon). */
export function downloadErrorMessage(error: unknown): string {
  if (error instanceof TooBigError) {
    return 'Lagu ini terlalu besar untuk diunduh.';
  }
  if (error instanceof UrlExpiredError) {
    return 'Lagu tidak bisa ditemukan. Coba lagi nanti.';
  }
  if (error instanceof DownloadAbortedError) {
    return 'Unduhan dibatalkan.';
  }
  return 'Unduhan gagal. Periksa koneksi internet kamu, lalu coba lagi.';
}

const SPACE_ERROR_MESSAGE = 'Ruang di perangkat tidak cukup untuk lagu ini.';

export class DownloadManager {
  private library: LibraryService;
  private store: DownloadStore;
  private resolver: DownloadResolver;
  private fetchImpl: typeof fetch;
  private sleepFn: (ms: number) => Promise<void>;
  private storageEstimate?: () => Promise<{ usage?: number; quota?: number }>;
  private chunkSizeBytes: number;
  private pumping = false;
  private pumpQueued = false;
  private started = false;
  private active: ActiveDownload | null = null;
  private activeAbort: AbortController | null = null;
  private activeSongId: string | null = null;
  private resolverReady: Promise<unknown> | null = null;

  constructor(deps: DownloadManagerDeps) {
    this.library = deps.library;
    this.store = deps.store ?? getDownloadStore();
    this.resolver = deps.resolver ?? new StreamResolver();
    this.fetchImpl =
      deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.sleepFn =
      deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    this.storageEstimate = deps.storageEstimate;
    this.chunkSizeBytes = deps.chunkSizeBytes ?? DOWNLOAD_CHUNK_BYTES;
  }

  /** Kait tes: ubah ukuran chunk (E2E memakai chunk kecil). */
  setChunkSizeForTest(bytes: number): void {
    this.chunkSizeBytes = bytes;
  }

  /** Unduhan yang sedang berjalan (untuk UI/debug), atau null. */
  getActive(): ActiveDownload | null {
    return this.active ? { ...this.active } : null;
  }

  /**
   * Start saat app dibuka: rekonsiliasi lalu lanjutkan antrean.
   * Idempotent (StrictMode memanggil efek dua kali di dev).
   */
  async init(): Promise<ReconcileResult | null> {
    if (this.started) return null;
    this.started = true;
    let result: ReconcileResult;
    try {
      result = await reconcileDownloads({
        library: this.library,
        store: this.store,
      });
    } catch {
      // Rekonsiliasi gagal (IndexedDB/Cache bermasalah): antrean
      // tetap dicoba; kegagalan per job ditangani di pump.
      result = {
        jobsRequeued: 0,
        missingCleared: 0,
        orphansRemoved: 0,
        stalePartsRemoved: 0,
      };
    }
    this.kickPump();
    return result;
  }

  /** Masukkan lagu ke antrean unduhan (atau kembalikan bila sudah ada). */
  async enqueue(
    songId: string,
    quality: DownloadQuality,
    meta: EnqueueMeta,
  ): Promise<'queued' | 'already-downloaded' | 'already-queued'> {
    const existing = await this.library.downloadJobBySongId(songId);
    if (existing) {
      const status = existing.status;
      if (
        status === DownloadJobStatus.queued ||
        status === DownloadJobStatus.running
      ) {
        return 'already-queued';
      }
    }
    if (await this.library.isDownloaded(songId)) {
      return 'already-downloaded';
    }
    const song = await this.library.songById(songId);
    if (!song) {
      await this.library.upsertSong(
        {
          id: songId,
          title: meta.title,
          albumId: null,
          durationSeconds: meta.durationSeconds ?? null,
          thumbnailUrl: null,
          liked: 0,
          totalPlayTimeMs: 0,
          inLibrary: 0,
          downloadState: DownloadState.notDownloaded,
          filePath: null,
          fileSizeBytes: null,
          downloadedAt: null,
          formatId: null,
          unplayable: 0,
        },
        { artistNames: meta.artistNames ?? [], addToLibrary: false },
      );
    }
    await this.library.upsertDownloadJob({
      songId,
      status: DownloadJobStatus.queued,
      quality: QUALITY_ITAG_PREFERENCE[quality][0],
      bytesDownloaded: 0,
      totalBytes: null,
      attempts: 0,
      errorMessage: null,
      createdAt: Date.now(),
    });
    await this.library.setDownloadState(songId, DownloadState.downloading);
    this.kickPump();
    return 'queued';
  }

  /** Batalkan unduhan (berjalan atau antre): hapus job + part. */
  async cancel(songId: string): Promise<void> {
    if (this.activeSongId === songId && this.activeAbort) {
      this.activeAbort.abort();
    }
    await this.store.deleteParts(songId);
    await this.library.deleteDownloadJob(songId);
    const song = await this.library.songById(songId);
    if (song && song.song.downloadState === DownloadState.downloading) {
      await this.library.setDownloadState(
        songId,
        DownloadState.notDownloaded,
      );
    }
  }

  /** Coba lagi job yang gagal (part lama dipakai untuk resume). */
  async retry(songId: string): Promise<void> {
    const job = await this.library.downloadJobBySongId(songId);
    if (!job || job.status !== DownloadJobStatus.failed) return;
    await this.library.updateDownloadJob(songId, {
      status: DownloadJobStatus.queued,
      errorMessage: null,
    });
    await this.library.setDownloadState(songId, DownloadState.downloading);
    this.kickPump();
  }

  /** Hapus satu unduhan: file cache + part + status + job. */
  async deleteDownload(songId: string): Promise<void> {
    await this.cancel(songId);
    await this.store.deleteDownload(songId);
    await this.library.clearDownloadState(songId);
  }

  /** Hapus SEMUA unduhan + semua job + semua part. */
  async deleteAllDownloads(): Promise<number> {
    const downloaded = await this.library.downloadedFiles();
    const jobs = await this.library.downloadJobs();
    if (this.activeAbort) this.activeAbort.abort();
    let removed = 0;
    for (const file of downloaded) {
      await this.store.deleteDownload(file.songId);
      await this.library.clearDownloadState(file.songId);
      removed += 1;
    }
    for (const job of jobs) {
      await this.store.deleteParts(job.songId);
      await this.library.deleteDownloadJob(job.songId);
    }
    // Part yatim tanpa job maupun file juga dibersihkan.
    const parts = await this.store.listAllParts();
    await this.store.deletePartsFor(parts.keys());
    return removed;
  }

  // ---------- Pompa antrean (serial, 1 file) ----------

  private kickPump(): void {
    if (this.pumping) {
      this.pumpQueued = true;
      return;
    }
    void this.pump();
  }

  /** Pompa antrean sampai kosong (dipanggil tes secara langsung). */
  async pump(): Promise<void> {
    if (this.pumping) {
      this.pumpQueued = true;
      return;
    }
    this.pumping = true;
    try {
      for (;;) {
        const jobs = await this.library.downloadJobs();
        const next = jobs.find(
          (j) => j.status === DownloadJobStatus.queued,
        );
        if (!next) break;
        await this.runJob(next.songId);
      }
    } finally {
      this.pumping = false;
      if (this.pumpQueued) {
        this.pumpQueued = false;
        void this.pump();
      }
    }
  }

  private async ensureResolver(): Promise<void> {
    if (!this.resolverReady) {
      this.resolverReady = this.resolver.init().catch(() => undefined);
    }
    await this.resolverReady;
  }

  /**
   * Byte awal resume: prefix part berurutan dari indeks 0.
   * Yang penting hanya prefix KONTIGU dari byte 0 — panjang
   * tiap part boleh apa pun (ukuran chunk bisa berbeda antar
   * sesi, mis. chunk kecil di tes lalu chunk normal sesudah
   * navigasi); part baru diberi indeks berurutan dari
   * partCount, bukan dari offset / ukuran chunk, supaya tidak
   * pernah menimpa part lama.
   */
  private async resumeOffset(
    songId: string,
  ): Promise<{ startByte: number; partCount: number }> {
    const indexes = await this.store.listPartIndexes(songId);
    let startByte = 0;
    let partCount = 0;
    for (let i = 0; i < indexes.length; i += 1) {
      if (indexes[i] !== i) break;
      const part = await this.store.getPart(songId, i);
      if (!part) break;
      startByte += part.length;
      partCount += 1;
    }
    return { startByte, partCount };
  }

  private async runJob(songId: string): Promise<void> {
    const job = await this.library.downloadJobBySongId(songId);
    const song = await this.library.songById(songId);
    if (!job || !song) return;
    const quality = qualityFromItag(job.quality);
    const preference = QUALITY_ITAG_PREFERENCE[quality];
    const abort = new AbortController();
    this.activeAbort = abort;
    this.activeSongId = songId;
    this.active = {
      songId,
      title: song.song.title,
      bytesDownloaded: 0,
      totalBytes: null,
    };
    try {
      await this.library.updateDownloadJob(songId, {
        status: DownloadJobStatus.running,
        attempts: job.attempts + 1,
        errorMessage: null,
      });
      await this.ensureResolver();
      if (abort.signal.aborted) return;
      const resolved = await this.resolver.resolve(
        { videoId: songId, title: song.song.title },
        { itagPreference: preference },
      );
      if (abort.signal.aborted) return;
      // Pemeriksaan ruang sebelum byte pertama diunduh.
      const estimateBytes =
        resolved.bitrate != null && song.song.durationSeconds != null
          ? Math.round((resolved.bitrate / 8) * song.song.durationSeconds)
          : null;
      if (estimateBytes !== null) {
        const hasRoom = await this.hasRoomFor(estimateBytes);
        if (!hasRoom) {
          await this.failJob(songId, SPACE_ERROR_MESSAGE);
          return;
        }
      }
      const { startByte, partCount: keptParts } =
        await this.resumeOffset(songId);
      const fetchRange: FetchRange = (url, start, end, signal) =>
        fetchRangeViaProxy(url, start, end, signal, {
          fetchImpl: this.fetchImpl,
          sleep: this.sleepFn,
        });
      // Indeks part baru dihitung BERURUTAN dari part lama
      // (bukan offset / ukuran chunk): bila ukuran chunk
      // berubah antar sesi, rumus offset menimpa part lama
      // dan rakitan gagal cocok ukurannya (P5, 18 Nov).
      let nextPartIndex = keptParts;
      const result = await downloadChunked({
        streamUrl: resolved.url,
        startByte,
        chunkSizeBytes: this.chunkSizeBytes,
        fetchRange,
        reResolve: async () => {
          const fresh = await this.resolver.resolve(
            { videoId: songId, title: song.song.title },
            { itagPreference: preference },
          );
          return fresh.url;
        },
        onChunk: async (bytes, offset) => {
          const index = nextPartIndex;
          nextPartIndex += 1;
          await this.store.putPart(songId, index, bytes);
          await this.library.updateDownloadJob(songId, {
            bytesDownloaded: offset + bytes.length,
          });
          if (this.active && this.activeSongId === songId) {
            this.active.bytesDownloaded = offset + bytes.length;
          }
        },
        onProgress: (downloaded, total) => {
          if (this.active && this.activeSongId === songId) {
            this.active.bytesDownloaded = downloaded;
            this.active.totalBytes = total;
          }
          if (total !== null) {
            void this.library.updateDownloadJob(songId, {
              totalBytes: total,
            });
          }
        },
        signal: abort.signal,
        sleep: this.sleepFn,
      });
      if (abort.signal.aborted) return;
      // Rakit part menjadi satu file; ukuran WAJIB cocok.
      // Jumlah part = part lama yang dipertahankan + chunk
      // yang diunduh panggilan ini (bukan ceil(total/chunk):
      // bila ukuran chunk berubah antar sesi, rumus ceil salah).
      const partCount = keptParts + result.chunksDownloaded;
      const parts: BlobPart[] = [];
      let assembled = 0;
      for (let i = 0; i < partCount; i += 1) {
        const part = await this.store.getPart(songId, i);
        if (!part) throw new RetryableError('Part unduhan hilang saat rakit');
        parts.push(part as BlobPart);
        assembled += part.length;
      }
      if (assembled !== result.totalBytes) {
        throw new RetryableError('Ukuran rakitan tidak cocok');
      }
      const blob = new Blob(parts, {
        type: result.contentType ?? 'application/octet-stream',
      });
      await this.store.putDownload(
        songId,
        blob,
        result.contentType ?? 'application/octet-stream',
      );
      await this.store.deleteParts(songId);
      await this.library.markDownloaded({
        songId,
        filePath: downloadUrl(songId),
        fileSizeBytes: result.totalBytes,
        formatId: String(resolved.itag),
      });
      await this.library.deleteDownloadJob(songId);
    } catch (error) {
      if (
        error instanceof DownloadAbortedError ||
        abort.signal.aborted
      ) {
        // Dibatalkan pengguna: cancel() sudah membersihkan.
        return;
      }
      await this.failJob(songId, downloadErrorMessage(error));
    } finally {
      if (this.activeSongId === songId) {
        this.active = null;
        this.activeSongId = null;
        this.activeAbort = null;
      }
    }
  }

  private async failJob(songId: string, message: string): Promise<void> {
    await this.library.updateDownloadJob(songId, {
      status: DownloadJobStatus.failed,
      errorMessage: message,
    });
    await this.library.setDownloadState(songId, DownloadState.notDownloaded);
  }

  /** Cek ruang: pemakaian + perkiraan + 100 MB headroom < kuota. */
  private async hasRoomFor(estimateBytes: number): Promise<boolean> {
    const estimateFn =
      this.storageEstimate ??
      (typeof navigator !== 'undefined' &&
      navigator.storage &&
      typeof navigator.storage.estimate === 'function'
        ? () => navigator.storage.estimate()
        : null);
    if (!estimateFn) return true;
    try {
      const estimate = await estimateFn();
      if (
        typeof estimate.quota !== 'number' ||
        typeof estimate.usage !== 'number'
      ) {
        return true;
      }
      return (
        estimate.usage + estimateBytes + DOWNLOAD_SPACE_HEADROOM_BYTES <
        estimate.quota
      );
    } catch {
      return true;
    }
  }
}

let sharedManager: DownloadManager | null = null;
let sharedManagerOpen: Promise<DownloadManager> | null = null;

/**
 * Manajer bersama (satu instance per halaman; pemanggilan
 * bersamaan berbagi satu promise pembuatan supaya tidak pernah
 * ada dua manajer yang memompa antrean paralel).
 */
export function getDownloadManager(
  library?: LibraryService,
): Promise<DownloadManager> {
  if (sharedManager) return Promise.resolve(sharedManager);
  if (!sharedManagerOpen) {
    sharedManagerOpen = (async () => {
      if (!library) {
        const { getLibraryService } = await import('../data/library');
        library = await getLibraryService();
      }
      sharedManager = new DownloadManager({ library });
      return sharedManager;
    })().catch((error: unknown) => {
      sharedManagerOpen = null;
      throw error;
    });
  }
  return sharedManagerOpen;
}

/** Buang manajer bersama (dipakai tes). */
export function resetDownloadManager(): void {
  sharedManager = null;
  sharedManagerOpen = null;
}
