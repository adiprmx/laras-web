/**
 * Layanan library: satu-satunya jalan UI ke database.
 *
 * Port `LibraryService` APK (`lib/data/library_service.dart`):
 * semua perilaku dipertahankan (aturan masuk Library, batas
 * koleksi, pagination keyset 50/halaman, AND lalu OR di
 * pencarian lokal, dedup riwayat pencarian tanpa membedakan
 * kapitalisasi), kecuali pencarian memakai indeks token
 * IndexedDB (bukan FTS5) dan boolean disimpan 0/1.
 *
 * Semua daftar memakai pagination keyset: halaman berikut
 * diminta dengan item terakhir halaman sebelumnya, bukan nomor
 * halaman, supaya sisipan di tengah tidak menggeser isi.
 */
import { LarasDatabase, openDatabase } from './database';
import {
  MAX_BACKUP_QUEUE_ITEMS,
  type BackupData,
} from '../backup/format';
import {
  fillForYou,
  FOR_YOU_LIMIT,
  FOR_YOU_WINDOW_MS,
  rankForYou,
  type ForYouCandidate,
} from './recommendations';
import {
  compareSearchCandidates,
  localArtistIdForName,
  prefixUpperBound,
  scoreCandidate,
  tokenize,
  uniqueTokens,
} from './tokens';
import {
  DownloadState,
  type AlbumRow,
  type AlbumWithCount,
  type ArtistRow,
  type ArtistWithCount,
  type LibraryCounts,
  type LocalSearchResults,
  type PlaybackStateRow,
  type PlayEventRow,
  type PlayHistoryEntry,
  type PlaylistRow,
  type PlaylistSongEntry,
  type PlaylistSongRow,
  type PlaylistWithCount,
  type QueueItemRow,
  type SearchHistoryRow,
  type SongArtistRow,
  type SongImport,
  type SongRow,
  type SongView,
  type SyncTombstoneRow,
  type TokenIndexRow,
} from './types';

/** Ukuran halaman standar semua daftar (port APK kPageSize). */
export const PAGE_SIZE = 50;

/** Batas riwayat putar (PRD B4.6). Entri tertua dihapus otomatis. */
export const MAX_PLAY_EVENTS = 10000;

/** Batas riwayat pencarian (PRD B4.6). Query terlama dihapus otomatis. */
export const MAX_SEARCH_HISTORY = 100;

/** Batas nama playlist (PRD B4.1). */
export const MAX_PLAYLIST_NAME_LENGTH = 100;

/** Batas deskripsi playlist (PRD B4.1). */
export const MAX_PLAYLIST_DESCRIPTION_LENGTH = 500;

/** Ambang pencatatan play event (PRD B2.7): 10 detik. */
export const MIN_PLAY_EVENT_MS = 10000;

/** Durasi "putaran bermakna" (PRD B4.6): 30 detik. */
export const MEANINGFUL_PLAY_MS = 30000;

/** Batas lagu per playlist (arsitektur §5.4). */
export const MAX_PLAYLIST_SONGS = 1000;

/**
 * Batas playlist sinkron per pengguna (arsitektur §4.3, S7):
 * tarik dari server tidak pernah membuat playlist ke-101 di
 * perangkat ini. Sama dengan batas server; pembuatan lokal
 * manual tidak dibatasi angka ini.
 */
export const MAX_SYNC_PLAYLISTS = 100;

/** Batas ukuran satu kolom lirik (port R3-L1 APK). */
export const MAX_LYRICS_BYTES = 256 * 1024;

/**
 * Kunci app_meta: waktu terakhir riwayat dihapus total (P7).
 * Sinkronisasi mengirim penanda ini supaya server ikut menghapus
 * riwayat sampai waktu tersebut.
 */
export const SYNC_HISTORY_CLEARED_KEY = 'sync-history-cleared-before';

/** Urutan daftar lagu (port SongSort APK). */
export type SongSort = 'newest' | 'byName' | 'mostPlayed';

/**
 * Isi database mentah untuk ekspor backup (P8). Pemetaan ke
 * BackupData tinggal di `backup/service.ts` (seperti APK: snapshot
 * di LibraryService, pemetaan di BackupService).
 */
export interface BackupSnapshot {
  songs: SongRow[];
  songArtists: SongArtistRow[];
  albums: AlbumRow[];
  artists: ArtistRow[];
  playlists: PlaylistRow[];
  playlistSongs: PlaylistSongRow[];
  playEvents: PlayEventRow[];
  searchHistory: SearchHistoryRow[];
  queue: QueueItemRow[];
  playbackState: PlaybackStateRow | null;
}

/** Hitungan hasil merge impor backup (P8), per jenis data. */
export interface BackupMergeResult {
  songsAdded: number;
  songsExisted: number;
  playlistsCreated: number;
  playlistSongsAdded: number;
  playlistSongsExisted: number;
  /** Lagu playlist yang tidak masuk karena playlist sudah 1.000 lagu (batas web; file dari app yang sama tidak pernah memicu ini). */
  playlistSongsSkippedFull: number;
  eventsAdded: number;
  eventsExisted: number;
  queriesAdded: number;
  queriesExisted: number;
  queueAdded: number;
  queueExisted: number;
  /** Item antrean backup yang tidak masuk karena antrean sudah penuh (200 item). */
  queueSkippedFull: number;
  /** Id lagu antrean yang tidak masuk karena antrean penuh (untuk laporan hasil impor). */
  queueSkippedSongIds: string[];
  /** Id lagu yang dulu terunduh (menurut file) tapi belum terunduh di perangkat ini — penggerak tombol "Unduh ulang" (PRD B7.5). */
  downloadedSongIds: string[];
  /** True bila posisi pemutar dari file dipulihkan (hanya bila antrean perangkat tujuan kosong sebelum impor). */
  playbackStateRestored: boolean;
}

/** Jumlah item baru yang masuk (untuk angka "berhasil" di laporan). */
export function mergeTotalAdded(r: BackupMergeResult): number {
  return (
    r.songsAdded +
    r.playlistsCreated +
    r.playlistSongsAdded +
    r.eventsAdded +
    r.queriesAdded +
    r.queueAdded
  );
}

/** Jumlah item yang dilewati karena sudah ada. */
export function mergeTotalExisted(r: BackupMergeResult): number {
  return (
    r.songsExisted +
    r.playlistSongsExisted +
    r.eventsExisted +
    r.queriesExisted +
    r.queueExisted
  );
}

/** Batas atas string untuk rentang kunci (lebih besar dari teks nyata). */
const MAX_STRING = '\uffff';
/** Batas atas angka untuk rentang kunci. */
const MAX_NUMBER = Number.MAX_SAFE_INTEGER;

function now(): number {
  return Date.now();
}

function titleKeyOf(title: string): string {
  return title.toLowerCase();
}

export class LibraryService {
  private readonly db: LarasDatabase;

  constructor(db: LarasDatabase) {
    this.db = db;
  }

  // ------------------------------------------------------------------
  // Perubahan data (UI berlangganan untuk memuat ulang)
  // ------------------------------------------------------------------

  private listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  // ------------------------------------------------------------------
  // Lagu
  // ------------------------------------------------------------------

  /**
   * Simpan atau perbarui satu lagu beserta artis dan albumnya.
   * Lagu yang sudah ada hanya diperbarui metadata-nya (judul,
   * album, durasi, sampul, tanggal ubah); favorit, total waktu
   * putar, status unduhan, dan tanggal tambah dipertahankan.
   * Baris indeks token diperbarui dalam transaksi yang sama.
   */
  async upsertSong(
    song: SongImport['song'],
    opts: {
      artistNames?: string[];
      artistChannelIds?: Array<string | null>;
      album?: SongImport['album'];
      addToLibrary?: boolean;
    } = {},
  ): Promise<void> {
    const at = now();
    await this.db.transaction(
      'rw',
      [this.db.songs, this.db.albums, this.db.artists, this.db.song_artists, this.db.token_index],
      async () => {
        const albumId = await this.upsertAlbumRow(opts.album, at);
        await this.upsertSongRow(
          { ...song, albumId: albumId ?? song.albumId ?? null },
          at,
          opts.addToLibrary ?? false,
        );
        const names = opts.artistNames ?? [];
        await this.replaceSongArtists(
          song.id,
          names,
          opts.artistChannelIds ?? [],
          at,
        );
        await this.syncSongTokens(song.id, song.title, names);
      },
    );
    this.notify();
  }

  /**
   * Impor massal dalam satu transaksi (tes performa, impor P8,
   * simpan antrean). Semua tulis dilakukan berkelompok
   * (bulkGet/bulkAdd/bulkPut): impor per lagu satu per satu
   * terukur 21 detik untuk 120 lagu di browser (bench E2E
   * 18 Nov 2026), sementara berkelompok hanya ~0,2 detik untuk
   * jumlah yang sama. Semantik sama dengan upsertSong per lagu:
   * album/artis insert-or-ignore, lagu yang sudah ada hanya
   * diperbarui metadata-nya, pemetaan artis diganti, indeks
   * token disinkronkan.
   */
  async importSongs(
    items: SongImport[],
    opts: { addToLibrary?: boolean } = {},
  ): Promise<void> {
    if (items.length === 0) return;
    const at = now();
    const addToLibrary = opts.addToLibrary ?? true;
    await this.db.transaction(
      'rw',
      [this.db.songs, this.db.albums, this.db.artists, this.db.song_artists, this.db.token_index],
      async () => {
        // Album: insert-or-ignore berkelompok.
        const albumsById = new Map<string, AlbumRow>();
        for (const item of items) {
          const album = item.album;
          if (album && !albumsById.has(album.id)) {
            albumsById.set(album.id, {
              id: album.id,
              title: album.title,
              titleKey: titleKeyOf(album.title),
              year: album.year ?? null,
              thumbnailUrl: album.thumbnailUrl ?? null,
              liked: album.liked ?? 0,
              dateAdded: album.dateAdded ?? at,
            });
          }
        }
        if (albumsById.size > 0) {
          const keys = [...albumsById.keys()];
          const existing = await this.db.albums.bulkGet(keys);
          const missing: AlbumRow[] = [];
          keys.forEach((key, i) => {
            if (existing[i] === undefined) {
              const row = albumsById.get(key);
              if (row) missing.push(row);
            }
          });
          if (missing.length > 0) await this.db.albums.bulkAdd(missing);
        }

        // Artis: kumpulkan id unik, insert-or-ignore berkelompok.
        const artistNames = new Map<string, string>();
        const songArtistIds = new Map<string, string[]>();
        for (const item of items) {
          const names = item.artistNames ?? [];
          const ids: string[] = [];
          for (let i = 0; i < names.length; i++) {
            const name = names[i]?.trim();
            if (!name) continue;
            const channelId = item.artistChannelIds?.[i]?.trim();
            const id =
              channelId && channelId.length > 0
                ? channelId
                : localArtistIdForName(name);
            if (!artistNames.has(id)) artistNames.set(id, name);
            ids.push(id);
          }
          songArtistIds.set(item.song.id, ids);
        }
        const newArtistIds: string[] = [];
        if (artistNames.size > 0) {
          const keys = [...artistNames.keys()];
          const existing = await this.db.artists.bulkGet(keys);
          const missing: ArtistRow[] = [];
          keys.forEach((key, i) => {
            if (existing[i] === undefined) {
              const name = artistNames.get(key) ?? '';
              missing.push({
                id: key,
                name,
                nameKey: name.toLowerCase(),
                thumbnailUrl: null,
                liked: 0,
                dateAdded: at,
              });
              newArtistIds.push(key);
            }
          });
          if (missing.length > 0) await this.db.artists.bulkAdd(missing);
        }

        // Lagu: bulkGet, gabungkan di JS, bulkPut sekali.
        const ids = items.map((item) => item.song.id);
        const existingSongs = await this.db.songs.bulkGet(ids);
        const rowsToPut: SongRow[] = [];
        const updatedSongIds: string[] = [];
        items.forEach((item, i) => {
          const song = item.song;
          const albumId = item.album
            ? item.album.id
            : (song.albumId ?? null);
          const existing = existingSongs[i];
          if (!existing) {
            rowsToPut.push({
              id: song.id,
              title: song.title,
              titleKey: titleKeyOf(song.title),
              albumId,
              durationSeconds: song.durationSeconds ?? null,
              thumbnailUrl: song.thumbnailUrl ?? null,
              liked: song.liked ?? 0,
              totalPlayTimeMs: song.totalPlayTimeMs ?? 0,
              inLibrary: addToLibrary ? 1 : 0,
              dateAdded: song.dateAdded ?? at,
              dateModified: song.dateModified ?? at,
              downloadState:
                song.downloadState ?? DownloadState.notDownloaded,
              filePath: song.filePath ?? null,
              fileSizeBytes: song.fileSizeBytes ?? null,
              downloadedAt: song.downloadedAt ?? null,
              formatId: song.formatId ?? null,
              unplayable: song.unplayable ?? 0,
            });
            return;
          }
          updatedSongIds.push(song.id);
          rowsToPut.push({
            ...existing,
            title: song.title,
            titleKey: titleKeyOf(song.title),
            albumId: albumId ?? existing.albumId,
            durationSeconds: song.durationSeconds ?? existing.durationSeconds,
            thumbnailUrl: song.thumbnailUrl ?? existing.thumbnailUrl,
            inLibrary: addToLibrary ? 1 : existing.inLibrary,
            dateModified: at,
          });
        });
        await this.db.songs.bulkPut(rowsToPut);

        // Pemetaan artis: hapus lama untuk lagu-lagu ini, sisip baru.
        await this.db.song_artists.where('songId').anyOf(ids).delete();
        const mappings: Array<{
          songId: string;
          artistId: string;
          position: number;
        }> = [];
        for (const [songId, artistIds] of songArtistIds) {
          artistIds.forEach((artistId, position) => {
            mappings.push({ songId, artistId, position });
          });
        }
        if (mappings.length > 0) {
          await this.db.song_artists.bulkAdd(mappings);
        }

        // Token: lagu yang diperbarui dihapus token lamanya dulu;
        // lagu baru dan artis baru langsung disisip berkelompok.
        if (updatedSongIds.length > 0) {
          await this.db.token_index
            .where('[kind+refId]')
            .anyOf(
              updatedSongIds.map(
                (id) => ['song', id] as [string, string],
              ),
            )
            .delete();
        }
        const tokenRows: Array<{
          token: string;
          kind: 'song' | 'artist';
          refId: string;
        }> = [];
        for (const item of items) {
          const tokens = uniqueTokens(
            `${item.song.title} ${(item.artistNames ?? []).join(' ')}`,
          );
          for (const token of tokens) {
            tokenRows.push({ token, kind: 'song', refId: item.song.id });
          }
        }
        for (const id of newArtistIds) {
          const name = artistNames.get(id) ?? '';
          for (const token of uniqueTokens(name)) {
            tokenRows.push({ token, kind: 'artist', refId: id });
          }
        }
        if (tokenRows.length > 0) {
          await this.db.token_index.bulkAdd(tokenRows);
        }
      },
    );
    this.notify();
  }

  private async upsertAlbumRow(
    album: SongImport['album'],
    at: number,
  ): Promise<string | null> {
    if (!album) return null;
    const existing = await this.db.albums.get(album.id);
    if (!existing) {
      await this.db.albums.add({
        id: album.id,
        title: album.title,
        titleKey: titleKeyOf(album.title),
        year: album.year ?? null,
        thumbnailUrl: album.thumbnailUrl ?? null,
        liked: album.liked ?? 0,
        dateAdded: album.dateAdded ?? at,
      });
    }
    return album.id;
  }

  private async upsertSongRow(
    song: SongImport['song'],
    at: number,
    addToLibrary: boolean,
  ): Promise<void> {
    const existing = await this.db.songs.get(song.id);
    if (!existing) {
      await this.db.songs.add({
        id: song.id,
        title: song.title,
        titleKey: titleKeyOf(song.title),
        albumId: song.albumId ?? null,
        durationSeconds: song.durationSeconds ?? null,
        thumbnailUrl: song.thumbnailUrl ?? null,
        liked: song.liked ?? 0,
        totalPlayTimeMs: song.totalPlayTimeMs ?? 0,
        inLibrary: addToLibrary ? 1 : 0,
        dateAdded: song.dateAdded ?? at,
        dateModified: song.dateModified ?? at,
        downloadState: song.downloadState ?? DownloadState.notDownloaded,
        filePath: song.filePath ?? null,
        fileSizeBytes: song.fileSizeBytes ?? null,
        downloadedAt: song.downloadedAt ?? null,
        formatId: song.formatId ?? null,
        unplayable: song.unplayable ?? 0,
      });
      return;
    }
    await this.db.songs.update(song.id, {
      title: song.title,
      titleKey: titleKeyOf(song.title),
      albumId: song.albumId ?? existing.albumId,
      durationSeconds: song.durationSeconds ?? existing.durationSeconds,
      thumbnailUrl: song.thumbnailUrl ?? existing.thumbnailUrl,
      ...(addToLibrary ? { inLibrary: 1 } : {}),
      dateModified: at,
    });
  }

  private async replaceSongArtists(
    songId: string,
    artistNames: string[],
    channelIds: Array<string | null>,
    at: number,
  ): Promise<void> {
    await this.db.song_artists
      .where('[songId+artistId]')
      .between([songId, ''], [songId, MAX_STRING])
      .delete();
    for (let i = 0; i < artistNames.length; i++) {
      const name = artistNames[i]?.trim();
      if (!name) continue;
      const channelId = channelIds[i]?.trim();
      const artistId =
        channelId && channelId.length > 0
          ? channelId
          : localArtistIdForName(name);
      const existing = await this.db.artists.get(artistId);
      if (!existing) {
        await this.db.artists.add({
          id: artistId,
          name,
          nameKey: name.toLowerCase(),
          thumbnailUrl: null,
          liked: 0,
          dateAdded: at,
        });
      }
      await this.db.song_artists.add({
        songId,
        artistId,
        position: i,
      });
      await this.syncArtistTokens(artistId, name);
    }
  }

  // ------------------------------------------------------------------
  // Indeks token (pengganti FTS5)
  // ------------------------------------------------------------------

  private async syncSongTokens(
    songId: string,
    title: string,
    artistNames: string[],
  ): Promise<void> {
    await this.db.token_index
      .where('[kind+refId]')
      .equals(['song', songId])
      .delete();
    const tokens = uniqueTokens(`${title} ${artistNames.join(' ')}`);
    if (tokens.length > 0) {
      await this.db.token_index.bulkAdd(
        tokens.map((token) => ({ token, kind: 'song' as const, refId: songId })),
      );
    }
  }

  private async syncArtistTokens(artistId: string, name: string): Promise<void> {
    await this.db.token_index
      .where('[kind+refId]')
      .equals(['artist', artistId])
      .delete();
    const tokens = uniqueTokens(name);
    if (tokens.length > 0) {
      await this.db.token_index.bulkAdd(
        tokens.map((token) => ({
          token,
          kind: 'artist' as const,
          refId: artistId,
        })),
      );
    }
  }

  /**
   * Bangun ulang seluruh indeks token dari tabel lagu dan artis.
   * Dipakai setelah impor massal bila indeks perlu diperbaiki.
   * Lagu diproses per batch 200 supaya memori tetap terbatas.
   */
  async rebuildTokenIndex(): Promise<void> {
    await this.db.transaction(
      'rw',
      [this.db.songs, this.db.artists, this.db.song_artists, this.db.token_index],
      async () => {
        await this.db.token_index.clear();
        let lastId = '';
        for (;;) {
          const batch = await this.db.songs
            .where('id')
            .above(lastId)
            .limit(200)
            .toArray();
          if (batch.length === 0) break;
          const views = await this.attachArtists(batch);
          for (const view of views) {
            await this.syncSongTokens(
              view.song.id,
              view.song.title,
              view.artistNames,
            );
          }
          lastId = batch[batch.length - 1]?.id ?? '';
        }
        const artists = await this.db.artists.toArray();
        for (const artist of artists) {
          await this.syncArtistTokens(artist.id, artist.name);
        }
      },
    );
    this.notify();
  }

  // ------------------------------------------------------------------
  // Baca lagu
  // ------------------------------------------------------------------

  /** Satu lagu beserta artisnya, atau null bila belum dikenal. */
  async songById(id: string): Promise<SongView | null> {
    const song = await this.db.songs.get(id);
    if (!song) return null;
    return (await this.attachArtists([song]))[0] ?? null;
  }

  /** Beberapa lagu sekaligus, urut sesuai `ids` (dipakai restore antrean). */
  async songsByIds(ids: string[]): Promise<SongView[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.songs.bulkGet(ids);
    const found = rows.filter((r): r is SongRow => r !== undefined);
    const views = await this.attachArtists(found);
    const byId = new Map(views.map((v) => [v.song.id, v]));
    const out: SongView[] = [];
    for (const id of ids) {
      const view = byId.get(id);
      if (view) out.push(view);
    }
    return out;
  }

  /** Halaman lagu Library (hanya `inLibrary = 1`). */
  async songsPage(opts: {
    sort?: SongSort;
    after?: SongView;
    limit?: number;
  }): Promise<SongView[]> {
    const sort = opts.sort ?? 'newest';
    const limit = opts.limit ?? PAGE_SIZE;
    const after = opts.after?.song;
    let rows: SongRow[];
    if (sort === 'newest') {
      const upper: [number, number, string] =
        after != null
          ? [1, after.dateAdded, after.id]
          : [1, MAX_NUMBER, MAX_STRING];
      rows = await this.db.songs
        .where('[inLibrary+dateAdded+id]')
        .between([1, 0, ''], upper, true, after == null)
        .reverse()
        .limit(limit)
        .toArray();
    } else if (sort === 'byName') {
      const lower: [number, string, string] =
        after != null
          ? [1, after.titleKey, after.id]
          : [1, '', ''];
      rows = await this.db.songs
        .where('[inLibrary+titleKey+id]')
        .between(lower, [1, MAX_STRING, MAX_STRING], after == null, true)
        .limit(limit)
        .toArray();
    } else {
      const upper: [number, number, string] =
        after != null
          ? [1, after.totalPlayTimeMs, after.id]
          : [1, MAX_NUMBER, MAX_STRING];
      rows = await this.db.songs
        .where('[inLibrary+totalPlayTimeMs+id]')
        .between([1, 0, ''], upper, true, after == null)
        .reverse()
        .limit(limit)
        .toArray();
    }
    return this.attachArtists(rows);
  }

  /** Halaman lagu favorit (playlist virtual Favorit). */
  async favoriteSongsPage(opts: {
    after?: SongView;
    limit?: number;
  }): Promise<SongView[]> {
    const limit = opts.limit ?? PAGE_SIZE;
    const after = opts.after?.song;
    const upper: [number, number, string] =
      after != null
        ? [1, after.dateAdded, after.id]
        : [1, MAX_NUMBER, MAX_STRING];
    const rows = await this.db.songs
      .where('[liked+dateAdded+id]')
      .between([1, 0, ''], upper, true, after == null)
      .reverse()
      .limit(limit)
      .toArray();
    return this.attachArtists(rows);
  }

  /** Halaman lagu satu artis, urut nama. */
  async songsByArtistPage(
    artistId: string,
    opts: { after?: SongView; limit?: number } = {},
  ): Promise<SongView[]> {
    const limit = opts.limit ?? PAGE_SIZE;
    const mappings = await this.db.song_artists
      .where('artistId')
      .equals(artistId)
      .toArray();
    if (mappings.length === 0) return [];
    const ids = mappings.map((m) => m.songId);
    const rows = await this.db.songs.bulkGet(ids);
    const found = rows.filter((r): r is SongRow => r !== undefined);
    // Urut nama di JS: lagu satu artis terbatas jumlahnya, dan
    // indeks gabungan (artis, judul) tidak ada di skema port.
    found.sort((a, b) => {
      if (a.titleKey !== b.titleKey) return a.titleKey < b.titleKey ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const after = opts.after?.song;
    const start = after
      ? found.findIndex(
          (s) =>
            s.titleKey > after.titleKey ||
            (s.titleKey === after.titleKey && s.id > after.id),
        )
      : 0;
    if (start === -1) return [];
    return this.attachArtists(found.slice(start, start + limit));
  }

  /** Halaman lagu satu album, urut nama. */
  async songsByAlbumPage(
    albumId: string,
    opts: { after?: SongView; limit?: number } = {},
  ): Promise<SongView[]> {
    const limit = opts.limit ?? PAGE_SIZE;
    const after = opts.after?.song;
    const lower: [string, string, string] =
      after != null
        ? [albumId, after.titleKey, after.id]
        : [albumId, '', ''];
    const rows = await this.db.songs
      .where('[albumId+titleKey+id]')
      .between(lower, [albumId, MAX_STRING, MAX_STRING], after == null, true)
      .limit(limit)
      .toArray();
    return this.attachArtists(rows);
  }

  /** Tempelkan nama artis ke daftar lagu (dua query, tanpa N+1). */
  private async attachArtists(songs: SongRow[]): Promise<SongView[]> {
    if (songs.length === 0) return [];
    const ids = songs.map((s) => s.id);
    const mappings = await this.db.song_artists
      .where('songId')
      .anyOf(ids)
      .toArray();
    const artistIds = [...new Set(mappings.map((m) => m.artistId))];
    const namesById = new Map<string, string>();
    if (artistIds.length > 0) {
      const artists = await this.db.artists.bulkGet(artistIds);
      for (const artist of artists) {
        if (artist) namesById.set(artist.id, artist.name);
      }
    }
    const grouped = new Map<string, Array<{ position: number; name: string }>>();
    for (const m of mappings) {
      const name = namesById.get(m.artistId);
      if (name == null) continue;
      const list = grouped.get(m.songId) ?? [];
      list.push({ position: m.position, name });
      grouped.set(m.songId, list);
    }
    return songs.map((song) => {
      const names = grouped.get(song.id) ?? [];
      names.sort((a, b) => a.position - b.position);
      return { song, artistNames: names.map((n) => n.name) };
    });
  }

  /** Hitungan isi library, untuk keputusan empty state. */
  async libraryCounts(): Promise<LibraryCounts> {
    const [songs, artists, albums, playlists, favorites, historyEntries] =
      await Promise.all([
        this.db.songs.where('inLibrary').equals(1).count(),
        this.db.artists.count(),
        this.db.albums.count(),
        this.db.playlists.count(),
        this.db.songs.where('liked').equals(1).count(),
        this.db.play_events.count(),
      ]);
    return { songs, artists, albums, playlists, favorites, historyEntries };
  }

  // ------------------------------------------------------------------
  // Favorit
  // ------------------------------------------------------------------

  /** Apakah lagu ini difavoritkan (false bila lagu belum dikenal). */
  async isLiked(songId: string): Promise<boolean> {
    const song = await this.db.songs.get(songId);
    return song?.liked === 1;
  }

  /**
   * Balik status favorit lagu. Menandai favorit juga memasukkan
   * lagu ke Library. Mengembalikan status baru. Lagu wajib sudah
   * ada di database; bila belum ada, melempar Error.
   */
  async toggleLiked(songId: string): Promise<boolean> {
    const song = await this.db.songs.get(songId);
    if (!song) {
      throw new Error(`toggleLiked: lagu ${songId} belum ada di database`);
    }
    const liked = song.liked === 1 ? 0 : 1;
    await this.db.songs.update(songId, {
      liked,
      ...(liked === 1 ? { inLibrary: 1 } : {}),
      dateModified: now(),
    });
    // Batal suka adalah penghapusan yang harus ikut tersinkron.
    if (liked === 0) await this.recordTombstone('like', songId);
    this.notify();
    return liked === 1;
  }

  /**
   * Keluarkan lagu dari Library: favorit mati, lagu keluar dari
   * semua playlist, `inLibrary` mati. Baris lagu dan riwayat
   * putarnya tetap ada. Penghapusan dicatat sebagai tombstone
   * sinkronisasi (kecuali bila `quiet`, jalur tarik server).
   */
  async removeFromLibrary(
    songId: string,
    opts: { quiet?: boolean } = {},
  ): Promise<void> {
    // Keanggotaan playlist + status suka dibaca dulu: sesudah
    // transaksi, keduanya sudah tidak bisa diketahui lagi.
    const memberships = opts.quiet
      ? []
      : await this.db.playlist_songs
          .where('songId')
          .equals(songId)
          .toArray();
    const wasLiked = opts.quiet
      ? false
      : (await this.db.songs.get(songId))?.liked === 1;
    await this.db.transaction(
      'rw',
      [this.db.playlist_songs, this.db.songs],
      async () => {
        await this.db.playlist_songs.where('songId').equals(songId).delete();
        await this.db.songs.update(songId, {
          liked: 0,
          inLibrary: 0,
          dateModified: now(),
        });
      },
    );
    if (!opts.quiet) {
      if (wasLiked) await this.recordTombstone('like', songId);
      for (const m of memberships) {
        const playlist = await this.db.playlists.get(m.playlistId);
        if (playlist?.clientId) {
          await this.recordTombstone(
            'playlist-item',
            `${playlist.clientId}:${songId}`,
          );
        }
      }
    }
    this.notify();
  }

  // ------------------------------------------------------------------
  // Artis dan album
  // ------------------------------------------------------------------

  /**
   * Halaman artis beserta jumlah lagu Library masing-masing, urut
   * nama. Hanya artis yang punya minimal satu lagu Library yang
   * tampil, supaya tab Artis tidak penuh baris "0 lagu".
   */
  async artistsPage(opts: {
    after?: ArtistWithCount;
    limit?: number;
  }): Promise<ArtistWithCount[]> {
    const limit = opts.limit ?? PAGE_SIZE;
    const out: ArtistWithCount[] = [];
    let lower: [string, string] =
      opts.after != null
        ? [opts.after.artist.nameKey, opts.after.artist.id]
        : ['', ''];
    let includeLower = opts.after == null;
    // Maju per batch sampai 50 artis berisi terkumpul atau habis.
    for (;;) {
      const batch = await this.db.artists
        .where('[nameKey+id]')
        .between(lower, [MAX_STRING, MAX_STRING], includeLower, true)
        .limit(limit)
        .toArray();
      if (batch.length === 0) break;
      for (const artist of batch) {
        const count = await this.librarySongCountForArtist(artist.id);
        if (count > 0) {
          out.push({ artist, songCount: count });
          if (out.length >= limit) return out;
        }
      }
      const last = batch[batch.length - 1];
      if (!last || batch.length < limit) break;
      lower = [last.nameKey, last.id];
      includeLower = false;
    }
    return out;
  }

  /** Halaman album beserta jumlah lagu Library masing-masing. */
  async albumsPage(opts: {
    after?: AlbumWithCount;
    limit?: number;
  }): Promise<AlbumWithCount[]> {
    const limit = opts.limit ?? PAGE_SIZE;
    const out: AlbumWithCount[] = [];
    let lower: [string, string] =
      opts.after != null
        ? [opts.after.album.titleKey, opts.after.album.id]
        : ['', ''];
    let includeLower = opts.after == null;
    for (;;) {
      const batch = await this.db.albums
        .where('[titleKey+id]')
        .between(lower, [MAX_STRING, MAX_STRING], includeLower, true)
        .limit(limit)
        .toArray();
      if (batch.length === 0) break;
      for (const album of batch) {
        const count = await this.db.songs
          .where('[albumId+titleKey+id]')
          .between([album.id, '', ''], [album.id, MAX_STRING, MAX_STRING])
          .filter((s) => s.inLibrary === 1)
          .count();
        if (count > 0) {
          out.push({ album, songCount: count });
          if (out.length >= limit) return out;
        }
      }
      const last = batch[batch.length - 1];
      if (!last || batch.length < limit) break;
      lower = [last.titleKey, last.id];
      includeLower = false;
    }
    return out;
  }

  private async librarySongCountForArtist(artistId: string): Promise<number> {
    const mappings = await this.db.song_artists
      .where('artistId')
      .equals(artistId)
      .toArray();
    if (mappings.length === 0) return 0;
    const rows = await this.db.songs.bulkGet(
      mappings.map((m) => m.songId),
    );
    return rows.filter((r) => r?.inLibrary === 1).length;
  }

  async artistById(id: string): Promise<ArtistRow | null> {
    return (await this.db.artists.get(id)) ?? null;
  }

  async albumById(id: string): Promise<AlbumRow | null> {
    return (await this.db.albums.get(id)) ?? null;
  }

  /**
   * Gabungkan artis id semu (`local-<hash nama>`) ke channelId
   * YTM aslinya (P4). Pemetaan lagu artis semu dipindah ke baris
   * channelId, baris artis semu dihapus, indeks token diperbarui.
   */
  async mergeArtistChannel(opts: {
    name: string;
    channelId: string;
    thumbnailUrl?: string;
  }): Promise<void> {
    const name = opts.name.trim();
    const channelId = opts.channelId.trim();
    if (name.length === 0 || channelId.length === 0) return;
    const pseudoId = localArtistIdForName(name);
    if (pseudoId === channelId) return;
    const at = now();
    await this.db.transaction(
      'rw',
      [this.db.artists, this.db.song_artists, this.db.token_index],
      async () => {
        const existing = await this.db.artists.get(channelId);
        if (!existing) {
          await this.db.artists.add({
            id: channelId,
            name,
            nameKey: name.toLowerCase(),
            thumbnailUrl: opts.thumbnailUrl ?? null,
            liked: 0,
            dateAdded: at,
          });
        } else if (
          opts.thumbnailUrl &&
          opts.thumbnailUrl.length > 0 &&
          !existing.thumbnailUrl
        ) {
          await this.db.artists.update(channelId, {
            thumbnailUrl: opts.thumbnailUrl,
          });
        }
        const mappings = await this.db.song_artists
          .where('artistId')
          .equals(pseudoId)
          .toArray();
        for (const mapping of mappings) {
          await this.db.song_artists
            .add({
              songId: mapping.songId,
              artistId: channelId,
              position: mapping.position,
            })
            .catch(() => {
              // Duplikat posisi diabaikan (sudah ada).
            });
        }
        await this.db.song_artists
          .where('artistId')
          .equals(pseudoId)
          .delete();
        await this.db.artists.delete(pseudoId);
        await this.syncArtistTokens(channelId, name);
        await this.db.token_index
          .where('[kind+refId]')
          .equals(['artist', pseudoId])
          .delete();
      },
    );
    this.notify();
  }

  // ------------------------------------------------------------------
  // Playlist
  // ------------------------------------------------------------------

  /**
   * Buat playlist baru. Nama wajib tidak kosong dan paling panjang
   * 100 karakter; deskripsi paling panjang 500 karakter.
   * Mengembalikan id playlist. Melempar Error bila validasi gagal.
   */
  async createPlaylist(
    name: string,
    opts: { description?: string | null } = {},
  ): Promise<number> {
    const trimmed = name.trim();
    validatePlaylistName(trimmed);
    validatePlaylistDescription(opts.description ?? null);
    const at = now();
    const id = await this.db.playlists.add({
      name: trimmed,
      description: opts.description?.trim() ?? null,
      browseId: null,
      thumbnailUrl: null,
      createdAt: at,
      updatedAt: at,
    });
    this.notify();
    return id as number;
  }

  /** Ubah nama playlist (validasi sama seperti createPlaylist). */
  async renamePlaylist(id: number, name: string): Promise<void> {
    const trimmed = name.trim();
    validatePlaylistName(trimmed);
    await this.db.playlists.update(id, {
      name: trimmed,
      updatedAt: now(),
    });
    this.notify();
  }

  /** Ubah deskripsi playlist (null berarti kosongkan deskripsi). */
  async updatePlaylistDescription(
    id: number,
    description: string | null,
  ): Promise<void> {
    validatePlaylistDescription(description);
    await this.db.playlists.update(id, {
      description: description?.trim() ?? null,
      updatedAt: now(),
    });
    this.notify();
  }

  /**
   * Hapus playlist. Lagu di dalamnya ikut terhapus dari playlist;
   * lagu di Library tidak ikut terhapus. Penghapusan dicatat
   * sebagai tombstone sinkronisasi bila playlist punya clientId
   * (pernah disinkronkan), kecuali bila `quiet` (jalur tarik).
   */
  async deletePlaylist(
    id: number,
    opts: { quiet?: boolean } = {},
  ): Promise<void> {
    const playlist = opts.quiet ? null : await this.db.playlists.get(id);
    await this.db.transaction(
      'rw',
      [this.db.playlists, this.db.playlist_songs],
      async () => {
        await this.db.playlist_songs
          .where('[playlistId+position]')
          .between([id, 0], [id, MAX_NUMBER])
          .delete();
        await this.db.playlists.delete(id);
      },
    );
    if (playlist?.clientId) {
      await this.recordTombstone('playlist', playlist.clientId);
    }
    this.notify();
  }

  async playlistById(id: number): Promise<PlaylistRow | null> {
    return (await this.db.playlists.get(id)) ?? null;
  }

  /** Halaman playlist beserta jumlah lagu, urut terakhir diubah dulu. */
  async playlistsPage(opts: {
    after?: PlaylistWithCount;
    limit?: number;
  }): Promise<PlaylistWithCount[]> {
    const limit = opts.limit ?? PAGE_SIZE;
    const after = opts.after?.playlist;
    const upper: [number, number] =
      after != null ? [after.updatedAt, after.id] : [MAX_NUMBER, MAX_NUMBER];
    const rows = await this.db.playlists
      .where('[updatedAt+id]')
      .between([0, 0], upper, true, after == null)
      .reverse()
      .limit(limit)
      .toArray();
    if (rows.length === 0) return [];
    const out: PlaylistWithCount[] = [];
    for (const playlist of rows) {
      const songCount = await this.db.playlist_songs
        .where('[playlistId+position]')
        .between([playlist.id, 0], [playlist.id, MAX_NUMBER])
        .count();
      out.push({ playlist, songCount });
    }
    return out;
  }

  /**
   * Tambahkan lagu ke playlist. Lagu yang sama tidak bisa
   * ditambahkan dua kali (mengembalikan false). Menambahkan lagu
   * juga memasukkannya ke Library. Mengembalikan true bila lagu
   * benar-benar ditambahkan.
   */
  async addSongToPlaylist(
    playlistId: number,
    songId: string,
  ): Promise<boolean> {
    return this.db.transaction(
      'rw',
      [this.db.playlist_songs, this.db.songs, this.db.playlists],
      async () => {
        const existing = await this.db.playlist_songs.get([
          playlistId,
          songId,
        ]);
        if (existing) return false;
        const count = await this.db.playlist_songs
          .where('[playlistId+position]')
          .between([playlistId, 0], [playlistId, MAX_NUMBER])
          .count();
        if (count >= MAX_PLAYLIST_SONGS) return false;
        const position = await this.nextPlaylistPosition(playlistId);
        const at = now();
        await this.db.playlist_songs.add({
          playlistId,
          songId,
          position,
          dateAdded: at,
        });
        await this.db.songs.update(songId, { inLibrary: 1 });
        await this.touchPlaylist(playlistId, at);
        return true;
      },
    ).then((added) => {
      if (added) this.notify();
      return added;
    });
  }

  /** Tambahkan beberapa lagu sekaligus (duplikat dilewati). */
  async addSongsToPlaylist(
    playlistId: number,
    songIds: string[],
  ): Promise<number> {
    let added = 0;
    for (const songId of songIds) {
      if (await this.addSongToPlaylist(playlistId, songId)) added++;
    }
    return added;
  }

  /**
   * Keluarkan lagu dari playlist. Posisi lagu lain dirapatkan
   * kembali (0..n-1 tanpa lubang).
   */
  async removeSongFromPlaylist(
    playlistId: number,
    songId: string,
    opts: { quiet?: boolean } = {},
  ): Promise<void> {
    const playlist = opts.quiet
      ? null
      : await this.db.playlists.get(playlistId);
    await this.db.transaction(
      'rw',
      [this.db.playlist_songs, this.db.playlists],
      async () => {
        await this.db.playlist_songs.delete([playlistId, songId]);
        await this.renumberPlaylist(playlistId);
        await this.touchPlaylist(playlistId, now());
      },
    );
    if (playlist?.clientId) {
      await this.recordTombstone(
        'playlist-item',
        `${playlist.clientId}:${songId}`,
      );
    }
    this.notify();
  }

  /** Pindahkan lagu ke posisi baru di playlist (posisi dijepit). */
  async moveSongInPlaylist(
    playlistId: number,
    songId: string,
    newPosition: number,
  ): Promise<void> {
    await this.db.transaction(
      'rw',
      [this.db.playlist_songs, this.db.playlists],
      async () => {
        const rows = await this.db.playlist_songs
          .where('[playlistId+position]')
          .between([playlistId, 0], [playlistId, MAX_NUMBER])
          .toArray();
        const ids = rows.map((r) => r.songId);
        const from = ids.indexOf(songId);
        if (from === -1) return;
        ids.splice(from, 1);
        const to = Math.min(Math.max(0, newPosition), ids.length);
        ids.splice(to, 0, songId);
        for (let i = 0; i < ids.length; i++) {
          await this.db.playlist_songs.update([playlistId, ids[i] as string], {
            position: i,
          });
        }
        await this.touchPlaylist(playlistId, now());
      },
    );
    this.notify();
  }

  /** Halaman lagu satu playlist, urut posisi. */
  async playlistSongsPage(
    playlistId: number,
    opts: { after?: PlaylistSongEntry; limit?: number } = {},
  ): Promise<PlaylistSongEntry[]> {
    const limit = opts.limit ?? PAGE_SIZE;
    const lower: [number, number] =
      opts.after != null
        ? [playlistId, opts.after.position]
        : [playlistId, -1];
    const rows = await this.db.playlist_songs
      .where('[playlistId+position]')
      .between(lower, [playlistId, MAX_NUMBER], opts.after == null, true)
      .limit(limit)
      .toArray();
    if (rows.length === 0) return [];
    const views = await this.songsByIds(rows.map((r) => r.songId));
    const byId = new Map(views.map((v) => [v.song.id, v]));
    const out: PlaylistSongEntry[] = [];
    for (const row of rows) {
      const view = byId.get(row.songId);
      if (view) {
        out.push({ song: view, position: row.position, dateAdded: row.dateAdded });
      }
    }
    return out;
  }

  /**
   * Lagu playlist untuk diputar: paling banyak `limit` lagu, mulai
   * dari `startSongId` bila diberikan. Batas mengikuti antrean
   * pemutar (200 lagu).
   */
  async playlistSongsForPlayback(
    playlistId: number,
    opts: { startSongId?: string; limit?: number } = {},
  ): Promise<SongView[]> {
    const limit = opts.limit ?? 200;
    let startPosition = 0;
    if (opts.startSongId) {
      const start = await this.db.playlist_songs.get([
        playlistId,
        opts.startSongId,
      ]);
      if (start) startPosition = start.position;
    }
    const rows = await this.db.playlist_songs
      .where('[playlistId+position]')
      .between([playlistId, startPosition], [playlistId, MAX_NUMBER])
      .limit(limit)
      .toArray();
    if (rows.length === 0) return [];
    return this.songsByIds(rows.map((r) => r.songId));
  }

  private async nextPlaylistPosition(playlistId: number): Promise<number> {
    const last = await this.db.playlist_songs
      .where('[playlistId+position]')
      .between([playlistId, 0], [playlistId, MAX_NUMBER])
      .reverse()
      .limit(1)
      .toArray();
    return (last[0]?.position ?? -1) + 1;
  }

  private async renumberPlaylist(playlistId: number): Promise<void> {
    const rows = await this.db.playlist_songs
      .where('[playlistId+position]')
      .between([playlistId, 0], [playlistId, MAX_NUMBER])
      .toArray();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row && row.position !== i) {
        await this.db.playlist_songs.update([playlistId, row.songId], {
          position: i,
        });
      }
    }
  }

  private async touchPlaylist(playlistId: number, at: number): Promise<void> {
    await this.db.playlists.update(playlistId, { updatedAt: at });
  }

  // ------------------------------------------------------------------
  // Riwayat putar
  // ------------------------------------------------------------------

  /**
   * Catat satu sesi putar: simpan event, tambahkan durasi ke total
   * waktu putar lagu, lalu pangkas riwayat ke MAX_PLAY_EVENTS.
   * Pemanggil memastikan hanya sesi yang memenuhi ambang PRD
   * B2.7 (10 detik atau sampai selesai) yang dicatat.
   */
  async recordPlay(opts: {
    songId: string;
    timestamp: number;
    playTimeMs: number;
  }): Promise<void> {
    await this.db.transaction(
      'rw',
      [this.db.play_events, this.db.songs],
      async () => {
        await this.db.play_events.add({
          songId: opts.songId,
          timestamp: opts.timestamp,
          playTimeMs: opts.playTimeMs,
        });
        const song = await this.db.songs.get(opts.songId);
        if (song) {
          await this.db.songs.update(opts.songId, {
            totalPlayTimeMs: song.totalPlayTimeMs + opts.playTimeMs,
          });
        }
        const count = await this.db.play_events.count();
        if (count > MAX_PLAY_EVENTS) {
          const excess = count - MAX_PLAY_EVENTS;
          const oldest = await this.db.play_events
            .orderBy('[timestamp+id]')
            .limit(excess)
            .toArray();
          await this.db.play_events.bulkDelete(
            oldest.map((e) => e.id),
          );
        }
      },
    );
    this.notify();
  }

  /** Halaman riwayat putar, terbaru dulu. */
  async historyPage(opts: {
    after?: PlayHistoryEntry;
    limit?: number;
  }): Promise<PlayHistoryEntry[]> {
    const limit = opts.limit ?? PAGE_SIZE;
    const after = opts.after?.event;
    const upper: [number, number] =
      after != null ? [after.timestamp, after.id] : [MAX_NUMBER, MAX_NUMBER];
    const events = await this.db.play_events
      .where('[timestamp+id]')
      .between([0, 0], upper, true, after == null)
      .reverse()
      .limit(limit)
      .toArray();
    if (events.length === 0) return [];
    const ids = [...new Set(events.map((e) => e.songId))];
    const views = await this.songsByIds(ids);
    const byId = new Map(views.map((v) => [v.song.id, v]));
    const out: PlayHistoryEntry[] = [];
    for (const event of events) {
      const song = byId.get(event.songId);
      if (song) out.push({ event, song });
    }
    return out;
  }

  /**
   * Lagu yang baru diputar, tanpa duplikat: tiap lagu tampil sekali,
   * di posisi putaran terakhirnya (seksi "Baru diputar" P4).
   */
  async recentPlayedSongs(opts: { limit?: number } = {}): Promise<SongView[]> {
    const limit = opts.limit ?? 10;
    const seen = new Set<string>();
    const ids: string[] = [];
    // Iterasi kursor berhenti begitu `limit` lagu unik terkumpul,
    // jadi riwayat 10.000 entri tidak pernah dimuat seluruhnya.
    await this.db.play_events
      .orderBy('[timestamp+id]')
      .reverse()
      .each((event) => {
        if (seen.has(event.songId)) return;
        seen.add(event.songId);
        ids.push(event.songId);
        if (ids.length >= limit) return false;
      });
    if (ids.length === 0) return [];
    return this.songsByIds(ids);
  }

  /**
   * Hapus seluruh riwayat putar. Total waktu putar lagu TIDAK
   * direset (agregat seumur hidup yang menggerakkan urutan
   * "Sering diputar"). Penanda hapus dicatat di app_meta supaya
   * sinkronisasi ikut menghapus riwayat di server (bila tidak,
   * riwayat server akan bangkit lagi di tarik berikutnya).
   */
  async clearHistory(): Promise<void> {
    await this.db.play_events.clear();
    await this.setMeta(
      SYNC_HISTORY_CLEARED_KEY,
      String(now()),
    );
    this.notify();
  }

  /** Jumlah putaran bermakna (30 detik atau lebih) satu lagu. */
  async meaningfulPlayCount(
    songId: string,
    opts: { withinMs?: number } = {},
  ): Promise<number> {
    const since = now() - (opts.withinMs ?? 30 * 24 * 60 * 60 * 1000);
    return this.db.play_events
      .where('songId')
      .equals(songId)
      .filter((e) => e.playTimeMs >= MEANINGFUL_PLAY_MS && e.timestamp >= since)
      .count();
  }

  /**
   * "Lagu untukmu" (PRD B6.2): skor putaran bermakna 30 hari
   * terakhir + 5 bila favorit + 2 bila diunduh, 20 teratas,
   * diisi lagu library terbaru bila kurang. Dihitung dari satu
   * query rentang indeks (hanya event 30 hari terakhir) +
   * kunci favorit/unduhan — riwayat putar penuh tidak pernah
   * dimuat ke memori. Tanpa nama artis, genre, kesamaan audio,
   * dan tanpa machine learning. Bila library kosong, hasilnya
   * kosong (seksi tidak tampil).
   */
  async forYouSongs(opts: { limit?: number } = {}): Promise<SongView[]> {
    const limit = opts.limit ?? FOR_YOU_LIMIT;
    const since = now() - FOR_YOU_WINDOW_MS;
    const events = await this.db.play_events
      .where('[timestamp+id]')
      .above([since, 0])
      .toArray();
    const bySong = new Map<
      string,
      { meaningful: number; lastPlayedAt: number }
    >();
    for (const event of events) {
      const agg = bySong.get(event.songId) ?? {
        meaningful: 0,
        lastPlayedAt: 0,
      };
      if (event.playTimeMs >= MEANINGFUL_PLAY_MS) agg.meaningful += 1;
      if (event.timestamp > agg.lastPlayedAt) {
        agg.lastPlayedAt = event.timestamp;
      }
      bySong.set(event.songId, agg);
    }
    const likedIds = await this.db.songs
      .where('liked')
      .equals(1)
      .primaryKeys();
    const downloadedIds = await this.db.songs
      .where('downloadState')
      .equals(DownloadState.downloaded)
      .primaryKeys();
    const liked = new Set(likedIds);
    const downloaded = new Set(downloadedIds);
    const ids = new Set([...bySong.keys(), ...liked, ...downloaded]);
    const candidates: ForYouCandidate[] = [...ids].map((songId) => {
      const agg = bySong.get(songId);
      return {
        songId,
        meaningfulPlays: agg?.meaningful ?? 0,
        lastPlayedAt: agg?.lastPlayedAt ?? 0,
        liked: liked.has(songId),
        downloaded: downloaded.has(songId),
      };
    });
    let rankedIds = rankForYou(candidates, limit).map((c) => c.songId);
    // Isi sisa dengan lagu library terbaru (halaman keyset sampai
    // penuh atau habis; lagu yang sudah terpilih dilewati).
    if (rankedIds.length < limit) {
      let after: SongView | undefined;
      while (rankedIds.length < limit) {
        const page = await this.songsPage({
          sort: 'newest',
          limit: PAGE_SIZE,
          after,
        });
        if (page.length === 0) break;
        rankedIds = fillForYou(
          rankedIds,
          page.map((v) => v.song.id),
          limit,
        );
        after = page[page.length - 1];
      }
    }
    if (rankedIds.length === 0) return [];
    return this.songsByIds(rankedIds);
  }

  // ------------------------------------------------------------------
  // Pencarian lokal (indeks token)
  // ------------------------------------------------------------------

  /**
   * Cari lagu dan artis di dalam database (bukan hanya Library:
   * lagu yang pernah diputar tapi belum disimpan ikut ditemukan).
   * Semua kata kunci wajib cocok (AND), tiap kata memakai awalan.
   * Bila AND tidak menemukan apa pun, dicoba OR. Port APK.
   */
  async searchLocal(
    query: string,
    opts: { limit?: number } = {},
  ): Promise<LocalSearchResults> {
    const limit = opts.limit ?? PAGE_SIZE;
    const tokens = tokenize(query);
    if (tokens.length === 0) return { songs: [], artists: [] };
    let mode: 'and' | 'or' = 'and';
    let songIds = await this.refIdsForTokens(tokens, 'song', 'and');
    let artistIds = await this.refIdsForTokens(tokens, 'artist', 'and');
    if (songIds.length === 0 && artistIds.length === 0) {
      mode = 'or';
      songIds = await this.refIdsForTokens(tokens, 'song', 'or');
      artistIds = await this.refIdsForTokens(tokens, 'artist', 'or');
    }
    const songs = await this.rankSongs(songIds, tokens, limit, mode);
    const artists = await this.rankArtists(artistIds, tokens, limit, mode);
    return { songs, artists };
  }

  private async refIdsForTokens(
    tokens: string[],
    kind: 'song' | 'artist',
    mode: 'and' | 'or',
  ): Promise<string[]> {
    const sets: Array<Set<string>> = [];
    for (const token of tokens) {
      const rows = await this.db.token_index
        .where('token')
        .between(token, prefixUpperBound(token), true, true)
        .filter((r) => r.kind === kind)
        .toArray();
      sets.push(new Set(rows.map((r) => r.refId)));
    }
    if (mode === 'or') {
      const union = new Set<string>();
      for (const set of sets) for (const id of set) union.add(id);
      return [...union];
    }
    let out = sets[0] ?? new Set<string>();
    for (const set of sets.slice(1)) {
      out = new Set([...out].filter((id) => set.has(id)));
      if (out.size === 0) break;
    }
    return [...out];
  }

  private async rankSongs(
    ids: string[],
    queryTokens: string[],
    limit: number,
    mode: 'and' | 'or',
  ): Promise<SongView[]> {
    if (ids.length === 0) return [];
    const views = await this.songsByIds(ids);
    const scored = views
      .map((view) => ({
        view,
        score: scoreCandidate(
          queryTokens,
          tokenize(view.song.title),
          tokenize(view.artistNames.join(' ')),
          mode,
        ),
      }))
      .filter((s) => s.score > 0);
    scored.sort((a, b) =>
      compareSearchCandidates(
        { score: a.score, titleKey: a.view.song.titleKey, id: a.view.song.id },
        { score: b.score, titleKey: b.view.song.titleKey, id: b.view.song.id },
      ),
    );
    return scored.slice(0, limit).map((s) => s.view);
  }

  private async rankArtists(
    ids: string[],
    queryTokens: string[],
    limit: number,
    mode: 'and' | 'or',
  ): Promise<ArtistRow[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.artists.bulkGet(ids);
    const found = rows.filter((r): r is ArtistRow => r !== undefined);
    const scored = found
      .map((artist) => ({
        artist,
        score: scoreCandidate(queryTokens, tokenize(artist.name), [], mode),
      }))
      .filter((s) => s.score > 0);
    scored.sort((a, b) =>
      compareSearchCandidates(
        { score: a.score, titleKey: a.artist.nameKey, id: a.artist.id },
        { score: b.score, titleKey: b.artist.nameKey, id: b.artist.id },
      ),
    );
    return scored.slice(0, limit).map((s) => s.artist);
  }

  // ------------------------------------------------------------------
  // Riwayat pencarian
  // ------------------------------------------------------------------

  /**
   * Simpan query pencarian (query sama tidak diduplikasi: baris
   * lama dihapus lalu disisip baru supaya naik ke atas daftar).
   * Dedup tidak membedakan kapitalisasi; ejaan yang tersimpan
   * adalah ejaan terakhir yang diketik pengguna.
   */
  async addSearchQuery(query: string): Promise<void> {
    const trimmed = query.trim();
    if (trimmed.length === 0) return;
    const at = now();
    await this.db.transaction('rw', [this.db.search_history], async () => {
      await this.db.search_history
        .where('queryLower')
        .equals(trimmed.toLowerCase())
        .delete();
      await this.db.search_history.add({
        query: trimmed,
        queryLower: trimmed.toLowerCase(),
        timestamp: at,
      });
      const count = await this.db.search_history.count();
      if (count > MAX_SEARCH_HISTORY) {
        const excess = count - MAX_SEARCH_HISTORY;
        const oldest = await this.db.search_history
          .orderBy('[timestamp+query]')
          .limit(excess)
          .toArray();
        await this.db.search_history.bulkDelete(
          oldest.map((q) => q.query),
        );
      }
    });
    this.notify();
  }

  /** Query pencarian terbaru dulu. */
  async recentSearches(opts: { limit?: number } = {}): Promise<string[]> {
    const rows = await this.db.search_history
      .orderBy('[timestamp+query]')
      .reverse()
      .limit(opts.limit ?? 10)
      .toArray();
    return rows.map((r) => r.query);
  }

  /** Query riwayat yang diawali `prefix`, terbaru dulu (saran lokal). */
  async searchHistoryMatching(
    prefix: string,
    opts: { limit?: number } = {},
  ): Promise<string[]> {
    const trimmed = prefix.trim().toLowerCase();
    if (trimmed.length === 0) return [];
    const rows = await this.db.search_history
      .where('queryLower')
      .between(trimmed, prefixUpperBound(trimmed), true, true)
      .toArray();
    rows.sort((a, b) => {
      if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
      return a.query < b.query ? 1 : a.query > b.query ? -1 : 0;
    });
    return rows.slice(0, opts.limit ?? 8).map((r) => r.query);
  }

  /** Hapus satu query dari riwayat pencarian. */
  async deleteSearchQuery(query: string): Promise<void> {
    await this.db.search_history.delete(query);
    this.notify();
  }

  /** Hapus seluruh riwayat pencarian. */
  async clearSearchHistory(): Promise<void> {
    await this.db.search_history.clear();
    this.notify();
  }

  // ------------------------------------------------------------------
  // Antrean tersimpan
  // ------------------------------------------------------------------

  /** Ganti seluruh antrean tersimpan (dipakai pemutar saat berubah). */
  async replaceQueue(
    items: Array<{ songId: string; source: string | null; kind: 'stream' | 'local' }>,
  ): Promise<void> {
    await this.db.transaction('rw', [this.db.queue_items], async () => {
      await this.db.queue_items.clear();
      if (items.length > 0) {
        await this.db.queue_items.bulkAdd(
          items.map((item, position) => ({ ...item, position })),
        );
      }
    });
    this.notify();
  }

  /** Muat antrean tersimpan, urut posisi. */
  async loadQueue(): Promise<
    Array<{ position: number; songId: string; source: string | null; kind: 'stream' | 'local' }>
  > {
    return this.db.queue_items.orderBy('position').toArray();
  }

  /** Kosongkan antrean tersimpan. */
  async clearQueue(): Promise<void> {
    await this.db.queue_items.clear();
    this.notify();
  }

  // ------------------------------------------------------------------
  // Lirik (P7 mengisi tabel ini; P3 menyediakan aksesnya)
  // ------------------------------------------------------------------

  /** Lirik tersimpan satu lagu, atau null bila belum pernah diambil. */
  async getLyrics(songId: string): Promise<{
    lyrics: string;
    syncedLyrics: string | null;
    source: 'lrclib' | 'ovh' | null;
  } | null> {
    const row = await this.db.lyrics.get(songId);
    if (!row) return null;
    return {
      lyrics: row.lyrics,
      syncedLyrics: row.syncedLyrics,
      source: row.source ?? null,
    };
  }

  /**
   * Simpan lirik lagu (sisip atau ganti). Menolak lirik di atas
   * 256 KB per kolom (port R3-L1 APK). `source` dicatat untuk
   * atribusi yang jujur saat lirik dibaca dari cache.
   */
  async saveLyrics(opts: {
    songId: string;
    lyrics: string;
    syncedLyrics?: string | null;
    source?: 'lrclib' | 'ovh';
  }): Promise<boolean> {
    const encoder = new TextEncoder();
    if (encoder.encode(opts.lyrics).length > MAX_LYRICS_BYTES) return false;
    if (
      opts.syncedLyrics != null &&
      encoder.encode(opts.syncedLyrics).length > MAX_LYRICS_BYTES
    ) {
      return false;
    }
    await this.db.lyrics.put({
      songId: opts.songId,
      lyrics: opts.lyrics,
      syncedLyrics: opts.syncedLyrics ?? null,
      fetchedAt: now(),
      source: opts.source ?? null,
    });
    this.notify();
    return true;
  }

  // ------------------------------------------------------------------
  // Status pemutar (MUST #3)
  // ------------------------------------------------------------------

  /** Status pemutar terakhir (satu baris, id 1), atau null. */
  async loadPlaybackState(): Promise<{
    currentIndex: number;
    positionMs: number;
    shuffleEnabled: boolean;
    repeatMode: number;
    order: number[];
    rate: number;
    volume: number;
  } | null> {
    const row = await this.db.playback_state.get(1);
    if (!row) return null;
    return {
      currentIndex: row.currentIndex,
      positionMs: row.positionMs,
      shuffleEnabled: row.shuffleEnabled === 1,
      repeatMode: row.repeatMode,
      order: row.order,
      rate: row.rate,
      volume: row.volume,
    };
  }

  /** Simpan status pemutar penuh (sisip atau ganti baris id 1). */
  async savePlaybackState(opts: {
    currentIndex: number;
    positionMs: number;
    shuffleEnabled: boolean;
    repeatMode: number;
    order: number[];
    rate: number;
    volume: number;
  }): Promise<void> {
    await this.db.playback_state.put({
      id: 1,
      currentIndex: opts.currentIndex,
      positionMs: opts.positionMs,
      shuffleEnabled: opts.shuffleEnabled ? 1 : 0,
      repeatMode: opts.repeatMode,
      order: opts.order,
      rate: opts.rate,
      volume: opts.volume,
      updatedAt: now(),
    });
  }

  /** Perbarui posisi saja, mempertahankan indeks/mode tersimpan. */
  async savePlaybackPosition(positionMs: number): Promise<void> {
    const existing = await this.db.playback_state.get(1);
    if (!existing) {
      await this.db.playback_state.put({
        id: 1,
        currentIndex: 0,
        positionMs,
        shuffleEnabled: 0,
        repeatMode: 0,
        order: [],
        rate: 1,
        volume: 1,
        updatedAt: now(),
      });
      return;
    }
    await this.db.playback_state.update(1, {
      positionMs,
      updatedAt: now(),
    });
  }

  /** Hapus status pemutar tersimpan (antrean dikosongkan). */
  async clearPlaybackState(): Promise<void> {
    await this.db.playback_state.delete(1);
  }

  // ------------------------------------------------------------------
  // Unduhan (P5 mengisi; P3 menyediakan akses + port APK)
  // ------------------------------------------------------------------

  /** Lagu terunduh, urut file terbesar dulu. */
  async downloadedSongs(opts: { limit?: number } = {}): Promise<SongView[]> {
    const rows = await this.db.songs
      .where('downloadState')
      .equals(DownloadState.downloaded)
      .toArray();
    rows.sort((a, b) => {
      const sizeA = a.fileSizeBytes ?? 0;
      const sizeB = b.fileSizeBytes ?? 0;
      if (sizeA !== sizeB) return sizeB - sizeA;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return this.attachArtists(rows.slice(0, opts.limit ?? 10));
  }

  /**
   * Semua lagu terunduh, urut unduhan terbaru dulu (layar
   * Penyimpanan P5). Berbeda dengan `downloadedSongs` (urut
   * ukuran, batas 10 untuk seksi beranda).
   */
  async downloadedSongsList(): Promise<SongView[]> {
    const rows = await this.db.songs
      .where('downloadState')
      .equals(DownloadState.downloaded)
      .toArray();
    rows.sort((a, b) => {
      const dateA = a.downloadedAt ?? 0;
      const dateB = b.downloadedAt ?? 0;
      if (dateA !== dateB) return dateB - dateA;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return this.attachArtists(rows);
  }

  /** Daftar ringan semua file unduhan (rekonsiliasi saat start). */
  async downloadedFiles(): Promise<
    Array<{ songId: string; filePath: string | null; fileSizeBytes: number | null }>
  > {
    const rows = await this.db.songs
      .where('downloadState')
      .equals(DownloadState.downloaded)
      .toArray();
    return rows.map((r) => ({
      songId: r.id,
      filePath: r.filePath,
      fileSizeBytes: r.fileSizeBytes,
    }));
  }

  /** Tandai lagu sebagai terunduh (file sudah ditulis, ukuran cocok). */
  async markDownloaded(opts: {
    songId: string;
    filePath: string;
    fileSizeBytes: number;
    formatId?: string | null;
  }): Promise<void> {
    await this.db.songs.update(opts.songId, {
      downloadState: DownloadState.downloaded,
      filePath: opts.filePath,
      fileSizeBytes: opts.fileSizeBytes,
      downloadedAt: now(),
      formatId: opts.formatId ?? null,
      inLibrary: 1,
      unplayable: 0,
      dateModified: now(),
    });
    this.notify();
  }

  /** Kosongkan status unduhan lagu (file hilang/rusak/dihapus). */
  async clearDownloadState(songId: string): Promise<void> {
    await this.db.songs.update(songId, {
      downloadState: DownloadState.notDownloaded,
      filePath: null,
      fileSizeBytes: null,
      downloadedAt: null,
      formatId: null,
      dateModified: now(),
    });
    this.notify();
  }

  /** Ubah status unduhan lagu saja. */
  async setDownloadState(songId: string, state: number): Promise<void> {
    await this.db.songs.update(songId, {
      downloadState: state,
      dateModified: now(),
    });
    this.notify();
  }

  /** Apakah lagu sudah terunduh (file lokal tersedia). */
  async isDownloaded(songId: string): Promise<boolean> {
    const song = await this.db.songs.get(songId);
    return (
      song != null &&
      song.downloadState === DownloadState.downloaded &&
      song.filePath != null
    );
  }

  /** Semua pekerjaan unduhan, urut dibuat dulu (null = paling tua). */
  async downloadJobs(): Promise<
    Array<{
      songId: string;
      status: number;
      quality: number | null;
      bytesDownloaded: number;
      totalBytes: number | null;
      attempts: number;
      errorMessage: string | null;
      createdAt: number | null;
      updatedAt: number;
    }>
  > {
    const rows = await this.db.download_jobs.toArray();
    rows.sort((a, b) => {
      const ca = a.createdAt ?? 0;
      const cb = b.createdAt ?? 0;
      if (ca !== cb) return ca - cb;
      return a.songId < b.songId ? -1 : a.songId > b.songId ? 1 : 0;
    });
    return rows;
  }

  async downloadJobBySongId(songId: string): Promise<{
    songId: string;
    status: number;
    quality: number | null;
    bytesDownloaded: number;
    totalBytes: number | null;
    attempts: number;
    errorMessage: string | null;
    createdAt: number | null;
    updatedAt: number;
  } | null> {
    const row = await this.db.download_jobs.get(songId);
    if (!row) return null;
    return {
      songId: row.songId,
      status: row.status,
      quality: row.quality,
      bytesDownloaded: row.bytesDownloaded,
      totalBytes: row.totalBytes,
      attempts: row.attempts,
      errorMessage: row.errorMessage,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Perbarui sebagian kolom pekerjaan unduhan (progres per chunk,
   * status, pesan galat). Berbeda dengan upsert: kolom yang tidak
   * disebut TIDAK berubah (upsert menimpa quality dan kawan-kawan
   * dengan null bila tidak disebut).
   */
  async updateDownloadJob(
    songId: string,
    patch: Partial<{
      status: number;
      quality: number | null;
      bytesDownloaded: number;
      totalBytes: number | null;
      attempts: number;
      errorMessage: string | null;
    }>,
  ): Promise<void> {
    await this.db.download_jobs.update(songId, {
      ...patch,
      updatedAt: now(),
    });
    this.notify();
  }

  /** Sisip atau ganti satu pekerjaan unduhan. */
  async upsertDownloadJob(job: {
    songId: string;
    status: number;
    quality?: number | null;
    bytesDownloaded?: number;
    totalBytes?: number | null;
    attempts?: number;
    errorMessage?: string | null;
    createdAt?: number | null;
  }): Promise<void> {
    await this.db.download_jobs.put({
      songId: job.songId,
      status: job.status,
      quality: job.quality ?? null,
      bytesDownloaded: job.bytesDownloaded ?? 0,
      totalBytes: job.totalBytes ?? null,
      attempts: job.attempts ?? 0,
      errorMessage: job.errorMessage ?? null,
      createdAt: job.createdAt ?? null,
      updatedAt: now(),
    });
    this.notify();
  }

  /** Hapus pekerjaan unduhan. */
  async deleteDownloadJob(songId: string): Promise<void> {
    await this.db.download_jobs.delete(songId);
    this.notify();
  }

  /**
   * Pekerjaan yang tertinggal berstatus "mengunduh" kembali ke
   * antrean (rekonsiliasi saat start). Mengembalikan jumlah job.
   */
  async resetRunningJobsToQueued(): Promise<number> {
    const running = await this.db.download_jobs
      .where('status')
      .equals(1)
      .toArray();
    if (running.length === 0) return 0;
    const at = now();
    await this.db.transaction('rw', [this.db.download_jobs], async () => {
      for (const job of running) {
        await this.db.download_jobs.update(job.songId, {
          status: 0,
          updatedAt: at,
        });
      }
    });
    this.notify();
    return running.length;
  }

  /** Hapus pekerjaan selesai yang lebih tua dari 7 hari. */
  async pruneCompletedJobs(opts: { olderThanMs?: number } = {}): Promise<number> {
    const cutoff = now() - (opts.olderThanMs ?? 7 * 24 * 60 * 60 * 1000);
    const stale = await this.db.download_jobs
      .where('status')
      .equals(4)
      .filter((j) => j.updatedAt < cutoff)
      .toArray();
    if (stale.length === 0) return 0;
    await this.db.download_jobs.bulkDelete(stale.map((j) => j.songId));
    this.notify();
    return stale.length;
  }

  // ------------------------------------------------------------------
  // Cache streaming (P5; manifest di cache_entries)
  // ------------------------------------------------------------------

  async cacheEntry(key: string): Promise<{
    key: string;
    filePath: string;
    sizeBytes: number;
    lastAccessed: number;
    createdAt: number;
  } | null> {
    return (await this.db.cache_entries.get(key)) ?? null;
  }

  /** Entri cache untuk satu lagu (semua itag yang pernah di-cache). */
  async cacheEntriesForVideo(videoId: string): Promise<
    Array<{ key: string; sizeBytes: number }>
  > {
    const rows = await this.db.cache_entries
      .where('key')
      .between(`${videoId}_`, `${videoId}_\uFFFF`, true, true)
      .toArray();
    return rows.map((r) => ({ key: r.key, sizeBytes: r.sizeBytes }));
  }

  async upsertCacheEntry(entry: {
    key: string;
    filePath: string;
    sizeBytes: number;
  }): Promise<void> {
    const at = now();
    await this.db.cache_entries.put({
      key: entry.key,
      filePath: entry.filePath,
      sizeBytes: entry.sizeBytes,
      lastAccessed: at,
      createdAt: at,
    });
  }

  /** Perbarui waktu akses terakhir entri cache (dipakai LRU). */
  async touchCacheEntry(key: string): Promise<void> {
    await this.db.cache_entries.update(key, { lastAccessed: now() });
  }

  async deleteCacheEntry(key: string): Promise<void> {
    await this.db.cache_entries.delete(key);
  }

  async deleteCacheEntries(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.db.cache_entries.bulkDelete(keys);
  }

  /** Entri cache urut akses terakhir (paling lama dulu, urutan LRU). */
  async cacheEntriesByLru(opts: { limit?: number } = {}): Promise<
    Array<{ key: string; sizeBytes: number; lastAccessed: number }>
  > {
    const rows = await this.db.cache_entries
      .orderBy('lastAccessed')
      .limit(opts.limit ?? 100)
      .toArray();
    return rows.map((r) => ({
      key: r.key,
      sizeBytes: r.sizeBytes,
      lastAccessed: r.lastAccessed,
    }));
  }

  /** Hitungan penyimpanan dari database (PRD B3.3). */
  async storageStats(): Promise<{
    downloadCount: number;
    downloadBytes: number;
    playedSongsCount: number;
    playedSongsBytes: number;
  }> {
    const downloaded = await this.db.songs
      .where('downloadState')
      .equals(DownloadState.downloaded)
      .toArray();
    const entries = await this.db.cache_entries.toArray();
    return {
      downloadCount: downloaded.length,
      downloadBytes: downloaded.reduce(
        (sum, s) => sum + (s.fileSizeBytes ?? 0),
        0,
      ),
      playedSongsCount: entries.length,
      playedSongsBytes: entries.reduce((sum, e) => sum + e.sizeBytes, 0),
    };
  }

  // ------------------------------------------------------------------
  // Lagu yang tidak bisa diputar (P6, B4.7)
  // ------------------------------------------------------------------

  /**
   * Tandai lagu sebagai tidak bisa diputar. Dipanggil HANYA saat
   * playabilityStatus membuktikan lagu dihapus/privat/dibatasi
   * wilayah, bukan saat gagal jaringan.
   */
  async markUnplayable(songId: string): Promise<void> {
    await this.db.songs
      .where('id')
      .equals(songId)
      .filter((s) => s.unplayable === 0)
      .modify({ unplayable: 1, dateModified: now() });
    this.notify();
  }

  /** Bersihkan tanda "tidak bisa diputar" (satu resolve berhasil). */
  async clearUnplayable(songId: string): Promise<void> {
    await this.db.songs
      .where('id')
      .equals(songId)
      .filter((s) => s.unplayable === 1)
      .modify({ unplayable: 0, dateModified: now() });
    this.notify();
  }

  async isUnplayable(songId: string): Promise<boolean> {
    const song = await this.db.songs.get(songId);
    return song?.unplayable === 1;
  }

  /** Jumlah lagu bertanda yang BUKAN unduhan (bisa dihapus massal). */
  async unplayableCount(): Promise<number> {
    return this.db.songs
      .where('unplayable')
      .equals(1)
      .filter((s) => s.downloadState !== DownloadState.downloaded)
      .count();
  }

  /**
   * Hapus massal lagu bertanda yang bukan unduhan. Mengembalikan
   * jumlah lagu yang dihapus.
   */
  async deleteUnplayableSongs(): Promise<number> {
    const rows = await this.db.songs
      .where('unplayable')
      .equals(1)
      .filter((s) => s.downloadState !== DownloadState.downloaded)
      .toArray();
    if (rows.length === 0) return 0;
    const ids = rows.map((s) => s.id);
    await this.db.transaction(
      'rw',
      [
        this.db.songs,
        this.db.playlist_songs,
        this.db.song_artists,
        this.db.token_index,
        this.db.formats,
        this.db.lyrics,
        this.db.play_events,
        this.db.download_jobs,
        this.db.queue_items,
      ],
      async () => {
        for (const id of ids) {
          await this.db.playlist_songs
            .where('songId')
            .equals(id)
            .delete();
          await this.db.token_index
            .where('[kind+refId]')
            .equals(['song', id])
            .delete();
          await this.db.song_artists
            .where('[songId+artistId]')
            .between([id, ''], [id, MAX_STRING])
            .delete();
          await this.db.formats.where('songId').equals(id).delete();
          await this.db.lyrics.delete(id);
          await this.db.play_events.where('songId').equals(id).delete();
          await this.db.download_jobs.delete(id);
          await this.db.queue_items
            .filter((q) => q.songId === id)
            .delete();
          await this.db.songs.delete(id);
        }
      },
    );
    this.notify();
    return ids.length;
  }

  /** Simpan metadata format audio bila belum ada. */
  async upsertFormat(format: {
    id: string;
    songId: string;
    itag: number;
    mimeType: string;
    codecs?: string | null;
    bitrate?: number | null;
    loudnessDb?: number | null;
    contentLength?: number | null;
  }): Promise<void> {
    const existing = await this.db.formats.get(format.id);
    if (existing) return;
    await this.db.formats.add({
      id: format.id,
      songId: format.songId,
      itag: format.itag,
      mimeType: format.mimeType,
      codecs: format.codecs ?? null,
      bitrate: format.bitrate ?? null,
      loudnessDb: format.loudnessDb ?? null,
      contentLength: format.contentLength ?? null,
      lastModified: now(),
    });
  }

  // ------------------------------------------------------------------
  // Meta app (nilai kecil)
  // ------------------------------------------------------------------

  async getMeta(key: string): Promise<string | null> {
    const row = await this.db.app_meta.get(key);
    return row?.value ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.db.app_meta.put({ key, value });
  }

  // ------------------------------------------------------------------
  // Backup dan impor (P8): snapshot + merge satu transaksi
  // ------------------------------------------------------------------

  /**
   * Baca seluruh isi database untuk ekspor backup. Pembacaan
   * berurutan tanpa transaksi (port APK): event putar yang
   * tercatat di tengah ekspor boleh masuk atau tidak — merge di
   * perangkat tujuan men-dedup, jadi tidak ada data ganda.
   */
  async backupSnapshot(): Promise<BackupSnapshot> {
    const songs = await this.db.songs.toArray();
    const songArtists = await this.db.song_artists.toArray();
    const albums = await this.db.albums.toArray();
    const artists = await this.db.artists.toArray();
    const playlists = await this.db.playlists.toArray();
    const playlistSongs = await this.db.playlist_songs
      .orderBy('[playlistId+position]')
      .toArray();
    const playEvents = await this.db.play_events
      .orderBy('[timestamp+id]')
      .toArray();
    const searchHistory = await this.db.search_history.toArray();
    const queue = await this.db.queue_items.orderBy('position').toArray();
    const playbackState = (await this.db.playback_state.get(1)) ?? null;
    return {
      songs,
      songArtists,
      albums,
      artists,
      playlists,
      playlistSongs,
      playEvents,
      searchHistory,
      queue,
      playbackState,
    };
  }

  /**
   * Gabungkan isi file salinan ke database dalam SATU transaksi
   * Dexie (PRD B10.1): gagal di tengah berarti TIDAK ADA yang
   * berubah.
   *
   * Aturan merge (port APK `mergeBackupData`, B4.8 menang atas
   * B10.3 soal nama playlist):
   * - Lagu: dicocokkan berdasarkan id. Lagu baru disisip dengan
   *   nilai dari file (favorit, total waktu putar, tanggal
   *   tambah). Lagu yang sudah ada hanya diperbarui metadata-nya
   *   (judul, album, durasi, sampul); favorit dan total waktu
   *   putar TIDAK PERNAH diturunkan (favorit dari file hanya
   *   bisa menambah, bukan mencabut), dan status unduhan tidak
   *   disentuh. Artis lagu yang sudah ada tidak ditulis ulang
   *   (database lokal adalah otoritasnya).
   * - Album dan artis: disisip bila belum ada (berdasarkan id).
   * - Playlist: dicocokkan berdasarkan NAMA persis. Nama sama
   *   berarti lagunya yang belum ada ditambahkan ke playlist
   *   yang sama (BUKAN membuat salinan "(salinan)"); nama baru
   *   berarti playlist baru. Nama dipotong ke batas PRD
   *   (100 karakter) dan deskripsi ke 500 karakter bila file
   *   membawanya lebih panjang.
   * - Riwayat putar: dedup (lagu, detik putar, durasi); batas
   *   10.000 entri tetap ditegakkan (yang tertua dihapus).
   *   Dedup memakai DETIK (bukan milidetik) supaya file yang
   *   sempat melewati APK — drift menyimpan DateTime sebagai
   *   detik — tidak menghasilkan duplikat saat kembali ke web.
   * - Riwayat pencarian: dedup query tanpa membedakan
   *   kapitalisasi; batas 100 query tetap ditegakkan.
   * - Antrean: ditambahkan di BELAKANG antrean yang ada (bukan
   *   menimpa); duplikat videoId dilewati; total dibatasi
   *   200 item. Item dari file selalu `kind: 'stream'` (file
   *   tidak membawa lagu lokal).
   * - Posisi pemutar: dipulihkan hanya bila antrean perangkat
   *   tujuan kosong sebelum impor (dan file membawa antrean —
   *   posisi tanpa antrean tidak berarti). Urutan putar web
   *   (`order`) diisi urutan identitas, kecepatan dan volume
   *   memakai nilai bawaan 1 (file tidak membawanya).
   * - Lagu yang dulu terunduh (menurut file) TIDAK ditandai
   *   terunduh di sini — filenya tidak ada di perangkat ini.
   *   Id-nya dikembalikan di `downloadedSongIds` untuk tombol
   *   "Unduh ulang".
   *
   * Penyimpangan web dari APK (dicatat, bukan disembunyikan):
   * - Judul lagu yang berubah pada lagu yang sudah ada membuat
   *   indeks token lagu itu disinkronkan ulang (APK tidak
   *   menyentuh FTS untuk lagu lama; di web, tanpa ini pencarian
   *   lokal akan memakai judul lama).
   * - Batas 1.000 lagu per playlist ditegakkan (dihitung di
   *   `playlistSongsSkippedFull`); file dari app yang sama tidak
   *   pernah memicu ini karena batasnya sama di kedua platform.
   *
   * `data` WAJIB sudah lewat `parseBackupText` (tervalidasi +
   * termigrasi). Pemanggil TIDAK boleh membangun BackupData dari
   * JSON mentah tanpa validasi.
   */
  async mergeBackupData(data: BackupData): Promise<BackupMergeResult> {
    const at = now();
    const result = await this.db.transaction(
      'rw',
      [
        this.db.songs,
        this.db.albums,
        this.db.artists,
        this.db.song_artists,
        this.db.token_index,
        this.db.playlists,
        this.db.playlist_songs,
        this.db.play_events,
        this.db.search_history,
        this.db.queue_items,
        this.db.playback_state,
      ],
      async () => {
        let songsAdded = 0;
        let songsExisted = 0;
        let playlistsCreated = 0;
        let playlistSongsAdded = 0;
        let playlistSongsExisted = 0;
        let playlistSongsSkippedFull = 0;
        let eventsAdded = 0;
        let eventsExisted = 0;
        let queriesAdded = 0;
        let queriesExisted = 0;
        let queueAdded = 0;
        let queueExisted = 0;
        let queueSkippedFull = 0;
        const queueSkippedSongIds: string[] = [];
        const downloadedSongIds: string[] = [];

        // Album dulu (lagu menunjuk album), insert-or-ignore.
        if (data.albums.length > 0) {
          const keys = data.albums.map((a) => a.id);
          const existing = await this.db.albums.bulkGet(keys);
          const missing: AlbumRow[] = [];
          data.albums.forEach((album, i) => {
            if (existing[i] === undefined) {
              missing.push({
                id: album.id,
                title: album.title,
                titleKey: titleKeyOf(album.title),
                year: album.year,
                thumbnailUrl: album.thumbnailUrl,
                liked: album.liked ? 1 : 0,
                dateAdded: album.dateAdded ?? at,
              });
            }
          });
          if (missing.length > 0) await this.db.albums.bulkAdd(missing);
        }

        // Artis: dari data.artists + dari referensi artis di lagu
        // (file bisa membawa ref tanpa baris artis — APK membuat
        // barisnya dari ref, dan web melakukan hal yang sama).
        const artistNames = new Map<string, string>();
        for (const artist of data.artists) {
          artistNames.set(artist.id, artist.name);
        }
        for (const song of data.songs) {
          for (const ref of song.artists) {
            if (!artistNames.has(ref.id)) {
              artistNames.set(ref.id, ref.name);
            }
          }
        }
        const artistsById = new Map(data.artists.map((a) => [a.id, a]));
        const newArtistIds: string[] = [];
        if (artistNames.size > 0) {
          const keys = [...artistNames.keys()];
          const existing = await this.db.artists.bulkGet(keys);
          const missing: ArtistRow[] = [];
          keys.forEach((key, i) => {
            if (existing[i] === undefined) {
              const fromFile = artistsById.get(key);
              const name = artistNames.get(key) ?? '';
              missing.push({
                id: key,
                name,
                nameKey: name.toLowerCase(),
                thumbnailUrl: fromFile?.thumbnailUrl ?? null,
                liked: fromFile?.liked ? 1 : 0,
                dateAdded: fromFile?.dateAdded ?? at,
              });
              newArtistIds.push(key);
            }
          });
          if (missing.length > 0) {
            await this.db.artists.bulkAdd(missing);
          }
        }

        // Lagu: satu baca untuk seluruh tabel supaya merge
        // 10.000 lagu tidak memakai N+1 query.
        const ids = data.songs.map((s) => s.id);
        const existingSongs =
          ids.length > 0 ? await this.db.songs.bulkGet(ids) : [];
        const rowsToPut: SongRow[] = [];
        const newSongIds = new Set<string>();
        const retitledSongIds: string[] = [];
        data.songs.forEach((song, i) => {
          const existing = existingSongs[i];
          if (!existing) {
            rowsToPut.push({
              id: song.id,
              title: song.title,
              titleKey: titleKeyOf(song.title),
              albumId: song.albumId,
              durationSeconds: song.durationSeconds,
              thumbnailUrl: song.thumbnailUrl,
              liked: song.liked ? 1 : 0,
              totalPlayTimeMs: song.totalPlayTimeMs,
              inLibrary: song.inLibrary ? 1 : 0,
              dateAdded: song.dateAdded ?? at,
              dateModified: at,
              // Status unduhan selalu 0 untuk lagu baru: file
              // audio tidak ikut di file salinan (PRD B7.6).
              downloadState: DownloadState.notDownloaded,
              filePath: null,
              fileSizeBytes: null,
              downloadedAt: null,
              formatId: null,
              unplayable: song.unplayable ? 1 : 0,
            });
            newSongIds.add(song.id);
            songsAdded++;
          } else {
            songsExisted++;
            if (existing.title !== song.title) {
              retitledSongIds.push(song.id);
            }
            // Metadata dari file menang; favorit/inLibrary hanya
            // bisa naik (tidak pernah mencabut yang sudah ada);
            // total waktu putar dan status unduhan dipertahankan.
            rowsToPut.push({
              ...existing,
              title: song.title,
              titleKey: titleKeyOf(song.title),
              albumId: song.albumId,
              durationSeconds: song.durationSeconds,
              thumbnailUrl: song.thumbnailUrl,
              liked: song.liked && existing.liked === 0 ? 1 : existing.liked,
              inLibrary:
                song.inLibrary && existing.inLibrary === 0
                  ? 1
                  : existing.inLibrary,
              dateModified: at,
            });
          }
          if (song.downloaded) {
            const alreadyDownloaded =
              existing?.downloadState === DownloadState.downloaded;
            if (!alreadyDownloaded) downloadedSongIds.push(song.id);
          }
        });
        if (rowsToPut.length > 0) {
          await this.db.songs.bulkPut(rowsToPut);
        }

        // Pemetaan artis hanya untuk lagu BARU (lagu lama memakai
        // pemetaan lokalnya sendiri, port APK).
        const mappings: SongArtistRow[] = [];
        for (const song of data.songs) {
          if (!newSongIds.has(song.id)) continue;
          song.artists.forEach((ref, position) => {
            mappings.push({ songId: song.id, artistId: ref.id, position });
          });
        }
        if (mappings.length > 0) {
          await this.db.song_artists.bulkAdd(mappings);
        }

        // Token: lagu baru + artis baru langsung disisip; lagu
        // yang judulnya berubah dihapus token lamanya dulu
        // (penyimpangan web, lihat dokstring di atas).
        const retitledSet = new Set(retitledSongIds);
        if (retitledSongIds.length > 0) {
          await this.db.token_index
            .where('[kind+refId]')
            .anyOf(
              retitledSongIds.map((id) => ['song', id] as [string, string]),
            )
            .delete();
        }
        const tokenRows: TokenIndexRow[] = [];
        for (const song of data.songs) {
          if (!newSongIds.has(song.id) && !retitledSet.has(song.id)) {
            continue;
          }
          for (const token of uniqueTokens(
            `${song.title} ${song.artists.map((a) => a.name).join(' ')}`,
          )) {
            tokenRows.push({ token, kind: 'song', refId: song.id });
          }
        }
        for (const id of newArtistIds) {
          for (const token of uniqueTokens(artistNames.get(id) ?? '')) {
            tokenRows.push({ token, kind: 'artist', refId: id });
          }
        }
        if (tokenRows.length > 0) {
          await this.db.token_index.bulkAdd(tokenRows);
        }

        // Playlist: cocokkan berdasarkan nama persis (B4.8).
        const existingPlaylists = await this.db.playlists.toArray();
        const byName = new Map<string, PlaylistRow>();
        for (const p of existingPlaylists) {
          if (!byName.has(p.name)) byName.set(p.name, p);
        }
        for (const bp of data.playlists) {
          const name = bp.name.trim();
          if (name.length === 0) continue;
          const safeName =
            name.length > MAX_PLAYLIST_NAME_LENGTH
              ? name.slice(0, MAX_PLAYLIST_NAME_LENGTH)
              : name;
          const descTrimmed = bp.description?.trim() ?? null;
          const safeDescription =
            descTrimmed !== null &&
            descTrimmed.length > MAX_PLAYLIST_DESCRIPTION_LENGTH
              ? descTrimmed.slice(0, MAX_PLAYLIST_DESCRIPTION_LENGTH)
              : descTrimmed;
          let target = byName.get(safeName);
          if (!target) {
            const id = await this.db.playlists.add({
              name: safeName,
              description: safeDescription,
              browseId: null,
              thumbnailUrl: null,
              createdAt: bp.createdAt ?? at,
              updatedAt: at,
            });
            target = {
              id: id as number,
              name: safeName,
              description: safeDescription,
              browseId: null,
              thumbnailUrl: null,
              createdAt: bp.createdAt ?? at,
              updatedAt: at,
            };
            byName.set(safeName, target);
            playlistsCreated++;
          }
          const members = await this.db.playlist_songs
            .where('[playlistId+position]')
            .between([target.id, 0], [target.id, MAX_NUMBER])
            .toArray();
          const memberIds = new Set(members.map((m) => m.songId));
          let position =
            members.length > 0
              ? Math.max(...members.map((m) => m.position)) + 1
              : 0;
          const toAdd: PlaylistSongRow[] = [];
          const markLibrary: string[] = [];
          for (const songId of bp.songIds) {
            if (memberIds.has(songId)) {
              playlistSongsExisted++;
              continue;
            }
            if (memberIds.size >= MAX_PLAYLIST_SONGS) {
              playlistSongsSkippedFull++;
              continue;
            }
            toAdd.push({
              playlistId: target.id,
              songId,
              position,
              dateAdded: at,
            });
            memberIds.add(songId);
            position++;
            playlistSongsAdded++;
            markLibrary.push(songId);
          }
          if (toAdd.length > 0) {
            await this.db.playlist_songs.bulkAdd(toAdd);
          }
          if (markLibrary.length > 0) {
            await this.db.songs
              .where('id')
              .anyOf(markLibrary)
              .modify({ inLibrary: 1 });
          }
          await this.touchPlaylist(target.id, at);
        }

        // Riwayat putar: dedup (lagu, detik, durasi). Batas
        // 10.000 entri tetap ditegakkan (yang tertua dihapus).
        const existingEvents = await this.db.play_events.toArray();
        const eventKeys = new Set(
          existingEvents.map(
            (e) =>
              `${e.songId}|${Math.floor(e.timestamp / 1000)}|${e.playTimeMs}`,
          ),
        );
        const newEvents: Array<{
          songId: string;
          timestamp: number;
          playTimeMs: number;
        }> = [];
        for (const event of data.playEvents) {
          const key = `${event.songId}|${Math.floor(event.timestamp / 1000)}|${event.playTimeMs}`;
          if (eventKeys.has(key)) {
            eventsExisted++;
            continue;
          }
          newEvents.push({
            songId: event.songId,
            timestamp: event.timestamp,
            playTimeMs: event.playTimeMs,
          });
          eventKeys.add(key);
          eventsAdded++;
        }
        if (newEvents.length > 0) {
          await this.db.play_events.bulkAdd(newEvents);
        }
        const eventCount = await this.db.play_events.count();
        if (eventCount > MAX_PLAY_EVENTS) {
          const excess = eventCount - MAX_PLAY_EVENTS;
          const oldest = await this.db.play_events
            .orderBy('[timestamp+id]')
            .limit(excess)
            .toArray();
          await this.db.play_events.bulkDelete(oldest.map((e) => e.id));
        }

        // Riwayat pencarian: dedup tanpa membedakan kapitalisasi.
        const existingQueries = await this.db.search_history.toArray();
        const queryKeys = new Set(
          existingQueries.map((q) => q.query.toLowerCase()),
        );
        const newQueries: SearchHistoryRow[] = [];
        for (const q of data.searchHistory) {
          if (queryKeys.has(q.query.toLowerCase())) {
            queriesExisted++;
            continue;
          }
          newQueries.push({
            query: q.query,
            queryLower: q.query.toLowerCase(),
            timestamp: q.timestamp,
          });
          queryKeys.add(q.query.toLowerCase());
          queriesAdded++;
        }
        if (newQueries.length > 0) {
          await this.db.search_history.bulkAdd(newQueries);
        }
        const queryCount = await this.db.search_history.count();
        if (queryCount > MAX_SEARCH_HISTORY) {
          const excess = queryCount - MAX_SEARCH_HISTORY;
          const oldest = await this.db.search_history
            .orderBy('[timestamp+query]')
            .limit(excess)
            .toArray();
          await this.db.search_history.bulkDelete(
            oldest.map((q) => q.query),
          );
        }

        // Antrean: ditambahkan di belakang antrean yang ada.
        const existingQueue = await this.db.queue_items
          .orderBy('position')
          .toArray();
        const queuedIds = new Set(existingQueue.map((q) => q.songId));
        let queuePosition =
          existingQueue.length > 0
            ? (existingQueue[existingQueue.length - 1]?.position ?? -1) + 1
            : 0;
        const queueToAdd: QueueItemRow[] = [];
        for (const item of data.queue) {
          if (queuedIds.has(item.songId)) {
            queueExisted++;
            continue;
          }
          if (queuePosition >= MAX_BACKUP_QUEUE_ITEMS) {
            queueSkippedFull++;
            queueSkippedSongIds.push(item.songId);
            continue;
          }
          queueToAdd.push({
            position: queuePosition,
            songId: item.songId,
            source: item.source,
            kind: 'stream',
          });
          queuedIds.add(item.songId);
          queuePosition++;
          queueAdded++;
        }
        if (queueToAdd.length > 0) {
          await this.db.queue_items.bulkAdd(queueToAdd);
        }

        // Posisi pemutar: hanya bila antrean tujuan kosong sebelum
        // impor (dan file membawa antrean — posisi tanpa antrean
        // tidak berarti).
        let playbackStateRestored = false;
        const ps = data.playbackState;
        if (existingQueue.length === 0 && ps !== null && queuePosition > 0) {
          await this.db.playback_state.put({
            id: 1,
            currentIndex: Math.min(
              Math.max(0, ps.currentIndex),
              queuePosition - 1,
            ),
            positionMs: ps.positionMs,
            shuffleEnabled: ps.shuffleEnabled ? 1 : 0,
            repeatMode: ps.repeatMode,
            order: Array.from({ length: queuePosition }, (_, i) => i),
            rate: 1,
            volume: 1,
            updatedAt: at,
          });
          playbackStateRestored = true;
        }

        return {
          songsAdded,
          songsExisted,
          playlistsCreated,
          playlistSongsAdded,
          playlistSongsExisted,
          playlistSongsSkippedFull,
          eventsAdded,
          eventsExisted,
          queriesAdded,
          queriesExisted,
          queueAdded,
          queueExisted,
          queueSkippedFull,
          queueSkippedSongIds,
          downloadedSongIds,
          playbackStateRestored,
        };
      },
    );
    this.notify();
    return result;
  }

  // ------------------------------------------------------------------
  // Sinkronisasi (P7): tombstone + akses baca/tulis untuk syncService
  // ------------------------------------------------------------------

  /**
   * Catat penghapusan lokal supaya ikut terkirim ke server.
   * Tombstone tidak dicatat untuk data yang belum pernah punya
   * clientId (tidak pernah disinkronkan, jadi server tidak punya
   * salinannya) — pemanggil yang memutuskan.
   */
  async recordTombstone(
    kind: SyncTombstoneRow['kind'],
    ref: string,
  ): Promise<void> {
    await this.db.sync_tombstones.put({
      key: `${kind}:${ref}`,
      kind,
      ref,
      deletedAt: now(),
    });
  }

  async listTombstones(): Promise<SyncTombstoneRow[]> {
    return this.db.sync_tombstones.toArray();
  }

  async deleteTombstones(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.db.sync_tombstones.bulkDelete(keys);
  }

  /** Hapus tombstone lebih tua dari `beforeMs` (retensi 30 hari). */
  async pruneTombstones(beforeMs: number): Promise<number> {
    return this.db.sync_tombstones
      .where('deletedAt')
      .below(beforeMs)
      .delete();
  }

  /** Playlist berdasarkan id client sinkronisasi (tanpa indeks; maks 100). */
  async playlistByClientId(
    clientId: string,
  ): Promise<PlaylistRow | null> {
    const found = await this.db.playlists
      .filter((p) => p.clientId === clientId)
      .first();
    return found ?? null;
  }

  async setPlaylistClientId(id: number, clientId: string): Promise<void> {
    await this.db.playlists.update(id, { clientId });
  }

  /** Semua playlist (untuk dorong sinkronisasi; maks 100). */
  async allPlaylists(): Promise<PlaylistRow[]> {
    return this.db.playlists.toArray();
  }

  /** Semua lagu satu playlist, urut posisi (untuk dorong sinkronisasi). */
  async playlistSongsAll(playlistId: number): Promise<PlaylistSongRow[]> {
    return this.db.playlist_songs
      .where('[playlistId+position]')
      .between([playlistId, 0], [playlistId, MAX_NUMBER])
      .toArray();
  }

  /**
   * Terapkan nama/deskripsi playlist dari server, dengan
   * updatedAt server (bukan jam perangkat). Dipakai jalur tarik.
   */
  async applyRemotePlaylist(
    id: number,
    opts: { name: string; description: string | null; updatedAt: number },
  ): Promise<void> {
    await this.db.playlists.update(id, {
      name: opts.name,
      description: opts.description,
      updatedAt: opts.updatedAt,
    });
    this.notify();
  }

  /**
   * Buat playlist dari data server (clientId sudah ditentukan
   * server). Mengembalikan id lokal baru, atau null bila
   * perangkat sudah punya 100 playlist (batas sinkron §4.3,
   * S7 lapis kedua — pull dari server yang membengkak tidak
   * boleh membengkakkan IndexedDB tanpa batas).
   */
  async createPlaylistFromRemote(opts: {
    clientId: string;
    name: string;
    description: string | null;
    updatedAt: number;
  }): Promise<number | null> {
    const count = await this.db.playlists.count();
    if (count >= MAX_SYNC_PLAYLISTS) return null;
    const id = await this.db.playlists.add({
      name: opts.name,
      description: opts.description,
      browseId: null,
      thumbnailUrl: null,
      clientId: opts.clientId,
      createdAt: opts.updatedAt,
      updatedAt: opts.updatedAt,
    });
    this.notify();
    return id as number;
  }

  /**
   * Atur status suka secara eksplisit (jalur tarik sinkronisasi
   * memakai `quiet` supaya tidak mencatat tombstone untuk
   * perubahan yang asalnya dari server).
   */
  async setLiked(
    songId: string,
    liked: boolean,
    opts: { quiet?: boolean } = {},
  ): Promise<void> {
    const song = await this.db.songs.get(songId);
    if (!song) {
      throw new Error(`setLiked: lagu ${songId} belum ada di database`);
    }
    await this.db.songs.update(songId, {
      liked: liked ? 1 : 0,
      ...(liked ? { inLibrary: 1 } : {}),
      dateModified: now(),
    });
    if (!liked && !opts.quiet) {
      await this.recordTombstone('like', songId);
    }
    this.notify();
  }

  /** Semua lagu yang disukai beserta artisnya (untuk dorong). */
  async allLikedSongs(): Promise<SongView[]> {
    const rows = await this.db.songs.where('liked').equals(1).toArray();
    if (rows.length === 0) return [];
    return this.songsByIds(rows.map((r) => r.id));
  }

  /** Entri riwayat mentah, terbaru dulu (untuk dorong). */
  async historyEvents(limit: number): Promise<PlayEventRow[]> {
    return this.db.play_events
      .orderBy('[timestamp+id]')
      .reverse()
      .limit(limit)
      .toArray();
  }

  /** Apakah entri riwayat (lagu + waktu) sudah ada (dedup tarik). */
  async hasPlayEvent(songId: string, timestamp: number): Promise<boolean> {
    const count = await this.db.play_events
      .where('songId')
      .equals(songId)
      .filter((e) => e.timestamp === timestamp)
      .count();
    return count > 0;
  }

  /**
   * Sisipkan lagu ke playlist di posisi tertentu (jalur tarik
   * sinkronisasi). Bila posisi sudah terisi, lagu ditaruh di
   * ujung (maks+1) — urutan lokal tidak pernah ditimpa paksa.
   * Mengembalikan false bila lagu sudah ada di playlist.
   */
  async insertPlaylistItemAt(
    playlistId: number,
    songId: string,
    position: number,
  ): Promise<boolean> {
    return this.db.transaction(
      'rw',
      [this.db.playlist_songs, this.db.songs, this.db.playlists],
      async () => {
        const existing = await this.db.playlist_songs.get([
          playlistId,
          songId,
        ]);
        if (existing) return false;
        const count = await this.db.playlist_songs
          .where('[playlistId+position]')
          .between([playlistId, 0], [playlistId, MAX_NUMBER])
          .count();
        if (count >= MAX_PLAYLIST_SONGS) return false;
        const taken = await this.db.playlist_songs
          .where('[playlistId+position]')
          .equals([playlistId, position])
          .count();
        const finalPosition =
          taken > 0
            ? await this.nextPlaylistPosition(playlistId)
            : position;
        const at = now();
        await this.db.playlist_songs.add({
          playlistId,
          songId,
          position: finalPosition,
          dateAdded: at,
        });
        await this.db.songs.update(songId, { inLibrary: 1 });
        await this.touchPlaylist(playlistId, at);
        return true;
      },
    ).then((added) => {
      if (added) this.notify();
      return added;
    });
  }

  /**
   * Pastikan lagu dari server ada sebagai baris lokal (jalur
   * tarik sinkronisasi). Baris minimal: judul + artis dari
   * metadata server apa adanya. Bila metadata tidak ada, judul
   * memakai videoId itu sendiri — bukan karangan, melainkan id
   * asli yang bisa dicari ulang. Lagu yang sudah ada tidak
   * disentuh.
   */
  async ensureRemoteSong(
    videoId: string,
    title: string | null,
    artist: string | null,
  ): Promise<void> {
    const existing = await this.db.songs.get(videoId);
    if (existing) return;
    const at = now();
    await this.importSongs(
      [
        {
          song: {
            id: videoId,
            title: title ?? videoId,
            albumId: null,
            durationSeconds: null,
            thumbnailUrl: null,
            liked: 0,
            totalPlayTimeMs: 0,
            inLibrary: 1,
            dateAdded: at,
            dateModified: at,
            downloadState: DownloadState.notDownloaded,
            filePath: null,
            fileSizeBytes: null,
            downloadedAt: null,
            formatId: null,
            unplayable: 0,
          },
          artistNames: artist ? [artist] : [],
        },
      ],
      { addToLibrary: true },
    );
  }
}

function validatePlaylistName(trimmed: string): void {
  if (trimmed.length === 0) {
    throw new Error('Nama playlist tidak boleh kosong');
  }
  if (trimmed.length > MAX_PLAYLIST_NAME_LENGTH) {
    throw new Error(
      `Nama playlist paling panjang ${MAX_PLAYLIST_NAME_LENGTH} karakter`,
    );
  }
}

function validatePlaylistDescription(description: string | null): void {
  if (
    description != null &&
    description.trim().length > MAX_PLAYLIST_DESCRIPTION_LENGTH
  ) {
    throw new Error(
      `Deskripsi playlist paling panjang ${MAX_PLAYLIST_DESCRIPTION_LENGTH} karakter`,
    );
  }
}

let sharedService: LibraryService | null = null;
let sharedServiceOpen: Promise<LibraryService> | null = null;

/**
 * Layanan library bersama (membuka database sekali). Gagal buka
 * melempar; pemanggil wajib menangkap.
 */
export function getLibraryService(): Promise<LibraryService> {
  if (sharedService) return Promise.resolve(sharedService);
  if (!sharedServiceOpen) {
    sharedServiceOpen = openDatabase()
      .then((db) => {
        sharedService = new LibraryService(db);
        return sharedService;
      })
      .catch((error: unknown) => {
        sharedServiceOpen = null;
        throw error;
      });
  }
  return sharedServiceOpen;
}

/** Buang layanan bersama (dipakai tes dan reset data). */
export function resetLibraryService(): void {
  sharedService = null;
  sharedServiceOpen = null;
}
