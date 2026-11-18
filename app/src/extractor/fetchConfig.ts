/**
 * Fetch mentah config remote (teks JSON, belum di-parse).
 *
 * Satu-satunya tempat fetch config ditulis: dipakai
 * `loadPlayerConfig` (resolve.ts) dan loader TTL P6
 * (resilience/configStore.ts, yang butuh teks mentah untuk
 * sidik jari perubahan). Melempar pada kegagalan apa pun;
 * pemanggil yang memutuskan fallback-nya.
 *
 * Cap 4 MB ditegakkan SELAMA membaca stream (Red 1 S4).
 */
import {
  CONFIG_MAX_BYTES,
  CONFIG_TIMEOUT_MS,
  CONFIG_URL,
} from '../spike/config';
import { readCappedText } from './readCapped';

export async function fetchRemoteConfigText(
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchFn(CONFIG_URL, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`config HTTP ${res.status}`);
  return readCappedText(res, CONFIG_MAX_BYTES);
}
