// Rate limit proxy di D1 (Red 1 S3, arsitektur §4.1).
//
// Menggantikan bucket in-memory per isolate: satu IP tersebar ke
// banyak isolate (batas mudah dilampaui) dan bucket tidak pernah
// dibersihkan (kebocoran memori). D1 dipakai karena KV tulis hanya
// 1.000/hari — tidak cocok untuk tulis per request.
//
// Satu baris per (kunci, jendela menit): kunci `innertube:<ip>` atau
// `media:<ip>`, window_start = awal menit (epoch ms). Jendela
// selaras (fixed window), bukan sliding: cukup untuk melindungi
// kuota Workers dan membuat perilakunya deterministik di tes.
//
// Biaya kuota D1: 1 baris tulis + 1 baris baca per request. Tulis
// 100.000/hari seorde dengan kuota request Workers (100.000/hari),
// jadi rate limit tidak menjadi bottleneck baru sebelum kuota
// request itu sendiri. Baris kedaluwarsa disapu probabilistik
// (1% request) supaya tabel tidak tumbuh tanpa batas.
//
// Fail-open diputuskan di pemanggil (index.js): bila D1 gagal,
// request diizinkan + dicatat, bukan ditolak.

const WINDOW_MS = 60000;

/** Probabilitas sapu jendela kedaluwarsa per panggilan. */
export const SWEEP_PROBABILITY = 0.01;

/** Awal jendela menit untuk timestamp tertentu. */
export function windowStartFor(nowMs) {
  return Math.floor(nowMs / WINDOW_MS) * WINDOW_MS;
}

/**
 * Catat satu request untuk `key` dan laporkan apakah kunci ini
 * sudah melewati `limit` dalam jendela menit berjalan.
 * Melempar bila D1 gagal — pemanggil memutuskan fallback.
 */
export async function isRateLimited(db, key, limit, nowMs = Date.now()) {
  const windowStart = windowStartFor(nowMs);
  await db
    .prepare(
      'INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1) ' +
        'ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1',
    )
    .bind(key, windowStart)
    .run();
  const row = await db
    .prepare(
      'SELECT count FROM rate_limits WHERE key = ?1 AND window_start = ?2',
    )
    .bind(key, windowStart)
    .first();
  const limited = (row?.count ?? 0) > limit;
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

/** Hapus baris jendela yang sudah lewat (di luar jendela berjalan). */
export async function sweepExpiredWindows(db, nowMs = Date.now()) {
  const cutoff = windowStartFor(nowMs);
  await db
    .prepare('DELETE FROM rate_limits WHERE window_start < ?1')
    .bind(cutoff)
    .run();
}
