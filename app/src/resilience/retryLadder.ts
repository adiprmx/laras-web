/**
 * Tangga retry latar untuk LOGIN_REQUIRED (hotfix resolve, 19 Nov 2026).
 *
 * Bukti: uji §5 19 Nov 2026 15:50 WIB — 0/5 TOTAL; ketiga client
 * (WEB_REMIX, MWEB, ANDROID_VR) x 3 putaran retry P6 =
 * LOGIN_REQUIRED untuk kelima lagu. Jendela buruk berlangsung 10+
 * menit, sementara retry P6 (3 putaran, backoff 5 dtk + 15 dtk,
 * total ~20 dtk) terlalu pendek untuk jendela selama itu. Proxy
 * sendiri SEHAT — yang menolak adalah YouTube.
 *
 * Tangga penuh per lagu (cepat P6 + latar ini):
 *   putaran 1 -> +5 dtk -> putaran 2 -> +15 dtk -> putaran 3
 *   -> +60 dtk -> putaran latar 1 -> +5 mnt -> putaran latar 2.
 * Total jendela mencoba ~6,3 menit (380 dtk jeda + waktu resolve),
 * bukan ~20 dtk. Tiap putaran mencoba client sesuai urutan config
 * (maks 3 request player/putaran); total maks per lagu 15 request
 * yang tersebar dalam ~7 menit — jauh di bawah rate limit proxy
 * 60/menit di setiap menitnya.
 *
 * Modul ini MURNI (tanpa DOM, tanpa timer): state tangga adalah
 * data (langkah + tenggat epoch), jadi service bisa mengecek
 * tenggat dari watchdog, dari timer, DAN dari visibilitychange —
 * tab tersembunyi membuat setTimeout di-throttle browser
 * (~1/menit), tapi tenggat tetap bisa dicek saat tab kembali
 * terlihat. Tes memakai jam palsu / nowMs injeksi, tanpa tidur
 * sungguhan.
 *
 * Retry latar HANYA untuk LOGIN_REQUIRED murni (semua upaya
 * `=LOGIN_REQUIRED`, lihat isLoginRequiredOnly): UNPLAYABLE bisa
 * berarti lagu yang benar-benar tidak ada (permanen), dan galat
 * jaringan/proxy/format punya jalurnya sendiri yang TIDAK diubah.
 */
import { RESOLVE_RETRY_BACKOFF_MS } from './retry';

/**
 * Jeda latar sesudah tangga cepat P6 habis (milidetik): 1 menit,
 * lalu 5 menit.
 *
 * Alasan angka: jendela buruk terukur 10+ menit, tapi penanda
 * berbalik per client x waktu (bukti §5: WEB_REMIX buruk 08:00,
 * lolos 08:05) — percobaan di +60 dtk menangkap jendela pendek,
 * percobaan di +5 mnt menangkap jendela menengah, tanpa menunggu
 * penuh 10 menit. Dua langkah latar cukup: langkah ketiga (+10
 * mnt) hanya menambah penantian pengguna dengan peluang lolos
 * yang makin kecil, sementara pengguna selalu bisa menekan
 * "Coba lagi" atau skip kapan saja.
 */
export const BACKGROUND_RETRY_BACKOFF_MS = [60_000, 300_000] as const;

/** Total jeda tangga penuh (cepat + latar): 380.000 ms (~6,3 mnt). */
export const RETRY_LADDER_TOTAL_WAIT_MS =
  RESOLVE_RETRY_BACKOFF_MS.reduce((a, b) => a + b, 0) +
  BACKGROUND_RETRY_BACKOFF_MS.reduce((a, b) => a + b, 0);

/** Maks request player per lagu di seluruh tangga (5 putaran x 3). */
export const RETRY_LADDER_MAX_PLAYER_REQUESTS = 15;

/** State satu tangga latar yang sedang berjalan untuk satu lagu. */
export interface RetryLadderState {
  /** videoId lagu yang sedang dicoba ulang. */
  videoId: string;
  /** Langkah latar berikutnya (0 = jeda 60 dtk, 1 = jeda 5 mnt). */
  step: number;
  /** Tenggat (epoch ms) percobaan latar berikutnya. */
  nextAttemptAt: number;
}

/**
 * Mulai tangga latar: percobaan pertama dijadwalkan sesudah jeda
 * langkah 0. Mengembalikan null bila daftar jeda kosong (tangga
 * dimatikan — dipakai tes untuk menonaktifkan retry latar).
 */
export function startLadder(
  videoId: string,
  nowMs: number,
  backoffMs: readonly number[] = BACKGROUND_RETRY_BACKOFF_MS,
): RetryLadderState | null {
  const first = backoffMs[0];
  if (first === undefined) return null;
  return { videoId, step: 0, nextAttemptAt: nowMs + first };
}

/**
 * Maju ke langkah berikut sesudah satu percobaan latar gagal
 * LOGIN_REQUIRED lagi. Mengembalikan null bila tangga habis
 * (tidak ada langkah berikut) — pemanggil menampilkan pesan
 * akhir yang jujur.
 */
export function advanceLadder(
  state: RetryLadderState,
  nowMs: number,
  backoffMs: readonly number[] = BACKGROUND_RETRY_BACKOFF_MS,
): RetryLadderState | null {
  const next = backoffMs[state.step + 1];
  if (next === undefined) return null;
  return {
    videoId: state.videoId,
    step: state.step + 1,
    nextAttemptAt: nowMs + next,
  };
}

/** Apakah tenggat percobaan latar sudah lewat (saatnya mencoba). */
export function isLadderDue(state: RetryLadderState, nowMs: number): boolean {
  return nowMs >= state.nextAttemptAt;
}

/**
 * Apakah SEMUA upaya tercatat adalah LOGIN_REQUIRED (dan ada
 * minimal satu upaya). Syarat ketat untuk memulai tangga latar:
 * satu saja upaya bukan LOGIN_REQUIRED (UNPLAYABLE, OK tanpa
 * format, proxy-gagal, jaringan-gagal, solver-gagal) berarti
 * kegagalan ini BUKAN penolakan bot-check murni — tangga latar
 * tidak jalan, perilaku lama yang berlaku.
 *
 * Upaya berbentuk `CLIENT=STATUS` (ResolveError.attempts, semua
 * putaran digabung). Memakai akhiran `=LOGIN_REQUIRED` supaya
 * nama client apa pun lolos.
 */
export function isLoginRequiredOnly(attempts: string[]): boolean {
  return (
    attempts.length > 0 &&
    attempts.every((a) => a.endsWith('=LOGIN_REQUIRED'))
  );
}
