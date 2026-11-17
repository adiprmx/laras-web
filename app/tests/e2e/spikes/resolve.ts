// Resolve InnerTube sisi Node untuk harness spike S3/S5/S9.
//
// Port MINIMAL alur APK (fallback_orchestrator.dart + innertube_client.dart)
// yang cukup untuk spike pemutaran. Ini BUKAN ekstraktor produksi web
// (itu pekerjaan tim ekstraktor / spike S4); modul ini hanya memberi URL
// stream langsung ANDROID_VR kepada harness uji.
//
// Alur: config remote -> visitorData via search -> request player per
// client (sts WAJIB untuk client scripted) -> pilih itag 251/140/250/
// 249/139 -> tolak SABR -> validasi allowlist host.
//
// Format cipher (WEB_REMIX/MWEB) TIDAK dipecahkan di sini: solver adalah
// spike S4. Bila client scripted hanya memberi cipher, hasilnya dicatat
// sebagai needsSolver dan client berikut dicoba.
//
// URL stream TIDAK PERNAH dicetak ke log; pakai describeStreamUrl().
import {
  ANDROID_VR,
  BEST_QUALITY_ITAG_ORDER,
  CLIENT_FALLBACK_ORDER,
  CONFIG_URL,
  INNERTUBE_API_KEY,
  INNERTUBE_HOST,
  WEB_REMIX,
  describeStreamUrl,
  isAllowedStreamUrl,
  type CanarySong,
  type ClientDefinition,
} from './canary';

export interface PlayerConfig {
  stsByHash: Record<string, number>;
  fetchedMs: number;
}

export interface ResolvedSong {
  song: CanarySong;
  client: string;
  itag: number;
  mimeType: string;
  bitrate: number;
  /** URL stream langsung. Hanya ada di memori, jangan dicetak. */
  url: string;
  /** Total byte dari Content-Range probe pertama, bila diketahui. */
  totalBytes: number | null;
  resolveMs: number;
  /** Client yang dicoba sebelum yang berhasil, beserta hasilnya. */
  attempts: ResolveAttempt[];
}

export interface ResolveAttempt {
  client: string;
  playability: string;
  audioFormats: number;
  pickedItag: number | null;
  pickedDirect: boolean;
  pickedCipher: boolean;
  ms: number;
  error?: string;
}

interface AudioFormat {
  itag: number;
  mimeType: string;
  bitrate: number;
  url?: string;
  signatureCipher?: string;
  serverAbrStreamingUrl?: string;
  isSabr: boolean;
}

const SEARCH_QUERY = 'lagu indonesia populer';

/** Timeout: egress VM lambat (request player sah 16-26 detik, bukti APK). */
const PLAYER_TIMEOUT_MS = 60000;
const SEARCH_TIMEOUT_MS = 60000;
const CONFIG_TIMEOUT_MS = 30000;

async function postYoutubei(
  path: string,
  body: Record<string, unknown>,
  client: ClientDefinition,
  timeoutMs: number,
): Promise<{ status: number; ms: number; json: Record<string, unknown> }> {
  const t0 = Date.now();
  const res = await fetch(
    `https://${INNERTUBE_HOST}${path}?key=${INNERTUBE_API_KEY}&prettyPrint=false`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': client.userAgent,
        'X-YouTube-Client-Name': client.clientId,
        'X-YouTube-Client-Version': client.version,
        Accept: 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  const text = await res.text();
  return { status: res.status, ms: Date.now() - t0, json: JSON.parse(text) as Record<string, unknown> };
}

export async function fetchPlayerConfig(): Promise<PlayerConfig> {
  const t0 = Date.now();
  const res = await fetch(CONFIG_URL, {
    signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`config HTTP ${res.status}`);
  const json = (await res.json()) as {
    playerHashes?: Record<string, { signatureTimestamp?: number }>;
  };
  const stsByHash: Record<string, number> = {};
  for (const [hash, v] of Object.entries(json.playerHashes ?? {})) {
    if (typeof v.signatureTimestamp === 'number') {
      stsByHash[hash] = v.signatureTimestamp;
    }
  }
  return { stsByHash, fetchedMs: Date.now() - t0 };
}

/** Ambil visitorData segar lewat endpoint search (cache di pemanggil). */
export async function fetchVisitorData(
  client: ClientDefinition,
): Promise<{ visitorData: string | null; ms: number }> {
  const { json, ms } = await postYoutubei(
    '/youtubei/v1/search',
    { context: { client: { ...client.context } }, query: SEARCH_QUERY },
    client,
    SEARCH_TIMEOUT_MS,
  );
  const responseContext = json.responseContext as
    | { visitorData?: string }
    | undefined;
  const visitorData =
    typeof responseContext?.visitorData === 'string' &&
    responseContext.visitorData.length > 0
      ? responseContext.visitorData
      : null;
  return { visitorData, ms };
}

function parseAudioFormats(
  json: Record<string, unknown>,
): { playability: string; formats: AudioFormat[] } {
  const playability =
    ((json.playabilityStatus as { status?: string } | undefined)?.status ??
      '?');
  const streamingData = (json.streamingData ?? {}) as {
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
      serverAbrStreamingUrl:
        typeof f.serverAbrStreamingUrl === 'string'
          ? f.serverAbrStreamingUrl
          : undefined,
      isSabr,
    });
  }
  return { playability, formats };
}

function pickAudioFormat(formats: AudioFormat[]): AudioFormat | null {
  const usable = formats.filter(
    (f) => !f.isSabr && (Boolean(f.url) || Boolean(f.signatureCipher)),
  );
  for (const itag of BEST_QUALITY_ITAG_ORDER) {
    const found = usable.find((f) => f.itag === itag);
    if (found) return found;
  }
  usable.sort((a, b) => b.bitrate - a.bitrate);
  return usable[0] ?? null;
}

export interface Resolver {
  /** Resolve satu lagu lewat urutan fallback; kembalikan URL langsung. */
  resolve(song: CanarySong): Promise<ResolvedSong>;
  /** sts yang dipakai untuk client scripted. */
  sts: number;
  visitorData: string | null;
}

export async function createResolver(): Promise<Resolver> {
  const config = await fetchPlayerConfig();
  const hashes = Object.keys(config.stsByHash);
  if (hashes.length === 0) throw new Error('config tanpa playerHashes');
  // Pakai sts dari hash yang nilainya terbesar (hash terbaru).
  const sts = Math.max(...Object.values(config.stsByHash));
  let visitorData: string | null = null;
  try {
    const vd = await fetchVisitorData(WEB_REMIX);
    visitorData = vd.visitorData;
  } catch {
    // ensureVisitorData tidak pernah melempar (aturan APK): resolve tetap
    // dicoba tanpa visitorData.
    visitorData = null;
  }

  async function fetchPlayer(
    song: CanarySong,
    client: ClientDefinition,
  ): Promise<ResolveAttempt & { picked: AudioFormat | null }> {
    const context = { ...client.context };
    if (visitorData) context.visitorData = visitorData;
    const contentPlaybackContext: Record<string, unknown> = {
      vis: 0,
      splay: false,
      autoCaptionsDefaultOn: false,
      autonavState: 'STATE_OFF',
      html5Preference: 'HTML5_PREF_WANTS',
      lact: [],
    };
    if (client.requiresScript) {
      // sts WAJIB di request player pertama (transfer §3.1): tanpa sts
      // server membalas UNPLAYABLE, bukan LOGIN_REQUIRED.
      contentPlaybackContext.signatureTimestamp = sts;
    }
    const t0 = Date.now();
    const { json } = await postYoutubei(
      '/youtubei/v1/player',
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
    const ms = Date.now() - t0;
    const { playability, formats } = parseAudioFormats(json);
    const picked = pickAudioFormat(formats);
    return {
      client: client.name,
      playability,
      audioFormats: formats.length,
      pickedItag: picked?.itag ?? null,
      pickedDirect: Boolean(picked?.url),
      pickedCipher: Boolean(picked?.signatureCipher),
      ms,
      picked,
    };
  }

  async function resolve(song: CanarySong): Promise<ResolvedSong> {
    const t0 = Date.now();
    const attempts: ResolveAttempt[] = [];
    for (const client of CLIENT_FALLBACK_ORDER) {
      try {
        const attempt = await fetchPlayer(song, client);
        attempts.push(attempt);
        const picked = attempt.picked;
        if (!picked) continue;
        if (!picked.url) {
          // Format cipher: butuh solver S4, bukan kegagalan resolve.
          // Lanjut ke client berikut (VR memberi URL langsung).
          continue;
        }
        if (!isAllowedStreamUrl(picked.url)) continue;
        return {
          song,
          client: client.name,
          itag: picked.itag,
          mimeType: picked.mimeType,
          bitrate: picked.bitrate,
          url: picked.url,
          totalBytes: null,
          resolveMs: Date.now() - t0,
          attempts,
        };
      } catch (e) {
        attempts.push({
          client: client.name,
          playability: 'ERROR',
          audioFormats: 0,
          pickedItag: null,
          pickedDirect: false,
          pickedCipher: false,
          ms: Date.now() - t0,
          error: String(e).slice(0, 160),
        });
      }
    }
    throw new Error(
      `resolve gagal untuk ${song.videoId} (${song.title}): ` +
        attempts.map((a) => `${a.client}=${a.playability}`).join(', '),
    );
  }

  return { resolve, sts, visitorData };
}

/**
 * Resolve cepat hanya lewat ANDROID_VR (URL langsung tanpa solver).
 * Dipakai re-resolve di tengah lagu oleh relay: satu POST player.
 */
export async function resolveViaVr(
  song: CanarySong,
  visitorData: string | null,
): Promise<{ url: string; itag: number; mimeType: string; ms: number }> {
  const context = { ...ANDROID_VR.context };
  if (visitorData) context.visitorData = visitorData;
  const t0 = Date.now();
  const { json } = await postYoutubei(
    '/youtubei/v1/player',
    {
      context: { client: context },
      videoId: song.videoId,
      playbackContext: {
        contentPlaybackContext: {
          vis: 0,
          splay: false,
          autoCaptionsDefaultOn: false,
          autonavState: 'STATE_OFF',
          html5Preference: 'HTML5_PREF_WANTS',
          lact: [],
        },
      },
      racyCheckOk: true,
      contentCheckOk: true,
    },
    ANDROID_VR,
    PLAYER_TIMEOUT_MS,
  );
  const { formats } = parseAudioFormats(json);
  const picked = pickAudioFormat(formats);
  if (!picked?.url || !isAllowedStreamUrl(picked.url)) {
    throw new Error(
      `re-resolve VR gagal untuk ${song.videoId}: ` +
        `format=${formats.length} picked=${picked?.itag ?? 'tidak ada'}`,
    );
  }
  return {
    url: picked.url,
    itag: picked.itag,
    mimeType: picked.mimeType.split(';')[0],
    ms: Date.now() - t0,
  };
}

export { describeStreamUrl };
