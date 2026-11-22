import { Suspense, lazy, useEffect } from 'react';
import { Gear } from '@phosphor-icons/react';
import { strings } from './strings/id';
import { getPlayerService } from './player/service';
import { initLibraryStore } from './store/library';
import MiniPlayer from './components/MiniPlayer';
import FullPlayer from './components/FullPlayer';
import BottomNav, { type NavCurrent } from './components/BottomNav';
import AppLink from './components/AppLink';
import HomePage from './components/home/HomePage';
import { useRoute } from './router/router';
import { registerRoutePreload } from './router/prefetch';

// Rute tersembunyi (tidak ditautkan dari mana pun di beranda):
// /player-test = halaman uji pemutar P2 (nada lokal),
// /library-test = halaman uji library P3 (isi 1.000 lagu contoh),
// /p4-test = halaman uji beranda P4 (skenario "Lagu untukmu"
// deterministik),
// /p5-test = halaman uji unduhan P5 (isi 10 lagu + antre unduh).
// /p6-test = halaman uji ketahanan P6 (seed banner + snapshot).
// /p7-test = halaman uji fitur Should P7 (lirik, EQ, timer tidur).
// /p8-test = halaman uji Backup dan Ekspor P8 (seed data contoh).
// Kedelapannya DEV-ONLY (Red 1 H1): gerbang
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
const loadSpikePage = () => import('./spike/SpikePage');
const SpikePage = lazy(loadSpikePage);
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
const P6TestPage = import.meta.env.DEV
  ? lazy(() => import('./test-pages/P6TestPage'))
  : null;
const P7TestPage = import.meta.env.DEV
  ? lazy(() => import('./test-pages/P7TestPage'))
  : null;
const P8TestPage = import.meta.env.DEV
  ? lazy(() => import('./test-pages/P8TestPage'))
  : null;
const loadDownloadsPage = () =>
  import('./components/downloads/DownloadsPage');
const DownloadsPage = lazy(loadDownloadsPage);
const loadSettingsPage = () => import('./components/settings/SettingsPage');
const SettingsPage = lazy(loadSettingsPage);
const loadLibraryPage = () => import('./components/library/LibraryPage');
const LibraryPage = lazy(loadLibraryPage);
const loadPlaylistDetailPage = () =>
  import('./components/library/PlaylistDetailPage');
const PlaylistDetailPage = lazy(loadPlaylistDetailPage);
const loadSearchPage = () => import('./components/search/SearchPage');
const SearchPage = lazy(loadSearchPage);
const loadBrowsePage = () => import('./components/browse/BrowsePage');
const BrowsePage = lazy(loadBrowsePage);

// P-Links: daftarkan pemuat untuk prefetch on-intent (hover /
// fokus di AppLink). Awalan terpanjang menang ('/library/playlist'
// mengalahkan '/library').
registerRoutePreload('/spike', loadSpikePage);
registerRoutePreload('/downloads', loadDownloadsPage);
registerRoutePreload('/settings', loadSettingsPage);
registerRoutePreload('/library', loadLibraryPage);
registerRoutePreload('/library/playlist', loadPlaylistDetailPage);
registerRoutePreload('/search', loadSearchPage);
registerRoutePreload('/browse', loadBrowsePage);

function LoadingPage() {
  return (
    <div className="min-h-dvh bg-black px-4 py-16 text-center text-sm text-zinc-400">
      Memuat halaman.
    </div>
  );
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
    // Ketahanan (P6): muat kondisi banner dari storage, lalu
    // cek kanari harian di latar sesudah jeda 20 detik (tidak
    // berebut jaringan dengan muat awal halaman). Impor dinamis
    // supaya modul ketahanan tidak masuk bundle awal; gagal
    // start tidak merusak app.
    void import('./resilience/store')
      .then(({ useResilienceStore }) => {
        void useResilienceStore.getState().refresh();
        window.setTimeout(() => {
          void useResilienceStore
            .getState()
            .runDailyCanaryIfDue();
        }, 20000);
      })
      .catch(() => undefined);
    // Sinkronisasi (P7 + P-PushDelta): periksa sesi + sinkron
    // BERSYARAT sekali di latar sesudah jeda 20 detik (tidak
    // berebut jaringan dengan muat awal) — diam bila tidak ada
    // perubahan lokal dan sinkron terakhir masih segar.
    // Best-effort: gagal tidak mengganggu pemutaran; pengguna
    // yang belum masuk tidak merasakan apa pun. Impor dinamis
    // supaya modul sync tidak masuk bundle awal.
    window.setTimeout(() => {
      void import('./sync/syncStore')
        .then(({ useSyncStore }) => useSyncStore.getState().bootSync())
        .catch(() => undefined);
    }, 20000);
    // Kembali online: kejar ketinggalan (bersyarat juga).
    const onOnline = (): void => {
      void import('./sync/syncStore')
        .then(({ useSyncStore }) => useSyncStore.getState().bootSync())
        .catch(() => undefined);
    };
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('online', onOnline);
    };
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
  if (route.name === 'p6-test' && P6TestPage) {
    return (
      <Suspense fallback={<LoadingPage />}>
        <P6TestPage />
        <MiniPlayer />
        <FullPlayer />
      </Suspense>
    );
  }
  if (route.name === 'p7-test' && P7TestPage) {
    return (
      <Suspense fallback={<LoadingPage />}>
        <P7TestPage />
        <MiniPlayer />
        <FullPlayer />
      </Suspense>
    );
  }
  if (route.name === 'p8-test' && P8TestPage) {
    return (
      <Suspense fallback={<LoadingPage />}>
        <P8TestPage />
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
          : route.name === 'settings'
            ? 'settings'
            : 'home';

  return (
    <div className="min-h-dvh bg-black text-zinc-100 min-[840px]:pl-[72px]">
      <header className="flex items-center justify-between px-4 py-3">
        <AppLink
          to="/"
          onNavigate={navigate}
          testId="nav-home-title"
          className="text-xl font-bold tracking-tight"
        >
          {strings.appName}
        </AppLink>
        <AppLink
          to="/settings"
          onNavigate={navigate}
          ariaLabel={strings.settings}
          testId="nav-settings"
          className="flex h-11 w-11 items-center justify-center rounded-full text-zinc-400 transition-colors hover:text-zinc-100 active:scale-95"
        >
          <Gear size={22} aria-hidden="true" />
        </AppLink>
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
            ) : route.name === 'settings' ? (
              <SettingsPage onNavigate={navigate} />
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
