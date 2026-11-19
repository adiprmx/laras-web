/**
 * Tes logika timer tidur (P7): tenggat, sisa waktu, fade,
 * format. Fungsi murni, jam di-injeksi.
 */
import { describe, expect, it } from 'vitest';
import {
  createEndOfSongTimer,
  createMinutesTimer,
  fadeFactor,
  formatSleepRemaining,
  isTimerExpired,
  remainingMs,
  SLEEP_TIMER_MINUTES,
  sleepTimerText,
} from './sleepTimer';

describe('SLEEP_TIMER_MINUTES', () => {
  it('pilihan kanonis PRD: 5/10/15/30/45/60', () => {
    expect([...SLEEP_TIMER_MINUTES]).toEqual([5, 10, 15, 30, 45, 60]);
  });
});

describe('createMinutesTimer + remainingMs', () => {
  it('tenggat 5 menit dari sekarang, sisa berkurang', () => {
    const now = 1_000_000;
    const timer = createMinutesTimer(5, now);
    expect(timer).toEqual({
      mode: 'minutes',
      deadlineMs: now + 300_000,
      minutes: 5,
    });
    expect(remainingMs(timer, now)).toBe(300_000);
    expect(remainingMs(timer, now + 60_000)).toBe(240_000);
  });

  it('sisa tidak pernah negatif sesudah tenggat', () => {
    const timer = createMinutesTimer(5, 1_000_000);
    expect(remainingMs(timer, 1_000_000 + 999_999)).toBe(0);
  });

  it('timer akhir-lagu tidak punya sisa menit', () => {
    const timer = createEndOfSongTimer('lagu-1');
    expect(remainingMs(timer, 1_000_000)).toBeNull();
    expect(remainingMs(null, 1_000_000)).toBeNull();
  });
});

describe('isTimerExpired', () => {
  it('habis tepat di tenggat, belum habis sebelumnya', () => {
    const timer = createMinutesTimer(10, 1_000_000);
    expect(isTimerExpired(timer, 1_000_000 + 599_999)).toBe(false);
    expect(isTimerExpired(timer, 1_000_000 + 600_000)).toBe(true);
  });

  it('timer akhir-lagu dan null tidak pernah kedaluwarsa lewat jam', () => {
    expect(
      isTimerExpired(createEndOfSongTimer('x'), 9_999_999_999),
    ).toBe(false);
    expect(isTimerExpired(null, 9_999_999_999)).toBe(false);
  });
});

describe('fadeFactor', () => {
  it('1 di luar 10 detik terakhir, turun lurus di dalamnya', () => {
    const timer = createMinutesTimer(5, 1_000_000);
    expect(fadeFactor(timer, 1_000_000)).toBe(1);
    expect(fadeFactor(timer, 1_000_000 + 290_000)).toBe(1);
    expect(fadeFactor(timer, 1_000_000 + 295_000)).toBeCloseTo(0.5);
    expect(fadeFactor(timer, 1_000_000 + 299_000)).toBeCloseTo(0.1);
    expect(fadeFactor(timer, 1_000_000 + 300_000)).toBe(0);
  });

  it('timer akhir-lagu dan null selalu 1', () => {
    expect(fadeFactor(createEndOfSongTimer('x'), 1_000_000)).toBe(1);
    expect(fadeFactor(null, 1_000_000)).toBe(1);
  });
});

describe('sleepTimerText', () => {
  it('teks menit dan akhir-lagu', () => {
    const timer = createMinutesTimer(12, 1_000_000);
    expect(sleepTimerText(timer, 1_000_000)).toBe(
      'Berhenti dalam 12 menit',
    );
    expect(
      sleepTimerText(createEndOfSongTimer('x'), 1_000_000),
    ).toBe('Berhenti sesudah lagu ini selesai.');
    expect(sleepTimerText(null, 1_000_000)).toBeNull();
  });
});

describe('formatSleepRemaining', () => {
  it('detik di bawah satu menit, menit di atasnya', () => {
    expect(formatSleepRemaining(0)).toBe('0 detik');
    expect(formatSleepRemaining(45_000)).toBe('45 detik');
    expect(formatSleepRemaining(59_000)).toBe('59 detik');
    expect(formatSleepRemaining(59_500)).toBe('1 menit');
    expect(formatSleepRemaining(61_000)).toBe('2 menit');
    expect(formatSleepRemaining(12 * 60_000)).toBe('12 menit');
    expect(formatSleepRemaining(60_000)).toBe('1 menit');
  });
});
