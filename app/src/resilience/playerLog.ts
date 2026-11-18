/**
 * Log pemutar ringkas (maks 10 baris) untuk snapshot diagnostik.
 *
 * Hanya baris aman yang disimpan: tanpa URL stream, tanpa videoId,
 * tanpa data pribadi. Sebagai pertahanan lapis kedua, apa pun yang
 * mirip URL http(s) disamarkan sebelum disimpan, seandainya
 * pemanggil lalai.
 *
 * Log hidup di memori selama sesi berjalan. Saat kegagalan
 * terjadi, pemanggil memanggil persistPlayerLog() (best-effort,
 * tidak pernah melempar) agar log bertahan melewati reload
 * halaman — pengguna yang membuka Pengaturan sesudah reload
 * tetap melihat catatan kegagalan. Tanpa persist, muat ulang
 * halaman mengosongkan log (ditemukan E2E P6: seed lalu goto
 * ke /settings menampilkan "Belum ada catatan").
 */
import {
  createAppMetaStorage,
  type KeyValueStorage,
} from './configStore';

export const PLAYER_LOG_MAX_LINES = 10;

/** Kunci log pemutar di app_meta. */
export const PLAYER_LOG_KEY = 'p6.playerLog';

const lines: string[] = [];

function sanitize(line: string): string {
  return line.replace(/https?:\/\/\S+/g, '[url]');
}

function timestamp(): string {
  const now = new Date();
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`;
}

/** Tambah satu baris log (baris lama terbuang bila sudah 10). */
export function logPlayer(line: string): void {
  lines.push(`${timestamp()} ${sanitize(line)}`);
  while (lines.length > PLAYER_LOG_MAX_LINES) lines.shift();
}

/** Salinan 10 baris terakhir (terlama dulu). */
export function getPlayerLog(): string[] {
  return [...lines];
}

/** Kosongkan log memori saja (tes). Persisted log tidak ikut hapus. */
export function clearPlayerLog(): void {
  lines.length = 0;
}

let defaultStorage: KeyValueStorage | null = null;

function getDefaultStorage(): KeyValueStorage {
  if (!defaultStorage) defaultStorage = createAppMetaStorage();
  return defaultStorage;
}

/**
 * Rantai tulis per storage: dua persist berurutan tidak boleh
 * saling menyalip (tulis lama yang commit belakangan akan
 * menimpa tulis baru dengan isi basi). Rantai dipisah per
 * storage agar storage tes tidak terblokir storage produksi.
 */
const persistChains = new WeakMap<KeyValueStorage, Promise<void>>();

/**
 * Simpan 10 baris terakhir ke storage. Best-effort: tidak
 * pernah melempar (IndexedDB mati = log tetap hidup di memori).
 */
export function persistPlayerLog(
  storage: KeyValueStorage = getDefaultStorage(),
): Promise<void> {
  const text = JSON.stringify(lines);
  const prev = persistChains.get(storage) ?? Promise.resolve();
  const run = prev
    .then(() => storage.set(PLAYER_LOG_KEY, text))
    .catch(() => undefined);
  persistChains.set(storage, run);
  return run;
}

/**
 * Muat log yang tersimpan. Rusak / hilang / bukan array
 * string = array kosong (bukan galat).
 */
export async function loadPersistedPlayerLog(
  storage: KeyValueStorage = getDefaultStorage(),
): Promise<string[]> {
  try {
    const raw = await storage.get(PLAYER_LOG_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((line): line is string => typeof line === 'string')
      .slice(-PLAYER_LOG_MAX_LINES);
  } catch {
    return [];
  }
}
