/**
 * Kualitas unduhan (P5).
 *
 * Tiga opsi, label kanonis APK (arsitektur §3.6): "Terbaik",
 * "Seimbang", "Hemat data". Kata itag, bitrate, codec, Opus,
 * AAC, dan angka kbps TIDAK PERNAH tampil di antarmuka; yang
 * tampil hanya label + perkiraan ukuran dari durasi lagu.
 *
 * Tiap opsi membawa urutan itag pilihannya sendiri; bila itag
 * pertama tidak tersedia di format lagu, opsi jatuh ke itag
 * berikutnya dalam urutannya. Urutan kanonis
 * (251, 140, 250, 249, 139) dipakai "Terbaik" apa adanya.
 */

export type DownloadQuality = 'best' | 'balanced' | 'dataSaver';

/** Urutan itag pilihan per kualitas (itag yang tersedia dipakai). */
export const QUALITY_ITAG_PREFERENCE: Record<
  DownloadQuality,
  readonly number[]
> = {
  best: [251, 140, 250, 249, 139],
  balanced: [140, 250, 249, 139, 251],
  dataSaver: [249, 139, 140, 250, 251],
};

/**
 * Perkiraan bitrate (bit/detik) per kualitas, dipakai menghitung
 * perkiraan ukuran sebelum unduhan mulai. Angka dari arsitektur
 * §3.6: 251 sekitar 160 kbps, 140 sekitar 128 kbps, 249/139
 * sekitar 50 kbps. Perkiraan selalu dilabeli perkiraan di UI.
 */
export const QUALITY_BITRATE_BPS: Record<DownloadQuality, number> = {
  best: 160_000,
  balanced: 128_000,
  dataSaver: 50_000,
};

/**
 * Pulihkan kualitas dari itag pertama yang tersimpan di job
 * (251 -> Terbaik, 140 -> Seimbang, 249 -> Hemat data). Itag
 * pertama tiap opsi berbeda, jadi pemetaan ini tidak ambigu;
 * itag lain jatuh ke Terbaik (paling aman: kualitas tertinggi).
 */
export function qualityFromItag(itag: number | null): DownloadQuality {
  if (itag === 140) return 'balanced';
  if (itag === 249 || itag === 139) return 'dataSaver';
  return 'best';
}

/** Perkiraan ukuran file (byte) dari durasi lagu. */
export function estimateDownloadBytes(
  quality: DownloadQuality,
  durationSeconds: number | null | undefined,
): number | null {
  if (durationSeconds == null || durationSeconds <= 0) return null;
  return Math.round((QUALITY_BITRATE_BPS[quality] / 8) * durationSeconds);
}

/**
 * Format ukuran byte untuk UI Bahasa Indonesia: "512 B",
 * "120 KB", "4,2 MB", "1,2 GB" (koma desimal, satu desimal).
 * Format manual (bukan toLocaleString) supaya hasilnya
 * deterministik di semua runtime.
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = value < 10 ? value.toFixed(1) : String(Math.round(value));
  return `${rounded.replace('.', ',')} ${units[unitIndex]}`;
}
