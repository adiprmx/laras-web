/**
 * Retry resolve lintas waktu (P6, rekomendasi §5
 * docs/spikes/egress-dan-opsi-resolve.md).
 *
 * Bukti empiris: WEB_REMIX LOGIN_REQUIRED pukul 08:00 WIB, lolos
 * pukul 08:05 WIB — penanda berubah per client x waktu, bukan
 * blokir permanen. Bila SEMUA client menolak di satu putaran
 * (LOGIN_REQUIRED atau UNPLAYABLE tanpa format), putaran resolve
 * diulang dengan backoff sebelum menyerah.
 *
 * Batas: maks 3 putaran (1 awal + 2 ulang) x 3 client = 9 request
 * player per lagu, jauh di bawah rate limit proxy 60/menit.
 * Retry TIDAK berlaku untuk galat jaringan (sudah ada retry
 * sendiri per client di resolve.ts), galat proxy, atau format
 * yang tidak tersedia (OK tanpa format tidak akan berubah dalam
 * hitungan detik).
 */
export const RESOLVE_RETRY_ROUNDS = 3;

/** Jeda antar putaran (milidetik): 5 detik, lalu 15 detik. */
export const RESOLVE_RETRY_BACKOFF_MS = [5000, 15000] as const;

/**
 * Playability yang berarti YouTube menolak lagu ini di jendela
 * waktu ini (bukan galat jaringan, bukan format tidak ada).
 */
export function isRefusalPlayability(status: string): boolean {
  return status === 'LOGIN_REQUIRED' || status === 'UNPLAYABLE';
}

/** Jeda default (setTimeout); bisa diinjeksi di tes. */
export function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
