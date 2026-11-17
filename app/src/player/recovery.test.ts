import { describe, expect, it } from 'vitest';
import {
  decideOnError,
  decideRestorePosition,
  FailureCounter,
  StallTracker,
} from './recovery';

describe('StallTracker', () => {
  it('posisi yang maju terus berarti ok', () => {
    const tracker = new StallTracker();
    expect(tracker.feed(0, 0, true)).toBe('ok');
    expect(tracker.feed(1, 1000, true)).toBe('ok');
    expect(tracker.feed(2, 2000, true)).toBe('ok');
  });

  it('macet 5 detik meminta resume, 10 detik meminta resolve ulang', () => {
    const tracker = new StallTracker();
    expect(tracker.feed(10, 0, true)).toBe('ok');
    expect(tracker.feed(10, 4000, true)).toBe('ok');
    expect(tracker.feed(10, 5000, true)).toBe('resume');
    expect(tracker.feed(10, 6000, true)).toBe('ok');
    expect(tracker.feed(10, 10000, true)).toBe('reresolve');
    // Sesudah resolve ulang diminta, tidak meminta lagi sampai reset.
    expect(tracker.feed(10, 15000, true)).toBe('ok');
  });

  it('posisi yang maju mereset episode macet', () => {
    const tracker = new StallTracker();
    tracker.feed(10, 0, true);
    expect(tracker.feed(10, 5000, true)).toBe('resume');
    expect(tracker.feed(11, 6000, true)).toBe('ok');
    expect(tracker.feed(11, 11000, true)).toBe('resume');
  });

  it('saat jeda, pelacak diam dan reset', () => {
    const tracker = new StallTracker();
    tracker.feed(10, 0, true);
    expect(tracker.feed(10, 4000, false)).toBe('ok');
    expect(tracker.feed(10, 20000, true)).toBe('ok');
  });

  it('reset mengembalikan ke keadaan awal', () => {
    const tracker = new StallTracker();
    tracker.feed(10, 0, true);
    tracker.feed(10, 10000, true);
    tracker.reset();
    expect(tracker.feed(10, 20000, true)).toBe('ok');
    expect(tracker.feed(10, 25000, true)).toBe('resume');
  });
});

describe('FailureCounter', () => {
  it('berhenti sesudah 3 kegagalan berturut-turut', () => {
    const counter = new FailureCounter();
    expect(counter.shouldStop).toBe(false);
    counter.recordFailure();
    counter.recordFailure();
    expect(counter.shouldStop).toBe(false);
    counter.recordFailure();
    expect(counter.failures).toBe(3);
    expect(counter.shouldStop).toBe(true);
  });

  it('satu lagu sukses mereset hitungan', () => {
    const counter = new FailureCounter();
    counter.recordFailure();
    counter.recordFailure();
    counter.recordSuccess();
    expect(counter.failures).toBe(0);
    expect(counter.shouldStop).toBe(false);
  });
});

describe('decideOnError', () => {
  it('lagu yang sudah terdengar di-resolve ulang bila masih ada jatah', () => {
    expect(decideOnError(30, 0)).toBe('reresolve');
    expect(decideOnError(5.1, 1)).toBe('reresolve');
  });

  it('jatah habis atau belum terdengar pindah ke lagu berikut', () => {
    expect(decideOnError(30, 2)).toBe('next');
    expect(decideOnError(5, 0)).toBe('next');
    expect(decideOnError(0, 0)).toBe('next');
  });
});

describe('decideRestorePosition', () => {
  it('posisi di bawah 10 detik mulai dari awal', () => {
    expect(decideRestorePosition(9.9, 268)).toEqual({
      action: 'start',
      position: 0,
    });
    expect(decideRestorePosition(0, 268)).toEqual({
      action: 'start',
      position: 0,
    });
  });

  it('posisi kurang dari 10 detik dari akhir pindah ke lagu berikut', () => {
    expect(decideRestorePosition(260, 268)).toEqual({ action: 'next' });
    expect(decideRestorePosition(258.5, 268)).toEqual({ action: 'next' });
  });

  it('posisi tengah dilanjutkan apa adanya', () => {
    expect(decideRestorePosition(100, 268)).toEqual({
      action: 'start',
      position: 100,
    });
  });

  it('lagu di bawah 30 detik memakai ambang sepertiga durasi', () => {
    // Durasi 24 detik: ambang 8 detik.
    expect(decideRestorePosition(7, 24)).toEqual({
      action: 'start',
      position: 0,
    });
    expect(decideRestorePosition(17, 24)).toEqual({ action: 'next' });
    expect(decideRestorePosition(12, 24)).toEqual({
      action: 'start',
      position: 12,
    });
  });

  it('durasi tak diketahui memakai posisi tersimpan apa adanya', () => {
    expect(decideRestorePosition(42, undefined)).toEqual({
      action: 'start',
      position: 42,
    });
  });
});
