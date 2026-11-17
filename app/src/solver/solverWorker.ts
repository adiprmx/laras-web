/**
 * Web Worker khusus solver (QuickJS-WASM) - port isolate pekerja
 * `signature_solver.dart` APK.
 *
 * Protokol pesan (JSON, dua arah):
 * - Utama -> worker `{ type: 'init', hash, initScript }`:
 *   evaluasi stub + base.js + prelude sekali per hash.
 *   Balasan `{ type: 'ok' }` atau `{ type: 'error', message }`.
 * - Utama -> worker `{ type: 'solve', driver }`:
 *   jalankan driver, balas `{ type: 'ok', result }` atau
 *   `{ type: 'error', message }`. Driver wajib mengembalikan string.
 * - Utama -> worker `{ type: 'memory' }`:
 *   balas `{ type: 'ok', memory }` dengan statistik memori runtime
 *   (dipakai pengukuran spike; bukan jalur produksi).
 *
 * Worker tidak punya akses DOM; base.js yang tidak tepercaya tidak
 * pernah dievaluasi di konteks halaman utama. Komunikasi hanya lewat
 * `postMessage`. Satu runtime, eksekusi serial (klien menjamin hanya
 * satu request berjalan pada satu waktu).
 */
import { QuickJsEngine } from './quickJsEngine';

export interface SolverWorkerRequest {
  type: 'init' | 'solve' | 'memory';
  hash?: string;
  initScript?: string;
  driver?: string;
  id: number;
}

export interface SolverWorkerResponse {
  type: 'ok' | 'error';
  id: number;
  result?: string;
  message?: string;
  memory?: {
    memoryUsedSize: number;
    mallocLimit: number;
    jsFuncCodeSize: number;
  };
}

const engine = new QuickJsEngine();
let loadedHash: string | null = null;
let ready: Promise<void> | null = null;

function ensureEngine(): Promise<void> {
  if (!ready) ready = engine.ensureReady();
  return ready;
}

self.onmessage = async (event: MessageEvent<SolverWorkerRequest>) => {
  const request = event.data;
  const reply = (response: SolverWorkerResponse): void => {
    self.postMessage(response);
  };
  try {
    await ensureEngine();
    if (request.type === 'init') {
      if (request.hash === loadedHash) {
        reply({ type: 'ok', id: request.id });
        return;
      }
      if (typeof request.initScript !== 'string') {
        reply({
          type: 'error',
          id: request.id,
          message: 'init tanpa initScript',
        });
        return;
      }
      const outcome = engine.eval(request.initScript);
      if (!outcome.ok) {
        reply({ type: 'error', id: request.id, message: outcome.error });
        return;
      }
      loadedHash = request.hash ?? null;
      reply({ type: 'ok', id: request.id });
      return;
    }
    if (request.type === 'solve') {
      if (loadedHash === null) {
        reply({
          type: 'error',
          id: request.id,
          message: 'solve sebelum init',
        });
        return;
      }
      if (typeof request.driver !== 'string') {
        reply({
          type: 'error',
          id: request.id,
          message: 'solve tanpa driver',
        });
        return;
      }
      const outcome = engine.eval(request.driver);
      if (!outcome.ok) {
        reply({ type: 'error', id: request.id, message: outcome.error });
        return;
      }
      if (typeof outcome.value !== 'string' || outcome.value === '') {
        reply({
          type: 'error',
          id: request.id,
          message: 'driver solver mengembalikan nilai bukan string',
        });
        return;
      }
      reply({ type: 'ok', id: request.id, result: outcome.value });
      return;
    }
    if (request.type === 'memory') {
      const memory = engine.memoryStats();
      if (!memory) {
        reply({
          type: 'error',
          id: request.id,
          message: 'statistik memori tidak tersedia',
        });
        return;
      }
      reply({ type: 'ok', id: request.id, memory });
      return;
    }
    reply({ type: 'error', id: request.id, message: 'tipe pesan tidak dikenal' });
  } catch (error) {
    reply({
      type: 'error',
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
