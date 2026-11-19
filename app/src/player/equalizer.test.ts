/**
 * Tes logika equalizer (P7): preset, clamp, normalisasi JSON
 * tersimpan, label. Tanpa AudioContext.
 */
import { describe, expect, it } from 'vitest';
import {
  clampGain,
  DEFAULT_EQ_SETTINGS,
  EQ_FREQUENCIES,
  EQ_PRESET_GAINS,
  formatFrequency,
  formatGain,
  gainsEqual,
  normalizeEqSettings,
  presetForGains,
} from './equalizer';

describe('EQ_FREQUENCIES', () => {
  it('10 band ISO 31 Hz sampai 16 kHz', () => {
    expect(EQ_FREQUENCIES).toEqual([
      31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000,
    ]);
  });
});

describe('clampGain', () => {
  it('membatasi ke plus minus 12 dB', () => {
    expect(clampGain(20)).toBe(12);
    expect(clampGain(-20)).toBe(-12);
    expect(clampGain(3)).toBe(3);
  });

  it('nilai bukan angka menjadi 0', () => {
    expect(clampGain(Number.NaN)).toBe(0);
    expect(clampGain(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('presetForGains', () => {
  it('mengenali tiap preset dari gain-nya', () => {
    expect(presetForGains(EQ_PRESET_GAINS.flat)).toBe('flat');
    expect(presetForGains(EQ_PRESET_GAINS.bass)).toBe('bass');
    expect(presetForGains(EQ_PRESET_GAINS.vocal)).toBe('vocal');
    expect(presetForGains(EQ_PRESET_GAINS.acoustic)).toBe('acoustic');
  });

  it('gain campuran menjadi custom', () => {
    expect(presetForGains([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe('custom');
  });
});

describe('normalizeEqSettings', () => {
  it('masukan bukan objek menjadi default rata', () => {
    expect(normalizeEqSettings(null)).toEqual(DEFAULT_EQ_SETTINGS);
    expect(normalizeEqSettings('rusak')).toEqual(DEFAULT_EQ_SETTINGS);
    expect(normalizeEqSettings(undefined)).toEqual(DEFAULT_EQ_SETTINGS);
  });

  it('gain di luar rentang di-clamp, preset asing jadi custom', () => {
    const out = normalizeEqSettings({
      preset: 'tidak-ada',
      gains: [99, -99, 0, 0, 0, 0, 0, 0, 0, 0],
    });
    expect(out.gains).toEqual([12, -12, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(out.preset).toBe('custom');
  });

  it('panjang gain salah diisi default', () => {
    const out = normalizeEqSettings({ preset: 'bass', gains: [1, 2] });
    expect(out).toEqual(DEFAULT_EQ_SETTINGS);
  });

  it('preset dan gain yang cocok dipertahankan', () => {
    const out = normalizeEqSettings({
      preset: 'bass',
      gains: [...EQ_PRESET_GAINS.bass],
    });
    expect(out.preset).toBe('bass');
    expect(out.gains).toEqual([...EQ_PRESET_GAINS.bass]);
  });

  it('preset yang tidak cocok dengan gain dikoreksi', () => {
    const out = normalizeEqSettings({
      preset: 'bass',
      gains: [...EQ_PRESET_GAINS.vocal],
    });
    expect(out.preset).toBe('vocal');
  });
});

describe('formatFrequency', () => {
  it('Hz di bawah 1000, kHz di atasnya', () => {
    expect(formatFrequency(31)).toBe('31 Hz');
    expect(formatFrequency(500)).toBe('500 Hz');
    expect(formatFrequency(1000)).toBe('1 kHz');
    expect(formatFrequency(16000)).toBe('16 kHz');
  });
});

describe('formatGain', () => {
  it('tanda plus untuk positif, tanpa tanda untuk nol', () => {
    expect(formatGain(3)).toBe('+3 dB');
    expect(formatGain(-2)).toBe('-2 dB');
    expect(formatGain(0)).toBe('0 dB');
  });
});

describe('gainsEqual', () => {
  it('toleransi 0,01 dB', () => {
    expect(gainsEqual([1, 2], [1.005, 2])).toBe(true);
    expect(gainsEqual([1, 2], [1.02, 2])).toBe(false);
    expect(gainsEqual([1], [1, 2])).toBe(false);
  });
});
