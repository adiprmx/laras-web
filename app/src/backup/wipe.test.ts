/**
 * Tes hapus semua data (P8): tiap langkah dipanggil, kunci
 * bukan milik app tidak disentuh, kegagalan satu langkah tidak
 * menghentikan langkah lain, dan penghapusan database nyata
 * mengembalikan app ke keadaan kosong total.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteDatabase } from '../data/database';
import {
  getLibraryService,
  resetLibraryService,
} from '../data/library';
import { wipeAllData } from './wipe';

beforeEach(async () => {
  resetLibraryService();
  await deleteDatabase();
  localStorage.clear();
});

afterEach(async () => {
  resetLibraryService();
  await deleteDatabase();
  localStorage.clear();
});

describe('wipeAllData dengan dependensi stub', () => {
  it('semua langkah jalan + hasil tercatat', async () => {
    const calls: string[] = [];
    const caches = new Set(['laras-downloads-v1', 'laras-runtime-v1']);
    const result = await wipeAllData({
      stopPlayer: () => {
        calls.push('player');
      },
      deleteDownloads: async () => {
        calls.push('downloads');
        return 3;
      },
      deleteDb: async () => {
        calls.push('db');
      },
      resetLibrary: () => {
        calls.push('reset');
      },
      listCaches: async () => [...caches],
      deleteCache: async (name) => {
        calls.push(`cache:${name}`);
        return caches.delete(name);
      },
      listLocalKeys: () => ['laras.player.v1', 'laras.lain', 'bukan-app'],
      removeLocalKey: (key) => {
        calls.push(`local:${key}`);
      },
    });
    expect(calls[0]).toBe('player');
    expect(calls).toContain('downloads');
    expect(calls).toContain('db');
    expect(result.dbDeleted).toBe(true);
    expect(result.downloadsDeleted).toBe(3);
    expect(result.cachesDeleted).toEqual([
      'laras-downloads-v1',
      'laras-runtime-v1',
    ]);
    // Hanya kunci berawalan laras. yang dihapus.
    expect(result.localKeysRemoved).toEqual(['laras.player.v1', 'laras.lain']);
    expect(calls).not.toContain('local:bukan-app');
    expect(result.failedSteps).toEqual([]);
  });

  it('satu langkah gagal -> langkah lain tetap jalan + dicatat', async () => {
    const result = await wipeAllData({
      stopPlayer: () => {
        throw new Error('player mati');
      },
      deleteDownloads: async () => {
        throw new Error('unduhan gagal');
      },
      deleteDb: async () => undefined,
      resetLibrary: () => undefined,
      listCaches: async () => ['laras-runtime-v1'],
      deleteCache: async () => true,
      listLocalKeys: () => [],
      removeLocalKey: () => undefined,
    });
    expect(result.dbDeleted).toBe(true);
    expect(result.cachesDeleted).toEqual(['laras-runtime-v1']);
    expect(result.failedSteps).toContain('player');
    expect(result.failedSteps).toContain('downloads');
  });

  it('gagal hapus satu cache -> cache lain tetap dihapus', async () => {
    const result = await wipeAllData({
      stopPlayer: () => undefined,
      deleteDownloads: async () => 0,
      deleteDb: async () => undefined,
      resetLibrary: () => undefined,
      listCaches: async () => ['cache-a', 'cache-b'],
      deleteCache: async (name) => {
        if (name === 'cache-a') throw new Error('gagal');
        return true;
      },
      listLocalKeys: () => [],
      removeLocalKey: () => undefined,
    });
    expect(result.cachesDeleted).toEqual(['cache-b']);
    expect(result.failedSteps).toContain('cache:cache-a');
  });
});

describe('wipeAllData dengan database + localStorage nyata', () => {
  it('database terhapus: sesudah wipe, app kembali kosong total', async () => {
    const service = await getLibraryService();
    await service.mergeBackupData({
      version: 1,
      appVersion: '0.9.0',
      exportedAt: new Date(),
      songs: [
        {
          id: 'vid-1',
          title: 'Lagu Satu',
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
      ],
      albums: [],
      artists: [],
      playlists: [],
      playEvents: [],
      searchHistory: [{ query: 'noah', timestamp: 1792515600000 }],
      queue: [{ songId: 'vid-1', source: null }],
      playbackState: null,
      settings: null,
    });
    expect((await service.libraryCounts()).songs).toBe(1);
    localStorage.setItem('laras.player.v1', '{"x":1}');
    localStorage.setItem('kunci-lain', 'tetap');

    const result = await wipeAllData({
      // Pemutar + unduhan asli tidak dipakai di jsdom (butuh
      // Audio/Cache API); langkah database + localStorage yang
      // dibuktikan nyata di sini, sisanya di E2E.
      stopPlayer: () => undefined,
      deleteDownloads: async () => 0,
      listCaches: async () => [],
      deleteCache: async () => false,
    });
    expect(result.dbDeleted).toBe(true);
    expect(result.localKeysRemoved).toEqual(['laras.player.v1']);
    expect(localStorage.getItem('kunci-lain')).toBe('tetap');

    // Database baru dibuka sesudah wipe: kosong total.
    const fresh = await getLibraryService();
    const counts = await fresh.libraryCounts();
    expect(counts.songs).toBe(0);
    expect(counts.playlists).toBe(0);
    expect(counts.favorites).toBe(0);
    expect(counts.historyEntries).toBe(0);
    expect(await fresh.loadQueue()).toEqual([]);
    expect(await fresh.recentSearches({ limit: 10 })).toEqual([]);
  });

  it('wipe di database kosong tetap berhasil', async () => {
    const result = await wipeAllData({
      stopPlayer: () => undefined,
      deleteDownloads: async () => 0,
      listCaches: async () => [],
      deleteCache: async () => false,
    });
    expect(result.dbDeleted).toBe(true);
    expect(result.failedSteps).toEqual([]);
  });
});

describe('wipeAllData dependensi default (tanpa stub)', () => {
  it('tidak crash di jsdom (caches tidak ada)', async () => {
    // jsdom tidak punya caches; pemutar + unduhan memakai
    // implementasi asli — pemutar jsdom aman (Audio stub),
    // download manager memanggil deleteAllDownloads yang
    // memakai caches (guarded) + database.
    const stopPlayer = vi.fn();
    const result = await wipeAllData({
      stopPlayer,
      // deleteDownloads asli dipakai: di jsdom ia gagal (tidak
      // ada Cache Storage) — kegagalan itu dicatat, bukan
      // crash, dan langkah lain tetap jalan.
    });
    expect(stopPlayer).toHaveBeenCalledTimes(1);
    expect(result.dbDeleted).toBe(true);
    expect(result.failedSteps).toContain('downloads');
  });
});
