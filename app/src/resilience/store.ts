/**
 * Store ketahanan (Zustand): kondisi layanan + config untuk UI.
 *
 * Store HANYA menyimpan state UI; logika berat hidup di
 * configStore.ts (TTL) dan canary.ts (cek latar). Banner status
 * dihitung dari dua sumber: hasil kanari terakhir dan keadaan
 * config (basi = info).
 *
 * Tingkat banner:
 * - none: normal, tanpa banner.
 * - info: config memakai cadangan basi (remote gagal > 6 jam).
 * - warning: kanari degraded (1-2 lagu gagal).
 * - outage: kanari broken (layanan bermasalah).
 */
import { create } from 'zustand';
import { getPlayerService } from '../player/service';
import {
  createAppMetaStorage,
  getConfigLoader,
  CONFIG_CACHE_KEY,
  CONFIG_TTL_MS,
  type ConfigSource,
} from './configStore';
import {
  createCanaryChecker,
  parseCanaryRecord,
  shouldRunCanary,
  CANARY_RECORD_KEY,
  type CanaryRecord,
} from './canary';
import { strings } from '../strings/id';

export type BannerLevel = 'none' | 'info' | 'warning' | 'outage';

export type UpdateStatus = 'idle' | 'checking' | 'done' | 'failed';

export interface ResilienceState {
  canary: CanaryRecord | null;
  configSource: ConfigSource | null;
  configStale: boolean;
  configFetchedAt: number | null;
  bannerLevel: BannerLevel;
  updateStatus: UpdateStatus;
  updateMessage: string | null;
  /** Muat ulang kondisi dari storage + loader (dipanggil saat start). */
  refresh: () => Promise<void>;
  /**
   * Tombol "Periksa pembaruan": paksa ambil config baru lalu
   * jalankan ulang cek kanari (PRD B9.2/B9.8).
   */
  runUpdateCheck: () => Promise<void>;
  /** Cek kanari harian di latar, bila jatuh tempo dan online. */
  runDailyCanaryIfDue: () => Promise<void>;
}

export function computeBannerLevel(input: {
  canaryStatus: CanaryRecord['status'] | null;
  configStale: boolean;
}): BannerLevel {
  if (input.canaryStatus === 'broken') return 'outage';
  if (input.canaryStatus === 'degraded') return 'warning';
  if (input.configStale) return 'info';
  return 'none';
}

async function readPersistedCanary(): Promise<CanaryRecord | null> {
  try {
    const storage = createAppMetaStorage();
    return parseCanaryRecord(await storage.get(CANARY_RECORD_KEY));
  } catch {
    return null;
  }
}

/**
 * Apakah cache config tersimpan sudah basi (> TTL). Dibaca
 * langsung dari storage supaya banner info tampil walau loader
 * belum pernah load di sesi ini.
 */
async function readConfigStale(): Promise<boolean> {
  try {
    const storage = createAppMetaStorage();
    const raw = await storage.get(CONFIG_CACHE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { fetchedAt?: unknown };
    if (typeof parsed.fetchedAt !== 'number') return false;
    return Date.now() - parsed.fetchedAt >= CONFIG_TTL_MS;
  } catch {
    return false;
  }
}

async function runCanaryNow(): Promise<CanaryRecord | null> {
  const resolver = await getPlayerService().getResolver();
  const checker = createCanaryChecker({
    resolveSong: async (videoId: string) => {
      await resolver.resolve(
        { videoId, title: videoId },
        { maxRounds: 1 },
      );
    },
  });
  const outcome = await checker.runCheck();
  return outcome.record;
}

export const useResilienceStore = create<ResilienceState>()((set, get) => ({
  canary: null,
  configSource: null,
  configStale: false,
  configFetchedAt: null,
  bannerLevel: 'none',
  updateStatus: 'idle',
  updateMessage: null,

  async refresh(): Promise<void> {
    const [canary, persistedStale] = await Promise.all([
      readPersistedCanary(),
      readConfigStale(),
    ]);
    const lastLoaded = getConfigLoader().lastLoaded();
    const configStale = Boolean(lastLoaded?.stale) || persistedStale;
    set({
      canary,
      configSource: lastLoaded?.source ?? null,
      configStale,
      configFetchedAt: lastLoaded?.fetchedAt ?? null,
      bannerLevel: computeBannerLevel({
        canaryStatus: canary?.status ?? null,
        configStale,
      }),
    });
  },

  async runUpdateCheck(): Promise<void> {
    if (get().updateStatus === 'checking') return;
    set({ updateStatus: 'checking', updateMessage: null });
    try {
      const loaded = await getConfigLoader().load({ force: true });
      // Refresh config lalu cek kanari ulang (PRD B9.2): tombol
      // ini menutup loop "config baru, layanan pulih?".
      let canary = get().canary;
      try {
        const record = await runCanaryNow();
        if (record) canary = record;
      } catch {
        // Kanari gagal jalan (mis. offline): hasil config tetap
        // dilaporkan; kanari dicoba lagi di jadwal harian.
      }
      if (loaded.source === 'builtin' || loaded.stale) {
        set({
          updateStatus: 'failed',
          updateMessage: strings.updateFailed,
          canary,
        });
      } else if (loaded.changed) {
        set({
          updateStatus: 'done',
          updateMessage: strings.updateUpdated,
          canary,
        });
      } else {
        set({
          updateStatus: 'done',
          updateMessage: strings.updateUpToDate,
          canary,
        });
      }
    } catch {
      set({
        updateStatus: 'failed',
        updateMessage: strings.updateFailed,
      });
    }
    await get().refresh();
  },

  async runDailyCanaryIfDue(): Promise<void> {
    try {
      if (!navigator.onLine) return;
      const canary = await readPersistedCanary();
      if (!shouldRunCanary(canary?.checkedAt ?? null, Date.now())) return;
      const record = await runCanaryNow();
      if (record) {
        set({
          canary: record,
          bannerLevel: computeBannerLevel({
            canaryStatus: record.status,
            configStale: get().configStale,
          }),
        });
      }
    } catch {
      // Cek latar gagal diam-diam: tidak pernah mengganggu pengguna.
    }
  },
}));
