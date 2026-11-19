/**
 * Klien baca cache resolve (P3).
 *
 * Saat jendela YouTube terbuka sesaat, populator koordinator
 * menyimpan URL stream lagu kanari + populer di D1 (migrasi 0008,
 * endpoint GET /api/resolve-cache di worker proxy). Modul ini
 * membaca entri itu — dipakai StreamResolver sebagai cadangan
 * sesudah resolve langsung gagal.
 *
 * Aturan yang mengikat:
 * - Entri kedaluwarsa TIDAK PERNAH dipakai: worker sudah
 *   memfilter di SQL, dan parse di sini memeriksa lagi dengan
 *   margin aman (URL yang tinggal < 60 detik dianggap basi —
 *   lagu bisa terputus di tengah jalan bila URL mati saat
 *   diputar). Pertahanan berlapis, bukan percaya satu sisi.
 * - URL WAJIB lolos allowlist stream yang sama dengan resolve
 *   langsung (hanya *.googlevideo.com https).
 * - Modul ini tidak pernah melempar: cache adalah best-effort.
 *   Kegagalan jaringan, 404, atau balasan aneh semuanya berarti
 *   "tidak ada simpanan" (null) — pemanggil lanjut ke fallback
 *   berikutnya (pemutar YouTube) atau menampilkan galat.
 * - URL stream TIDAK PERNAH dicetak ke log (aturan PRD B2.1).
 */
import { isAllowedStreamUrl } from '../solver/urlAllowlist';
import { PROXY_BASE_URL } from '../spike/config';

/** Margin aman kedaluwarsa: URL yang tinggal segini dianggap basi. */
export const RESOLVE_CACHE_SAFETY_MS = 60 * 1000;

/** Batas waktu baca cache (milidetik): satu query D1, harus cepat. */
export const RESOLVE_CACHE_TIMEOUT_MS = 10 * 1000;

/** Entri cache yang sudah divalidasi dan siap dipakai. */
export interface CachedStream {
  videoId: string;
  title: string;
  /** URL stream langsung. Hanya ada di memori, jangan dicetak. */
  url: string;
  itag: number;
  bitrate: number | null;
  client: string;
  /** Batas berlaku URL (epoch milidetik). */
  expiresAtMs: number;
  /** Waktu resolve asal (epoch milidetik). */
  resolvedAtMs: number;
}

/**
 * Parse + validasi balasan GET /api/resolve-cache. Mengembalikan
 * null bila bentuknya salah, URL tidak lolos allowlist, atau
 * entri sudah kedaluwarsa (dengan margin aman). `nowMs` bisa
 * diinjeksi supaya tes tidak bergantung pada jam sungguhan.
 */
export function parseCachedStream(
  json: unknown,
  nowMs: number = Date.now(),
): CachedStream | null {
  if (typeof json !== 'object' || json === null) return null;
  const root = json as Record<string, unknown>;
  if (root.success !== true) return null;
  const data = root.data as Record<string, unknown> | undefined;
  if (typeof data !== 'object' || data === null) return null;
  const videoId = data.videoId;
  const streamUrl = data.streamUrl;
  const itag = data.itag;
  const bitrate = data.bitrate;
  const client = data.client;
  const title = data.title;
  const expiresAt = data.expiresAt;
  const resolvedAt = data.resolvedAt;
  if (typeof videoId !== 'string' || videoId.length === 0) return null;
  if (typeof streamUrl !== 'string' || !isAllowedStreamUrl(streamUrl)) {
    return null;
  }
  if (typeof itag !== 'number' || !Number.isInteger(itag)) return null;
  if (
    bitrate !== null &&
    bitrate !== undefined &&
    (typeof bitrate !== 'number' || !Number.isInteger(bitrate))
  ) {
    return null;
  }
  if (typeof client !== 'string' || client.length === 0) return null;
  if (typeof title !== 'string') return null;
  if (typeof expiresAt !== 'number' || typeof resolvedAt !== 'number') {
    return null;
  }
  const expiresAtMs = expiresAt * 1000;
  if (!Number.isFinite(expiresAtMs)) return null;
  // Kedaluwarsa (+ margin aman): jangan pernah memutar URL basi.
  if (expiresAtMs - nowMs <= RESOLVE_CACHE_SAFETY_MS) return null;
  return {
    videoId,
    title,
    url: streamUrl,
    itag,
    bitrate: typeof bitrate === 'number' ? bitrate : null,
    client,
    expiresAtMs,
    resolvedAtMs: resolvedAt * 1000,
  };
}

/**
 * Ambil entri cache untuk satu lagu. Mengembalikan null bila
 * tidak ada simpanan, entri basi, atau terjadi galat apa pun
 * (jaringan, timeout, balasan aneh). Tidak pernah melempar.
 */
export async function fetchCachedStream(
  videoId: string,
  opts: {
    fetchImpl?: typeof fetch;
    nowMs?: number;
    baseUrl?: string;
    timeoutMs?: number;
  } = {},
): Promise<CachedStream | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl ?? PROXY_BASE_URL;
  const timeoutMs = opts.timeoutMs ?? RESOLVE_CACHE_TIMEOUT_MS;
  let res: Response;
  try {
    res = await fetchImpl(
      `${baseUrl}/api/resolve-cache?videoId=${encodeURIComponent(videoId)}`,
      {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let json: unknown;
  try {
    json = (await res.json()) as unknown;
  } catch {
    return null;
  }
  return parseCachedStream(json, opts.nowMs ?? Date.now());
}
