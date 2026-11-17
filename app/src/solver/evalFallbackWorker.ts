/**
 * Web Worker khusus fallback lapis 1 (keputusan-solver §7): eval
 * langsung di worker, tanpa WASM.
 *
 * Protokol pesan IDENTIK dengan `solverWorker.ts` (init/solve/memory),
 * supaya klien bisa bertukar mesin tanpa mengubah pemanggil. Satu-satunya
 * perbedaan: pesan `memory` di sini mengembalikan null (V8 tidak
 * memberi angka memori per-eval seperti `computeMemoryUsage` QuickJS;
 * pengukuran memori fallback memakai `performance.memory` di halaman
 * atau RSS proses).
 */
import { EvalEngine } from './evalEngine';
import type {
  SolverWorkerRequest,
  SolverWorkerResponse,
} from './solverWorker';

const engine = new EvalEngine();
let loadedHash: string | null = null;

self.onmessage = (event: MessageEvent<SolverWorkerRequest>) => {
  const request = event.data;
  const reply = (response: SolverWorkerResponse): void => {
    self.postMessage(response);
  };
  try {
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
      reply({
        type: 'error',
        id: request.id,
        message: 'statistik memori tidak tersedia di mesin eval',
      });
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
