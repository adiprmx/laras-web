/**
 * Failover proxy Cloudflare -> Render (KERANGKA, BELUM DIAKTIFKAN).
 *
 * Status 19 Nov 2026: DRAFT. Layanan Render BELUM DIBUAT (API key
 * Render belum ada; lihat docs/render-egress.md). Modul ini TIDAK
 * diimpor oleh resolve.ts, innertube.ts, atau modul lain. Hanya
 * koordinator yang wiring sesudah vonis BERSIH dari probe live
 * (OK + format audio pada min 2 sel independen SAAT CF ditolak).
 * Jangan aktifkan sebelum itu: failover ke egress yang belum
 * terbukti hanya menambah latensi tanpa nilai.
 *
 * Perilaku bila diaktifkan (wiring mengganti pemanggilan
 * postInnertube di postViaProxy dengan postInnertubeWithFailover):
 * coba Cloudflare dulu; bila CF melempar (jaringan/proxy) atau
 * /api/innertube/player mengembalikan playability penolakan
 * (LOGIN_REQUIRED/UNPLAYABLE), coba Render sekali. Hasil Render
 * dikembalikan apa adanya (termasuk bila ikut menolak) supaya
 * pemanggil tetap melihat playability sebenarnya. Jalur selain
 * player (search/browse/next) hanya failover saat CF melempar,
 * karena responsnya tidak membawa playability.
 *
 * Catatan tidur Render: layanan gratis tidur sesudah 15 menit
 * idle dan bangun sekitar 1 menit. Percobaan Render pertama
 * sesudah tidur bisa melewati timeout pemanggil; keep-alive ping
 * tiap 10 menit ke /healthz (di luar modul ini) yang menjaga
 * layanan tetap bangun. Modul ini TIDAK melakukan warm-up
 * sendiri: satu percobaan failover yang gagal karena tidur
 * dicatat sebagai galat jaringan biasa.
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
import { isRefusalPlayability } from './retry';

/** URL dasar proxy Render (egress ketiga). Layanan belum dibuat. */
export const RENDER_PROXY_BASE_URL = 'https://laras-proxy-render.onrender.com';

/**
 * Saklar failover. FALSE sampai vonis BERSIH + wiring koordinator.
 * Per-panggilan bisa di-override lewat opts (dipakai tes).
 */
export const RENDER_FAILOVER_ENABLED = false;

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
