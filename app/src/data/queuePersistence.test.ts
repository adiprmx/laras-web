/**
 * Tes persistensi antrean IndexedDB + migrasi localStorage.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLAYER_STORAGE_KEY } from '../player/persistence';
import { localTrack, streamTrack, type Track } from '../player/types';
import { LarasDatabase } from './database';
import { LibraryService } from './library';
import {
  migrateLocalStorageQueue,
  remapOrder,
  restoreQueueState,
  saveQueueState,
} from './queuePersistence';

let counter = 0;
const openDbs: LarasDatabase[] = [];

async function makeService(): Promise<LibraryService> {
  counter += 1;
  const db = new LarasDatabase(`laras-queue-test-${counter}`);
  openDbs.push(db);
  await db.open();
  return new LibraryService(db);
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(async () => {
  while (openDbs.length > 0) {
    const db = openDbs.pop();
    db?.close();
  }
  window.localStorage.clear();
});

function makeTracks(): Track[] {
  const a = streamTrack('vid-a', 'Lagu A', 200);
  a.artist = 'Noah';
  const b = streamTrack('vid-b', 'Lagu B', 180);
  b.artist = 'Peterpan';
  const c = localTrack('https://contoh.test/nada.wav', 'Nada Uji', 10);
  return [a, b, c];
}

describe('saveQueueState dan restoreQueueState', () => {
  it('simpan lalu pulihkan antrean utuh (judul, artis, urutan, posisi)', async () => {
    const service = await makeService();
    const tracks = makeTracks();
    await saveQueueState(service, {
      tracks,
      order: [2, 0, 1],
      orderPos: 1,
      positionSeconds: 42.5,
      shuffle: true,
      repeat: 'all',
      rate: 1.25,
      volume: 0.8,
    });
    const restored = await restoreQueueState(service);
    expect(restored).not.toBeNull();
    expect(restored?.tracks.map((t) => t.id)).toEqual([
      'vid-a',
      'vid-b',
      'https://contoh.test/nada.wav',
    ]);
    expect(restored?.tracks[0]?.title).toBe('Lagu A');
    expect(restored?.tracks[0]?.artist).toBe('Noah');
    expect(restored?.tracks[2]?.source.kind).toBe('local');
    expect(restored?.order).toEqual([2, 0, 1]);
    expect(restored?.orderPos).toBe(1);
    expect(restored?.positionSeconds).toBeCloseTo(42.5, 3);
    expect(restored?.shuffle).toBe(true);
    expect(restored?.repeat).toBe('all');
    expect(restored?.rate).toBe(1.25);
    expect(restored?.volume).toBe(0.8);
  });

  it('null bila tidak ada antrean tersimpan', async () => {
    const service = await makeService();
    expect(await restoreQueueState(service)).toBeNull();
  });

  it('lagu antrean tidak masuk Library', async () => {
    const service = await makeService();
    await saveQueueState(service, {
      tracks: makeTracks(),
      order: [0, 1, 2],
      orderPos: 0,
      positionSeconds: 0,
      shuffle: false,
      repeat: 'off',
      rate: 1,
      volume: 1,
    });
    expect(await service.songsPage({})).toHaveLength(0);
    const counts = await service.libraryCounts();
    expect(counts.songs).toBe(0);
  });

  it('lagu antrean tetap bisa ditemukan pencarian lokal', async () => {
    const service = await makeService();
    await saveQueueState(service, {
      tracks: makeTracks(),
      order: [0, 1, 2],
      orderPos: 0,
      positionSeconds: 0,
      shuffle: false,
      repeat: 'off',
      rate: 1,
      volume: 1,
    });
    const found = await service.searchLocal('lagu a');
    expect(found.songs.map((v) => v.song.id)).toEqual(['vid-a']);
  });

  it('lagu blob dibuang saat simpan (tidak bisa dipulihkan)', async () => {
    const service = await makeService();
    const tracks = makeTracks();
    const blob = localTrack('blob:https://x/123', 'Blob', 5);
    await saveQueueState(service, {
      tracks: [...tracks, blob],
      order: [0, 1, 2, 3],
      orderPos: 0,
      positionSeconds: 0,
      shuffle: false,
      repeat: 'off',
      rate: 1,
      volume: 1,
    });
    const restored = await restoreQueueState(service);
    expect(restored?.tracks).toHaveLength(3);
    expect(restored?.order).toEqual([0, 1, 2]);
  });

  it('lagu yang barisnya hilang dilewati dan urutan dipetakan ulang', async () => {
    const service = await makeService();
    await saveQueueState(service, {
      tracks: makeTracks(),
      order: [2, 0, 1],
      orderPos: 2,
      positionSeconds: 10,
      shuffle: true,
      repeat: 'off',
      rate: 1,
      volume: 1,
    });
    // Hapus lagu tengah dari database (simulasi hapus massal).
    await service.markUnplayable('vid-b');
    await service.deleteUnplayableSongs();
    const restored = await restoreQueueState(service);
    expect(restored?.tracks.map((t) => t.id)).toEqual([
      'vid-a',
      'https://contoh.test/nada.wav',
    ]);
    // Urutan lama [2,0,1] -> posisi 1 hilang -> [1,0].
    expect(restored?.order).toEqual([1, 0]);
    // Lagu saat ini (vid-b) hilang -> kembali ke awal urutan.
    expect(restored?.orderPos).toBe(0);
  });
});

describe('remapOrder', () => {
  it('memetakan ulang indeks setelah penghapusan', () => {
    expect(remapOrder([2, 0, 1], [0, 2], 2)).toEqual([1, 0]);
  });

  it('urutan rusak kembali ke identitas', () => {
    expect(remapOrder([0, 0, 5], [0, 1, 2], 3)).toEqual([0, 1, 2]);
    expect(remapOrder([], [0, 1], 2)).toEqual([0, 1]);
  });
});

describe('migrateLocalStorageQueue', () => {
  function writeLegacyState(): void {
    const tracks = makeTracks();
    window.localStorage.setItem(
      PLAYER_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        queue: tracks,
        order: [0, 1, 2],
        orderPos: 1,
        positionSeconds: 30,
        shuffle: false,
        repeat: 'off',
        rate: 1,
        volume: 1,
        updatedAt: 1000,
      }),
    );
  }

  it('memindahkan antrean lama ke IndexedDB sekali jalan', async () => {
    const service = await makeService();
    writeLegacyState();
    expect(await migrateLocalStorageQueue(service)).toBe('migrated');
    expect(window.localStorage.getItem(PLAYER_STORAGE_KEY)).toBeNull();
    const restored = await restoreQueueState(service);
    expect(restored?.tracks).toHaveLength(3);
    expect(restored?.orderPos).toBe(1);
    expect(restored?.positionSeconds).toBe(30);
    // Jalan kedua: sudah tercatat, tidak diulang.
    expect(await migrateLocalStorageQueue(service)).toBe('skipped');
  });

  it('tidak menimpa antrean IndexedDB yang sudah ada', async () => {
    const service = await makeService();
    await saveQueueState(service, {
      tracks: [streamTrack('vid-baru', 'Lagu Baru', 100)],
      order: [0],
      orderPos: 0,
      positionSeconds: 0,
      shuffle: false,
      repeat: 'off',
      rate: 1,
      volume: 1,
    });
    writeLegacyState();
    expect(await migrateLocalStorageQueue(service)).toBe('skipped');
    const restored = await restoreQueueState(service);
    expect(restored?.tracks.map((t) => t.id)).toEqual(['vid-baru']);
    expect(window.localStorage.getItem(PLAYER_STORAGE_KEY)).toBeNull();
  });

  it('localStorage kosong menghasilkan empty dan tercatat', async () => {
    const service = await makeService();
    expect(await migrateLocalStorageQueue(service)).toBe('empty');
    expect(await migrateLocalStorageQueue(service)).toBe('skipped');
  });

  it('isi localStorage rusak dihapus dan tercatat', async () => {
    const service = await makeService();
    window.localStorage.setItem(PLAYER_STORAGE_KEY, 'bukan json {');
    expect(await migrateLocalStorageQueue(service)).toBe('empty');
    expect(window.localStorage.getItem(PLAYER_STORAGE_KEY)).toBeNull();
    expect(await restoreQueueState(service)).toBeNull();
  });
});
