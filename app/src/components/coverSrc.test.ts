/**
 * Tes helper srcset sampul (P-React19).
 */
import { describe, expect, it } from 'vitest';
import { coverSrcSet } from './coverSrc';

describe('coverSrcSet', () => {
  it('ytimg jpg: tiga varian + sizes diteruskan', () => {
    expect(
      coverSrcSet('https://i.ytimg.com/vi/abc123XYZ/hqdefault.jpg', '48px'),
    ).toEqual({
      srcSet:
        'https://i.ytimg.com/vi/abc123XYZ/default.jpg 120w, ' +
        'https://i.ytimg.com/vi/abc123XYZ/mqdefault.jpg 320w, ' +
        'https://i.ytimg.com/vi/abc123XYZ/hqdefault.jpg 480w',
      sizes: '48px',
    });
  });

  it('ytimg: query dibuang (URL telanjang = kanonis)', () => {
    const result = coverSrcSet(
      'https://i.ytimg.com/vi/abc123XYZ/hq720.jpg?sqp=-oaymwEXCJADEOABSFryq4qpAwkIARUAAIhCGAE=&rs=AOn4CLDtest',
      '48px',
    );
    expect(result?.srcSet).not.toContain('sqp=');
    expect(result?.srcSet).toContain(
      'https://i.ytimg.com/vi/abc123XYZ/mqdefault.jpg 320w',
    );
  });

  it('ytimg webp: varian .webp dipertahankan', () => {
    const result = coverSrcSet(
      'https://i.ytimg.com/vi_webp/abc123XYZ/hqdefault.webp',
      '48px',
    );
    expect(result?.srcSet).toContain(
      'https://i.ytimg.com/vi_webp/abc123XYZ/default.webp 120w',
    );
  });

  it('lh3 =w-h: parameter resize ditulis ulang, sufiks dipertahankan', () => {
    expect(
      coverSrcSet(
        'https://lh3.googleusercontent.com/abc=w544-h544-l90-rj',
        '48px',
      ),
    ).toEqual({
      srcSet:
        'https://lh3.googleusercontent.com/abc=w96-h96-l90-rj 96w, ' +
        'https://lh3.googleusercontent.com/abc=w240-h240-l90-rj 240w, ' +
        'https://lh3.googleusercontent.com/abc=w544-h544-l90-rj 544w',
      sizes: '48px',
    });
  });

  it('lh3 =s: parameter ukuran ditulis ulang', () => {
    const result = coverSrcSet(
      'https://lh3.googleusercontent.com/abc=s544',
      '96px',
    );
    expect(result?.srcSet).toContain(
      'https://lh3.googleusercontent.com/abc=s96 96w',
    );
    expect(result?.sizes).toBe('96px');
  });

  it('host tak dikenal / null / kosong -> null (src tunggal)', () => {
    expect(
      coverSrcSet('https://lh3.ggpht.com/abc=w544-h544', '48px'),
    ).toBeNull();
    expect(coverSrcSet('https://example.com/cover.jpg', '48px')).toBeNull();
    expect(coverSrcSet(null, '48px')).toBeNull();
    expect(coverSrcSet(undefined, '48px')).toBeNull();
    expect(coverSrcSet('', '48px')).toBeNull();
  });
});
