/**
 * State UI Library (Zustand).
 *
 * `version` naik setiap kali layanan library mengubah data, jadi
 * komponen cukup berlangganan angka ini untuk memuat ulang daftar.
 * `sort` adalah urutan daftar lagu, disimpan di app_meta supaya
 * bertahan setelah browser ditutup.
 */
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import {
  getLibraryService,
  type LibraryService,
  type SongSort,
} from '../data/library';

/** Kunci app_meta untuk urutan daftar lagu (dipakai ekspor backup P8). */
export const SORT_META_KEY = 'songSort';

interface LibraryUiState {
  version: number;
  sort: SongSort;
  sortLoaded: boolean;
  setSort: (sort: SongSort) => void;
  bump: () => void;
}

export const useLibraryStore = create<LibraryUiState>()((set) => ({
  version: 0,
  sort: 'newest',
  sortLoaded: false,
  setSort: (sort) => {
    set({ sort });
    void getLibraryService()
      .then((service) => service.setMeta(SORT_META_KEY, sort))
      .catch(() => undefined);
  },
  bump: () => set((s) => ({ version: s.version + 1 })),
}));

let wired = false;

/**
 * Sambungkan store ke layanan library sekali (dipanggil App).
 * Memuat urutan tersimpan dan menaikkan `version` di tiap
 * perubahan data. Gagal buka database ditangani komponen
 * (mereka menampilkan keadaan galat sendiri).
 */
export function initLibraryStore(): void {
  if (wired) return;
  wired = true;
  void getLibraryService()
    .then(async (service) => {
      service.subscribe(() => useLibraryStore.getState().bump());
      const sort = await service.getMeta(SORT_META_KEY);
      if (sort === 'byName' || sort === 'mostPlayed' || sort === 'newest') {
        useLibraryStore.setState({ sort, sortLoaded: true });
      } else {
        useLibraryStore.setState({ sortLoaded: true });
      }
    })
    .catch(() => {
      useLibraryStore.setState({ sortLoaded: true });
    });
}

/** Layanan library untuk komponen: null selagi memuat atau gagal. */
export function useLibraryService(): {
  service: LibraryService | null;
  dbError: boolean;
} {
  const [service, setService] = useState<LibraryService | null>(null);
  const [dbError, setDbError] = useState(false);
  useEffect(() => {
    let alive = true;
    getLibraryService()
      .then((s) => {
        if (alive) setService(s);
      })
      .catch(() => {
        if (alive) setDbError(true);
      });
    return () => {
      alive = false;
    };
  }, []);
  return { service, dbError };
}
