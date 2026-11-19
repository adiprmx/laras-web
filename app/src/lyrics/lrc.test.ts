/**
 * Tes parser LRC (P7). Fungsi murni, tanpa jaringan.
 */
import { describe, expect, it } from 'vitest';
import { activeLineIndex, parseLrc } from './lrc';

describe('parseLrc', () => {
  it('mengurai baris waktu dasar', () => {
    const lines = parseLrc(
      '[00:12.00]Baris pertama\n[00:15.50]Baris kedua\n',
    );
    expect(lines).toEqual([
      { timeSeconds: 12, text: 'Baris pertama' },
      { timeSeconds: 15.5, text: 'Baris kedua' },
    ]);
  });

  it('menerima penanda tanpa pecahan dan pecahan 1-3 digit', () => {
    const lines = parseLrc(
      '[00:05]tanpa pecahan\n[01:00.5]satu digit\n[01:01.234]tiga digit\n',
    );
    expect(lines).toEqual([
      { timeSeconds: 5, text: 'tanpa pecahan' },
      { timeSeconds: 60.5, text: 'satu digit' },
      { timeSeconds: 61.234, text: 'tiga digit' },
    ]);
  });

  it('mengabaikan tag metadata dan baris tanpa waktu', () => {
    const lines = parseLrc(
      '[ti:Judul Lagu]\n[ar:Nama Artis]\n[by:siapa]\n[00:10.00]Nyata\nbaris sampah\n',
    );
    expect(lines).toEqual([{ timeSeconds: 10, text: 'Nyata' }]);
  });

  it('membuat satu baris per penanda bila satu baris punya dua waktu', () => {
    const lines = parseLrc('[00:12.00][00:30.00]Diulang\n');
    expect(lines).toEqual([
      { timeSeconds: 12, text: 'Diulang' },
      { timeSeconds: 30, text: 'Diulang' },
    ]);
  });

  it('menerapkan offset ke semua waktu', () => {
    const lines = parseLrc('[offset:+500]\n[00:10.00]Geser\n');
    expect(lines).toEqual([{ timeSeconds: 10.5, text: 'Geser' }]);
  });

  it('membuang offset negatif yang membuat waktu negatif', () => {
    const lines = parseLrc('[offset:-20000]\n[00:10.00]Hilang\n[00:30.00]Ada\n');
    expect(lines).toEqual([{ timeSeconds: 10, text: 'Ada' }]);
  });

  it('membuang tag kata gaya lirik yang diperkaya', () => {
    const lines = parseLrc(
      '[00:10.00]Kata <00:10.50>kedua <00:11.00>ketiga\n',
    );
    expect(lines).toEqual([
      { timeSeconds: 10, text: 'Kata kedua ketiga' },
    ]);
  });

  it('mengurutkan baris yang tidak urut dan mempertahankan teks kosong', () => {
    const lines = parseLrc('[00:20.00]Kedua\n[00:10.00]\n[00:15.00]Tengah\n');
    expect(lines).toEqual([
      { timeSeconds: 10, text: '' },
      { timeSeconds: 15, text: 'Tengah' },
      { timeSeconds: 20, text: 'Kedua' },
    ]);
  });

  it('teks kosong menghasilkan nol baris', () => {
    expect(parseLrc('')).toEqual([]);
    expect(parseLrc('[ti:Hanya metadata]\n')).toEqual([]);
  });
});

describe('activeLineIndex', () => {
  const lines = [
    { timeSeconds: 10, text: 'satu' },
    { timeSeconds: 20, text: 'dua' },
    { timeSeconds: 30, text: 'tiga' },
  ];

  it('-1 sebelum baris pertama', () => {
    expect(activeLineIndex(lines, 0)).toBe(-1);
    expect(activeLineIndex(lines, 9.99)).toBe(-1);
  });

  it('baris terakhir yang waktunya sudah lewat', () => {
    expect(activeLineIndex(lines, 10)).toBe(0);
    expect(activeLineIndex(lines, 19.99)).toBe(0);
    expect(activeLineIndex(lines, 20)).toBe(1);
    expect(activeLineIndex(lines, 29.99)).toBe(1);
    expect(activeLineIndex(lines, 30)).toBe(2);
    expect(activeLineIndex(lines, 999)).toBe(2);
  });

  it('daftar kosong selalu -1', () => {
    expect(activeLineIndex([], 100)).toBe(-1);
  });
});
