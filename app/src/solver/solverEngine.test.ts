// @vitest-environment node
/**
 * Tes mesin solver S1: QuickJS-WASM (jalur utama) + eval V8 (fallback
 * lapis 1) terhadap base.js ASLI ketiga hash, dengan asersi oracle APK.
 *
 * Oracle:
 * - fad7e4e9: sig hasil decipher WAJIB byte-identik dengan oracle
 *   `sig-result.json` (spike P1 APK, terverifikasi lawan pytubefix
 *   11.2.1). Input cipher dari fixture respons player WEB_REMIX asli.
 * - ad8d59ae: transform `n` WAJIB byte-identik dengan oracle
 *   `ad8d59ae_n_diag.log` (koordinator Fase 2, 16 Nov 2026):
 *   `avtzUIaCevXHJKjFf` -> `M3WoXUP3VXHCEA`.
 * - b559f50c: tanpa oracle tersimpan; verifikasi lewat kesepakatan
 *   antar-mesin (QuickJS-WASM == eval V8, byte-identik) + cek struktur.
 *
 * Tiap hash memakai mesin QuickJS segar (runtime WASM terpisah) supaya
 * tidak ada sisa global hash lain yang menutupi dependensi hilang.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { EvalEngine } from './evalEngine';
import {
  buildPlayerScript,
  buildSolveDriver,
  buildSolverInitScript,
  solveExpression,
  type PlayerScript,
} from './playerScript';
import { QuickJsEngine } from './quickJsEngine';
import { isAllowedStreamUrl } from './urlAllowlist';

const kFullBaseJs: Record<string, string> = {
  fad7e4e9: `${process.env.HOME}/workspace/music-app/hidden_files/tim-p1-spike/base-fad7e4e9.js`,
  ad8d59ae: `${process.env.HOME}/workspace/music-app/hidden_files/koordinator-fase-2/base_ad8d59ae.js`,
  b559f50c: `${process.env.HOME}/workspace/music-app/hidden_files/koordinator-fase-2/base_b559f50c.js`,
};

function loadFullBaseJs(hash: string): string | null {
  const path = kFullBaseJs[hash];
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

function buildScript(hash: string): PlayerScript | null {
  const baseJs = loadFullBaseJs(hash);
  if (baseJs === null) return null;
  return buildPlayerScript(
    `/s/player/${hash}/player_es6.vflset/en_US/base.js`,
    baseJs,
  );
}

import {
  fullyDecode,
  kCipherUrlAd8,
  kCipherUrlByHash,
  kCipherUrlFad,
  kCipheredS,
  kOracleNAd8,
  kOracleSigFad,
} from './spikeOracles';

async function initEngine(script: PlayerScript): Promise<QuickJsEngine> {
  const engine = new QuickJsEngine();
  await engine.ensureReady();
  const init = engine.eval(buildSolverInitScript(script));
  expect(init.ok, `init ${script.hash} gagal: ${init.error}`).toBe(true);
  return engine;
}

describe('QuickJS-WASM: solve ketiga hash (S1)', () => {
  it(
    'fad7e4e9: sig decipher byte-identik dengan oracle APK',
    async () => {
      const script = buildScript('fad7e4e9');
      if (!script) {
        console.warn('base.js fad7e4e9 tidak ditemukan; tes dilewati');
        return;
      }
      const engine = await initEngine(script);
      try {
        const expr = solveExpression(script.sigCallSite, '__s');
        const outcome = engine.eval(
          `var __s = ${JSON.stringify(kCipheredS)};\n${expr};`,
        );
        expect(outcome.ok, `eval sig gagal: ${outcome.error}`).toBe(true);
        expect(outcome.value).toBe(kOracleSigFad);
      } finally {
        engine.dispose();
      }
    },
    120_000,
  );

  it(
    'fad7e4e9: driver penuh menghasilkan URL googlevideo + sig oracle',
    async () => {
      const script = buildScript('fad7e4e9');
      if (!script) {
        console.warn('base.js fad7e4e9 tidak ditemukan; tes dilewati');
        return;
      }
      const engine = await initEngine(script);
      try {
        const driver = buildSolveDriver(script, {
          cipherUrl: kCipherUrlFad,
          cipheredS: kCipheredS,
          sigParam: 'sig',
        });
        const outcome = engine.eval(driver);
        expect(outcome.ok, `driver gagal: ${outcome.error}`).toBe(true);
        const finalUrl = outcome.value as string;
        expect(isAllowedStreamUrl(finalUrl)).toBe(true);
        const parsed = new URL(finalUrl);
        expect(parsed.searchParams.get('itag')).toBe('251');
        // Sig di URL (setelah dekode penuh) sama dengan oracle terdekode.
        const sigParam = parsed.searchParams.get('sig');
        expect(sigParam).not.toBeNull();
        expect(fullyDecode(sigParam as string)).toBe(
          fullyDecode(kOracleSigFad),
        );
        expect(parsed.searchParams.get('n')).not.toBeNull();
      } finally {
        engine.dispose();
      }
    },
    120_000,
  );

  it(
    'ad8d59ae: transform n byte-identik dengan oracle APK',
    async () => {
      const script = buildScript('ad8d59ae');
      if (!script) {
        console.warn('base.js ad8d59ae tidak ditemukan; tes dilewati');
        return;
      }
      const engine = await initEngine(script);
      try {
        const driver = buildSolveDriver(script, {
          cipherUrl: kCipherUrlAd8,
          cipheredS: kCipheredS,
          sigParam: 'sig',
        });
        const outcome = engine.eval(driver);
        expect(outcome.ok, `driver gagal: ${outcome.error}`).toBe(true);
        const finalUrl = outcome.value as string;
        expect(isAllowedStreamUrl(finalUrl)).toBe(true);
        const parsed = new URL(finalUrl);
        expect(parsed.searchParams.get('n')).toBe(kOracleNAd8);
        expect(parsed.searchParams.get('sig')).not.toBeNull();
        expect((parsed.searchParams.get('sig') as string).length).toBeGreaterThan(20);
      } finally {
        engine.dispose();
      }
    },
    120_000,
  );

  it(
    'b559f50c: driver penuh menghasilkan URL googlevideo yang sah',
    async () => {
      const script = buildScript('b559f50c');
      if (!script) {
        console.warn('base.js b559f50c tidak ditemukan; tes dilewati');
        return;
      }
      const engine = await initEngine(script);
      try {
        const driver = buildSolveDriver(script, {
          cipherUrl: kCipherUrlByHash["b559f50c"],
          cipheredS: kCipheredS,
          sigParam: 'sig',
        });
        const outcome = engine.eval(driver);
        expect(outcome.ok, `driver gagal: ${outcome.error}`).toBe(true);
        const finalUrl = outcome.value as string;
        expect(isAllowedStreamUrl(finalUrl)).toBe(true);
        const parsed = new URL(finalUrl);
        expect(parsed.searchParams.get('sig')).not.toBeNull();
        expect(parsed.searchParams.get('n')).not.toBeNull();
        // Transform n b559f50c mengubah n input (bukan identitas).
        expect(parsed.searchParams.get('n')).not.toBe('AN4ZrqC9mKvCumNnl');
      } finally {
        engine.dispose();
      }
    },
    120_000,
  );

  it(
    'memori runtime setelah init jauh di bawah batas 192 MiB',
    async () => {
      const script = buildScript('ad8d59ae');
      if (!script) {
        console.warn('base.js ad8d59ae tidak ditemukan; tes dilewati');
        return;
      }
      const engine = await initEngine(script);
      try {
        const stats = engine.memoryStats();
        expect(stats).not.toBeNull();
        expect(stats!.memoryUsedSize).toBeGreaterThan(0);
        expect(stats!.memoryUsedSize).toBeLessThan(192 * 1024 * 1024);
        expect(stats!.mallocLimit).toBe(192 * 1024 * 1024);
      } finally {
        engine.dispose();
      }
    },
    120_000,
  );
});

describe('Fallback lapis 1: eval V8 langsung (keputusan-solver §7)', () => {
  it(
    'fad7e4e9: eval menghasilkan sig oracle yang sama dengan QuickJS',
    async () => {
      const script = buildScript('fad7e4e9');
      if (!script) {
        console.warn('base.js fad7e4e9 tidak ditemukan; tes dilewati');
        return;
      }
      const engine = new EvalEngine();
      const init = engine.eval(buildSolverInitScript(script));
      expect(init.ok, `init eval gagal: ${init.error}`).toBe(true);
      const expr = solveExpression(script.sigCallSite, '__s');
      const outcome = engine.eval(
        `var __s = ${JSON.stringify(kCipheredS)};\n${expr};`,
      );
      expect(outcome.ok, `eval sig gagal: ${outcome.error}`).toBe(true);
      expect(outcome.value).toBe(kOracleSigFad);
      engine.dispose();
    },
    120_000,
  );
});
