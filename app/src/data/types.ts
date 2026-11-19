/**
 * Baris-baris IndexedDB Laras Web (P3).
 *
 * Port skema drift APK v4 (`~/workspace/music-app/laras/lib/data/
 * tables.dart` + `laras_database.dart`): nama store dan nama kolom
 * dipertahankan, hanya konvensi penulisan yang berubah (snake_case
 * SQL menjadi camelCase TypeScript, sama seperti Dart). Timestamp
 * disimpan sebagai angka milidetik epoch (drift memakai detik;
 * web memakai milidetik supaya urutan dalam satu detik tetap
 * terbedakan, tiebreak id tetap dipakai).
 *
 * Kolom bertanda "web" tidak ada di APK dan dicatat alasannya:
 * - `titleKey` / `nameKey`: judul/nama huruf kecil untuk urutan
 *   tanpa membedakan kapitalisasi (IndexedDB tidak punya
 *   `lower()` seperti SQL).
 * - `queryLower`: query huruf kecil untuk dedup riwayat pencarian.
 * - `queue_items.kind`: jenis lagu antrean (stream/lokal); kolom
 *   APK `source` (asal antrean) dipertahankan apa adanya.
 * - Flag boolean APK (`liked`, `inLibrary`, `unplayable`,
 *   `shuffleEnabled`) disimpan sebagai angka 0/1: boolean BUKAN
 *   kunci IndexedDB yang valid, jadi tidak bisa dipakai di
 *   indeks gabungan. Ini juga persis penyimpanan drift APK
 *   (boolean() menjadi INTEGER 0/1 di SQLite).
 * - `playback_state.order` / `.rate` / `.volume`: urutan putar
 *   acak + kecepatan + volume, supaya pulih antrean web sama
 *   persis dengan keadaan sebelum browser ditutup.
 */

import type { RepeatMode } from '../player/types';

/** Status unduhan lagu (`songs.download_state`, port APK). */
export const DownloadState = {
  notDownloaded: 0,
  downloading: 1,
  downloaded: 2,
} as const;

/** Status pekerjaan unduhan (`download_jobs.status`, port APK). */
export const DownloadJobStatus = {
  queued: 0,
  running: 1,
  paused: 2,
  failed: 3,
  completed: 4,
} as const;

/** Mode pengulangan sebagai angka (`playback_state.repeat_mode`). */
export const RepeatModeValue = {
  off: 0,
  all: 1,
  one: 2,
} as const;

export function repeatModeToValue(mode: RepeatMode): number {
  if (mode === 'all') return RepeatModeValue.all;
  if (mode === 'one') return RepeatModeValue.one;
  return RepeatModeValue.off;
}

export function repeatModeFromValue(value: number): RepeatMode {
  if (value === RepeatModeValue.all) return 'all';
  if (value === RepeatModeValue.one) return 'one';
  return 'off';
}

export interface SongRow {
  /** videoId YouTube (atau URL untuk lagu lokal antrean). */
  id: string;
  title: string;
  /** Judul huruf kecil (web, untuk urutan nama). */
  titleKey: string;
  albumId: string | null;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  /** 0/1 (lihat catatan di atas). */
  liked: number;
  totalPlayTimeMs: number;
  /** 0/1 (lihat catatan di atas). */
  inLibrary: number;
  dateAdded: number;
  dateModified: number;
  downloadState: number;
  /** Path relatif unduhan (web: kunci blob, diisi P5). */
  filePath: string | null;
  fileSizeBytes: number | null;
  downloadedAt: number | null;
  formatId: string | null;
  /** 0/1 (lihat catatan di atas). */
  unplayable: number;
}

export interface AlbumRow {
  /** browseId album YouTube Music. */
  id: string;
  title: string;
  /** Judul huruf kecil (web, untuk urutan nama). */
  titleKey: string;
  year: number | null;
  thumbnailUrl: string | null;
  /** 0/1 (lihat catatan di atas). */
  liked: number;
  dateAdded: number;
}

export interface ArtistRow {
  /** channelId YTM, atau id semu `local-<hash nama>`. */
  id: string;
  name: string;
  /** Nama huruf kecil (web, untuk urutan nama). */
  nameKey: string;
  thumbnailUrl: string | null;
  /** 0/1 (lihat catatan di atas). */
  liked: number;
  dateAdded: number;
}

export interface SongArtistRow {
  songId: string;
  artistId: string;
  position: number;
}

export interface AlbumArtistRow {
  albumId: string;
  artistId: string;
  position: number;
}

export interface PlaylistRow {
  id: number;
  name: string;
  description: string | null;
  /** browseId bila playlist berasal dari YouTube Music. */
  browseId: string | null;
  thumbnailUrl: string | null;
  /**
   * Id client sinkronisasi (P7, web): identitas stabil playlist di
   * server sync (`<deviceId>:<id lokal>`). Kolom opsional tanpa
   * indeks — Dexie menyimpan properti tambahan tanpa perubahan
   * skema versi.
   */
  clientId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PlaylistSongRow {
  playlistId: number;
  songId: string;
  position: number;
  dateAdded: number;
}

export interface FormatRow {
  /** Gabungan videoId dan itag. */
  id: string;
  songId: string;
  itag: number;
  mimeType: string;
  codecs: string | null;
  bitrate: number | null;
  loudnessDb: number | null;
  contentLength: number | null;
  lastModified: number;
}

export interface LyricsRow {
  songId: string;
  lyrics: string;
  syncedLyrics: string | null;
  fetchedAt: number;
  /**
   * Asal lirik (P7, opsional tanpa indeks — Dexie menyimpan
   * properti ekstra tanpa perubahan skema). Dipakai atribusi
   * "Lirik oleh ..." di panel; baris tanpa sumber (dibuat
   * sebelum kolom ini ada) dianggap dari LRCLIB.
   */
  source?: 'lrclib' | 'ovh' | null;
}

export interface PlayEventRow {
  id: number;
  songId: string;
  timestamp: number;
  playTimeMs: number;
}

export interface SearchHistoryRow {
  query: string;
  /** Query huruf kecil (web, untuk dedup). */
  queryLower: string;
  timestamp: number;
}

export interface QueueItemRow {
  position: number;
  songId: string;
  /** Asal antrean (playlist, album, pencarian), port APK. */
  source: string | null;
  /** Jenis lagu antrean (web): stream atau lokal. */
  kind: 'stream' | 'local';
}

export interface LocalItemRow {
  path: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  durationSeconds: number | null;
  dateAdded: number;
}

export interface CacheEntryRow {
  /** videoId + itag. */
  key: string;
  filePath: string;
  sizeBytes: number;
  lastAccessed: number;
  createdAt: number;
}

export interface DownloadJobRow {
  songId: string;
  status: number;
  /** Itag kualitas yang dipilih (251/140/249/139). */
  quality: number | null;
  bytesDownloaded: number;
  totalBytes: number | null;
  attempts: number;
  errorMessage: string | null;
  createdAt: number | null;
  updatedAt: number;
}

/** Satu baris indeks token: satu token milik satu lagu/artis. */
export interface TokenIndexRow {
  id?: number;
  token: string;
  kind: 'song' | 'artist';
  refId: string;
}

export interface PlaybackStateRow {
  /** Selalu 1: hanya ada satu status pemutar. */
  id: number;
  /** Posisi lagu saat ini di urutan putar (orderPos). */
  currentIndex: number;
  /** Posisi putar dalam lagu, milidetik. */
  positionMs: number;
  /** 0/1 (lihat catatan di atas). */
  shuffleEnabled: number;
  repeatMode: number;
  /** Urutan putar: indeks ke antrean (web). */
  order: number[];
  /** Kecepatan putar (web). */
  rate: number;
  /** Volume app 0..1 (web). */
  volume: number;
  updatedAt: number;
}

export interface AppMetaRow {
  key: string;
  value: string;
}

/**
 * Tombstone hapus lokal untuk sinkronisasi (P7, store v3).
 * Dicatat saat pengguna menghapus playlist, mengeluarkan lagu
 * dari playlist, atau membatalkan suka — supaya penghapusan
 * ikut terkirim ke server dan ke perangkat lain (tanpa ini,
 * data yang dihapus akan bangkit lagi dari tarik berikutnya).
 * Dibersihkan sesudah terkirim + berumur 30 hari.
 */
export interface SyncTombstoneRow {
  /** Kunci: `<kind>:<ref>` (mis. `playlist:pl-abc:3`). */
  key: string;
  kind: 'playlist' | 'playlist-item' | 'like';
  /** Referensi yang dihapus (clientId playlist / videoId / gabungan). */
  ref: string;
  deletedAt: number;
}

/** Satu lagu beserta nama-nama artisnya, siap tampil di daftar. */
export interface SongView {
  song: SongRow;
  artistNames: string[];
}

/** Satu lagu di dalam playlist, beserta posisinya. */
export interface PlaylistSongEntry {
  song: SongView;
  position: number;
  dateAdded: number;
}

/** Satu entri riwayat putar: sesi putar beserta lagunya. */
export interface PlayHistoryEntry {
  event: PlayEventRow;
  song: SongView;
}

export interface ArtistWithCount {
  artist: ArtistRow;
  songCount: number;
}

export interface AlbumWithCount {
  album: AlbumRow;
  songCount: number;
}

export interface PlaylistWithCount {
  playlist: PlaylistRow;
  songCount: number;
}

export interface LibraryCounts {
  songs: number;
  artists: number;
  albums: number;
  playlists: number;
  favorites: number;
  historyEntries: number;
}

/** Hasil pencarian lokal: lagu dan artis yang cocok. */
export interface LocalSearchResults {
  songs: SongView[];
  artists: ArtistRow[];
}

/** Satu lagu untuk impor massal (tes performa, impor P8). */
export interface SongImport {
  song: Omit<SongRow, 'titleKey' | 'dateAdded' | 'dateModified'> & {
    dateAdded?: number;
    dateModified?: number;
  };
  artistNames?: string[];
  /** channelId YTM sejajar artistNames. */
  artistChannelIds?: Array<string | null>;
  album?: Omit<AlbumRow, 'titleKey' | 'dateAdded'> & { dateAdded?: number };
}
