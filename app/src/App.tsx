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
// /player-test = halaman uji pemutar P2 (nada lokal),
// /library-test = halaman uji library P3 (isi 1.000 lagu contoh),
// /p4-test = halaman uji beranda P4 (skenario "Lagu untukmu"
// deterministik),
// /p5-test = halaman uji unduhan P5 (isi 10 lagu + antre unduh).
// Keempatnya DEV-ONLY (Red 1 H1): gerbang
// `import.meta.env.DEV` di bawah membuat rute + lazy import-nya
// dihapus total dari build produksi oleh tree-shaking, sehingga
// chunk *TestPage* tidak ada di dist/ dan pengunjung produksi
// tidak bisa membuka halaman destruktif ini. E2E berjalan
// terhadap server dev supaya seeder ini tetap tersedia; gerbang
// CI di .github/workflows/ci.yml menggagalkan build bila chunk
// *TestPage* lolos ke dist/ produksi.
//
// PENGECUALIAN (keputusan koordinator, mengikat): /spike BOLEH
// tetap di produksi. Itu alat verifikasi §5 yang dijalankan
// koordinator dari preview, non-destruktif (hanya memutar lagu
// kanari dan menyalin laporan), bukan halaman uji destruktif.
const SpikePage = lazy(() => import('./spike/SpikePage'));
const PlayerTestPage = import.meta.env.DEV
  ? lazy(() => import('./test-pages/PlayerTestPage'))
  : null;
const LibraryTestPage = import.meta.env.DEV
  ? lazy(() => import('./test-pages/LibraryTestPage'))
  : null;
const P4TestPage = import.meta.env.DEV
  ? lazy(() => import('./test-pages/P4TestPage'))
  : null;
const P5TestPage = import.meta.env.DEV
  ? lazy(() => import('./test-pages/P5TestPage'))
  : null;
const DownloadsPage = lazy(
  () => import('./components/downloads/DownloadsPage'),
);
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
  | { name: 'downloads' }
  | { name: 'spike' }
  | { name: 'player-test' }
  | { name: 'library-test' }
  | { name: 'p4-test' }
  | { name: 'p5-test' };

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
  // Rute uji hanya ada di build dev (Red 1 H1): di produksi
  // keempatnya jatuh ke beranda di bawah.
  if (import.meta.env.DEV) {
    if (path === '/player-test') return { name: 'player-test' };
    if (path === '/library-test') return { name: 'library-test' };
    if (path === '/p4-test') return { name: 'p4-test' };
    if (path === '/p5-test') return { name: 'p5-test' };
  }
  if (path === '/downloads') return { name: 'downloads' };
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
    // Manajer unduhan (P5): rekonsiliasi Dexie vs Cache Storage
    // lalu lanjutkan antrean. Impor dinamis supaya modul unduhan
    // tidak masuk bundle awal. Gagal start tidak merusak app.
    void import('./downloads/downloadManager')
      .then(({ getDownloadManager }) => getDownloadManager())
      .then((manager) => manager.init())
      .catch(() => undefined);
  }, []);

  const [route, navigate] = useRoute();

  if (route.name === 'spike') {
    return (
      <Suspense fallback={<LoadingPage />}>
        <SpikePage />
      </Suspense>
    );
  }
  if (route.name === 'player-test' && PlayerTestPage) {
    return (
      <Suspense fallback={<LoadingPage />}>
        <PlayerTestPage />
        <MiniPlayer />
        <FullPlayer />
      </Suspense>
    );
  }
  if (route.name === 'library-test' && LibraryTestPage) {
    return (
      <Suspense fallback={<LoadingPage />}>
        <LibraryTestPage />
        <MiniPlayer />
        <FullPlayer />
      </Suspense>
    );
  }
  if (route.name === 'p4-test' && P4TestPage) {
    return (
      <Suspense fallback={<LoadingPage />}>
        <P4TestPage />
        <MiniPlayer />
        <FullPlayer />
      </Suspense>
    );
  }
  if (route.name === 'p5-test' && P5TestPage) {
    return (
      <Suspense fallback={<LoadingPage />}>
        <P5TestPage />
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
        : route.name === 'downloads'
          ? 'downloads'
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
            ) : route.name === 'downloads' ? (
              <DownloadsPage onNavigate={navigate} />
            ) : route.name === 'library' ? (
              <LibraryPage
                key={route.tab ?? 'songs'}
                onNavigate={navigate}
                initialTab={route.tab}
              />
            ) : route.name === 'playlist' ? (
              <PlaylistDetailPage
                playlistId={route.id}
                onNavigate={navigate}
              />
            ) : (
              // Tidak terjangkau: rute uji sudah ditangani di atas
              // (atau tidak ada di build produksi) — beranda
              // sebagai cadangan bila pengetikan rute meleset.
              <HomePage onNavigate={navigate} />
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
