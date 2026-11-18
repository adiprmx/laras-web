import { describe, expect, it, vi } from 'vitest';
import { HtmlAudioPort, isSafeLocalUrl } from './port';

// jsdom tidak mengimplementasikan HTMLMediaElement.load: stub
// supaya tes tidak membanjiri output dengan "Not implemented".
vi.spyOn(window.HTMLMediaElement.prototype, 'load').mockImplementation(
  () => {},
);

describe('isSafeLocalUrl (Red 1 I3)', () => {
  const origin = window.location.origin;

  it('menerima path relatif dan URL same-origin', () => {
    expect(isSafeLocalUrl('/__player-test__/tone-10s.wav')).toBe(true);
    expect(isSafeLocalUrl(`${origin}/audio/lagu.wav`)).toBe(true);
  });

  it('menerima blob same-origin', () => {
    expect(isSafeLocalUrl(`blob:${origin}/1234-5678`)).toBe(true);
  });

  it('menolak host asing, blob asing, data:, dan URL rusak', () => {
    expect(
      isSafeLocalUrl('https://evil.example.com/lagu.mp3'),
    ).toBe(false);
    expect(
      isSafeLocalUrl('https://localhost:3000.evil.example.com/x.mp3'),
    ).toBe(false);
    expect(
      isSafeLocalUrl('blob:https://evil.example.com/1234'),
    ).toBe(false);
    expect(isSafeLocalUrl('data:audio/mp3;base64,AAAA')).toBe(false);
    expect(isSafeLocalUrl('http://[::1')).toBe(false);
  });
});

describe('HtmlAudioPort.load', () => {
  it('melempar untuk URL lokal host asing', () => {
    const port = new HtmlAudioPort();
    expect(() =>
      port.load('https://evil.example.com/lagu.mp3', 'local'),
    ).toThrow('URL audio lokal tidak diizinkan');
    port.dispose();
  });

  it('menerima nada same-origin', () => {
    const port = new HtmlAudioPort();
    expect(() =>
      port.load('/__player-test__/tone-10s.wav', 'local'),
    ).not.toThrow();
    port.dispose();
  });
});
