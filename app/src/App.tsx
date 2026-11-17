import { Suspense, lazy, useEffect } from 'react';
import { strings } from './strings/id';
import { getPlayerService } from './player/service';
import MiniPlayer from './components/MiniPlayer';
import FullPlayer from './components/FullPlayer';
import TrySongs from './components/TrySongs';

// Rute tersembunyi (tidak ditautkan dari mana pun di beranda):
// /spike = halaman uji integrasi P1, /player-test = halaman uji
// pemutar P2 (nada lokal). Lazy-load menjaga bundle awal tetap
// di bawah anggaran.
const SpikePage = lazy(() => import('./spike/SpikePage'));
const PlayerTestPage = lazy(() => import('./test-pages/PlayerTestPage'));

function hiddenRoute(): 'spike' | 'player-test' | null {
  const path = window.location.pathname;
  if (path === '/spike' || path === '/spike/') return 'spike';
  if (path === '/player-test' || path === '/player-test/') {
    return 'player-test';
  }
  return null;
}

function LoadingPage() {
  return (
    <div className="min-h-dvh bg-black px-4 py-16 text-center text-sm text-zinc-400">
      Memuat halaman uji.
    </div>
  );
}

// P2: beranda berisi seksi "Coba pemutar" (5 lagu nyata) + pencarian
// yang masih nonaktif. P3-P4 mengisi beranda dengan konten nyata
// (lokal dulu, jaringan belakangan).
export default function App() {
  // Service pemutar diinisialisasi sekali (idempotent, aman di
  // StrictMode): pulihkan antrean, pasang listener, nyalakan watchdog.
  useEffect(() => {
    getPlayerService().init();
  }, []);

  const route = hiddenRoute();
  if (route === 'spike') {
    return (
      <Suspense fallback={<LoadingPage />}>
        <SpikePage />
      </Suspense>
    );
  }
  if (route === 'player-test') {
    return (
      <Suspense fallback={<LoadingPage />}>
        <PlayerTestPage />
        <MiniPlayer />
        <FullPlayer />
      </Suspense>
    );
  }
  return (
    <div className="min-h-dvh bg-black text-zinc-100">
      <header className="flex items-center justify-between px-4 py-3">
        <h1 className="text-xl font-bold tracking-tight">{strings.appName}</h1>
        <span className="rounded-full border border-white/10 px-2 py-1 text-[11px] text-zinc-400">
          {strings.comingSoon}
        </span>
      </header>
      {/* Padding bawah memberi ruang untuk bar putar (64 px + garis). */}
      <main className="mx-auto max-w-2xl px-4 pb-28 pt-8">
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
      </main>
      <MiniPlayer />
      <FullPlayer />
    </div>
  );
}
