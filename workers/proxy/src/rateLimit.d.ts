// Deklarasi tipe untuk rateLimit.js (dipakai tes Vitest di app/).
// Antarmuka D1 minimal yang dipakai modul ini.

export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run(): Promise<unknown>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1Statement;
}

export declare const SWEEP_PROBABILITY: number;
// Blue 6 (S10a/S12b): jendela terpanjang di sistem (1 jam,
// untuk rate limit hapus akun); retensi sapu memakai nilai
// yang sama (SWEEP_RETENTION_MS di .js, tidak diekspor).
export declare const MAX_WINDOW_MS: number;
export declare function windowStartFor(
  nowMs: number,
  windowMs?: number,
): number;
export declare function isRateLimited(
  db: D1DatabaseLike,
  key: string,
  limit: number,
  nowMs?: number,
  windowMs?: number,
): Promise<boolean>;
export declare function sweepExpiredWindows(
  db: D1DatabaseLike,
  nowMs?: number,
): Promise<void>;
