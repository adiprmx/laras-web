/**
 * Tes parser search/browse dari fixture respons YouTube Music ASLI.
 *
 * Fixture disalin dari rekaman nyata APK Laras (respons API P1 +
 * HTML music.youtube.com, 15-16 Nov 2026) — tidak ada JSON yang
 * dikarang dari nol. Nilai yang di-assert adalah nilai verbatim
 * dari rekaman itu, dan sama dengan ekspektasi tes parser APK
 * (`test/extractor/search_parser_test.dart`), supaya port ini
 * terbukti berperilaku identik.
 */
import { describe, expect, it } from 'vitest';
import browseAlbumJson from './test-fixtures/browse-album.json';
import browseArtistJson from './test-fixtures/browse-artist.json';
import browseHomeJson from './test-fixtures/browse-home.json';
import browseMoodsJson from './test-fixtures/browse-moods.json';
import browsePlaylistJson from './test-fixtures/browse-playlist.json';
import searchPeterpanJson from './test-fixtures/search-peterpan.json';
import suggestNoahJson from './test-fixtures/suggest-noah.json';
import {
  browsePageAllSongs,
  parseBrowsePage,
  parseDuration,
  parseGroupedSearchResults,
  parseSearchSongsTolerant,
  parseSearchSuggestions,
  runsText,
} from './searchParser';

const FIXTURES: Record<string, unknown> = {
  'search-peterpan': searchPeterpanJson,
  'browse-home': browseHomeJson,
  'browse-moods': browseMoodsJson,
  'browse-artist': browseArtistJson,
  'browse-album': browseAlbumJson,
  'browse-playlist': browsePlaylistJson,
  'suggest-noah': suggestNoahJson,
};

/** Salinan dalam fixture (tes toleransi mengubah isinya). */
function loadFixture(name: string): unknown {
  return JSON.parse(JSON.stringify(FIXTURES[name])) as unknown;
}

describe('parseGroupedSearchResults (fixture search-peterpan)', () => {
  const results = parseGroupedSearchResults(loadFixture('search-peterpan'));

  it('lagu: kartu + 3 item kartu + 2 lagu + 1 video', () => {
    // Kartu hasil teratas menyumbang lagunya (onTap) + 3 item di
    // dalamnya; video musik dihitung sebagai lagu (bisa diputar).
    expect(results.songs.length).toBe(7);
    const card = results.songs.find((s) => s.videoId === 'hhn-nGSuenM');
    expect(card?.title).toBe('Semua Tentang Kita');
    expect(card?.artist).toBe('Noah');
    const peterpan = results.songs.find((s) => s.videoId === 'j9ITOOStWNU');
    expect(peterpan?.title).toBe('Semua Tentang Kita');
    expect(peterpan?.artist).toBe('Peterpan');
    const video = results.songs.find((s) => s.videoId === 'bJW9qWX1CNA');
    expect(video?.artist).toBe('Noah');
  });

  it('artis membawa channelId asli', () => {
    expect(results.artists.length).toBe(1);
    const artist = results.artists[0];
    expect(artist?.name).toBe('Noah');
    expect(artist?.channelId).toBe('UCCMnLkUAdm_NGMDTTC-nvDQ');
    expect(artist?.subscribersText).toContain('33.5M');
  });

  it('album membawa browseId + artis + tahun', () => {
    expect(results.albums.length).toBe(1);
    const album = results.albums[0];
    expect(album?.title).toBe('Sebuah Nama, Sebuah Cerita');
    expect(album?.browseId).toBe('MPREb_CjVCffe6rk9');
    expect(album?.artists).toContain('Peterpan');
    expect(album?.year).toBe(2008);
  });

  it('playlist membawa browseId + keterangan', () => {
    expect(results.playlists.length).toBe(1);
    const playlist = results.playlists[0];
    expect(playlist?.browseId).toBe('VLPLUDw6LIBdqtzMOnmH4PxbdaVZ746IzI7v');
    expect(playlist?.subtitle).toContain('Iin');
  });

  it('podcast dilewati (bukan musik v1)', () => {
    expect(
      results.songs.some((s) => s.videoId === 'MPSPPLIBpZacpSLD4'),
    ).toBe(false);
    expect(
      results.playlists.some((p) => p.browseId === 'MPSPPLIBpZacpSLD4'),
    ).toBe(false);
  });

  it('param filter dibaca dari chip respons', () => {
    expect(results.filterParams.songs).toBe(
      'EgWKAQIIAWoSEAQQAxAFEAkQChAVEBAQDhAR',
    );
    expect(results.filterParams.albums).toBe(
      'EgWKAQIYAWoSEAQQAxAFEAkQChAVEBAQDhAR',
    );
    expect(results.filterParams.artists).toBe(
      'EgWKAQIgAWoSEAQQAxAFEAkQChAVEBAQDhAR',
    );
    expect(results.filterParams.playlists).toBe(
      'EgeKAQQoADgBahIQBBADEAUQCRAKEBUQEBAOEBE%3D',
    );
    expect(results.filterParams.playlistsCommunity).toBe(
      'EgeKAQQoAEABahIQBBADEAUQCRAKEBUQEBAOEBE%3D',
    );
  });
});

describe('parseGroupedSearchResults toleransi', () => {
  it('respons kosong menghasilkan hasil kosong, bukan throw', () => {
    const results = parseGroupedSearchResults({});
    expect(results.songs).toEqual([]);
    expect(results.albums).toEqual([]);
    expect(results.artists).toEqual([]);
    expect(results.playlists).toEqual([]);
  });

  it('satu kelompok rusak tidak mengosongkan kelompok lain', () => {
    const json = loadFixture('search-peterpan') as Record<string, unknown>;
    const sectionList = (
      (
        (json.contents as Record<string, unknown>)
          .tabbedSearchResultsRenderer as Record<string, unknown>
      ).tabs as Array<Record<string, unknown>>
    )[0]?.tabRenderer as Record<string, unknown>;
    const contents = (
      (
        (sectionList.content as Record<string, unknown>)
          .sectionListRenderer as Record<string, unknown>
      ).contents as unknown[]
    );
    contents.unshift('bukan-map');
    contents.push({ musicCardShelfRenderer: 'rusak' });
    const results = parseGroupedSearchResults(json);
    expect(results.songs.length).toBe(7);
    expect(results.artists.length).toBe(1);
  });
});

describe('parseBrowsePage (fixture browse)', () => {
  it('beranda: 2 rak kartu playlist', () => {
    const page = parseBrowsePage(loadFixture('browse-home'));
    expect(page.shelves.length).toBe(2);
    expect(page.shelves[0]?.title).toBe("Today's biggest hits");
    expect(page.shelves[0]?.items.length).toBe(3);
    expect(page.shelves[0]?.isSongList).toBe(false);
    const first = page.shelves[0]?.items[0];
    expect(first?.kind).toBe('playlist');
    expect(first?.browseId?.startsWith('VLRD')).toBe(true);
    expect(first?.thumbnailUrl).toBeDefined();
    expect(page.shelves[1]?.title).toBe('Trending community playlists');
    expect(
      page.shelves[1]?.items[0]?.browseId?.startsWith('VLPL'),
    ).toBe(true);
  });

  it('playlist: header + lagu + continuation', () => {
    const page = parseBrowsePage(loadFixture('browse-playlist'));
    expect(page.title).toBe('Vibe: Clean & Feel-Good');
    expect(page.subtitle).toContain('Playlist');
    expect(page.thumbnailUrl).toBeDefined();
    expect(page.shelves.length).toBe(1);
    const shelf = page.shelves[0];
    expect(shelf?.isSongList).toBe(true);
    expect(shelf?.items.length).toBe(3);
    const first = shelf?.items[0];
    expect(first?.kind).toBe('song');
    expect(first?.videoId).toBeDefined();
    expect(first?.artist).toBeDefined();
    expect(first?.durationSeconds).toBeDefined();
    expect(page.continuation).toBeDefined();
    expect(browsePageAllSongs(page).length).toBe(3);
  });

  it('album: header + lagu tanpa continuation', () => {
    const page = parseBrowsePage(loadFixture('browse-album'));
    expect(page.title).toBe('A Camp Family Christmas (feat. Egan Camp)');
    expect(page.shelves.length).toBe(1);
    expect(page.shelves[0]?.isSongList).toBe(true);
    expect(page.shelves[0]?.items.length).toBe(3);
    expect(page.continuation).toBeUndefined();
  });

  it('artis: header + lagu teratas + album', () => {
    const page = parseBrowsePage(loadFixture('browse-artist'));
    expect(page.title).toBe('Noah');
    expect(page.shelves.length).toBe(2);
    expect(page.shelves[0]?.title).toBe('Top songs');
    expect(page.shelves[0]?.isSongList).toBe(true);
    expect(page.shelves[0]?.items.length).toBe(3);
    expect(page.shelves[1]?.title).toBe('Albums');
    expect(page.shelves[1]?.isSongList).toBe(false);
    expect(page.shelves[1]?.items[0]?.kind).toBe('album');
    expect(page.shelves[1]?.items[0]?.browseId?.startsWith('MPRE')).toBe(
      true,
    );
  });

  it('mood dan genre: 2 grid kategori', () => {
    const page = parseBrowsePage(loadFixture('browse-moods'));
    expect(page.shelves.length).toBe(2);
    expect(page.shelves[0]?.title).toBe('Moods & moments');
    expect(page.shelves[0]?.items.map((i) => i.title)).toContain('Chill');
    expect(page.shelves[0]?.items[0]?.kind).toBe('category');
    expect(page.shelves[0]?.items[0]?.browseId).toBeDefined();
    expect(page.shelves[0]?.items[0]?.browseParams).toBeDefined();
    expect(page.shelves[1]?.title).toBe('Genres');
    expect(page.shelves[1]?.items.map((i) => i.title)).toContain('Blues');
  });

  it('respons kosong menghasilkan halaman kosong, bukan throw', () => {
    const page = parseBrowsePage({});
    expect(page.title).toBe('');
    expect(page.shelves).toEqual([]);
  });
});

describe('parseSearchSuggestions', () => {
  it('mengambil teks saran dan membuang duplikat', () => {
    const out = parseSearchSuggestions({
      contents: [
        {
          searchSuggestionRenderer: {
            suggestion: { runs: [{ text: 'noah' }] },
          },
        },
        {
          searchSuggestionRenderer: {
            suggestion: { runs: [{ text: 'NOAH' }] },
          },
        },
        {
          searchSuggestionRenderer: {
            suggestion: { runs: [{ text: 'noah semua tentang kita' }] },
          },
        },
      ],
    });
    expect(out).toEqual(['noah', 'noah semua tentang kita']);
  });

  it('respons tanpa saran menghasilkan daftar kosong', () => {
    expect(parseSearchSuggestions({})).toEqual([]);
  });

  it('respons suggest ASLI (fixture suggest-noah) di-parse berurutan', () => {
    expect(parseSearchSuggestions(loadFixture('suggest-noah'))).toEqual([
      'noah kahan',
      'noah graves',
      'noah kahan the great divide',
      'noah cyrus',
      'noah nine',
      'noah thorne',
    ]);
  });
});

describe('cap item parser + validasi thumbnail (R1-M3, R1-L2)', () => {
  function songItem(i: number, thumbnailUrl?: string): unknown {
    const item: Record<string, unknown> = {
      musicResponsiveListItemRenderer: {
        playlistItemData: {
          videoId: `vid${String(i).padStart(8, '0')}`,
        },
        flexColumns: [
          {
            musicResponsiveListItemFlexColumnRenderer: {
              text: { simpleText: `Lagu ${i}` },
            },
          },
          {
            musicResponsiveListItemFlexColumnRenderer: {
              text: { simpleText: `Song • Artis ${i}` },
            },
          },
        ],
      },
    };
    if (thumbnailUrl != null) {
      (
        item.musicResponsiveListItemRenderer as Record<string, unknown>
      ).thumbnail = {
        musicThumbnailRenderer: {
          thumbnail: {
            thumbnails: [{ url: thumbnailUrl, width: 60, height: 60 }],
          },
        },
      };
    }
    return item;
  }

  function searchJsonWithItems(items: unknown[]): unknown {
    return {
      contents: {
        tabbedSearchResultsRenderer: {
          tabs: [
            {
              tabRenderer: {
                selected: true,
                content: {
                  sectionListRenderer: {
                    contents: [{ musicShelfRenderer: { contents: items } }],
                  },
                },
              },
            },
          ],
        },
      },
    };
  }

  function searchJsonWithSongs(count: number): unknown {
    return searchJsonWithItems(
      Array.from({ length: count }, (_, i) => songItem(i)),
    );
  }

  it('150 lagu di satu rak -> paling banyak 100', () => {
    const results = parseGroupedSearchResults(searchJsonWithSongs(150));
    expect(results.songs.length).toBe(100);
    // Semua videoId unik (tidak ada duplikat akibat cap).
    expect(new Set(results.songs.map((s) => s.videoId)).size).toBe(100);
    // Catatan: collectListItems memakai stack DFS sehingga urutan
    // traversal terbalik dari urutan dokumen (perilaku parser APK,
    // bukan bagian kontrak cap) — cap menyimpan 100 pertama dalam
    // urutan traversal itu (item 149..50).
    expect(results.songs[0]?.videoId).toBe('vid00000149');
    expect(results.songs[99]?.videoId).toBe('vid00000050');
  });

  it('99 lagu tetap utuh (cap tidak memotong hasil sah)', () => {
    const results = parseGroupedSearchResults(searchJsonWithSongs(99));
    expect(results.songs.length).toBe(99);
  });

  it('thumbnail dari host liar -> undefined (UI pakai placeholder)', () => {
    const results = parseGroupedSearchResults(
      searchJsonWithItems([
        songItem(0, 'https://evil.example/x.jpg'),
        songItem(1, 'https://i.ytimg.com/vi/x/hq.jpg'),
        songItem(2, 'http://i.ytimg.com/vi/x/hq.jpg'),
      ]),
    );
    expect(results.songs.length).toBe(3);
    const byId = new Map(results.songs.map((s) => [s.videoId, s]));
    expect(byId.get('vid00000000')?.thumbnailUrl).toBeUndefined();
    expect(byId.get('vid00000001')?.thumbnailUrl).toBe(
      'https://i.ytimg.com/vi/x/hq.jpg',
    );
    expect(byId.get('vid00000002')?.thumbnailUrl).toBeUndefined();
  });

  it('150 saran -> paling banyak 100', () => {
    const out = parseSearchSuggestions({
      contents: Array.from({ length: 150 }, (_, i) => ({
        searchSuggestionRenderer: {
          suggestion: { simpleText: `saran ${i}` },
        },
      })),
    });
    expect(out.length).toBe(100);
  });
});

describe('parseSearchSongsTolerant (kolektor cadangan)', () => {
  it('mengambil videoId 11 karakter di mana pun di pohon', () => {
    const out = parseSearchSongsTolerant({
      aneh: {
        dalam: [
          { videoId: 'hhn-nGSuenM', title: { simpleText: 'Semua Tentang Kita' } },
          { videoId: 'pendek', title: { simpleText: 'Dilewati' } },
          { videoId: 'hhn-nGSuenM', title: { simpleText: 'Semua Tentang Kita' } },
        ],
      },
    });
    expect(out).toEqual([
      { videoId: 'hhn-nGSuenM', title: 'Semua Tentang Kita' },
    ]);
  });

  it('menemukan lagu di fixture walau parser terstruktur gagal total', () => {
    const out = parseSearchSongsTolerant(loadFixture('search-peterpan'));
    expect(out.length).toBeGreaterThan(0);
    expect(out.some((s) => s.videoId === 'hhn-nGSuenM')).toBe(true);
  });
});

describe('primitif parser', () => {
  it('runsText menggabungkan runs dan membaca simpleText', () => {
    expect(runsText({ simpleText: 'abc' })).toBe('abc');
    expect(runsText({ runs: [{ text: 'a' }, { text: 'b' }] })).toBe('ab');
    expect(runsText('langsung')).toBe('langsung');
    expect(runsText(undefined)).toBe('');
    expect(runsText({})).toBe('');
  });

  it('parseDuration membaca m:ss dan h:mm:ss', () => {
    expect(parseDuration('3:24')).toBe(204);
    expect(parseDuration('1:02:03')).toBe(3723);
    expect(parseDuration('0:45')).toBe(45);
    expect(parseDuration('105M plays')).toBeUndefined();
    expect(parseDuration('Noah')).toBeUndefined();
    expect(parseDuration('3:4')).toBeUndefined();
  });
});
