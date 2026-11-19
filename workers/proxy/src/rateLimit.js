// Rate limit proxy di D1 (Red 1 S3, arsitektur §4.1).
//
// Menggantikan bucket in-memory per isolate: satu IP tersebar ke
// banyak isolate (batas mudah dilampaui) dan bucket tidak pernah
// dibersihkan (kebocoran memori). D1 dipakai karena KV tulis hanya
// 1.000/hari — tidak cocok untuk tulis per request.
//
// Satu baris per (kunci, jendela): kunci `innertube:<ip>` atau
// `media:<ip>`, window_start = awal jendela (epoch ms). Jendela
// selaras (fixed window), bukan sliding: cukup untuk melindungi
// kuota Workers dan membuat perilakunya deterministik di tes.
// Jendela bawaan 1 menit; pemanggil boleh memakai jendela lebih
// panjang (mis. 1 jam untuk hapus akun, S10) lewat parameter
// windowMs.
//
// Biaya kuota D1: 1 baris tulis + 1-2 baris baca per request
// yang DIIZINKAN; request yang SUDAH dibatasi tidak menulis
// apa-apa (S12b: SELECT dulu, tolak tanpa UPSERT). Tulis
// 100.000/hari seorde dengan kuota request Workers (100.000/hari),
// jadi rate limit tidak menjadi bottleneck baru sebelum kuota
// request itu sendiri. Baris kedaluwarsa disapu probabilistik
// (1% request) supaya tabel tidak tumbuh tanpa batas.
//
// Fail-open diputuskan di pemanggil (index.js): bila D1 gagal,
// request diizinkan + dicatat, bukan ditolak.

const WINDOW_MS = 60000;

/** Jendela terpanjang yang dipakai sistem (1 jam, rate limit hapus akun S10). */
export const MAX_WINDOW_MS = 3600000;

/**
 * Retensi sapu: baris dipertahankan selama jendela TERPANJANG
 * (1 jam). Sapu yang memakai retensi 1 menit akan menghapus
 * baris berjendela jam milik pemanggil lain yang berbagi tabel
 * ini (proxy + sync memakai satu database D1), sehingga batas
 * per jam menjadi tidak efektif. Harga: satu kunci aktif
 * memegang paling banyak ~60 baris menit sebelum disapu
 * (tetap kecil: puluhan ribu baris untuk ratusan IP aktif).
 */
const SWEEP_RETENTION_MS = MAX_WINDOW_MS;

/** Probabilitas sapu jendela kedaluwarsa per panggilan. */
export const SWEEP_PROBABILITY = 0.01;

/** Awal jendela untuk timestamp tertentu (jendela bawaan 1 menit). */
export function windowStartFor(nowMs, windowMs = WINDOW_MS) {
  return Math.floor(nowMs / windowMs) * windowMs;
}

/**
 * Catat satu request untuk `key` dan laporkan apakah kunci ini
 * sudah melewati `limit` dalam jendela berjalan.
 * Melempar bila D1 gagal — pemanggil memutuskan fallback.
 *
 * S12b: SELECT dulu — request yang sudah melewati batas ditolak
 * TANPA menulis baris. Tanpa ini, penyerang yang membanjiri di
 * atas batas tetap membakar 1 baris tulis D1 per request yang
 * ditolak (kuota tulis bersama bisa dihabiskan 2 akun dalam
 * ~19 jam, Red 6 S12). Sesudah UPSERT, hitungan dibaca ulang
 * supaya vonis memakai nilai sesudah increment (eksak di bawah
 * konkurensi: tanpa baca ulang, seluruh burst bersamaan yang
 * membaca nilai pra-tulis yang sama bisa sama-sama lolos).
 * Race tersisa: dua request bersamaan di batas bisa sama-sama
 * ditolak (arah aman: menolak, bukan meloloskan).
 */
export async function isRateLimited(
  db,
  key,
  limit,
  nowMs = Date.now(),
  windowMs = WINDOW_MS,
) {
  const windowStart = windowStartFor(nowMs, windowMs);
  const before = await db
    .prepare(
      'SELECT count FROM rate_limits WHERE key = ?1 AND window_start = ?2',
    )
    .bind(key, windowStart)
    .first();
  // Sudah dibatasi: tolak tanpa tulis (S12b).
  if ((before?.count ?? 0) > limit) return true;
  await db
    .prepare(
      'INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1) ' +
        'ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1',
    )
    .bind(key, windowStart)
    .run();
  const after = await db
    .prepare(
      'SELECT count FROM rate_limits WHERE key = ?1 AND window_start = ?2',
    )
    .bind(key, windowStart)
    .first();
  const limited = (after?.count ?? 0) > limit;
  // Sapu probabilistik: kegagalan sapu tidak boleh mengubah vonis.
  if (Math.random() < SWEEP_PROBABILITY) {
    try {
      await sweepExpiredWindows(db, nowMs);
    } catch {
      // Abaikan: sapu adalah perawatan, bukan bagian vonis.
    }
  }
  return limited;
}

/**
 * Hapus baris jendela yang sudah lewat (di luar retensi 1 jam —
 * jendela terpanjang sistem, lihat SWEEP_RETENTION_MS).
 */
export async function sweepExpiredWindows(db, nowMs = Date.now()) {
  const cutoff = nowMs - SWEEP_RETENTION_MS;
  await db
    .prepare('DELETE FROM rate_limits WHERE window_start < ?1')
    .bind(cutoff)
    .run();
}
