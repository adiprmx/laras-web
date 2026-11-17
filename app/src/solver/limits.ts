/**
 * Batas operasi runtime solver (port `QuickJsLimits` APK,
 * `signature_solver.dart`).
 *
 * Angka-angka ini berasal dari SimpMusic dan terbukti di APK:
 * membangun AST base.js (~2,6 MiB) butuh lebih dari 128 MiB, jadi batas
 * memori 192 MiB bukan angka sembarang. Stack 256 KiB adalah batas aman
 * praktis; jangan naikkan tanpa bukti (README gg_quickjs: limit di atas
 * 512 KiB bisa crash proses native).
 */
export const QuickJsLimits = {
  /** Memori maksimum runtime: 192 MiB. */
  memoryBytes: 192 * 1024 * 1024,

  /** Stack maksimum runtime: 256 KiB. */
  stackBytes: 256 * 1024,

  /** Timeout satu eksekusi (init maupun solve): 10 detik. */
  timeoutMs: 10_000,
} as const;
