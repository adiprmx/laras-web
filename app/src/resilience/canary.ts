/**
 * Deteksi kanari (P6, PRD B9.7): cek sekali sehari di latar.
 *
 * Lima lagu kanari di-resolve saja (tanpa memutar suara);
 * hasilnya dicatat di IndexedDB app_meta dan dipakai banner
 * status + kode diagnostik. Semua lokal, tanpa telemetri.
 *
 * Aturan yang mengikat:
 * - Kegagalan jaringan DIABAIKAN: offline bukan kerusakan
 *   layanan, dan tidak memajukan waktu cek.
 * - Kanari memakai maxRounds 1 (tanpa retry lintas waktu):
 *   probe harus MENGUKUR kesehatan, bukan menutupinya, dan
 *   tidak membakar kuota proxy (5 lagu x 3 client = 15 request
 *   maks per cek, di bawah rate limit 60/menit).
 * - Jeda antar lagu menghormati rate limit proxy.
 * - Cek tidak pernah mengganggu pengguna: jalan di latar,
 *   gagal diam-diam.
 */
import { CANARY_SONGS } from '../spike/config';
import { classifyPlaybackFailure, type FailureCause } from './errors';
import type { KeyValueStorage } from './configStore';
import { createAppMetaStorage } from './configStore';

/** Jadwal cek kanari: sekali sehari. */
export const CANARY_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Batas waktu satu lagu kanari (PRD B9.7). */
export const CANARY_TIMEOUT_MS = 90 * 1000;
/** Jeda antar lagu kanari (hormati rate limit proxy). */
export const CANARY_GAP_MS = 1000;
/** Kunci hasil kanari di app_meta. */
export const CANARY_RECORD_KEY = 'p6.canary.last';

export type CanaryStatus = 'ok' | 'degraded' | 'broken';

export interface CanaryRecord {
  checkedAt: number;
  succeeded: number;
  failed: number;
  networkFailures: number;
  dominantCause: FailureCause | null;
  status: CanaryStatus;
  /** Cek gagal berturut-turut dengan penyebab dominan yang sama. */
  streak: number;
  streakCause: FailureCause | null;
}

export function computeCanaryStatus(
  failed: number,
  streak: number,
): CanaryStatus {
  // Ambang rusak (PRD B9.7): 3 cek gagal berturut-turut dengan
  // penyebab sama, atau lebih dari separuh lagu gagal (3 dari 5).
  if (failed >= 3 || streak >= 3) return 'broken';
  if (failed >= 1) return 'degraded';
  return 'ok';
}

/** Apakah cek kanari sudah jatuh tempo. */
export function shouldRunCanary(
  lastCheckedAt: number | null,
  nowMs: number,
): boolean {
  if (lastCheckedAt === null) return true;
  return nowMs - lastCheckedAt >= CANARY_CHECK_INTERVAL_MS;
}

export function parseCanaryRecord(raw: string | null): CanaryRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CanaryRecord>;
    if (
      typeof parsed.checkedAt !== 'number' ||
      typeof parsed.succeeded !== 'number' ||
      typeof parsed.failed !== 'number' ||
      typeof parsed.networkFailures !== 'number' ||
      (parsed.status !== 'ok' &&
        parsed.status !== 'degraded' &&
        parsed.status !== 'broken')
    ) {
      return null;
    }
    return {
      checkedAt: parsed.checkedAt,
      succeeded: parsed.succeeded,
      failed: parsed.failed,
      networkFailures: parsed.networkFailures,
      dominantCause: parsed.dominantCause ?? null,
      status: parsed.status,
      streak: typeof parsed.streak === 'number' ? parsed.streak : 0,
      streakCause: parsed.streakCause ?? null,
    };
  } catch {
    return null;
  }
}

export interface CanaryCheckerDeps {
  /**
   * Resolve satu lagu kanari (tanpa memutar suara). Implementasi
   * produksi memakai StreamResolver dengan maxRounds 1.
   */
  resolveSong: (videoId: string) => Promise<void>;
  now?: () => number;
  storage?: KeyValueStorage;
  /** Jeda antar lagu (diinjeksi di tes supaya tes tidak lambat). */
  delay?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  gapMs?: number;
  /** Apakah perangkat sedang online (diinjeksi di tes). */
  online?: () => boolean;
}

export interface CanaryCheckOutcome {
  /** 'ran' = cek jalan dan tersimpan; 'skipped' = tidak tersimpan. */
  outcome: 'ran' | 'skipped';
  record: CanaryRecord | null;
  /** Alasan skip: 'offline' (jaringan putus / semua gagal jaringan). */
  skippedReason?: 'offline';
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createCanaryChecker(deps: CanaryCheckerDeps) {
  const now = deps.now ?? Date.now;
  const storage = deps.storage ?? createAppMetaStorage();
  const delay = deps.delay ?? defaultDelay;
  const timeoutMs = deps.timeoutMs ?? CANARY_TIMEOUT_MS;
  const gapMs = deps.gapMs ?? CANARY_GAP_MS;
  const online = deps.online ?? (() => navigator.onLine);

  async function loadRecord(): Promise<CanaryRecord | null> {
    try {
      return parseCanaryRecord(await storage.get(CANARY_RECORD_KEY));
    } catch {
      return null;
    }
  }

  async function saveRecord(record: CanaryRecord): Promise<void> {
    try {
      await storage.set(CANARY_RECORD_KEY, JSON.stringify(record));
    } catch {
      // Gagal simpan tidak memblokir apa pun.
    }
  }

  return {
    loadRecord,

    async isDue(): Promise<boolean> {
      const record = await loadRecord();
      return shouldRunCanary(record?.checkedAt ?? null, now());
    },

    /**
     * Jalankan satu cek kanari penuh (5 lagu, berurutan).
     * Mengembalikan 'skipped' bila offline atau semua kegagalan
     * adalah jaringan (waktu cek tidak dimajukan, PRD B9.7).
     */
    async runCheck(): Promise<CanaryCheckOutcome> {
      if (!online()) {
        return { outcome: 'skipped', record: null, skippedReason: 'offline' };
      }
      const previous = await loadRecord();
      let succeeded = 0;
      let failed = 0;
      let networkFailures = 0;
      const causeCounts = new Map<FailureCause, number>();
      for (let i = 0; i < CANARY_SONGS.length; i++) {
        const song = CANARY_SONGS[i];
        if (i > 0 && gapMs > 0) await delay(gapMs);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('kanari melewati batas')),
              timeoutMs,
            );
          });
          await Promise.race([deps.resolveSong(song.videoId), timeout]);
          succeeded += 1;
        } catch (error) {
          const classified = classifyPlaybackFailure({
            online: online(),
            error,
          });
          if (classified.cause === 'offline') {
            networkFailures += 1;
          } else {
            failed += 1;
            causeCounts.set(
              classified.cause,
              (causeCounts.get(classified.cause) ?? 0) + 1,
            );
          }
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      // Semua kegagalan adalah jaringan: bukan sinyal kerusakan
      // layanan — jangan simpan, jangan majukan waktu cek.
      if (failed === 0 && networkFailures > 0 && succeeded === 0) {
        return { outcome: 'skipped', record: null, skippedReason: 'offline' };
      }
      let dominantCause: FailureCause | null = null;
      let dominantCount = 0;
      for (const [cause, count] of causeCounts) {
        if (count > dominantCount) {
          dominantCause = cause;
          dominantCount = count;
        }
      }
      const streak =
        failed > 0 &&
        dominantCause !== null &&
        previous?.streakCause === dominantCause
          ? previous.streak + 1
          : failed > 0
            ? 1
            : 0;
      const record: CanaryRecord = {
        checkedAt: now(),
        succeeded,
        failed,
        networkFailures,
        dominantCause,
        status: computeCanaryStatus(failed, streak),
        streak,
        streakCause: failed > 0 ? dominantCause : null,
      };
      await saveRecord(record);
      return { outcome: 'ran', record };
    },
  };
}
