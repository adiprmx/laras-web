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
  type PlayHistoryEntry,
  type PlaylistRow,
  type PlaylistSongEntry,
  type PlaylistWithCount,
  type SongImport,
  type SongRow,
  type SongView,
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

/** Batas ukuran satu kolom lirik (port R3-L1 APK). */
export const MAX_LYRICS_BYTES = 256 * 1024;

/** Urutan daftar lagu (port SongSort APK). */
export type SongSort = 'newest' | 'byName' | 'mostPlayed';

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
    this.notify();
    return liked === 1;
  }

  /**
   * Keluarkan lagu dari Library: favorit mati, lagu keluar dari
   * semua playlist, `inLibrary` mati. Baris lagu dan riwayat
   * putarnya tetap ada.
   */
  async removeFromLibrary(songId: string): Promise<void> {
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
   * lagu di Library tidak ikut terhapus.
   */
  async deletePlaylist(id: number): Promise<void> {
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
  ): Promise<void> {
    await this.db.transaction(
      'rw',
      [this.db.playlist_songs, this.db.playlists],
      async () => {
        await this.db.playlist_songs.delete([playlistId, songId]);
        await this.renumberPlaylist(playlistId);
        await this.touchPlaylist(playlistId, now());
      },
    );
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
   * "Sering diputar").
   */
  async clearHistory(): Promise<void> {
    await this.db.play_events.clear();
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
  } | null> {
    const row = await this.db.lyrics.get(songId);
    if (!row) return null;
    return { lyrics: row.lyrics, syncedLyrics: row.syncedLyrics };
  }

  /**
   * Simpan lirik lagu (sisip atau ganti). Menolak lirik di atas
   * 256 KB per kolom (port R3-L1 APK).
   */
  async saveLyrics(opts: {
    songId: string;
    lyrics: string;
    syncedLyrics?: string | null;
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
  } | null> {
    const row = await this.db.download_jobs.get(songId);
    if (!row) return null;
    return { songId: row.songId, status: row.status };
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
