/**
 * Klien lirik LRCLIB + fallback lyrics.ovh (P7, spike S10).
 *
 * Jalur utama `/api/get` (cocok persis artis + judul + durasi;
 * median 17.754 byte, sekitar 13x lebih kecil dari `/api/search`),
 * fallback `/api/search` (pilih durasi cocok plus minus 2 detik),
 * fallback kedua lyrics.ovh (lirik polos, tanpa sinkron).
 *
 * Batas laju resmi LRCLIB (dokumentasi, terverifikasi S10):
 * generik sekitar 45/menit, teridentifikasi sekitar 90/menit,
 * terdaftar sekitar 180/menit. Browser tidak bisa menyetel
 * `User-Agent`, jadi app mengirim `X-User-Agent` dan
 * `Lrclib-Client` (alternatif resmi untuk JavaScript browser).
 * Respons 429 dihormati lewat header `Retry-After` + jitter
 * sampai 30 persen, lalu satu kali coba ulang.
 *
 * Semua fetch punya timeout eksplisit 30 detik dan cap respons
 * 1 MB (arsitektur §6.1). Tidak ada pengenal pengguna atau
 * perangkat di request, hanya judul lagu (PRD B5.2).
 */
import { readCappedText, ResponseTooBigError } from '../extractor/readCapped';

export const LRCLIB_BASE_URL = 'https://lrclib.net';
export const LYRICS_OVH_BASE_URL = 'https://api.lyrics.ovh';
/** Pengenal client LRCLIB (bukan secret, aman dikirim browser). */
export const LRCLIB_CLIENT_ID =
  'LarasWeb/1.0 (+https://github.com/adiprmx/laras-web)';

export const LYRICS_FETCH_TIMEOUT_MS = 30000;
/** Cap respons lirik 1 MB (arsitektur §6.1). */
export const LYRICS_MAX_BYTES = 1024 * 1024;
/** Toleransi cocok durasi di hasil /api/search (detik). */
export const SEARCH_DURATION_TOLERANCE_SECONDS = 2;
/** Batas atas tunggu Retry-After (detik). */
export const MAX_RETRY_AFTER_SECONDS = 60;

export interface LyricsQuery {
  artist: string;
  title: string;
  /** Durasi detik, bila diketahui (membantu cocok persis). */
  durationSeconds?: number;
}

export type LyricsFetchResult =
  | {
      status: 'ok';
      syncedLyrics: string | null;
      plainLyrics: string;
      source: 'lrclib' | 'ovh';
    }
  | { status: 'not-found' }
  | { status: 'rate-limited'; retryAfterSeconds: number }
  | { status: 'error' };

interface LrclibRecord {
  syncedLyrics?: string | null;
  plainLyrics?: string | null;
  duration?: number | null;
  instrumental?: boolean | null;
}

export interface LyricsFetchDeps {
  fetchFn?: typeof fetch;
  /** Tidur yang bisa di-injeksi supaya tes tidak menunggu. */
  sleep?: (ms: number) => Promise<void>;
  /** Acak 0..1 untuk jitter (di-injeksi supaya tes deterministik). */
  random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function clientHeaders(): Record<string, string> {
  return {
    'X-User-Agent': LRCLIB_CLIENT_ID,
    'Lrclib-Client': LRCLIB_CLIENT_ID,
  };
}

function retryAfterSeconds(res: Response): number {
  const raw = Number(res.headers.get('Retry-After') || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return Math.min(raw, MAX_RETRY_AFTER_SECONDS);
}

/** Pilih rekaman terbaik dari hasil /api/search. */
export function pickSearchResult(
  records: LrclibRecord[],
  durationSeconds?: number,
): LrclibRecord | null {
  if (records.length === 0) return null;
  if (durationSeconds !== undefined) {
    const byDuration = records.find(
      (r) =>
        r.duration !== undefined &&
        r.duration !== null &&
        Math.abs(r.duration - durationSeconds) <=
          SEARCH_DURATION_TOLERANCE_SECONDS &&
        (r.syncedLyrics || r.plainLyrics),
    );
    if (byDuration) return byDuration;
  }
  const synced = records.find((r) => r.syncedLyrics);
  if (synced) return synced;
  const plain = records.find((r) => r.plainLyrics);
  if (plain) return plain;
  return null;
}

function recordToResult(
  record: LrclibRecord,
): LyricsFetchResult {
  // I13: /api/get bisa mengembalikan JSON literal null (HTTP 200);
  // tanpa cek ini, `record.instrumental` melempar TypeError.
  if (typeof record !== 'object' || record === null) {
    return { status: 'not-found' };
  }
  if (record.instrumental) return { status: 'not-found' };
  const plain = record.plainLyrics?.trim() ?? '';
  const synced = record.syncedLyrics?.trim() || null;
  if (!plain && !synced) return { status: 'not-found' };
  return {
    status: 'ok',
    syncedLyrics: synced,
    // Bila hanya ada lirik tersinkron, teks polos diturunkan dari
    // baris-barisnya supaya tampilan polos tetap punya isi.
    plainLyrics: plain || stripLrcTags(synced ?? ''),
    source: 'lrclib',
  };
}

/** Ambil teks baris dari LRC (buang penanda waktu). */
function stripLrcTags(synced: string): string {
  return synced
    .split(/\r?\n/)
    .map((line) => line.replace(/\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/g, '').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/**
 * Ambil lirik dari jaringan (tanpa cache; cache ada di
 * lyricsService). Urutan: /api/get, /api/search, lyrics.ovh.
 */
export async function fetchLyricsFromNetwork(
  query: LyricsQuery,
  deps: LyricsFetchDeps = {},
): Promise<LyricsFetchResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;

  const getParams = new URLSearchParams({
    artist_name: query.artist,
    track_name: query.title,
  });
  if (query.durationSeconds !== undefined) {
    getParams.set('duration', String(Math.round(query.durationSeconds)));
  }

  // Jalur 1: /api/get (cocok persis). 429 dihormati sekali.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let res: Response;
    try {
      res = await fetchFn(`${LRCLIB_BASE_URL}/api/get?${getParams}`, {
        headers: clientHeaders(),
        signal: AbortSignal.timeout(LYRICS_FETCH_TIMEOUT_MS),
      });
    } catch {
      return { status: 'error' };
    }
    if (res.status === 429) {
      const waitSeconds = retryAfterSeconds(res);
      if (attempt === 0) {
        const jitter = 1 + random() * 0.3;
        await sleep(waitSeconds * 1000 * jitter);
        continue;
      }
      return { status: 'rate-limited', retryAfterSeconds: waitSeconds };
    }
    if (res.status === 404) break;
    if (!res.ok) return { status: 'error' };
    let record: LrclibRecord;
    try {
      record = JSON.parse(
        await readCappedText(res, LYRICS_MAX_BYTES),
      ) as LrclibRecord;
    } catch (error) {
      if (error instanceof ResponseTooBigError) return { status: 'error' };
      return { status: 'error' };
    }
    return recordToResult(record);
  }

  // Jalur 2: /api/search (cari bebas, pilih durasi cocok).
  const searchParams = new URLSearchParams({
    artist_name: query.artist,
    track_name: query.title,
  });
  try {
    const res = await fetchFn(
      `${LRCLIB_BASE_URL}/api/search?${searchParams}`,
      {
        headers: clientHeaders(),
        signal: AbortSignal.timeout(LYRICS_FETCH_TIMEOUT_MS),
      },
    );
    if (res.status === 429) {
      return {
        status: 'rate-limited',
        retryAfterSeconds: retryAfterSeconds(res),
      };
    }
    if (res.ok) {
      const records = JSON.parse(
        await readCappedText(res, LYRICS_MAX_BYTES),
      ) as LrclibRecord[];
      if (Array.isArray(records)) {
        const best = pickSearchResult(records, query.durationSeconds);
        if (best) return recordToResult(best);
      }
    }
  } catch {
    // Gagal search bukan akhir: fallback lyrics.ovh masih dicoba.
  }

  // Jalur 3: lyrics.ovh (lirik polos saja).
  try {
    const res = await fetchFn(
      `${LYRICS_OVH_BASE_URL}/v1/${encodeURIComponent(query.artist)}/${encodeURIComponent(query.title)}`,
      { signal: AbortSignal.timeout(LYRICS_FETCH_TIMEOUT_MS) },
    );
    if (!res.ok) return { status: 'not-found' };
    const body = JSON.parse(
      await readCappedText(res, LYRICS_MAX_BYTES),
    ) as { lyrics?: string };
    const plain = body.lyrics?.trim() ?? '';
    if (!plain) return { status: 'not-found' };
    return {
      status: 'ok',
      syncedLyrics: null,
      plainLyrics: plain,
      source: 'ovh',
    };
  } catch {
    return { status: 'error' };
  }
}
