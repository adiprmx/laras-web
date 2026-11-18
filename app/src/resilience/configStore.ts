/**
 * Config remote dengan TTL 6 jam (P6, K7, PRD B9.1-B9.2).
 *
 * Rantai fallback: config remote segar -> cache terakhir yang
 * valid (walau basi, ditandai stale) -> nilai bawaan di kode.
 * Skema + cap 4 MB SUDAH ditegakkan di lapisan bawah
 * (parsePlayerConfig + fetchRemoteConfigText); modul ini tidak
 * menduplikasinya.
 *
 * Deteksi perubahan membandingkan ISI teks (arsitektur §4.2):
 * membandingkan fetchedAt adalah bug P6 APK (refresh selalu
 * menulis fetchedAt baru sehingga "sudah terbaru" tidak pernah
 * tercapai).
 *
 * Penyimpanan cache: IndexedDB app_meta (best-effort) + cache
 * memori. Bila IndexedDB tidak tersedia (mode privat), loader
 * tetap jalan dengan memori saja.
 */
import { openDatabase } from '../data/database';
import { fetchRemoteConfigText } from '../extractor/fetchConfig';
import {
  parsePlayerConfig,
  playerConfigFromParsed,
  type PlayerConfig,
} from '../extractor/resolve';
import {
  BUILTIN_CLIENTS,
  BUILTIN_HASHES,
} from '../spike/config';

/** TTL refresh normal config: 6 jam (K7). */
export const CONFIG_TTL_MS = 6 * 60 * 60 * 1000;
/** Jeda minimum antar fetch remote, kecuali dipaksa (PRD B9.2). */
export const CONFIG_MIN_REFETCH_MS = 5 * 60 * 1000;
/** Kunci cache config di app_meta. */
export const CONFIG_CACHE_KEY = 'p6.config';

export type ConfigSource = 'remote' | 'cached' | 'builtin';

export interface LoadedConfig {
  config: PlayerConfig;
  source: ConfigSource;
  /**
   * True bila config yang dipakai sudah melewati TTL (cadangan
   * basi karena fetch remote gagal). Builtin bukan stale.
   */
  stale: boolean;
  /** True bila fetch remote kali ini membawa isi berbeda. */
  changed: boolean;
  /** Kapan config ini diambil (null untuk builtin). */
  fetchedAt: number | null;
  /** Versi client utama (untuk diagnostik LRS1). */
  primaryClientVersion: string | null;
}

export interface KeyValueStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

/** Storage app_meta IndexedDB (melempar bila DB tidak bisa dibuka). */
export function createAppMetaStorage(): KeyValueStorage {
  return {
    async get(key: string): Promise<string | null> {
      const db = await openDatabase();
      const row = await db.app_meta.get(key);
      return row?.value ?? null;
    },
    async set(key: string, value: string): Promise<void> {
      const db = await openDatabase();
      await db.app_meta.put({ key, value });
    },
  };
}

/** Storage memori (tes + cadangan bila IndexedDB mati). */
export function createMemoryStorage(
  initial: Record<string, string> = {},
): KeyValueStorage {
  const map = new Map(Object.entries(initial));
  return {
    get: async (key: string) => map.get(key) ?? null,
    set: async (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

export interface ConfigLoaderDeps {
  fetchFn?: typeof fetch;
  /** Jam (milidetik); diinjeksi di tes untuk mock waktu. */
  now?: () => number;
  storage?: KeyValueStorage;
}

interface CachedConfig {
  text: string;
  fetchedAt: number;
}

function parseCached(raw: string | null): CachedConfig | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CachedConfig>;
    if (
      typeof parsed.text !== 'string' ||
      typeof parsed.fetchedAt !== 'number'
    ) {
      return null;
    }
    return { text: parsed.text, fetchedAt: parsed.fetchedAt };
  } catch {
    return null;
  }
}

function builtinConfig(): PlayerConfig {
  return {
    stsByHash: BUILTIN_HASHES,
    clients: BUILTIN_CLIENTS,
    fromRemote: false,
  };
}

function primaryVersion(config: PlayerConfig): string | null {
  return config.clients[0]?.version ?? null;
}

export interface ConfigLoader {
  load(opts?: { force?: boolean }): Promise<LoadedConfig>;
  /** Hasil load terakhir (null bila belum pernah load). */
  lastLoaded(): LoadedConfig | null;
}

export function createConfigLoader(deps: ConfigLoaderDeps = {}): ConfigLoader {
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? Date.now;
  const storage = deps.storage ?? createAppMetaStorage();
  let memory: CachedConfig | null = null;
  let lastFetchAttemptAt = 0;
  let last: LoadedConfig | null = null;
  let inFlight: Promise<LoadedConfig> | null = null;

  async function readPersisted(): Promise<CachedConfig | null> {
    try {
      return parseCached(await storage.get(CONFIG_CACHE_KEY));
    } catch {
      return null;
    }
  }

  async function writePersisted(cached: CachedConfig): Promise<void> {
    try {
      await storage.set(CONFIG_CACHE_KEY, JSON.stringify(cached));
    } catch {
      // Cache gagal ditulis: memori tetap jalan; fetch berikut
      // mengunduh ulang. Tidak pernah memblokir pemutaran.
    }
  }

  function toLoaded(
    parsed: ReturnType<typeof parsePlayerConfig>,
    source: ConfigSource,
    stale: boolean,
    changed: boolean,
    fetchedAt: number | null,
  ): LoadedConfig {
    // Cache berasal dari remote (bukan builtin), jadi fromRemote
    // true untuk 'remote' maupun 'cached': segmen CFG kode LRS1
    // harus membaca R..., bukan B, untuk config cache.
    const config = parsed
      ? playerConfigFromParsed(parsed, source !== 'builtin')
      : builtinConfig();
    return {
      config,
      source,
      stale,
      changed,
      fetchedAt,
      primaryClientVersion: primaryVersion(config),
    };
  }

  async function loadFresh(opts: { force?: boolean }): Promise<LoadedConfig> {
    const at = now();
    // Cache memori segar: pakai tanpa fetch (kecuali dipaksa).
    if (
      !opts.force &&
      memory &&
      at - memory.fetchedAt < CONFIG_TTL_MS
    ) {
      const parsed = parsePlayerConfig(JSON.parse(memory.text) as unknown);
      last = toLoaded(parsed, 'cached', false, false, memory.fetchedAt);
      return last;
    }
    const persisted = await readPersisted();
    const persistedParsed = persisted
      ? parsePlayerConfig(JSON.parse(persisted.text) as unknown)
      : null;
    // Cache tersimpan segar: pakai tanpa fetch (kecuali dipaksa).
    if (
      !opts.force &&
      persisted &&
      persistedParsed &&
      at - persisted.fetchedAt < CONFIG_TTL_MS
    ) {
      memory = persisted;
      last = toLoaded(
        persistedParsed,
        'cached',
        false,
        false,
        persisted.fetchedAt,
      );
      return last;
    }
    // Rate limit 5 menit antar fetch (kecuali dipaksa): pakai
    // cadangan terbaik yang ada daripada menembak lagi.
    if (
      !opts.force &&
      lastFetchAttemptAt > 0 &&
      at - lastFetchAttemptAt < CONFIG_MIN_REFETCH_MS
    ) {
      const fallback = persistedParsed
        ? toLoaded(
            persistedParsed,
            'cached',
            true,
            false,
            persisted!.fetchedAt,
          )
        : toLoaded(null, 'builtin', false, false, null);
      last = fallback;
      return last;
    }
    lastFetchAttemptAt = at;
    let text: string;
    try {
      text = await fetchRemoteConfigText(fetchFn);
    } catch {
      // Fetch gagal: cache terakhir yang valid (walau basi), lalu
      // builtin. Cadangan basi ditandai stale untuk banner info.
      if (persisted && persistedParsed) {
        memory = persisted;
        last = toLoaded(
          persistedParsed,
          'cached',
          true,
          false,
          persisted.fetchedAt,
        );
        return last;
      }
      last = toLoaded(null, 'builtin', false, false, null);
      return last;
    }
    let parsed: ReturnType<typeof parsePlayerConfig>;
    try {
      parsed = parsePlayerConfig(JSON.parse(text) as unknown);
    } catch {
      parsed = null;
    }
    if (!parsed) {
      // Config rusak/tidak dikenal: perlakukan seperti fetch
      // gagal (cache lalu builtin), jangan pernah pakai mentah.
      if (persisted && persistedParsed) {
        memory = persisted;
        last = toLoaded(
          persistedParsed,
          'cached',
          true,
          false,
          persisted.fetchedAt,
        );
        return last;
      }
      last = toLoaded(null, 'builtin', false, false, null);
      return last;
    }
    // Deteksi perubahan dari ISI, bukan fetchedAt (arsitektur
    // §4.2): isi sama dengan cache berarti "sudah terbaru".
    const previousText = persisted?.text ?? memory?.text ?? null;
    const changed = previousText !== text;
    const cached: CachedConfig = { text, fetchedAt: at };
    memory = cached;
    await writePersisted(cached);
    last = toLoaded(parsed, 'remote', false, changed, at);
    return last;
  }

  return {
    load(opts: { force?: boolean } = {}): Promise<LoadedConfig> {
      // Single-flight: dua load bersamaan berbagi satu fetch.
      if (!inFlight) {
        inFlight = loadFresh(opts).finally(() => {
          inFlight = null;
        });
      }
      return inFlight;
    },
    lastLoaded(): LoadedConfig | null {
      return last;
    },
  };
}

let sharedLoader: ConfigLoader | null = null;

/** Loader config bersama app (satu instance per halaman). */
export function getConfigLoader(): ConfigLoader {
  if (!sharedLoader) sharedLoader = createConfigLoader();
  return sharedLoader;
}
