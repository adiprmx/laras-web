import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { strings } from './strings/id';
import { getPlayerService } from './player/service';
import { initLibraryStore } from './store/library';
import MiniPlayer from './components/MiniPlayer';
import FullPlayer from './components/FullPlayer';
import TrySongs from './components/TrySongs';

// Rute tersembunyi (tidak ditautkan dari mana pun di beranda):
// /spike = halaman uji integrasi P1, /player-test = halaman uji
// pemutar P2 (nada lokal), /library-test = halaman uji library
// P3 (isi 1.000 lagu contoh). Lazy-load menjaga bundle awal
// tetap di bawah anggaran.
const SpikePage = lazy(() => import('./spike/SpikePage'));
const PlayerTestPage = lazy(() => import('./test-pages/PlayerTestPage'));
const LibraryTestPage = lazy(() => import('./test-pages/LibraryTestPage'));
const LibraryPage = lazy(() => import('./components/library/LibraryPage'));
const PlaylistDetailPage = lazy(
  () => import('./components/library/PlaylistDetailPage'),
);

type Route =
  | { name: 'home' }
  | { name: 'library' }
  | { name: 'playlist'; id: number }
  | { name: 'spike' }
  | { name: 'player-test' }
  | { name: 'library-test' };

function parseRoute(pathname: string): Route {
  const path = pathname.replace(/\/$/, '') || '/';
  if (path === '/spike') return { name: 'spike' };
  if (path === '/player-test') return { name: 'player-test' };
  if (path === '/library-test') return { name: 'library-test' };
  if (path === '/library') return { name: 'library' };
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
    parseRoute(window.location.pathname),
  );
  useEffect(() => {
    const onPopState = (): void => {
      setRoute(parseRoute(window.location.pathname));
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  const navigate = useCallback((path: string) => {
    window.history.pushState(null, '', path);
    setRoute(parseRoute(path));
    window.scrollTo(0, 0);
  }, []);
  return [route, navigate];
}

// P3: beranda berisi seksi "Coba pemutar" + navigasi ke Library.
// Pencarian penuh (jaringan) hadir di P4; pencarian lokal ada
// di dalam Library.
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

  const onLibrary = route.name === 'library' || route.name === 'playlist';

  return (
    <div className="min-h-dvh bg-black text-zinc-100">
      <header className="flex items-center justify-between px-4 py-3">
        <button
          type="button"
          onClick={() => navigate('/')}
          data-testid="nav-home-title"
          className="text-xl font-bold tracking-tight"
        >
          {strings.appName}
        </button>
        <nav aria-label="Navigasi utama" className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => navigate('/')}
            aria-current={route.name === 'home' ? 'page' : undefined}
            data-testid="nav-home"
            className={`h-11 rounded-full px-4 text-sm font-medium transition-colors active:scale-95 ${
              route.name === 'home'
                ? 'bg-white text-black'
                : 'text-zinc-400 hover:text-zinc-100'
            }`}
          >
            {strings.home}
          </button>
          <button
            type="button"
            onClick={() => navigate('/library')}
            aria-current={onLibrary ? 'page' : undefined}
            data-testid="nav-library"
            className={`h-11 rounded-full px-4 text-sm font-medium transition-colors active:scale-95 ${
              onLibrary
                ? 'bg-white text-black'
                : 'text-zinc-400 hover:text-zinc-100'
            }`}
          >
            {strings.library}
          </button>
        </nav>
      </header>
      {/* Padding bawah memberi ruang untuk bar putar (64 px + garis). */}
      <main className="mx-auto max-w-2xl px-4 pb-28 pt-4">
        {route.name === 'home' ? (
          <div className="pt-4">
            <div className="flex items-center justify-center gap-2">
              <input
                type="search"
                placeholder={strings.searchPlaceholder}
                aria-label={strings.searchPlaceholder}
                disabled
                className="h-11 w-full max-w-sm rounded-xl border border-white/10 bg-zinc-900 px-4 text-sm text-zinc-100 placeholder:text-zinc-500 disabled:opacity-50"
              />
              <button
                type="button"
                disabled
                className="h-11 shrink-0 rounded-xl bg-white px-4 text-sm font-medium text-black disabled:opacity-50"
              >
                {strings.searchButton}
              </button>
            </div>
            <p className="mt-4 text-center text-xs text-zinc-400">
              {strings.searchNotReady}
            </p>
            <TrySongs />
          </div>
        ) : (
          <Suspense fallback={<LoadingPage />}>
            {route.name === 'library' ? (
              <LibraryPage onNavigate={navigate} />
            ) : (
              <PlaylistDetailPage
                playlistId={route.id}
                onNavigate={navigate}
              />
            )}
          </Suspense>
        )}
      </main>
      <MiniPlayer />
      <FullPlayer />
    </div>
  );
}
