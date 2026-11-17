/**
 * Konstanta halaman spike integrasi P1 (rute /spike).
 *
 * Satu-satunya tempat URL proxy ditulis: bila P2 mengganti proxy
 * spike ke proxy produksi, cukup ubah PROXY_BASE_URL di sini.
 *
 * Nilai bawaan (client + hash) adalah salinan config-v1 per
 * 18 Nov 2026 dan hanya dipakai bila config remote tidak bisa
 * diambil. Config remote tetap sumber utama saat bisa diambil.
 */

/** URL dasar proxy byte-only spike (S7). Satu konstanta, mudah diganti. */
export const PROXY_BASE_URL =
  'https://laras-proxy-spike.hiroohengkerr.workers.dev';

/** Config remote control plane bersama APK (tag config-v1). */
export const CONFIG_URL =
  'https://raw.githubusercontent.com/adiprmx/laras/config-v1/player-config.json';

/** Urutan pemilihan itag kanonis (arsitektur APK 3.2, PRD 5.8). */
export const ITAG_ORDER = [251, 140, 250, 249, 139] as const;

/** Durasi periksa cepat per lagu, dalam detik. */
export const QUICK_CHECK_SECONDS = 30;

/** Batas waktu jaringan (milidetik). */
export const CONFIG_TIMEOUT_MS = 15000;
export const SEARCH_TIMEOUT_MS = 60000;
export const PLAYER_TIMEOUT_MS = 60000;
export const BASE_JS_TIMEOUT_MS = 90000;

/**
 * Macet dianggap gagal bila posisi putar tidak maju selama ini
 * (milidetik) padahal lagu sedang diminta memutar.
 */
export const STALL_TIMEOUT_MS = 45000;

/** Satu kali coba ulang resolve di tengah lagu bila putaran macet. */
export const MAX_MID_SONG_RETRY = 1;

export interface CanarySong {
  videoId: string;
  title: string;
  /** Durasi dalam detik, dari respons player probe APK. */
  lengthSeconds: number;
}

export const CANARY_SONGS: CanarySong[] = [
  { videoId: 'hhn-nGSuenM', title: 'Semua Tentang Kita', lengthSeconds: 268 },
  { videoId: 'qkC4waEZVt4', title: 'Rahasia Hati', lengthSeconds: 251 },
  { videoId: 'k2XdBPv0D3Y', title: 'Surat Cinta Untuk Starla', lengthSeconds: 308 },
  { videoId: 'NL8WUtq_NDY', title: 'Ya Sudahlah', lengthSeconds: 254 },
  { videoId: 'YsGwU8vTRsE', title: 'Tak Ingin Usai', lengthSeconds: 278 },
];

/** Total durasi kelima lagu kanari: 1.359 detik (22 menit 39 detik). */
export const TOTAL_CANARY_SECONDS = CANARY_SONGS.reduce(
  (sum, song) => sum + song.lengthSeconds,
  0,
);

export interface ClientDefinition {
  name: string;
  version: string;
  clientId: string;
  context: Record<string, unknown>;
  requiresScript: boolean;
}

/**
 * Definisi client bawaan (salinan config-v1, 18 Nov 2026).
 * Dipakai hanya bila config remote tidak bisa diambil.
 */
export const BUILTIN_CLIENTS: ClientDefinition[] = [
  {
    name: 'WEB_REMIX',
    version: '1.20261110.04.00',
    clientId: '67',
    context: { clientName: 'WEB_REMIX', clientVersion: '1.20261110.04.00' },
    requiresScript: true,
  },
  {
    name: 'MWEB',
    version: '2.20260708.05.00',
    clientId: '2',
    context: { clientName: 'MWEB', clientVersion: '2.20260708.05.00' },
    requiresScript: true,
  },
  {
    name: 'ANDROID_VR',
    version: '1.65.10',
    clientId: '14',
    context: {
      clientName: 'ANDROID_VR',
      clientVersion: '1.65.10',
      androidSdkVersion: 34,
    },
    requiresScript: false,
  },
];

/**
 * Hash player bawaan (salinan config-v1, 18 Nov 2026).
 * Dipakai hanya bila config remote tidak bisa diambil.
 */
export const BUILTIN_HASHES: Record<string, number> = {
  ad8d59ae: 20768,
  b559f50c: 20770,
  fad7e4e9: 20767,
};
