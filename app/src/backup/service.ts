/**
 * Layanan salinan data (P8, PRD B10.1/B7.5/B7.6).
 *
 * Satu pintu untuk ekspor dan impor file salinan:
 * - Ekspor: snapshot database + pengaturan -> JSON berversi ->
 *   unduh lewat browser (tanpa server).
 * - Impor: baca byte file -> cek ukuran -> parse + validasi +
 *   migrasi -> merge SATU transaksi (LibraryService.
 *   mergeBackupData) -> terapkan pengaturan (opsional, pilihan
 *   pengguna) -> ImportReport.
 *
 * Impor tidak pernah mengubah database bila file tidak lolos
 * validasi: validasi penuh (termasuk integritas referensi)
 * berjalan SEBELUM transaksi dibuka, dan transaksi membatalkan
 * segalanya bila satu langkah gagal (atomic, PRD B10.1).
 *
 * Pengaturan yang ikut salinan (hanya buatan pengguna): urutan
 * daftar lagu, saklar lirik, dan pengaturan equalizer web.
 * Field APK yang tidak punya padanan web (dataSaver,
 * defaultQuality, wifiOnly, cacheLimitBytes, playbackSpeed,
 * playbackPitch, skipSilence, eqEnabled, eqPreset) ditulis
 * null saat ekspor dan diabaikan saat impor — dicatat, bukan
 * disembunyikan. Yang tidak ikut: status kanari, config remote,
 * status layanan, cap waktu Jelajah, flag first-run, dan
 * penanda sinkronisasi.
 *
 * Login TIDAK PERNAH dibutuhkan: backup/ekspor jalan penuh
 * tanpa akun (aturan rencana §P8).
 */
import { APP_VERSION } from '../core/version';
import {
  getLibraryService,
  mergeTotalAdded,
  mergeTotalExisted,
  type LibraryService,
  type SongSort,
} from '../data/library';
import { DownloadState } from '../data/types';
import { getLyricsService, LYRICS_ENABLED_KEY } from '../lyrics/lyricsService';
import { normalizeEqSettings, type EqSettings } from '../player/equalizer';
import { getPlayerService } from '../player/service';
import { EQ_SETTINGS_KEY, useEqualizerStore } from '../store/equalizer';
import { SORT_META_KEY, useLibraryStore } from '../store/library';
import {
  backupFileName,
  encodeBackupData,
  MAX_BACKUP_BYTES,
  parseBackupBytes,
  type BackupData,
  type BackupSettings,
  type BackupSong,
} from './format';
import type { ImportFailure, ImportReport } from './report';

/** Hasil ekspor. */
export type BackupExportOutcome = 'downloaded' | 'failed' | 'tooLarge';

/** Payload ekspor yang siap diunduh (dipisah supaya bisa diuji tanpa DOM). */
export interface BackupExportPayload {
  outcome: BackupExportOutcome;
  /** Teks JSON (null bila outcome bukan 'downloaded'). */
  text: string | null;
  fileName: string;
  /** Ukuran byte teks JSON. */
  sizeBytes: number;
}

/**
 * Bangun isi file salinan dari database + pengaturan saat ini.
 *
 * Dipakai ekspor dan tes end-to-end (tanpa unduh file).
 */
export async function buildBackupData(
  library: LibraryService,
): Promise<BackupData> {
  const snap = await library.backupSnapshot();
  const artistNames = new Map(
    snap.artists.map((a) => [a.id, a.name] as [string, string]),
  );
  const grouped = new Map<string, Array<{ position: number; id: string; name: string }>>();
  for (const m of snap.songArtists) {
    const name = artistNames.get(m.artistId);
    if (name === undefined) continue;
    const list = grouped.get(m.songId) ?? [];
    list.push({ position: m.position, id: m.artistId, name });
    grouped.set(m.songId, list);
  }
  const songArtists = new Map<string, BackupSong['artists']>();
  for (const [songId, refs] of grouped) {
    refs.sort((a, b) => a.position - b.position);
    songArtists.set(
      songId,
      refs.map((r) => ({ id: r.id, name: r.name })),
    );
  }
  const membersByPlaylist = new Map<number, string[]>();
  for (const m of snap.playlistSongs) {
    const list = membersByPlaylist.get(m.playlistId) ?? [];
    list.push(m.songId);
    membersByPlaylist.set(m.playlistId, list);
  }
  const settings = await readBackupSettings(library);
  return {
    version: 1,
    appVersion: APP_VERSION,
    exportedAt: new Date(),
    songs: snap.songs.map((song) => ({
      id: song.id,
      title: song.title,
      artists: songArtists.get(song.id) ?? [],
      albumId: song.albumId,
      durationSeconds: song.durationSeconds,
      thumbnailUrl: song.thumbnailUrl,
      liked: song.liked === 1,
      inLibrary: song.inLibrary === 1,
      totalPlayTimeMs: song.totalPlayTimeMs,
      dateAdded: song.dateAdded,
      downloaded: song.downloadState === DownloadState.downloaded,
      unplayable: song.unplayable === 1,
    })),
    albums: snap.albums.map((a) => ({
      id: a.id,
      title: a.title,
      year: a.year,
      thumbnailUrl: a.thumbnailUrl,
      liked: a.liked === 1,
      dateAdded: a.dateAdded,
    })),
    artists: snap.artists.map((a) => ({
      id: a.id,
      name: a.name,
      thumbnailUrl: a.thumbnailUrl,
      liked: a.liked === 1,
      dateAdded: a.dateAdded,
    })),
    playlists: snap.playlists.map((p) => ({
      name: p.name,
      description: p.description,
      songIds: membersByPlaylist.get(p.id) ?? [],
      createdAt: p.createdAt,
    })),
    playEvents: snap.playEvents.map((e) => ({
      songId: e.songId,
      timestamp: e.timestamp,
      playTimeMs: e.playTimeMs,
    })),
    searchHistory: snap.searchHistory.map((q) => ({
      query: q.query,
      timestamp: q.timestamp,
    })),
    queue: snap.queue.map((q) => ({
      songId: q.songId,
      source: q.source,
    })),
    playbackState:
      snap.playbackState === null
        ? null
        : {
            currentIndex: snap.playbackState.currentIndex,
            positionMs: snap.playbackState.positionMs,
            shuffleEnabled: snap.playbackState.shuffleEnabled === 1,
            repeatMode: snap.playbackState.repeatMode,
          },
    settings,
  };
}

/** Baca pengaturan pengguna dari app_meta untuk diekspor. */
async function readBackupSettings(
  library: LibraryService,
): Promise<BackupSettings> {
  const sortRaw = await library.getMeta(SORT_META_KEY);
  const sortSongs =
    sortRaw === 'newest' || sortRaw === 'byName' || sortRaw === 'mostPlayed'
      ? sortRaw
      : null;
  const lyricsRaw = await library.getMeta(LYRICS_ENABLED_KEY);
  const eq = await readEqSettings(library);
  return {
    dataSaver: null,
    defaultQuality: null,
    wifiOnly: null,
    cacheLimitBytes: null,
    playbackSpeed: null,
    playbackPitch: null,
    skipSilence: null,
    sortSongs,
    eqEnabled: null,
    eqPreset: null,
    lyricsEnabled: lyricsRaw !== '0',
    eqPresetName: eq?.preset ?? null,
    eqGains: eq ? [...eq.gains] : null,
  };
}

async function readEqSettings(
  library: LibraryService,
): Promise<EqSettings | null> {
  // Store adalah sumber kebenaran saat app jalan (sudah dimuat);
  // app_meta dibaca bila store belum dimuat (mis. ekspor sebelum
  // pemutar init selesai).
  if (useEqualizerStore.getState().loaded) {
    return useEqualizerStore.getState().settings;
  }
  const raw = await library.getMeta(EQ_SETTINGS_KEY);
  if (raw === null || raw === '') return null;
  try {
    return normalizeEqSettings(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Bangun payload ekspor (encode + cek ukuran). Salinan yang
 * melebihi batas impor TIDAK BOLEH dibagikan: pengguna akan
 * mengira datanya aman padahal file-nya ditolak saat impor.
 */
export function buildExportPayload(data: BackupData): BackupExportPayload {
  const text = encodeBackupData(data);
  const sizeBytes = new TextEncoder().encode(text).length;
  const fileName = backupFileName(data.exportedAt);
  if (sizeBytes > MAX_BACKUP_BYTES) {
    return { outcome: 'tooLarge', text: null, fileName, sizeBytes };
  }
  return { outcome: 'downloaded', text, fileName, sizeBytes };
}

/**
 * Unduh teks sebagai file lewat browser (tanpa server): Blob +
 * tautan sementara. Mengembalikan false bila browser menolak
 * (mis. unduhan diblokir).
 */
export function triggerBrowserDownload(
  text: string,
  fileName: string,
): boolean {
  try {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Beri jeda singkat sebelum mencabut URL supaya unduhan
    // sempat dimulai (pola umum; tanpa ini Chrome kadang gagal
    // memulai unduhan untuk file besar).
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ekspor salinan lalu unduh lewat browser. Mengembalikan hasil —
 * pemanggil (termasuk alur "Simpan salinan dulu" di hapus data)
 * memutuskan langkah berikut dari hasil ini; penghapusan TIDAK
 * PERNAH lanjut otomatis dari sini.
 */
export async function exportBackup(): Promise<BackupExportPayload> {
  const library = await getLibraryService();
  const data = await buildBackupData(library);
  const payload = buildExportPayload(data);
  if (payload.outcome !== 'downloaded' || payload.text === null) {
    return payload;
  }
  const ok = triggerBrowserDownload(payload.text, payload.fileName);
  return ok
    ? payload
    : { ...payload, outcome: 'failed', text: null };
}

/**
 * Baca + validasi file salinan TANPA mengubah database.
 *
 * Dipakai layar impor untuk menampilkan ringkasan sebelum
 * pengguna menekan "Pulihkan". Melempar BackupException bila
 * file tidak bisa dipakai.
 */
export function previewImport(bytes: Uint8Array): BackupData {
  return parseBackupBytes(bytes);
}

/**
 * Batas lagu yang diantre sekali ketuk "Unduh ulang"
 * (Blue 3, Red 3 R14). Satu file bisa membawa puluhan ribu flag
 * `downloaded`; tanpa cap, satu ketukan mengantre puluhan ribu
 * unduhan. Kelebihan dilaporkan ke pengguna, bukan diam-diam
 * dipotong (lihat capRedownloadIds).
 */
export const MAX_REDOWLOAD_JOBS = 200;

/** Bagi daftar lagu unduh-ulang ke yang diantre + jumlah yang dilewati. */
export function capRedownloadIds(ids: string[]): {
  queued: string[];
  skipped: number;
} {
  return {
    queued: ids.slice(0, MAX_REDOWLOAD_JOBS),
    skipped: Math.max(0, ids.length - MAX_REDOWLOAD_JOBS),
  };
}

/**
 * Impor file salinan yang sudah lolos previewImport.
 *
 * Merge database berjalan dalam satu transaksi; pengaturan dari
 * file diterapkan sesudah transaksi berhasil bila
 * `applySettings` true. Mengembalikan ImportReport (angka
 * berhasil/sudah ada/gagal + daftar lagu yang dulu terunduh
 * untuk tombol "Unduh ulang").
 */
export async function importBackup(
  data: BackupData,
  opts: { applySettings: boolean },
): Promise<ImportReport> {
  const library = await getLibraryService();
  const merged = await library.mergeBackupData(data);
  if (opts.applySettings && data.settings !== null) {
    await applyBackupSettings(data.settings);
  }
  const failures: ImportFailure[] = [];
  if (merged.queueSkippedSongIds.length > 0) {
    const songsById = new Map(data.songs.map((s) => [s.id, s]));
    for (const songId of merged.queueSkippedSongIds) {
      const song = songsById.get(songId);
      const label =
        song === undefined
          ? songId
          : song.artists.length === 0
            ? song.title
            : `${song.artists[0]?.name ?? ''} - ${song.title}`;
      failures.push({ label, reason: 'queueFull' });
    }
  }
  return {
    succeeded: mergeTotalAdded(merged),
    alreadyExisted: mergeTotalExisted(merged),
    failures,
    playlistId: null,
    playlistName: null,
    downloadedSongIds: merged.downloadedSongIds,
    exportedAt: data.exportedAt,
    appVersion: data.appVersion,
  };
}

/**
 * Terapkan pengaturan dari file. Setiap nilai sudah disanitasi
 * sendiri (sortir tak dikenal diabaikan, EQ dinormalisasi ke
 * bentuk yang sah). Field APK tanpa padanan web diabaikan.
 */
export async function applyBackupSettings(
  settings: BackupSettings,
): Promise<void> {
  let changed = false;
  if (
    settings.sortSongs === 'newest' ||
    settings.sortSongs === 'byName' ||
    settings.sortSongs === 'mostPlayed'
  ) {
    const sort: SongSort = settings.sortSongs;
    useLibraryStore.getState().setSort(sort);
    changed = true;
  }
  if (settings.lyricsEnabled !== null && settings.lyricsEnabled !== undefined) {
    const lyrics = await getLyricsService();
    await lyrics.setEnabled(settings.lyricsEnabled);
    changed = true;
  }
  if (
    settings.eqPresetName !== null &&
    settings.eqPresetName !== undefined &&
    settings.eqGains !== null &&
    settings.eqGains !== undefined
  ) {
    const eq = normalizeEqSettings({
      preset: settings.eqPresetName,
      gains: settings.eqGains,
    });
    await getPlayerService().applySyncedEqSettings(eq);
    changed = true;
  }
  if (changed) {
    // Pengaturan dari file adalah perubahan lokal (bukan dari
    // server): tandai supaya sinkronisasi mendorongnya.
    void import('../sync/settingsMarkers')
      .then((m) => m.markSettingsChanged())
      .catch(() => undefined);
  }
}
