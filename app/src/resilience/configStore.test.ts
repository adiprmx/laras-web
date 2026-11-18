import { describe, expect, it, vi } from 'vitest';
import {
  CONFIG_MIN_REFETCH_MS,
  CONFIG_TTL_MS,
  createConfigLoader,
  createMemoryStorage,
} from './configStore';
import { BUILTIN_CLIENTS, BUILTIN_HASHES } from '../spike/config';

const CONFIG_A = {
  clients: [
    { clientId: '67', name: 'WEB_REMIX', version: '1.20261110.04.00' },
    {
      clientId: '14',
      name: 'ANDROID_VR',
      requiresScript: false,
      version: '1.65.10',
    },
  ],
  playerHashes: { b559f50c: { signatureTimestamp: 20770 } },
  version: 1,
};
const CONFIG_B = {
  ...CONFIG_A,
  clients: [
    { clientId: '67', name: 'WEB_REMIX', version: '1.20261118.01.00' },
    {
      clientId: '14',
      name: 'ANDROID_VR',
      requiresScript: false,
      version: '1.65.10',
    },
  ],
};

function fetchOk(config: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(config)));
}

function fetchFail() {
  return vi.fn(async () => {
    throw new Error('jaringan putus');
  });
}

describe('createConfigLoader (TTL 6 jam, K7)', () => {
  it('memakai remote segar dan tidak fetch lagi dalam TTL', async () => {
    const fetchFn = fetchOk(CONFIG_A);
    let nowMs = 1_000_000;
    const loader = createConfigLoader({
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => nowMs,
      storage: createMemoryStorage(),
    });
    const first = await loader.load();
    expect(first.source).toBe('remote');
    expect(first.changed).toBe(true);
    expect(first.config.fromRemote).toBe(true);
    expect(first.primaryClientVersion).toBe('1.20261110.04.00');
    expect(fetchFn).toHaveBeenCalledTimes(1);

    nowMs += CONFIG_TTL_MS - 1000;
    const second = await loader.load();
    expect(second.source).toBe('cached');
    expect(second.stale).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('mengambil config baru sesudah TTL habis (K7, mock waktu)', async () => {
    let current = CONFIG_A;
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify(current)),
    );
    let nowMs = 1_000_000;
    const loader = createConfigLoader({
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => nowMs,
      storage: createMemoryStorage(),
    });
    const first = await loader.load();
    expect(first.primaryClientVersion).toBe('1.20261110.04.00');

    current = CONFIG_B;
    nowMs += CONFIG_TTL_MS + 1;
    const second = await loader.load();
    expect(second.source).toBe('remote');
    expect(second.changed).toBe(true);
    expect(second.primaryClientVersion).toBe('1.20261118.01.00');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('"sudah terbaru" bila isi remote sama (banding isi, bukan waktu)', async () => {
    const fetchFn = fetchOk(CONFIG_A);
    let nowMs = 1_000_000;
    const loader = createConfigLoader({
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => nowMs,
      storage: createMemoryStorage(),
    });
    await loader.load();
    nowMs += CONFIG_TTL_MS + 1;
    const second = await loader.load();
    expect(second.source).toBe('remote');
    expect(second.changed).toBe(false);
  });

  it('fetch gagal sesudah TTL: pakai cache basi (stale) bukan builtin', async () => {
    const fetchFn = fetchOk(CONFIG_A);
    const nowMs = 1_000_000;
    const storage = createMemoryStorage();
    const loader = createConfigLoader({
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => nowMs,
      storage,
    });
    await loader.load();
    // Loader baru (simulasi muat ulang halaman): cache memori
    // kosong, cache tersimpan yang dipakai.
    const failing = fetchFail();
    const loader2 = createConfigLoader({
      fetchFn: failing as unknown as typeof fetch,
      now: () => nowMs + CONFIG_TTL_MS + 1,
      storage,
    });
    const result = await loader2.load();
    expect(result.source).toBe('cached');
    expect(result.stale).toBe(true);
    expect(result.config.fromRemote).toBe(true);
    expect(result.config.stsByHash).toEqual({ b559f50c: 20770 });
  });

  it('fetch gagal tanpa cache apa pun: builtin', async () => {
    const loader = createConfigLoader({
      fetchFn: fetchFail() as unknown as typeof fetch,
      storage: createMemoryStorage(),
    });
    const result = await loader.load();
    expect(result.source).toBe('builtin');
    expect(result.stale).toBe(false);
    expect(result.config.fromRemote).toBe(false);
    expect(result.config.clients).toEqual(BUILTIN_CLIENTS);
    expect(result.config.stsByHash).toEqual(BUILTIN_HASHES);
  });

  it('config rusak (versi tak dikenal): cache basi, bukan mentah', async () => {
    const storage = createMemoryStorage();
    const good = createConfigLoader({
      fetchFn: fetchOk(CONFIG_A) as unknown as typeof fetch,
      now: () => 1_000_000,
      storage,
    });
    await good.load();
    const bad = createConfigLoader({
      fetchFn: fetchOk({ ...CONFIG_A, version: 99 }) as unknown as typeof fetch,
      now: () => 1_000_000 + CONFIG_TTL_MS + 1,
      storage,
    });
    const result = await bad.load();
    expect(result.source).toBe('cached');
    expect(result.stale).toBe(true);
    expect(result.config.fromRemote).toBe(true);
  });

  it('force mem-bypass TTL dan rate limit 5 menit', async () => {
    let current = CONFIG_A;
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify(current)),
    );
    let nowMs = 1_000_000;
    const loader = createConfigLoader({
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => nowMs,
      storage: createMemoryStorage(),
    });
    await loader.load();
    current = CONFIG_B;
    nowMs += 1000;
    const forced = await loader.load({ force: true });
    expect(forced.changed).toBe(true);
    expect(forced.primaryClientVersion).toBe('1.20261118.01.00');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('tanpa force, fetch tidak diulang dalam 5 menit (rate limit)', async () => {
    const fetchFn = fetchOk(CONFIG_A);
    let nowMs = 1_000_000;
    const storage = createMemoryStorage();
    const loader = createConfigLoader({
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => nowMs,
      storage,
    });
    await loader.load();
    // Cache dibuat basi dengan memajukan jam melewati TTL, lalu
    // fetch dibuat gagal: loader jatuh ke cache basi. Load kedua
    // dalam 5 menit tidak boleh fetch lagi.
    const failing = fetchFail();
    nowMs += CONFIG_TTL_MS + 1;
    const loader2 = createConfigLoader({
      fetchFn: failing as unknown as typeof fetch,
      now: () => nowMs,
      storage,
    });
    const first = await loader2.load();
    expect(first.source).toBe('cached');
    expect(failing).toHaveBeenCalledTimes(1);
    nowMs += CONFIG_MIN_REFETCH_MS - 1000;
    const second = await loader2.load();
    expect(second.source).toBe('cached');
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('single-flight: dua load bersamaan hanya satu fetch', async () => {
    const fetchFn = fetchOk(CONFIG_A);
    const loader = createConfigLoader({
      fetchFn: fetchFn as unknown as typeof fetch,
      storage: createMemoryStorage(),
    });
    const [a, b] = await Promise.all([loader.load(), loader.load()]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('lastLoaded mengembalikan hasil load terakhir', async () => {
    const loader = createConfigLoader({
      fetchFn: fetchOk(CONFIG_A) as unknown as typeof fetch,
      storage: createMemoryStorage(),
    });
    expect(loader.lastLoaded()).toBeNull();
    await loader.load();
    expect(loader.lastLoaded()?.source).toBe('remote');
  });

  it('storage rusak tidak memblokir load (degradasi memori)', async () => {
    const broken: { get: () => Promise<never>; set: () => Promise<never> } = {
      get: async () => {
        throw new Error('IndexedDB mati');
      },
      set: async () => {
        throw new Error('IndexedDB mati');
      },
    };
    const loader = createConfigLoader({
      fetchFn: fetchOk(CONFIG_A) as unknown as typeof fetch,
      storage: broken,
    });
    const result = await loader.load();
    expect(result.source).toBe('remote');
    expect(result.config.fromRemote).toBe(true);
  });
});
