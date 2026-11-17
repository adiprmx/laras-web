/**
 * Database IndexedDB Laras Web (Dexie).
 *
 * Skema port drift APK v4, dibagi dua versi IndexedDB supaya
 * migrasi berversi bisa diuji (dan supaya penambahan store di
 * masa depan punya pola yang sama):
 * - v1: 15 tabel APK (songs sampai download_jobs).
 * - v2: 3 store tambahan web (token_index, playback_state,
 *   app_meta).
 *
 * Aturan migrasi yang mengikat: upgrade TIDAK PERNAH menghapus
 * data pengguna. Versi baru hanya menambah store/indeks atau
 * kolom dengan nilai default; penghapusan store butuh keputusan
 * eksplisit koordinator + migrasi data dulu.
 *
 * Nama database `laras` stabil lintas versi app: mengganti nama
 * sama dengan membuang seluruh library pengguna.
 */
import Dexie, { type Table } from 'dexie';
import type {
  AlbumArtistRow,
  AlbumRow,
  AppMetaRow,
  ArtistRow,
  CacheEntryRow,
  DownloadJobRow,
  FormatRow,
  LocalItemRow,
  LyricsRow,
  PlaybackStateRow,
  PlayEventRow,
  PlaylistRow,
  PlaylistSongRow,
  QueueItemRow,
  SearchHistoryRow,
  SongArtistRow,
  SongRow,
  TokenIndexRow,
} from './types';

export const LARAS_DB_NAME = 'laras';
export const LARAS_DB_VERSION = 2;

/** 15 store v1: port tabel drift APK (lihat src/data/types.ts). */
export const V1_STORES: Record<string, string> = {
  // Indeks gabungan dipakai pagination keyset (lihat library.ts):
  // [inLibrary+dateAdded+id] terbaru, [inLibrary+titleKey+id]
  // nama, [inLibrary+totalPlayTimeMs+id] sering diputar,
  // [liked+dateAdded+id] favorit, [albumId+titleKey+id] album.
  songs:
    'id, albumId, titleKey, liked, inLibrary, downloadState, ' +
    'unplayable, dateAdded, [inLibrary+dateAdded+id], ' +
    '[inLibrary+titleKey+id], [inLibrary+totalPlayTimeMs+id], ' +
    '[liked+dateAdded+id], [albumId+titleKey+id]',
  albums: 'id, titleKey, [titleKey+id]',
  artists: 'id, nameKey, [nameKey+id]',
  song_artists: '[songId+artistId], artistId, songId',
  album_artists: '[albumId+artistId], artistId',
  playlists: '++id, name, [updatedAt+id]',
  playlist_songs: '[playlistId+songId], [playlistId+position], songId',
  formats: 'id, songId',
  lyrics: 'songId',
  play_events: '++id, songId, [timestamp+id]',
  search_history: 'query, queryLower, [timestamp+query]',
  queue_items: 'position',
  local_items: 'path',
  cache_entries: 'key, lastAccessed',
  download_jobs: 'songId, status, createdAt',
};

/** 3 store v2: tambahan web (arsitektur §5.1). */
export const V2_STORES: Record<string, string> = {
  // [token+kind+refId] untuk hapus baris satu lagu; [kind+refId]
  // untuk hapus seluruh token satu entitas.
  token_index: '++id, token, [token+kind+refId], [kind+refId]',
  playback_state: 'id',
  app_meta: 'key',
};

export class LarasDatabase extends Dexie {
  songs!: Table<SongRow, string>;
  albums!: Table<AlbumRow, string>;
  artists!: Table<ArtistRow, string>;
  song_artists!: Table<SongArtistRow, [string, string]>;
  album_artists!: Table<AlbumArtistRow, [string, string]>;
  playlists!: Table<PlaylistRow, number, Omit<PlaylistRow, 'id'>>;
  playlist_songs!: Table<PlaylistSongRow, [number, string]>;
  formats!: Table<FormatRow, string>;
  lyrics!: Table<LyricsRow, string>;
  play_events!: Table<PlayEventRow, number, Omit<PlayEventRow, 'id'>>;
  search_history!: Table<SearchHistoryRow, string>;
  queue_items!: Table<QueueItemRow, number>;
  local_items!: Table<LocalItemRow, string>;
  cache_entries!: Table<CacheEntryRow, string>;
  download_jobs!: Table<DownloadJobRow, string>;
  token_index!: Table<TokenIndexRow, number>;
  playback_state!: Table<PlaybackStateRow, number>;
  app_meta!: Table<AppMetaRow, string>;

  constructor(name: string = LARAS_DB_NAME) {
    super(name);
    this.version(1).stores(V1_STORES);
    // v2 hanya menambah store; data v1 tidak disentuh.
    this.version(2).stores(V2_STORES);
  }
}

let sharedDb: LarasDatabase | null = null;
let sharedOpen: Promise<LarasDatabase> | null = null;

/** Apakah IndexedDB tersedia di lingkungan ini. */
export function isIndexedDbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

/**
 * Buka database bersama (satu instance per halaman). Gagal buka
 * (mode privat, IndexedDB dimatikan) melempar; pemanggil wajib
 * menangkap dan menampilkan keadaan jujur, bukan crash.
 */
export function openDatabase(): Promise<LarasDatabase> {
  if (sharedDb) return Promise.resolve(sharedDb);
  if (!sharedOpen) {
    sharedOpen = (async () => {
      const db = new LarasDatabase();
      await db.open();
      sharedDb = db;
      return db;
    })().catch((error: unknown) => {
      sharedOpen = null;
      throw error;
    });
  }
  return sharedOpen;
}

/** Tutup + buang instance bersama (dipakai tes dan reset data). */
export async function closeDatabase(): Promise<void> {
  sharedOpen = null;
  if (sharedDb) {
    sharedDb.close();
    sharedDb = null;
  }
}

/**
 * Hapus seluruh database dari disk (dipakai "Hapus semua data"
 * P8 dan tes). Menutup instance bersama dulu.
 */
export async function deleteDatabase(
  name: string = LARAS_DB_NAME,
): Promise<void> {
  await closeDatabase();
  await Dexie.delete(name);
}
