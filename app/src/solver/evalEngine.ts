/**
 * Mesin fallback lapis 1 (keputusan-solver §7): eval langsung di
 * Web Worker khusus.
 *
 * Bila QuickJS-WASM gagal atau terlalu berat, solver tetap jalan di
 * browser dengan V8 native: base.js dievaluasi lewat eval tidak
 * langsung `(0, eval)(...)` di scope global worker, lalu driver
 * dijalankan dengan cara yang sama. V8 mengeksekusi base.js secara
 * native (lebih cepat dari QuickJS), tanpa modul WASM.
 *
 * Harga yang dibayar: halaman/worker butuh `unsafe-eval` di CSP, dan
 * base.js berjalan di V8 dengan akses API worker (fetch, dll.) -
 * permukaan lebih luas dari QuickJS-WASM yang ter-sandbox. Karena itu
 * ini CADANGAN, bukan jalur utama.
 *
 * Catatan implementasi: eval tidak langsung dipakai supaya deklarasi
 * top-level base.js (`var _yt_player`, fungsi, kelas) mendarat di scope
 * global worker dan tetap tersedia untuk evaluasi driver berikutnya.
 * `new Function` TIDAK bisa dipakai untuk ini (deklarasinya terjebak
 * di scope fungsi).
 */
import { ExtractorException } from './errors';
import { QuickJsLimits } from './limits';

export interface EvalOutcome {
  ok: boolean;
  value?: string;
  error?: string;
}

// Eval tidak langsung: memanggil `eval` lewat referensi member
// (`globalThis.eval`) adalah eval tidak langsung menurut spesifikasi
// ECMAScript - kode dievaluasi di scope global worker, bukan scope
// lokal modul ini. Bentuk `(0, eval)(...)` yang setara ditolak tsc
// (TS2695), jadi dipakai bentuk member ini.
const globalEval: (code: string) => unknown = globalThis.eval;

export class EvalEngine {
  private disposed = false;

  /**
   * Evaluasi `code` di scope global worker.
   * Timeout 10 detik TIDAK bisa ditegakkan dari dalam worker yang sama
   * (eval sinkron memblokir thread) - penegakannya adalah backstop
   * terminasi worker di sisi pemanggil (`solverClient.ts` memakai pola
   * yang sama; klien fallback memakai pola identik).
   */
  eval(code: string): EvalOutcome {
    if (this.disposed) {
      return { ok: false, error: 'mesin eval sudah ditutup' };
    }
    try {
      const value = globalEval(code);
      return {
        ok: true,
        value: typeof value === 'string' ? value : '',
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Tenggat yang dipakai backstop pemanggil (sama dengan QuickJS). */
  timeoutMs(): number {
    return QuickJsLimits.timeoutMs;
  }

  dispose(): void {
    this.disposed = true;
  }
}

/** Galat bila hasil eval bukan string (padanan cek driver di worker). */
export function assertDriverString(outcome: EvalOutcome): string {
  if (!outcome.ok) {
    throw new ExtractorException('solverTimeout', outcome.error ?? 'eval gagal');
  }
  if (typeof outcome.value !== 'string' || outcome.value === '') {
    throw new ExtractorException(
      'solverTimeout',
      'driver solver mengembalikan nilai bukan string',
    );
  }
  return outcome.value;
}
