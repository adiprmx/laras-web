/**
 * Equalizer 10 band (P7): frekuensi, preset, validasi pengaturan.
 *
 * Frekuensi tengah standar ISO 31 Hz sampai 16 kHz (port
 * spesifikasi mpv_audio_kit APK, arsitektur §3.4). Rentang gain
 * plus minus 12 dB. Pengaturan tersimpan di IndexedDB (app_meta
 * `eq-settings`) lewat store equalizer.
 *
 * Fungsi murni: tanpa AudioContext, tanpa IndexedDB, mudah dites.
 * Graph Web Audio-nya ada di audioGraph.ts; EQ hanya aktif di
 * jalur graph (lokal/cache), tidak pernah untuk stream (S5).
 */

export const EQ_FREQUENCIES = [
  31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000,
] as const;

export const EQ_BAND_COUNT = 10;
export const EQ_MIN_DB = -12;
export const EQ_MAX_DB = 12;
/** Q filter peaking (lebar sedang, satu oktaf kira-kira). */
export const EQ_FILTER_Q = 1;

export type EqPresetName =
  | 'flat'
  | 'bass'
  | 'vocal'
  | 'acoustic'
  | 'custom';

export const EQ_PRESET_NAMES: Array<Exclude<EqPresetName, 'custom'>> = [
  'flat',
  'bass',
  'vocal',
  'acoustic',
];

export const EQ_PRESET_GAINS: Record<
  Exclude<EqPresetName, 'custom'>,
  readonly number[]
> = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  bass: [6, 5, 3, 1, 0, 0, 0, 0, -1, -2],
  vocal: [-2, -1, 0, 1, 2, 3, 3, 2, 1, 0],
  acoustic: [2, 1, 0, 0, 1, 2, 2, 3, 2, 1],
};

export interface EqSettings {
  preset: EqPresetName;
  gains: number[];
}

export const DEFAULT_EQ_SETTINGS: EqSettings = {
  preset: 'flat',
  gains: [...EQ_PRESET_GAINS.flat],
};

/** Batasi satu nilai gain ke rentang plus minus 12 dB. */
export function clampGain(db: number): number {
  if (!Number.isFinite(db)) return 0;
  return Math.min(EQ_MAX_DB, Math.max(EQ_MIN_DB, db));
}

/** Apakah dua daftar gain sama persis (toleransi 0,01 dB). */
export function gainsEqual(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => Math.abs(v - b[i]) < 0.01);
}

/** Nama preset yang cocok dengan gain ini, atau 'custom'. */
export function presetForGains(gains: readonly number[]): EqPresetName {
  for (const name of EQ_PRESET_NAMES) {
    if (gainsEqual(gains, EQ_PRESET_GAINS[name])) return name;
  }
  return 'custom';
}

/**
 * Validasi pengaturan dari JSON tersimpan (bisa rusak/asing):
 * gain bukan angka dibuang ke 0, panjang salah diisi default,
 * preset asing menjadi 'custom' (atau preset yang cocok).
 */
export function normalizeEqSettings(input: unknown): EqSettings {
  if (typeof input !== 'object' || input === null) {
    return { ...DEFAULT_EQ_SETTINGS, gains: [...DEFAULT_EQ_SETTINGS.gains] };
  }
  const raw = input as { preset?: unknown; gains?: unknown };
  let gains: number[];
  if (Array.isArray(raw.gains) && raw.gains.length === EQ_BAND_COUNT) {
    gains = raw.gains.map((g) =>
      typeof g === 'number' ? clampGain(g) : 0,
    );
  } else {
    gains = [...DEFAULT_EQ_SETTINGS.gains];
  }
  const preset =
    typeof raw.preset === 'string' &&
    (EQ_PRESET_NAMES as string[]).includes(raw.preset) &&
    gainsEqual(gains, EQ_PRESET_GAINS[raw.preset as Exclude<EqPresetName, 'custom'>])
      ? (raw.preset as EqPresetName)
      : presetForGains(gains);
  return { preset, gains };
}

/** Label frekuensi ramah: 31 Hz, 1 kHz, 16 kHz. */
export function formatFrequency(hz: number): string {
  if (hz >= 1000) {
    const khz = hz / 1000;
    return `${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`;
  }
  return `${hz} Hz`;
}

/** Label gain: +3 dB, -2 dB, 0 dB. */
export function formatGain(db: number): string {
  if (db > 0) return `+${db} dB`;
  if (db < 0) return `${db} dB`;
  return '0 dB';
}
