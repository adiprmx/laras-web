/**
 * Tes prefetch rute on-intent (P-Links, Koordinator #18).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetRoutePreloads,
  prefetchRoute,
  registerRoutePreload,
} from './prefetch';

beforeEach(() => {
  __resetRoutePreloads();
});

describe('prefetchRoute', () => {
  it('memanggil pemuat awalan yang cocok', () => {
    const load = vi.fn().mockResolvedValue(undefined);
    registerRoutePreload('/library', load);
    prefetchRoute('/library');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('awalan terpanjang menang', () => {
    const library = vi.fn().mockResolvedValue(undefined);
    const playlist = vi.fn().mockResolvedValue(undefined);
    registerRoutePreload('/library', library);
    registerRoutePreload('/library/playlist', playlist);
    prefetchRoute('/library/playlist/5');
    expect(playlist).toHaveBeenCalledTimes(1);
    expect(library).not.toHaveBeenCalled();
  });

  it('cocok dengan query string + subpath', () => {
    const search = vi.fn().mockResolvedValue(undefined);
    registerRoutePreload('/search', search);
    prefetchRoute('/search?q=starla');
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('hanya sekali per awalan', () => {
    const load = vi.fn().mockResolvedValue(undefined);
    registerRoutePreload('/browse', load);
    prefetchRoute('/browse');
    prefetchRoute('/browse/abc');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('rute tak dikenal = no-op, tanpa lempar', () => {
    expect(() => prefetchRoute('/tidak-ada')).not.toThrow();
  });

  it('pemuat yang gagal tidak melempar (diam)', async () => {
    const load = vi.fn().mockRejectedValue(new Error('chunk gagal'));
    registerRoutePreload('/settings', load);
    expect(() => prefetchRoute('/settings')).not.toThrow();
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('registrasi ganda tidak menimpa pemuat pertama', () => {
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);
    registerRoutePreload('/downloads', first);
    registerRoutePreload('/downloads', second);
    prefetchRoute('/downloads');
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });
});
