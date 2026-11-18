import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { strings } from './strings/id';
import { getPlayerService } from './player/service';
import { initLibraryStore } from './store/library';
import MiniPlayer from './components/MiniPlayer';
import FullPlayer from './components/FullPlayer';
import BottomNav, { type NavCurrent } from './components/BottomNav';
import HomePage from './components/home/HomePage';
import type { LibraryTab } from './components/library/LibraryPage';

// Rute tersembunyi (tidak ditautkan dari mana pun di beranda):
// /spike = halaman uji integrasi P1, /player-test = halaman uji
// pemutar P2 (nada lokal), /library-test = halaman uji library
// P3 (isi 1.000 lagu contoh), /p4-test = halaman uji beranda P4
// (skenario "Lagu untukmu" deterministik). Lazy-load menjaga
// bundle awal tetap di bawah anggaran.
const SpikePage = lazy(() => import('./spike/SpikePage'));
const PlayerTestPage = lazy(() => import('./test-pages/PlayerTestPage'));
const LibraryTestPage = lazy(() => import('./test-pages/LibraryTestPage'));
const P4TestPage = lazy(() => import('./test-pages/P4TestPage'));
const LibraryPage = lazy(() => import('./components/library/LibraryPage'));
const PlaylistDetailPage = lazy(
  () => import('./components/library/PlaylistDetailPage'),
);
const SearchPage = lazy(() => import('./components/search/SearchPage'));
const BrowsePage = lazy(() => import('./components/browse/BrowsePage'));

type Route =
  | { name: 'home' }
  | { name: 'search'; query: string }
  | { name: 'browse'; browseId?: string; browseParams?: string }
  | { name: 'library'; tab?: LibraryTab }
  | { name: 'playlist'; id: number }
  | { name: 'spike' }
  | { name: 'player-test' }
  | { name: 'library-test' }
  | { name: 'p4-test' };

const LIBRARY_TABS: LibraryTab[] = [
  'songs',
  'albums',
  'artists',
  'playlists',
  'favorites',
  'history',
];

function parseRoute(pathname: string, search: string): Route {
  const path = pathname.replace(/\/$/, '') || '/';
  const params = new URLSearchParams(search);
  if (path === '/spike') return { name: 'spike' };
  if (path === '/player-test') return { name: 'player-test' };
  if (path === '/library-test') return { name: 'library-test' };
  if (path === '/p4-test') return { name: 'p4-test' };
  if (path === '/search') {
    return { name: 'search', query: params.get('q') ?? '' };
  }
  if (path === '/browse') return { name: 'browse' };
  const browse = /^\/browse\/([^/]+)$/.exec(path);
  if (browse) {
    return {
      name: 'browse',
      browseId: decodeURIComponent(browse[1]),
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

function LoadingPage() {
  return (
    <div className="min-h-dvh bg-black px-4 py-16 text-center text-sm text-zinc-400">
      Memuat halaman.
    </div>
  );
}

function useRoute(): [Route, (path: string) => void] {
  const [route, setRoute] = useState<Route>(() =>
    parseRoute(window.location.pathname, window.location.search),
  );
  useEffect(() => {
    const onPopState = (): void => {
      setRoute(parseRoute(window.location.pathname, window.location.search));
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  const navigate = useCallback((path: string) => {
    window.history.pushState(null, '', path);
    const [pathname, search] = path.split('?');
    setRoute(parseRoute(pathname, search ? `?${search}` : ''));
    window.scrollTo(0, 0);
  }, []);
  return [route, navigate];
}

export default function App() {
  // Service pemutar diinisialisasi sekali (idempotent, aman di
  // StrictMode): pulihkan antrean, pasang listener, nyalakan watchdog.
  useEffect(() => {
    getPlayerService().init();
    initLibraryStore();
  }, []);

  const [route, navigate] = useRoute();

  if (route.name === 'spike') {
    return (
      <Suspense fallback={<LoadingPage />}>
        <SpikePage />
      </Suspense>
    );
  }
  if (route.name === 'player-test') {
    return (
      <Suspense fallback={<LoadingPage />}>
        <PlayerTestPage />
        <MiniPlayer />
        <FullPlayer />
      </Suspense>
    );
  }
  if (route.name === 'library-test') {
    return (
      <Suspense fallback={<LoadingPage />}>
        <LibraryTestPage />
        <MiniPlayer />
        <FullPlayer />
      </Suspense>
    );
  }
  if (route.name === 'p4-test') {
    return (
      <Suspense fallback={<LoadingPage />}>
        <P4TestPage />
        <MiniPlayer />
        <FullPlayer />
      </Suspense>
    );
  }

  const navCurrent: NavCurrent =
    route.name === 'search'
      ? 'search'
      : route.name === 'library' || route.name === 'playlist'
        ? 'library'
        : 'home';

  return (
    <div className="min-h-dvh bg-black text-zinc-100 min-[840px]:pl-[72px]">
      <header className="flex items-center px-4 py-3">
        <button
          type="button"
          onClick={() => navigate('/')}
          data-testid="nav-home-title"
          className="text-xl font-bold tracking-tight"
        >
          {strings.appName}
        </button>
      </header>
      {/* Padding bawah memberi ruang untuk bar putar (64 px) + bar
          navigasi (56 px) di HP; di desktop hanya bar putar. */}
      <main className="mx-auto max-w-2xl px-4 pb-40 pt-2 min-[840px]:pb-28">
        {route.name === 'home' ? (
          <HomePage onNavigate={navigate} />
        ) : (
          <Suspense fallback={<LoadingPage />}>
            {route.name === 'search' ? (
              <SearchPage
                initialQuery={route.query}
                onNavigate={navigate}
              />
            ) : route.name === 'browse' ? (
              <BrowsePage
                key={`${route.browseId ?? 'home'}-${route.browseParams ?? ''}`}
                browseId={route.browseId}
                browseParams={route.browseParams}
                onNavigate={navigate}
              />
            ) : route.name === 'library' ? (
              <LibraryPage
                key={route.tab ?? 'songs'}
                onNavigate={navigate}
                initialTab={route.tab}
              />
            ) : (
              <PlaylistDetailPage
                playlistId={route.id}
                onNavigate={navigate}
              />
            )}
          </Suspense>
        )}
      </main>
      <BottomNav current={navCurrent} onNavigate={navigate} />
      <MiniPlayer withNav />
      <FullPlayer />
    </div>
  );
}
