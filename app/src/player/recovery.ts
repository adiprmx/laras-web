/**
 * Kebijakan pemulihan pemutaran (logika murni, tanpa DOM).
 *
 * Latar: googlevideo membatasi 1 MiB per URL dari IP datacenter
 * (terbukti S3; belum terbukti di IP residensial). Bila batas itu
 * berlaku di perangkat pengguna, stream putus di tengah lagu dan
 * pemutar wajib me-resolve ulang dari videoId lalu lanjut dari
 * posisi terakhir, tanpa memulai lagu dari awal (PRD B2).
 *
 * Urutan pemulihan (PRD B2): coba lanjut dulu, lalu resolve ulang,
 * lalu pindah ke lagu berikut. Sesudah 3 lagu berturut-turut gagal,
 * pemutar berhenti dan menampilkan pesan.
 */

/** Coba lanjut (resume) bila posisi tidak maju selama ini (ms). */
export const STALL_RESUME_AFTER_MS = 5000;

/** Resolve ulang bila posisi tetap tidak maju selama ini (ms). */
export const STALL_RERESOLVE_AFTER_MS = 10000;

/** Resolve ulang reaktif maks per lagu (di luar pra-resolve). */
export const MAX_RERESOLVE_PER_TRACK = 2;

/** Berhenti sesudah lagu gagal berturut-turut sebanyak ini. */
export const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Posisi (detik) saat pemutar mulai menyiapkan URL segar di latar
 * untuk lagu yang sedang diputar, supaya bila stream putus, URL
 * pengganti sudah siap. 45 detik dipilih di bawah perkiraan dinding
 * 1 MiB (sekitar 55 detik audio itag 251) dengan margin.
 */
export const PRERESOLVE_AT_SECONDS = 45;

/** Error hanya memicu resolve ulang bila lagu sudah terdengar sejauh ini. */
export const RERESOLVE_MIN_HEARD_SECONDS = 5;

/** Batas waktu keseluruhan satu resolve (diputuskan P2, selaras timeout kanari). */
export const RESOLVE_OVERALL_TIMEOUT_MS = 90000;

export type StallAction = 'ok' | 'resume' | 'reresolve';

/**
 * Pelacak macet: diberi sampel posisi tiap detik saat lagu diminta
 * memutar. Posisi yang tidak maju 5 detik meminta resume; tetap
 * tidak maju sampai 10 detik meminta resolve ulang. Posisi yang
 * maju mereset episode macet.
 */
export class StallTracker {
  private lastAdvanceAt: number | null = null;
  private lastPosition = 0;
  private resumed = false;
  private reresolved = false;

  /** Catat sampel posisi. `nowMs` dari jam yang sama tiap panggil. */
  feed(positionSeconds: number, nowMs: number, playing: boolean): StallAction {
    if (!playing) {
      this.lastAdvanceAt = null;
      this.resumed = false;
      this.reresolved = false;
      return 'ok';
    }
    if (this.lastAdvanceAt === null) {
      this.lastAdvanceAt = nowMs;
      this.lastPosition = positionSeconds;
      return 'ok';
    }
    if (positionSeconds > this.lastPosition + 0.05) {
      this.lastAdvanceAt = nowMs;
      this.lastPosition = positionSeconds;
      this.resumed = false;
      this.reresolved = false;
      return 'ok';
    }
    const stalledFor = nowMs - this.lastAdvanceAt;
    if (stalledFor >= STALL_RERESOLVE_AFTER_MS && !this.reresolved) {
      this.reresolved = true;
      return 'reresolve';
    }
    if (stalledFor >= STALL_RESUME_AFTER_MS && !this.resumed) {
      this.resumed = true;
      return 'resume';
    }
    return 'ok';
  }

  /** Reset penuh (ganti lagu, seek, atau resolve ulang dimulai). */
  reset(): void {
    this.lastAdvanceAt = null;
    this.lastPosition = 0;
    this.resumed = false;
    this.reresolved = false;
  }
}

/** Penghitung kegagalan lagu berturut-turut. Sukses mereset. */
export class FailureCounter {
  private count = 0;

  recordFailure(): number {
    this.count += 1;
    return this.count;
  }

  recordSuccess(): void {
    this.count = 0;
  }

  get failures(): number {
    return this.count;
  }

  get shouldStop(): boolean {
    return this.count >= MAX_CONSECUTIVE_FAILURES;
  }
}

export type ErrorDecision = 'reresolve' | 'next';

/**
 * Keputusan saat elemen audio error. Lagu yang sudah terdengar
 * lebih dari 5 detik dan masih punya jatah resolve ulang di-resolve
 * ulang; sisanya pindah ke lagu berikut.
 */
export function decideOnError(
  positionSeconds: number,
  reResolveCount: number,
): ErrorDecision {
  if (
    positionSeconds > RERESOLVE_MIN_HEARD_SECONDS &&
    reResolveCount < MAX_RERESOLVE_PER_TRACK
  ) {
    return 'reresolve';
  }
  return 'next';
}

export type RestoreDecision =
  | { action: 'start'; position: number }
  | { action: 'next' };

/**
 * Aturan lanjut posisi tersimpan (PRD B2.7): posisi di bawah 10
 * detik mulai dari awal; posisi kurang dari 10 detik dari akhir
 * pindah ke lagu berikut. Untuk lagu di bawah 30 detik, ambang
 * memakai sepertiga durasi.
 */
export function decideRestorePosition(
  savedSeconds: number,
  durationSeconds: number | undefined,
): RestoreDecision {
  if (
    typeof durationSeconds !== 'number' ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    return { action: 'start', position: Math.max(0, savedSeconds) };
  }
  const threshold =
    durationSeconds < 30 ? durationSeconds / 3 : 10;
  if (savedSeconds < threshold) {
    return { action: 'start', position: 0 };
  }
  if (durationSeconds - savedSeconds < threshold) {
    return { action: 'next' };
  }
  return { action: 'start', position: savedSeconds };
}
