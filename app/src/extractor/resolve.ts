/**
 * Resolve lagu dari browser lewat proxy byte-only.
 *
 * Alur: config remote (fetch langsung, CORS terbuka) lalu request
 * player dan base.js lewat proxy (fetch langsung diblokir CORS,
 * vonis S2). Format cipher dipecahkan solver QuickJS-WASM di
 * browser (S1/S4). URL stream hasil resolve dipakai langsung oleh
 * elemen audio, BUKAN lewat proxy (arsitektur produksi; proxy audio
 * untuk streaming dilarang).
 *
 * Modul ini adalah wiring resolve P1 yang terbukti (halaman spike),
 * dipromosikan ke kode produksi P2 tanpa mengubah alurnya. Satu
 * perubahan: `SpikeResolver` menjadi `StreamResolver` dan lagu
 * diwakili `SongRef` umum (bukan hanya lagu kanari).
 *
 * Solver di-lazy-load: modul solver (termasuk WASM sekitar 250 KB
 * gzip) hanya diunduh saat format cipher pertama ditemui. Jalur
 * ANDROID_VR yang memberi URL langsung tidak memuat solver sama
 * sekali.
 *
 * URL stream TIDAK PERNAH dicetak ke log atau laporan (aturan
 * PRD B2.1). Laporan hanya mencatat host tersamar, itag, dan
 * panjang URL.
 */
import { buildPlayerScript, type PlayerScript } from '../solver/playerScript';
import { ExtractorException } from '../solver/errors';
import { isAllowedStreamUrl } from '../solver/urlAllowlist';
import {
  defaultDelay,
  isRefusalPlayability,
  RESOLVE_RETRY_BACKOFF_MS,
  RESOLVE_RETRY_ROUNDS,
} from '../resilience/retry';
import type { ConfigLoader } from '../resilience/configStore';
import {
  InnertubeError,
  postInnertube,
} from './innertube';
import { fetchRemoteConfigText } from './fetchConfig';
import {
  fetchCachedStream,
  type CachedStream,
} from './resolveCache';
import {
  BASE_JS_MAX_BYTES,
  BASE_JS_TIMEOUT_MS,
  BUILTIN_CLIENTS,
  BUILTIN_HASHES,
  CONFIG_SCHEMA_VERSION,
  ITAG_ORDER,
  PLAYER_TIMEOUT_MS,
  PROXY_BASE_URL,
  SEARCH_TIMEOUT_MS,
  type ClientDefinition,
} from '../spike/config';
import { readCappedText, ResponseTooBigError } from './readCapped';

/** Lagu yang bisa di-resolve: cukup videoId dan judul tampil. */
export interface SongRef {
  videoId: string;
  title: string;
}

export interface PlayerConfig {
  stsByHash: Record<string, number>;
  clients: ClientDefinition[];
  /** True bila config remote berhasil diambil (bukan nilai bawaan). */
  fromRemote: boolean;
}

export interface ResolvedTrack {
  videoId: string;
  title: string;
  /** URL stream langsung. Hanya ada di memori, jangan dicetak. */
  url: string;
  itag: number;
  /** Bitrate format terpilih (bit/detik), bila diketahui. */
  bitrate: number | null;
  client: string;
  /** True bila URL didapat lewat solver (format cipher). */
  usedSolver: boolean;
  /** Hash base.js yang dipakai solver, bila ada. */
  hash: string | null;
  resolveMs: number;
  /**
   * True bila URL berasal dari cache D1 (P3), bukan resolve
   * langsung. Dipakai diagnostik; tidak mengubah pemutaran.
   */
  fromCache?: boolean;
}

/** Galat resolve dengan pesan yang bisa tampil ke pengguna. */
export class ResolveError extends Error {
  /** Penyebab singkat untuk laporan (bahasa sehari-hari). */
  readonly causeText: string;
  /**
   * Upaya per client bentuk `CLIENT=STATUS` (tanpa videoId, aman
   * untuk log dan diagnostik). Diisi resolve() saat gagal.
   */
  readonly attempts: string[];

  constructor(message: string, causeText: string, attempts: string[] = []) {
    super(message);
    this.name = 'ResolveError';
    this.causeText = causeText;
    this.attempts = attempts;
  }
}

export interface AudioFormat {
  itag: number;
  mimeType: string;
  bitrate: number;
  url?: string;
  signatureCipher?: string;
  isSabr: boolean;
}

/**
 * Parse config player dari JSON config-v1. Mengembalikan null bila
 * JSON tidak membawa hash maupun client yang bisa dipakai, atau
 * bila nomor versi skemanya tidak dikenal app ini (PRD B9.1:
 * "app lama menolak config yang tidak dikenalnya"). Field `version`
 * di file live adalah 1; config tanpa field versi juga ditolak
 * karena versinya tidak diketahui.
 */
export function parsePlayerConfig(json: unknown): {
  stsByHash: Record<string, number>;
  clients: ClientDefinition[];
} | null {
  if (typeof json !== 'object' || json === null) return null;
  const root = json as Record<string, unknown>;
  if (root.version !== CONFIG_SCHEMA_VERSION) return null;
  const stsByHash: Record<string, number> = {};
  const hashes = root.playerHashes as
    | Record<string, { signatureTimestamp?: unknown }>
    | undefined;
  for (const [hash, value] of Object.entries(hashes ?? {})) {
    if (typeof value?.signatureTimestamp === 'number') {
      stsByHash[hash] = value.signatureTimestamp;
    }
  }
  const clients: ClientDefinition[] = [];
  const rawClients = root.clients as
    | Array<Record<string, unknown>>
    | undefined;
  for (const raw of rawClients ?? []) {
    if (
      typeof raw.name !== 'string' ||
      typeof raw.version !== 'string' ||
      typeof raw.clientId !== 'string'
    ) {
      continue;
    }
    const context: Record<string, unknown> = {
      clientName: raw.name,
      clientVersion: raw.version,
    };
    if (raw.name === 'ANDROID_VR') context.androidSdkVersion = 34;
    clients.push({
      name: raw.name,
      version: raw.version,
      clientId: raw.clientId,
      context,
      requiresScript: raw.requiresScript !== false,
    });
  }
  if (Object.keys(stsByHash).length === 0 && clients.length === 0) {
    return null;
  }
  return { stsByHash, clients };
}

/**
 * Bentuk PlayerConfig dari hasil parse: config remote MENGGANTIKAN
 * builtin (semantik allowlist PRD B9.3); fallback ke builtin HANYA
 * bila set yang diteruskan kosong. Dipakai loadPlayerConfig dan
 * loader TTL P6 (satu semantik di kedua jalur).
 */
export function playerConfigFromParsed(
  parsed: {
    stsByHash: Record<string, number>;
    clients: ClientDefinition[];
  },
  fromRemote: boolean,
): PlayerConfig {
  return {
    stsByHash:
      Object.keys(parsed.stsByHash).length > 0
        ? parsed.stsByHash
        : BUILTIN_HASHES,
    clients:
      parsed.clients.length > 0 ? parsed.clients : BUILTIN_CLIENTS,
    fromRemote,
  };
}
export function chooseHash(stsByHash: Record<string, number>): string | null {
  let best: string | null = null;
  let bestSts = -1;
  for (const [hash, sts] of Object.entries(stsByHash)) {
    if (sts > bestSts) {
      best = hash;
      bestSts = sts;
    }
  }
  return best;
}

/** sts terbesar dari config (dipakai request player client scripted). */
export function maxSts(stsByHash: Record<string, number>): number | null {
  const values = Object.values(stsByHash);
  if (values.length === 0) return null;
  return Math.max(...values);
}

export interface ParsedCipher {
  cipherUrl: string;
  cipheredS: string;
  sigParam: string;
}

/**
 * Parse `signatureCipher` (query string `s=...&sp=...&url=...`).
 * Mengembalikan null bila bagian wajib tidak ada.
 */
export function parseSignatureCipher(cipher: string): ParsedCipher | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(cipher);
  } catch {
    return null;
  }
  const s = params.get('s');
  const cipherUrl = params.get('url');
  if (!s || !cipherUrl) return null;
  // Dekode SATU kali saja (port Uri.splitQueryString APK): nilai url
  // yang sudah terdekode masih mengandung %XX milik URL itu sendiri
  // (mis. %3A pada alamat IPv6); dekode kedua merusak URL.
  if (!isAllowedStreamUrl(cipherUrl)) return null;
  return { cipherUrl, cipheredS: s, sigParam: params.get('sp') || 'sig' };
}

/** Parse status dan format audio dari respons player InnerTube. */
export function parseAudioFormats(json: unknown): {
  playability: string;
  formats: AudioFormat[];
} {
  const root = (typeof json === 'object' && json !== null
    ? json
    : {}) as Record<string, unknown>;
  const playability =
    ((root.playabilityStatus as { status?: string } | undefined)?.status ??
      '?');
  const streamingData = (root.streamingData ?? {}) as {
    serverAbrStreamingUrl?: string;
    adaptiveFormats?: Array<Record<string, unknown>>;
  };
  const topSabr = Boolean(streamingData.serverAbrStreamingUrl);
  const formats: AudioFormat[] = [];
  for (const f of streamingData.adaptiveFormats ?? []) {
    const mimeType = String(f.mimeType ?? '');
    if (!mimeType.startsWith('audio/')) continue;
    const hasUrl = typeof f.url === 'string' && f.url.length > 0;
    const hasCipher =
      typeof f.signatureCipher === 'string' && f.signatureCipher.length > 0;
    const isSabr = Boolean(
      f.serverAbrStreamingUrl || (!hasUrl && !hasCipher && topSabr),
    );
    formats.push({
      itag: Number(f.itag ?? 0),
      mimeType,
      bitrate: Number(f.bitrate ?? 0),
      url: hasUrl ? (f.url as string) : undefined,
      signatureCipher: hasCipher ? (f.signatureCipher as string) : undefined,
      isSabr,
    });
  }
  return { playability, formats };
}

/**
 * Pilih format audio menurut urutan itag pilihan: itag pertama
 * dalam urutan yang tersedia (bukan SABR, membawa URL langsung
 * atau cipher) yang menang. Bila tidak ada yang cocok di urutan,
 * ambil bitrate tertinggi.
 */
export function pickAudioFormatForPreference(
  formats: AudioFormat[],
  preference: readonly number[],
): AudioFormat | null {
  const usable = formats.filter(
    (f) => !f.isSabr && (Boolean(f.url) || Boolean(f.signatureCipher)),
  );
  for (const itag of preference) {
    const found = usable.find((f) => f.itag === itag);
    if (found) return found;
  }
  usable.sort((a, b) => b.bitrate - a.bitrate);
  return usable[0] ?? null;
}

/**
 * Pilih format audio: itag sesuai urutan kanonis, bukan SABR, dan
 * membawa URL langsung atau cipher. Bila tidak ada yang cocok di
 * urutan, ambil bitrate tertinggi.
 */
export function pickAudioFormat(formats: AudioFormat[]): AudioFormat | null {
  return pickAudioFormatForPreference(formats, ITAG_ORDER);
}

/**
 * Ringkasan URL stream yang AMAN dicetak ke log dan laporan.
 * URL lengkap TIDAK PERNAH dicetak.
 */
export function describeStreamUrl(url: string, itag: number): string {
  let host = '?';
  try {
    host = new URL(url).hostname;
  } catch {
    host = 'url-tidak-valid';
  }
  const edge = host.endsWith('.googlevideo.com') ? '*.googlevideo.com' : host;
  return `host=${edge} itag=${itag} urlLen=${url.length}`;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res;
}

/**
 * POST ke proxy, memetakan galat balasan ke ResolveError dengan
 * pesan yang sama seperti sebelum refactor (P4 memindahkan fetch
 * ke modul bersama `innertube.ts`; perilaku resolve tidak berubah).
 * Galat jaringan lolos apa adanya (pemanggil mencoba ulang sekali).
 */
async function postViaProxy(
  path: string,
  body: Record<string, unknown>,
  client: ClientDefinition,
  timeoutMs: number,
): Promise<{ status: number; json: Record<string, unknown> }> {
  try {
    return await postInnertube(path, body, client, timeoutMs);
  } catch (error) {
    if (error instanceof InnertubeError) {
      if (error.kind === 'bad-json') {
        throw new ResolveError(
          error.message,
          `Server perantara membalas tidak wajar (HTTP ${error.status}).`,
        );
      }
      if (error.kind === 'too-big') {
        throw new ResolveError(
          error.message,
          'Balasan server perantara terlalu besar.',
        );
      }
      throw new ResolveError(
        error.message,
        error.kind === 'rate-limited'
          ? 'Terlalu banyak permintaan, coba lagi sebentar.'
          : `Server perantara gagal (HTTP ${error.status}).`,
      );
    }
    throw error;
  }
}

/** Muat config remote; bila gagal, pakai nilai bawaan. */
export async function loadPlayerConfig(): Promise<PlayerConfig> {
  try {
    // Cap 4 MB ditegakkan SELAMA membaca stream (Red 1 S4):
    // respons raksasa dibatalkan sebelum memenuhi memori, bukan
    // sesudahnya. Config dengan versi skema tak dikenal ditolak
    // di parsePlayerConfig dan jatuh ke nilai bawaan di bawah.
    const text = await fetchRemoteConfigText();
    const parsed = parsePlayerConfig(JSON.parse(text) as unknown);
    if (!parsed) throw new Error('config tanpa isi yang bisa dipakai');
    return playerConfigFromParsed(parsed, true);
  } catch {
    return {
      stsByHash: BUILTIN_HASHES,
      clients: BUILTIN_CLIENTS,
      fromRemote: false,
    };
  }
}

/**
 * Snapshot resolve terakhir (untuk diagnostik LRS1): client yang
 * dicoba, playability tiap client, dan jumlah putaran. Tanpa
 * videoId, tanpa URL.
 */
export interface LastResolveSnapshot {
  clientsTried: string[];
  playabilityByClient: Record<string, string>;
  rounds: number;
  failedAt: number;
}

type SolverClientType = import('../solver/solverClient').SolverClient;

/**
 * Resolver produksi: satu instance melayani semua lagu dalam sesi
 * (config dan visitorData dimuat sekali, solver dipakai ulang).
 */
export class StreamResolver {
  private config: PlayerConfig | null = null;
  private sts = 0;
  private hash: string | null = null;
  private visitorData: string | null = null;
  private solver: SolverClientType | null = null;
  private solverLoading: Promise<SolverClientType> | null = null;
  private scriptByHash = new Map<string, PlayerScript>();
  private configLoader: ConfigLoader | null;
  private lastSnapshot: LastResolveSnapshot | null = null;
  private cacheLookup: (videoId: string) => Promise<CachedStream | null>;

  /**
   * `configLoader` bisa diinjeksi (tes memakai loader dengan jam
   * dan storage palsu); tanpa injeksi, loader bersama TTL 6 jam
   * dipakai (impor dinamis supaya tidak ada siklus statis dengan
   * resilience/configStore). `cacheLookup` juga bisa diinjeksi
   * (tes memakai lookup palsu); tanpa injeksi, baca cache D1
   * lewat worker proxy dipakai.
   */
  constructor(opts: {
    configLoader?: ConfigLoader;
    cacheLookup?: (videoId: string) => Promise<CachedStream | null>;
  } = {}) {
    this.configLoader = opts.configLoader ?? null;
    this.cacheLookup = opts.cacheLookup ?? fetchCachedStream;
  }

  /** Muat config + visitorData. Dipanggil sekali sebelum lagu pertama. */
  async init(): Promise<PlayerConfig> {
    // Config lewat loader TTL 6 jam (P6, K7): remote segar, lalu
    // cache terakhir yang valid, lalu builtin.
    const loader =
      this.configLoader ??
      (await import('../resilience/configStore')).getConfigLoader();
    this.configLoader = loader;
    const loaded = await loader.load();
    this.config = loaded.config;
    this.sts = maxSts(this.config.stsByHash) ?? 0;
    this.hash = chooseHash(this.config.stsByHash);
    // Jaring pengaman VR: urutan client wajib membawa minimal satu
    // client bebas-script (arsitektur §4.2).
    if (
      !this.config.clients.some((c) => c.requiresScript === false)
    ) {
      const vr = BUILTIN_CLIENTS.find((c) => c.name === 'ANDROID_VR');
      if (vr) this.config.clients = [...this.config.clients, vr];
    }
    try {
      const first = this.config.clients[0];
      if (first) {
        const { json } = await postViaProxy(
          '/api/innertube/search',
          {
            context: { client: { ...first.context } },
            query: 'lagu indonesia populer',
          },
          first,
          SEARCH_TIMEOUT_MS,
        );
        const responseContext = json.responseContext as
          | { visitorData?: string }
          | undefined;
        if (
          typeof responseContext?.visitorData === 'string' &&
          responseContext.visitorData.length > 0
        ) {
          this.visitorData = responseContext.visitorData;
        }
      }
    } catch {
      // visitorData tidak pernah memblokir resolve (aturan APK).
      this.visitorData = null;
    }
    return this.config;
  }

  get playerHash(): string | null {
    return this.hash;
  }

  get usedRemoteConfig(): boolean {
    return this.config?.fromRemote ?? false;
  }

  /** Versi client utama di config aktif (untuk diagnostik LRS1). */
  get primaryClientVersion(): string | null {
    return this.config?.clients[0]?.version ?? null;
  }

  /** Snapshot resolve terakhir (null bila belum pernah resolve). */
  get lastResolve(): LastResolveSnapshot | null {
    return this.lastSnapshot;
  }

  /**
   * Lazy-load solver: modul solver (termasuk WASM) baru diunduh saat
   * format cipher pertama ditemui. Dipanggil sekali, dipakai ulang.
   */
  private loadSolver(): Promise<SolverClientType> {
    if (this.solver) return Promise.resolve(this.solver);
    if (!this.solverLoading) {
      this.solverLoading = import('../solver/solverClient').then(
        ({ SolverClient }) => {
          this.solver = new SolverClient();
          return this.solver;
        },
      );
    }
    return this.solverLoading;
  }

  private async loadPlayerScript(hash: string): Promise<PlayerScript> {
    const cached = this.scriptByHash.get(hash);
    if (cached) return cached;
    const res = await fetchWithTimeout(
      `${PROXY_BASE_URL}/api/player-script?hash=${encodeURIComponent(hash)}`,
      {
        headers: { Accept: 'text/javascript' },
        // Jangan pernah pakai ulang base.js basi dari HTTP cache
        // browser (proxy mengirim max-age=86400): hash boleh sama
        // sementara isi base.js sudah berubah di sisi YouTube.
        // Dedup dalam satu sesi tetap lewat cache memori scriptByHash.
        cache: 'no-store',
      },
      BASE_JS_TIMEOUT_MS,
    );
    if (!res.ok) {
      throw new ResolveError(
        `base.js hash ${hash} HTTP ${res.status}`,
        'File pemutar lagu tidak bisa diambil dari server perantara.',
      );
    }
    // Cap 8 MB ditegakkan SELAMA membaca stream (Red 1 R5): pola
    // lama `res.text()` dulu lalu cek panjang sudah terlambat.
    let baseJs: string;
    try {
      baseJs = await readCappedText(res, BASE_JS_MAX_BYTES);
    } catch (error) {
      if (error instanceof ResponseTooBigError) {
        throw new ResolveError(
          'base.js melewati cap 8 MB',
          'File pemutar lagu terlalu besar.',
        );
      }
      throw error;
    }
    const script = buildPlayerScript(
      `/s/player/${hash}/player_es6.vflset/en_US/base.js`,
      baseJs,
    );
    this.scriptByHash.set(hash, script);
    return script;
  }

  private async solveCipher(
    format: AudioFormat,
  ): Promise<{ url: string; hash: string }> {
    const cipher = format.signatureCipher
      ? parseSignatureCipher(format.signatureCipher)
      : null;
    if (!cipher) {
      throw new ResolveError(
        'signatureCipher tidak bisa diparse',
        'Format lagu terenkripsi tidak bisa dibaca.',
      );
    }
    const hash = this.hash;
    if (!hash) {
      throw new ResolveError(
        'tidak ada hash player di config',
        'Config tidak membawa info pemutar lagu.',
      );
    }
    const script = await this.loadPlayerScript(hash);
    const solver = await this.loadSolver();
    const url = await solver.solve(script, {
      cipherUrl: cipher.cipherUrl,
      cipheredS: cipher.cipheredS,
      sigParam: cipher.sigParam,
    });
    return { url, hash };
  }

  private async fetchPlayer(
    song: SongRef,
    client: ClientDefinition,
    itagPreference: readonly number[] = ITAG_ORDER,
  ): Promise<{ playability: string; picked: AudioFormat | null }> {
    const context = { ...client.context };
    if (this.visitorData) context.visitorData = this.visitorData;
    const contentPlaybackContext: Record<string, unknown> = {
      vis: 0,
      splay: false,
      autoCaptionsDefaultOn: false,
      autonavState: 'STATE_OFF',
      html5Preference: 'HTML5_PREF_WANTS',
      lact: [],
    };
    if (client.requiresScript) {
      // sts WAJIB di request player pertama: tanpa sts server
      // membalas UNPLAYABLE, bukan LOGIN_REQUIRED.
      contentPlaybackContext.signatureTimestamp = this.sts;
    }
    const { json } = await postViaProxy(
      '/api/innertube/player',
      {
        context: { client: context },
        videoId: song.videoId,
        playbackContext: { contentPlaybackContext },
        racyCheckOk: true,
        contentCheckOk: true,
      },
      client,
      PLAYER_TIMEOUT_MS,
    );
    const { playability, formats } = parseAudioFormats(json);
    return {
      playability,
      picked: pickAudioFormatForPreference(formats, itagPreference),
    };
  }

  /**
   * Resolve satu lagu lewat urutan fallback client. Format cipher
   * dipecahkan solver di browser; URL langsung dipakai apa adanya
   * sesudah lolos allowlist.
   *
   * `opts.itagPreference` (P5, unduhan): urutan itag pilihan
   * kualitas unduhan; tanpa opsi ini, urutan kanonis dipakai
   * (perilaku pemutaran tidak berubah).
   *
   * Retry lintas waktu (P6, rekomendasi §5): bila SEMUA client
   * menolak dalam satu putaran (LOGIN_REQUIRED/UNPLAYABLE tanpa
   * format), putaran diulang sampai `maxRounds` (default 3)
   * dengan backoff 5 dtk lalu 15 dtk. `delay` bisa diinjeksi
   * supaya tes tidak tidur sungguhan; `onRetryRound` dipanggil
   * sebelum tiap jeda supaya UI bisa menenangkan pengguna
   * ("mencari jalur lain") alih-alih menampilkan error.
   * Kanari memakai maxRounds 1: probe mengukur, bukan menutupi.
   */
  async resolve(
    song: SongRef,
    opts: {
      itagPreference?: readonly number[];
      maxRounds?: number;
      delay?: (ms: number) => Promise<void>;
      onRetryRound?: (round: number, waitMs: number) => void;
    } = {},
  ): Promise<ResolvedTrack> {
    if (!this.config) {
      throw new ResolveError('resolver belum init', 'Resolver belum siap.');
    }
    const itagPreference = opts.itagPreference ?? ITAG_ORDER;
    const maxRounds = Math.max(1, opts.maxRounds ?? RESOLVE_RETRY_ROUNDS);
    const delay = opts.delay ?? defaultDelay;
    const t0 = performance.now();
    const allAttempts: string[] = [];
    const playabilityByClient: Record<string, string> = {};
    let lastProxyError: ResolveError | null = null;
    let roundsRun = 0;
    for (let round = 0; round < maxRounds; round++) {
      roundsRun = round + 1;
      const roundAttempts: string[] = [];
      let sawFormat = false;
      let sawProxyOrNetwork = false;
      let refusals = 0;
      for (const client of this.config.clients) {
        let attempt: {
          playability: string;
          picked: AudioFormat | null;
        } | null = null;
        try {
          attempt = await this.fetchPlayer(song, client, itagPreference);
        } catch (error) {
          if (error instanceof ResolveError) {
            // Galat proxy (mis. rate limit): catat lalu coba client
            // berikut; penyebab spesifik dipakai bila semua gagal.
            lastProxyError = error;
            roundAttempts.push(`${client.name}=proxy-gagal`);
            sawProxyOrNetwork = true;
            continue;
          }
          // Satu kali coba ulang untuk galat jaringan/timeout.
          try {
            await new Promise((r) => setTimeout(r, 2000));
            attempt = await this.fetchPlayer(song, client, itagPreference);
          } catch (retryError) {
            if (retryError instanceof ResolveError) {
              lastProxyError = retryError;
              roundAttempts.push(`${client.name}=proxy-gagal`);
            } else {
              roundAttempts.push(`${client.name}=jaringan-gagal`);
            }
            sawProxyOrNetwork = true;
            continue;
          }
        }
        roundAttempts.push(`${client.name}=${attempt.playability}`);
        playabilityByClient[client.name] = attempt.playability;
        if (isRefusalPlayability(attempt.playability)) refusals += 1;
        const picked = attempt.picked;
        if (!picked) continue;
        sawFormat = true;
        if (picked.url) {
          if (!isAllowedStreamUrl(picked.url)) continue;
          this.recordSnapshot(
            roundAttempts,
            playabilityByClient,
            roundsRun,
          );
          return {
            videoId: song.videoId,
            title: song.title,
            url: picked.url,
            itag: picked.itag,
            bitrate: picked.bitrate > 0 ? picked.bitrate : null,
            client: client.name,
            usedSolver: false,
            hash: null,
            resolveMs: Math.round(performance.now() - t0),
          };
        }
        if (picked.signatureCipher) {
          try {
            const { url, hash } = await this.solveCipher(picked);
            this.recordSnapshot(
              roundAttempts,
              playabilityByClient,
              roundsRun,
            );
            return {
              videoId: song.videoId,
              title: song.title,
              url,
              itag: picked.itag,
              bitrate: picked.bitrate > 0 ? picked.bitrate : null,
              client: client.name,
              usedSolver: true,
              hash,
              resolveMs: Math.round(performance.now() - t0),
            };
          } catch (error) {
            roundAttempts.push(`${client.name}=solver-gagal`);
            if (
              error instanceof ResolveError ||
              error instanceof ExtractorException
            ) {
              // Cipher gagal dipecahkan (termasuk buildPlayerScript
              // yang melempar ExtractorException, mis. base.js berubah
              // strukturnya, dan solverTimeout dari solverClient):
              // coba client berikut, jangan matikan resolve.
              continue;
            }
            throw error;
          }
        }
      }
      allAttempts.push(...roundAttempts);
      const allRefused =
        this.config.clients.length > 0 &&
        refusals === this.config.clients.length &&
        !sawFormat &&
        !sawProxyOrNetwork;
      if (allRefused && round + 1 < maxRounds) {
        const waitMs =
          RESOLVE_RETRY_BACKOFF_MS[round] ??
          RESOLVE_RETRY_BACKOFF_MS[RESOLVE_RETRY_BACKOFF_MS.length - 1];
        opts.onRetryRound?.(round + 2, waitMs);
        await delay(waitMs);
        continue;
      }
      break;
    }
    this.recordSnapshot(allAttempts, playabilityByClient, roundsRun);
    // Cadangan cache D1 (P3): resolve langsung gagal di semua
    // putaran — coba simpanan dari jendela terbuka terakhir.
    // Entri kedaluwarsa sudah disaring worker + parse client;
    // yang kembali ke sini dijamin masih berlaku. Cache tidak
    // pernah melempar (null = tidak ada simpanan), jadi kegagalan
    // di sini tidak menutupi penyebab asli di bawah.
    const cached = await this.tryCache(song);
    if (cached) {
      return {
        videoId: song.videoId,
        title: song.title,
        url: cached.url,
        itag: cached.itag,
        bitrate: cached.bitrate,
        client: cached.client,
        usedSolver: false,
        hash: null,
        resolveMs: Math.round(performance.now() - t0),
        fromCache: true,
      };
    }
    if (lastProxyError) {
      throw new ResolveError(
        `resolve gagal untuk ${song.videoId}: ${allAttempts.join(', ')}; ` +
          `penyebab proxy: ${lastProxyError.message}`,
        lastProxyError.causeText,
        allAttempts,
      );
    }
    throw new ResolveError(
      `resolve gagal untuk ${song.videoId}: ${allAttempts.join(', ')}`,
      'Lagu tidak bisa ditemukan di semua jalur. Coba lagi nanti.',
      allAttempts,
    );
  }

  /**
   * Baca cache D1 untuk satu lagu. Mengembalikan null bila tidak
   * ada simpanan atau lookup gagal dengan cara apa pun — cache
   * adalah cadangan best-effort, bukan jalur yang boleh melempar.
   */
  private async tryCache(song: SongRef): Promise<CachedStream | null> {
    try {
      return await this.cacheLookup(song.videoId);
    } catch {
      return null;
    }
  }

  /** Simpan snapshot resolve terakhir untuk diagnostik LRS1. */
  private recordSnapshot(
    attempts: string[],
    playabilityByClient: Record<string, string>,
    rounds: number,
  ): void {
    const clientsTried: string[] = [];
    for (const attempt of attempts) {
      const name = attempt.split('=')[0];
      if (name && !clientsTried.includes(name)) clientsTried.push(name);
    }
    this.lastSnapshot = {
      clientsTried,
      playabilityByClient: { ...playabilityByClient },
      rounds,
      failedAt: Date.now(),
    };
  }

  /** Tutup worker solver (dipanggil saat uji selesai atau dibatalkan). */
  dispose(): void {
    this.solver?.dispose();
    this.solver = null;
    this.solverLoading = null;
  }
}
