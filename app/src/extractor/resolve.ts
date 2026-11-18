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
import { isAllowedStreamUrl } from '../solver/urlAllowlist';
import {
  InnertubeError,
  postInnertube,
} from './innertube';
import {
  BASE_JS_TIMEOUT_MS,
  BUILTIN_CLIENTS,
  BUILTIN_HASHES,
  CONFIG_TIMEOUT_MS,
  CONFIG_URL,
  ITAG_ORDER,
  PLAYER_TIMEOUT_MS,
  PROXY_BASE_URL,
  SEARCH_TIMEOUT_MS,
  type ClientDefinition,
} from '../spike/config';

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
  client: string;
  /** True bila URL didapat lewat solver (format cipher). */
  usedSolver: boolean;
  /** Hash base.js yang dipakai solver, bila ada. */
  hash: string | null;
  resolveMs: number;
}

/** Galat resolve dengan pesan yang bisa tampil ke pengguna. */
export class ResolveError extends Error {
  /** Penyebab singkat untuk laporan (bahasa sehari-hari). */
  readonly causeText: string;

  constructor(message: string, causeText: string) {
    super(message);
    this.name = 'ResolveError';
    this.causeText = causeText;
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
 * JSON tidak membawa hash maupun client yang bisa dipakai.
 */
export function parsePlayerConfig(json: unknown): {
  stsByHash: Record<string, number>;
  clients: ClientDefinition[];
} | null {
  if (typeof json !== 'object' || json === null) return null;
  const root = json as Record<string, unknown>;
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
 * Pilih hash player terbaru: sts terbesar. Bila seri, hash pertama
 * dalam urutan kunci yang menang (deterministik).
 */
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
 * Pilih format audio: itag sesuai urutan kanonis, bukan SABR, dan
 * membawa URL langsung atau cipher. Bila tidak ada yang cocok di
 * urutan, ambil bitrate tertinggi.
 */
export function pickAudioFormat(formats: AudioFormat[]): AudioFormat | null {
  const usable = formats.filter(
    (f) => !f.isSabr && (Boolean(f.url) || Boolean(f.signatureCipher)),
  );
  for (const itag of ITAG_ORDER) {
    const found = usable.find((f) => f.itag === itag);
    if (found) return found;
  }
  usable.sort((a, b) => b.bitrate - a.bitrate);
  return usable[0] ?? null;
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
    const res = await fetchWithTimeout(
      CONFIG_URL,
      { headers: { Accept: 'application/json' } },
      CONFIG_TIMEOUT_MS,
    );
    if (!res.ok) throw new Error(`config HTTP ${res.status}`);
    const parsed = parsePlayerConfig(await res.json());
    if (!parsed) throw new Error('config tanpa isi yang bisa dipakai');
    return {
      stsByHash:
        Object.keys(parsed.stsByHash).length > 0
          ? parsed.stsByHash
          : BUILTIN_HASHES,
      clients:
        parsed.clients.length > 0 ? parsed.clients : BUILTIN_CLIENTS,
      fromRemote: true,
    };
  } catch {
    return {
      stsByHash: BUILTIN_HASHES,
      clients: BUILTIN_CLIENTS,
      fromRemote: false,
    };
  }
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

  /** Muat config + visitorData. Dipanggil sekali sebelum lagu pertama. */
  async init(): Promise<PlayerConfig> {
    this.config = await loadPlayerConfig();
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
      { headers: { Accept: 'text/javascript' } },
      BASE_JS_TIMEOUT_MS,
    );
    if (!res.ok) {
      throw new ResolveError(
        `base.js hash ${hash} HTTP ${res.status}`,
        'File pemutar lagu tidak bisa diambil dari server perantara.',
      );
    }
    const baseJs = await res.text();
    if (baseJs.length > 8 * 1024 * 1024) {
      throw new ResolveError(
        'base.js melewati cap 8 MB',
        'File pemutar lagu terlalu besar.',
      );
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
    return { playability, picked: pickAudioFormat(formats) };
  }

  /**
   * Resolve satu lagu lewat urutan fallback client. Format cipher
   * dipecahkan solver di browser; URL langsung dipakai apa adanya
   * sesudah lolos allowlist.
   */
  async resolve(song: SongRef): Promise<ResolvedTrack> {
    if (!this.config) {
      throw new ResolveError('resolver belum init', 'Resolver belum siap.');
    }
    const t0 = performance.now();
    const attempts: string[] = [];
    let lastProxyError: ResolveError | null = null;
    for (const client of this.config.clients) {
      let attempt: {
        playability: string;
        picked: AudioFormat | null;
      } | null = null;
      try {
        attempt = await this.fetchPlayer(song, client);
      } catch (error) {
        if (error instanceof ResolveError) {
          // Galat proxy (mis. rate limit): catat lalu coba client
          // berikut; penyebab spesifik dipakai bila semua gagal.
          lastProxyError = error;
          attempts.push(`${client.name}=proxy-gagal`);
          continue;
        }
        // Satu kali coba ulang untuk galat jaringan/timeout.
        try {
          await new Promise((r) => setTimeout(r, 2000));
          attempt = await this.fetchPlayer(song, client);
        } catch (retryError) {
          if (retryError instanceof ResolveError) {
            lastProxyError = retryError;
            attempts.push(`${client.name}=proxy-gagal`);
          } else {
            attempts.push(`${client.name}=jaringan-gagal`);
          }
          continue;
        }
      }
      attempts.push(`${client.name}=${attempt.playability}`);
      const picked = attempt.picked;
      if (!picked) continue;
      if (picked.url) {
        if (!isAllowedStreamUrl(picked.url)) continue;
        return {
          videoId: song.videoId,
          title: song.title,
          url: picked.url,
          itag: picked.itag,
          client: client.name,
          usedSolver: false,
          hash: null,
          resolveMs: Math.round(performance.now() - t0),
        };
      }
      if (picked.signatureCipher) {
        try {
          const { url, hash } = await this.solveCipher(picked);
          return {
            videoId: song.videoId,
            title: song.title,
            url,
            itag: picked.itag,
            client: client.name,
            usedSolver: true,
            hash,
            resolveMs: Math.round(performance.now() - t0),
          };
        } catch (error) {
          attempts.push(`${client.name}=solver-gagal`);
          if (error instanceof ResolveError) {
            // Cipher gagal dipecahkan: coba client berikut.
            continue;
          }
          throw error;
        }
      }
    }
    if (lastProxyError) {
      throw new ResolveError(
        `resolve gagal untuk ${song.videoId}: ${attempts.join(', ')}; ` +
          `penyebab proxy: ${lastProxyError.message}`,
        lastProxyError.causeText,
      );
    }
    throw new ResolveError(
      `resolve gagal untuk ${song.videoId}: ${attempts.join(', ')}`,
      'Lagu tidak bisa ditemukan di semua jalur. Coba lagi nanti.',
    );
  }

  /** Tutup worker solver (dipanggil saat uji selesai atau dibatalkan). */
  dispose(): void {
    this.solver?.dispose();
    this.solver = null;
    this.solverLoading = null;
  }
}
