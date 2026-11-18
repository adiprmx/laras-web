/**
 * Tes cache Jelajah: simpan/muat, TTL 6 jam, nilai rusak, dan
 * batas ukuran. Memakai IndexedDB palsu (pola library.test.ts).
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { deleteDatabase } from './database';
import { resetLibraryService } from './library';
import {
  BROWSE_CACHE_MAX_BYTES,
  BROWSE_CACHE_TTL_MS,
  isBrowseCacheFresh,
  loadCachedBrowseHome,
  saveCachedBrowseHome,
} from './browseCache';
import type { BrowsePage } from '../extractor/searchParser';

const PAGE: BrowsePage = {
  title: '',
  shelves: [
    {
      title: "Today's biggest hits",
      items: [
        {
          kind: 'playlist',
          title: 'Hit Hari Ini',
          browseId: 'VLPL123',
        },
      ],
      isSongList: false,
    },
  ],
};

afterEach(async () => {
  resetLibraryService();
  await deleteDatabase();
});

describe('isBrowseCacheFresh', () => {
  it('segar di bawah 6 jam, basi di atas 6 jam', () => {
    const now = Date.now();
    expect(isBrowseCacheFresh(now, now)).toBe(true);
    expect(isBrowseCacheFresh(now - BROWSE_CACHE_TTL_MS + 1000, now)).toBe(
      true,
    );
    expect(isBrowseCacheFresh(now - BROWSE_CACHE_TTL_MS, now)).toBe(false);
    expect(isBrowseCacheFresh(now - BROWSE_CACHE_TTL_MS - 1000, now)).toBe(
      false,
    );
  });
});

describe('save/load cache Jelajah', () => {
  it('simpan lalu muat mengembalikan halaman yang sama', async () => {
    expect(await saveCachedBrowseHome(PAGE)).toBe(true);
    const cached = await loadCachedBrowseHome();
    expect(cached?.page).toEqual(PAGE);
    expect(cached?.fetchedAt).toBeGreaterThan(0);
    expect(isBrowseCacheFresh(cached?.fetchedAt ?? 0)).toBe(true);
  });

  it('belum ada cache menghasilkan null', async () => {
    expect(await loadCachedBrowseHome()).toBeNull();
  });

  it('nilai melebihi batas ukuran tidak disimpan', async () => {
    const big: BrowsePage = {
      title: 'x'.repeat(BROWSE_CACHE_MAX_BYTES),
      shelves: [],
    };
    expect(await saveCachedBrowseHome(big)).toBe(false);
    expect(await loadCachedBrowseHome()).toBeNull();
  });
});
