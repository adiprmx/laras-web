/**
 * Verifikasi satu kali: solver QuickJS-WASM BEKERJA di build produksi.
 *
 * Latar: build produksi pertama halaman spike membuktikan Vite
 * mengubah `new URL('./solverWorker.ts', import.meta.url)` yang
 * disimpan ke variabel menjadi data URL berisi sumber TypeScript
 * mentah (worker gagal total). Pola diperbaiki ke
 * `new Worker(new URL(...))` langsung + `worker.format: 'es'`.
 * Skrip ini membuktikan perbaikan itu di Chromium nyata melawan
 * `vite preview` (build produksi): muat chunk solverClient hasil
 * build, solve cipher oracle fad7e4e9, bandingkan sig dengan oracle
 * APK (terverifikasi pytubefix).
 *
 * Jalankan: vite preview harus jalan di port 4173, lalu
 *   npx vite-node tests/spikes/verify-prod-solver.mts
 * Skrip ini BUKAN tes CI: base.js dibaca dari arsip koordinator
 * Fase 2 APK di luar repo web.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { buildPlayerScript } from '../../src/solver/playerScript';
import {
  fullyDecode,
  kCipherUrlFad,
  kCipheredS,
  kOracleSigFad,
} from '../../src/solver/spikeOracles';

const PREVIEW_URL = 'http://localhost:4173/spike';
const BASE_JS_PATH =
  '/home/hatch/workspace/music-app/hidden_files/tim-p1-spike/base-fad7e4e9.js';
const EXPECTED_N = '4kdLuLGx-Us4iQ';

const distFiles = readdirSync(new URL('../../dist/assets', import.meta.url));
const solverClientFile = distFiles.find(
  (f) => f.startsWith('solverClient-') && f.endsWith('.js'),
);
if (!solverClientFile) {
  console.error('FAIL: chunk solverClient tidak ketemu di dist/assets');
  process.exit(1);
}

const baseJs = readFileSync(BASE_JS_PATH, 'utf-8');
console.log(`base.js fad7e4e9: ${baseJs.length} byte`);
const script = buildPlayerScript(
  '/s/player/fad7e4e9/player_es6.vflset/en_US/base.js',
  baseJs,
);
console.log(
  `PlayerScript: hash=${script.hash} sts=${script.signatureTimestamp} ` +
    `urlClass=${script.urlClassName} prelude=${script.preludeCode.length} byte`,
);

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const workerErrors: string[] = [];
  page.on('pageerror', (error) => workerErrors.push(String(error)));
  await page.goto(PREVIEW_URL, { waitUntil: 'domcontentloaded' });
  const t0 = Date.now();
  const result = await page.evaluate(
    async ({ solverClientUrl, playerScript, cipherUrl, cipheredS }) => {
      // Import dinamis lewat Function: `import()` langsung di sini
      // diubah vite-node menjadi `__vite_ssr_dynamic_import__`.
      const dynamicImport = new Function('url', 'return import(url)') as (
        url: string,
      ) => Promise<{
        SolverClient: new () => {
          solve: (
            script: unknown,
            input: {
              cipherUrl: string;
              cipheredS: string;
              sigParam: string;
            },
          ) => Promise<string>;
          dispose: () => void;
        };
      }>;
      const { SolverClient } = await dynamicImport(solverClientUrl);
      const client = new SolverClient();
      try {
        const finalUrl = await client.solve(playerScript, {
          cipherUrl,
          cipheredS,
          sigParam: 'sig',
        });
        return { finalUrl };
      } finally {
        client.dispose();
      }
    },
    {
      solverClientUrl: `/assets/${solverClientFile}`,
      playerScript: script,
      cipherUrl: kCipherUrlFad,
      cipheredS: kCipheredS,
    },
  );
  const solveMs = Date.now() - t0;
  const parsed = new URL(result.finalUrl);
  const sig = parsed.searchParams.get('sig') ?? '';
  const n = parsed.searchParams.get('n') ?? '';
  const sigOk = fullyDecode(sig) === fullyDecode(kOracleSigFad);
  const nOk = n === EXPECTED_N;
  const hostOk = parsed.hostname.endsWith('.googlevideo.com');
  console.log(`solve di browser produksi: ${solveMs} ms`);
  console.log(`host googlevideo: ${hostOk ? 'YA' : 'TIDAK'}`);
  console.log(`sig cocok oracle: ${sigOk ? 'YA' : 'TIDAK'}`);
  console.log(`n transform cocok (4kdLuLGx-Us4iQ): ${nOk ? 'YA' : 'TIDAK'}`);
  console.log(`pageerror: ${workerErrors.length}`);
  if (!sigOk || !nOk || !hostOk || workerErrors.length > 0) {
    console.error('FAIL: solver produksi tidak lolos oracle');
    for (const e of workerErrors) console.error(`  pageerror: ${e}`);
    process.exit(1);
  }
  console.log('PASS: solver QuickJS-WASM bekerja di build produksi');
} finally {
  await browser.close();
}
