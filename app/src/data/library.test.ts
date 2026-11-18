/**
 * Tes LibraryService: port perilaku APK (library_service.dart).
 * Tiap tes memakai database IndexedDB palsu yang baru.
 *
 * Tes yang mengimpor 100+ lagu memakai timeout 30 detik
 * (bukan default 5 detik): fake-indexeddb lambat dan timeout
 * default bisa terlampaui saat seluruh suite jalan paralel di
 * VM berbagi CPU. Ini anggaran waktu lingkungan, bukan
 * pelonggaran asersi.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { LarasDatabase } from './database';
import {
  LibraryService,
  MAX_PLAYLIST_DESCRIPTION_LENGTH,
  MAX_PLAYLIST_NAME_LENGTH,
  MAX_PLAY_EVENTS,
  MAX_SEARCH_HISTORY,
  PAGE_SIZE,
} from './library';
import { localArtistIdForName } from './tokens';
import type { SongImport } from './types';

let counter = 0;
const openDbs: LarasDatabase[] = [];

async function makeService(): Promise<LibraryService> {
  counter += 1;
  const db = new LarasDatabase(`laras-lib-test-${counter}`);
  openDbs.push(db);
  await db.open();
  return new LibraryService(db);
}

afterEach(async () => {
  while (openDbs.length > 0) {
    const db = openDbs.pop();
    db?.close();
  }
});

function song(
  id: string,
  title: string,
  artists: string[] = [],
  dateAdded = 1000,
): SongImport {
  return {
    song: {
      id,
      title,
      albumId: null,
      durationSeconds: 200,
      thumbnailUrl: null,
      liked: 0,
      totalPlayTimeMs: 0,
      inLibrary: 0,
      downloadState: 0,
      filePath: null,
      fileSizeBytes: null,
      downloadedAt: null,
      formatId: null,
      unplayable: 0,
      dateAdded,
      dateModified: dateAdded,
    },
    artistNames: artists,
  };
}

describe('upsertSong', () => {
  it('lagu baru masuk Library bila addToLibrary', async () => {
    const service = await makeService();
    await service.upsertSong(song('v1', 'Semua Tentang Kita').song, {
      artistNames: ['Peterpan'],
      addToLibrary: true,
    });
    const view = await service.songById('v1');
    expect(view?.song.title).toBe('Semua Tentang Kita');
    expect(view?.song.inLibrary).toBe(1);
    expect(view?.artistNames).toEqual(['Peterpan']);
  });

  it('sekadar diputar tidak masuk Library', async () => {
    const service = await makeService();
    await service.upsertSong(song('v1', 'Semua Tentang Kita').song, {
      artistNames: ['Peterpan'],
    });
    expect((await service.songById('v1'))?.song.inLibrary).toBe(0);
    const page = await service.songsPage({});
    expect(page).toHaveLength(0);
  });

  it('pembaruan metadata mempertahankan favorit dan total putar', async () => {
    const service = await makeService();
    await service.upsertSong(song('v1', 'Judul Lama').song, {
      addToLibrary: true,
    });
    await service.toggleLiked('v1');
    await service.recordPlay({ songId: 'v1', timestamp: 100, playTimeMs: 60000 });
    await service.upsertSong(song('v1', 'Judul Baru').song, {
      addToLibrary: true,
    });
    const view = await service.songById('v1');
    expect(view?.song.title).toBe('Judul Baru');
    expect(view?.song.liked).toBe(1);
    expect(view?.song.totalPlayTimeMs).toBe(60000);
  });

  it('artis tanpa channelId memakai id semu dari nama', async () => {
    const service = await makeService();
    await service.upsertSong(song('v1', 'Lagu').song, {
      artistNames: ['Noah'],
      addToLibrary: true,
    });
    const artist = await service.artistById(localArtistIdForName('Noah'));
    expect(artist?.name).toBe('Noah');
  });
});

describe('songsPage', () => {
  async function seed120(service: LibraryService): Promise<void> {
    const items: SongImport[] = [];
    for (let i = 0; i < 120; i++) {
      const num = String(i).padStart(3, '0');
      const item = song(`v${num}`, `Lagu ${num}`, ['Artis'], 1000 + i);
      item.song.totalPlayTimeMs = i * 1000;
      items.push(item);
    }
    await service.importSongs(items, { addToLibrary: true });
  }

  it(
    'terbaru: 50 + 50 + 20, tanpa tumpang tindih, urut tanggal turun',
    async () => {
    const service = await makeService();
    await seed120(service);
    const p1 = await service.songsPage({ sort: 'newest' });
    expect(p1).toHaveLength(50);
    expect(p1[0]?.song.id).toBe('v119');
    expect(p1[49]?.song.id).toBe('v070');
    const p2 = await service.songsPage({
      sort: 'newest',
      after: p1[49],
    });
    expect(p2).toHaveLength(50);
    expect(p2[0]?.song.id).toBe('v069');
    const p3 = await service.songsPage({
      sort: 'newest',
      after: p2[49],
    });
    expect(p3).toHaveLength(20);
    expect(p3[19]?.song.id).toBe('v000');
    const ids = new Set([...p1, ...p2, ...p3].map((v) => v.song.id));
    expect(ids.size).toBe(120);
  }, 30000);

  it(
    'nama: urut judul naik tanpa membedakan kapitalisasi',
    async () => {
    const service = await makeService();
    await seed120(service);
    const p1 = await service.songsPage({ sort: 'byName' });
    expect(p1).toHaveLength(50);
    expect(p1[0]?.song.title).toBe('Lagu 000');
    expect(p1[49]?.song.title).toBe('Lagu 049');
    const p3 = await service.songsPage({
      sort: 'byName',
      after: p1[49],
      limit: 70,
    });
    expect(p3).toHaveLength(70);
    expect(p3[69]?.song.title).toBe('Lagu 119');
  }, 30000);

  it(
    'sering diputar: urut total waktu putar turun',
    async () => {
    const service = await makeService();
    await seed120(service);
    const p1 = await service.songsPage({ sort: 'mostPlayed' });
    expect(p1[0]?.song.id).toBe('v119');
    expect(p1[0]?.song.totalPlayTimeMs).toBe(119000);
    expect(p1[49]?.song.id).toBe('v070');
  }, 30000);

  it('halaman kosong bila tidak ada lagu Library', async () => {
    const service = await makeService();
    expect(await service.songsPage({})).toHaveLength(0);
  });

  it('PAGE_SIZE adalah 50 (port APK)', () => {
    expect(PAGE_SIZE).toBe(50);
  });
});

describe('favorit', () => {
  it('toggleLiked memfavoritkan dan memasukkan ke Library', async () => {
    const service = await makeService();
    await service.upsertSong(song('v1', 'Lagu').song, {});
    expect(await service.isLiked('v1')).toBe(false);
    expect(await service.toggleLiked('v1')).toBe(true);
    expect(await service.isLiked('v1')).toBe(true);
    expect((await service.songById('v1'))?.song.inLibrary).toBe(1);
    const favorites = await service.favoriteSongsPage({});
    expect(favorites.map((v) => v.song.id)).toEqual(['v1']);
    expect(await service.toggleLiked('v1')).toBe(false);
    expect(await service.favoriteSongsPage({})).toHaveLength(0);
  });

  it('toggleLiked melempar bila lagu belum ada', async () => {
    const service = await makeService();
    await expect(service.toggleLiked('tidak-ada')).rejects.toThrow();
  });

  it('removeFromLibrary mematikan favorit dan mengeluarkan dari playlist', async () => {
    const service = await makeService();
    await service.upsertSong(song('v1', 'Lagu').song, { addToLibrary: true });
    await service.toggleLiked('v1');
    const playlistId = await service.createPlaylist('Campuran');
    await service.addSongToPlaylist(playlistId, 'v1');
    await service.removeFromLibrary('v1');
    const view = await service.songById('v1');
    expect(view?.song.liked).toBe(0);
    expect(view?.song.inLibrary).toBe(0);
    expect(await service.playlistSongsPage(playlistId, {})).toHaveLength(0);
  });
});

describe('artis dan album', () => {
  it('artistsPage hanya artis dengan lagu Library, beserta hitungan', async () => {
    const service = await makeService();
    await service.importSongs(
      [
        song('v1', 'Satu', ['Noah'], 100),
        song('v2', 'Dua', ['Noah'], 200),
        song('v3', 'Tiga', ['Peterpan'], 300),
      ],
      { addToLibrary: true },
    );
    // Artis tanpa lagu Library (hanya diputar).
    await service.upsertSong(song('v4', 'Empat', ['Hantu']).song, {});
    const page = await service.artistsPage({});
    expect(page.map((a) => a.artist.name)).toEqual(['Noah', 'Peterpan']);
    expect(page.find((a) => a.artist.name === 'Noah')?.songCount).toBe(2);
    expect(page.find((a) => a.artist.name === 'Peterpan')?.songCount).toBe(1);
  });

  it(
    'songsByArtistPage memakai pagination dan urut nama',
    async () => {
    const service = await makeService();
    const items: SongImport[] = [];
    for (let i = 0; i < 60; i++) {
      items.push(song(`a${i}`, `Lagu ${String(i).padStart(2, '0')}`, ['Noah']));
    }
    await service.importSongs(items, { addToLibrary: true });
    const artistId = localArtistIdForName('Noah');
    const p1 = await service.songsByArtistPage(artistId);
    expect(p1).toHaveLength(50);
    expect(p1[0]?.song.title).toBe('Lagu 00');
    const p2 = await service.songsByArtistPage(artistId, { after: p1[49] });
    expect(p2).toHaveLength(10);
    expect(p2[9]?.song.title).toBe('Lagu 59');
  }, 30000);

  it('albumsPage beserta hitungan lagu Library', async () => {
    const service = await makeService();
    const album = {
      id: 'alb1',
      title: 'Album Satu',
      year: 2020,
      thumbnailUrl: null,
      liked: 0,
    };
    await service.upsertSong(song('v1', 'Satu').song, {
      album,
      addToLibrary: true,
    });
    await service.upsertSong(song('v2', 'Dua').song, {
      album,
      addToLibrary: true,
    });
    const page = await service.albumsPage({});
    expect(page).toHaveLength(1);
    expect(page[0]?.album.title).toBe('Album Satu');
    expect(page[0]?.songCount).toBe(2);
    const songs = await service.songsByAlbumPage('alb1');
    expect(songs.map((v) => v.song.title)).toEqual(['Dua', 'Satu']);
  });

  it('mergeArtistChannel memindah lagu ke channelId', async () => {
    const service = await makeService();
    await service.upsertSong(song('v1', 'Lagu').song, {
      artistNames: ['Noah'],
      addToLibrary: true,
    });
    const pseudoId = localArtistIdForName('Noah');
    await service.mergeArtistChannel({
      name: 'Noah',
      channelId: 'UC-noah',
      thumbnailUrl: 'https://x/y.jpg',
    });
    expect(await service.artistById(pseudoId)).toBeNull();
    const artist = await service.artistById('UC-noah');
    expect(artist?.name).toBe('Noah');
    expect(artist?.thumbnailUrl).toBe('https://x/y.jpg');
    const songs = await service.songsByArtistPage('UC-noah');
    expect(songs.map((v) => v.song.id)).toEqual(['v1']);
    const found = await service.searchLocal('noah');
    expect(found.artists.map((a) => a.id)).toEqual(['UC-noah']);
  });
});

describe('libraryCounts', () => {
  it('menghitung isi library', async () => {
    const service = await makeService();
    await service.importSongs(
      [song('v1', 'Satu', ['Noah']), song('v2', 'Dua', ['Noah'])],
      { addToLibrary: true },
    );
    await service.toggleLiked('v1');
    await service.createPlaylist('P1');
    await service.recordPlay({ songId: 'v1', timestamp: 1, playTimeMs: 20000 });
    const counts = await service.libraryCounts();
    expect(counts.songs).toBe(2);
    expect(counts.favorites).toBe(1);
    expect(counts.playlists).toBe(1);
    expect(counts.historyEntries).toBe(1);
  });
});

describe('MAX_PLAY_EVENTS', () => {
  it('batas riwayat putar adalah 10000 (port APK)', () => {
    expect(MAX_PLAY_EVENTS).toBe(10000);
  });

  it('batas riwayat pencarian adalah 100 (port APK)', () => {
    expect(MAX_SEARCH_HISTORY).toBe(100);
  });

  it('batas nama dan deskripsi playlist (PRD B4.1)', () => {
    expect(MAX_PLAYLIST_NAME_LENGTH).toBe(100);
    expect(MAX_PLAYLIST_DESCRIPTION_LENGTH).toBe(500);
  });
});

describe('playlist', () => {
  it('buat, ubah nama, ubah deskripsi, hapus', async () => {
    const service = await makeService();
    const id = await service.createPlaylist('Campuran', {
      description: 'Lagu santai',
    });
    expect((await service.playlistById(id))?.name).toBe('Campuran');
    await service.renamePlaylist(id, 'Campuran Baru');
    await service.updatePlaylistDescription(id, 'Deskripsi baru');
    const row = await service.playlistById(id);
    expect(row?.name).toBe('Campuran Baru');
    expect(row?.description).toBe('Deskripsi baru');
    await service.deletePlaylist(id);
    expect(await service.playlistById(id)).toBeNull();
  });

  it('validasi nama kosong dan terlalu panjang', async () => {
    const service = await makeService();
    await expect(service.createPlaylist('   ')).rejects.toThrow();
    await expect(service.createPlaylist('x'.repeat(101))).rejects.toThrow();
    await expect(
      service.createPlaylist('Ok', { description: 'y'.repeat(501) }),
    ).rejects.toThrow();
  });

  it('tambah lagu, tolak duplikat, lagu masuk Library', async () => {
    const service = await makeService();
    await service.upsertSong(song('v1', 'Satu').song, {});
    const id = await service.createPlaylist('P');
    expect(await service.addSongToPlaylist(id, 'v1')).toBe(true);
    expect(await service.addSongToPlaylist(id, 'v1')).toBe(false);
    expect((await service.songById('v1'))?.song.inLibrary).toBe(1);
    const entries = await service.playlistSongsPage(id, {});
    expect(entries).toHaveLength(1);
    expect(entries[0]?.position).toBe(0);
  });

  it('hapus lagu merapatkan posisi', async () => {
    const service = await makeService();
    const items = [song('v1', 'Satu'), song('v2', 'Dua'), song('v3', 'Tiga')];
    await service.importSongs(items, { addToLibrary: true });
    const id = await service.createPlaylist('P');
    await service.addSongsToPlaylist(id, ['v1', 'v2', 'v3']);
    await service.removeSongFromPlaylist(id, 'v2');
    const entries = await service.playlistSongsPage(id, {});
    expect(entries.map((e) => [e.song.song.id, e.position])).toEqual([
      ['v1', 0],
      ['v3', 1],
    ]);
  });

  it('pindah lagu ke posisi baru', async () => {
    const service = await makeService();
    await service.importSongs(
      [song('v1', 'Satu'), song('v2', 'Dua'), song('v3', 'Tiga')],
      { addToLibrary: true },
    );
    const id = await service.createPlaylist('P');
    await service.addSongsToPlaylist(id, ['v1', 'v2', 'v3']);
    await service.moveSongInPlaylist(id, 'v3', 0);
    const entries = await service.playlistSongsPage(id, {});
    expect(entries.map((e) => e.song.song.id)).toEqual(['v3', 'v1', 'v2']);
  });

  it('playlistsPage urut terakhir diubah dulu, beserta hitungan', async () => {
    const service = await makeService();
    const a = await service.createPlaylist('A');
    const b = await service.createPlaylist('B');
    await service.importSongs([song('v1', 'Satu')], { addToLibrary: true });
    // Jeda kecil supaya updatedAt A benar-benar lebih baru dari B
    // (timestamp milidetik; tanpa jeda bisa seri dan tiebreak id
    // akan menaruh B di depan).
    await new Promise((resolve) => setTimeout(resolve, 5));
    await service.addSongToPlaylist(a, 'v1');
    // Menyentuh A membuatnya paling baru diubah.
    const page = await service.playlistsPage({});
    expect(page.map((p) => p.playlist.id)).toEqual([a, b]);
    expect(page[0]?.songCount).toBe(1);
    expect(page[1]?.songCount).toBe(0);
  });

  it('playlistSongsForPlayback mulai dari lagu yang dipilih', async () => {
    const service = await makeService();
    await service.importSongs(
      [song('v1', 'Satu'), song('v2', 'Dua'), song('v3', 'Tiga')],
      { addToLibrary: true },
    );
    const id = await service.createPlaylist('P');
    await service.addSongsToPlaylist(id, ['v1', 'v2', 'v3']);
    const songs = await service.playlistSongsForPlayback(id, {
      startSongId: 'v2',
    });
    expect(songs.map((v) => v.song.id)).toEqual(['v2', 'v3']);
  });
});

describe('riwayat putar', () => {
  it('recordPlay menambah event dan total waktu putar', async () => {
    const service = await makeService();
    await service.upsertSong(song('v1', 'Satu').song, {});
    await service.recordPlay({ songId: 'v1', timestamp: 100, playTimeMs: 45000 });
    await service.recordPlay({ songId: 'v1', timestamp: 200, playTimeMs: 15000 });
    expect((await service.songById('v1'))?.song.totalPlayTimeMs).toBe(60000);
    const history = await service.historyPage({});
    expect(history).toHaveLength(2);
    expect(history[0]?.event.timestamp).toBe(200);
    expect(history[1]?.event.timestamp).toBe(100);
  });

  it('clearHistory menghapus event tapi tidak mereset total putar', async () => {
    const service = await makeService();
    await service.upsertSong(song('v1', 'Satu').song, {});
    await service.recordPlay({ songId: 'v1', timestamp: 100, playTimeMs: 45000 });
    await service.clearHistory();
    expect(await service.historyPage({})).toHaveLength(0);
    expect((await service.songById('v1'))?.song.totalPlayTimeMs).toBe(45000);
  });

  it('recentPlayedSongs tanpa duplikat, di posisi putaran terakhir', async () => {
    const service = await makeService();
    await service.importSongs([song('v1', 'Satu'), song('v2', 'Dua')], {});
    await service.recordPlay({ songId: 'v1', timestamp: 100, playTimeMs: 20000 });
    await service.recordPlay({ songId: 'v2', timestamp: 200, playTimeMs: 20000 });
    await service.recordPlay({ songId: 'v1', timestamp: 300, playTimeMs: 20000 });
    const recent = await service.recentPlayedSongs({});
    expect(recent.map((v) => v.song.id)).toEqual(['v1', 'v2']);
  });

  it('meaningfulPlayCount hanya menghitung putaran 30 detik ke atas', async () => {
    const service = await makeService();
    await service.upsertSong(song('v1', 'Satu').song, {});
    await service.recordPlay({ songId: 'v1', timestamp: Date.now(), playTimeMs: 15000 });
    await service.recordPlay({ songId: 'v1', timestamp: Date.now(), playTimeMs: 30000 });
    await service.recordPlay({ songId: 'v1', timestamp: Date.now(), playTimeMs: 90000 });
    expect(await service.meaningfulPlayCount('v1')).toBe(2);
  });
});

describe('pencarian lokal', () => {
  async function seed(service: LibraryService): Promise<void> {
    await service.importSongs(
      [
        song('v1', 'Semua Tentang Kita', ['Peterpan']),
        song('v2', 'Rahasia Hati', ['Element']),
        song('v3', 'Surat Cinta Untuk Starla', ['Virgoun']),
        song('v4', 'Kita Semua Sama', ['Noah']),
      ],
      { addToLibrary: true },
    );
  }

  it('cocok judul dan artis lewat awalan token', async () => {
    const service = await makeService();
    await seed(service);
    const byTitle = await service.searchLocal('semua');
    // v1 dan v4 sama-sama punya token "semua" (skor sama),
    // tiebreak judul: "Kita Semua Sama" < "Semua Tentang Kita".
    expect(byTitle.songs.map((v) => v.song.id)).toEqual(['v4', 'v1']);
    const byArtist = await service.searchLocal('peter');
    expect(byArtist.songs.map((v) => v.song.id)).toEqual(['v1']);
    expect(byArtist.artists.map((a) => a.name)).toEqual(['Peterpan']);
  });

  it('AND dulu: semua kata wajib cocok', async () => {
    const service = await makeService();
    await seed(service);
    const found = await service.searchLocal('semua kita');
    // v1 dan v4 sama-sama mengandung kedua kata (skor sama),
    // tiebreak judul menaruh v4 di depan.
    expect(found.songs.map((v) => v.song.id)).toEqual(['v4', 'v1']);
  });

  it('OR sebagai cadangan bila AND kosong', async () => {
    const service = await makeService();
    await seed(service);
    const found = await service.searchLocal('starla hati');
    expect(found.songs.map((v) => v.song.id).sort()).toEqual(['v2', 'v3']);
  });

  it('peringkat: cocok persis di judul di atas cocok awalan', async () => {
    const service = await makeService();
    await seed(service);
    const found = await service.searchLocal('kita');
    // v1: "kita" persis di judul; v4: "kita" persis di judul juga,
    // tiebreak judul lalu id: "Kita Semua Sama" < "Semua Tentang Kita".
    expect(found.songs.map((v) => v.song.id)).toEqual(['v4', 'v1']);
  });

  it('kueri kosong dan tidak cocok menghasilkan daftar kosong', async () => {
    const service = await makeService();
    await seed(service);
    expect(await service.searchLocal('')).toEqual({ songs: [], artists: [] });
    expect(await service.searchLocal('zzzqqq')).toEqual({
      songs: [],
      artists: [],
    });
  });

  it('rebuildTokenIndex memulihkan indeks yang terhapus', async () => {
    const service = await makeService();
    await seed(service);
    // Ubah judul: token lama wajib hilang, token baru wajib ada.
    await service.upsertSong(song('v1', 'Judul Sama Sekali Baru').song, {
      artistNames: ['Peterpan'],
      addToLibrary: true,
    });
    const found = await service.searchLocal('sama sekali');
    expect(found.songs.map((v) => v.song.id)).toEqual(['v1']);
    const gone = await service.searchLocal('tentang');
    expect(gone.songs).toHaveLength(0);
    await service.rebuildTokenIndex();
    const again = await service.searchLocal('sama sekali');
    expect(again.songs.map((v) => v.song.id)).toEqual(['v1']);
  });
});

describe('riwayat pencarian', () => {
  it('tambah, dedup tanpa membedakan kapitalisasi, terbaru dulu', async () => {
    const service = await makeService();
    await service.addSearchQuery('Noah');
    await service.addSearchQuery('Peterpan');
    await service.addSearchQuery('noah');
    const recent = await service.recentSearches({});
    expect(recent).toEqual(['noah', 'Peterpan']);
  });

  it('searchHistoryMatching memberi saran dari awalan', async () => {
    const service = await makeService();
    await service.addSearchQuery('Noah');
    await service.addSearchQuery('Noah Band');
    await service.addSearchQuery('Peterpan');
    const matches = await service.searchHistoryMatching('noa');
    expect(matches).toEqual(['Noah Band', 'Noah']);
  });

  it('hapus satu query dan hapus semua', async () => {
    const service = await makeService();
    await service.addSearchQuery('Noah');
    await service.addSearchQuery('Peterpan');
    await service.deleteSearchQuery('Noah');
    expect(await service.recentSearches({})).toEqual(['Peterpan']);
    await service.clearSearchHistory();
    expect(await service.recentSearches({})).toEqual([]);
  });

  it(
    'dibatasi 100 query, yang terlama dibuang',
    async () => {
    const service = await makeService();
    for (let i = 0; i < 105; i++) {
      await service.addSearchQuery(`q${String(i).padStart(3, '0')}`);
    }
    const recent = await service.recentSearches({ limit: 200 });
    expect(recent).toHaveLength(100);
    expect(recent[0]).toBe('q104');
    expect(recent).not.toContain('q000');
    expect(recent).toContain('q005');
  }, 30000);
});

describe('antrean dan status pemutar', () => {
  it('replaceQueue, loadQueue, clearQueue', async () => {
    const service = await makeService();
    await service.replaceQueue([
      { songId: 'v1', source: null, kind: 'stream' },
      { songId: 'v2', source: 'playlist', kind: 'stream' },
    ]);
    const items = await service.loadQueue();
    expect(items.map((i) => [i.position, i.songId])).toEqual([
      [0, 'v1'],
      [1, 'v2'],
    ]);
    expect(items[1]?.source).toBe('playlist');
    await service.replaceQueue([]);
    expect(await service.loadQueue()).toHaveLength(0);
    await service.replaceQueue([{ songId: 'v9', source: null, kind: 'local' }]);
    await service.clearQueue();
    expect(await service.loadQueue()).toHaveLength(0);
  });

  it('savePlaybackState, loadPlaybackState, savePlaybackPosition', async () => {
    const service = await makeService();
    expect(await service.loadPlaybackState()).toBeNull();
    await service.savePlaybackState({
      currentIndex: 2,
      positionMs: 12345,
      shuffleEnabled: true,
      repeatMode: 1,
      order: [2, 0, 1],
      rate: 1.25,
      volume: 0.8,
    });
    const state = await service.loadPlaybackState();
    expect(state).toEqual({
      currentIndex: 2,
      positionMs: 12345,
      shuffleEnabled: true,
      repeatMode: 1,
      order: [2, 0, 1],
      rate: 1.25,
      volume: 0.8,
    });
    await service.savePlaybackPosition(99999);
    const after = await service.loadPlaybackState();
    expect(after?.positionMs).toBe(99999);
    expect(after?.currentIndex).toBe(2);
    await service.clearPlaybackState();
    expect(await service.loadPlaybackState()).toBeNull();
  });
});

describe('lirik', () => {
  it('simpan dan ambil lirik', async () => {
    const service = await makeService();
    expect(await service.getLyrics('v1')).toBeNull();
    expect(
      await service.saveLyrics({ songId: 'v1', lyrics: 'la la la' }),
    ).toBe(true);
    expect(await service.getLyrics('v1')).toEqual({
      lyrics: 'la la la',
      syncedLyrics: null,
    });
  });

  it('menolak lirik di atas 256 KB', async () => {
    const service = await makeService();
    const huge = 'x'.repeat(256 * 1024 + 1);
    expect(await service.saveLyrics({ songId: 'v1', lyrics: huge })).toBe(false);
    expect(await service.getLyrics('v1')).toBeNull();
  });
});

describe('lagu tidak bisa diputar', () => {
  it('tandai, bersihkan, hitung, hapus massal (unduhan dipertahankan)', async () => {
    const service = await makeService();
    await service.importSongs(
      [song('v1', 'Satu'), song('v2', 'Dua'), song('v3', 'Tiga')],
      { addToLibrary: true },
    );
    await service.markDownloaded({
      songId: 'v3',
      filePath: 'blob:1',
      fileSizeBytes: 1234,
    });
    await service.markUnplayable('v1');
    await service.markUnplayable('v3');
    expect(await service.isUnplayable('v1')).toBe(true);
    expect(await service.unplayableCount()).toBe(1);
    await service.clearUnplayable('v1');
    expect(await service.isUnplayable('v1')).toBe(false);
    await service.markUnplayable('v1');
    await service.markUnplayable('v2');
    expect(await service.deleteUnplayableSongs()).toBe(2);
    expect(await service.songById('v1')).toBeNull();
    expect(await service.songById('v2')).toBeNull();
    expect((await service.songById('v3'))?.song.title).toBe('Tiga');
  });
});

describe('pekerjaan unduhan dan cache', () => {
  it('upsert job, reset yang tertinggal mengunduh, pangkas selesai lama', async () => {
    const service = await makeService();
    await service.upsertDownloadJob({ songId: 'v1', status: 1 });
    await service.upsertDownloadJob({ songId: 'v2', status: 4 });
    expect(await service.resetRunningJobsToQueued()).toBe(1);
    expect((await service.downloadJobBySongId('v1'))?.status).toBe(0);
    await service.upsertDownloadJob({ songId: 'v3', status: 4 });
    // Batas negatif membuat semua job selesai terlihat "lama".
    expect(await service.pruneCompletedJobs({ olderThanMs: -1 })).toBe(2);
    expect(await service.downloadJobs()).toHaveLength(1);
  });

  it('cache: simpan, cari per lagu, LRU', async () => {
    const service = await makeService();
    await service.upsertCacheEntry({
      key: 'v1_251',
      filePath: 'blob:a',
      sizeBytes: 100,
    });
    await service.upsertCacheEntry({
      key: 'v1_140',
      filePath: 'blob:b',
      sizeBytes: 200,
    });
    await service.upsertCacheEntry({
      key: 'v2_251',
      filePath: 'blob:c',
      sizeBytes: 300,
    });
    const entries = await service.cacheEntriesForVideo('v1');
    expect(entries.map((e) => e.key).sort()).toEqual(['v1_140', 'v1_251']);
    const stats = await service.storageStats();
    expect(stats.playedSongsCount).toBe(3);
    expect(stats.playedSongsBytes).toBe(600);
    await service.touchCacheEntry('v1_251');
    await service.deleteCacheEntry('v2_251');
    const lru = await service.cacheEntriesByLru({ limit: 10 });
    expect(lru.map((e) => e.key)).toEqual(['v1_140', 'v1_251']);
  });

  it('updateDownloadJob memperbarui sebagian tanpa menimpa kolom lain (P5)', async () => {
    const service = await makeService();
    await service.upsertDownloadJob({
      songId: 'v1',
      status: 1,
      quality: 251,
      bytesDownloaded: 100,
      totalBytes: 2500,
      attempts: 1,
      errorMessage: null,
      createdAt: 1,
    });
    await service.updateDownloadJob('v1', { bytesDownloaded: 500 });
    const job = await service.downloadJobBySongId('v1');
    expect(job).toMatchObject({
      status: 1,
      quality: 251,
      bytesDownloaded: 500,
      totalBytes: 2500,
      attempts: 1,
    });
  });

  it('downloadedSongsList mengembalikan unduhan, terbaru dulu (P5)', async () => {
    const service = await makeService();
    await service.importSongs(
      [
        song('d1', 'Unduhan 1', [], 1000),
        song('d2', 'Unduhan 2', [], 2000),
        song('n1', 'Bukan unduhan', [], 3000),
      ],
      { addToLibrary: true },
    );
    await service.markDownloaded({
      songId: 'd1',
      filePath: '/dl/d1',
      fileSizeBytes: 100,
    });
    // Jeda 2 ms supaya stempel waktu unduhan d2 pasti lebih
    // baru dari d1 (tanpa jeda keduanya bisa sama dan urutan
    // jatuh ke tie-break id).
    await new Promise((r) => setTimeout(r, 2));
    await service.markDownloaded({
      songId: 'd2',
      filePath: '/dl/d2',
      fileSizeBytes: 200,
    });
    const list = await service.downloadedSongsList();
    expect(list.map((s) => s.song.id)).toEqual(['d2', 'd1']);
    expect(list[0].song.fileSizeBytes).toBe(200);
  });
});

describe('subscribe', () => {
  it('pendengar dipanggil saat data berubah', async () => {
    const service = await makeService();
    let calls = 0;
    const off = service.subscribe(() => {
      calls += 1;
    });
    await service.createPlaylist('P');
    expect(calls).toBe(1);
    off();
    await service.createPlaylist('Q');
    expect(calls).toBe(1);
  });
});
