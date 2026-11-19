/**
 * Store pengaturan equalizer (Zustand, P7).
 *
 * Store HANYA menyimpan state + persistensi IndexedDB (app_meta
 * `eq-settings`); penerapan ke graph Web Audio adalah tugas
 * PlayerService, yang membaca store ini. Pola yang sama dengan
 * store pemutar: state di sini, logika di service.
 */
import { create } from 'zustand';
import { getLibraryService } from '../data/library';
import {
  clampGain,
  DEFAULT_EQ_SETTINGS,
  EQ_PRESET_GAINS,
  normalizeEqSettings,
  presetForGains,
  type EqPresetName,
  type EqSettings,
} from '../player/equalizer';

export const EQ_SETTINGS_KEY = 'eq-settings';

interface EqualizerState {
  settings: EqSettings;
  loaded: boolean;
  /** Muat pengaturan tersimpan (sekali, dari PlayerService.init). */
  load: () => Promise<void>;
  /** Terapkan preset (gain ikut berubah) + simpan. */
  setPreset: (preset: Exclude<EqPresetName, 'custom'>) => Promise<void>;
  /** Ubah satu band (preset menjadi 'custom' bila tidak cocok) + simpan. */
  setBand: (index: number, db: number) => Promise<void>;
  /** Kembali ke rata + simpan. */
  reset: () => Promise<void>;
  /** Tulis state langsung (dipakai sinkronisasi P7, tanpa simpan ganda). */
  setSettingsState: (settings: EqSettings) => void;
}

async function persist(settings: EqSettings): Promise<void> {
  try {
    const library = await getLibraryService();
    await library.setMeta(EQ_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Gagal simpan tidak merusak pemutaran; pengaturan tetap
    // berlaku di sesi ini.
  }
  // Penanda sinkronisasi P7: EQ berubah di perangkat ini.
  // Import dinamis supaya store tidak bergantung statis ke
  // modul sync (menghindari siklus import).
  void import('../sync/settingsMarkers')
    .then((m) => m.markSettingsChanged())
    .catch(() => {
      // Penanda gagal dicatat: pengaturan mungkin tidak terdorong
      // di sinkronisasi berikut; bukan galat fatal.
    });
}

export const useEqualizerStore = create<EqualizerState>()((set, get) => ({
  settings: {
    ...DEFAULT_EQ_SETTINGS,
    gains: [...DEFAULT_EQ_SETTINGS.gains],
  },
  loaded: false,

  load: async () => {
    if (get().loaded) return;
    try {
      const library = await getLibraryService();
      const raw = await library.getMeta(EQ_SETTINGS_KEY);
      if (raw !== null) {
        set({ settings: normalizeEqSettings(JSON.parse(raw)) });
      }
    } catch {
      // JSON rusak atau IndexedDB tidak tersedia: pakai default.
    }
    set({ loaded: true });
  },

  setPreset: async (preset) => {
    const settings: EqSettings = {
      preset,
      gains: [...EQ_PRESET_GAINS[preset]],
    };
    set({ settings });
    await persist(settings);
  },

  setBand: async (index, db) => {
    const current = get().settings;
    if (index < 0 || index >= current.gains.length) return;
    const gains = [...current.gains];
    gains[index] = clampGain(db);
    const settings: EqSettings = { preset: presetForGains(gains), gains };
    set({ settings });
    await persist(settings);
  },

  reset: async () => {
    const settings: EqSettings = {
      ...DEFAULT_EQ_SETTINGS,
      gains: [...DEFAULT_EQ_SETTINGS.gains],
    };
    set({ settings });
    await persist(settings);
  },

  setSettingsState: (settings) => set({ settings }),
}));
