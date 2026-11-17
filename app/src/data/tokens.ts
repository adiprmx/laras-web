/**
 * Tokenizer + skor pencarian lokal (logika murni, tanpa IndexedDB).
 *
 * Port perilaku pencarian lokal APK (`library_service.dart`):
 * - Kata kunci dipecah menjadi token (huruf kecil, tanpa tanda baca).
 * - Semua token wajib cocok (AND); bila AND kosong, dicoba OR.
 * - Ketikan sebagian cocok lewat awalan token (`kata*` di FTS5,
 *   di sini lewat rentang kunci `token` di IndexedDB).
 *
 * Perbedaan dari APK: APK memakai skor bm25 FTS5. Web memakai
 * skor deterministik sederhana (cocok persis di judul lebih
 * berat dari cocok awalan di nama artis), supaya urutan hasil
 * bisa diuji tanpa mesin FTS.
 */

/** Pecah teks menjadi token: huruf kecil, tanpa tanda baca. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
}

/** Token unik (urutan kemunculan pertama dipertahankan). */
export function uniqueTokens(text: string): string[] {
  return [...new Set(tokenize(text))];
}

/**
 * Id semu artis dari nama, port `localArtistIdForName` APK.
 *
 * FNV-1a 64 bit atas nama huruf kecil (unit UTF-16, sama seperti
 * `codeUnits` Dart), diformat heksadesimal 16 digit. Nama yang
 * sama selalu memetakan ke artis yang sama; P4 menggabungkan id
 * semu ke channelId asli saat data YTM tersedia.
 */
export function localArtistIdForName(name: string): string {
  const normalized = name.trim().toLowerCase();
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= BigInt(normalized.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return `local-${hash.toString(16).padStart(16, '0')}`;
}

/** Batas atas rentang awalan untuk satu token kueri. */
export function prefixUpperBound(prefix: string): string {
  return `${prefix}\uffff`;
}

/**
 * Skor satu kandidat terhadap token kueri (0 bila tidak cocok).
 * Bobot: cocok persis di judul 3, cocok awalan di judul 2,
 * cocok persis di nama 1,5, cocok awalan di nama 1.
 * Mode "and": semua token kueri harus cocok di judul atau nama;
 * satu token yang tidak cocok membuat skor 0. Mode "or": token
 * yang tidak cocok diabaikan, skor adalah jumlah kecocokan
 * (dipakai jalur cadangan pencarian lokal).
 */
export function scoreCandidate(
  queryTokens: string[],
  titleTokens: string[],
  nameTokens: string[],
  mode: 'and' | 'or' = 'and',
): number {
  if (queryTokens.length === 0) return 0;
  let score = 0;
  for (const query of queryTokens) {
    if (titleTokens.includes(query)) {
      score += 3;
      continue;
    }
    if (titleTokens.some((t) => t.startsWith(query))) {
      score += 2;
      continue;
    }
    if (nameTokens.includes(query)) {
      score += 1.5;
      continue;
    }
    if (nameTokens.some((t) => t.startsWith(query))) {
      score += 1;
      continue;
    }
    if (mode === 'and') return 0;
  }
  return score;
}

/** Urutkan kandidat hasil cari: skor turun, lalu judul, lalu id. */
export function compareSearchCandidates(
  a: { score: number; titleKey: string; id: string },
  b: { score: number; titleKey: string; id: string },
): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.titleKey !== b.titleKey) {
    return a.titleKey < b.titleKey ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
