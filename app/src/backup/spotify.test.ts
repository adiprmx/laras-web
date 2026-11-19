/**
 * Tes impor Spotify tanpa API (P8): parse file (teks/CSV/JSON),
 * validasi tautan, parse HTML playlist publik (fixture HTML asli
 * dari APK), normalisasi + pencocokan, dan importDraft end-to-end
 * dengan pencarian stub + database IndexedDB palsu.
 *
 * Port kasus `spotify_import_test.dart` APK + kasus web (fetch
 * lewat proxy, bukan langsung ke open.spotify.com).
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LarasDatabase } from '../data/database';
import { LibraryService } from '../data/library';
import type { GroupedSearchResults, SearchSong } from '../extractor/searchParser';
import { SearchError } from '../extractor/searchService';
import { PROXY_BASE_URL } from '../spike/config';
import {
  decodeHtmlEntities,
  fetchFromLink,
  findConfidentMatch,
  importDraft,
  normalizeTrackText,
  parseSpotifyCsv,
  parseSpotifyFile,
  parseSpotifyJson,
  parseSpotifyPlaylistHtml,
  parseSpotifyText,
  SPOTIFY_FILE_MAX_BYTES,
  SPOTIFY_FILE_MAX_TRACKS,
  SpotifyFileException,
  SpotifyLinkException,
  trackLabel,
  validateSpotifyPlaylistUrl,
  type SpotifyPlaylistDraft,
  type SpotifyTrackRef,
} from './spotify';

// Fixture HTML asli dari APK (salinan test/fixtures/spotify_playlist.html).
import FIXTURE_HTML from './test-fixtures/spotify_playlist.html?raw';

function grouped(songs: SearchSong[]): GroupedSearchResults {
  return { songs, albums: [], artists: [], playlists: [], filterParams: {} };
}

let counter = 0;
const openDbs: LarasDatabase[] = [];

async function makeService(): Promise<LibraryService> {
  counter += 1;
  const db = new LarasDatabase(`laras-spotify-test-${counter}`);
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

describe('parseSpotifyText', () => {
  it('format dasar "Artis - Judul" per baris', () => {
    const tracks = parseSpotifyText(
      'Peterpan - Semua Tentang Kita\nNOAH - Separuh Aku',
    );
    expect(tracks).toEqual([
      { title: 'Semua Tentang Kita', artist: 'Peterpan' },
      { title: 'Separuh Aku', artist: 'NOAH' },
    ]);
  });

  it('penomoran awal dibuang, baris kosong dilewati', () => {
    const tracks = parseSpotifyText(
      '1. Peterpan - Semua Tentang Kita\n\n01) NOAH - Separuh Aku\n123. Judul Saja',
    );
    expect(tracks).toEqual([
      { title: 'Semua Tentang Kita', artist: 'Peterpan' },
      { title: 'Separuh Aku', artist: 'NOAH' },
      { title: 'Judul Saja', artist: '' },
    ]);
  });

  it('baris tanpa pemisah = judul saja', () => {
    expect(parseSpotifyText('Judul Saja')).toEqual([
      { title: 'Judul Saja', artist: '' },
    ]);
  });

  it('en dash dan em dash ber-spasi juga pemisah', () => {
    const tracks = parseSpotifyText(
      'Artis A – Judul A\nArtis B — Judul B',
    );
    expect(tracks).toEqual([
      { title: 'Judul A', artist: 'Artis A' },
      { title: 'Judul B', artist: 'Artis B' },
    ]);
  });

  it('pemisah pertama yang dipakai (judul berisi " - " tetap utuh sesudahnya)', () => {
    const tracks = parseSpotifyText('Artis - Judul - Remix');
    expect(tracks).toEqual([{ title: 'Judul - Remix', artist: 'Artis' }]);
  });

  it('baris berakhir tanda hubung (tanpa judul) -> judul saja apa adanya', () => {
    // Trim menghapus spasi akhir, jadi ' - ' tidak ditemukan:
    // seluruh baris dianggap judul (sama seperti APK).
    expect(parseSpotifyText('Artis Saja - ')).toEqual([
      { title: 'Artis Saja -', artist: '' },
    ]);
  });

  it('teks kosong -> SpotifyFileException', () => {
    expect(() => parseSpotifyText('   \n  ')).toThrow(SpotifyFileException);
  });
});

describe('parseSpotifyCsv', () => {
  it('header artist + track, koma di dalam kutip', () => {
    const tracks = parseSpotifyCsv(
      'Track Name,Artist Name(s),Album\n"Semua, Tentang Kita",Peterpan,Album X\nSeparuh Aku,NOAH,Album Y',
    );
    expect(tracks).toEqual([
      { title: 'Semua, Tentang Kita', artist: 'Peterpan' },
      { title: 'Separuh Aku', artist: 'NOAH' },
    ]);
  });

  it('tanpa header: dua kolom dibaca (artis, judul)', () => {
    const tracks = parseSpotifyCsv('Peterpan,Semua Tentang Kita\nNOAH,Separuh Aku');
    expect(tracks).toEqual([
      { title: 'Semua Tentang Kita', artist: 'Peterpan' },
      { title: 'Separuh Aku', artist: 'NOAH' },
    ]);
  });

  it('satu kolom saja -> SpotifyFileException', () => {
    expect(() => parseSpotifyCsv('Judul Saja')).toThrow(SpotifyFileException);
  });
});

describe('parseSpotifyJson', () => {
  it('daftar langsung Exportify', () => {
    const draft = parseSpotifyJson(
      '[{"Track Name": "Semua Tentang Kita", "Artist Name(s)": "Peterpan"}]',
    );
    expect(draft.tracks).toEqual([
      { title: 'Semua Tentang Kita', artist: 'Peterpan' },
    ]);
  });

  it('daftar langsung name + artists objek', () => {
    const draft = parseSpotifyJson(
      '[{"name": "Separuh Aku", "artists": [{"name": "NOAH"}, {"name": "X"}]}]',
    );
    expect(draft.tracks).toEqual([
      { title: 'Separuh Aku', artist: 'NOAH, X' },
    ]);
  });

  it('pembungkus {tracks} + {playlist:{name, tracks}}', () => {
    const a = parseSpotifyJson(
      '{"tracks": [{"name": "Lagu A", "artist": "Artis A"}]}',
    );
    expect(a.tracks).toEqual([{ title: 'Lagu A', artist: 'Artis A' }]);
    const b = parseSpotifyJson(
      '{"playlist": {"name": "Favorit", "tracks": [{"name": "Lagu B"}]}}',
    );
    expect(b.name).toBe('Favorit');
    expect(b.tracks).toEqual([{ title: 'Lagu B', artist: '' }]);
  });

  it('item terbungkus {track:{...}}', () => {
    const draft = parseSpotifyJson(
      '{"tracks": [{"track": {"name": "Lagu C", "artists": ["Artis C"]}}]}',
    );
    expect(draft.tracks).toEqual([{ title: 'Lagu C', artist: 'Artis C' }]);
  });

  it('JSON bukan daftar lagu -> SpotifyFileException', () => {
    expect(() => parseSpotifyJson('{"foo": 1}')).toThrow(SpotifyFileException);
    expect(() => parseSpotifyJson('[]')).toThrow(SpotifyFileException);
    expect(() => parseSpotifyJson('{bukan json')).toThrow(SpotifyFileException);
  });
});

describe('parseSpotifyFile (deteksi dari isi)', () => {
  const enc = new TextEncoder();
  it('JSON terdeteksi dari isi', () => {
    const draft = parseSpotifyFile(
      enc.encode('[{"name": "Lagu A"}]'),
      'ekspor.json',
    );
    expect(draft.tracks).toEqual([{ title: 'Lagu A', artist: '' }]);
    expect(draft.name).toBe('ekspor');
  });

  it('CSV header terdeteksi dari isi', () => {
    const draft = parseSpotifyFile(
      enc.encode('Track Name,Artist\nLagu A,Artis A'),
      'daftar.txt',
    );
    expect(draft.tracks).toEqual([{ title: 'Lagu A', artist: 'Artis A' }]);
  });

  it('CSV tanpa header terdeteksi dari koma mayoritas', () => {
    const draft = parseSpotifyFile(
      enc.encode('Artis A,Lagu A\nArtis B,Lagu B'),
    );
    expect(draft.tracks).toEqual([
      { title: 'Lagu A', artist: 'Artis A' },
      { title: 'Lagu B', artist: 'Artis B' },
    ]);
  });

  it('teks biasa terdeteksi sebagai teks', () => {
    const draft = parseSpotifyFile(
      enc.encode('Artis A - Lagu A\nArtis B - Lagu B'),
      'playlist-saya.txt',
    );
    expect(draft.tracks.length).toBe(2);
    expect(draft.name).toBe('playlist-saya');
  });

  it('byte bukan UTF-8 -> SpotifyFileException', () => {
    expect(() => parseSpotifyFile(new Uint8Array([0xff, 0xfe, 0x00]))).toThrow(
      SpotifyFileException,
    );
  });

  it('file kosong -> SpotifyFileException', () => {
    expect(() => parseSpotifyFile(enc.encode('  '))).toThrow(
      SpotifyFileException,
    );
  });
});

describe('validateSpotifyPlaylistUrl', () => {
  it('tautan valid (dengan query) -> id', () => {
    expect(
      validateSpotifyPlaylistUrl(
        'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc123',
      ),
    ).toBe('37i9dQZF1DXcBWIGoYBM5M');
  });

  it.each([
    ['http (bukan https)', 'http://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'],
    ['api.spotify.com TERLARANG', 'https://api.spotify.com/v1/playlists/37i9dQZF1DXcBWIGoYBM5M'],
    ['accounts.spotify.com TERLARANG', 'https://accounts.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'],
    ['bukan playlist', 'https://open.spotify.com/track/37i9dQZF1DXcBWIGoYBM5M'],
    ['id terlalu pendek', 'https://open.spotify.com/playlist/abc123'],
    ['segmen tambahan', 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M/extra'],
    ['bukan URL', 'bukan tautan'],
    ['host mirip', 'https://open.spotify.com.evil.com/playlist/37i9dQZF1DXcBWIGoYBM5M'],
  ])('ditolak: %s', (_label, url) => {
    expect(() => validateSpotifyPlaylistUrl(url)).toThrow(SpotifyLinkException);
  });
});

describe('parseSpotifyPlaylistHtml (fixture APK)', () => {
  it('nama + 3 lagu dari fixture asli', () => {
    const draft = parseSpotifyPlaylistHtml(FIXTURE_HTML);
    expect(draft.name).toBe('Chill Hits');
    expect(draft.tracks).toEqual([
      { title: 'BIRDS OF A FEATHER', artist: 'Billie Eilish' },
      { title: 'I Wanna Be Yours', artist: 'Arctic Monkeys' },
      { title: 'Sailor Song', artist: 'Gigi Perez' },
    ]);
    expect(draft.truncated).toBe(false);
  });

  it('fallback <title> bila og:title tidak ada', () => {
    const html = FIXTURE_HTML.replace(
      /<meta property="og:title"[^>]*>/,
      '',
    ).replace(
      /<title>[^<]*<\/title>/,
      '<title>Nama Fallback | Spotify Playlist</title>',
    );
    expect(parseSpotifyPlaylistHtml(html).name).toBe('Nama Fallback');
  });

  it('entitas HTML di-decode di judul dan artis', () => {
    const html = `<meta property="og:title" content="A &amp; B"/>
      <div aria-label="Lagu &#x27;Kutip&#x27;" data-testid="track-row">
      <span data-testid="internal-artist-link"><a href="/x">Artis &#38; Rekan</a></span></div>`;
    const draft = parseSpotifyPlaylistHtml(html);
    expect(draft.name).toBe('A & B');
    expect(draft.tracks).toEqual([
      { title: "Lagu 'Kutip'", artist: 'Artis & Rekan' },
    ]);
  });

  it('dipotong di 30 lagu, truncated true', () => {
    let html = '<meta property="og:title" content="Besar"/>';
    for (let i = 0; i < 35; i++) {
      html += `<div aria-label="Lagu ${i}" data-testid="track-row">` +
        `<span data-testid="internal-artist-link"><a href="/x">Artis ${i}</a></span></div>`;
    }
    const draft = parseSpotifyPlaylistHtml(html);
    expect(draft.tracks.length).toBe(30);
    expect(draft.truncated).toBe(true);
  });

  it('baris tanpa aria-label dilewati; tanpa lagu -> draf kosong', () => {
    const html = '<meta property="og:title" content="Kosong"/>' +
      '<div data-testid="track-row"></div>';
    const draft = parseSpotifyPlaylistHtml(html);
    expect(draft.tracks).toEqual([]);
    expect(draft.name).toBe('Kosong');
  });
});

describe('decodeHtmlEntities', () => {
  it('named + desimal + hex + tak dikenal dibiarkan', () => {
    expect(decodeHtmlEntities('A &amp; B &quot;C&quot; &#39;D&#39;')).toBe(
      `A & B "C" 'D'`,
    );
    expect(decodeHtmlEntities('&#x27; &#65; &tidakdikenal;')).toBe(
      `' A &tidakdikenal;`,
    );
    expect(decodeHtmlEntities('&lt;tag&gt; &apos;x&apos;')).toBe(`<tag> 'x'`);
  });
});

describe('normalizeTrackText', () => {
  it('huruf kecil, imbuhan kurung di akhir dibuang berulang', () => {
    expect(normalizeTrackText('Judul (Remastered) [Official Video]')).toBe(
      'judul',
    );
    expect(normalizeTrackText('Judul (Official Video)')).toBe('judul');
    // Kurung di tengah TIDAK dibuang.
    expect(normalizeTrackText('Judul (Bagian 1) Lanjutan')).toBe(
      'judul bagian 1 lanjutan',
    );
  });

  it('diakritik dilipat, tanda baca + spasi dibuang', () => {
    expect(normalizeTrackText('Beyoncé')).toBe('beyonce');
    expect(normalizeTrackText('  Lagu—Baru!  (Live) ')).toBe('lagu baru');
    // 'ź' tidak ada di peta lipat APK (paritas) — tetap 'ź'.
    expect(normalizeTrackText('Straße Łódź')).toBe('strasse lodź');
  });
});

describe('findConfidentMatch', () => {
  const ref: SpotifyTrackRef = { title: 'Semua Tentang Kita', artist: 'Peterpan' };
  it('cocok persis sesudah normalisasi (judul + artis)', () => {
    const match = findConfidentMatch(
      grouped([
        { videoId: 'v1', title: 'Semua Tentang Kita (Official Video)', artist: 'Peterpan' },
      ]),
      ref,
    );
    expect(match?.videoId).toBe('v1');
  });

  it('artis beda -> tidak cocok (tidak menebak)', () => {
    const match = findConfidentMatch(
      grouped([
        { videoId: 'v1', title: 'Semua Tentang Kita', artist: 'NOAH' },
      ]),
      ref,
    );
    expect(match).toBeNull();
  });

  it('artis kosong di daftar -> judul saja cukup', () => {
    const match = findConfidentMatch(
      grouped([{ videoId: 'v1', title: 'Semua Tentang Kita', artist: 'Siapa Saja' }]),
      { title: 'Semua Tentang Kita', artist: '' },
    );
    expect(match?.videoId).toBe('v1');
  });

  it('hanya 5 hasil teratas yang dipertimbangkan', () => {
    const songs: SearchSong[] = [];
    for (let i = 0; i < 5; i++) {
      songs.push({ videoId: `x${i}`, title: 'Lain', artist: 'Lain' });
    }
    songs.push({ videoId: 'v6', title: 'Semua Tentang Kita', artist: 'Peterpan' });
    expect(findConfidentMatch(grouped(songs), ref)).toBeNull();
  });

  it('artis gabungan dipisah koma', () => {
    const match = findConfidentMatch(
      grouped([
        { videoId: 'v1', title: 'Semua Tentang Kita', artist: 'Peterpan, NOAH' },
      ]),
      ref,
    );
    expect(match?.videoId).toBe('v1');
  });
});

describe('trackLabel', () => {
  it('dengan / tanpa artis', () => {
    expect(trackLabel({ title: 'Judul', artist: 'Artis' })).toBe('Artis - Judul');
    expect(trackLabel({ title: 'Judul', artist: '' })).toBe('Judul');
  });
});

describe('fetchFromLink (via proxy, stub fetch)', () => {
  const url = 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M';

  it('memanggil rute proxy dengan id + mengembalikan draf', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      seen.push(String(input));
      return new Response(FIXTURE_HTML, {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    });
    const draft = await fetchFromLink(url, fetchImpl as typeof fetch);
    expect(seen.length).toBe(1);
    expect(seen[0]).toBe(
      `${PROXY_BASE_URL}/api/spotify-page?id=37i9dQZF1DXcBWIGoYBM5M`,
    );
    // TIDAK PERNAH menyentuh open.spotify.com langsung dari browser.
    expect(seen[0]).not.toContain('open.spotify.com');
    expect(draft.name).toBe('Chill Hits');
    expect(draft.tracks.length).toBe(3);
  });

  it('HTTP bukan 200 -> unreadable', async () => {
    const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 }));
    await expect(
      fetchFromLink(url, fetchImpl as typeof fetch),
    ).rejects.toMatchObject({ kind: 'unreadable' } satisfies { kind: string });
  });

  it('halaman tanpa lagu -> empty', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('<html><body>kosong</body></html>', { status: 200 }),
    );
    await expect(
      fetchFromLink(url, fetchImpl as typeof fetch),
    ).rejects.toMatchObject({ kind: 'empty' } satisfies { kind: string });
  });

  it('respons melebihi cap -> unreadable', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('x', {
          status: 200,
          headers: { 'Content-Length': String(3 * 1024 * 1024) },
        }),
    );
    await expect(
      fetchFromLink(url, fetchImpl as typeof fetch),
    ).rejects.toMatchObject({ kind: 'unreadable' } satisfies { kind: string });
  });

  it('tautan tidak valid -> invalidUrl (tanpa request)', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await expect(
      fetchFromLink('https://api.spotify.com/v1/x', fetchImpl as typeof fetch),
    ).rejects.toMatchObject({ kind: 'invalidUrl' } satisfies { kind: string });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('importDraft', () => {
  const draft: SpotifyPlaylistDraft = {
    name: 'Chill Hits',
    truncated: false,
    tracks: [
      { title: 'Semua Tentang Kita', artist: 'Peterpan' },
      { title: 'Separuh Aku', artist: 'NOAH' },
      { title: 'Lagu Tak Ada', artist: 'Artis Tak Ada' },
    ],
  };

  function searchStub(
    table: Record<string, SearchSong[]>,
  ): (query: string) => Promise<GroupedSearchResults> {
    return async (query) => grouped(table[query] ?? []);
  }

  it('cocok -> playlist dibuat + lagu masuk library + laporan benar', async () => {
    const library = await makeService();
    const search = searchStub({
      'Peterpan Semua Tentang Kita': [
        { videoId: 'j9ITOOStWNU', title: 'Semua Tentang Kita', artist: 'Peterpan', durationSeconds: 250 },
      ],
      'NOAH Separuh Aku': [
        { videoId: 'yBKXg9LpHgw', title: 'Separuh Aku', artist: 'NOAH' },
      ],
    });
    const progress: Array<[number, number]> = [];
    const report = await importDraft(
      draft,
      {
        playlistName: 'Chill Hits',
        onProgress: (done, total) => progress.push([done, total]),
      },
      { search, library, matchDelayMs: 0 },
    );
    expect(report.succeeded).toBe(2);
    expect(report.alreadyExisted).toBe(0);
    expect(report.failures).toEqual([
      { label: 'Artis Tak Ada - Lagu Tak Ada', reason: 'notFound' },
    ]);
    expect(report.playlistId).not.toBeNull();
    expect(report.playlistName).toBe('Chill Hits');
    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    const counts = await library.libraryCounts();
    expect(counts.songs).toBe(2);
    expect(counts.playlists).toBe(1);
    const playlists = await library.playlistsPage({});
    expect(playlists[0]?.playlist.name).toBe('Chill Hits');
    expect(playlists[0]?.songCount).toBe(2);
  });

  it('tidak ada yang cocok -> playlist TIDAK dibuat', async () => {
    const library = await makeService();
    const report = await importDraft(
      draft,
      { playlistName: 'Chill Hits' },
      { search: searchStub({}), library, matchDelayMs: 0 },
    );
    expect(report.succeeded).toBe(0);
    expect(report.failures.length).toBe(3);
    expect(report.playlistId).toBeNull();
    expect(report.playlistName).toBeNull();
    const counts = await library.libraryCounts();
    expect(counts.playlists).toBe(0);
    expect(counts.songs).toBe(0);
  });

  it('videoId sama dari dua lagu -> sudah ada (bukan duplikat)', async () => {
    const library = await makeService();
    const dupDraft: SpotifyPlaylistDraft = {
      name: null,
      truncated: false,
      tracks: [
        { title: 'Semua Tentang Kita', artist: 'Peterpan' },
        { title: 'Semua Tentang Kita', artist: 'Peterpan' },
      ],
    };
    const report = await importDraft(
      dupDraft,
      { playlistName: 'Duplikat' },
      {
        search: searchStub({
          'Peterpan Semua Tentang Kita': [
            { videoId: 'j9ITOOStWNU', title: 'Semua Tentang Kita', artist: 'Peterpan' },
          ],
        }),
        library,
        matchDelayMs: 0,
      },
    );
    expect(report.succeeded).toBe(1);
    expect(report.alreadyExisted).toBe(1);
    const playlists = await library.playlistsPage({});
    expect(playlists[0]?.songCount).toBe(1);
  });

  it('jaringan putus di tengah -> sisanya network, yang cocok tetap tersimpan', async () => {
    const library = await makeService();
    let calls = 0;
    const search = async (): Promise<GroupedSearchResults> => {
      calls += 1;
      if (calls === 2) {
        throw new SearchError('network', 'offline', 'Tidak ada internet.');
      }
      return grouped([
        { videoId: 'j9ITOOStWNU', title: 'Semua Tentang Kita', artist: 'Peterpan' },
      ]);
    };
    const report = await importDraft(
      draft,
      { playlistName: 'Putus' },
      { search, library, matchDelayMs: 0 },
    );
    expect(calls).toBe(2);
    expect(report.succeeded).toBe(1);
    expect(report.failures).toEqual([
      { label: 'NOAH - Separuh Aku', reason: 'network' },
      { label: 'Artis Tak Ada - Lagu Tak Ada', reason: 'network' },
    ]);
    expect(report.playlistId).not.toBeNull();
  });

  it('gagal pencarian bukan jaringan -> per lagu, lanjut ke lagu berikut', async () => {
    const library = await makeService();
    const search = async (query: string): Promise<GroupedSearchResults> => {
      if (query.includes('Separuh')) {
        throw new SearchError('http', 'HTTP 500', 'Server bermasalah.');
      }
      if (query.includes('Tak Ada')) return grouped([]);
      return grouped([
        { videoId: 'j9ITOOStWNU', title: 'Semua Tentang Kita', artist: 'Peterpan' },
      ]);
    };
    const report = await importDraft(
      draft,
      { playlistName: 'Sebagian' },
      { search, library, matchDelayMs: 0 },
    );
    expect(report.succeeded).toBe(1);
    expect(report.failures).toEqual([
      { label: 'NOAH - Separuh Aku', reason: 'searchFailed' },
      { label: 'Artis Tak Ada - Lagu Tak Ada', reason: 'notFound' },
    ]);
  });

  it('dibatalkan di tengah -> sisanya cancelled, yang cocok tetap tersimpan', async () => {
    const library = await makeService();
    let cancelled = false;
    const search = searchStub({
      'Peterpan Semua Tentang Kita': [
        { videoId: 'j9ITOOStWNU', title: 'Semua Tentang Kita', artist: 'Peterpan' },
      ],
      'NOAH Separuh Aku': [
        { videoId: 'yBKXg9LpHgw', title: 'Separuh Aku', artist: 'NOAH' },
      ],
    });
    const report = await importDraft(
      draft,
      {
        playlistName: 'Batal',
        onProgress: (done) => {
          if (done === 1) cancelled = true;
        },
        isCancelled: () => cancelled,
      },
      { search, library, matchDelayMs: 0 },
    );
    expect(report.succeeded).toBe(1);
    expect(report.failures).toEqual([
      { label: 'NOAH - Separuh Aku', reason: 'cancelled' },
      { label: 'Artis Tak Ada - Lagu Tak Ada', reason: 'cancelled' },
    ]);
    expect(report.playlistId).not.toBeNull();
  });

  it('lagu sudah ada di playlist tujuan -> sudah ada (bukan duplikat)', async () => {
    const library = await makeService();
    // Impor dua kali ke nama playlist yang sama: impor kedua
    // membuat playlist baru (nama sama diizinkan) — perilaku ini
    // dicatat; yang diuji: lagu tidak duplikat di library.
    const search = searchStub({
      'Peterpan Semua Tentang Kita': [
        { videoId: 'j9ITOOStWNU', title: 'Semua Tentang Kita', artist: 'Peterpan' },
      ],
    });
    const one: SpotifyPlaylistDraft = {
      name: null,
      truncated: false,
      tracks: [{ title: 'Semua Tentang Kita', artist: 'Peterpan' }],
    };
    await importDraft(one, { playlistName: 'Satu' }, { search, library, matchDelayMs: 0 });
    const second = await importDraft(one, { playlistName: 'Dua' }, { search, library, matchDelayMs: 0 });
    expect(second.succeeded).toBe(1);
    const counts = await library.libraryCounts();
    expect(counts.songs).toBe(1);
    expect(counts.playlists).toBe(2);
  });

  it('R16: nama playlist 150 karakter dipotong ke 100, impor tetap jalan', async () => {
    const library = await makeService();
    const search = searchStub({
      'Peterpan Semua Tentang Kita': [
        { videoId: 'j9ITOOStWNU', title: 'Semua Tentang Kita', artist: 'Peterpan' },
      ],
    });
    const one: SpotifyPlaylistDraft = {
      name: 'x'.repeat(150),
      truncated: false,
      tracks: [{ title: 'Semua Tentang Kita', artist: 'Peterpan' }],
    };
    const longName = 'y'.repeat(150);
    const report = await importDraft(
      one,
      { playlistName: longName },
      { search, library, matchDelayMs: 0 },
    );
    expect(report.playlistId).not.toBeNull();
    expect(report.playlistName).toBe('y'.repeat(100));
    const playlists = await library.playlistsPage({});
    expect(playlists[0]?.playlist.name).toBe('y'.repeat(100));
  });
});

describe('parseSpotifyFile: cap ukuran dan jumlah lagu (Blue 3, R13)', () => {
  it('file teks 35 lagu dipotong ke 30 + truncated + totalTracks', () => {
    const lines = Array.from(
      { length: 35 },
      (_, i) => `Artis ${i} - Lagu ${i}`,
    ).join('\n');
    const draft = parseSpotifyFile(new TextEncoder().encode(lines), 'daftar.txt');
    expect(draft.tracks).toHaveLength(SPOTIFY_FILE_MAX_TRACKS);
    expect(draft.truncated).toBe(true);
    expect(draft.totalTracks).toBe(35);
  });

  it('file JSON 40 lagu dipotong ke 30', () => {
    const items = Array.from({ length: 40 }, (_, i) => ({
      name: `Lagu ${i}`,
      artist: `Artis ${i}`,
    }));
    const draft = parseSpotifyFile(
      new TextEncoder().encode(JSON.stringify({ tracks: items })),
      'daftar.json',
    );
    expect(draft.tracks).toHaveLength(30);
    expect(draft.truncated).toBe(true);
    expect(draft.totalTracks).toBe(40);
  });

  it('file 30 lagu tidak terpotong', () => {
    const lines = Array.from(
      { length: 30 },
      (_, i) => `Artis ${i} - Lagu ${i}`,
    ).join('\n');
    const draft = parseSpotifyFile(new TextEncoder().encode(lines));
    expect(draft.tracks).toHaveLength(30);
    expect(draft.truncated).toBe(false);
    expect(draft.totalTracks).toBeUndefined();
  });

  it('file di atas 10 MB ditolak dengan kind tooLarge', () => {
    const bytes = new Uint8Array(SPOTIFY_FILE_MAX_BYTES + 1);
    bytes.fill(97); // 'a'
    try {
      parseSpotifyFile(bytes, 'besar.txt');
      throw new Error('diharapkan SpotifyFileException');
    } catch (e) {
      expect(e).toBeInstanceOf(SpotifyFileException);
      expect((e as SpotifyFileException).kind).toBe('tooLarge');
    }
  });

  it('judul 1.500 karakter dipotong ke 1.000', () => {
    const draft = parseSpotifyFile(
      new TextEncoder().encode(`Artis - ${'x'.repeat(1500)}`),
    );
    expect(draft.tracks[0]?.title).toBe('x'.repeat(1000));
  });
});
