// Data bersama harness spike S3/S5/S9 Laras Web.
//
// Nilai di sini adalah PORT dari definisi APK yang terbukti
// (~/workspace/music-app/laras/lib/extractor/client_definitions.dart dan
// config remote tag config-v1). Bukan tebakan: versi client dan sts
// diverifikasi dari config remote pada 17 Nov 2026.

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

export interface ClientDefinition {
  name: string;
  version: string;
  clientId: string;
  userAgent: string;
  context: Record<string, unknown>;
  requiresScript: boolean;
}

/** Kunci API InnerTube PUBLIK (tertanam di halaman youtube.com, dipakai
 * yt-dlp/pytubefix). Bukan secret (keputusan K-F2-10 APK). */
export const INNERTUBE_API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

export const INNERTUBE_HOST = 'www.youtube.com';

export const CONFIG_URL =
  'https://raw.githubusercontent.com/adiprmx/laras/config-v1/player-config.json';

export const WEB_REMIX: ClientDefinition = {
  name: 'WEB_REMIX',
  version: '1.20261110.04.00',
  clientId: '67',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  context: { clientName: 'WEB_REMIX', clientVersion: '1.20261110.04.00' },
  requiresScript: true,
};

export const MWEB: ClientDefinition = {
  name: 'MWEB',
  version: '2.20260708.05.00',
  clientId: '2',
  userAgent:
    'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  context: { clientName: 'MWEB', clientVersion: '2.20260708.05.00' },
  requiresScript: true,
};

export const ANDROID_VR: ClientDefinition = {
  name: 'ANDROID_VR',
  version: '1.65.10',
  clientId: '14',
  userAgent:
    'com.google.android.youtube/21.26.364 (Linux; U; Android 14; Pixel 8) gzip',
  context: {
    clientName: 'ANDROID_VR',
    clientVersion: '1.65.10',
    androidSdkVersion: 34,
  },
  requiresScript: false,
};

/** Urutan fallback kanonis APK: WEB_REMIX, MWEB, ANDROID_VR. */
export const CLIENT_FALLBACK_ORDER: ClientDefinition[] = [
  WEB_REMIX,
  MWEB,
  ANDROID_VR,
];

/** Urutan pemilihan itag kanonis (arsitektur APK 3.2, PRD 5.8). */
export const BEST_QUALITY_ITAG_ORDER = [251, 140, 250, 249, 139];

/**
 * Ringkasan URL stream yang AMAN dicetak ke log. URL lengkap TIDAK PERNAH
 * dicetak (aturan PRD B2.1: URL stream hanya ada di memori).
 */
export function describeStreamUrl(url: string, itag: number): string {
  let host = '?';
  try {
    host = new URL(url).hostname;
  } catch {
    host = 'url-tidak-valid';
  }
  const edge = host.endsWith('.googlevideo.com')
    ? '*.googlevideo.com'
    : host;
  return `host=${edge} itag=${itag} urlLen=${url.length}`;
}

/** Allowlist URL stream, port url_allowlist.dart APK. */
export function isAllowedStreamUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    if (u.username !== '' || u.password !== '') return false;
    return (
      u.hostname === 'googlevideo.com' ||
      u.hostname.endsWith('.googlevideo.com')
    );
  } catch {
    return false;
  }
}
