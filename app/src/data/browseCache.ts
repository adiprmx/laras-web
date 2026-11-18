/**
 * Cache halaman Jelajah (browse home) di `app_meta`.
 *
 * PRD B6.4: "Jelajah" dimuat ulang otomatis bila datanya lebih
 * dari 6 jam; gagal refresh menampilkan data terakhir dengan
 * pesan. Cache menyimpan halaman browse yang sudah di-parse
 * (bukan JSON mentah) supaya muatnya murah dan ukurannya kecil.
 * Batas keras 512 KB per nilai cache (halaman browse nyata jauh
 * di bawah angka ini; nilai lebih besar tidak disimpan).
 *
 * Cache ini BUKAN penyimpanan lagu dan bukan data pengguna yang
 * sensitif — hanya rak katalog publik YouTube Music.
 */
import { getLibraryService } from './library';
import type { BrowsePage } from '../extractor/searchParser';

/** Kunci cache di `app_meta`. */
export const BROWSE_HOME_CACHE_KEY = 'browseHomeCache';

/** TTL cache Jelajah: 6 jam (selaras TTL config remote). */
export const BROWSE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Batas ukuran satu nilai cache (byte). */
export const BROWSE_CACHE_MAX_BYTES = 512 * 1024;

export interface CachedBrowseHome {
  page: BrowsePage;
  /** Waktu simpan (epoch ms). */
  fetchedAt: number;
}

/** Benar bila cache masih segar (lebih muda dari TTL). */
export function isBrowseCacheFresh(
  fetchedAt: number,
  nowMs: number = Date.now(),
): boolean {
  return nowMs - fetchedAt < BROWSE_CACHE_TTL_MS;
}

/** Muat cache Jelajah, atau null bila belum ada / rusak. */
export async function loadCachedBrowseHome(): Promise<CachedBrowseHome | null> {
  try {
    const service = await getLibraryService();
    const raw = await service.getMeta(BROWSE_HOME_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      page?: BrowsePage;
      fetchedAt?: number;
    };
    if (
      typeof parsed.fetchedAt !== 'number' ||
      !parsed.page ||
      !Array.isArray(parsed.page.shelves)
    ) {
      return null;
    }
    return { page: parsed.page, fetchedAt: parsed.fetchedAt };
  } catch {
    return null;
  }
}

/**
 * Simpan cache Jelajah. Mengembalikan false bila nilai melewati
 * batas ukuran (tidak disimpan) atau database tidak bisa dibuka.
 */
export async function saveCachedBrowseHome(page: BrowsePage): Promise<boolean> {
  const value = JSON.stringify({ page, fetchedAt: Date.now() });
  if (new TextEncoder().encode(value).length > BROWSE_CACHE_MAX_BYTES) {
    return false;
  }
  try {
    const service = await getLibraryService();
    await service.setMeta(BROWSE_HOME_CACHE_KEY, value);
    return true;
  } catch {
    return false;
  }
}
