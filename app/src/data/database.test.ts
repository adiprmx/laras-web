/**
 * Tes database: skema v1+v2, migrasi berversi, dan ketahanan buka.
 *
 * fake-indexeddb menyediakan IndexedDB di jsdom; tiap tes memakai
 * nama database unik supaya tidak bocor antar tes.
 */
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LARAS_DB_VERSION,
  LarasDatabase,
  V1_STORES,
  closeDatabase,
  deleteDatabase,
} from './database';

let counter = 0;
function uniqueName(): string {
  counter += 1;
  return `laras-test-${counter}`;
}

afterEach(async () => {
  await closeDatabase();
});

describe('skema', () => {
  it('buka segar membuat 19 store', async () => {
    const db = new LarasDatabase(uniqueName());
    await db.open();
    expect(db.verno).toBe(LARAS_DB_VERSION);
    const names = db.tables.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'album_artists',
        'albums',
        'app_meta',
        'artists',
        'cache_entries',
        'download_jobs',
        'formats',
        'local_items',
        'lyrics',
        'play_events',
        'playback_state',
        'playlist_songs',
        'playlists',
        'queue_items',
        'search_history',
        'song_artists',
        'songs',
        'sync_tombstones',
        'token_index',
      ].sort(),
    );
    expect(names).toHaveLength(19);
    db.close();
  });

  it('buka ulang mempertahankan data', async () => {
    const name = uniqueName();
    const first = new LarasDatabase(name);
    await first.open();
    await first.songs.add({
      id: 'vid1',
      title: 'Lagu Uji',
      titleKey: 'lagu uji',
      albumId: null,
      durationSeconds: 200,
      thumbnailUrl: null,
      liked: 0,
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
    });
    first.close();

    const second = new LarasDatabase(name);
    await second.open();
    const row = await second.songs.get('vid1');
    expect(row?.title).toBe('Lagu Uji');
    second.close();
  });
});

describe('migrasi v1 ke v3', () => {
  it('menambah store v2+v3 tanpa menghapus data v1', async () => {
    const name = uniqueName();
    // Bangun database v1 persis dengan definisi produksi v1.
    const legacy = new Dexie(name);
    legacy.version(1).stores(V1_STORES);
    await legacy.open();
    await legacy.table('songs').add({
      id: 'vid-lama',
      title: 'Lagu Lama',
      titleKey: 'lagu lama',
      albumId: null,
      durationSeconds: 180,
      thumbnailUrl: null,
      liked: 1,
      totalPlayTimeMs: 5000,
      inLibrary: 1,
      dateAdded: 500,
      dateModified: 500,
      downloadState: 0,
      filePath: null,
      fileSizeBytes: null,
      downloadedAt: null,
      formatId: null,
      unplayable: 0,
    });
    await legacy.table('playlists').add({
      name: 'Playlist Lama',
      description: null,
      browseId: null,
      thumbnailUrl: null,
      createdAt: 500,
      updatedAt: 500,
    });
    legacy.close();

    // Buka dengan kode produksi (v3): upgrade jalan, data utuh.
    const db = new LarasDatabase(name);
    await db.open();
    expect(db.verno).toBe(3);
    const song = await db.songs.get('vid-lama');
    expect(song?.title).toBe('Lagu Lama');
    expect(song?.liked).toBe(1);
    expect(song?.totalPlayTimeMs).toBe(5000);
    const playlists = await db.playlists.toArray();
    expect(playlists).toHaveLength(1);
    expect(playlists[0]?.name).toBe('Playlist Lama');
    // Store v2 ada dan bisa ditulis.
    await db.app_meta.put({ key: 'cek', value: 'ok' });
    expect((await db.app_meta.get('cek'))?.value).toBe('ok');
    await db.playback_state.put({
      id: 1,
      currentIndex: 0,
      positionMs: 0,
      shuffleEnabled: 0,
      repeatMode: 0,
      order: [],
      rate: 1,
      volume: 1,
      updatedAt: 1,
    });
    expect(await db.playback_state.get(1)).not.toBeUndefined();
    // Store v3 ada dan bisa ditulis.
    await db.sync_tombstones.put({
      key: 'like:vid-lama',
      kind: 'like',
      ref: 'vid-lama',
      deletedAt: 1,
    });
    expect(
      (await db.sync_tombstones.get('like:vid-lama'))?.kind,
    ).toBe('like');
    db.close();
  });
});

describe('deleteDatabase', () => {
  it('menghapus database sampai tidak ada lagi', async () => {
    const name = uniqueName();
    const db = new LarasDatabase(name);
    await db.open();
    await db.songs.add({
      id: 'vid9',
      title: 'Hapus Saya',
      titleKey: 'hapus saya',
      albumId: null,
      durationSeconds: null,
      thumbnailUrl: null,
      liked: 0,
      totalPlayTimeMs: 0,
      inLibrary: 0,
      dateAdded: 1,
      dateModified: 1,
      downloadState: 0,
      filePath: null,
      fileSizeBytes: null,
      downloadedAt: null,
      formatId: null,
      unplayable: 0,
    });
    db.close();
    await deleteDatabase(name);
    const fresh = new LarasDatabase(name);
    await fresh.open();
    expect(await fresh.songs.count()).toBe(0);
    fresh.close();
  });
});
