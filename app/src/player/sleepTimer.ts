/**
 * Timer tidur (P7): logika murni berbasis tenggat (deadline).
 *
 * Hitung mundur memakai timestamp tenggat yang dicek tiap detik
 * dan saat tab kembali terlihat — `setTimeout` di-throttle
 * browser saat tab di latar, sehingga tenggat adalah satu-satunya
 * hitungan yang bisa diandalkan (arsitektur §3.7).
 *
 * Dua mode: hitung menit (5/10/15/30/45/60) atau sampai lagu yang
 * sedang diputar selesai. Saat habis, volume turun perlahan 10
 * detik terakhir lalu pemutaran dijeda; antrean dan posisi utuh.
 * Timer berhenti bila tab ditutup (dinyatakan jujur di UI).
 */
import { strings } from '../strings/id';

export const SLEEP_TIMER_MINUTES = [5, 10, 15, 30, 45, 60] as const;

/** Durasi fade-out sebelum timer habis (milidetik). */
export const SLEEP_FADE_MS = 10_000;

export type SleepTimerState =
  | {
      mode: 'minutes';
      /** Tenggat habis (milidetik epoch). */
      deadlineMs: number;
      minutes: number;
    }
  | {
      mode: 'end-of-song';
      /** Id lagu yang dikunci saat timer dipasang. */
      trackId: string;
    };

/** Buat timer menit dari sekarang. */
export function createMinutesTimer(
  minutes: number,
  nowMs: number,
): SleepTimerState {
  return {
    mode: 'minutes',
    deadlineMs: nowMs + minutes * 60_000,
    minutes,
  };
}

/** Buat timer akhir-lagu yang terkunci ke satu lagu. */
export function createEndOfSongTimer(trackId: string): SleepTimerState {
  return { mode: 'end-of-song', trackId };
}

/**
 * Sisa waktu timer menit (milidetik, tidak pernah negatif).
 * Null untuk mode akhir-lagu (sisanya adalah sisa lagu).
 */
export function remainingMs(
  timer: SleepTimerState | null,
  nowMs: number,
): number | null {
  if (!timer) return null;
  if (timer.mode === 'end-of-song') return null;
  return Math.max(0, timer.deadlineMs - nowMs);
}

/** Apakah timer menit sudah habis. */
export function isTimerExpired(
  timer: SleepTimerState | null,
  nowMs: number,
): boolean {
  if (!timer || timer.mode !== 'minutes') return false;
  return nowMs >= timer.deadlineMs;
}

/**
 * Faktor volume saat fade-out: 1 di luar 10 detik terakhir, lalu
 * turun lurus ke 0 di tenggat. Timer akhir-lagu tidak memakai
 * fade berbasis waktu (fade-nya dihitung dari sisa lagu oleh
 * service bila perlu).
 */
export function fadeFactor(
  timer: SleepTimerState | null,
  nowMs: number,
): number {
  const remaining = remainingMs(timer, nowMs);
  if (remaining === null) return 1;
  if (remaining >= SLEEP_FADE_MS) return 1;
  return Math.max(0, remaining / SLEEP_FADE_MS);
}

/** Teks sisa waktu ramah: "12 menit", "45 detik", "1 menit". */
export function formatSleepRemaining(ms: number): string {
  if (ms <= 0) return '0 detik';
  const totalSeconds = Math.ceil(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} detik`;
  const minutes = Math.ceil(totalSeconds / 60);
  return `${minutes} menit`;
}

/** Teks status timer untuk pemutar (null bila tidak ada timer). */
export function sleepTimerText(
  timer: SleepTimerState | null,
  nowMs: number,
): string | null {
  if (!timer) return null;
  if (timer.mode === 'end-of-song') return strings.sleepTimerEndOfSongActive;
  const remaining = remainingMs(timer, nowMs);
  if (remaining === null) return null;
  return strings.sleepTimerRemaining(formatSleepRemaining(remaining));
}
