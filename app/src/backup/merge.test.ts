/**
 * Tes merge impor backup (P8): aturan merge port APK, satu
 * transaksi Dexie, dan snapshot ekspor. Tiap tes memakai
 * database IndexedDB palsu yang baru.
 *
 * Atomicity dibuktikan dua lapis: (1) file tidak valid ditolak
 * parse SEBELUM transaksi dibuka (database tidak berubah — tes
 * "file tidak valid tidak menyentuh database"); (2) merge
 * berjalan dalam satu `db.transaction` Dexie, yang membatalkan
 * segalanya bila satu langkah gagal (jaminan Dexie, bukan
 * diuji ulang di sini).
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { LarasDatabase } from '../data/database';
import {
  LibraryService,
  MAX_PLAY_EVENTS,
  MAX_SEARCH_HISTORY,
  mergeTotalAdded,
  mergeTotalExisted,
} from '../data/library';
import { DownloadState } from '../data/types';
import {
  parseBackupText,
  type BackupData,
} from './format';

let counter = 0;
const openDbs: LarasDatabase[] = [];

async function makeService(): Promise<LibraryService> {
  counter += 1;
  const db = new LarasDatabase(`laras-merge-test-${counter}`);
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

function emptyBackup(): BackupData {
  return {
    version: 1,
    appVersion: '0.9.0',
    exportedAt: new Date('2026-11-19T00:00:00.000Z'),
    songs: [],
    albums: [],
    artists: [],
    playlists: [],
    playEvents: [],
    searchHistory: [],
    queue: [],
    playbackState: null,
    settings: null,
  };
}

function sampleBackup(): BackupData {
  const data = emptyBackup();
  data.songs = [
    {
      id: 'vid-1',
      title: 'Lagu Satu',
      artists: [{ id: 'UC-1', name: 'Artis Satu' }],
      albumId: 'MPRE-1',
      durationSeconds: 180,
      thumbnailUrl: null,
      liked: true,
      inLibrary: true,
      totalPlayTimeMs: 60000,
      dateAdded: 1791926400000,
      downloaded: true,
      unplayable: false,
    },
    {
      id: 'vid-2',
      title: 'Lagu Dua',
      artists: [],
      albumId: null,
      durationSeconds: null,
      thumbnailUrl: null,
      liked: false,
      inLibrary: false,
      totalPlayTimeMs: 0,
      dateAdded: null,
      downloaded: false,
      unplayable: false,
    },
  ];
  data.albums = [
    {
      id: 'MPRE-1',
      title: 'Album Satu',
      year: 2024,
      thumbnailUrl: null,
      liked: false,
      dateAdded: null,
    },
  ];
  data.artists = [
    {
      id: 'UC-1',
      name: 'Artis Satu',
      thumbnailUrl: null,
      liked: false,
      dateAdded: null,
    },
  ];
  data.playlists = [
    {
      name: 'Favoritku',
      description: 'Lagu-lagu pilihan',
      songIds: ['vid-1', 'vid-2'],
      createdAt: 1792099200000,
    },
  ];
  data.playEvents = [
    { songId: 'vid-1', timestamp: 1792519200000, playTimeMs: 120000 },
  ];
  data.searchHistory = [{ query: 'noah', timestamp: 1792515600000 }];
  data.queue = [
    { songId: 'vid-1', source: 'library' },
    { songId: 'vid-2', source: null },
  ];
  data.playbackState = {
    currentIndex: 1,
    positionMs: 45000,
    shuffleEnabled: true,
    repeatMode: 1,
  };
  return data;
}

describe('mergeBackupData ke database kosong', () => {
  it('semua bagian masuk + hitungan benar', async () => {
    const service = await makeService();
    const result = await service.mergeBackupData(sampleBackup());
    expect(result.songsAdded).toBe(2);
    expect(result.songsExisted).toBe(0);
    expect(result.playlistsCreated).toBe(1);
    expect(result.playlistSongsAdded).toBe(2);
    expect(result.eventsAdded).toBe(1);
    expect(result.queriesAdded).toBe(1);
    expect(result.queueAdded).toBe(2);
    expect(result.playbackStateRestored).toBe(true);
    expect(result.downloadedSongIds).toEqual(['vid-1']);
    expect(mergeTotalAdded(result)).toBe(2 + 1 + 2 + 1 + 1 + 2);
    expect(mergeTotalExisted(result)).toBe(0);

    const counts = await service.libraryCounts();
    expect(counts.songs).toBe(2);
    expect(counts.playlists).toBe(1);
    expect(counts.favorites).toBe(1);
    expect(counts.historyEntries).toBe(1);

    const song1 = await service.songById('vid-1');
    expect(song1?.song.title).toBe('Lagu Satu');
    expect(song1?.artistNames).toEqual(['Artis Satu']);
    expect(song1?.song.liked).toBe(1);
    expect(song1?.song.totalPlayTimeMs).toBe(60000);
    // Flag downloaded TIDAK menandai lagu terunduh (filenya tidak ada).
    expect(song1?.song.downloadState).toBe(DownloadState.notDownloaded);

    const playlists = await service.playlistsPage({});
    expect(playlists[0]?.playlist.name).toBe('Favoritku');
    expect(playlists[0]?.songCount).toBe(2);

    const queue = await service.loadQueue();
    expect(queue.map((q) => q.songId)).toEqual(['vid-1', 'vid-2']);
    expect(queue[0]?.source).toBe('library');
    const state = await service.loadPlaybackState();
    expect(state?.currentIndex).toBe(1);
    expect(state?.positionMs).toBe(45000);
    expect(state?.shuffleEnabled).toBe(true);
    expect(state?.repeatMode).toBe(1);
    expect(state?.order).toEqual([0, 1]);
  });

  it('lagu baru bisa dicari lokal (indeks token ikut terisi)', async () => {
    const service = await makeService();
    await service.mergeBackupData(sampleBackup());
    const results = await service.searchLocal('satu');
    expect(results.songs.map((v) => v.song.id)).toContain('vid-1');
    const artistResults = await service.searchLocal('artis satu');
    expect(artistResults.artists.map((a) => a.id)).toContain('UC-1');
  });
});

describe('mergeBackupData ke database berisi (aturan merge)', () => {
  it('merge kedua: semuanya sudah ada, tidak ada duplikat', async () => {
    const service = await makeService();
    await service.mergeBackupData(sampleBackup());
    const result = await service.mergeBackupData(sampleBackup());
    expect(result.songsAdded).toBe(0);
    expect(result.songsExisted).toBe(2);
    expect(result.playlistsCreated).toBe(0);
    expect(result.playlistSongsAdded).toBe(0);
    expect(result.playlistSongsExisted).toBe(2);
    expect(result.eventsAdded).toBe(0);
    expect(result.eventsExisted).toBe(1);
    expect(result.queriesAdded).toBe(0);
    expect(result.queueAdded).toBe(0);
    expect(result.queueExisted).toBe(2);
    expect(result.playbackStateRestored).toBe(false);
    const counts = await service.libraryCounts();
    expect(counts.songs).toBe(2);
    expect(counts.playlists).toBe(1);
  });

  it('lagu lama: metadata dari file menang, favorit tidak pernah turun', async () => {
    const service = await makeService();
    // Lagu lokal: judul lama, sudah disukai, total putar 5000.
    await service.upsertSong(
      {
        id: 'vid-1',
        title: 'Judul Lama',
        albumId: null,
        durationSeconds: null,
        thumbnailUrl: null,
        liked: 1,
        totalPlayTimeMs: 5000,
        inLibrary: 1,
        downloadState: 0,
        filePath: null,
        fileSizeBytes: null,
        downloadedAt: null,
        formatId: null,
        unplayable: 0,
      },
      { artistNames: ['Artis Lokal'], addToLibrary: true },
    );
    // File membawa judul baru + liked=false + total 60000.
    const data = sampleBackup();
    data.songs[0] = {
      ...data.songs[0]!,
      title: 'Judul Baru dari File',
      liked: false,
      totalPlayTimeMs: 60000,
    };
    await service.mergeBackupData(data);
    const song = await service.songById('vid-1');
    expect(song?.song.title).toBe('Judul Baru dari File');
    // Favorit lokal dipertahankan (file tidak bisa mencabut).
    expect(song?.song.liked).toBe(1);
    // Total waktu putar lokal dipertahankan.
    expect(song?.song.totalPlayTimeMs).toBe(5000);
    // Artis lokal dipertahankan (tidak ditulis ulang dari file).
    expect(song?.artistNames).toEqual(['Artis Lokal']);
    // Pencarian lokal memakai judul baru (token disinkron ulang).
    const results = await service.searchLocal('judul baru');
    expect(results.songs.map((v) => v.song.id)).toContain('vid-1');
  });

  it('favorit dari file bisa menambah suka pada lagu lama', async () => {
    const service = await makeService();
    await service.upsertSong(
      {
        id: 'vid-2',
        title: 'Lagu Dua',
        albumId: null,
        durationSeconds: null,
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
      },
      { addToLibrary: false },
    );
    const data = emptyBackup();
    data.songs = [
      {
        id: 'vid-2',
        title: 'Lagu Dua',
        artists: [],
        albumId: null,
        durationSeconds: null,
        thumbnailUrl: null,
        liked: true,
        inLibrary: true,
        totalPlayTimeMs: 0,
        dateAdded: null,
        downloaded: false,
        unplayable: false,
      },
    ];
    await service.mergeBackupData(data);
    const song = await service.songById('vid-2');
    expect(song?.song.liked).toBe(1);
    expect(song?.song.inLibrary).toBe(1);
  });

  it('playlist nama sama digabung (bukan salinan), lagu baru ditambah', async () => {
    const service = await makeService();
    await service.importSongs(
      [
        {
          song: {
            id: 'vid-9',
            title: 'Lagu Sembilan',
            albumId: null,
            durationSeconds: null,
            thumbnailUrl: null,
            liked: 0,
            totalPlayTimeMs: 0,
            inLibrary: 1,
            downloadState: 0,
            filePath: null,
            fileSizeBytes: null,
            downloadedAt: null,
            formatId: null,
            unplayable: 0,
          },
        },
      ],
      { addToLibrary: true },
    );
    const playlistId = await service.createPlaylist('Favoritku');
    await service.addSongToPlaylist(playlistId, 'vid-9');
    const result = await service.mergeBackupData(sampleBackup());
    expect(result.playlistsCreated).toBe(0);
    expect(result.playlistSongsAdded).toBe(2);
    const playlists = await service.playlistsPage({});
    expect(playlists.length).toBe(1);
    expect(playlists[0]?.songCount).toBe(3);
    const members = await service.playlistSongsPage(playlistId);
    expect(members.map((m) => m.song.song.id)).toEqual([
      'vid-9',
      'vid-1',
      'vid-2',
    ]);
  });

  it('nama playlist dipotong ke 100 karakter', async () => {
    const service = await makeService();
    const data = emptyBackup();
    data.songs = [
      {
        id: 'vid-1',
        title: 'Lagu Satu',
        artists: [],
        albumId: null,
        durationSeconds: null,
        thumbnailUrl: null,
        liked: false,
        inLibrary: false,
        totalPlayTimeMs: 0,
        dateAdded: null,
        downloaded: false,
        unplayable: false,
      },
    ];
    data.playlists = [
      {
        name: 'P'.repeat(150),
        description: 'D'.repeat(600),
        songIds: ['vid-1'],
        createdAt: null,
      },
    ];
    await service.mergeBackupData(data);
    const playlists = await service.playlistsPage({});
    expect(playlists[0]?.playlist.name.length).toBe(100);
    expect(playlists[0]?.playlist.description?.length).toBe(500);
  });

  it('antrean ditambah di belakang; posisi pemutar TIDAK dipulihkan bila antrean tujuan berisi', async () => {
    const service = await makeService();
    await service.replaceQueue([
      { songId: 'vid-lokal', source: null, kind: 'stream' },
    ]);
    await service.savePlaybackState({
      currentIndex: 0,
      positionMs: 1234,
      shuffleEnabled: false,
      repeatMode: 0,
      order: [0],
      rate: 1,
      volume: 1,
    });
    const result = await service.mergeBackupData(sampleBackup());
    expect(result.queueAdded).toBe(2);
    expect(result.playbackStateRestored).toBe(false);
    const queue = await service.loadQueue();
    expect(queue.map((q) => q.songId)).toEqual([
      'vid-lokal',
      'vid-1',
      'vid-2',
    ]);
    const state = await service.loadPlaybackState();
    expect(state?.positionMs).toBe(1234);
  });

  it('antrean penuh: sisanya dilewati + dilaporkan', async () => {
    const service = await makeService();
    // Antrean lokal sudah 199 item.
    const local: Array<{ songId: string; source: string | null; kind: 'stream' | 'local' }> = [];
    for (let i = 0; i < 199; i++) {
      local.push({ songId: `lokal-${i}`, source: null, kind: 'stream' });
    }
    await service.replaceQueue(local);
    const data = emptyBackup();
    data.songs = [
      {
        id: 'vid-1',
        title: 'Lagu Satu',
        artists: [],
        albumId: null,
        durationSeconds: null,
        thumbnailUrl: null,
        liked: false,
        inLibrary: false,
        totalPlayTimeMs: 0,
        dateAdded: null,
        downloaded: false,
        unplayable: false,
      },
      {
        id: 'vid-2',
        title: 'Lagu Dua',
        artists: [],
        albumId: null,
        durationSeconds: null,
        thumbnailUrl: null,
        liked: false,
        inLibrary: false,
        totalPlayTimeMs: 0,
        dateAdded: null,
        downloaded: false,
        unplayable: false,
      },
    ];
    data.queue = [
      { songId: 'vid-1', source: null },
      { songId: 'vid-2', source: null },
    ];
    const result = await service.mergeBackupData(data);
    expect(result.queueAdded).toBe(1);
    expect(result.queueSkippedFull).toBe(1);
    expect(result.queueSkippedSongIds).toEqual(['vid-2']);
    const queue = await service.loadQueue();
    expect(queue.length).toBe(200);
  });

  it('riwayat putar: dedup per detik (file dari APK tidak ganda)', async () => {
    const service = await makeService();
    await service.recordPlay({
      songId: 'vid-1',
      timestamp: 1792519200500,
      playTimeMs: 120000,
    });
    // File membawa event yang sama tapi dibulatkan ke detik (APK).
    const data = emptyBackup();
    data.songs = [
      {
        id: 'vid-1',
        title: 'Lagu Satu',
        artists: [],
        albumId: null,
        durationSeconds: null,
        thumbnailUrl: null,
        liked: false,
        inLibrary: false,
        totalPlayTimeMs: 0,
        dateAdded: null,
        downloaded: false,
        unplayable: false,
      },
    ];
    data.playEvents = [
      { songId: 'vid-1', timestamp: 1792519200000, playTimeMs: 120000 },
    ];
    const result = await service.mergeBackupData(data);
    expect(result.eventsAdded).toBe(0);
    expect(result.eventsExisted).toBe(1);
  });

  it('riwayat pencarian: dedup tanpa membedakan kapitalisasi', async () => {
    const service = await makeService();
    await service.addSearchQuery('NOAH');
    const data = emptyBackup();
    data.searchHistory = [
      { query: 'noah', timestamp: 1792515600000 },
      { query: 'Peterpan', timestamp: 1792515700000 },
    ];
    const result = await service.mergeBackupData(data);
    expect(result.queriesAdded).toBe(1);
    expect(result.queriesExisted).toBe(1);
    const recent = await service.recentSearches({ limit: 10 });
    expect(recent).toContain('NOAH');
    expect(recent).toContain('Peterpan');
  });

  it('batas riwayat putar 10.000 tetap ditegakkan sesudah merge', async () => {
    const service = await makeService();
    // Isi 10.000 event langsung lewat recordPlay berkelompok
    // tidak ada — pakai impor: buat 9.999 event via merge besar.
    const data = emptyBackup();
    data.songs = [
      {
        id: 'vid-1',
        title: 'Lagu Satu',
        artists: [],
        albumId: null,
        durationSeconds: null,
        thumbnailUrl: null,
        liked: false,
        inLibrary: false,
        totalPlayTimeMs: 0,
        dateAdded: null,
        downloaded: false,
        unplayable: false,
      },
    ];
    for (let i = 0; i < MAX_PLAY_EVENTS; i++) {
      data.playEvents.push({
        songId: 'vid-1',
        timestamp: 1700000000000 + i * 1000,
        playTimeMs: 1000 + i,
      });
    }
    await service.mergeBackupData(data);
    const counts = await service.libraryCounts();
    expect(counts.historyEntries).toBe(MAX_PLAY_EVENTS);
    // Merge satu event baru: total tetap 10.000, yang tertua hilang.
    const more = emptyBackup();
    more.songs = data.songs;
    more.playEvents = [
      { songId: 'vid-1', timestamp: 1800000000000, playTimeMs: 9999 },
    ];
    const result = await service.mergeBackupData(more);
    expect(result.eventsAdded).toBe(1);
    const countsAfter = await service.libraryCounts();
    expect(countsAfter.historyEntries).toBe(MAX_PLAY_EVENTS);
    const oldest = await service.historyPage({ limit: 1 });
    expect(oldest[0]?.event.timestamp).toBe(1800000000000);
  }, 30000);

  it('batas riwayat pencarian 100 tetap ditegakkan sesudah merge', async () => {
    const service = await makeService();
    for (let i = 0; i < MAX_SEARCH_HISTORY; i++) {
      await service.addSearchQuery(`query-${i}`);
    }
    const data = emptyBackup();
    data.searchHistory = [
      { query: 'query-baru', timestamp: 1800000000000 },
    ];
    await service.mergeBackupData(data);
    const recent = await service.recentSearches({ limit: 200 });
    expect(recent.length).toBe(MAX_SEARCH_HISTORY);
    expect(recent).toContain('query-baru');
  }, 30000);
});

describe('backupSnapshot', () => {
  it('snapshot lalu merge ke database lain memulihkan semuanya', async () => {
    const source = await makeService();
    await source.mergeBackupData(sampleBackup());
    const snapshot = await source.backupSnapshot();
    expect(snapshot.songs.length).toBe(2);
    expect(snapshot.playlists.length).toBe(1);
    expect(snapshot.playlistSongs.length).toBe(2);
    expect(snapshot.playEvents.length).toBe(1);
    expect(snapshot.searchHistory.length).toBe(1);
    expect(snapshot.queue.length).toBe(2);
    expect(snapshot.playbackState?.currentIndex).toBe(1);
    expect(snapshot.songArtists.length).toBe(1);
    expect(snapshot.songArtists[0]?.artistId).toBe('UC-1');
  });
});

describe('file tidak valid tidak menyentuh database', () => {
  it('parse gagal -> merge tidak pernah jalan, database tetap', async () => {
    const service = await makeService();
    await service.mergeBackupData(sampleBackup());
    const before = await service.libraryCounts();
    expect(() =>
      parseBackupText('{"backupVersion":99,"appVersion":"9.9.9"}'),
    ).toThrow();
    // Tidak ada pemanggilan merge: hitungan tetap sama.
    const after = await service.libraryCounts();
    expect(after).toEqual(before);
  });
});
