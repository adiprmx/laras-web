/**
 * Konstanta unduhan dan offline (P5).
 *
 * Nama cache dan jalur URL hidup di satu tempat supaya kode app,
 * Service Worker (`public/sw.js`), dan tes memakai nilai yang
 * sama. Service Worker tidak bisa mengimpor modul ini (file
 * statis di `public/`), jadi nilainya diduplikasi di sana dengan
 * komentar yang menunjuk ke file ini; tes `sw.test.ts` memaksa
 * kedua salinan tetap sama.
 */

/**
 * Cache unduhan eksplisit. Nama ini STABIL lintas build: unduhan
 * adalah data pengguna dan tidak boleh yatim hanya karena app
 * diperbarui. Naikkan hanya bila format penyimpanan berubah dan
 * migrasi ditulis.
 */
export const DOWNLOADS_CACHE_NAME = 'laras-downloads-v1';

/**
 * Cache runtime (cache streaming otomatis, pasca-P5). Dipisah
 * total dari cache unduhan supaya eviction LRU tidak pernah
 * menyentuh unduhan (K9).
 */
export const RUNTIME_CACHE_NAME = 'laras-runtime-v1';

/** Awalan nama cache shell (versi build ditempel di belakangnya). */
export const SHELL_CACHE_PREFIX = 'laras-shell-';

/**
 * Cache yang TIDAK PERNAH dihapus eviction maupun pembersihan
 * aktivasi Service Worker. Satu-satunya jalan menghapus isinya
 * adalah aksi hapus eksplisit pengguna.
 */
export function isProtectedCache(cacheName: string): boolean {
  return cacheName === DOWNLOADS_CACHE_NAME;
}

/**
 * Cache yang boleh dihapus saat aktivasi Service Worker bila
 * namanya bukan versi saat ini (shell lama, runtime lama).
 * Cache unduhan tidak pernah masuk daftar ini (K9).
 */
export function isDeletableOnActivate(
  cacheName: string,
  currentShellCache: string,
): boolean {
  if (isProtectedCache(cacheName)) return false;
  if (cacheName === currentShellCache) return false;
  if (cacheName === RUNTIME_CACHE_NAME) return false;
  return (
    cacheName.startsWith(SHELL_CACHE_PREFIX) ||
    cacheName.startsWith('laras-runtime-')
  );
}

/** Jalur URL same-origin tempat SW melayani file unduhan. */
export const DOWNLOAD_PATH_PREFIX = '/dl/';

/** Jalur URL part unduhan (internal, tidak pernah diminta audio). */
export const DOWNLOAD_PART_PATH_PREFIX = '/dl-part/';

/** URL file unduhan satu lagu (relatif terhadap origin app). */
export function downloadUrl(videoId: string): string {
  return `${DOWNLOAD_PATH_PREFIX}${encodeURIComponent(videoId)}`;
}

/** URL satu part unduhan (relatif terhadap origin app). */
export function downloadPartUrl(videoId: string, index: number): string {
  return `${DOWNLOAD_PART_PATH_PREFIX}${encodeURIComponent(videoId)}/${index}`;
}

/** Ambil videoId dari jalur `/dl/<videoId>`, atau null. */
export function videoIdFromDownloadPath(pathname: string): string | null {
  if (!pathname.startsWith(DOWNLOAD_PATH_PREFIX)) return null;
  const rest = pathname.slice(DOWNLOAD_PATH_PREFIX.length);
  if (rest === '' || rest.includes('/')) return null;
  try {
    return decodeURIComponent(rest);
  } catch {
    return null;
  }
}

/** Ambil videoId + indeks dari jalur `/dl-part/<videoId>/<index>`. */
export function partFromDownloadPartPath(pathname: string): {
  videoId: string;
  index: number;
} | null {
  if (!pathname.startsWith(DOWNLOAD_PART_PATH_PREFIX)) return null;
  const rest = pathname.slice(DOWNLOAD_PART_PATH_PREFIX.length);
  const slash = rest.lastIndexOf('/');
  if (slash <= 0) return null;
  const index = Number(rest.slice(slash + 1));
  if (!Number.isInteger(index) || index < 0) return null;
  try {
    return { videoId: decodeURIComponent(rest.slice(0, slash)), index };
  } catch {
    return null;
  }
}

/** Ukuran satu chunk unduhan: 1 MiB (dinding googlevideo, S2/S3). */
export const DOWNLOAD_CHUNK_BYTES = 1024 * 1024;

/** Percobaan ulang per chunk (di luar percobaan pertama). */
export const DOWNLOAD_MAX_CHUNK_RETRIES = 3;

/** Re-resolve URL stream bila URL mati di tengah unduhan. */
export const DOWNLOAD_MAX_RERESOLVES = 2;

/** Batas ukuran satu file unduhan: 100 MB (sama dengan cap proxy). */
export const DOWNLOAD_MAX_FILE_BYTES = 100 * 1024 * 1024;

/** Batas waktu satu request chunk: 120 detik (sama dengan proxy). */
export const DOWNLOAD_CHUNK_TIMEOUT_MS = 120_000;

/** Watchdog macet: tanpa byte baru selama ini, chunk dibatalkan. */
export const DOWNLOAD_STALL_TIMEOUT_MS = 60_000;

/** Ruang kosong yang wajib tersisa sesudah unduhan (arsitektur). */
export const DOWNLOAD_SPACE_HEADROOM_BYTES = 100 * 1024 * 1024;

/** Tunggu 429 terlama yang dituruti (Retry-After di atas ini gagal). */
export const DOWNLOAD_MAX_RETRY_AFTER_SECONDS = 65;

/** Batas cache runtime default: 500 MB (arsitektur §3.6). */
export const RUNTIME_CACHE_LIMIT_BYTES = 500 * 1024 * 1024;
