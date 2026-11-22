/**
 * Matematika daftar berjendela (P-Virtual) — dipisah dari
 * komponen supaya berkas komponen hanya mengekspor komponen
 * (react-refresh/only-export-components).
 */

export interface VirtualWindow {
  /** Indeks baris pertama yang di-render (inklusif). */
  start: number;
  /** Indeks baris terakhir yang di-render (eksklusif). */
  end: number;
}

/**
 * Hitung jendela baris yang terlihat. Fungsi murni (bisa
 * diuji tanpa DOM): scrollTop = piksel daftar yang sudah lewat
 * atas viewport; viewportHeight = tinggi viewport.
 */
export function computeWindow(args: {
  scrollTop: number;
  viewportHeight: number;
  itemHeight: number;
  total: number;
  overscan: number;
}): VirtualWindow {
  const { scrollTop, viewportHeight, itemHeight, total, overscan } = args;
  if (total <= 0 || itemHeight <= 0) return { start: 0, end: 0 };
  const start = Math.max(
    0,
    Math.floor(scrollTop / itemHeight) - overscan,
  );
  const end = Math.min(
    total,
    Math.ceil((scrollTop + viewportHeight) / itemHeight) + overscan,
  );
  return { start, end: Math.max(end, start) };
}

/** Di bawah jumlah ini, daftar selalu di-render penuh. */
export const VIRTUAL_LIST_THRESHOLD = 150;
/** Tinggi baris perkiraan sebelum pengukuran pertama (SongRow ≈ 72px). */
export const VIRTUAL_LIST_ESTIMATED_HEIGHT = 72;
/** Baris tambahan di atas/bawah viewport (anti-kedip saat scroll cepat). */
export const VIRTUAL_LIST_OVERSCAN = 10;
