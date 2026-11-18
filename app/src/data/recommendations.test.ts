/**
 * Tes rumus "Lagu untukmu" (PRD B6.2): skor murni + agregasi
 * database. Contoh hitung PRD: lagu B 9 putaran bermakna, lagu A
 * 3 putaran + favorit (8), lagu C 1 putaran + unduh (3) — urutan
 * B, A, C.
 *
 * Tes database memakai IndexedDB palsu yang baru per tes (pola
 * library.test.ts).
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { LarasDatabase } from './database';
import { LibraryService, MEANINGFUL_PLAY_MS } from './library';
import {
  fillForYou,
  FOR_YOU_LIMIT,
  forYouScore,
  rankForYou,
  type ForYouCandidate,
} from './recommendations';
import type { SongImport } from './types';

let counter = 0;
const openDbs: LarasDatabase[] = [];

async function makeService(): Promise<LibraryService> {
  counter += 1;
  const db = new LarasDatabase(`laras-foryou-test-${counter}`);
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
    artistNames: [],
  };
}

function candidate(
  songId: string,
  meaningfulPlays: number,
  lastPlayedAt: number,
  opts: { liked?: boolean; downloaded?: boolean } = {},
): ForYouCandidate {
  return {
    songId,
    meaningfulPlays,
    lastPlayedAt,
    liked: opts.liked ?? false,
    downloaded: opts.downloaded ?? false,
  };
}

describe('forYouScore (rumus murni)', () => {
  it('skor = putaran bermakna + 5 favorit + 2 unduh', () => {
    expect(forYouScore(candidate('x', 9, 0))).toBe(9);
    expect(forYouScore(candidate('x', 3, 0, { liked: true }))).toBe(8);
    expect(forYouScore(candidate('x', 1, 0, { downloaded: true }))).toBe(3);
    expect(
      forYouScore(candidate('x', 2, 0, { liked: true, downloaded: true })),
    ).toBe(9);
    expect(forYouScore(candidate('x', 0, 0))).toBe(0);
  });
});

describe('rankForYou (urutan murni)', () => {
  it('contoh PRD: B (9), A (3+favorit=8), C (1+unduh=3)', () => {
    const ranked = rankForYou([
      candidate('lagu-a', 3, 100, { liked: true }),
      candidate('lagu-b', 9, 50),
      candidate('lagu-c', 1, 200, { downloaded: true }),
    ]);
    expect(ranked.map((c) => c.songId)).toEqual([
      'lagu-b',
      'lagu-a',
      'lagu-c',
    ]);
  });

  it('seri skor dipecah waktu putar terakhir, lalu songId', () => {
    const ranked = rankForYou([
      candidate('lagu-a', 5, 100),
      candidate('lagu-b', 5, 300),
      candidate('lagu-c', 5, 300),
    ]);
    // B dan C seri penuh (skor + waktu sama): songId menentukan.
    expect(ranked.map((c) => c.songId)).toEqual([
      'lagu-b',
      'lagu-c',
      'lagu-a',
    ]);
  });

  it('dibatasi 20 teratas', () => {
    const ranked = rankForYou(
      Array.from({ length: 25 }, (_, i) =>
        candidate(`lagu-${String(i).padStart(2, '0')}`, 25 - i, 0),
      ),
    );
    expect(ranked.length).toBe(FOR_YOU_LIMIT);
    expect(ranked[0]?.songId).toBe('lagu-00');
    expect(ranked[19]?.songId).toBe('lagu-19');
  });

  it('daftar kosong tetap kosong', () => {
    expect(rankForYou([])).toEqual([]);
  });
});

describe('fillForYou (isi sisa dengan lagu terbaru)', () => {
  it('mengisi sampai batas tanpa duplikat', () => {
    expect(fillForYou(['a', 'b'], ['b', 'c', 'd', 'e'], 4)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('daftar penuh tidak berubah', () => {
    expect(fillForYou(['a', 'b'], ['c'], 2)).toEqual(['a', 'b']);
  });
});

describe('LibraryService.forYouSongs (agregasi database)', () => {
  it('urutan mengikuti contoh PRD dari riwayat putar nyata', async () => {
    const service = await makeService();
    const base = Date.now();
    await service.importSongs(
      [song('lagu-a', 'Lagu A'), song('lagu-b', 'Lagu B'), song('lagu-c', 'Lagu C')],
      { addToLibrary: true },
    );
    // B: 9 putaran bermakna. A: 3 putaran + favorit. C: 1 putaran + unduh.
    for (let i = 0; i < 9; i++) {
      await service.recordPlay({
        songId: 'lagu-b',
        timestamp: base - i * 1000,
        playTimeMs: MEANINGFUL_PLAY_MS,
      });
    }
    for (let i = 0; i < 3; i++) {
      await service.recordPlay({
        songId: 'lagu-a',
        timestamp: base - i * 1000,
        playTimeMs: MEANINGFUL_PLAY_MS,
      });
    }
    await service.recordPlay({
      songId: 'lagu-c',
      timestamp: base,
      playTimeMs: MEANINGFUL_PLAY_MS,
    });
    await service.toggleLiked('lagu-a');
    await service.markDownloaded({
      songId: 'lagu-c',
      filePath: 'lagu-c.opus',
      fileSizeBytes: 1234,
    });
    const out = await service.forYouSongs({});
    expect(out.map((v) => v.song.id)).toEqual([
      'lagu-b',
      'lagu-a',
      'lagu-c',
    ]);
  });

  it('putaran di bawah 30 detik tidak dihitung sebagai bermakna', async () => {
    const service = await makeService();
    const base = Date.now();
    await service.importSongs(
      [song('lagu-a', 'Lagu A'), song('lagu-b', 'Lagu B')],
      { addToLibrary: true },
    );
    // A diputar 10 kali tapi masing-masing 10 detik (bukan bermakna).
    for (let i = 0; i < 10; i++) {
      await service.recordPlay({
        songId: 'lagu-a',
        timestamp: base - i * 1000,
        playTimeMs: 10000,
      });
    }
    // B sekali 30 detik.
    await service.recordPlay({
      songId: 'lagu-b',
      timestamp: base,
      playTimeMs: MEANINGFUL_PLAY_MS,
    });
    const out = await service.forYouSongs({});
    // B skor 1, A skor 0 — B dulu, A ikut sebagai isi (library terbaru).
    expect(out[0]?.song.id).toBe('lagu-b');
    expect(out.map((v) => v.song.id)).toContain('lagu-a');
  });

  it('putaran lebih tua dari 30 hari tidak dihitung', async () => {
    const service = await makeService();
    const base = Date.now();
    const old = base - 31 * 24 * 60 * 60 * 1000;
    await service.importSongs(
      [song('lagu-a', 'Lagu A'), song('lagu-b', 'Lagu B')],
      { addToLibrary: true },
    );
    for (let i = 0; i < 9; i++) {
      await service.recordPlay({
        songId: 'lagu-a',
        timestamp: old - i * 1000,
        playTimeMs: MEANINGFUL_PLAY_MS,
      });
    }
    await service.recordPlay({
      songId: 'lagu-b',
      timestamp: base,
      playTimeMs: MEANINGFUL_PLAY_MS,
    });
    const out = await service.forYouSongs({});
    expect(out[0]?.song.id).toBe('lagu-b');
  });

  it('favorit tanpa putaran tetap masuk (skor 5)', async () => {
    const service = await makeService();
    await service.importSongs([song('lagu-a', 'Lagu A')], {
      addToLibrary: true,
    });
    await service.toggleLiked('lagu-a');
    const out = await service.forYouSongs({});
    expect(out.map((v) => v.song.id)).toEqual(['lagu-a']);
  });

  it('library kosong menghasilkan daftar kosong', async () => {
    const service = await makeService();
    expect(await service.forYouSongs({})).toEqual([]);
  });

  it('dibatasi 20 lagu walau library lebih besar', async () => {
    const service = await makeService();
    const items = Array.from({ length: 25 }, (_, i) =>
      song(`lagu-${String(i).padStart(2, '0')}`, `Lagu ${i}`, 1000 + i),
    );
    await service.importSongs(items, { addToLibrary: true });
    const out = await service.forYouSongs({});
    expect(out.length).toBe(20);
    // Isi adalah 20 lagu library terbaru.
    expect(out[0]?.song.id).toBe('lagu-24');
  });
});
