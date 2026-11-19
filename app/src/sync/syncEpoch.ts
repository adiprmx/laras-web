/**
 * Generasi sinkronisasi (R18): penghitung yang naik setiap kali
 * wipe dimulai. Putaran sync yang sedang berjalan menangkap
 * generasi di awal dan memeriksa sebelum SETIAP penulisan —
 * bila generasi berubah, putaran berhenti tanpa menulis lagi,
 * sehingga tarik yang sudah diotorisasi sebelum logout tidak
 * bisa membangkitkan data ke database segar sesudah wipe.
 *
 * Modul kecil tanpa dependensi, sengaja BUKAN di syncStore:
 * syncService tidak boleh mengimpor store (store mengimpor
 * syncService — siklus), dan wipe.ts butuh memanggilnya tanpa
 * menarik seluruh graf syncService.
 */
let epoch = 0;

/** Generasi saat ini (ditangkap putaran sync di awal). */
export function currentSyncEpoch(): number {
  return epoch;
}

/** Naikkan generasi: batalkan semua putaran sync yang berjalan. */
export function invalidateSyncEpoch(): void {
  epoch += 1;
}

/** Apakah generasi yang ditangkap putaran masih berlaku. */
export function isSyncEpochCurrent(captured: number): boolean {
  return captured === epoch;
}
