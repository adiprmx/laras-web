/**
 * Router hand-rolled (dipindah dari App.tsx di P-Links,
 * Koordinator #18 — tanpa React Router: 8 rute tidak
 * membenarkan churn dependensi).
 *
 * - parseRoute: URL -> Route (dipakai useRoute + tes).
 * - useRoute: state rute + navigate() (pushState) + restorasi
 *   scroll manual (P-Links): browser tidak bisa memulihkan
 *   posisi gulir dengan benar karena konten dimuat malas
 *   (saat popstate, DOM masih fallback Suspense) — jadi posisi
 *   disimpan per URL dan dipulihkan sendiri sesudah render.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LibraryTab } from '../components/library/LibraryPage';

export type Route =
  | { name: 'home' }
  | { name: 'search'; query: string }
  | { name: 'browse'; browseId?: string; browseParams?: string }
  | { name: 'library'; tab?: LibraryTab }
  | { name: 'playlist'; id: number }
  | { name: 'downloads' }
  | { name: 'settings' }
  | { name: 'spike' }
  | { name: 'player-test' }
  | { name: 'library-test' }
  | { name: 'p4-test' }
  | { name: 'p5-test' }
  | { name: 'p6-test' }
  | { name: 'p7-test' }
  | { name: 'p8-test' };

const LIBRARY_TABS: LibraryTab[] = [
  'songs',
  'albums',
  'artists',
  'playlists',
  'favorites',
  'history',
];

export function parseRoute(pathname: string, search: string): Route {
  const path = pathname.replace(/\/$/, '') || '/';
  const params = new URLSearchParams(search);
  if (path === '/spike') return { name: 'spike' };
  // Rute uji hanya ada di build dev (Red 1 H1): di produksi
  // ketujuhnya jatuh ke beranda di bawah.
  if (import.meta.env.DEV) {
    if (path === '/player-test') return { name: 'player-test' };
    if (path === '/library-test') return { name: 'library-test' };
    if (path === '/p4-test') return { name: 'p4-test' };
    if (path === '/p5-test') return { name: 'p5-test' };
    if (path === '/p6-test') return { name: 'p6-test' };
    if (path === '/p7-test') return { name: 'p7-test' };
    if (path === '/p8-test') return { name: 'p8-test' };
  }
  if (path === '/downloads') return { name: 'downloads' };
  if (path === '/settings') return { name: 'settings' };
  if (path === '/search') {
    return { name: 'search', query: params.get('q') ?? '' };
  }
  if (path === '/browse') return { name: 'browse' };
  const browse = /^\/browse\/([^/]+)$/.exec(path);
  if (browse) {
    // decodeURIComponent melempar URIError untuk segmen persen
    // yang rusak (tautan crafted); tanpa tangkapan, lemparan di
    // initializer useState meruntuhkan seluruh app (Red 1 R2).
    // Segmen rusak berarti tautan tidak valid: ke beranda.
    let browseId: string;
    try {
      browseId = decodeURIComponent(browse[1]);
    } catch {
      return { name: 'home' };
    }
    return {
      name: 'browse',
      browseId,
      browseParams: params.get('params') ?? undefined,
    };
  }
  if (path === '/library') {
    const tab = params.get('tab');
    return {
      name: 'library',
      tab: LIBRARY_TABS.includes(tab as LibraryTab)
        ? (tab as LibraryTab)
        : undefined,
    };
  }
  const playlist = /^\/library\/playlist\/(\d+)$/.exec(path);
  if (playlist) return { name: 'playlist', id: Number(playlist[1]) };
  return { name: 'home' };
}

function currentUrl(): string {
  return window.location.pathname + window.location.search;
}

export function useRoute(): [Route, (path: string) => void] {
  const [route, setRoute] = useState<Route>(() =>
    parseRoute(window.location.pathname, window.location.search),
  );
  // P-Links: posisi gulir per URL (kunci = path + query).
  const positionsRef = useRef(new Map<string, number>());
  const urlRef = useRef(currentUrl());

  useEffect(() => {
    // Restorasi manual: mode 'auto' bawaan browser memulihkan
    // posisi SEBELUM konten malas selesai dimuat (DOM masih
    // fallback pendek) sehingga posisi terjepit ke 0.
    const prev = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';
    // Timer/frame tertunda dibatalkan saat unmount: tanpa ini,
    // callback 300 ms bisa jalan sesudah lingkungan (jsdom di
    // tes) dibongkar -> ReferenceError window is not defined
    // (unhandled error di suite Wave 2).
    // Set<number>: window.setTimeout mengembalikan number (DOM),
    // sementara ReturnType<typeof setTimeout> = NodeJS.Timeout
    // karena @types/node ikut terpasang — jangan pakai itu.
    const pendingTimers = new Set<number>();
    const pendingFrames = new Set<number>();
    const onPopState = (): void => {
      // Simpan posisi halaman yang ditinggalkan (untuk forward).
      positionsRef.current.set(urlRef.current, window.scrollY);
      const url = currentUrl();
      urlRef.current = url;
      setRoute(parseRoute(window.location.pathname, window.location.search));
      const y = positionsRef.current.get(url) ?? 0;
      // Pulihkan sesudah render: rAF ganda (≈ sesudah paint).
      // Ulangi sekali sesudah 300 ms untuk chunk malas yang baru
      // selesai dimuat — dibatalkan bila pengguna sudah menggulir
      // sendiri (scrollY bukan 0 lagi) atau posisi sudah benar.
      const frame1 = requestAnimationFrame(() => {
        pendingFrames.delete(frame1);
        const frame2 = requestAnimationFrame(() => {
          pendingFrames.delete(frame2);
          window.scrollTo(0, y);
        });
        pendingFrames.add(frame2);
      });
      pendingFrames.add(frame1);
      const timer = window.setTimeout(() => {
        pendingTimers.delete(timer);
        if (window.scrollY === 0 && y !== 0) window.scrollTo(0, y);
      }, 300);
      pendingTimers.add(timer);
    };
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
      pendingTimers.forEach((t) => window.clearTimeout(t));
      pendingTimers.clear();
      pendingFrames.forEach((f) => window.cancelAnimationFrame(f));
      pendingFrames.clear();
      window.history.scrollRestoration = prev;
    };
  }, []);

  const navigate = useCallback((path: string) => {
    positionsRef.current.set(urlRef.current, window.scrollY);
    urlRef.current = path;
    window.history.pushState(null, '', path);
    const [pathname, search] = path.split('?');
    setRoute(parseRoute(pathname, search ? `?${search}` : ''));
    window.scrollTo(0, 0);
  }, []);

  return [route, navigate];
}
