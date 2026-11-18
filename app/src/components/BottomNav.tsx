/**
 * Navigasi utama: bar bawah di HP, rail kiri di lebar 840 px ke
 * atas (arsitektur §3.8). Satu DOM yang sama berubah bentuk lewat
 * CSS — bukan dua komponen — supaya testid tiap tombol unik di
 * semua ukuran layar.
 *
 * Empat tab (P5): Beranda, Cari, Library, Unduhan.
 */
import { Books, Download, House, MagnifyingGlass } from '@phosphor-icons/react';
import { strings } from '../strings/id';

export type NavCurrent = 'home' | 'search' | 'library' | 'downloads';

interface BottomNavProps {
  current: NavCurrent;
  onNavigate: (path: string) => void;
}

const ITEMS: Array<{
  id: NavCurrent;
  label: string;
  path: string;
  testId: string;
  icon: (active: boolean) => React.ReactNode;
}> = [
  {
    id: 'home',
    label: strings.home,
    path: '/',
    testId: 'nav-home',
    icon: (active) => (
      <House size={22} weight={active ? 'fill' : 'regular'} aria-hidden="true" />
    ),
  },
  {
    id: 'search',
    label: strings.search,
    path: '/search',
    testId: 'nav-search',
    icon: () => (
      <MagnifyingGlass size={22} aria-hidden="true" />
    ),
  },
  {
    id: 'library',
    label: strings.library,
    path: '/library',
    testId: 'nav-library',
    icon: (active) => (
      <Books size={22} weight={active ? 'fill' : 'regular'} aria-hidden="true" />
    ),
  },
  {
    id: 'downloads',
    label: strings.downloads,
    path: '/downloads',
    testId: 'nav-downloads',
    icon: (active) => (
      <Download size={22} weight={active ? 'fill' : 'regular'} aria-hidden="true" />
    ),
  },
];

export default function BottomNav({ current, onNavigate }: BottomNavProps) {
  return (
    <nav
      aria-label="Navigasi utama"
      data-testid="bottom-nav"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-black/95 backdrop-blur-md min-[840px]:inset-x-auto min-[840px]:bottom-0 min-[840px]:left-0 min-[840px]:top-0 min-[840px]:w-[72px] min-[840px]:border-r min-[840px]:border-t-0"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      <div className="flex h-14 items-stretch justify-around min-[840px]:h-full min-[840px]:flex-col min-[840px]:items-center min-[840px]:justify-start min-[840px]:gap-2 min-[840px]:pt-4">
        <span
          aria-hidden="true"
          className="hidden h-10 w-10 items-center justify-center rounded-xl bg-white text-lg font-bold text-black min-[840px]:mb-4 min-[840px]:flex"
        >
          L
        </span>
        {ITEMS.map((item) => {
          const active = current === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onNavigate(item.path)}
              aria-current={active ? 'page' : undefined}
              data-testid={item.testId}
              className={`flex min-w-[64px] flex-1 flex-col items-center justify-center gap-0.5 transition-colors active:scale-95 min-[840px]:h-14 min-[840px]:w-14 min-[840px]:flex-none min-[840px]:rounded-xl ${
                active
                  ? 'text-zinc-100 min-[840px]:bg-white/10'
                  : 'text-zinc-400 hover:text-zinc-100'
              }`}
            >
              {item.icon(active)}
              <span className="text-[11px] font-medium leading-none">
                {item.label}
              </span>
              <span
                aria-hidden="true"
                className={`mt-1 h-1 w-1 rounded-full bg-white min-[840px]:hidden ${
                  active ? 'opacity-100' : 'opacity-0'
                }`}
              />
            </button>
          );
        })}
      </div>
    </nav>
  );
}
