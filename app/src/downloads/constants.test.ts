import { describe, expect, it } from 'vitest';
import {
  DOWNLOADS_CACHE_NAME,
  downloadPartUrl,
  downloadUrl,
  isDeletableOnActivate,
  isProtectedCache,
  partFromDownloadPartPath,
  RUNTIME_CACHE_NAME,
  videoIdFromDownloadPath,
} from './constants';

describe('cache predicates (K9)', () => {
  it('cache unduhan dilindungi', () => {
    expect(isProtectedCache(DOWNLOADS_CACHE_NAME)).toBe(true);
    expect(isProtectedCache(RUNTIME_CACHE_NAME)).toBe(false);
    expect(isProtectedCache('laras-shell-v2')).toBe(false);
  });

  it('aktivasi SW tidak pernah menghapus cache unduhan', () => {
    expect(
      isDeletableOnActivate(DOWNLOADS_CACHE_NAME, 'laras-shell-0.9.0-x'),
    ).toBe(false);
  });

  it('aktivasi menghapus shell lama, bukan shell saat ini/runtime', () => {
    expect(
      isDeletableOnActivate('laras-shell-v2', 'laras-shell-0.9.0-x'),
    ).toBe(true);
    expect(
      isDeletableOnActivate('laras-shell-0.9.0-x', 'laras-shell-0.9.0-x'),
    ).toBe(false);
    expect(
      isDeletableOnActivate(RUNTIME_CACHE_NAME, 'laras-shell-0.9.0-x'),
    ).toBe(false);
    expect(
      isDeletableOnActivate('laras-runtime-old', 'laras-shell-0.9.0-x'),
    ).toBe(true);
  });

  it('cache asing tidak dihapus', () => {
    expect(isDeletableOnActivate('workbox-precache', 'laras-shell-x')).toBe(
      false,
    );
    expect(isDeletableOnActivate('other-cache', 'laras-shell-x')).toBe(false);
  });
});

describe('download URL paths', () => {
  it('downloadUrl memakai awalan /dl/ + videoId ter-encode', () => {
    expect(downloadUrl('hhn-nGSuenM')).toBe('/dl/hhn-nGSuenM');
    expect(downloadUrl('a/b')).toBe('/dl/a%2Fb');
  });

  it('videoIdFromDownloadPath membalik downloadUrl', () => {
    expect(videoIdFromDownloadPath('/dl/hhn-nGSuenM')).toBe('hhn-nGSuenM');
    expect(videoIdFromDownloadPath('/dl/a%2Fb')).toBe('a/b');
  });

  it('videoIdFromDownloadPath menolak jalur bukan unduhan', () => {
    expect(videoIdFromDownloadPath('/dl/')).toBeNull();
    expect(videoIdFromDownloadPath('/dl/a/b')).toBeNull();
    expect(videoIdFromDownloadPath('/dl-part/a/0')).toBeNull();
    expect(videoIdFromDownloadPath('/library')).toBeNull();
    expect(videoIdFromDownloadPath('/dl/%E0%A4%A')).toBeNull();
  });

  it('part paths bolak-balik', () => {
    expect(downloadPartUrl('vid1', 3)).toBe('/dl-part/vid1/3');
    expect(partFromDownloadPartPath('/dl-part/vid1/3')).toEqual({
      videoId: 'vid1',
      index: 3,
    });
    expect(partFromDownloadPartPath('/dl-part/vid1/x')).toBeNull();
    expect(partFromDownloadPartPath('/dl-part/vid1')).toBeNull();
    expect(partFromDownloadPartPath('/dl/vid1')).toBeNull();
  });
});
