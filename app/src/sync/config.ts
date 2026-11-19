/**
 * Konfigurasi klien sinkronisasi (P7).
 *
 * URL Worker sinkronisasi. Override lewat env build
 * `VITE_SYNC_API_URL` (mis. untuk staging); default adalah
 * Worker produksi di akun Cloudflare yang sama dengan proxy.
 * Nilai default ini BUKAN karangan: nama worker `laras-sync`
 * ditetapkan di workers/sync/wrangler.toml dan subdomain akun
 * `hiroohengkerr` sama dengan proxy yang sudah live.
 */
export const SYNC_API_BASE_URL =
  import.meta.env.VITE_SYNC_API_URL ??
  'https://laras-sync.hiroohengkerr.workers.dev';

/** Timeout satu request sync (detik). */
export const SYNC_API_TIMEOUT_MS = 30000;

/** Batas entri per koleksi per push (sama dengan batas server). */
export const SYNC_PUSH_BATCH_SIZE = 100;
