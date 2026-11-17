/**
 * Store pemutar (Zustand). Store HANYA menyimpan state UI; semua
 * logika pemutaran hidup di PlayerService (src/player/service.ts).
 * Service menulis state lewat `setPlayerState`; komponen membaca
 * lewat selector dan memanggil aksi service, bukan memanggil
 * elemen audio langsung.
 */
import { create } from 'zustand';
import type {
  AudioPath,
  PlayerStatus,
  RepeatMode,
  Track,
} from '../player/types';

export interface PlayerState {
  /** Antrean (urutan asli). */
  queue: Track[];
  /** Urutan putar: indeks ke `queue`. Identitas bila shuffle mati. */
  order: number[];
  /** Posisi lagu saat ini di dalam `order`. -1 bila antrean kosong. */
  orderPos: number;
  status: PlayerStatus;
  /** Posisi putar detik (diperbarui dari event timeupdate). */
  position: number;
  /** Durasi lagu detik (0 bila belum diketahui). */
  duration: number;
  /** Ujung buffer detik (0 bila belum diketahui). */
  bufferedEnd: number;
  shuffle: boolean;
  repeat: RepeatMode;
  rate: number;
  volume: number;
  /** Jalur audio lagu saat ini (null bila belum ada lagu). */
  audioPath: AudioPath | null;
  /** Pesan galat untuk pengguna (null bila tidak ada). */
  errorMessage: string | null;
  /** Pesan info singkat (mis. putar otomatis diblokir browser). */
  notice: string | null;
  /** Layar pemutar penuh sedang terbuka. */
  fullPlayerOpen: boolean;
  /** Pesan pengatur suara (EQ) yang sedang ditampilkan. */
  eqNote: string | null;
  /** Penulis state untuk service. Komponen tidak memanggil ini. */
  setPlayerState: (patch: Partial<PlayerState>) => void;
  /** Aksi UI murni (bukan pemutaran). */
  setFullPlayerOpen: (open: boolean) => void;
  setEqNote: (note: string | null) => void;
  dismissNotice: () => void;
}

export const usePlayerStore = create<PlayerState>()((set) => ({
  queue: [],
  order: [],
  orderPos: -1,
  status: 'idle',
  position: 0,
  duration: 0,
  bufferedEnd: 0,
  shuffle: false,
  repeat: 'off',
  rate: 1,
  volume: 1,
  audioPath: null,
  errorMessage: null,
  notice: null,
  fullPlayerOpen: false,
  eqNote: null,
  setPlayerState: (patch) => set(patch),
  setFullPlayerOpen: (open) => set({ fullPlayerOpen: open }),
  setEqNote: (note) => set({ eqNote: note }),
  dismissNotice: () => set({ notice: null }),
}));

/** Lagu yang sedang diputar (atau null). Selector untuk komponen. */
export function selectCurrentTrack(state: PlayerState): Track | null {
  if (state.orderPos < 0 || state.orderPos >= state.order.length) return null;
  return state.queue[state.order[state.orderPos]] ?? null;
}
