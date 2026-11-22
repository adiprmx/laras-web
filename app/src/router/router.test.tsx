// @vitest-environment jsdom
/**
 * Tes router (P-Links, Koordinator #18): parseRoute + useRoute
 * (navigasi + restorasi scroll manual).
 *
 * scrollY/jsdom: scrollTo di-stub supaya memperbarui scrollY
 * tiruan (mirip browser); popstate disimulasikan dengan
 * pushState + dispatch PopStateEvent (history.back() jsdom
 * tidak bisa diandalkan urutan event-nya).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseRoute, useRoute } from './router';

// React 19: tandai lingkungan tes supaya act() tidak memperingatkan.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let mockScrollY = 0;
const scrollToSpy = vi.fn((_x: number, y: number) => {
  mockScrollY = y;
});
const origScrollTo = window.scrollTo;

function Harness() {
  const [route, navigate] = useRoute();
  return (
    <div>
      <span data-testid="route">
        {route.name}
        {route.name === 'playlist' ? `:${route.id}` : ''}
        {route.name === 'search' ? `:${route.query}` : ''}
        {route.name === 'library' && route.tab ? `:${route.tab}` : ''}
      </span>
      <button
        type="button"
        data-testid="go-library"
        onClick={() => navigate('/library')}
      >
        Library
      </button>
      <button
        type="button"
        data-testid="go-playlist"
        onClick={() => navigate('/library/playlist/7')}
      >
        Playlist
      </button>
    </div>
  );
}

function renderHarness(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Harness />);
  });
}

function click(testId: string): void {
  const button = document.querySelector(
    `[data-testid="${testId}"]`,
  ) as HTMLButtonElement;
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function routeText(): string {
  return (
    document.querySelector('[data-testid="route"]')?.textContent ?? ''
  );
}

// CATATAN: restorasi scroll menunggu rAF ganda + render React —
// durasinya bervariasi (di bawah instrumentasi coverage Vitest 5
// terbukti > 60 ms). Tes memakai vi.waitFor (poll sampai asersi
// lolos, timeout 1 dtk), BUKAN sleep() tetap — sleep tetap adalah
// flake yang menunggu waktu (gagal sekali di run coverage Vitest 5,
 // 22 Nov 2026; plain run lolos).
beforeEach(() => {
  mockScrollY = 0;
  scrollToSpy.mockClear();
  Object.defineProperty(window, 'scrollY', {
    configurable: true,
    get: () => mockScrollY,
  });
  window.scrollTo = scrollToSpy as unknown as typeof window.scrollTo;
  window.history.pushState(null, '', '/');
});

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
  window.scrollTo = origScrollTo;
  window.history.pushState(null, '', '/');
});

describe('parseRoute', () => {
  it('rute dasar + query', () => {
    expect(parseRoute('/', '')).toEqual({ name: 'home' });
    expect(parseRoute('/library', '?tab=history')).toEqual({
      name: 'library',
      tab: 'history',
    });
    expect(parseRoute('/library', '?tab=ngawur')).toEqual({
      name: 'library',
      tab: undefined,
    });
    expect(parseRoute('/search', '?q=starla')).toEqual({
      name: 'search',
      query: 'starla',
    });
    expect(parseRoute('/library/playlist/7', '')).toEqual({
      name: 'playlist',
      id: 7,
    });
    expect(parseRoute('/browse/abc', '?params=p1')).toEqual({
      name: 'browse',
      browseId: 'abc',
      browseParams: 'p1',
    });
  });

  it('tak dikenal + segmen rusak -> beranda', () => {
    expect(parseRoute('/ngawur', '')).toEqual({ name: 'home' });
    expect(parseRoute('/browse/%E0%A4%A', '')).toEqual({ name: 'home' });
    expect(parseRoute('/library/', '')).toEqual({
      name: 'library',
      tab: undefined,
    });
  });
});

describe('useRoute', () => {
  it('navigate: ganti rute + URL + gulir ke atas', () => {
    renderHarness();
    expect(routeText()).toBe('home');
    mockScrollY = 400;
    click('go-library');
    expect(routeText()).toBe('library');
    expect(window.location.pathname).toBe('/library');
    expect(scrollToSpy).toHaveBeenCalledWith(0, 0);
  });

  it('popstate memulihkan posisi gulir halaman sebelumnya', async () => {
    renderHarness();
    // Gulir di beranda, lalu pindah ke Library.
    mockScrollY = 500;
    click('go-library');
    expect(mockScrollY).toBe(0);
    // Kembali (simulasi tombol back browser).
    mockScrollY = 0;
    window.history.pushState(null, '', '/');
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(routeText()).toBe('home');
    await vi.waitFor(() => {
      expect(scrollToSpy).toHaveBeenCalledWith(0, 500);
    });
  });

  it('popstate ke URL tanpa posisi tersimpan -> gulir ke 0', async () => {
    renderHarness();
    click('go-playlist');
    mockScrollY = 0;
    window.history.pushState(null, '', '/settings');
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(routeText()).toBe('settings');
    await vi.waitFor(() => {
      expect(scrollToSpy).toHaveBeenCalledWith(0, 0);
    });
  });

  it('posisi halaman yang ditinggalkan tersimpan untuk forward', async () => {
    renderHarness();
    mockScrollY = 300;
    click('go-library');
    // Gulir di Library, lalu back ke beranda.
    mockScrollY = 250;
    window.history.pushState(null, '', '/');
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await vi.waitFor(() => {
      expect(scrollToSpy).toHaveBeenCalledWith(0, 300);
    });
    // Forward lagi ke Library: posisi 250 pulih.
    scrollToSpy.mockClear();
    mockScrollY = 0;
    window.history.pushState(null, '', '/library');
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await vi.waitFor(() => {
      expect(scrollToSpy).toHaveBeenCalledWith(0, 250);
    });
  });
});
