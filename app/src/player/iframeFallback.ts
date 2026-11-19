/**
 * Fallback pemutar YouTube (P3, desain lengkap di
 * docs/iframe-fallback.md).
 *
 * Bila resolve langsung gagal DAN cache D1 kosong, lagu tetap
 * bisa diputar lewat pemutar resmi YouTube di dalam iframe
 * (YouTube IFrame Player API) — tanpa resolve, tanpa CORS, tanpa
 * server, dari IP pengunjung sendiri.
 *
 * Modul ini berisi logika MURNI + pemuat API on-demand (boleh
 * diimpor tes tanpa DOM React):
 * - `shouldEnterIframeFallback`: gerbang masuk mode fallback.
 * - `loadYouTubeIframeApi`: muat script API sekali, on-demand
 *   (BUKAN di bundle awal — hanya diunduh saat fallback aktif).
 * - Registry kontroler: komponen pemutar mendaftarkan kontrol
 *   putar/jeda/cari-nya supaya PlayerService bisa mengarahkan
 *   tombol putar MiniPlayer/FullPlayer ke iframe saat mode
 *   fallback aktif.
 *
 * Aturan kebijakan YouTube yang mengikat implementasi (dokumen
 * resmi IFrame Player API, dibaca 19 Nov 2026):
 * - Pemutar WAJIB terlihat, viewport minimal 200x200 px.
 *   Dilarang menyembunyikan pemutar (display:none, ukuran 0)
 *   atau memakainya sebagai pemutar latar/audio saja.
 * - Dilarang menaruh elemen apa pun DI ATAS pemutar (overlay).
 *   Kontrol app sendiri wajib berada DI LUAR (di bawah) iframe.
 * - Dilarang memisahkan komponen audio dari videonya.
 * Komponen IframeFallbackPlayer.tsx menegakkan ketiganya.
 */
import { isLoginRequiredOnly } from '../resilience/retryLadder';
import type { PlayerStatus } from './types';

/** URL script API IFrame resmi YouTube. */
export const YOUTUBE_IFRAME_API_URL = 'https://www.youtube.com/iframe_api';

/** Batas waktu muat script API (milidetik). */
export const YOUTUBE_IFRAME_API_TIMEOUT_MS = 15 * 1000;

/** Kode status YT.PlayerState (dokumen resmi IFrame Player API). */
export const YT_PLAYER_STATE = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
} as const;

/**
 * Permukaan minimal YT.Player yang dipakai komponen. Sengaja
 * kecil: hanya method yang benar-benar dipanggil.
 */
export interface YoutubePlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead?: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  loadVideoById(videoId: string): void;
  destroy(): void;
}

export interface YoutubePlayerOptions {
  videoId: string;
  playerVars?: Record<string, string | number>;
  events?: {
    onReady?: () => void;
    onStateChange?: (event: { data: number }) => void;
    onError?: (event: { data: number | string }) => void;
  };
}

export interface YoutubeApi {
  Player: new (
    element: HTMLElement,
    options: YoutubePlayerOptions,
  ) => YoutubePlayer;
}

/**
 * Gerbang masuk mode fallback (dipakai PlayerService saat tangga
 * retry latar HABIS — artinya resolve langsung + cache D1 + dua
 * percobaan latar sudah gagal semua):
 * - Hanya bila MAYORITAS upaya resolve terakhir ditolak YouTube
 *   (LOGIN_REQUIRED) — gerbang yang sama dengan tangga retry
 *   latar. Lagu yang memang tidak ada (UNPLAYABLE murni) TIDAK
 *   masuk fallback: pemutar YouTube juga akan gagal, dan
 *   perilaku lama (berhenti di lagu ini dengan pesan jujur)
 *   lebih tepat.
 * - Tidak bila pengguna SUDAH menjeda: lagu tidak boleh mulai
 *   sendiri menit-menit sesudah pengguna menjeda (aturan yang
 *   sama dengan tangga retry latar).
 */
export function shouldEnterIframeFallback(args: {
  attempts: string[];
  status: PlayerStatus;
}): boolean {
  return (
    isLoginRequiredOnly(args.attempts) && args.status !== 'paused'
  );
}

/**
 * Muat YouTube IFrame Player API on-demand. Script hanya
 * diunduh saat fallback aktif (bukan di bundle awal, bukan
 * saat app dibuka). Promise di-cache: panggilan kedua memakai
 * hasil pertama. Bila `window.YT` sudah ada (mis. dimuat
 * halaman lain), langsung dipakai tanpa menambah script.
 *
 * Penolakan: script gagal dimuat (galat jaringan) atau callback
 * siap tidak datang dalam batas waktu.
 */
let apiPromise: Promise<YoutubeApi> | null = null;

export function loadYouTubeIframeApi(
  timeoutMs: number = YOUTUBE_IFRAME_API_TIMEOUT_MS,
): Promise<YoutubeApi> {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise<YoutubeApi>((resolve, reject) => {
    const w = window as unknown as {
      YT?: YoutubeApi;
      onYouTubeIframeAPIReady?: () => void;
    };
    if (w.YT?.Player) {
      resolve(w.YT);
      return;
    }
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      apiPromise = null;
      reject(new Error('YouTube IFrame API timeout'));
    }, timeoutMs);
    const finish = (value: YoutubeApi | Error): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (value instanceof Error) {
        apiPromise = null;
        reject(value);
      } else {
        resolve(value);
      }
    };
    // Rangkai callback siap yang sudah ada (bila ada) supaya
    // pemuat lain tidak kehilangan gilirannya.
    const previousReady = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      try {
        previousReady?.();
      } finally {
        if (w.YT?.Player) {
          finish(w.YT);
        } else {
          finish(new Error('YouTube IFrame API tidak tersedia'));
        }
      }
    };
    const script = document.createElement('script');
    script.src = YOUTUBE_IFRAME_API_URL;
    script.async = true;
    script.onerror = () => {
      finish(new Error('Script YouTube IFrame API gagal dimuat'));
    };
    document.head.appendChild(script);
  });
  return apiPromise;
}

/** Dipakai tes untuk mengosongkan cache promise antar kasus. */
export function resetYouTubeIframeApiForTests(): void {
  apiPromise = null;
}

// ---------- Registry kontroler ----------

/**
 * Kontrol yang didaftarkan komponen pemutar iframe supaya
 * PlayerService bisa mengarahkan tombol putar/jeda/cari
 * (MiniPlayer, FullPlayer, MediaSession) ke iframe saat mode
 * fallback aktif. Satu komponen aktif dalam satu waktu.
 */
export interface IframePlayerController {
  play(): void;
  pause(): void;
  seekTo(seconds: number): void;
}

let activeController: IframePlayerController | null = null;

/** Daftarkan kontroler saat komponen mount; null saat unmount. */
export function registerIframeController(
  controller: IframePlayerController | null,
): void {
  activeController = controller;
}

/** Kontroler aktif (null bila tidak ada pemutar iframe). */
export function getIframeController(): IframePlayerController | null {
  return activeController;
}
