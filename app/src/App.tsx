import { Suspense, lazy } from 'react';
import { strings } from './strings/id';

// Rute /spike TERSEMBUNYI: halaman uji integrasi P1, hanya untuk
// verifikasi manual dari browser nyata. Tidak ditautkan dari mana pun
// di beranda. Lazy-load menjaga bundle awal tetap di bawah anggaran.
const SpikePage = lazy(() => import('./spike/SpikePage'));

function isSpikeRoute(): boolean {
  const path = window.location.pathname;
  return path === '/spike' || path === '/spike/';
}

// P0: skeleton beranda — kosong yang jujur, tanpa data contoh.
// P2-P4 mengisi beranda dengan seksi nyata (lokal dulu, jaringan belakangan).
export default function App() {
  if (isSpikeRoute()) {
    return (
      <Suspense
        fallback={
          <div className="min-h-dvh bg-black px-4 py-16 text-center text-sm text-zinc-400">
            Memuat halaman uji.
          </div>
        }
      >
        <SpikePage />
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
      <main className="mx-auto max-w-2xl px-4 py-16 text-center">
        <h2 className="text-2xl font-semibold tracking-tight">{strings.homeEmptyTitle}</h2>
        <p className="mx-auto mt-3 max-w-prose text-sm leading-relaxed text-zinc-400">
          {strings.homeEmptyBody}
        </p>
        <div className="mt-8 flex items-center justify-center gap-2">
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
        <p className="mt-4 text-xs text-zinc-500">{strings.searchNotReady}</p>
      </main>
    </div>
  );
}
