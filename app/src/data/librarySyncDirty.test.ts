/**
 * Tes penanda dirty untuk dorong delta (P-PushDelta): mutasi
 * lokal menandai baris yang berubah, jalur tarik tidak menandai,
 * penghapusan berversi melindungi edit di tengah sync.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { LarasDatabase } from './database';
import { LibraryService } from './library';
import type { BackupData } from '../backup/format';
import type { SongImport } from './types';

let counter = 0;
const openDbs: LarasDatabase[] = [];

async function makeService(): Promise<LibraryService> {
  counter += 1;
  const db = new LarasDatabase(`laras-dirty-test-${counter}`);
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

function song(id: string, liked = 0): SongImport {
  return {
    song: {
      id,
      title: `Lagu ${id}`,
      albumId: null,
      durationSeconds: 200,
      thumbnailUrl: null,
      liked,
      totalPlayTimeMs: 0,
      inLibrary: 1,
      dateAdded: 1000,
      dateModified: 1000,
      downloadState: 0,
      filePath: null,
      fileSizeBytes: null,
      downloadedAt: null,
      formatId: null,
      unplayable: 0,
    },
    artistNames: [],
  };
}

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

describe('penanda dirty sinkronisasi (P-PushDelta)', () => {
  it('buat/ubah-nama/ubah-deskripsi playlist menandai playlist', async () => {
    const library = await makeService();
    expect(await library.hasSyncDirty()).toBe(false);
    const id = await library.createPlaylist('Satu');
    let dirty = await library.listSyncDirty();
    expect(dirty).toHaveLength(1);
    expect(dirty[0]).toMatchObject({
      collection: 'playlists',
      ref: String(id),
    });
    await library.renamePlaylist(id, 'Satu Baru');
    await library.updatePlaylistDescription(id, 'Deskripsi');
    dirty = await library.listSyncDirty();
    // Satu kunci yang sama, nilainya diperbarui (bukan ganda).
    expect(dirty).toHaveLength(1);
    expect(await library.hasSyncDirty()).toBe(true);
  });

  it('tambah lagu menandai item; tambah duplikat tidak menambah penanda', async () => {
    const library = await makeService();
    const id = await library.createPlaylist('Satu');
    await library.importSongs([song('vid-1')]);
    await library.addSongToPlaylist(id, 'vid-1');
    const dirty = await library.listSyncDirty();
    expect(
      dirty.filter((d) => d.collection === 'playlist-items'),
    ).toHaveLength(1);
    expect(
      dirty.find((d) => d.collection === 'playlist-items')?.ref,
    ).toBe(`${id}:vid-1`);
    await library.addSongToPlaylist(id, 'vid-1');
    expect(await library.listSyncDirty()).toHaveLength(dirty.length);
  });

  it('hapus lagu: kunci item dibersihkan, item tersisa ditandai (renumber)', async () => {
    const library = await makeService();
    const id = await library.createPlaylist('Satu');
    await library.importSongs([song('vid-1'), song('vid-2')]);
    await library.addSongToPlaylist(id, 'vid-1');
    await library.addSongToPlaylist(id, 'vid-2');
    await library.removeSongFromPlaylist(id, 'vid-1');
    const dirty = await library.listSyncDirty();
    const items = dirty.filter((d) => d.collection === 'playlist-items');
    expect(items).toHaveLength(1);
    expect(items[0]?.ref).toBe(`${id}:vid-2`);
  });

  it('reorder menandai semua item playlist', async () => {
    const library = await makeService();
    const id = await library.createPlaylist('Satu');
    await library.importSongs([song('vid-1'), song('vid-2'), song('vid-3')]);
    await library.addSongToPlaylist(id, 'vid-1');
    await library.addSongToPlaylist(id, 'vid-2');
    await library.addSongToPlaylist(id, 'vid-3');
    // Bersihkan penanda tambah dulu supaya yang diukur hanya reorder.
    const before = await library.listSyncDirty();
    for (const d of before) {
      await library.clearSyncDirty(d.collection, d.ref);
    }
    await library.moveSongInPlaylist(id, 'vid-3', 0);
    const items = (await library.listSyncDirty()).filter(
      (d) => d.collection === 'playlist-items',
    );
    expect(items).toHaveLength(3);
  });

  it('suka menandai, batal suka membersihkan + tombstone', async () => {
    const library = await makeService();
    await library.importSongs([song('vid-1')]);
    await library.setLiked('vid-1', true);
    let dirty = await library.listSyncDirty();
    expect(dirty).toHaveLength(1);
    expect(dirty[0]).toMatchObject({ collection: 'likes', ref: 'vid-1' });
    await library.setLiked('vid-1', false);
    dirty = await library.listSyncDirty();
    expect(dirty).toHaveLength(0);
    const tombstones = await library.listTombstones();
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]).toMatchObject({ kind: 'like', ref: 'vid-1' });
  });

  it('jalur tarik (quiet) TIDAK menandai', async () => {
    const library = await makeService();
    await library.importSongs([song('vid-1')]);
    await library.setLiked('vid-1', true, { quiet: true });
    expect(await library.listSyncDirty()).toHaveLength(0);
    const id = await library.createPlaylist('Dari Server');
    await library.insertPlaylistItemAt(id, 'vid-1', 0);
    const items = (await library.listSyncDirty()).filter(
      (d) => d.collection === 'playlist-items',
    );
    expect(items).toHaveLength(0);
  });

  it('toggleLiked menandai lalu membersihkan', async () => {
    const library = await makeService();
    await library.importSongs([song('vid-1')]);
    await library.toggleLiked('vid-1');
    expect(await library.listSyncDirty()).toHaveLength(1);
    await library.toggleLiked('vid-1');
    expect(await library.listSyncDirty()).toHaveLength(0);
  });

  it('hapus playlist membersihkan penanda playlist + item-itemnya', async () => {
    const library = await makeService();
    const id = await library.createPlaylist('Satu');
    await library.importSongs([song('vid-1')]);
    await library.addSongToPlaylist(id, 'vid-1');
    expect(await library.listSyncDirty()).toHaveLength(2);
    await library.deletePlaylist(id);
    expect(await library.listSyncDirty()).toHaveLength(0);
  });

  it('keluar dari Library membersihkan penanda suka + item lagu itu', async () => {
    const library = await makeService();
    const id = await library.createPlaylist('Satu');
    await library.importSongs([song('vid-1'), song('vid-2')]);
    await library.addSongToPlaylist(id, 'vid-1');
    await library.addSongToPlaylist(id, 'vid-2');
    await library.setLiked('vid-1', true);
    await library.removeFromLibrary('vid-1');
    const dirty = await library.listSyncDirty();
    expect(
      dirty.some((d) => d.ref.includes('vid-1')),
    ).toBe(false);
    // vid-2 dan playlist tidak tersentuh.
    expect(dirty.some((d) => d.ref.includes('vid-2'))).toBe(true);
  });

  it('penghapusan berversi: edit di tengah sync tidak ikut terhapus', async () => {
    const library = await makeService();
    const id = await library.createPlaylist('Satu');
    const v1 = await library.markSyncDirty('playlists', String(id));
    // Edit kedua di tengah sync: nilai berubah.
    const v2 = await library.markSyncDirty('playlists', String(id));
    expect(v2).not.toBe(v1);
    // Sync membersihkan dengan snapshot lama: tidak terhapus.
    expect(
      await library.clearSyncDirty('playlists', String(id), v1),
    ).toBe(false);
    expect(await library.listSyncDirty()).toHaveLength(1);
    // Dengan nilai terbaru: terhapus.
    expect(
      await library.clearSyncDirty('playlists', String(id), v2),
    ).toBe(true);
    expect(await library.listSyncDirty()).toHaveLength(0);
  });

  it('impor lagu baru yang sudah disukai menandai; impor ulang tidak', async () => {
    const library = await makeService();
    await library.importSongs([song('vid-1', 1)]);
    const dirty = await library.listSyncDirty();
    expect(dirty).toHaveLength(1);
    expect(dirty[0]).toMatchObject({ collection: 'likes', ref: 'vid-1' });
    // Lagu sudah ada: impor ulang tidak mengubah liked -> tanpa penanda baru.
    const library2 = await makeService();
    await library2.importSongs([song('vid-2', 0)]);
    expect(await library2.listSyncDirty()).toHaveLength(0);
    await library2.importSongs([song('vid-2', 1)]);
    expect(await library2.listSyncDirty()).toHaveLength(0);
    const row = await library2.songsByIds(['vid-2']);
    expect(row[0]?.song.liked).toBe(0);
  });

  it('restore backup menandai suka + playlist baru + item baru', async () => {
    const library = await makeService();
    const data = emptyBackup();
    data.songs = [
      {
        id: 'vid-1',
        title: 'Lagu Satu',
        artists: [],
        albumId: null,
        durationSeconds: 180,
        thumbnailUrl: null,
        liked: true,
        inLibrary: true,
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
        durationSeconds: 180,
        thumbnailUrl: null,
        liked: false,
        inLibrary: true,
        totalPlayTimeMs: 0,
        dateAdded: null,
        downloaded: false,
        unplayable: false,
      },
    ];
    data.playlists = [
      {
        name: 'Dari Backup',
        description: null,
        songIds: ['vid-1', 'vid-2'],
        createdAt: null,
      },
    ];
    await library.mergeBackupData(data);
    const dirty = await library.listSyncDirty();
    expect(
      dirty.filter((d) => d.collection === 'likes'),
    ).toHaveLength(1);
    expect(
      dirty.filter((d) => d.collection === 'playlists'),
    ).toHaveLength(1);
    expect(
      dirty.filter((d) => d.collection === 'playlist-items'),
    ).toHaveLength(2);
  });
});
