/**
 * Tes browser spike S1: solver QuickJS-WASM + fallback eval di Web
 * Worker ASLI (Chromium), terhadap base.js asli ketiga hash.
 *
 * Dijalankan dengan konfigurasi khusus spike (vite dev, port 5199):
 *   npx playwright test -c playwright.spike-s1.config.ts
 * Di bawah konfigurasi E2E utama (preview build, port 4173) tes ini
 * MELEWATI dirinya sendiri - halaman spike tidak ada di build produksi.
 *
 * Selain asersi oracle, tes ini menulis hasil ukur mentah ke
 * `docs/spikes/s1-s4-browser-measurements.json` (bukti angka laporan).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

import type { SpikeResult } from '../../../src/solver/spikePage';

test.skip(
  async ({ baseURL }) => (baseURL ?? '').includes('4173'),
  'spike S1 hanya jalan di vite dev (port 5199), bukan preview build',
);

const kFullBaseJs: Record<string, string> = {
  fad7e4e9: `${process.env.HOME}/workspace/music-app/hidden_files/tim-p1-spike/base-fad7e4e9.js`,
  ad8d59ae: `${process.env.HOME}/workspace/music-app/hidden_files/koordinator-fase-2/base_ad8d59ae.js`,
  b559f50c: `${process.env.HOME}/workspace/music-app/hidden_files/koordinator-fase-2/base_b559f50c.js`,
};

function loadFullBaseJs(hash: string): string {
  const path = kFullBaseJs[hash];
  if (!existsSync(path)) {
    throw new Error(`base.js ${hash} tidak ditemukan di ${path}`);
  }
  return readFileSync(path, 'utf8');
}

test('S1 browser: QuickJS-WASM solve ketiga hash + fallback eval sepakat', async ({
  page,
}) => {
  const baseJsByHash: Record<string, string> = {
    fad7e4e9: loadFullBaseJs('fad7e4e9'),
    ad8d59ae: loadFullBaseJs('ad8d59ae'),
    b559f50c: loadFullBaseJs('b559f50c'),
  };

  await page.goto('/spike-s1.html');
  await expect(page.locator('#status')).toHaveText('siap', {
    timeout: 60000,
  });

  const result = await page.evaluate<
    SpikeResult,
    Record<string, string>
  >((baseJs) => window.__runSolverSpike(baseJs), baseJsByHash);

  // Simpan hasil ukur mentah untuk laporan spike.
  const outPath = resolve(
    process.cwd(),
    '../docs/spikes/s1-s4-browser-measurements.json',
  );
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);

  // Jalur utama: QuickJS-WASM.
  expect(result.quickjs.error, 'QuickJS-WASM error').toBeNull();
  expect(result.quickjs.hashes.map((h) => h.hash)).toEqual([
    'fad7e4e9',
    'ad8d59ae',
    'b559f50c',
  ]);
  for (const h of result.quickjs.hashes) {
    expect(h.finalUrl).toMatch(/^https:\/\/[^/]+\.googlevideo\.com\//);
    expect(h.sigParam).not.toBeNull();
    expect(h.nParam).not.toBeNull();
    expect(h.medianSolveMs).toBeLessThan(10000);
  }
  const fad = result.quickjs.hashes[0];
  const ad8 = result.quickjs.hashes[1];
  expect(fad.sigMatchesOracle, 'sig fad7e4e9 vs oracle').toBe(true);
  expect(ad8.nMatchesOracle, 'n ad8d59ae vs oracle').toBe(true);
  expect(result.quickjs.hashes[2].nParam).not.toBe('AN4ZrqC9mKvCumNnl');

  // Fallback lapis 1: eval V8 - harus sepakat byte-identik dengan QuickJS.
  expect(result.evalFallback.error, 'eval fallback error').toBeNull();
  expect(result.evalFallback.hashes.map((h) => h.hash)).toEqual([
    'fad7e4e9',
    'ad8d59ae',
    'b559f50c',
  ]);
  for (let i = 0; i < 3; i++) {
    const quickUrl = result.quickjs.hashes[i].finalUrl;
    const evalUrl = result.evalFallback.hashes[i].finalUrl;
    expect(evalUrl, `URL final ${result.quickjs.hashes[i].hash}`).toBe(
      quickUrl,
    );
  }
  expect(result.evalFallback.hashes[0].sigMatchesOracle).toBe(true);
  expect(result.evalFallback.hashes[1].nMatchesOracle).toBe(true);
});
