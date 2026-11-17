/**
 * MediaSession: metadata + kontrol lock screen, headset, dan
 * tombol media (PRD Must 3, arsitektur §3.3).
 *
 * Pelajaran S3/S9: Chromium TIDAK memperbarui
 * `navigator.mediaSession.playbackState` otomatis dari elemen
 * media (tetap 'none' saat lagu berbunyi). App WAJIB menyetel
 * playbackState eksplisit di tiap perubahan status putar.
 */
import type { Track } from './types';

export interface MediaSessionHandlers {
  onPlay: () => void;
  onPause: () => void;
  onNext: () => void;
  onPrev: () => void;
  onSeekTo: (seconds: number) => void;
}

export class MediaSessionManager {
  private supported: boolean;
  private handlersSet = false;

  constructor() {
    this.supported =
      typeof navigator !== 'undefined' && 'mediaSession' in navigator;
  }

  get isSupported(): boolean {
    return this.supported;
  }

  /** Daftarkan action handler sekali (idempotent). */
  setHandlers(handlers: MediaSessionHandlers): void {
    if (!this.supported || this.handlersSet) return;
    const ms = navigator.mediaSession;
    try {
      ms.setActionHandler('play', handlers.onPlay);
      ms.setActionHandler('pause', handlers.onPause);
      ms.setActionHandler('previoustrack', handlers.onPrev);
      ms.setActionHandler('nexttrack', handlers.onNext);
      ms.setActionHandler('seekto', (details) => {
        if (typeof details.seekTime === 'number') {
          handlers.onSeekTo(details.seekTime);
        }
      });
      this.handlersSet = true;
    } catch {
      // Browser yang menolak handler tertentu tetap bisa memutar.
      this.handlersSet = true;
    }
  }

  /** Metadata lagu saat ini (judul, artis, album, sampul). */
  setTrack(track: Track | null): void {
    if (!this.supported) return;
    try {
      if (!track) {
        navigator.mediaSession.metadata = null;
        return;
      }
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist ?? '',
        album: track.album ?? '',
        artwork: track.artwork
          ? [{ src: track.artwork, sizes: '480x360', type: 'image/jpeg' }]
          : [],
      });
    } catch {
      // Metadata gagal disetel bukan galat fatal pemutaran.
    }
  }

  /** Status putar: WAJIB disetel eksplisit (lihat catatan atas). */
  setPlaybackState(state: 'playing' | 'paused' | 'none'): void {
    if (!this.supported) return;
    try {
      navigator.mediaSession.playbackState = state;
    } catch {
      // Abaikan: status lock screen bukan bagian kritis pemutaran.
    }
  }

  /** Posisi putar untuk bilah progres di lock screen. */
  setPositionState(
    position: number,
    duration: number,
    playbackRate: number,
  ): void {
    if (!this.supported) return;
    if (!Number.isFinite(duration) || duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate,
        position: Math.min(Math.max(0, position), duration),
      });
    } catch {
      // Beberapa browser menolak bila metadata belum tersetel.
    }
  }

  clear(): void {
    this.setTrack(null);
    this.setPlaybackState('none');
  }
}
