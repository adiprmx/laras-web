import { create } from 'zustand';

// Store pemutar — P0: kerangka saja (antrean kosong, tanpa lagu).
// P2 mengisi logika pemutar (elemen audio, MediaSession, antrean 200 item).
export interface PlayerState {
  queueIds: string[];
  currentIndex: number;
  isPlaying: boolean;
}

export const usePlayerStore = create<PlayerState>(() => ({
  queueIds: [],
  currentIndex: -1,
  isPlaying: false,
}));
