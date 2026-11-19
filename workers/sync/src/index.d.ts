// Deklarasi tipe untuk index.js Worker sync (dipakai tes Vitest
// di app/). Hanya permukaan yang dipakai tes: default export
// dengan handler fetch ala Workers.
export interface SyncWorkerEnv {
  DB?: unknown;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  APP_URL?: string;
  ALLOWED_ORIGINS?: string;
  COOKIE_SAMESITE?: string;
}

declare const worker: {
  fetch(
    request: Request,
    env: SyncWorkerEnv,
    ctx?: unknown,
  ): Promise<Response>;
};

export default worker;
