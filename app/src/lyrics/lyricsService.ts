/**
 * Layanan lirik (P7): cache IndexedDB + penanda "tidak ditemukan"
 * + saklar lirik + pemberitahuan privasi satu kali.
 *
 * Urutan: cache dulu (store `lyrics` P3), lalu penanda tidak
 * ditemukan (7 hari, app_meta), lalu jaringan (LRCLIB). Hasil
 * "tidak ada" dan instrumental TIDAK disimpan permanen (PRD B5.2)
 * supaya lirik baru tetap bisa ditemukan; penanda 7 hari hanya
 * menahan request berulang dalam seminggu (arsitektur §3.7).
 *
 * Layanan ini tidak menampilkan apa pun; komponen yang memanggil
 * memutuskan tampilan dari status yang dikembalikan.
 */
import { getLibraryService, type LibraryService } from '../data/library';
import {
  fetchLyricsFromNetwork,
  type LyricsFetchDeps,
  type LyricsFetchResult,
  type LyricsQuery,
} from './lrclib';

export const LYRICS_MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const LYRICS_ENABLED_KEY = 'lyrics-enabled';
export const LYRICS_NOTICE_KEY = 'lyrics-notice-seen';
const MISS_PREFIX = 'lyrics-miss:';

export type LyricsServiceResult =
  | {
      status: 'ok';
      syncedLyrics: string | null;
      plainLyrics: string;
      /** Sumber asli lirik (dipakai atribusi; cache memakai sumber tersimpan). */
      source: 'lrclib' | 'ovh';
    }
  | { status: 'not-found' }
  | { status: 'rate-limited'; retryAfterSeconds: number }
  | { status: 'error' }
  | { status: 'disabled' };

function missKey(songId: string): string {
  return `${MISS_PREFIX}${songId}`;
}

export class LyricsService {
  private readonly library: LibraryService;

  constructor(library: LibraryService) {
    this.library = library;
  }

  /** Apakah lirik aktif (default aktif; saklar di Pengaturan). */
  async isEnabled(): Promise<boolean> {
    const value = await this.library.getMeta(LYRICS_ENABLED_KEY);
    return value !== '0';
  }

  async setEnabled(
    enabled: boolean,
    opts: { quiet?: boolean } = {},
  ): Promise<void> {
    await this.library.setMeta(LYRICS_ENABLED_KEY, enabled ? '1' : '0');
    // Penanda sinkronisasi P7: pengaturan lirik berubah di
    // perangkat ini. Jalur tarik memakai `quiet` supaya nilai
    // dari server tidak langsung didorong balik.
    if (opts.quiet) return;
    // Import dinamis supaya service tidak bergantung statis ke
    // modul sync (menghindari siklus import).
    void import('../sync/settingsMarkers')
      .then((m) => m.markSettingsChanged())
      .catch(() => {
        // Penanda gagal dicatat: pengaturan mungkin tidak
        // terdorong di sinkronisasi berikut; bukan galat fatal.
      });
  }

  /** Apakah pemberitahuan privasi lirik sudah diterima pengguna. */
  async hasSeenNotice(): Promise<boolean> {
    return (await this.library.getMeta(LYRICS_NOTICE_KEY)) === '1';
  }

  async markNoticeSeen(): Promise<void> {
    await this.library.setMeta(LYRICS_NOTICE_KEY, '1');
  }

  /**
   * Ambil lirik satu lagu: cache, penanda tidak ditemukan,
   * lalu jaringan. `network` di-injeksi untuk tes.
   */
  async getLyrics(
    songId: string,
    query: LyricsQuery,
    network?: (q: LyricsQuery) => Promise<LyricsFetchResult>,
    nowMs: number = Date.now(),
  ): Promise<LyricsServiceResult> {
    if (!(await this.isEnabled())) return { status: 'disabled' };

    const cached = await this.library.getLyrics(songId);
    if (cached) {
      return {
        status: 'ok',
        syncedLyrics: cached.syncedLyrics,
        plainLyrics: cached.lyrics,
        // Atribusi memakai sumber asli yang tersimpan (bukan
        // 'cache'): lirik dari lyrics.ovh tetap diakui ovh.
        // Baris tanpa sumber dianggap dari LRCLIB.
        source: cached.source ?? 'lrclib',
      };
    }

    const missRaw = await this.library.getMeta(missKey(songId));
    if (missRaw !== null) {
      const missAt = Number(missRaw);
      if (Number.isFinite(missAt) && nowMs - missAt < LYRICS_MISS_TTL_MS) {
        return { status: 'not-found' };
      }
    }

    const fetchFn =
      network ?? ((q: LyricsQuery) => fetchLyricsFromNetwork(q));
    const result = await fetchFn(query);
    if (result.status === 'ok') {
      // Simpan best-effort: gagal simpan (mis. di atas 256 KB)
      // tidak mengubah hasil yang tampil.
      await this.library
        .saveLyrics({
          songId,
          lyrics: result.plainLyrics,
          syncedLyrics: result.syncedLyrics,
          source: result.source,
        })
        .catch(() => false);
      return {
        status: 'ok',
        syncedLyrics: result.syncedLyrics,
        plainLyrics: result.plainLyrics,
        source: result.source,
      };
    }
    if (result.status === 'not-found') {
      await this.library
        .setMeta(missKey(songId), String(nowMs))
        .catch(() => undefined);
      return { status: 'not-found' };
    }
    if (result.status === 'rate-limited') {
      return {
        status: 'rate-limited',
        retryAfterSeconds: result.retryAfterSeconds,
      };
    }
    return { status: 'error' };
  }
}

let shared: LyricsService | null = null;

/** Singleton layanan lirik (dibuat malas di browser). */
export async function getLyricsService(): Promise<LyricsService> {
  if (!shared) shared = new LyricsService(await getLibraryService());
  return shared;
}

/** Buang singleton (dipakai tes). */
export function resetLyricsService(): void {
  shared = null;
}

export type { LyricsFetchDeps };
