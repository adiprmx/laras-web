/**
 * Klien solver di thread utama - port `QuickJsSignatureSolver` APK
 * (bagian isolate utama) ke Web Worker.
 *
 * - Satu Web Worker khusus memegang satu runtime QuickJS-WASM.
 * - Antrean serial: solve berikutnya menunggu yang berjalan selesai.
 * - Hash yang sudah dimuat di worker di-cache: init ulang hanya bila
 *   hash berubah.
 * - Timeout 10 detik per request ditegakkan di sisi pemanggil: bila
 *   worker tidak merespons, worker diterminasi dan dibuat ulang
 *   (backstop, padanan bunuh-isolate APK).
 * - Hasil solver divalidasi allowlist: hanya URL `*.googlevideo.com`
 *   yang boleh dipakai (R1-M1).
 */
import { ExtractorException } from './errors';
import { QuickJsLimits } from './limits';
import {
  buildSolveDriver,
  buildSolverInitScript,
  type PlayerScript,
} from './playerScript';
import type {
  SolverWorkerRequest,
  SolverWorkerResponse,
} from './solverWorker';
import { isAllowedStreamUrl } from './urlAllowlist';

export interface SolveInput {
  cipherUrl: string;
  cipheredS: string;
  sigParam: string;
}

interface PendingRequest {
  resolve: (value: SolverWorkerResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SolverClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private queue: Promise<void> = Promise.resolve();
  private loadedHash: string | null = null;
  private disposed = false;
  private readonly workerUrl: URL | null;

  /**
   * @param workerUrl URL worker solver (khusus spike S1 di mode dev:
   *   menguji worker fallback eval `evalFallbackWorker.ts` dengan
   *   klien yang sama). Tanpa parameter, klien memakai worker
   *   QuickJS-WASM lewat pola `new Worker(new URL(...))` langsung.
   *
   * Pola langsung ini WAJIB dipertahankan: `new URL(...)` yang
   * disimpan dulu ke variabel lalu diteruskan ke `new Worker`
   * TIDAK dikenali Vite sebagai worker, sehingga build produksi
   * mengubahnya menjadi data URL berisi sumber TypeScript mentah
   * (terbukti 18 Nov 2026: worker solver gagal total di build
   * produksi sampai pola ini diperbaiki).
   */
  constructor(workerUrl?: URL) {
    this.workerUrl = workerUrl ?? null;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    let worker: Worker;
    if (this.workerUrl) {
      worker = new Worker(this.workerUrl, {
        type: 'module',
      });
    } else {
      // Pola worker Vite: `new URL` HARUS langsung di dalam
      // `new Worker` (lihat komentar konstruktor).
      worker = new Worker(new URL('./solverWorker.ts', import.meta.url), {
        type: 'module',
      });
    }
    worker.onmessage = (event: MessageEvent<SolverWorkerResponse>) => {
      const response = event.data;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      pending.resolve(response);
    };
    worker.onerror = (event) => {
      const error = new ExtractorException(
        'solverTimeout',
        `worker solver gagal: ${event.message}`,
      );
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    };
    this.worker = worker;
    return worker;
  }

  private request(
    message: Omit<SolverWorkerRequest, 'id'>,
  ): Promise<SolverWorkerResponse> {
    if (this.disposed) {
      return Promise.reject(
        new ExtractorException('solverTimeout', 'solver sudah ditutup'),
      );
    }
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<SolverWorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Backstop: interrupt handler QuickJS seharusnya sudah memutus
        // evaluasi yang melewati batas; timer ini berjaga bila worker
        // tidak merespons sama sekali. Worker diterminasi supaya
        // eksekusi JS yang nyangkut ikut mati (padanan bunuh-isolate).
        this.pending.delete(id);
        this.killWorker();
        reject(
          new ExtractorException(
            'solverTimeout',
            'eksekusi QuickJS melewati 10 detik',
          ),
        );
      }, QuickJsLimits.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ ...message, id } satisfies SolverWorkerRequest);
    });
  }

  private killWorker(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.loadedHash = null;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(
        new ExtractorException('solverTimeout', 'worker solver diterminasi'),
      );
    }
    this.pending.clear();
  }

  /**
   * Hitung URL final yang bisa diputar dari format cipher.
   * Melempar `ExtractorException` penyebab `solverTimeout` bila eksekusi
   * melewati batas waktu, atau `parseFailed` bila hasil di luar host
   * yang diizinkan.
   */
  solve(script: PlayerScript, input: SolveInput): Promise<string> {
    const job = this.queue.then(() => this.solveLocked(script, input));
    // Antrean tidak boleh macet karena satu job gagal.
    this.queue = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }

  private async solveLocked(
    script: PlayerScript,
    input: SolveInput,
  ): Promise<string> {
    if (this.disposed) {
      throw new ExtractorException('solverTimeout', 'solver sudah ditutup');
    }
    if (this.loadedHash !== script.hash) {
      const initScript = buildSolverInitScript(script);
      const initResponse = await this.request({
        type: 'init',
        hash: script.hash,
        initScript,
      });
      if (initResponse.type !== 'ok') {
        throw new ExtractorException(
          'solverTimeout',
          `QuickJS error: ${initResponse.message ?? 'init gagal'}`,
        );
      }
      this.loadedHash = script.hash;
    }
    const driver = buildSolveDriver(script, {
      cipherUrl: input.cipherUrl,
      cipheredS: input.cipheredS,
      sigParam: input.sigParam,
    });
    const response = await this.request({ type: 'solve', driver });
    if (response.type !== 'ok' || typeof response.result !== 'string') {
      throw new ExtractorException(
        'solverTimeout',
        `QuickJS error: ${response.message ?? 'solve gagal'}`,
      );
    }
    const result = response.result;
    // R1-M1: hasil solver adalah URL dari JS jaringan - host-nya harus
    // googlevideo.com, bukan sekadar ber-skema https.
    if (result === '' || !isAllowedStreamUrl(result)) {
      throw new ExtractorException(
        'parseFailed',
        'solver mengembalikan URL di luar host yang diizinkan',
      );
    }
    return result;
  }

  /** Statistik memori runtime QuickJS di worker (pengukuran spike). */
  async memoryStats(): Promise<{
    memoryUsedSize: number;
    mallocLimit: number;
    jsFuncCodeSize: number;
  } | null> {
    const response = await this.request({ type: 'memory' });
    return response.memory ?? null;
  }

  dispose(): void {
    this.disposed = true;
    this.killWorker();
  }
}
