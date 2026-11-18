/**
 * Layanan pencarian dan browse YouTube Music lewat proxy byte-only.
 *
 * Port `InnertubeClient.search/browse/fetchSuggestions` APK ke
 * TypeScript, dengan jalur jaringan lewat proxy (fetch langsung
 * diblokir CORS, vonis S2). Client default WEB_REMIX (client
 * YouTube Music, sama dengan APK). visitorData ditangkap dari
 * respons search pertama dan dipakai ulang di request berikut
 * (pola APK: visitorData segar dari endpoint search).
 *
 * Aturan pemakaian (PRD B1.1): pencarian jaringan HANYA jalan
 * saat pengguna mengirim kueri secara eksplisit (tombol Cari /
 * Enter / ketuk saran). Layanan ini tidak men-debounce sendiri —
 * debounce saran (300 ms) dan pengiriman eksplisit ditegakkan di
 * lapisan UI (`SearchPage`), dan dibuktikan tes E2E (mengetik
 * tidak memicu request search).
 *
 * Galat diklasifikasikan ke `SearchErrorKind` supaya UI bisa
 * menampilkan pesan yang tepat (PRD B6.5): `network` (koneksi
 * putus/timeout), `http` (server membalas tidak ok),
 * `rate-limited` (429), `parse` (respons tanpa `contents` atau
 * bentuk tidak dikenal — YouTube mungkin mengubah layanannya).
 */
import {
  BUILTIN_CLIENTS,
  SEARCH_TIMEOUT_MS,
  type ClientDefinition,
} from '../spike/config';
import { InnertubeError, postInnertube } from './innertube';
import {
  parseBrowsePage,
  parseGroupedSearchResults,
  parseSearchSongsTolerant,
  parseSearchSuggestions,
  type BrowsePage,
  type GroupedSearchResults,
} from './searchParser';

/** browseId beranda YouTube Music (seksi Jelajah). */
export const BROWSE_HOME_ID = 'FEmusic_home';

/**
 * Batas waktu pencarian/browse di UI: skeleton tampil paling lama
 * 15 detik lalu berubah menjadi pesan galat (PRD B1.1).
 */
export const SEARCH_UI_TIMEOUT_MS = 15000;

/** Batas waktu saran jaringan (gagal saran hilang diam-diam). */
export const SUGGESTIONS_TIMEOUT_MS = 10000;

/** Jumlah saran jaringan paling banyak (PRD B1.2). */
export const MAX_NETWORK_SUGGESTIONS = 8;

export type SearchErrorKind =
  | 'network'
  | 'http'
  | 'rate-limited'
  | 'parse';

/** Galat pencarian/browse dengan pesan yang bisa tampil ke pengguna. */
export class SearchError extends Error {
  readonly kind: SearchErrorKind;
  /** Pesan bahasa sehari-hari untuk pengguna. */
  readonly causeText: string;

  constructor(kind: SearchErrorKind, message: string, causeText: string) {
    super(message);
    this.name = 'SearchError';
    this.kind = kind;
    this.causeText = causeText;
  }
}

function mapInnertubeError(error: InnertubeError, what: string): SearchError {
  if (error.kind === 'rate-limited') {
    return new SearchError(
      'rate-limited',
      error.message,
      'Terlalu banyak permintaan. Coba lagi sebentar.',
    );
  }
  if (error.kind === 'bad-json') {
    return new SearchError(
      'parse',
      error.message,
      'Hasilnya tidak bisa dibaca. YouTube mungkin mengubah layanannya.',
    );
  }
  return new SearchError(
    'http',
    error.message,
    `${what} belum bisa dimuat. Coba lagi nanti.`,
  );
}

function mapNetworkError(error: unknown, what: string): SearchError {
  if (error instanceof SearchError) return error;
  if (error instanceof InnertubeError) {
    return mapInnertubeError(error, what);
  }
  const name = (error as { name?: string } | null)?.name;
  const detail = name === 'TimeoutError' || name === 'AbortError'
    ? 'memakan waktu terlalu lama'
    : 'koneksi bermasalah';
  return new SearchError(
    'network',
    error instanceof Error ? error.message : String(error),
    `${what} tidak bisa dimuat karena ${detail}. Periksa koneksi internet kamu.`,
  );
}

/**
 * Satu instance melayani semua pencarian dalam sesi (visitorData
 * ditangkap sekali dan dipakai ulang).
 */
export class SearchService {
  private readonly client: ClientDefinition;
  private visitorData: string | null = null;

  constructor(client?: ClientDefinition) {
    this.client =
      client ??
      BUILTIN_CLIENTS.find((c) => c.name === 'WEB_REMIX') ??
      BUILTIN_CLIENTS[0];
    if (!this.client) {
      throw new Error('SearchService: tidak ada client InnerTube');
    }
  }

  private context(): Record<string, unknown> {
    const context = { ...this.client.context };
    if (this.visitorData) context.visitorData = this.visitorData;
    return context;
  }

  private captureVisitorData(json: Record<string, unknown>): void {
    const responseContext = json.responseContext as
      | { visitorData?: unknown }
      | undefined;
    const visitorData = responseContext?.visitorData;
    if (typeof visitorData === 'string' && visitorData.length > 0) {
      this.visitorData = visitorData;
    }
  }

  /**
   * Cari di YouTube Music. `params` adalah parameter filter dari
   * chip respons sebelumnya (mis. hanya lagu) untuk layar
   * "Lihat semua". Mengembalikan hasil yang sudah dikelompokkan.
   * Bila parser terstruktur tidak menemukan satu pun lagu,
   * kolektor toleran dipakai sebagai cadangan (port APK).
   */
  async search(
    query: string,
    opts: { params?: string; timeoutMs?: number } = {},
  ): Promise<GroupedSearchResults> {
    const body: Record<string, unknown> = {
      context: { client: this.context() },
      query,
    };
    if (opts.params != null && opts.params.length > 0) {
      body.params = opts.params;
    }
    let json: Record<string, unknown>;
    try {
      ({ json } = await postInnertube(
        '/api/innertube/search',
        body,
        this.client,
        opts.timeoutMs ?? SEARCH_TIMEOUT_MS,
      ));
    } catch (error) {
      throw mapNetworkError(error, 'Pencarian');
    }
    // R1-M4: respons search yang valid selalu membawa `contents` —
    // walau hasilnya kosong. Tanpa itu, server menolak dan hasil
    // kosong diam-diam akan menipu pengguna.
    if (json.contents == null) {
      throw new SearchError(
        'parse',
        'respons search tanpa contents',
        'Hasilnya tidak bisa dibaca. YouTube mungkin mengubah layanannya.',
      );
    }
    this.captureVisitorData(json);
    try {
      const grouped = parseGroupedSearchResults(json);
      if (grouped.songs.length === 0) {
        const tolerant = parseSearchSongsTolerant(json).filter(
          (s) => s.title.length > 0,
        );
        if (tolerant.length > 0) {
          return { ...grouped, songs: tolerant };
        }
      }
      return grouped;
    } catch (error) {
      throw new SearchError(
        'parse',
        `respons search tidak sesuai bentuk yang diharapkan: ${String(error)}`,
        'Hasilnya tidak bisa dibaca. YouTube mungkin mengubah layanannya.',
      );
    }
  }

  /**
   * Muat satu halaman browse: beranda (`FEmusic_home`), artis,
   * album, playlist, atau kategori mood/genre (browseId + params).
   */
  async browse(
    browseId: string,
    opts: { params?: string; timeoutMs?: number } = {},
  ): Promise<BrowsePage> {
    const body: Record<string, unknown> = {
      context: { client: this.context() },
      browseId,
    };
    if (opts.params != null && opts.params.length > 0) {
      body.params = opts.params;
    }
    let json: Record<string, unknown>;
    try {
      ({ json } = await postInnertube(
        '/api/innertube/browse',
        body,
        this.client,
        opts.timeoutMs ?? SEARCH_TIMEOUT_MS,
      ));
    } catch (error) {
      throw mapNetworkError(error, 'Halaman ini');
    }
    if (json.contents == null) {
      throw new SearchError(
        'parse',
        'respons browse tanpa contents',
        'Halaman ini tidak bisa dibaca. YouTube mungkin mengubah layanannya.',
      );
    }
    this.captureVisitorData(json);
    try {
      return parseBrowsePage(json);
    } catch (error) {
      throw new SearchError(
        'parse',
        `respons browse tidak sesuai bentuk yang diharapkan: ${String(error)}`,
        'Halaman ini tidak bisa dibaca. YouTube mungkin mengubah layanannya.',
      );
    }
  }

  /** Beranda Jelajah (rak-rak YouTube Music). */
  async browseHome(
    opts: { timeoutMs?: number } = {},
  ): Promise<BrowsePage> {
    return this.browse(BROWSE_HOME_ID, opts);
  }

  /**
   * Saran pencarian jaringan (`music/get_search_suggestions`),
   * paling banyak 8. Kegagalan apa pun melempar SearchError dan
   * ditangani pemanggil dengan diam (saran hilang, pencarian
   * penuh tetap jalan).
   */
  async suggestions(
    input: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<string[]> {
    let json: Record<string, unknown>;
    try {
      ({ json } = await postInnertube(
        '/api/innertube/suggestions',
        {
          context: { client: this.context() },
          input,
        },
        this.client,
        opts.timeoutMs ?? SUGGESTIONS_TIMEOUT_MS,
      ));
    } catch (error) {
      throw mapNetworkError(error, 'Saran');
    }
    return parseSearchSuggestions(json).slice(0, MAX_NETWORK_SUGGESTIONS);
  }
}

let sharedService: SearchService | null = null;

/** Layanan pencarian bersama (satu instance per sesi). */
export function getSearchService(): SearchService {
  sharedService ??= new SearchService();
  return sharedService;
}

/** Buang layanan bersama (dipakai tes). */
export function resetSearchService(): void {
  sharedService = null;
}
