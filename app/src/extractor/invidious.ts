/**
 * Klien baca stream via Invidious publik (cadangan TERAKHIR).
 *
 * Alasan tercatat (aturan 1 Juta Cara: API pihak ketiga hanya
 * sebagai jalur terakhir): instance tunggal tak dikenal
 * (yt.chocolatemoo53.com), ekosistem Invidious publik tipis
 * (1 dari 10 entri daftar resmi yang `api: true` + sehat),
 * operator tidak dikenal, respons lambat (6-23 detik) dan
 * kemungkinan dari cache instance. Modul ini TIDAK PERNAH jadi
 * cadangan utama dan TIDAK PERNAH dicoba sebelum resolve
 * langsung + cache D1 gagal.
 *
 * Vonis yang mengizinkan wiring ini: re-probe Koordinator #9
 * (20 Nov 2026 01:22-01:24 WIB) BERSIH — 3/3 OK_AUDIO (5 format
 * audio, itag 139/140/249/250/251) dengan braket kontrol CF
 * sebelum+sesudah sama-sama ditolak; URL audio terverifikasi
 * mengalir (Range -> HTTP 206, audio/mp4); CORS terbuka
 * (Access-Control-Allow-Origin: * + preflight OPTIONS 204).
 * Vonis P4 sebelumnya (19 Nov 22:51-22:52 WIB) juga BERSIH.
 * Instance publik berganti status cepat — vonis ini wajib
 * diprobe ulang berkala; bila instance mati, modul ini hanya
 * mengembalikan null (best-effort, tanpa galat ke pengguna).
 *
 * Aturan yang mengikat (sama dengan cache D1):
 * - URL WAJIB lolos allowlist stream yang sama dengan resolve
 *   langsung (hanya *.googlevideo.com https).
 * - URL kedaluwarsa TIDAK PERNAH dipakai: param `expire` di URL
 *   wajib ada dan melewati margin aman 60 detik.
 * - Modul ini tidak pernah melempar: kegagalan jaringan,
 *   timeout, atau balasan aneh semuanya berarti null.
 * - URL stream TIDAK PERNAH dicetak ke log (aturan PRD B2.1).
 */
import { isAllowedStreamUrl } from '../solver/urlAllowlist';
import { ITAG_ORDER } from '../spike/config';
import {
  RESOLVE_CACHE_SAFETY_MS,
  type CachedStream,
} from './resolveCache';

/** Instance Invidious tunggal yang terverifikasi BERSIH. */
export const INVIDIOUS_INSTANCE_URL = 'https://yt.chocolatemoo53.com';

/**
 * Batas waktu baca Invidious (milidetik): respons terukur 6-23
 * detik, jadi batas cache (10 detik) terlalu pendek; 30 detik
 * memberi ruang tanpa menggantung resolve terlalu lama (batas
 * keseluruhan resolve di service adalah 90 detik).
 */
export const INVIDIOUS_TIMEOUT_MS = 30 * 1000;

/** Nama client yang dicatat untuk stream dari jalur ini. */
export const INVIDIOUS_CLIENT_NAME = 'INVIDIOUS';

interface InvidiousFormat {
  itag: string;
  type: string;
  bitrate: string;
  url: string;
}

function isAudioFormat(value: unknown): value is InvidiousFormat {
  if (typeof value !== 'object' || value === null) return false;
  const f = value as Record<string, unknown>;
  return (
    typeof f.itag === 'string' &&
    typeof f.type === 'string' &&
    f.type.startsWith('audio/') &&
    typeof f.bitrate === 'string' &&
    typeof f.url === 'string'
  );
}

/** Ambil param `expire` (epoch detik) dari URL googlevideo. */
function expireMsFromUrl(url: string): number | null {
  let expire: string | null = null;
  try {
    expire = new URL(url).searchParams.get('expire');
  } catch {
    return null;
  }
  if (expire === null) return null;
  const seconds = Number.parseInt(expire, 10);
  if (!Number.isInteger(seconds) || seconds <= 0) return null;
  const ms = seconds * 1000;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Parse + validasi balasan GET /api/v1/videos/{id}. Mengembalikan
 * null bila bentuknya salah, tidak ada format audio, URL tidak
 * lolos allowlist, atau URL kedaluwarsa (dengan margin aman).
 * Format dipilih mengikuti ITAG_ORDER kanonis (251 dulu).
 * `nowMs` bisa diinjeksi supaya tes tidak bergantung jam nyata.
 */
export function parseInvidiousStream(
  json: unknown,
  videoId: string,
  nowMs: number = Date.now(),
): CachedStream | null {
  if (typeof json !== 'object' || json === null) return null;
  const root = json as Record<string, unknown>;
  if ('error' in root) return null;
  const formats = root.adaptiveFormats;
  if (!Array.isArray(formats)) return null;
  const audio = formats.filter(isAudioFormat);
  if (audio.length === 0) return null;
  const title = typeof root.title === 'string' ? root.title : videoId;
  for (const wanted of ITAG_ORDER) {
    const found = audio.find((f) => {
      const itag = Number.parseInt(f.itag, 10);
      return Number.isInteger(itag) && itag === wanted;
    });
    if (!found) continue;
    if (!isAllowedStreamUrl(found.url)) continue;
    const expiresAtMs = expireMsFromUrl(found.url);
    if (expiresAtMs === null) continue;
    // Kedaluwarsa (+ margin aman): jangan pernah memutar URL basi.
    if (expiresAtMs - nowMs <= RESOLVE_CACHE_SAFETY_MS) continue;
    const itag = Number.parseInt(found.itag, 10);
    const bitrate = Number.parseInt(found.bitrate, 10);
    return {
      videoId,
      title,
      url: found.url,
      itag,
      bitrate: Number.isInteger(bitrate) ? bitrate : null,
      client: INVIDIOUS_CLIENT_NAME,
      expiresAtMs,
      resolvedAtMs: nowMs,
    };
  }
  return null;
}

/**
 * Ambil stream audio satu lagu dari Invidious. Mengembalikan null
 * bila instance tidak merespons, tidak ada format audio yang
 * valid, atau terjadi galat apa pun. Tidak pernah melempar.
 */
export async function fetchInvidiousStream(
  videoId: string,
  opts: {
    fetchImpl?: typeof fetch;
    nowMs?: number;
    baseUrl?: string;
    timeoutMs?: number;
  } = {},
): Promise<CachedStream | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl ?? INVIDIOUS_INSTANCE_URL;
  const timeoutMs = opts.timeoutMs ?? INVIDIOUS_TIMEOUT_MS;
  let res: Response;
  try {
    res = await fetchImpl(
      `${baseUrl}/api/v1/videos/${encodeURIComponent(videoId)}`,
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
  return parseInvidiousStream(json, videoId, opts.nowMs ?? Date.now());
}
