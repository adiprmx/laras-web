import { describe, expect, it } from 'vitest';
import { generateSampleSongs, mulberry32 } from './sampleData';

describe('mulberry32', () => {
  it('deterministik: seed sama menghasilkan urutan sama', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const valuesA = [a(), a(), a(), a(), a()];
    const valuesB = [b(), b(), b(), b(), b()];
    expect(valuesA).toEqual(valuesB);
    for (const v of valuesA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('generateSampleSongs', () => {
  it('menghasilkan jumlah yang diminta, id berurutan', () => {
    const songs = generateSampleSongs(1000);
    expect(songs).toHaveLength(1000);
    expect(songs[0]?.song.id).toBe('sample-0000');
    expect(songs[999]?.song.id).toBe('sample-0999');
    const ids = new Set(songs.map((s) => s.song.id));
    expect(ids.size).toBe(1000);
  });

  it('deterministik: dua panggilan menghasilkan data identik', () => {
    const a = generateSampleSongs(200);
    const b = generateSampleSongs(200);
    expect(a).toEqual(b);
  });

  it('seed berbeda menghasilkan data berbeda', () => {
    const a = generateSampleSongs(50, { seed: 1 });
    const b = generateSampleSongs(50, { seed: 2 });
    expect(a).not.toEqual(b);
  });

  it('label contoh jelas di id, artis, dan album', () => {
    const songs = generateSampleSongs(10);
    for (const item of songs) {
      expect(item.song.id.startsWith('sample-')).toBe(true);
      expect(item.artistNames?.[0]).toMatch(/^Artis Contoh \d{2}$/);
      expect(item.album?.title).toMatch(/^Album Contoh \d{2}$/);
      expect(item.album?.id.startsWith('sample-album-')).toBe(true);
    }
  });

  it('lagu pertama terbaru, tiap lagu lebih tua satu jam', () => {
    const songs = generateSampleSongs(5);
    const added = songs.map((s) => s.song.dateAdded ?? 0);
    for (let i = 1; i < added.length; i++) {
      expect((added[i - 1] as number) - (added[i] as number)).toBe(3_600_000);
    }
  });

  it('setiap lagu ke-10 difavoritkan', () => {
    const songs = generateSampleSongs(100);
    const liked = songs.filter((s) => s.song.liked === 1);
    expect(liked).toHaveLength(10);
    expect(liked[0]?.song.id).toBe('sample-0000');
    expect(liked[1]?.song.id).toBe('sample-0010');
  });

  it('durasi dalam rentang wajar 120-360 detik', () => {
    const songs = generateSampleSongs(500);
    for (const item of songs) {
      const d = item.song.durationSeconds ?? 0;
      expect(d).toBeGreaterThanOrEqual(120);
      expect(d).toBeLessThanOrEqual(360);
    }
  });
});
