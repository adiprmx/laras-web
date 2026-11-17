/**
 * Mesin solver QuickJS-WASM (port `signature_solver.dart` APK ke web).
 *
 * Satu runtime QuickJS di dalam WebAssembly, dipakai serial (satu solve
 * pada satu waktu). Batas operasi dipin dari APK (`limits.ts`):
 * memori 192 MiB, stack 256 KiB, timeout 10 detik per eksekusi.
 *
 * Mesin: quickjs-emscripten-core 0.32.0 + varian singlefile browser
 * (WASM tertanam base64 di modul JS, jadi tidak butuh fetch berkas
 * .wasm terpisah di dalam Web Worker - andal di Vite dev maupun build).
 * Varian ini memakai QuickJS bellard (vendored 2026-02-15). Varian
 * quickjs-ng di paket yang sama masih di v0.12.1 - DI BAWAH lantai
 * 0.16.0 yang dipin APK untuk perbaikan CVE-2026-120438/120439/120440 -
 * jadi varian ng TIDAK dipakai sampai quickjs-emscripten membundel
 * quickjs-ng >= 0.16.0 (lihat docs/spikes/s1-s4-solver.md).
 *
 * Keamanan: tidak ada callback host yang didaftarkan dan tidak ada
 * fetch dari dalam JS - runtime murni komputasi, sama seperti APK.
 * Timeout ditegakkan interrupt handler QuickJS (padanan gg_quickjs);
 * klien (`solverClient.ts`) menambahkan backstop terminasi worker.
 */
import variant from '@jitl/quickjs-singlefile-browser-release-sync';
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from 'quickjs-emscripten-core';

import { ExtractorException } from './errors';
import { QuickJsLimits } from './limits';

/** Hasil evaluasi: nilai string, atau galat dengan pesan. */
export interface EvalOutcome {
  ok: boolean;
  value?: string;
  error?: string;
}

/** Statistik memori runtime QuickJS (dari `computeMemoryUsage`). */
export interface QuickJsMemoryStats {
  /** Byte yang dipakai objek runtime (`memory_used_size`). */
  memoryUsedSize: number;
  /** Batas malloc runtime (`malloc_limit`, 192 MiB setelah diset). */
  mallocLimit: number;
  /** Byte bytecode fungsi JS (`js_func_code_size`). */
  jsFuncCodeSize: number;
}

export class QuickJsEngine {
  private modulePromise: Promise<QuickJSWASMModule> | null = null;
  private runtime: QuickJSRuntime | null = null;
  private context: QuickJSContext | null = null;
  private deadlineMs = 0;
  private disposed = false;

  /** Muat modul WASM + buat runtime dan konteks (sekali saja). */
  async ensureReady(): Promise<void> {
    if (this.disposed) {
      throw new ExtractorException('solverTimeout', 'mesin solver sudah ditutup');
    }
    if (this.context) return;
    if (!this.modulePromise) {
      this.modulePromise = newQuickJSWASMModuleFromVariant(variant);
    }
    const module = await this.modulePromise;
    const runtime = module.newRuntime();
    runtime.setMemoryLimit(QuickJsLimits.memoryBytes);
    runtime.setMaxStackSize(QuickJsLimits.stackBytes);
    runtime.setInterruptHandler(() => {
      // Dipanggil berkala oleh interpreter saat eksekusi berjalan.
      // Kembalikan true bila tenggat 10 detik sudah lewat. Tenggat 0
      // berarti tidak ada evaluasi yang sedang dijaga.
      return this.deadlineMs !== 0 && Date.now() > this.deadlineMs;
    });
    this.runtime = runtime;
    this.context = runtime.newContext();
  }

  /**
   * Evaluasi `code` di konteks solver dengan tenggat 10 detik.
   * Mengembalikan nilai penyelesaian sebagai string (bila string),
   * atau string kosong untuk nilai bukan string (dipakai init).
   */
  eval(code: string): EvalOutcome {
    if (!this.context) {
      return { ok: false, error: 'mesin solver belum siap' };
    }
    this.deadlineMs = Date.now() + QuickJsLimits.timeoutMs;
    try {
      const result = this.context.evalCode(code);
      if (result.error !== undefined) {
        const message = this.dumpError(result.error);
        result.error.dispose();
        return { ok: false, error: message };
      }
      const handle = result.value;
      let value = '';
      try {
        value = this.context.dump(handle);
      } finally {
        handle.dispose();
      }
      return { ok: true, value: typeof value === 'string' ? value : '' };
    } catch (error) {
      return { ok: false, error: String(error) };
    } finally {
      // Tenggat dimatikan lagi: interrupt handler tidak boleh memutus
      // evaluasi berikutnya yang belum dipasangi tenggat baru.
      this.deadlineMs = 0;
    }
  }

  /** Statistik memori runtime saat ini (untuk pengukuran spike). */
  memoryStats(): QuickJsMemoryStats | null {
    if (!this.runtime || !this.context) return null;
    const handle = this.runtime.computeMemoryUsage();
    try {
      const dumped = this.context.dump(handle) as Record<string, unknown>;
      return {
        memoryUsedSize: Number(dumped['memory_used_size'] ?? 0),
        mallocLimit: Number(dumped['malloc_limit'] ?? 0),
        jsFuncCodeSize: Number(dumped['js_func_code_size'] ?? 0),
      };
    } finally {
      handle.dispose();
    }
  }

  private dumpError(handle: Parameters<QuickJSContext['dump']>[0]): string {
    if (!this.context) return 'galat QuickJS (konteks hilang)';
    try {
      const dumped = this.context.dump(handle) as Record<string, unknown>;
      if (dumped && typeof dumped === 'object') {
        const name = typeof dumped['name'] === 'string' ? dumped['name'] : '';
        const message =
          typeof dumped['message'] === 'string' ? dumped['message'] : '';
        const combined = name ? `${name}: ${message}` : message;
        if (combined) return combined;
      }
      return String(dumped);
    } catch {
      return 'galat QuickJS (tidak bisa dibaca)';
    }
  }

  dispose(): void {
    this.disposed = true;
    this.context?.dispose();
    this.context = null;
    this.runtime?.dispose();
    this.runtime = null;
  }
}
