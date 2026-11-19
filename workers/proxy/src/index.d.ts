// Deklarasi tipe untuk index.js Worker proxy (dipakai tes Vitest
// di app/). Hanya permukaan yang dipakai tes: default export
// dengan handler fetch ala Workers.
export interface ProxyWorkerEnv {
  DB?: unknown;
  ALLOWED_ORIGINS?: string;
  /** Secret tulis /api/resolve-cache (P3). Tidak ada = tulis ditolak. */
  RESOLVE_CACHE_KEY?: string;
}

declare const worker: {
  fetch(
    request: Request,
    env: ProxyWorkerEnv,
    ctx?: unknown,
  ): Promise<Response>;
};

export default worker;
