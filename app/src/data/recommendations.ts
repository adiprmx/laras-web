/**
 * Rumus "Lagu untukmu" — rekomendasi LOKAL, tanpa server, tanpa
 * telemetri, tanpa machine learning (PRD B6.2, USULAN yang
 * diputuskan koordinator).
 *
 * Skor satu lagu:
 *   jumlah putaran bermakna (30 detik atau lebih) dalam 30 hari
 *   terakhir, tambah 5 bila difavoritkan, tambah 2 bila diunduh.
 * Urutan: skor tertinggi dulu; seri dipecah waktu putar terakhir
 * (paling baru dulu); seri penuh dipecah videoId supaya urutan
 * deterministik. Ambil 20 teratas; bila kurang dari 20, isi sisa
 * dengan lagu library terbaru.
 *
 * Contoh hitung (terverifikasi koordinator di PRD APK): lagu B
 * dengan 9 putaran bermakna, lagu A dengan 3 putaran dan
 * difavoritkan (3 tambah 5 sama dengan 8), lagu C dengan 1 putaran
 * dan diunduh (1 tambah 2 sama dengan 3); urutan B, A, C.
 *
 * Modul ini murni (tidak menyentuh database): agregasi data hidup
 * di `LibraryService.forYouSongs`, pengurutan hidup di sini supaya
 * bisa diuji tanpa IndexedDB.
 */

/** Jumlah lagu "Lagu untukmu" paling banyak. */
export const FOR_YOU_LIMIT = 20;

/** Jendela putaran bermakna: 30 hari. */
export const FOR_YOU_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Bonus skor bila lagu difavoritkan. */
export const FOR_YOU_FAVORITE_BONUS = 5;

/** Bonus skor bila lagu diunduh. */
export const FOR_YOU_DOWNLOAD_BONUS = 2;

/** Satu kandidat "Lagu untukmu" (agregat dari database). */
export interface ForYouCandidate {
  songId: string;
  /** Putaran bermakna (30 detik+) dalam 30 hari terakhir. */
  meaningfulPlays: number;
  /** Waktu putar terakhir (epoch ms), 0 bila belum pernah diputar. */
  lastPlayedAt: number;
  liked: boolean;
  downloaded: boolean;
}

/** Skor satu kandidat sesuai rumus PRD B6.2. */
export function forYouScore(candidate: ForYouCandidate): number {
  let score = candidate.meaningfulPlays;
  if (candidate.liked) score += FOR_YOU_FAVORITE_BONUS;
  if (candidate.downloaded) score += FOR_YOU_DOWNLOAD_BONUS;
  return score;
}

/**
 * Urutkan kandidat sesuai rumus: skor tertinggi dulu, seri dipecah
 * waktu putar terakhir (paling baru dulu), seri penuh dipecah
 * songId. Mengembalikan paling banyak `limit` kandidat.
 */
export function rankForYou(
  candidates: ForYouCandidate[],
  limit: number = FOR_YOU_LIMIT,
): ForYouCandidate[] {
  const scored = candidates.map((c) => ({ candidate: c, score: forYouScore(c) }));
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.candidate.lastPlayedAt !== b.candidate.lastPlayedAt) {
      return b.candidate.lastPlayedAt - a.candidate.lastPlayedAt;
    }
    return a.candidate.songId < b.candidate.songId
      ? -1
      : a.candidate.songId > b.candidate.songId
        ? 1
        : 0;
  });
  return scored.slice(0, limit).map((s) => s.candidate);
}

/**
 * Isi sisa daftar "Lagu untukmu" dengan lagu library terbaru yang
 * belum ada di daftar. `rankedIds` adalah id yang sudah terpilih,
 * `newestIds` adalah id library urut terbaru dulu.
 */
export function fillForYou(
  rankedIds: string[],
  newestIds: string[],
  limit: number = FOR_YOU_LIMIT,
): string[] {
  if (rankedIds.length >= limit) return rankedIds.slice(0, limit);
  const seen = new Set(rankedIds);
  const out = [...rankedIds];
  for (const id of newestIds) {
    if (out.length >= limit) break;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
