/**
 * Klasifikasi error pemutaran ke 6 penyebab (P6, PRD B9).
 *
 * Tiap penyebab punya pesan Bahasa Indonesia sehari-hari (tanpa
 * jargon) + saran aksi. Klasifikasi murni: tidak membaca jaringan
 * atau storage, jadi mudah dites.
 *
 * Pemetaan dari ResolveError.attempts (bentuk `CLIENT=STATUS`):
 * - semua LOGIN_REQUIRED/UNPLAYABLE -> YouTube menolak
 * - ada proxy-gagal -> proxy tidak menjawab
 * - ada jaringan-gagal, atau navigator offline, atau galat
 *   jaringan/timeout -> tidak ada internet
 * - semua OK tapi tidak ada format yang bisa dipakai -> format
 *   tidak tersedia (resolve hanya melempar bila tidak ada format
 *   yang terpilih)
 * - pesan menyebut config/hash -> config kedaluwarsa
 * - selain itu -> tidak diketahui
 */
import { ResolveError } from '../extractor/resolve';

export type FailureCause =
  | 'offline'
  | 'refused'
  | 'proxy-down'
  | 'config-stale'
  | 'no-format'
  | 'unknown';

export interface ClassifiedFailure {
  cause: FailureCause;
  /** Judul singkat untuk layar. */
  title: string;
  /** Penjelasan + saran aksi, bahasa sehari-hari. */
  body: string;
  /** True bila kegagalan ini adalah timeout (untuk diagnostik). */
  isTimeout: boolean;
}

const MESSAGES: Record<
  FailureCause,
  { title: string; body: string }
> = {
  offline: {
    title: 'Tidak ada internet',
    body: 'Periksa sambungan internet kamu, lalu coba lagi.',
  },
  refused: {
    title: 'Lagu tidak bisa dibuka sekarang',
    body: 'Layanan musik sedang menolak permintaan dari app ini. Biasanya pulih sendiri dalam beberapa menit.',
  },
  'proxy-down': {
    title: 'Server perantara tidak menjawab',
    body: 'Jalur ke layanan musik sedang bermasalah. Coba lagi sebentar.',
  },
  'config-stale': {
    title: 'Pengaturan lagu kedaluwarsa',
    body: 'App memakai pengaturan lama. Buka Pengaturan lalu ketuk Periksa pembaruan.',
  },
  'no-format': {
    title: 'Lagu ini tidak tersedia',
    body: 'Lagu ini tidak punya format yang bisa diputar di app ini.',
  },
  unknown: {
    title: 'Lagu tidak bisa diputar',
    body: 'Terjadi kendala yang belum diketahui. Coba lagi, atau laporkan dari Pengaturan bila terus terjadi.',
  },
};

function attemptsOf(error: unknown): string[] {
  return error instanceof ResolveError ? error.attempts : [];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '';
}

export function classifyPlaybackFailure(input: {
  /** Nilai navigator.onLine saat gagal. */
  online: boolean;
  error?: unknown;
}): ClassifiedFailure {
  const { online, error } = input;
  const attempts = attemptsOf(error);
  const message = messageOf(error);
  const isTimeout =
    message.includes('melewati batas') ||
    (error instanceof Error && error.name === 'TimeoutError');
  let cause: FailureCause;
  if (!online) {
    cause = 'offline';
  } else if (
    error instanceof Error &&
    (error.name === 'TypeError' || error.name === 'AbortError') &&
    attempts.length === 0
  ) {
    // Galat fetch mentah tanpa upaya tercatat = jaringan putus.
    cause = 'offline';
  } else if (
    attempts.length > 0 &&
    attempts.every((a) => a.includes('=jaringan-gagal'))
  ) {
    cause = 'offline';
  } else if (
    attempts.length > 0 &&
    attempts.some((a) => a.includes('=proxy-gagal'))
  ) {
    cause = 'proxy-down';
  } else if (isTimeout) {
    // Batas waktu keseluruhan resolve: proxy tidak menjawab tepat
    // waktu. Bukan putus internet (online, request terkirim).
    cause = 'proxy-down';
  } else if (
    attempts.length > 0 &&
    attempts.every(
      (a) =>
        a.includes('=LOGIN_REQUIRED') || a.includes('=UNPLAYABLE'),
    )
  ) {
    cause = 'refused';
  } else if (
    attempts.length > 0 &&
    attempts.every((a) => a.includes('=OK'))
  ) {
    cause = 'no-format';
  } else if (
    /config|hash player/i.test(message) &&
    !message.includes('resolve gagal')
  ) {
    cause = 'config-stale';
  } else {
    cause = 'unknown';
  }
  const { title, body } = MESSAGES[cause];
  return { cause, title, body, isTimeout };
}

/** Pesan gabungan satu baris untuk errorMessage di store pemutar. */
export function failureMessage(failure: ClassifiedFailure): string {
  return `${failure.title}. ${failure.body}`;
}
