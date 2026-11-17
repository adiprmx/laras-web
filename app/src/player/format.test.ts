import { describe, expect, it } from 'vitest';
import { formatRemaining, formatTime } from './format';

describe('formatTime', () => {
  it('memformat detik menjadi m:ss', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(5)).toBe('0:05');
    expect(formatTime(65)).toBe('1:05');
    expect(formatTime(268)).toBe('4:28');
    expect(formatTime(3599)).toBe('59:59');
  });

  it('memformat durasi satu jam ke atas menjadi h:mm:ss', () => {
    expect(formatTime(3600)).toBe('1:00:00');
    expect(formatTime(3723)).toBe('1:02:03');
  });

  it('membulatkan ke bawah dan menangani nilai tak valid', () => {
    expect(formatTime(65.9)).toBe('1:05');
    expect(formatTime(NaN)).toBe('0:00');
    expect(formatTime(-10)).toBe('0:00');
    expect(formatTime(Infinity)).toBe('0:00');
  });
});

describe('formatRemaining', () => {
  it('menambahkan label Sisa', () => {
    expect(formatRemaining(754)).toBe('Sisa 12:34');
  });
});
