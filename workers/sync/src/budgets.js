// Worker sync — Anggaran tulis/baca harian (S8b/S11b) (P-SyncSplit).
// Dipindah verbatim dari index.js (P-SyncSplit); logika
// tidak berubah. Impor di bawah dihitung dari graf
// dependensi, bukan tebakan.

import {
  DAILY_READ_BUDGET,
  DAILY_WRITE_BUDGET,
  READ_BUDGET_RESERVE_PER_PULL,
} from './constants.js';
import { jsonError } from '../../shared/http.js';
import { logWarn } from '../../shared/log.js';

/**
 * Pra-cek anggaran tulis (S12a): true bila push bertagihan
 * `charge` PASTI ditolak anggaran (dipakai router SEBELUM
 * menulis baris rate-limit). Fail-open: galat D1 / tabel belum
 * ada berarti "lanjut" — reservasi atomik di handlePush tetap
 * menjadi penegak sesungguhnya.
 */
export async function writeBudgetExhausted(env, userId, charge) {
  if (!env.DB) return false;
  try {
    const day = new Date(Date.now()).toISOString().slice(0, 10);
    const row = await env.DB.prepare(
      'SELECT rows_written FROM sync_write_budget WHERE user_id = ? AND day = ?',
    )
      .bind(userId, day)
      .first();
    return (row ? Number(row.rows_written) : 0) + charge > DAILY_WRITE_BUDGET;
  } catch {
    return false;
  }
}

/** Pra-cek anggaran baca (S11b+S12a): true bila pull PASTI ditolak. */
export async function readBudgetExhausted(env, userId) {
  if (!env.DB) return false;
  try {
    const day = new Date(Date.now()).toISOString().slice(0, 10);
    const row = await env.DB.prepare(
      'SELECT rows_read FROM sync_read_budget WHERE user_id = ? AND day = ?',
    )
      .bind(userId, day)
      .first();
    return (
      (row ? Number(row.rows_read) : 0) + READ_BUDGET_RESERVE_PER_PULL >
      DAILY_READ_BUDGET
    );
  } catch {
    return false;
  }
}

/**
 * Kembalikan reservasi anggaran tulis (I23b): tepat sebesar
 * reservasi push itu (tidak bisa menggandakan anggaran —
 * dipanggil sekali per push yang gagal, tanpa retry, dan
 * dijaga lantai 0). Best-effort: gagal refund hanya membuat
 * pengguna kehilangan anggaran push itu (arah aman).
 */
export async function refundWriteBudget(db, userId, day, amount) {
  if (!amount || amount <= 0) return;
  try {
    await db
      .prepare(
        'UPDATE sync_write_budget SET rows_written = MAX(0, rows_written - ?) WHERE user_id = ? AND day = ?',
      )
      .bind(amount, userId, day)
      .run();
  } catch (e) {
    logWarn('anggaran tulis: gagal refund (anggaran push hangus)', { error: e instanceof Error ? e.message : 'unknown' });
  }
}

/** Kegagalan penghitung yang jujur (I23a): refund + 500 yang jelas. */
export async function failCountsUnavailable(db, userId, day, reservedCharge) {
  await refundWriteBudget(db, userId, day, reservedCharge);
  return jsonError(
    500,
    'SYNC_TEMPORARILY_UNAVAILABLE',
    'Sinkronisasi gagal sesaat. Coba lagi.',
  );
}
