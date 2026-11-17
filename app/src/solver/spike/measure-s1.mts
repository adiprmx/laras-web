/**
 * Harness ukur S1 (Node): median solve 21 putaran per hash, memori
 * puncak, dan ukuran bundle - pelengkap angka browser Playwright.
 *
 * Dijalankan dengan: `npx vite-node src/solver/spike/measure-s1.mts`
 * dari `app/`. Menulis `docs/spikes/s1-s4-node-measurements.json`.
 *
 * Catatan: eval V8 di harness ini jalan di thread utama Node (bukan
 * worker terpisah), jadi angkanya untuk perbandingan waktu saja;
 * bukti kebenaran fallback 3 hash ada di tes browser Playwright
 * (worker terpisah per mesin).
 */
import { gzipSync } from 'node:zlib';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { EvalEngine } from '../evalEngine';
import {
  buildPlayerScript,
  buildSolveDriver,
  buildSolverInitScript,
} from '../playerScript';
import { QuickJsEngine } from '../quickJsEngine';
import {
  kCipherUrlByHash,
  kCipheredS,
  kOracleNAd8,
  kOracleSigFad,
  fullyDecode,
} from '../spikeOracles';

const kHashes = ['fad7e4e9', 'ad8d59ae', 'b559f50c'] as const;
const kRuns = 21;

const kFullBaseJs: Record<string, string> = {
  fad7e4e9: `${process.env.HOME}/workspace/music-app/hidden_files/tim-p1-spike/base-fad7e4e9.js`,
  ad8d59ae: `${process.env.HOME}/workspace/music-app/hidden_files/koordinator-fase-2/base_ad8d59ae.js`,
  b559f50c: `${process.env.HOME}/workspace/music-app/hidden_files/koordinator-fase-2/base_b559f50c.js`,
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

interface HashMeasurement {
  hash: string;
  initMs: number;
  solveMs: number[];
  medianSolveMs: number;
  p95SolveMs: number;
  minSolveMs: number;
  maxSolveMs: number;
  finalUrlPrefix: string;
  sigMatchesOracle: boolean | null;
  nMatchesOracle: boolean | null;
  memoryAfterInit: number | null;
  memoryAfterSolves: number | null;
}

async function measureQuickJs(): Promise<{
  wasmLoadMs: number;
  hashes: HashMeasurement[];
  rssPeakBytes: number;
}> {
  const rssBefore = process.memoryUsage().rss;
  let rssPeak = rssBefore;
  const hashes: HashMeasurement[] = [];
  let wasmLoadMs = 0;
  let first = true;
  for (const hash of kHashes) {
    const baseJs = readFileSync(kFullBaseJs[hash], 'utf8');
    const script = buildPlayerScript(
      `/s/player/${hash}/player_es6.vflset/en_US/base.js`,
      baseJs,
    );
    const engine = new QuickJsEngine();
    const loadStart = performance.now();
    await engine.ensureReady();
    if (first) {
      wasmLoadMs = performance.now() - loadStart;
      first = false;
    }
    const initStart = performance.now();
    const init = engine.eval(buildSolverInitScript(script));
    const initMs = performance.now() - initStart;
    if (!init.ok) {
      throw new Error(`init QuickJS ${hash} gagal: ${init.error}`);
    }
    const memoryAfterInit = engine.memoryStats()?.memoryUsedSize ?? null;
    const driver = buildSolveDriver(script, {
      cipherUrl: kCipherUrlByHash[hash],
      cipheredS: kCipheredS,
      sigParam: 'sig',
    });
    const solveMs: number[] = [];
    let finalUrl = '';
    for (let i = 0; i < kRuns; i++) {
      const start = performance.now();
      const outcome = engine.eval(driver);
      solveMs.push(performance.now() - start);
      if (!outcome.ok) {
        throw new Error(`solve QuickJS ${hash} gagal: ${outcome.error}`);
      }
      finalUrl = outcome.value as string;
      rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
    }
    const memoryAfterSolves = engine.memoryStats()?.memoryUsedSize ?? null;
    const parsed = new URL(finalUrl);
    const sigParam = parsed.searchParams.get('sig');
    hashes.push({
      hash,
      initMs,
      solveMs,
      medianSolveMs: median(solveMs),
      p95SolveMs: percentile(solveMs, 95),
      minSolveMs: Math.min(...solveMs),
      maxSolveMs: Math.max(...solveMs),
      finalUrlPrefix: finalUrl.slice(0, 60),
      sigMatchesOracle:
        hash === 'fad7e4e9' && sigParam !== null
          ? fullyDecode(sigParam) === fullyDecode(kOracleSigFad)
          : null,
      nMatchesOracle:
        hash === 'ad8d59ae'
          ? parsed.searchParams.get('n') === kOracleNAd8
          : null,
      memoryAfterInit,
      memoryAfterSolves,
    });
    engine.dispose();
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  }
  return { wasmLoadMs, hashes, rssPeakBytes: rssPeak };
}

function measureEval(): { hashes: HashMeasurement[] } {
  // PENTING: stub DOM menimpa `globalThis.performance` di thread ini
  // (eval jalan di scope global), jadi `performance.now()` sesudah init
  // mengembalikan Date.now(). Pakai hrtime yang tidak terpengaruh.
  const nowMs = (): number => Number(process.hrtime.bigint()) / 1e6;
  const hashes: HashMeasurement[] = [];
  const engine = new EvalEngine();
  for (const hash of kHashes) {
    const baseJs = readFileSync(kFullBaseJs[hash], 'utf8');
    const script = buildPlayerScript(
      `/s/player/${hash}/player_es6.vflset/en_US/base.js`,
      baseJs,
    );
    const initStart = nowMs();
    const init = engine.eval(buildSolverInitScript(script));
    const initMs = nowMs() - initStart;
    if (!init.ok) {
      throw new Error(`init eval ${hash} gagal: ${init.error}`);
    }
    const driver = buildSolveDriver(script, {
      cipherUrl: kCipherUrlByHash[hash],
      cipheredS: kCipheredS,
      sigParam: 'sig',
    });
    const solveMs: number[] = [];
    let finalUrl = '';
    for (let i = 0; i < kRuns; i++) {
      const start = nowMs();
      const outcome = engine.eval(driver);
      solveMs.push(nowMs() - start);
      if (!outcome.ok) {
        throw new Error(`solve eval ${hash} gagal: ${outcome.error}`);
      }
      finalUrl = outcome.value as string;
    }
    const parsed = new URL(finalUrl);
    const sigParam = parsed.searchParams.get('sig');
    hashes.push({
      hash,
      initMs,
      solveMs,
      medianSolveMs: median(solveMs),
      p95SolveMs: percentile(solveMs, 95),
      minSolveMs: Math.min(...solveMs),
      maxSolveMs: Math.max(...solveMs),
      finalUrlPrefix: finalUrl.slice(0, 60),
      sigMatchesOracle:
        hash === 'fad7e4e9' && sigParam !== null
          ? fullyDecode(sigParam) === fullyDecode(kOracleSigFad)
          : null,
      nMatchesOracle:
        hash === 'ad8d59ae'
          ? parsed.searchParams.get('n') === kOracleNAd8
          : null,
      memoryAfterInit: null,
      memoryAfterSolves: null,
    });
  }
  engine.dispose();
  return { hashes };
}

function bundleSizes(): Record<string, { bytes: number; gzipBytes: number }> {
  const files: Record<string, string> = {
    'singlefile-browser emscripten-module.browser.mjs (dipakai worker)':
      'node_modules/@jitl/quickjs-singlefile-browser-release-sync/dist/emscripten-module.browser.mjs',
    'quickjs-emscripten-core index.mjs':
      'node_modules/quickjs-emscripten-core/dist/index.mjs',
    'quickjs-emscripten-core chunk utama':
      'node_modules/quickjs-emscripten-core/dist/chunk-TAV5CUKK.mjs',
  };
  const out: Record<string, { bytes: number; gzipBytes: number }> = {};
  for (const [label, rel] of Object.entries(files)) {
    const path = resolve(process.cwd(), rel);
    if (!existsSync(path)) {
      out[label] = { bytes: -1, gzipBytes: -1 };
      continue;
    }
    const content = readFileSync(path);
    out[label] = {
      bytes: statSync(path).size,
      gzipBytes: gzipSync(content).length,
    };
  }
  return out;
}

const quickjs = await measureQuickJs();
const evalFallback = measureEval();
const result = {
  measuredAt: new Date().toISOString(),
  environment: `Node ${process.version}, ${process.platform} ${process.arch}`,
  runsPerHash: kRuns,
  quickjs,
  evalFallback,
  bundleSizes: bundleSizes(),
};
const outPath = resolve(
  process.cwd(),
  '../docs/spikes/s1-s4-node-measurements.json',
);
writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(`hasil ukur ditulis ke ${outPath}`);
console.log(`QuickJS wasmLoadMs=${quickjs.wasmLoadMs.toFixed(1)} rssPeakMB=${(quickjs.rssPeakBytes / 1048576).toFixed(1)}`);
for (const h of quickjs.hashes) {
  console.log(
    `QuickJS ${h.hash}: init=${h.initMs.toFixed(1)}ms median=${h.medianSolveMs.toFixed(2)}ms p95=${h.p95SolveMs.toFixed(2)}ms min=${h.minSolveMs.toFixed(2)} max=${h.maxSolveMs.toFixed(2)} memInit=${h.memoryAfterInit} memSolves=${h.memoryAfterSolves} sigOracle=${h.sigMatchesOracle} nOracle=${h.nMatchesOracle}`,
  );
}
for (const h of evalFallback.hashes) {
  console.log(
    `eval ${h.hash}: init=${h.initMs.toFixed(1)}ms median=${h.medianSolveMs.toFixed(2)}ms p95=${h.p95SolveMs.toFixed(2)}ms min=${h.minSolveMs.toFixed(2)} max=${h.maxSolveMs.toFixed(2)} sigOracle=${h.sigMatchesOracle} nOracle=${h.nMatchesOracle}`,
  );
}
console.log(JSON.stringify(result.bundleSizes, null, 1));
