/**
 * Parser respons search dan browse InnerTube YouTube Music.
 *
 * Port `search_parser.dart` APK (dilewatkan kata per kata perilaku
 * yang terbukti, bukan ditebak ulang):
 * - search: `test-fixtures/search-peterpan.json` (rekaman API P1,
 *   15 Nov 2026) — daftar datar `musicResponsiveListItemRenderer`
 *   di dalam `itemSectionRenderer`, ditambah `musicCardShelfRenderer`
 *   hasil teratas dan `chipCloudRenderer` berisi parameter filter.
 * - browse: `test-fixtures/browse-*.json` (diekstrak dari HTML
 *   music.youtube.com, 16 Nov 2026) — `singleColumnBrowseResultsRenderer`
 *   untuk beranda/artis/mood, `twoColumnBrowseResultsRenderer` untuk
 *   album/playlist.
 * - saran: `test-fixtures/suggest-noah.json` (terverifikasi live
 *   16 Nov 2026).
 *
 * Parser toleran di tingkat item: satu item yang gagal di-parse
 * dilewati, satu kelompok yang gagal tidak mengosongkan kelompok
 * lain (PRD B1.1). Kegagalan struktural tingkat atas (tanpa
 * `contents`) ditangani pemanggil sebagai parse gagal (R1-M4).
 *
 * Thumbnail hanya dari host yang diizinkan (ytimg /
 * googleusercontent / ggpht, HTTPS) — validasi di sini menutup
 * SEMUA jalur tampil, karena semua thumbnail mengalir lewat
 * parser ini (port R1-L2).
 */
import { isAllowedThumbnailUrl } from '../solver/urlAllowlist';

/** Batas item per kelompok hasil (port kMaxParserItemsPerGroup). */
export const MAX_PARSER_ITEMS_PER_GROUP = 100;

/** Satu hasil pencarian lagu dari YouTube Music. */
export interface SearchSong {
  videoId: string;
  title: string;
  artist?: string;
  /** channelId YouTube Music artis utama, bila respons membawanya. */
  artistChannelId?: string;
  album?: string;
  /** browseId album (awalan `MPRE`), bila respons membawanya. */
  albumBrowseId?: string;
  durationSeconds?: number;
  thumbnailUrl?: string;
}

/** Satu hasil pencarian album dari YouTube Music. */
export interface SearchAlbum {
  /** browseId album (awalan `MPRE`). */
  browseId: string;
  title: string;
  artists: string[];
  year?: number;
  thumbnailUrl?: string;
}

/** Satu hasil pencarian artis dari YouTube Music. */
export interface SearchArtist {
  /** channelId artis (awalan `UC`). */
  channelId: string;
  name: string;
  thumbnailUrl?: string;
  /** Teks jumlah pendengar apa adanya dari respons, atau undefined. */
  subscribersText?: string;
}

/** Satu hasil pencarian playlist dari YouTube Music. */
export interface SearchPlaylist {
  /** browseId playlist (awalan `VLPL`, `VLRD`, atau `PL`). */
  browseId: string;
  title: string;
  /** Keterangan apa adanya dari respons (pembuat, jumlah lagu). */
  subtitle?: string;
  thumbnailUrl?: string;
}

/** Hasil pencarian yang sudah dikelompokkan. */
export interface GroupedSearchResults {
  /** Lagu dan video musik (keduanya bisa diputar lewat videoId). */
  songs: SearchSong[];
  albums: SearchAlbum[];
  artists: SearchArtist[];
  playlists: SearchPlaylist[];
  /**
   * Parameter filter pencarian per kelompok, dibaca dari chip
   * respons (kunci: `songs`, `albums`, `artists`, `playlists`,
   * `playlistsCommunity`, `videos`). Dipakai layar "Lihat semua"
   * untuk meminta daftar penuh satu kelompok.
   */
  filterParams: Record<string, string>;
}

/** Jenis item di satu rak halaman browse. */
export type BrowseItemKind =
  | 'song'
  | 'album'
  | 'artist'
  | 'playlist'
  | 'category';

/** Satu kartu/baris di halaman browse. */
export interface BrowseItem {
  kind: BrowseItemKind;
  title: string;
  /** Keterangan di bawah judul (artis, jumlah lagu, tahun). */
  subtitle?: string;
  /** videoId bila `kind` adalah `song`. */
  videoId?: string;
  /** browseId bila item membuka halaman lain. */
  browseId?: string;
  /** Parameter browse tambahan (dipakai kategori mood/genre). */
  browseParams?: string;
  thumbnailUrl?: string;
  durationSeconds?: number;
  /** Artis utama (untuk lagu). */
  artist?: string;
  /** channelId artis utama, bila respons membawanya. */
  artistChannelId?: string;
  /** Judul album (untuk lagu). */
  album?: string;
  /** browseId album, bila respons membawanya. */
  albumBrowseId?: string;
}

/** Satu rak (shelf) di halaman browse: judul + daftar item. */
export interface BrowseShelf {
  /** Judul rak apa adanya dari respons (mis. "Top songs"). */
  title: string;
  items: BrowseItem[];
  /**
   * Benar bila rak ini adalah daftar lagu vertikal (bukan deretan
   * kartu horizontal).
   */
  isSongList: boolean;
}

/** Satu halaman browse: kepala + rak-rak. */
export interface BrowsePage {
  title: string;
  subtitle?: string;
  thumbnailUrl?: string;
  shelves: BrowseShelf[];
  /** Token halaman berikut daftar lagu, atau undefined. */
  continuation?: string;
}

/** Semua lagu di semua rak, sesuai urutan tampil. */
export function browsePageAllSongs(page: BrowsePage): BrowseItem[] {
  const out: BrowseItem[] = [];
  for (const shelf of page.shelves) {
    for (const item of shelf.items) {
      if (item.kind === 'song') out.push(item);
    }
  }
  return out;
}

/** Benar bila item ini membuka halaman browse lain saat diketuk. */
export function browseItemOpensPage(item: BrowseItem): boolean {
  return (
    item.kind !== 'song' &&
    item.browseId != null &&
    item.browseId.length > 0
  );
}

/** Kata tipe di awal subjudul item pencarian (sesuai rekaman nyata). */
const SONG_TYPES = new Set(['Song', 'Video']);

/** Parameter filter pencarian per kelompok, dibaca dari chip respons. */
const CHIP_KEY_BY_TEXT: Record<string, string> = {
  Songs: 'songs',
  Albums: 'albums',
  Artists: 'artists',
  Videos: 'videos',
  'Featured playlists': 'playlists',
  'Community playlists': 'playlistsCommunity',
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function asList(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function emptyGrouped(): GroupedSearchResults {
  return { songs: [], albums: [], artists: [], playlists: [], filterParams: {} };
}

/** Parse respons search menjadi hasil yang sudah dikelompokkan. */
export function parseGroupedSearchResults(
  json: unknown,
): GroupedSearchResults {
  const songs: SearchSong[] = [];
  const albums: SearchAlbum[] = [];
  const artists: SearchArtist[] = [];
  const playlists: SearchPlaylist[] = [];
  const filterParams: Record<string, string> = {};
  const seenSongs = new Set<string>();
  const seenBrowse = new Set<string>();

  const sectionList = searchSectionList(json);
  if (!sectionList) return emptyGrouped();

  // Parameter filter dari chip (dipakai layar "Lihat semua").
  const header = asRecord(sectionList.header);
  const chipCloud = asRecord(header?.chipCloudRenderer);
  const chips = asList(chipCloud?.chips);
  if (chips) {
    for (const raw of chips) {
      if (!isRecord(raw)) continue;
      const chip = asRecord(raw.chipCloudChipRenderer);
      if (!chip) continue;
      const text = runsText(chip.text);
      const key = CHIP_KEY_BY_TEXT[text];
      if (!key) continue;
      const endpoint = asRecord(chip.navigationEndpoint);
      const searchEndpoint = asRecord(endpoint?.searchEndpoint);
      const params = asString(searchEndpoint?.params);
      if (params != null && params.length > 0 && !(key in filterParams)) {
        filterParams[key] = params;
      }
    }
  }

  function addSong(song: SearchSong): void {
    if (songs.length >= MAX_PARSER_ITEMS_PER_GROUP) return;
    if (seenSongs.has(song.videoId)) return;
    seenSongs.add(song.videoId);
    songs.push(song);
  }

  function addAlbum(album: SearchAlbum): void {
    if (albums.length >= MAX_PARSER_ITEMS_PER_GROUP) return;
    if (seenBrowse.has(album.browseId)) return;
    seenBrowse.add(album.browseId);
    albums.push(album);
  }

  function addArtist(artist: SearchArtist): void {
    if (artists.length >= MAX_PARSER_ITEMS_PER_GROUP) return;
    if (seenBrowse.has(artist.channelId)) return;
    seenBrowse.add(artist.channelId);
    artists.push(artist);
  }

  function addPlaylist(playlist: SearchPlaylist): void {
    if (playlists.length >= MAX_PARSER_ITEMS_PER_GROUP) return;
    if (seenBrowse.has(playlist.browseId)) return;
    seenBrowse.add(playlist.browseId);
    playlists.push(playlist);
  }

  /** Benar bila semua kelompok sudah penuh. */
  function groupsFull(): boolean {
    return (
      songs.length >= MAX_PARSER_ITEMS_PER_GROUP &&
      albums.length >= MAX_PARSER_ITEMS_PER_GROUP &&
      artists.length >= MAX_PARSER_ITEMS_PER_GROUP &&
      playlists.length >= MAX_PARSER_ITEMS_PER_GROUP
    );
  }

  const sections = asList(sectionList.contents);
  if (!sections) return { songs, albums, artists, playlists, filterParams };
  for (const rawSection of sections) {
    if (groupsFull()) break;
    if (!isRecord(rawSection)) continue;
    try {
      // Kartu hasil teratas: lagu dari onTap + item-item di dalamnya.
      const card = asRecord(rawSection.musicCardShelfRenderer);
      if (card) {
        const topSong = parseCardSong(card);
        if (topSong) addSong(topSong);
        const cardItems = asList(card.contents);
        if (cardItems) {
          for (const rawItem of cardItems) {
            classifyListItem(rawItem, { addSong, addAlbum, addArtist, addPlaylist });
          }
        }
        continue;
      }
      // Bagian biasa: kumpulkan semua baris daftar di dalamnya.
      for (const item of collectListItems(rawSection)) {
        classifyListItem(
          { musicResponsiveListItemRenderer: item },
          { addSong, addAlbum, addArtist, addPlaylist },
        );
      }
    } catch {
      // Satu bagian rusak tidak boleh mengosongkan hasil lain.
      continue;
    }
  }

  return { songs, albums, artists, playlists, filterParams };
}

/** Parse respons browse menjadi halaman (kepala + rak-rak). */
export function parseBrowsePage(json: unknown): BrowsePage {
  const root = asRecord(json);
  const contents = asRecord(root?.contents);
  if (!contents) return { title: '', shelves: [] };

  // Dua kolom (album/playlist): kepala di tab, lagu di secondaryContents.
  const twoColumn = asRecord(contents.twoColumnBrowseResultsRenderer);
  if (twoColumn) return parseTwoColumnPage(twoColumn);

  const singleColumn = asRecord(contents.singleColumnBrowseResultsRenderer);
  if (!singleColumn) return { title: '', shelves: [] };

  let title = '';
  let subtitle: string | undefined;
  let thumbnailUrl: string | undefined;
  const header = asRecord(root?.header);
  if (header) {
    const renderer = firstRenderer(header);
    if (renderer) {
      title = runsText(renderer.title);
      const sub = runsText(renderer.subtitle);
      subtitle = sub.length > 0 ? sub : undefined;
      thumbnailUrl = bestThumbnail(asRecord(renderer.thumbnail));
    }
  }

  const shelves: BrowseShelf[] = [];
  const sectionList = tabSectionList(singleColumn);
  const sections = asList(sectionList?.contents);
  if (sections) {
    for (const rawSection of sections) {
      if (!isRecord(rawSection)) continue;
      try {
        const shelf = parseBrowseSection(rawSection);
        if (shelf && shelf.items.length > 0) shelves.push(shelf);
      } catch {
        continue;
      }
    }
  }
  return { title, subtitle, thumbnailUrl, shelves };
}

/**
 * Parse respons `music/get_search_suggestions` menjadi daftar teks
 * saran. Parser berjalan toleran (mencari node
 * `searchSuggestionRenderer` di mana pun di pohon) supaya tetap
 * jalan bila YouTube menambah section lain. Bila respons tidak
 * membawa node itu, hasilnya kosong dan layar memakai saran
 * riwayat lokal.
 */
export function parseSearchSuggestions(json: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Antrean (BFS), bukan tumpukan: urutan dokumen dipertahankan
  // supaya saran tampil sesuai urutan YouTube (paling relevan dulu).
  const queue: unknown[] = [json];
  let index = 0;
  while (index < queue.length) {
    if (out.length >= MAX_PARSER_ITEMS_PER_GROUP) break;
    const node = queue[index++];
    if (Array.isArray(node)) {
      queue.push(...node);
      continue;
    }
    if (!isRecord(node)) continue;
    const suggestion = asRecord(node.searchSuggestionRenderer);
    if (suggestion) {
      const text = runsText(suggestion.suggestion);
      if (text.length > 0 && !seen.has(text.toLowerCase())) {
        seen.add(text.toLowerCase());
        out.push(text);
      }
    }
    queue.push(...Object.values(node));
  }
  return out;
}

/**
 * Kolektor toleran cadangan: berjalan iteratif di seluruh pohon
 * respons dan mengambil setiap `videoId` 11 karakter yang punya
 * judul. Dipakai layanan pencarian BILA parser terstruktur tidak
 * menemukan satu pun lagu — bentuk respons yang berubah tidak
 * langsung mengosongkan hasil (port `parseSearchResponse` APK).
 * Entri tanpa judul tetap diambil dengan judul kosong dan
 * disaring di lapisan atas.
 */
export function parseSearchSongsTolerant(json: unknown): SearchSong[] {
  const out: SearchSong[] = [];
  const seen = new Set<string>();
  const stack: unknown[] = [json];
  while (stack.length > 0) {
    if (out.length >= MAX_PARSER_ITEMS_PER_GROUP) break;
    const node = stack.pop();
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    if (!isRecord(node)) continue;
    const videoId = node.videoId;
    if (
      typeof videoId === 'string' &&
      videoId.length === 11 &&
      !seen.has(videoId)
    ) {
      seen.add(videoId);
      out.push({ videoId, title: runsText(node.title) });
    }
    stack.push(...Object.values(node));
  }
  return out;
}

// ------------------------------------------------------------------
// Search: struktur dasar
// ------------------------------------------------------------------

function searchSectionList(json: unknown): JsonRecord | undefined {
  const root = asRecord(json);
  const contents = asRecord(root?.contents);
  const tabbed = asRecord(contents?.tabbedSearchResultsRenderer);
  const tabs = asList(tabbed?.tabs);
  if (!tabs || tabs.length === 0) return undefined;
  let tab: JsonRecord | undefined;
  for (const raw of tabs) {
    if (!isRecord(raw)) continue;
    const renderer = asRecord(raw.tabRenderer);
    if (!renderer) continue;
    tab ??= renderer;
    if (renderer.selected === true) {
      tab = renderer;
      break;
    }
  }
  const content = asRecord(tab?.content);
  return asRecord(content?.sectionListRenderer);
}

function tabSectionList(
  resultsRenderer: JsonRecord,
): JsonRecord | undefined {
  const tabs = asList(resultsRenderer.tabs);
  if (!tabs || tabs.length === 0) return undefined;
  for (const raw of tabs) {
    if (!isRecord(raw)) continue;
    const renderer = asRecord(raw.tabRenderer);
    if (!renderer) continue;
    const content = asRecord(renderer.content);
    const sectionList = asRecord(content?.sectionListRenderer);
    if (sectionList) return sectionList;
  }
  return undefined;
}

/** Kumpulkan semua `musicResponsiveListItemRenderer` di satu subtree. */
function collectListItems(node: JsonRecord): JsonRecord[] {
  const out: JsonRecord[] = [];
  const stack: unknown[] = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    if (!isRecord(current)) continue;
    const item = asRecord(current.musicResponsiveListItemRenderer);
    if (item) {
      out.push(item);
      continue;
    }
    stack.push(...Object.values(current));
  }
  return out;
}

/** Lagu dari kartu hasil teratas (musicCardShelfRenderer). */
function parseCardSong(card: JsonRecord): SearchSong | null {
  const onTap = asRecord(card.onTap);
  const watch = asRecord(onTap?.watchEndpoint);
  const videoId = asString(watch?.videoId);
  if (!videoId || videoId.length === 0) return null;
  const title = runsText(card.title);
  if (title.length === 0) return null;
  const runs = runsOf(asRecord(card.subtitle));
  let artist: string | undefined;
  let artistChannelId: string | undefined;
  let durationSeconds: number | undefined;
  for (const run of runs) {
    const text = asString(run.text) ?? '';
    const browse = runBrowseEndpoint(run);
    const pageType = browsePageType(browse);
    if (pageType === 'MUSIC_PAGE_TYPE_ARTIST') {
      artist ??= text;
      artistChannelId ??= asString(browse?.browseId);
    }
    durationSeconds ??= parseDuration(text);
  }
  return {
    videoId,
    title,
    artist,
    artistChannelId,
    durationSeconds,
    thumbnailUrl: bestThumbnail(asRecord(card.thumbnail)),
  };
}

interface Adders {
  addSong: (song: SearchSong) => void;
  addAlbum: (album: SearchAlbum) => void;
  addArtist: (artist: SearchArtist) => void;
  addPlaylist: (playlist: SearchPlaylist) => void;
}

/** Klasifikasikan satu baris daftar ke kelompok hasil yang tepat. */
function classifyListItem(rawItem: unknown, adders: Adders): void {
  if (!isRecord(rawItem)) return;
  const item = asRecord(rawItem.musicResponsiveListItemRenderer);
  if (!item) return;
  try {
    const flexTexts = flexTextsOf(item);
    if (flexTexts.length === 0 || flexTexts[0].length === 0) return;
    const title = flexTexts[0];
    const subtitle = flexTexts.length > 1 ? flexTexts[1] : '';
    const typeWord = subtitle.split('•')[0]?.trim() ?? '';
    const videoId = itemVideoId(item);
    const browse = itemBrowseEndpoint(item);
    const pageType = browsePageType(browse);
    const browseId = asString(browse?.browseId);
    const thumbnailUrl = bestThumbnail(asRecord(item.thumbnail));

    // Lagu/video: punya videoId dan (tipe lagu/video, atau tanpa tipe
    // browse yang jelas). Tipe lain yang punya videoId tetap lagu —
    // videoId adalah yang menentukan bisa diputar.
    if (
      videoId != null &&
      (SONG_TYPES.has(typeWord) || typeWord.length === 0 || pageType == null)
    ) {
      const meta = artistAlbumFromItem(item, subtitle);
      adders.addSong({
        videoId,
        title,
        artist: meta.artist,
        artistChannelId: meta.artistChannelId,
        album: meta.album,
        albumBrowseId: meta.albumBrowseId,
        durationSeconds: durationFromItem(item),
        thumbnailUrl,
      });
      return;
    }
    if (browseId == null || browseId.length === 0) return;
    if (typeWord === 'Artist' || pageType === 'MUSIC_PAGE_TYPE_ARTIST') {
      const parts = subtitle.split('•');
      const detail =
        parts.length > 1 ? parts.slice(1).join('•').trim() : '';
      adders.addArtist({
        channelId: browseId,
        name: title,
        thumbnailUrl,
        subscribersText: detail.length > 0 ? detail : undefined,
      });
      return;
    }
    if (
      typeWord === 'Album' ||
      typeWord === 'Single' ||
      typeWord === 'EP' ||
      pageType === 'MUSIC_PAGE_TYPE_ALBUM'
    ) {
      const parts = subtitle
        .split('•')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      let year: number | undefined;
      if (parts.length > 0) {
        const parsed = Number(parts[parts.length - 1]);
        if (Number.isInteger(parsed) && parsed >= 1900 && parsed <= 2100) {
          year = parsed;
        }
      }
      const artists = parts.length > 1 ? splitNames(parts[1]) : [];
      adders.addAlbum({
        browseId,
        title,
        artists,
        year,
        thumbnailUrl,
      });
      return;
    }
    if (typeWord === 'Playlist' || pageType === 'MUSIC_PAGE_TYPE_PLAYLIST') {
      const parts = subtitle.split('•');
      const detail =
        parts.length > 1 ? parts.slice(1).join('•').trim() : '';
      adders.addPlaylist({
        browseId,
        title,
        subtitle: detail.length > 0 ? detail : undefined,
        thumbnailUrl,
      });
      return;
    }
    // Podcast, Episode, Profile, dan tipe lain: bukan musik v1,
    // sengaja dilewati (tidak masuk kelompok mana pun).
  } catch {
    // Satu item rusak tidak boleh mengosongkan kelompoknya.
    return;
  }
}

// ------------------------------------------------------------------
// Browse: dua kolom (album/playlist) dan satu kolom (beranda/artis)
// ------------------------------------------------------------------

function parseTwoColumnPage(twoColumn: JsonRecord): BrowsePage {
  let title = '';
  let subtitle: string | undefined;
  let thumbnailUrl: string | undefined;
  const shelves: BrowseShelf[] = [];

  const tabSection = tabSectionList(twoColumn);
  const tabSections = asList(tabSection?.contents);
  if (tabSections) {
    for (const raw of tabSections) {
      if (!isRecord(raw)) continue;
      const header = asRecord(raw.musicResponsiveHeaderRenderer);
      if (!header) continue;
      title = runsText(header.title);
      const sub1 = runsText(header.subtitle);
      const sub2 = runsText(header.secondSubtitle);
      const joined = [sub1, sub2].filter((s) => s.length > 0).join(' • ');
      subtitle = joined.length > 0 ? joined : undefined;
      thumbnailUrl = bestThumbnail(asRecord(header.thumbnail));
    }
  }

  const secondary = asRecord(twoColumn.secondaryContents);
  const secList = asRecord(secondary?.sectionListRenderer);
  const continuation = continuationToken(secList);
  const secContents = asList(secList?.contents);
  if (secContents) {
    for (const raw of secContents) {
      if (!isRecord(raw)) continue;
      const shelf =
        asRecord(raw.musicPlaylistShelfRenderer) ??
        asRecord(raw.musicShelfRenderer);
      if (!shelf) continue;
      const items = listItemsToBrowseItems(asList(shelf.contents));
      if (items.length > 0) {
        shelves.push({ title, items, isSongList: true });
      }
    }
  }
  return { title, subtitle, thumbnailUrl, shelves, continuation };
}

function parseBrowseSection(section: JsonRecord): BrowseShelf | null {
  const carousel = asRecord(section.musicCarouselShelfRenderer);
  if (carousel) {
    const header = asRecord(carousel.header);
    const basicHeader = asRecord(
      header?.musicCarouselShelfBasicHeaderRenderer,
    );
    const title = runsText(basicHeader?.title);
    const items: BrowseItem[] = [];
    const contents = asList(carousel.contents);
    if (contents) {
      for (const raw of contents) {
        if (items.length >= MAX_PARSER_ITEMS_PER_GROUP) break;
        if (!isRecord(raw)) continue;
        try {
          const item = parseTwoRowItem(raw);
          if (item) items.push(item);
        } catch {
          continue;
        }
      }
    }
    if (title.length === 0 && items.length === 0) return null;
    return { title, items, isSongList: false };
  }

  const shelf = asRecord(section.musicShelfRenderer);
  if (shelf) {
    const title = runsText(shelf.title);
    const items = listItemsToBrowseItems(asList(shelf.contents));
    if (items.length === 0) return null;
    return { title, items, isSongList: true };
  }

  const grid = asRecord(section.gridRenderer);
  if (grid) {
    const gridHeader = asRecord(grid.header);
    const gridTitle = asRecord(gridHeader?.gridHeaderRenderer);
    const title = runsText(gridTitle?.title);
    const items: BrowseItem[] = [];
    const gridItems = asList(grid.items);
    if (gridItems) {
      for (const raw of gridItems) {
        if (items.length >= MAX_PARSER_ITEMS_PER_GROUP) break;
        if (!isRecord(raw)) continue;
        try {
          const button = asRecord(raw.musicNavigationButtonRenderer);
          if (!button) continue;
          const text = runsText(button.buttonText);
          const click = asRecord(button.clickCommand);
          const browse = asRecord(click?.browseEndpoint);
          const browseId = asString(browse?.browseId);
          if (text.length === 0 || browseId == null || browseId.length === 0) {
            continue;
          }
          items.push({
            kind: 'category',
            title: text,
            browseId,
            browseParams: asString(browse?.params),
            thumbnailUrl: bestThumbnail(asRecord(button.thumbnail)),
          });
        } catch {
          continue;
        }
      }
    }
    if (items.length === 0) return null;
    return { title, items, isSongList: false };
  }

  // itemSectionRenderer berisi baris daftar (bentuk cadangan).
  const itemSection = asRecord(section.itemSectionRenderer);
  if (itemSection) {
    const items = listItemsToBrowseItems(asList(itemSection.contents));
    if (items.length === 0) return null;
    return { title: '', items, isSongList: true };
  }
  return null;
}

/** Kartu dua baris (musicTwoRowItemRenderer) menjadi BrowseItem. */
function parseTwoRowItem(raw: JsonRecord): BrowseItem | null {
  const item = asRecord(raw.musicTwoRowItemRenderer);
  if (!item) return null;
  const title = runsText(item.title);
  if (title.length === 0) return null;
  const subtitle = runsText(item.subtitle);
  const thumbnailUrl = bestThumbnail(asRecord(item.thumbnailRenderer));
  const endpoint = asRecord(item.navigationEndpoint);
  const watch = asRecord(endpoint?.watchEndpoint);
  const videoId = asString(watch?.videoId);
  if (videoId != null && videoId.length > 0) {
    const parts = subtitle
      .split('•')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return {
      kind: 'song',
      title,
      subtitle: subtitle.length > 0 ? subtitle : undefined,
      videoId,
      thumbnailUrl,
      artist: parts.length > 0 ? parts[0] : undefined,
    };
  }
  const browse = asRecord(endpoint?.browseEndpoint);
  const browseId = asString(browse?.browseId);
  if (browseId == null || browseId.length === 0) return null;
  const pageType = browsePageType(browse);
  let kind: BrowseItemKind;
  if (pageType === 'MUSIC_PAGE_TYPE_ALBUM') kind = 'album';
  else if (pageType === 'MUSIC_PAGE_TYPE_ARTIST') kind = 'artist';
  else if (pageType === 'MUSIC_PAGE_TYPE_PLAYLIST') kind = 'playlist';
  else if (browseId.startsWith('MPRE')) kind = 'album';
  else if (browseId.startsWith('UC')) kind = 'artist';
  else kind = 'playlist';
  return {
    kind,
    title,
    subtitle: subtitle.length > 0 ? subtitle : undefined,
    browseId,
    browseParams: asString(browse?.params),
    thumbnailUrl,
  };
}

/** Baris daftar (musicResponsiveListItemRenderer) menjadi item lagu browse. */
function listItemsToBrowseItems(contents: unknown[] | undefined): BrowseItem[] {
  const out: BrowseItem[] = [];
  if (!contents) return out;
  for (const raw of contents) {
    if (out.length >= MAX_PARSER_ITEMS_PER_GROUP) break;
    if (!isRecord(raw)) continue;
    try {
      const item = asRecord(raw.musicResponsiveListItemRenderer);
      if (!item) continue;
      const flexTexts = flexTextsOf(item);
      if (flexTexts.length === 0 || flexTexts[0].length === 0) continue;
      const videoId = itemVideoId(item);
      if (videoId == null || videoId.length === 0) continue;
      const subtitle = flexTexts.length > 1 ? flexTexts[1] : '';
      const meta = artistAlbumFromItem(item, subtitle);
      out.push({
        kind: 'song',
        title: flexTexts[0],
        subtitle: subtitle.length > 0 ? subtitle : undefined,
        videoId,
        thumbnailUrl: bestThumbnail(asRecord(item.thumbnail)),
        durationSeconds: durationFromItem(item),
        artist: meta.artist,
        artistChannelId: meta.artistChannelId,
        album: meta.album,
        albumBrowseId: meta.albumBrowseId,
      });
    } catch {
      continue;
    }
  }
  return out;
}

// ------------------------------------------------------------------
// Primitif bersama: teks runs, thumbnail, durasi, endpoint
// ------------------------------------------------------------------

/** Teks dari objek `simpleText`/`runs` InnerTube. */
export function runsText(node: unknown): string {
  if (isRecord(node)) {
    const simple = node.simpleText;
    if (typeof simple === 'string') return simple;
    const runs = node.runs;
    if (Array.isArray(runs)) {
      let out = '';
      for (const run of runs) {
        if (isRecord(run)) {
          const text = run.text;
          if (typeof text === 'string') out += text;
        }
      }
      return out;
    }
  }
  if (typeof node === 'string') return node;
  return '';
}

function runsOf(node: JsonRecord | undefined): JsonRecord[] {
  if (!node) return [];
  const runs = asList(node.runs);
  if (!runs) return [];
  return runs.filter((r): r is JsonRecord => isRecord(r));
}

/** Renderer pertama di dalam objek pembungkus (mis. `header`). */
function firstRenderer(wrapper: JsonRecord): JsonRecord | undefined {
  for (const value of Object.values(wrapper)) {
    if (isRecord(value)) return value;
  }
  return undefined;
}

/**
 * Thumbnail terbesar yang lebarnya tidak melebihi 544 px (cukup
 * untuk sampul di daftar dan kartu); bila tidak ada, yang terkecil.
 * Hanya URL dari host yang diizinkan yang jadi kandidat.
 */
function bestThumbnail(node: JsonRecord | undefined): string | undefined {
  if (!node) return undefined;
  const renderer = asRecord(node.musicThumbnailRenderer) ?? node;
  const thumb = asRecord(renderer.thumbnail);
  const thumbnails = asList(thumb?.thumbnails);
  if (!thumbnails || thumbnails.length === 0) return undefined;
  let bestUrl: string | undefined;
  let bestWidth = -1;
  let smallestUrl: string | undefined;
  let smallestWidth = Number.MAX_SAFE_INTEGER;
  for (const raw of thumbnails) {
    if (!isRecord(raw)) continue;
    const url = asString(raw.url);
    if (url == null || url.length === 0) continue;
    if (!isAllowedThumbnailUrl(url)) continue;
    const width = asInt(raw.width) ?? 0;
    if (width < smallestWidth) {
      smallestWidth = width;
      smallestUrl = url;
    }
    if (width <= 544 && width > bestWidth) {
      bestWidth = width;
      bestUrl = url;
    }
  }
  return bestUrl ?? smallestUrl;
}

function asInt(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value === 'number') return Math.trunc(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

/** Durasi dari teks "m:ss" atau "h:mm:ss"; undefined bila bukan durasi. */
export function parseDuration(text: string): number | undefined {
  const trimmed = text.trim();
  const match = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (!match) return undefined;
  const first = Number.parseInt(match[1], 10);
  const second = Number.parseInt(match[2], 10);
  const third = match[3];
  if (third == null) return first * 60 + second;
  return first * 3600 + second * 60 + Number.parseInt(third, 10);
}

/** Teks semua kolom fleksibel satu baris daftar, sesuai urutan. */
function flexTextsOf(item: JsonRecord): string[] {
  const columns = asList(item.flexColumns);
  if (!columns) return [];
  const out: string[] = [];
  for (const raw of columns) {
    if (!isRecord(raw)) continue;
    const column = asRecord(raw.musicResponsiveListItemFlexColumnRenderer);
    if (!column) continue;
    out.push(runsText(column.text));
  }
  return out;
}

/** Semua run teks di semua kolom fleksibel + kolom tetap satu baris. */
function allItemRuns(item: JsonRecord): JsonRecord[] {
  const out: JsonRecord[] = [];
  const columns = asList(item.flexColumns);
  if (columns) {
    for (const raw of columns) {
      if (!isRecord(raw)) continue;
      const column = asRecord(raw.musicResponsiveListItemFlexColumnRenderer);
      if (!column) continue;
      out.push(...runsOf(asRecord(column.text)));
    }
  }
  const fixed = asList(item.fixedColumns);
  if (fixed) {
    for (const raw of fixed) {
      if (!isRecord(raw)) continue;
      const column = asRecord(raw.musicResponsiveListItemFixedColumnRenderer);
      if (!column) continue;
      out.push(...runsOf(asRecord(column.text)));
    }
  }
  return out;
}

function runBrowseEndpoint(run: JsonRecord): JsonRecord | undefined {
  const endpoint = asRecord(run.navigationEndpoint);
  return asRecord(endpoint?.browseEndpoint);
}

function browsePageType(
  browseEndpoint: JsonRecord | undefined,
): string | undefined {
  const configs = asRecord(
    browseEndpoint?.browseEndpointContextSupportedConfigs,
  );
  const musicConfig = asRecord(
    configs?.browseEndpointContextMusicConfig,
  );
  return asString(musicConfig?.pageType);
}

/**
 * videoId satu baris daftar: dari `playlistItemData`, overlay tombol
 * putar, atau navigationEndpoint-nya sendiri.
 */
function itemVideoId(item: JsonRecord): string | undefined {
  const playlistData = asRecord(item.playlistItemData);
  const fromData = asString(playlistData?.videoId);
  if (fromData != null && fromData.length > 0) return fromData;
  const overlay = asRecord(item.overlay);
  const overlayContent = asRecord(
    overlay?.musicItemThumbnailOverlayRenderer,
  );
  const content = asRecord(overlayContent?.content);
  const playButton = asRecord(content?.musicPlayButtonRenderer);
  const playEndpoint = asRecord(playButton?.playNavigationEndpoint);
  const watch = asRecord(playEndpoint?.watchEndpoint);
  const fromOverlay = asString(watch?.videoId);
  if (fromOverlay != null && fromOverlay.length > 0) return fromOverlay;
  const endpoint = asRecord(item.navigationEndpoint);
  const watchEndpoint = asRecord(endpoint?.watchEndpoint);
  const fromNav = asString(watchEndpoint?.videoId);
  if (fromNav != null && fromNav.length > 0) return fromNav;
  return undefined;
}

function itemBrowseEndpoint(item: JsonRecord): JsonRecord | undefined {
  const endpoint = asRecord(item.navigationEndpoint);
  return asRecord(endpoint?.browseEndpoint);
}

/** Durasi satu baris daftar: kolom tetap dulu, lalu run mana pun. */
function durationFromItem(item: JsonRecord): number | undefined {
  const fixed = asList(item.fixedColumns);
  if (fixed) {
    for (const raw of fixed) {
      if (!isRecord(raw)) continue;
      const column = asRecord(raw.musicResponsiveListItemFixedColumnRenderer);
      if (!column) continue;
      const duration = parseDuration(runsText(column.text));
      if (duration != null) return duration;
    }
  }
  for (const run of allItemRuns(item)) {
    const duration = parseDuration(asString(run.text) ?? '');
    if (duration != null) return duration;
  }
  return undefined;
}

interface ArtistAlbum {
  artist?: string;
  artistChannelId?: string;
  album?: string;
  albumBrowseId?: string;
}

/**
 * Artis + album dari run-run satu baris daftar.
 *
 * Run yang membawa browseEndpoint bertipe ARTIST/ALBUM memberi nama
 * sekaligus id-nya. Bila tidak ada run ber-id artis, nama artis
 * diambil dari segmen subjudul setelah kata tipe
 * ("Song • Nama Artis").
 */
function artistAlbumFromItem(
  item: JsonRecord,
  subtitle: string,
): ArtistAlbum {
  const artistNames: string[] = [];
  let artistChannelId: string | undefined;
  let album: string | undefined;
  let albumBrowseId: string | undefined;
  for (const run of allItemRuns(item)) {
    const text = asString(run.text) ?? '';
    if (text.length === 0) continue;
    const browse = runBrowseEndpoint(run);
    const pageType = browsePageType(browse);
    if (pageType === 'MUSIC_PAGE_TYPE_ARTIST') {
      if (!artistNames.includes(text)) artistNames.push(text);
      artistChannelId ??= asString(browse?.browseId);
    } else if (pageType === 'MUSIC_PAGE_TYPE_ALBUM') {
      album ??= text;
      albumBrowseId ??= asString(browse?.browseId);
    }
  }
  let artist: string | undefined;
  if (artistNames.length > 0) {
    artist = artistNames.join(', ');
  } else {
    // Cadangan: segmen kedua subjudul ("Song • Artis • Album").
    const parts = subtitle
      .split('•')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (parts.length > 1) {
      artist = parts[1];
      // Segmen ketiga bisa jadi album ("Song • Artis • Album • 3:24")
      // — tapi bisa juga jumlah putar; album hanya diambil bila
      // segmen itu bukan angka/jumlah dan bukan durasi.
      if (parts.length > 2 && album == null) {
        const candidate = parts[2];
        const lower = candidate.toLowerCase();
        if (
          parseDuration(candidate) == null &&
          !/^\d/.test(candidate) &&
          !lower.includes('plays') &&
          !lower.includes('views') &&
          !lower.includes('subscribers')
        ) {
          album = candidate;
        }
      }
    }
  }
  return { artist, artistChannelId, album, albumBrowseId };
}

/** Pisahkan nama-nama artis ("A, B & C" menjadi [A, B, C]). */
function splitNames(text: string): string[] {
  return text
    .split(/\s*(?:,|&)\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Token continuation dari satu sectionListRenderer, bila ada. */
function continuationToken(
  sectionList: JsonRecord | undefined,
): string | undefined {
  const continuations = asList(sectionList?.continuations);
  if (!continuations || continuations.length === 0) return undefined;
  const first = asRecord(continuations[0]);
  const data = asRecord(first?.nextContinuationData);
  const token = asString(data?.continuation);
  if (token == null || token.length === 0) return undefined;
  return token;
}
