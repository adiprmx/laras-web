/**
 * Daftar berjendela tanpa dependensi (P-Virtual).
 *
 * Daftar panjang (ribuan lagu/riwayat) di-render penuh oleh
 * React akan membuat DOM membengkak dan scroll tersendat di HP
 * murah. Komponen ini hanya me-render baris di sekitar viewport
 * (+ overscan) dan mengganti sisanya dengan spacer `<li>`
 * setinggi baris yang dilewati, sehingga tinggi total daftar
 * (dan posisi tombol "Muat lagi" di bawahnya) tetap sama.
 *
 * Tinggi baris DIUKUR dari DOM nyata (selisih offsetTop dua
 * baris berurutan — sudah termasuk border divide-y), bukan
 * ditebak dari CSS: bila CSS berubah, pengukuran ikut benar.
 * Bila pengukuran menghasilkan 0 (jsdom, daftar tersembunyi),
 * virtualisasi NONAKTIF dan semua baris di-render — degradasi
 * aman, bukan daftar kosong. Daftar di bawah ambang batas juga
 * selalu di-render penuh (E2E me-seed maks. 100 baris).
 *
 * Batasan yang diketahui: baris yang keluar viewport di-unmount,
 * jadi fokus keyboard di dalam baris yang menghilang akan hilang
 * (perilaku standar semua virtual list).
 */
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  computeWindow,
  VIRTUAL_LIST_ESTIMATED_HEIGHT,
  VIRTUAL_LIST_OVERSCAN,
  VIRTUAL_LIST_THRESHOLD,
  type VirtualWindow,
} from './virtualList';

interface VirtualListProps<T> {
  items: T[];
  /** Render satu baris (HARUS mengembalikan <li> — anak langsung <ul>). */
  renderItem: (item: T, index: number) => ReactNode;
  keyOf: (item: T, index: number) => string | number;
  estimatedItemHeight?: number;
  overscan?: number;
  threshold?: number;
  testId?: string;
  className?: string;
}

export default function VirtualList<T>({
  items,
  renderItem,
  keyOf,
  estimatedItemHeight = VIRTUAL_LIST_ESTIMATED_HEIGHT,
  overscan = VIRTUAL_LIST_OVERSCAN,
  threshold = VIRTUAL_LIST_THRESHOLD,
  testId,
  className,
}: VirtualListProps<T>): ReactNode {
  // Tinggi baris terukur (null = belum terukur).
  const [stride, setStride] = useState<number | null>(null);
  // True bila pengukuran gagal (jsdom / tersembunyi): render semua.
  const [disabled, setDisabled] = useState(false);
  // Nama state `win` (bukan `window`): `window` global masih
  // dibutuhkan di initializer ini (innerHeight).
  const [win, setWin] = useState<VirtualWindow>(() =>
    computeWindow({
      scrollTop: 0,
      viewportHeight:
        typeof window !== 'undefined' ? window.innerHeight : 800,
      itemHeight: estimatedItemHeight,
      total: items.length,
      overscan,
    }),
  );
  const listRef = useRef<HTMLUListElement | null>(null);
  const rafRef = useRef<number | null>(null);

  const virtualized = !disabled && items.length > threshold;

  const recompute = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const h = stride ?? estimatedItemHeight;
    const rect = el.getBoundingClientRect();
    // Bila daftar belum punya tinggi di layout (tersembunyi),
    // jangan persempit jendela — render dari atas saja.
    const scrollTop = rect.height === 0 ? 0 : Math.max(0, -rect.top);
    setWin((prev) => {
      const next = computeWindow({
        scrollTop,
        viewportHeight: window.innerHeight,
        itemHeight: h,
        total: items.length,
        overscan,
      });
      return next.start === prev.start && next.end === prev.end
        ? prev
        : next;
    });
  }, [stride, estimatedItemHeight, items.length, overscan]);

  // Ukur stride dari dua baris pertama yang ter-render.
  // Selisih offsetTop sudah termasuk border divide-y, jadi
  // spacer start*h tepat sama dengan tinggi baris yang dilewati.
  useLayoutEffect(() => {
    if (disabled || stride !== null) return;
    const el = listRef.current;
    if (!el) return;
    const rows = [...el.children].filter(
      (c) => c.tagName === 'LI' && c.getAttribute('aria-hidden') !== 'true',
    ) as HTMLElement[];
    if (rows.length >= 2) {
      const first = rows[0] as HTMLElement;
      const second = rows[1] as HTMLElement;
      const measured = second.offsetTop - first.offsetTop;
      if (measured > 0) {
        setStride(measured);
      } else {
        // Tanpa layout nyata (jsdom): nonaktifkan, render semua.
        setDisabled(true);
      }
      return;
    }
    if (rows.length === 1) {
      const only = rows[0] as HTMLElement;
      if (only.offsetHeight > 0) {
        setStride(only.offsetHeight);
      } else {
        setDisabled(true);
      }
    }
  }, [disabled, stride]);

  // Hitung ulang saat scroll/resize (rAF-throttle) + saat
  // jumlah item / stride berubah.
  useEffect(() => {
    if (!virtualized) return;
    recompute();
    const onScroll = (): void => {
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        recompute();
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [virtualized, recompute]);

  if (!virtualized) {
    return (
      <ul ref={listRef} className={className} data-testid={testId}>
        {items.map((item, index) => (
          <Fragment key={keyOf(item, index)}>
            {renderItem(item, index)}
          </Fragment>
        ))}
      </ul>
    );
  }

  const h = stride ?? estimatedItemHeight;
  const { start, end } = win;
  return (
    <ul ref={listRef} className={className} data-testid={testId}>
      {/* Spacer atas: tingginya tepat start baris yang dilewati.
          Spacer bawah mendapat border-top divide-y (+1px) —
          galat 1px di ujung bawah daftar, diabaikan. */}
      {start > 0 && (
        <li aria-hidden="true" style={{ height: start * h }} />
      )}
      {items.slice(start, end).map((item, i) => (
        <Fragment key={keyOf(item, start + i)}>
          {renderItem(item, start + i)}
        </Fragment>
      ))}
      {end < items.length && (
        <li aria-hidden="true" style={{ height: (items.length - end) * h }} />
      )}
    </ul>
  );
}
