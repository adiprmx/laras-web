import { describe, expect, it } from 'vitest';
import {
  compareSearchCandidates,
  localArtistIdForName,
  prefixUpperBound,
  scoreCandidate,
  tokenize,
  uniqueTokens,
} from './tokens';

describe('tokenize', () => {
  it('huruf kecil, tanpa tanda baca', () => {
    expect(tokenize('Semua Tentang Kita!')).toEqual([
      'semua',
      'tentang',
      'kita',
    ]);
  });

  it('memisah angka dan kata', () => {
    expect(tokenize('Lagu 2024 (Remix)')).toEqual([
      'lagu',
      '2024',
      'remix',
    ]);
  });

  it('teks kosong menghasilkan daftar kosong', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('!!!')).toEqual([]);
  });

  it('huruf beraksen dipertahankan', () => {
    expect(tokenize('Beyoncé Café')).toEqual(['beyoncé', 'café']);
  });
});

describe('uniqueTokens', () => {
  it('membuang duplikat, urutan pertama dipertahankan', () => {
    expect(uniqueTokens('kita kita semua kita')).toEqual(['kita', 'semua']);
  });
});

describe('localArtistIdForName', () => {
  it('deterministik dan tidak peduli kapitalisasi/spasi', () => {
    const a = localArtistIdForName('Peterpan');
    expect(a).toBe(localArtistIdForName('  PETERPAN  '));
    expect(a).toMatch(/^local-[0-9a-f]{16}$/);
  });

  it('nama berbeda menghasilkan id berbeda', () => {
    expect(localArtistIdForName('Peterpan')).not.toBe(
      localArtistIdForName('Noah'),
    );
  });

  it('nilai FNV-1a cocok dengan hitungan referensi', () => {
    // Dihitung manual dari algoritma FNV-1a 64 bit (offset basis
    // 0xcbf29ce484222325, prima 0x100000001b3) atas "noah".
    expect(localArtistIdForName('noah')).toBe('local-3c24ecbad17d9e4b');
  });
});

describe('prefixUpperBound', () => {
  it('menambah U+FFFF sebagai batas atas rentang', () => {
    expect(prefixUpperBound('sem')).toBe(`sem${String.fromCharCode(0xffff)}`);
    expect(prefixUpperBound('sem').charCodeAt(3)).toBe(0xffff);
  });
});

describe('scoreCandidate', () => {
  it('cocok persis di judul lebih berat dari awalan', () => {
    const exact = scoreCandidate(['semua'], ['semua', 'tentang'], []);
    const prefix = scoreCandidate(['sem'], ['semua', 'tentang'], []);
    expect(exact).toBe(3);
    expect(prefix).toBe(2);
  });

  it('cocok di nama artis lebih ringan dari judul', () => {
    expect(scoreCandidate(['noah'], ['lagu'], ['noah'])).toBe(1.5);
    expect(scoreCandidate(['no'], ['lagu'], ['noah'])).toBe(1);
  });

  it('token yang tidak cocok di mana pun membuat skor 0', () => {
    expect(scoreCandidate(['semua', 'xyz'], ['semua'], [])).toBe(0);
  });

  it('mode or: token yang tidak cocok diabaikan, bukan menggagalkan', () => {
    expect(scoreCandidate(['semua', 'xyz'], ['semua'], [], 'or')).toBe(3);
    expect(scoreCandidate(['xyz', 'abc'], ['semua'], [], 'or')).toBe(0);
  });

  it('kueri kosong bernilai 0', () => {
    expect(scoreCandidate([], ['semua'], [])).toBe(0);
  });
});

describe('compareSearchCandidates', () => {
  it('skor turun, lalu judul, lalu id', () => {
    const rows = [
      { score: 2, titleKey: 'b', id: 'x2' },
      { score: 3, titleKey: 'z', id: 'x1' },
      { score: 2, titleKey: 'a', id: 'x3' },
      { score: 2, titleKey: 'a', id: 'x0' },
    ];
    rows.sort(compareSearchCandidates);
    expect(rows.map((r) => r.id)).toEqual(['x1', 'x0', 'x3', 'x2']);
  });
});
