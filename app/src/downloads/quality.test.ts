import { describe, expect, it } from 'vitest';
import {
  estimateDownloadBytes,
  formatBytes,
  QUALITY_ITAG_PREFERENCE,
  qualityFromItag,
} from './quality';

describe('QUALITY_ITAG_PREFERENCE', () => {
  it('Terbaik memakai urutan kanonis (251 dulu)', () => {
    expect(QUALITY_ITAG_PREFERENCE.best).toEqual([251, 140, 250, 249, 139]);
  });

  it('Seimbang mengutamakan 140, Hemat data mengutamakan 249', () => {
    expect(QUALITY_ITAG_PREFERENCE.balanced[0]).toBe(140);
    expect(QUALITY_ITAG_PREFERENCE.dataSaver[0]).toBe(249);
  });

  it('ketiga opsi mencakup itag yang sama (hanya urutan berbeda)', () => {
    const sorted = (list: readonly number[]): number[] =>
      [...list].sort((a, b) => a - b);
    expect(sorted(QUALITY_ITAG_PREFERENCE.balanced)).toEqual(
      sorted(QUALITY_ITAG_PREFERENCE.best),
    );
    expect(sorted(QUALITY_ITAG_PREFERENCE.dataSaver)).toEqual(
      sorted(QUALITY_ITAG_PREFERENCE.best),
    );
  });
});

describe('qualityFromItag', () => {
  it('memetakan itag pertama tiap opsi', () => {
    expect(qualityFromItag(251)).toBe('best');
    expect(qualityFromItag(140)).toBe('balanced');
    expect(qualityFromItag(249)).toBe('dataSaver');
    expect(qualityFromItag(139)).toBe('dataSaver');
  });

  it('itag tak dikenal/null jatuh ke Terbaik', () => {
    expect(qualityFromItag(250)).toBe('best');
    expect(qualityFromItag(null)).toBe('best');
    expect(qualityFromItag(999)).toBe('best');
  });
});

describe('estimateDownloadBytes', () => {
  it('cocok dengan angka arsitektur §3.6 untuk lagu 3,5 menit', () => {
    // Terbaik 160 kbps x 210 dtk = 4.200.000 byte (4,2 MB).
    expect(estimateDownloadBytes('best', 210)).toBe(4_200_000);
    // Seimbang 128 kbps x 210 dtk = 3.360.000 byte (3,4 MB).
    expect(estimateDownloadBytes('balanced', 210)).toBe(3_360_000);
    // Hemat data 50 kbps x 210 dtk = 1.312.500 byte (1,3 MB).
    expect(estimateDownloadBytes('dataSaver', 210)).toBe(1_312_500);
  });

  it('durasi tak dikenal menghasilkan null (bukan angka karangan)', () => {
    expect(estimateDownloadBytes('best', null)).toBeNull();
    expect(estimateDownloadBytes('best', undefined)).toBeNull();
    expect(estimateDownloadBytes('best', 0)).toBeNull();
    expect(estimateDownloadBytes('best', -5)).toBeNull();
  });
});

describe('formatBytes', () => {
  it('memformat byte, KB, MB, GB dengan koma desimal', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1,0 KB');
    expect(formatBytes(1536)).toBe('1,5 KB');
    expect(formatBytes(4_200_000)).toBe('4,0 MB');
    expect(formatBytes(4_400_000)).toBe('4,2 MB');
    expect(formatBytes(1_500_000_000)).toBe('1,4 GB');
  });

  it('nilai besar dibulatkan tanpa desimal', () => {
    expect(formatBytes(12_345_678)).toBe('12 MB');
    expect(formatBytes(123_456_789)).toBe('118 MB');
  });

  it('nilai tak valid menjadi 0 B', () => {
    expect(formatBytes(null)).toBe('0 B');
    expect(formatBytes(undefined)).toBe('0 B');
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(NaN)).toBe('0 B');
  });
});
