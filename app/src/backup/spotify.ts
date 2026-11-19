/**
 * Impor playlist Spotify TANPA API Spotify (P8, PRD B10.2/B10.4).
 * Port `spotify_import.dart` APK.
 *
 * LARANGAN MUTLAK (pelanggaran = penghenti rilis): app TIDAK BOLEH
 * memanggil api.spotify.com atau accounts.spotify.com; TIDAK BOLEH
 * client ID/secret/token Spotify; TIDAK BOLEH login Spotify; TIDAK
 * BOLEH library pembungkus Spotify Web API. Satu-satunya request ke
 * domain Spotify yang diizinkan adalah SATU pengambilan halaman
 * publik playlist yang dibagikan pengguna (jalur A).
 *
 * Jalur B (UTAMA, aman, nol request ke Spotify): pengguna memilih
 * atau menempel file ekspor miliknya — teks "Artis - Judul" per
 * baris, CSV, atau JSON ekspor data Spotify. File dibaca lokal di
 * browser.
 *
 * Jalur A (SEKUNDER, berisiko): tautan playlist publik Spotify.
 * TERBUKTI 17 Nov 2026 (probe APK, 2 playlist) + 19 Nov 2026
 * (probe web, "Today's Top Hits"): halaman open.spotify.com
 * merender 30 baris lagu pertama di HTML statis
 * (`data-testid="track-row"` + `aria-label` judul +
 * `internal-artist-link`), tanpa login dan tanpa JavaScript.
 * Batasan yang dibuktikan probe: hanya 30 lagu pertama yang
 * terbaca dari halaman statis (lagu ke-31+ dimuat lewat
 * JavaScript, yang TIDAK dikejar app ini); struktur HTML bisa
 * berubah sewaktu-waktu. Keduanya dinyatakan jujur di UI.
 *
 * PERBEDAAN WEB vs APK (jalur A): browser TIDAK BISA mengambil
 * open.spotify.com langsung — halaman itu tidak mengirim header
 * CORS (dibuktikan probe 19 Nov 2026), jadi `fetch` dari browser
 * selalu diblokir. Web mengambil halaman lewat rute proxy
 * `/api/spotify-page` di worker proxy yang sama dengan InnerTube
 * (aturan yang sama dipindahkan ke worker: id 22 karakter,
 * redirect manual maks 2 hop hanya dalam open.spotify.com, cap
 * 2 MB, timeout 15 detik, UA Android). Client TIDAK PERNAH
 * menyentuh domain Spotify langsung.
 *
 * Pencocokan: tiap lagu dicari ke YouTube Music lewat
 * SearchService yang sama dengan pencarian biasa — dipanggil
 * LANGSUNG (bukan lewat UI) supaya kueri pencocokan TIDAK masuk
 * riwayat pencarian pengguna (sama seperti APK memakai
 * OnlineSearchApi langsung). Padanan yakin = judul DAN artis
 * sama persis sesudah normalisasi di antara 5 hasil teratas.
 * Tidak ada padanan yakin = gagal "tidak ditemukan"; app TIDAK
 * PERNAH menebak diam-diam.
 */
import { getLibraryService, MAX_PLAYLIST_NAME_LENGTH, type LibraryService } from '../data/library';
import { readCappedText, ResponseTooBigError } from '../extractor/readCapped';
import {
  getSearchService,
  SearchError,
} from '../extractor/searchService';
import type {
  GroupedSearchResults,
  SearchSong,
} from '../extractor/searchParser';
import { PROXY_BASE_URL } from '../spike/config';
import type { ImportFailure, ImportReport } from './report';

/** Batas ukuran halaman playlist Spotify yang dibaca jalur A (ukuran nyata ~515 KB; 2 MB memberi ruang tanpa membuka pintu DoS memori). */
export const SPOTIFY_PAGE_MAX_BYTES = 2 * 1024 * 1024;

/** Jumlah baris lagu yang dirender halaman statis Spotify. */
export const SPOTIFY_LINK_MAX_TRACKS = 30;

/** Batas ukuran file daftar lagu jalur file (sama dengan batas file salinan). */
export const SPOTIFY_FILE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Batas jumlah lagu per impor jalur file (Blue 3, Red 3 R13):
 * SAMA dengan jalur tautan (30). Tanpa cap, satu file buatan
 * bisa mengantre ribuan pencarian YTM berurutan dan membakar
 * kuota proxy berjam-jam. Kelebihan dilaporkan ke pengguna
 * (draft.truncated + draft.totalTracks), bukan diam-diam dipotong.
 */
export const SPOTIFY_FILE_MAX_TRACKS = 30;

/** Batas panjang satu judul/artis dari file (dipotong, bukan ditolak). */
export const MAX_SPOTIFY_TRACK_TEXT_CHARS = 1000;

/** Jeda antar pencarian pencocokan (sopan terhadap rate limit YTM). */
export const SPOTIFY_MATCH_DELAY_MS = 150;

/** Timeout pengambilan halaman playlist (jalur A). */
export const SPOTIFY_PAGE_TIMEOUT_MS = 15000;

/** Jenis kegagalan jalur A (tautan playlist publik). */
export type SpotifyLinkErrorKind =
  /** Bukan tautan playlist open.spotify.com yang valid. */
  | 'invalidUrl'
  /** Halaman tidak bisa diambil (jaringan, HTTP bukan 200, redirect ke domain lain, ukuran lewat batas). */
  | 'unreadable'
  /** Halaman terbaca tapi tidak ada lagu yang bisa diekstrak (struktur berubah / playlist kosong / butuh login). */
  | 'empty';

/** Kegagalan jalur A. */
export class SpotifyLinkException extends Error {
  readonly kind: SpotifyLinkErrorKind;
  readonly detail: string | null;

  constructor(kind: SpotifyLinkErrorKind, detail?: string) {
    super(`SpotifyLinkException(${kind}${detail ? `: ${detail}` : ''})`);
    this.name = 'SpotifyLinkException';
    this.kind = kind;
    this.detail = detail ?? null;
  }
}

/** Kegagalan membaca file daftar lagu (jalur B). */
export class SpotifyFileException extends Error {
  readonly kind: 'tooLarge' | 'unreadable';

  constructor(message: string, kind: 'tooLarge' | 'unreadable' = 'unreadable') {
    super(message);
    this.name = 'SpotifyFileException';
    this.kind = kind;
  }
}

/** Satu lagu dari daftar Spotify (judul + artis, tanpa id). */
export interface SpotifyTrackRef {
  /** Judul lagu (wajib ada). */
  title: string;
  /** Nama artis (bisa kosong bila daftar hanya membawa judul). */
  artist: string;
}

/** Label tampil: "Artis - Judul" atau judul saja. */
export function trackLabel(ref: SpotifyTrackRef): string {
  return ref.artist === '' ? ref.title : `${ref.artist} - ${ref.title}`;
}

/** Draf playlist hasil parse file/tautan, siap dicocokkan. */
export interface SpotifyPlaylistDraft {
  /** Nama playlist asal (dari file/tautan), atau null bila tidak diketahui (UI memakai nama bawaan). */
  name: string | null;
  tracks: SpotifyTrackRef[];
  /** True bila daftar ini terpotong (jalur A: hanya 30 lagu pertama yang terbaca dari halaman statis). */
  truncated: boolean;
  /**
   * Jumlah lagu yang ditemukan sebelum cap (hanya diisi bila
   * terpotong di jalur file — UI melaporkannya ke pengguna).
   */
  totalTracks?: number;
}

// ------------------------------------------------------------------
// Jalur B: file / teks tempel
// ------------------------------------------------------------------

/**
 * Parse file daftar lagu (teks/CSV/JSON) dari byte mentah.
 *
 * Format dideteksi dari ISI (bukan ekstensi): JSON bila dimulai
 * `[` atau `{`, CSV bila baris pertama tampak seperti header
 * kolom, sisanya teks "Artis - Judul" per baris. Melempar
 * SpotifyFileException bila tidak ada satu pun lagu yang terbaca.
 */
export function parseSpotifyFile(
  bytes: Uint8Array,
  fileName?: string,
): SpotifyPlaylistDraft {
  // R13: tolak file di atas 10 MB SEBELUM decode/parse (lapis
  // kedua; dialog juga mengecek file.size sebelum membaca isi).
  if (bytes.length > SPOTIFY_FILE_MAX_BYTES) {
    throw new SpotifyFileException(
      'file melebihi 10 MB',
      'tooLarge',
    );
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SpotifyFileException('file bukan teks yang bisa dibaca');
  }
  const trimmed = text.trim();
  if (trimmed === '') {
    throw new SpotifyFileException('file kosong');
  }
  const baseName = baseNameWithoutExtension(fileName);
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const draft = parseSpotifyJson(trimmed);
    return capDraft({
      tracks: draft.tracks,
      name: draft.name ?? baseName,
      truncated: draft.truncated,
    });
  }
  const lines = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines.length > 0 && looksLikeCsvHeader(lines[0]!)) {
    return capDraft({
      tracks: parseSpotifyCsv(trimmed),
      name: baseName,
      truncated: false,
    });
  }
  // CSV tanpa header (dua kolom "Artis,Judul") dideteksi dari koma di
  // mayoritas baris — kalau tidak, perlakukan sebagai teks.
  if (
    lines.length >= 2 &&
    lines.filter((l) => l.includes(',')).length * 2 >= lines.length
  ) {
    const csv = parseSpotifyCsv(trimmed);
    if (csv.length > 0) {
      return capDraft({ tracks: csv, name: baseName, truncated: false });
    }
  }
  return capDraft({
    tracks: parseSpotifyText(trimmed),
    name: baseName,
    truncated: false,
  });
}

/**
 * Terapkan cap jalur file pada draf: potong judul/artis ke 1.000
 * karakter, lalu potong daftar ke SPOTIFY_FILE_MAX_TRACKS lagu.
 * Kelebihan dicatat di totalTracks supaya UI bisa melaporkannya.
 */
function capDraft(draft: SpotifyPlaylistDraft): SpotifyPlaylistDraft {
  const tracks = draft.tracks.map((t) => ({
    title: t.title.slice(0, MAX_SPOTIFY_TRACK_TEXT_CHARS),
    artist: t.artist.slice(0, MAX_SPOTIFY_TRACK_TEXT_CHARS),
  }));
  if (tracks.length <= SPOTIFY_FILE_MAX_TRACKS) {
    return { ...draft, tracks };
  }
  return {
    ...draft,
    tracks: tracks.slice(0, SPOTIFY_FILE_MAX_TRACKS),
    truncated: true,
    totalTracks: tracks.length,
  };
}

/**
 * Parse teks tempelan "Artis - Judul" per baris.
 *
 * Baris tanpa pemisah dianggap judul saja (artis kosong). Penomoran
 * awal ("1. ", "01) ") dibuang. Baris kosong dilewati.
 */
export function parseSpotifyText(text: string): SpotifyTrackRef[] {
  const out: SpotifyTrackRef[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line === '') continue;
    line = line.replace(/^\d{1,4}[.)]\s+/, '');
    if (line === '') continue;
    const sep = findArtistTitleSeparator(line);
    if (sep === -1) {
      out.push({ title: line, artist: '' });
    } else {
      const artist = line.substring(0, sep).trim();
      const title = line.substring(sep + 3).trim();
      if (title === '') {
        out.push({ title: artist, artist: '' });
      } else {
        out.push({ title, artist });
      }
    }
  }
  if (out.length === 0) {
    throw new SpotifyFileException('tidak ada lagu yang terbaca');
  }
  return out;
}

/**
 * Indeks pemisah " - " (atau en/em dash ber-spasi) pertama, atau -1.
 * Pemisah di DALAM judul ("Judul - Remix") tidak bisa dibedakan dari
 * pemisah artis-judul; pemisah pertama yang dipakai (sesuai format
 * "Artis - Judul").
 */
function findArtistTitleSeparator(line: string): number {
  const separators = [' - ', ' – ', ' — '];
  let best = -1;
  for (const sep of separators) {
    const index = line.indexOf(sep);
    if (index !== -1 && (best === -1 || index < best)) best = index;
  }
  return best;
}

/**
 * Parse CSV daftar lagu.
 *
 * Header dikenali bila memuat kolom artis (mengandung "artist") DAN
 * kolom judul (mengandung "track", "title", "song", atau "name").
 * Tanpa header, dua kolom dibaca sebagai (artis, judul). Parser CSV
 * kecil ini menangani tanda kutip + koma di dalam kutip.
 */
export function parseSpotifyCsv(text: string): SpotifyTrackRef[] {
  const rows = parseCsvRows(text);
  if (rows.length === 0) {
    throw new SpotifyFileException('tidak ada lagu yang terbaca');
  }
  let artistCol = -1;
  let titleCol = -1;
  let start = 0;
  const header = rows[0]!.map((c) => c.trim().toLowerCase());
  for (let i = 0; i < header.length; i++) {
    const col = header[i]!;
    if (col.includes('artist')) artistCol = i;
    if (
      col.includes('track') ||
      col.includes('title') ||
      col.includes('song') ||
      col === 'name'
    ) {
      titleCol = i;
    }
  }
  if (artistCol !== -1 && titleCol !== -1) {
    start = 1;
  } else if (rows[0]!.length >= 2) {
    artistCol = 0;
    titleCol = 1;
  } else {
    throw new SpotifyFileException('tidak ada lagu yang terbaca');
  }
  const out: SpotifyTrackRef[] = [];
  for (let r = start; r < rows.length; r++) {
    const row = rows[r]!;
    if (row.length <= titleCol) continue;
    const title = row[titleCol]!.trim();
    if (title === '') continue;
    const artist = artistCol < row.length ? row[artistCol]!.trim() : '';
    out.push({ title, artist });
  }
  if (out.length === 0) {
    throw new SpotifyFileException('tidak ada lagu yang terbaca');
  }
  return out;
}

function looksLikeCsvHeader(firstLine: string): boolean {
  const lower = firstLine.toLowerCase();
  const hasArtist = lower.includes('artist');
  const hasTitle =
    lower.includes('track') ||
    lower.includes('title') ||
    lower.includes('song') ||
    lower.includes('name');
  return hasArtist && hasTitle && firstLine.includes(',');
}

/** Parser CSV minimal: koma pemisah, kutip ganda escape (`""`), newline di dalam kutip didukung. */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  const current: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      current.push(field);
      field = '';
    } else if (ch === '\n') {
      current.push(field);
      field = '';
      rows.push([...current]);
      current.length = 0;
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || current.length > 0) {
    current.push(field);
    rows.push([...current]);
  }
  return rows.filter((row) =>
    row.some((cell) => cell.trim() !== ''),
  );
}

/**
 * Parse JSON ekspor data Spotify.
 *
 * Bentuk yang diterima (semuanya dibaca lokal, tanpa request):
 * - Daftar langsung: `[{"Track Name": "...", "Artist Name(s)": "..."}]`
 *   (format Exportify / ekspor playlist umum) atau
 *   `[{"name": "...", "artists": [{"name": "..."}]}]`.
 * - Objek pembungkus: `{"tracks": [...]}` atau
 *   `{"playlist": {"name": "...", "tracks": [...]}}`.
 * - Item terbungkus: `{"track": {"name": ..., "artists": [...]}}`
 *   (format unduhan data akun Spotify / YourLibrary).
 * Judul dibaca dari `Track Name` / `name` / `title` / `track`;
 * artis dari `Artist Name(s)` / `artists` (daftar nama atau daftar
 * objek `{name}`) / `artist`. Nama playlist dari `name` /
 * `playlistName` di objek pembungkus.
 */
export function parseSpotifyJson(text: string): SpotifyPlaylistDraft {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new SpotifyFileException('file JSON tidak bisa dibaca');
  }
  let playlistName: string | null = null;
  let items: unknown[];
  if (Array.isArray(decoded)) {
    items = decoded;
  } else if (typeof decoded === 'object' && decoded !== null) {
    const obj = decoded as Record<string, unknown>;
    const playlist = obj['playlist'];
    const holder =
      typeof playlist === 'object' && playlist !== null
        ? (playlist as Record<string, unknown>)
        : obj;
    const name = holder['name'] ?? holder['playlistName'];
    if (typeof name === 'string' && name.trim() !== '') {
      playlistName = name.trim();
    }
    const tracks = holder['tracks'];
    if (!Array.isArray(tracks)) {
      throw new SpotifyFileException('file JSON ini tidak berisi daftar lagu');
    }
    items = tracks;
  } else {
    throw new SpotifyFileException('file JSON ini tidak berisi daftar lagu');
  }
  const out: SpotifyTrackRef[] = [];
  for (const item of items) {
    const ref = spotifyJsonTrack(item);
    if (ref !== null) out.push(ref);
  }
  if (out.length === 0) {
    throw new SpotifyFileException('tidak ada lagu yang terbaca');
  }
  return { tracks: out, name: playlistName, truncated: false };
}

function spotifyJsonTrack(item: unknown): SpotifyTrackRef | null {
  if (typeof item !== 'object' || item === null) return null;
  let track = item as Record<string, unknown>;
  const wrapped = track['track'];
  if (typeof wrapped === 'object' && wrapped !== null) {
    track = wrapped as Record<string, unknown>;
  }
  let title = '';
  for (const key of ['Track Name', 'name', 'title', 'track']) {
    const value = track[key];
    if (typeof value === 'string' && value.trim() !== '') {
      title = value.trim();
      break;
    }
  }
  if (title === '') return null;
  let artist = '';
  const artists = track['artists'] ?? track['Artist Name(s)'];
  if (typeof artists === 'string') {
    artist = artists.trim();
  } else if (Array.isArray(artists)) {
    const names: string[] = [];
    for (const a of artists) {
      if (typeof a === 'string' && a.trim() !== '') {
        names.push(a.trim());
      } else if (typeof a === 'object' && a !== null) {
        const n = (a as Record<string, unknown>)['name'];
        if (typeof n === 'string' && n.trim() !== '') names.push(n.trim());
      }
    }
    artist = names.join(', ');
  }
  if (artist === '') {
    const single = track['artist'];
    if (typeof single === 'string') artist = single.trim();
  }
  return { title, artist };
}

function baseNameWithoutExtension(fileName: string | undefined): string | null {
  if (fileName === undefined) return null;
  let base = fileName.trim();
  const slash = base.lastIndexOf('/');
  if (slash !== -1) base = base.substring(slash + 1);
  const dot = base.lastIndexOf('.');
  if (dot > 0) base = base.substring(0, dot);
  base = base.trim();
  return base === '' ? null : base;
}

// ------------------------------------------------------------------
// Jalur A: tautan playlist publik
// ------------------------------------------------------------------

/**
 * Validasi tautan playlist Spotify. Mengembalikan id playlist
 * (22 karakter) yang sudah tervalidasi. Melempar
 * SpotifyLinkException jenis 'invalidUrl' untuk host/path/id apa
 * pun di luar bentuk yang diizinkan — termasuk api.spotify.com
 * dan accounts.spotify.com (TERLARANG).
 */
export function validateSpotifyPlaylistUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new SpotifyLinkException(
      'invalidUrl',
      'bukan tautan playlist open.spotify.com',
    );
  }
  const segments = url.pathname.split('/').filter((s) => s !== '');
  const valid =
    url.protocol === 'https:' &&
    url.hostname === 'open.spotify.com' &&
    segments.length === 2 &&
    segments[0] === 'playlist' &&
    /^[A-Za-z0-9]{22}$/.test(segments[1]!);
  if (!valid) {
    throw new SpotifyLinkException(
      'invalidUrl',
      'bukan tautan playlist open.spotify.com',
    );
  }
  return segments[1]!;
}

/**
 * Ambil daftar lagu dari tautan playlist publik Spotify (jalur A).
 *
 * SATU request ke rute proxy `/api/spotify-page?id=...` (worker
 * yang mengambil halaman open.spotify.com — browser tidak bisa
 * langsung karena halaman itu tanpa header CORS). Melempar
 * SpotifyLinkException bila tautan tidak valid, halaman tidak
 * bisa dibaca, atau tidak ada lagu yang terbaca (UI mengarahkan
 * ke jalur file).
 */
export async function fetchFromLink(
  rawUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SpotifyPlaylistDraft> {
  const id = validateSpotifyPlaylistUrl(rawUrl);
  const html = await fetchPlaylistPage(id, fetchImpl);
  const draft = parseSpotifyPlaylistHtml(html);
  if (draft.tracks.length === 0) {
    throw new SpotifyLinkException('empty', 'tidak ada baris lagu di halaman');
  }
  return draft;
}

async function fetchPlaylistPage(
  id: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SPOTIFY_PAGE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(
      `${PROXY_BASE_URL}/api/spotify-page?id=${encodeURIComponent(id)}`,
      { signal: controller.signal },
    );
    if (res.status !== 200) {
      throw new SpotifyLinkException('unreadable', `HTTP ${res.status}`);
    }
    try {
      const html = await readCappedText(res, SPOTIFY_PAGE_MAX_BYTES);
      if (html === '') {
        throw new SpotifyLinkException('unreadable', 'halaman kosong');
      }
      return html;
    } catch (error) {
      if (error instanceof ResponseTooBigError) {
        throw new SpotifyLinkException(
          'unreadable',
          'halaman melebihi batas ukuran',
        );
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof SpotifyLinkException) throw error;
    // I11: abort fetch asli adalah DOMException (bukan Error).
    if ((error as { name?: unknown } | null)?.name === 'AbortError') {
      throw new SpotifyLinkException('unreadable', 'waktu habis');
    }
    throw new SpotifyLinkException('unreadable', 'jaringan bermasalah');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ekstrak nama playlist + daftar lagu dari HTML halaman playlist
 * publik Spotify (fungsi murni — diuji dengan fixture HTML asli
 * dari APK).
 *
 * Jangkar yang dipakai (terbukti di 2 playlist APK + 1 probe web):
 * - Nama: `<meta property="og:title" content="...">` (fallback:
 *   `<title>Nama | Spotify Playlist</title>`).
 * - Tiap lagu: `aria-label="<Judul>" data-testid="track-row">`
 *   + `<span data-testid="internal-artist-link"><a ...>Artis</a>`
 *   pertama SESUDAH baris itu (sebelum baris berikut).
 * Entitas HTML (`&#x27;`, `&amp;`, dsb.) di-decode. Baris tanpa judul
 * dilewati. Hasil dibatasi SPOTIFY_LINK_MAX_TRACKS (halaman statis
 * hanya merender 30 baris pertama); `truncated` true bila batas
 * itu tercapai.
 */
export function parseSpotifyPlaylistHtml(html: string): SpotifyPlaylistDraft {
  let name: string | null = null;
  const ogTitle = /<meta\s+property="og:title"\s+content="([^"]*)"/.exec(html);
  if (ogTitle !== null) {
    const decoded = decodeHtmlEntities(ogTitle[1]!).trim();
    if (decoded !== '') name = decoded;
  }
  name ??= titleTagName(html);
  const markerRe = /data-testid="track-row"/g;
  const markers: Array<{ start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = markerRe.exec(html)) !== null) {
    markers.push({ start: m.index, end: m.index + m[0].length });
  }
  const tracks: SpotifyTrackRef[] = [];
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i]!;
    // Judul: aria-label terakhir dalam 600 karakter SEBELUM marker
    // (aria-label ada di tag pembuka baris yang sama).
    const titleFrom = Math.max(0, marker.start - 600);
    const before = html.substring(titleFrom, marker.start);
    const labelRe = /aria-label="([^"]+)"/g;
    let lastTitle: string | null = null;
    let lm: RegExpExecArray | null;
    while ((lm = labelRe.exec(before)) !== null) {
      lastTitle = lm[1]!;
    }
    if (lastTitle === null) continue;
    const title = decodeHtmlEntities(lastTitle).trim();
    if (title === '') continue;
    // Artis: tautan artis pertama SESUDAH marker, sebelum marker
    // baris berikut (atau maks 8.000 karakter — baris tidak sepanjang
    // itu; batas ini mencegah "mencuri" artis baris berikut bila satu
    // baris tidak punya tautan artis).
    const bodyStart = marker.end;
    const bodyEnd =
      i + 1 < markers.length
        ? markers[i + 1]!.start
        : Math.min(html.length, bodyStart + 8000);
    const body = html.substring(bodyStart, bodyEnd);
    const artistMatch =
      /data-testid="internal-artist-link"><a[^>]*>([^<]+)<\/a>/.exec(body);
    const artist =
      artistMatch === null
        ? ''
        : decodeHtmlEntities(artistMatch[1]!).trim();
    tracks.push({ title, artist });
    if (tracks.length >= SPOTIFY_LINK_MAX_TRACKS) break;
  }
  return {
    tracks,
    name,
    truncated: tracks.length >= SPOTIFY_LINK_MAX_TRACKS,
  };
}

function titleTagName(html: string): string | null {
  const match = /<title>([^<]*)<\/title>/.exec(html);
  if (match === null) return null;
  let title = decodeHtmlEntities(match[1]!).trim();
  const suffix = ' | Spotify Playlist';
  if (title.endsWith(suffix)) {
    title = title.substring(0, title.length - suffix.length).trim();
  }
  return title === '' ? null : title;
}

/**
 * Decode entitas HTML yang muncul di judul/artis Spotify: named
 * umum (`&amp;` `&quot;` `&lt;` `&gt;` `&#39;`) + numerik desimal
 * (`&#39;`) dan hex (`&#x27;`). Entitas tak dikenal dibiarkan apa
 * adanya (lebih aman daripada menebak).
 */
export function decodeHtmlEntities(raw: string): string {
  let out = raw
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&#39;', "'")
    .replaceAll('&apos;', "'");
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (whole, hex: string) => {
    const code = parseInt(hex, 16);
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
    return String.fromCodePoint(code);
  });
  out = out.replace(/&#([0-9]+);/g, (whole, dec: string) => {
    const code = parseInt(dec, 10);
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
    return String.fromCodePoint(code);
  });
  return out;
}

// ------------------------------------------------------------------
// Pencocokan ke YouTube Music + pembuatan playlist
// ------------------------------------------------------------------

/** Dependensi importDraft yang bisa diganti di tes. */
export interface ImportDraftDeps {
  /** Pencarian YTM (default: SearchService langsung — tidak masuk riwayat). */
  search?: (query: string) => Promise<GroupedSearchResults>;
  /** Layanan library (default: singleton bersama). */
  library?: LibraryService;
  /** Jeda antar pencarian pencocokan (default 150 ms; 0 di tes). */
  matchDelayMs?: number;
}

/**
 * Cocokkan `draft` ke YouTube Music lalu buat satu playlist baru.
 *
 * Aturan padanan yakin: judul DAN artis sama persis sesudah
 * normalisasi, di antara 5 hasil teratas. Lagu yang tidak cocok
 * masuk `failures` dengan alasan `notFound`. Playlist TIDAK
 * dibuat bila tidak ada satu pun lagu yang cocok (PRD B10.4).
 * Lagu yang sudah dicocokkan TETAP tersimpan bila pengguna
 * membatalkan (`isCancelled` true) atau jaringan putus di tengah —
 * sisanya dicatat gagal (`cancelled` / `network`).
 *
 * `onProgress` dipanggil sesudah tiap lagu (done, total) untuk
 * indikator progres UI. `playlistName` adalah nama playlist baru
 * (UI menyediakan kolom nama; pemanggil wajib memberi nama yang
 * sudah divalidasi tak kosong).
 */
export async function importDraft(
  draft: SpotifyPlaylistDraft,
  opts: {
    playlistName: string;
    onProgress?: (done: number, total: number) => void;
    isCancelled?: () => boolean;
  },
  deps: ImportDraftDeps = {},
): Promise<ImportReport> {
  const search =
    deps.search ?? ((q: string) => getSearchService().search(q));
  const library = deps.library ?? (await getLibraryService());
  const matchDelayMs = deps.matchDelayMs ?? SPOTIFY_MATCH_DELAY_MS;
  // R16: nama dari og:title/nama file tidak terbatas panjangnya,
  // sementara createPlaylist melempar di atas 100 karakter.
  // Potong ke batas SEBELUM createPlaylist (mengikuti merge backup).
  const safeName = opts.playlistName
    .trim()
    .slice(0, MAX_PLAYLIST_NAME_LENGTH);
  const total = draft.tracks.length;
  let succeeded = 0;
  let alreadyExisted = 0;
  const failures: ImportFailure[] = [];
  const matched: SearchSong[] = [];
  let stopped = false;
  for (let i = 0; i < total; i++) {
    if (opts.isCancelled?.() ?? false) {
      for (let j = i; j < total; j++) {
        failures.push({
          label: trackLabel(draft.tracks[j]!),
          reason: 'cancelled',
        });
      }
      stopped = true;
      break;
    }
    const ref = draft.tracks[i]!;
    try {
      const results = await search(
        ref.artist === '' ? ref.title : `${ref.artist} ${ref.title}`,
      );
      const match = findConfidentMatch(results, ref);
      if (match === null) {
        failures.push({ label: trackLabel(ref), reason: 'notFound' });
      } else if (matched.some((song) => song.videoId === match.videoId)) {
        alreadyExisted++;
      } else {
        matched.push(match);
      }
    } catch (error) {
      if (error instanceof SearchError && error.kind === 'network') {
        // Jaringan putus: berhenti; sisanya gagal `network`.
        // Lagu yang sudah cocok tetap disimpan di bawah.
        failures.push({ label: trackLabel(ref), reason: 'network' });
        for (let j = i + 1; j < total; j++) {
          failures.push({
            label: trackLabel(draft.tracks[j]!),
            reason: 'network',
          });
        }
        stopped = true;
        break;
      }
      failures.push({ label: trackLabel(ref), reason: 'searchFailed' });
    }
    opts.onProgress?.(i + 1, total);
    if (!stopped && i + 1 < total && matchDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, matchDelayMs));
    }
  }
  let playlistId: number | null = null;
  if (matched.length > 0) {
    playlistId = await library.createPlaylist(safeName);
    for (const song of matched) {
      await library.upsertSong(
        {
          id: song.videoId,
          title: song.title,
          albumId: song.albumBrowseId ?? null,
          durationSeconds: song.durationSeconds ?? null,
          thumbnailUrl: song.thumbnailUrl ?? null,
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
        {
          artistNames: song.artist === undefined ? [] : [song.artist],
          artistChannelIds:
            song.artistChannelId === undefined
              ? []
              : [song.artistChannelId],
          album:
            song.albumBrowseId === undefined || song.album === undefined
              ? undefined
              : {
                  id: song.albumBrowseId,
                  title: song.album,
                  year: null,
                  thumbnailUrl: null,
                  liked: 0,
                },
          addToLibrary: true,
        },
      );
      const added = await library.addSongToPlaylist(playlistId, song.videoId);
      if (added) {
        succeeded++;
      } else {
        alreadyExisted++;
      }
    }
  }
  return {
    succeeded,
    alreadyExisted,
    failures,
    playlistId,
    playlistName: matched.length === 0 ? null : safeName,
    downloadedSongIds: [],
    exportedAt: null,
    appVersion: null,
  };
}

/**
 * Padanan yakin di antara 5 hasil teratas: judul sama persis DAN
 * artis sama persis sesudah normalisasi. Bila daftar tidak membawa
 * artis, judul saja yang dicocokkan.
 */
export function findConfidentMatch(
  results: GroupedSearchResults,
  ref: SpotifyTrackRef,
): SearchSong | null {
  const wantTitle = normalizeTrackText(ref.title);
  const wantArtist = normalizeTrackText(ref.artist);
  if (wantTitle === '') return null;
  for (const song of results.songs.slice(0, 5)) {
    if (normalizeTrackText(song.title) !== wantTitle) continue;
    if (wantArtist === '') return song;
    const artists = (song.artist ?? '')
      .split(',')
      .map((a) => normalizeTrackText(a));
    if (artists.includes(wantArtist)) return song;
  }
  return null;
}

/**
 * Normalisasi untuk pencocokan: huruf kecil, imbuhan dalam kurung /
 * kurung siku di akhir dibuang ("(Official Video)", "[Remastered]"),
 * diakritik Latin dilipat (é -> e), tanda baca + spasi berlebih
 * dibuang. Dua judul yang sama isinya tapi beda ejaan ringan
 * ("Beyoncé" vs "Beyonce") tetap cocok.
 */
export function normalizeTrackText(raw: string): string {
  let text = raw.toLowerCase().trim();
  // Buang imbuhan dalam kurung di akhir, berulang (judul bisa punya
  // dua: "Judul (Remastered) [Official Video]").
  for (;;) {
    const trimmed = text
      .replace(/\s*\([^()]*\)\s*$/, '')
      .replace(/\s*\[[^[\]]*\]\s*$/, '')
      .trim();
    if (trimmed === text) break;
    text = trimmed;
  }
  const folds: Record<string, string> = {
    à: 'a',
    á: 'a',
    â: 'a',
    ã: 'a',
    ä: 'a',
    å: 'a',
    æ: 'ae',
    ç: 'c',
    è: 'e',
    é: 'e',
    ê: 'e',
    ë: 'e',
    ì: 'i',
    í: 'i',
    î: 'i',
    ï: 'i',
    ñ: 'n',
    ò: 'o',
    ó: 'o',
    ô: 'o',
    õ: 'o',
    ö: 'o',
    ø: 'o',
    ù: 'u',
    ú: 'u',
    û: 'u',
    ü: 'u',
    ý: 'y',
    ÿ: 'y',
    ß: 'ss',
    ł: 'l',
    đ: 'd',
    ş: 's',
    ğ: 'g',
    ı: 'i',
  };
  let folded = '';
  for (const ch of text) {
    folded += folds[ch] ?? ch;
  }
  return folded
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
