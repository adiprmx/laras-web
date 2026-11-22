/**
 * Failover egress resolve (Cloudflare -> Render -> Invidious).
 *
 * LAPISAN RENDER (KERANGKA, BELUM DIAKTIFKAN, TETAP MATI):
 * layanan Render dibuat 19 Nov 2026 dan DITOLAK oleh probe
 * (0/18 sel OK lintas siklus 3+4; lihat docs/render-egress.md).
 * `postInnertubeWithFailover` tetap ada sebagai kerangka draft
 * dan TIDAK diimpor oleh resolve.ts; saklar RENDER_FAILOVER_ENABLED
 * tetap false. Jangan aktifkan: failover ke egress yang terbukti
 * ditolak hanya menambah latensi tanpa nilai.
 *
 * LAPISAN INVIDIOUS (AKTIF sebagai cadangan TERAKHIR):
 * instance Invidious publik yt.chocolatemoo53.com terverifikasi
 * BERSIH oleh re-probe Koordinator #9 (20 Nov 2026 01:22-01:24
 * WIB): 3/3 OK_AUDIO dengan braket kontrol CF sebelum+sesudah
 * sama-sama ditolak; URL audio terverifikasi mengalir
 * (Range -> 206); CORS terbuka (ACAO *). Alasan cadangan
 * terakhir (bukan utama): instance tunggal tak dikenal,
 * ekosistem Invidious publik tipis, operator tidak dikenal,
 * respons lambat (6-23 detik) dan kemungkinan dari cache.
 * Urutan resolve penuh: proxy CF -> cache D1 -> Invidious ->
 * fallback IFrame. Wiring lewat injeksi `cacheLookup` di
 * StreamResolver (service.ts), TANPA mengubah resolve.ts:
 * `fetchCachedStreamWithInvidiousFallback` mencoba cache D1
 * dulu, Invidious hanya bila cache kosong. Matikan saklar
 * INVIDIOUS_FAILOVER_ENABLED bila instance mati atau re-probe
 * berkala gagal.
 */
import {
  INNERTUBE_MAX_BYTES,
  PROXY_BASE_URL,
  type ClientDefinition,
} from '../spike/config';
import {
  InnertubeError,
  type InnertubeErrorKind,
} from '../extractor/innertube';
import { readCappedText, ResponseTooBigError } from '../extractor/readCapped';
import {
  fetchCachedStream,
  type CachedStream,
} from '../extractor/resolveCache';
import { fetchInvidiousStream } from '../extractor/invidious';
import { isRefusalPlayability } from './retry';

/**
 * URL dasar proxy Render (egress ketiga). Layanan SUDAH dibuat
 * (19 Nov 2026) tapi DITOLAK: probe 0 OK / 18 ditolak YouTube.
 * Tetap live $0 untuk uji ulang; JANGAN aktifkan failover
 * (RENDER_FAILOVER_ENABLED = false) tanpa vonis BERSIH baru.
 */
export const RENDER_PROXY_BASE_URL = 'https://laras-proxy-render.onrender.com';

/**
 * Saklar failover. FALSE sampai vonis BERSIH + wiring koordinator.
 * Per-panggilan bisa di-override lewat opts (dipakai tes).
 */
export const RENDER_FAILOVER_ENABLED = false;

/**
 * Saklar failover Invidious. TRUE sesudah vonis BERSIH re-probe
 * Koordinator #9 (20 Nov 2026 01:22-01:24 WIB, 3/3 OK_AUDIO,
 * braket CF bersih). Matikan bila instance mati atau re-probe
 * berkala gagal — resolve kembali ke cache D1 saja.
 * Per-panggilan bisa di-override lewat opts (dipakai tes).
 */
export const INVIDIOUS_FAILOVER_ENABLED = true;

/**
 * Lookup gabungan cache D1 + Invidious untuk StreamResolver.
 *
 * Dipakai service.ts sebagai `cacheLookup` (resolve.ts tidak
 * diubah): sesudah semua putaran resolve langsung gagal,
 * StreamResolver memanggil lookup ini; cache D1 dicoba dulu,
 * Invidious hanya bila cache kosong. Bila keduanya kosong,
 * resolve melempar seperti biasa dan service masuk fallback
 * IFrame. Kedua lookup tidak pernah melempar (null = kosong),
 * dan tryCache di resolve.ts juga membungkus lookup ini dengan
 * try/catch — kegagalan di sini tidak menutupi penyebab asli.
 */
export async function fetchCachedStreamWithInvidiousFallback(
  videoId: string,
  opts: {
    enabled?: boolean;
    cacheLookup?: (videoId: string) => Promise<CachedStream | null>;
    invidiousLookup?: (videoId: string) => Promise<CachedStream | null>;
  } = {},
): Promise<CachedStream | null> {
  const cacheLookup = opts.cacheLookup ?? fetchCachedStream;
  const cached = await cacheLookup(videoId);
  if (cached) return cached;
  const enabled = opts.enabled ?? INVIDIOUS_FAILOVER_ENABLED;
  if (!enabled) return null;
  const invidiousLookup = opts.invidiousLookup ?? fetchInvidiousStream;
  return invidiousLookup(videoId);
}

export type ProxyEgress = 'cloudflare' | 'render';

export interface FailoverResult {
  status: number;
  json: Record<string, unknown>;
  /** Egress yang hasil akhirnya berasal darinya. */
  egress: ProxyEgress;
  /** Egress yang dicoba, sesuai urutan. */
  tried: ProxyEgress[];
}

/**
 * POST JSON ke satu endpoint proxy di base URL tertentu.
 * Cermin persis postInnertube (extractor/innertube.ts), ditambah
 * parameter baseUrl supaya satu fungsi melayani kedua egress.
 * Galat jaringan lolos apa adanya; galat balasan dibungkus
 * InnertubeError dengan kind yang sama.
 */
async function postToProxy(
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
  client: ClientDefinition,
  timeoutMs: number,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-YouTube-Client-Name': client.clientId,
      'X-YouTube-Client-Version': client.version,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let text: string;
  try {
    text = await readCappedText(res, INNERTUBE_MAX_BYTES);
  } catch (error) {
    if (error instanceof ResponseTooBigError) {
      throw new InnertubeError(
        'too-big',
        res.status,
        `proxy ${path} membalas melewati cap 10 MB (HTTP ${res.status})`,
      );
    }
    throw error;
  }
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new InnertubeError(
      'bad-json',
      res.status,
      `proxy ${path} membalas bukan JSON (HTTP ${res.status})`,
    );
  }
  if (!res.ok) {
    const code = (json.error as { code?: string } | undefined)?.code ?? null;
    const kind: InnertubeErrorKind =
      code === 'RATE_LIMITED' || res.status === 429
        ? 'rate-limited'
        : 'http';
    throw new InnertubeError(
      kind,
      res.status,
      `proxy ${path} HTTP ${res.status} (${code ?? 'tanpa kode'})`,
      code,
    );
  }
  return { status: res.status, json };
}

/** Benar bila respons player ini adalah penolakan YouTube. */
function isPlayerRefusal(path: string, json: Record<string, unknown>): boolean {
  if (path !== '/api/innertube/player') return false;
  const status = json.playabilityStatus as { status?: unknown } | undefined;
  return (
    typeof status?.status === 'string' &&
    isRefusalPlayability(status.status)
  );
}

/**
 * POST ke proxy dengan failover CF -> Render.
 *
 * Tanpa failover (default): perilaku identik dengan postInnertube,
 * ditambah field egress/tried. Dengan failover aktif: CF dicoba
 * dulu; bila CF melempar atau player ditolak, Render dicoba sekali
 * dan hasilnya dikembalikan apa adanya. Bila Render ikut melempar,
 * galat Render yang lolos ke pemanggil.
 */
export async function postInnertubeWithFailover(
  path: string,
  body: Record<string, unknown>,
  client: ClientDefinition,
  timeoutMs: number,
  opts: { enabled?: boolean } = {},
): Promise<FailoverResult> {
  const enabled = opts.enabled ?? RENDER_FAILOVER_ENABLED;
  let cfResult: { status: number; json: Record<string, unknown> };
  try {
    cfResult = await postToProxy(PROXY_BASE_URL, path, body, client, timeoutMs);
  } catch (error) {
    if (!enabled) throw error;
    const render = await postToProxy(
      RENDER_PROXY_BASE_URL,
      path,
      body,
      client,
      timeoutMs,
    );
    return { ...render, egress: 'render', tried: ['cloudflare', 'render'] };
  }
  if (!enabled || !isPlayerRefusal(path, cfResult.json)) {
    return { ...cfResult, egress: 'cloudflare', tried: ['cloudflare'] };
  }
  const render = await postToProxy(
    RENDER_PROXY_BASE_URL,
    path,
    body,
    client,
    timeoutMs,
  );
  return { ...render, egress: 'render', tried: ['cloudflare', 'render'] };
}
