/**
 * Format waktu pemutar: angka waktu tampil dengan angka tabular
 * (lebar sejajar) di UI. Satu-satunya format: m:ss, atau h:mm:ss
 * untuk durasi satu jam ke atas.
 */

/** Format detik menjadi "m:ss" atau "h:mm:ss". Nilai tak valid jadi "0:00". */
export function formatTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '0:00';
  const total = Math.floor(totalSeconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) return `${hours}:${mm}:${ss}`;
  return `${minutes}:${ss}`;
}

/** Label durasi sisa antrean: "Sisa 12:34" atau "Sisa 1:02:03". */
export function formatRemaining(totalSeconds: number): string {
  return `Sisa ${formatTime(totalSeconds)}`;
}
