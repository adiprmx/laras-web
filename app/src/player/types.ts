/**
 * Tipe inti pemutar Laras Web (P2).
 *
 * Satu lagu bisa datang dari dua sumber: streaming YouTube Music
 * (di-resolve dari videoId) atau audio lokal (URL same-origin atau
 * blob, mis. nada uji dan kelak file unduhan). Pemutar tidak pernah
 * menyimpan URL stream: yang disimpan hanya videoId, URL di-resolve
 * ulang tiap giliran lagu tiba (PRD B2.1).
 */

export type TrackSource =
  | { kind: 'stream'; videoId: string }
  | { kind: 'local'; url: string };

export interface Track {
  /** Kunci stabil: videoId untuk stream, URL untuk lokal. */
  id: string;
  title: string;
  artist?: string;
  album?: string;
  /** URL sampul (host ytimg yang diizinkan) atau undefined. */
  artwork?: string;
  /** Durasi dalam detik, bila diketahui sebelum lagu dimuat. */
  durationSeconds?: number;
  source: TrackSource;
}

export type RepeatMode = 'off' | 'all' | 'one';

export type PlayerStatus =
  | 'idle'
  | 'loading'
  | 'playing'
  | 'paused'
  | 'error';

/** Kecepatan putar kanonis (PRD B2): 7 pilihan. */
export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

/** Jalur audio aktif: lewat graph Web Audio atau langsung. */
export type AudioPath = 'direct' | 'graph';

/** Batas antrean (PRD B2): 200 item metadata. */
export const MAX_QUEUE_ITEMS = 200;

/** Ambang prev (PRD B2): posisi di atas ini kembali ke awal lagu. */
export const PREV_THRESHOLD_SECONDS = 3;

/** Bangun Track streaming dari videoId + judul + durasi. */
export function streamTrack(
  videoId: string,
  title: string,
  durationSeconds?: number,
  artwork?: string,
): Track {
  return {
    id: videoId,
    title,
    durationSeconds,
    artwork:
      artwork ?? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    source: { kind: 'stream', videoId },
  };
}

/** Bangun Track lokal dari URL + judul. */
export function localTrack(
  url: string,
  title: string,
  durationSeconds?: number,
): Track {
  return {
    id: url,
    title,
    durationSeconds,
    source: { kind: 'local', url },
  };
}
