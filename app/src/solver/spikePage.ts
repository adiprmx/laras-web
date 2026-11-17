/**
 * Halaman spike S1 (hanya untuk pengukuran, bukan UI produk).
 *
 * Mengekspos `window.__runSolverSpike(baseJsByHash)` yang menjalankan
 * solver lewat Web Worker ASLI di browser (QuickJS-WASM + fallback
 * eval) untuk ketiga hash, mengukur waktu init/solve dan memori, lalu
 * mengembalikan hasilnya untuk diasersi tes Playwright.
 *
 * Halaman ini tidak dipakai aplikasi produksi; koordinator boleh
 * menghapusnya setelah Fase 1 bila tidak lagi dibutuhkan sebagai
 * regresi spike.
 */
import { buildPlayerScript } from './playerScript';
import { SolverClient } from './solverClient';
import {
  fullyDecode,
  kCipherUrlByHash,
  kCipheredS,
  kOracleNAd8,
  kOracleSigFad,
} from './spikeOracles';

export interface SpikeHashResult {
  hash: string;
  initMs: number;
  solveMs: number[];
  medianSolveMs: number;
  minSolveMs: number;
  maxSolveMs: number;
  finalUrl: string;
  sigParam: string | null;
  nParam: string | null;
  sigMatchesOracle: boolean | null;
  nMatchesOracle: boolean | null;
  memoryUsedSize: number | null;
  mallocLimit: number | null;
}

export interface SpikeEngineResult {
  engine: 'quickjs-wasm' | 'eval-fallback';
  workerReadyMs: number;
  hashes: SpikeHashResult[];
  error: string | null;
}

export interface SpikeResult {
  quickjs: SpikeEngineResult;
  evalFallback: SpikeEngineResult;
  /** Byte `performance.memory` (Chromium) sesudah semua solve, bila ada. */
  jsHeapUsedBytes: number | null;
}

const kHashes = ['fad7e4e9', 'ad8d59ae', 'b559f50c'] as const;
const kSolveRuns = 7;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

async function runEngine(
  engine: 'quickjs-wasm' | 'eval-fallback',
  baseJsByHash: Record<string, string>,
): Promise<SpikeEngineResult> {
  const workerUrl =
    engine === 'quickjs-wasm'
      ? new URL('./solverWorker.ts', import.meta.url)
      : new URL('./evalFallbackWorker.ts', import.meta.url);
  const client = new SolverClient(workerUrl);
  const result: SpikeEngineResult = {
    engine,
    workerReadyMs: 0,
    hashes: [],
    error: null,
  };
  try {
    // Pemanasan worker: ukur waktu sampai worker pertama merespons
    // (termasuk muat modul WASM untuk QuickJS).
    const readyStart = performance.now();
    const firstScript = buildPlayerScript(
      `/s/player/fad7e4e9/player_es6.vflset/en_US/base.js`,
      baseJsByHash['fad7e4e9'],
    );
    await client.solve(firstScript, {
      cipherUrl: kCipherUrlByHash['fad7e4e9'],
      cipheredS: kCipheredS,
      sigParam: 'sig',
    });
    result.workerReadyMs = performance.now() - readyStart;

    for (const hash of kHashes) {
      const script = buildPlayerScript(
        `/s/player/${hash}/player_es6.vflset/en_US/base.js`,
        baseJsByHash[hash],
      );
      const input = {
        cipherUrl: kCipherUrlByHash[hash],
        cipheredS: kCipheredS,
        sigParam: 'sig',
      };
      // Init diukur lewat solve pertama sesudah ganti hash (klien
      // melakukan init lazily di solve pertama hash baru). Untuk hash
      // pertama init sudah terjadi di pemanasan, jadi initMs-nya
      // diambil dari workerReadyMs.
      const initStart = performance.now();
      const firstUrl = await client.solve(script, input);
      const initMs =
        hash === 'fad7e4e9'
          ? result.workerReadyMs
          : performance.now() - initStart;
      const solveMs: number[] = [];
      let finalUrl = firstUrl;
      for (let i = 0; i < kSolveRuns; i++) {
        const start = performance.now();
        finalUrl = await client.solve(script, input);
        solveMs.push(performance.now() - start);
      }
      const parsed = new URL(finalUrl);
      const sigParam = parsed.searchParams.get('sig');
      const nParam = parsed.searchParams.get('n');
      let memoryUsedSize: number | null = null;
      let mallocLimit: number | null = null;
      if (engine === 'quickjs-wasm') {
        try {
          const memory = await client.memoryStats();
          memoryUsedSize = memory?.memoryUsedSize ?? null;
          mallocLimit = memory?.mallocLimit ?? null;
        } catch {
          // Statistik memori adalah pengukuran, bukan syarat lolos.
        }
      }
      result.hashes.push({
        hash,
        initMs,
        solveMs,
        medianSolveMs: median(solveMs),
        minSolveMs: Math.min(...solveMs),
        maxSolveMs: Math.max(...solveMs),
        finalUrl,
        sigParam,
        nParam,
        sigMatchesOracle:
          hash === 'fad7e4e9' && sigParam !== null
            ? fullyDecode(sigParam) === fullyDecode(kOracleSigFad)
            : null,
        nMatchesOracle:
          hash === 'ad8d59ae' ? nParam === kOracleNAd8 : null,
        memoryUsedSize,
        mallocLimit,
      });
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    client.dispose();
  }
  return result;
}

declare global {
  interface Window {
    __runSolverSpike: (
      baseJsByHash: Record<string, string>,
    ) => Promise<SpikeResult>;
  }
}

window.__runSolverSpike = async (
  baseJsByHash: Record<string, string>,
): Promise<SpikeResult> => {
  const quickjs = await runEngine('quickjs-wasm', baseJsByHash);
  const evalFallback = await runEngine('eval-fallback', baseJsByHash);
  const performanceWithMemory = performance as Performance & {
    memory?: { usedJSHeapSize: number };
  };
  return {
    quickjs,
    evalFallback,
    jsHeapUsedBytes:
      performanceWithMemory.memory?.usedJSHeapSize ?? null,
  };
};

document.getElementById('status')!.textContent = 'siap';
