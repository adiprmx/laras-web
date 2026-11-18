/**
 * Client HTTP bersama untuk endpoint InnerTube lewat proxy byte-only.
 *
 * Satu-satunya tempat request POST ke proxy ditulis: resolve (P1/P2),
 * pencarian, dan browse (P4) semuanya lewat `postInnertube` ini.
 * URL proxy tetap satu konstanta di `spike/config.ts` (PROXY_BASE_URL)
 * — modul ini tidak menulis URL proxy kedua.
 *
 * Galat jaringan (termasuk timeout AbortError) dibiarkan lolos apa
 * adanya supaya pemanggil bisa membedakan "jaringan putus" dari
 * "server membalas tidak wajar". Galat balasan dibungkus
 * `InnertubeError` dengan `kind` yang bisa dipetakan ke pesan
 * pengguna (PRD B6.5: bedakan galat jaringan, HTTP, dan parse).
 */
import {
  INNERTUBE_MAX_BYTES,
  PROXY_BASE_URL,
  type ClientDefinition,
} from '../spike/config';
import { readCappedText, ResponseTooBigError } from './readCapped';

/** Jenis galat balasan proxy/InnerTube. */
export type InnertubeErrorKind =
  | 'bad-json'
  | 'http'
  | 'rate-limited'
  | 'too-big';

/** Galat balasan dari proxy (bukan galat jaringan). */
export class InnertubeError extends Error {
  readonly kind: InnertubeErrorKind;
  readonly status: number;
  /** Kode galat dari proxy (`error.code`), bila ada. */
  readonly code: string | null;

  constructor(
    kind: InnertubeErrorKind,
    status: number,
    message: string,
    code: string | null = null,
  ) {
    super(message);
    this.name = 'InnertubeError';
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

/**
 * POST JSON ke satu endpoint proxy InnerTube.
 *
 * Mengembalikan `{ status, json }`. Melempar `InnertubeError` bila
 * balasan bukan JSON atau status HTTP tidak ok. Galat jaringan
 * (termasuk timeout) lolos apa adanya.
 */
export async function postInnertube(
  path: string,
  body: Record<string, unknown>,
  client: ClientDefinition,
  timeoutMs: number,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${PROXY_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-YouTube-Client-Name': client.clientId,
      'X-YouTube-Client-Version': client.version,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  // Cap 10 MB ditegakkan SELAMA membaca stream (Red 1 R5):
  // pertahanan lapis kedua di atas cap proxy yang sama.
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
    if (code === 'RATE_LIMITED' || res.status === 429) {
      throw new InnertubeError(
        'rate-limited',
        res.status,
        `proxy ${path} HTTP ${res.status} (RATE_LIMITED)`,
        'RATE_LIMITED',
      );
    }
    throw new InnertubeError(
      'http',
      res.status,
      `proxy ${path} HTTP ${res.status} (${code ?? 'tanpa kode'})`,
      code,
    );
  }
  return { status: res.status, json };
}
