/**
 * Parser lirik tersinkron format LRC (P7).
 *
 * Format: `[mm:ss.xx] teks`, satu atau beberapa penanda waktu per
 * baris. Tag metadata (`[ti:]`, `[ar:]`, `[al:]`, `[by:]`,
 * `[length:]`, dan sejenisnya) diabaikan. Tag `[offset:+/-ms]`
 * menggeser semua waktu. Tag kata gaya lirik yang diperkaya
 * (`<mm:ss.xx>` di dalam teks) dibuang, teksnya dipertahankan.
 *
 * Fungsi murni: tanpa jaringan, tanpa IndexedDB, mudah dites.
 */

export interface LrcLine {
  /** Waktu mulai baris, detik (boleh pecahan). */
  timeSeconds: number;
  /** Teks baris (bisa kosong untuk jeda instrumental). */
  text: string;
}

const TIME_TAG_RE = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
const OFFSET_RE = /\[offset:\s*([+-]?\d+)\]/i;
const WORD_TAG_RE = /<\d{1,2}:\d{2}(?:[.:]\d{1,3})?>/g;
/** Tag metadata: huruf di dalam kurung siku, bukan angka waktu. */
const META_TAG_RE = /^\[[a-zA-Z#][^\]]*\]\s*/;

/** Ubah satu penanda `[mm:ss.xx]` menjadi detik. */
function tagToSeconds(
  minutes: string,
  seconds: string,
  fraction: string | undefined,
): number {
  const base = Number(minutes) * 60 + Number(seconds);
  if (!fraction) return base;
  // Pecahan 1-3 digit: persepuluh, perseratus, atau perseribu detik.
  return base + Number(fraction) / 10 ** fraction.length;
}

/**
 * Urai teks LRC menjadi baris-baris terurut waktu. Baris tanpa
 * penanda waktu dibuang (metadata dan baris sampah). Baris
 * duplikat waktu dipertahankan apa adanya.
 */
export function parseLrc(lrcText: string): LrcLine[] {
  const offsetMatch = OFFSET_RE.exec(lrcText);
  const offsetSeconds = offsetMatch
    ? Number(offsetMatch[1]) / 1000
    : 0;

  const lines: LrcLine[] = [];
  for (const rawLine of lrcText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    // Baris yang hanya berisi tag metadata dilewati.
    if (META_TAG_RE.test(line) && !TIME_TAG_RE.test(line)) continue;
    TIME_TAG_RE.lastIndex = 0;
    const times: number[] = [];
    let match: RegExpExecArray | null;
    let lastIndex = 0;
    while ((match = TIME_TAG_RE.exec(line)) !== null) {
      times.push(
        tagToSeconds(match[1], match[2], match[3]) + offsetSeconds,
      );
      lastIndex = match.index + match[0].length;
    }
    if (times.length === 0) continue;
    const text = line
      .slice(lastIndex)
      .replace(WORD_TAG_RE, '')
      .trim();
    for (const timeSeconds of times) {
      if (timeSeconds < 0) continue;
      lines.push({ timeSeconds, text });
    }
  }
  // Urut stabil berdasarkan waktu (baris dengan beberapa penanda
  // bisa keluar tidak urut bila penulis LRC-nya tidak urut).
  lines.sort((a, b) => a.timeSeconds - b.timeSeconds);
  return lines;
}

/**
 * Indeks baris aktif pada posisi putar tertentu: baris dengan
 * waktu terakhir yang sama dengan atau lebih kecil dari posisi
 * (PRD B5.1). Mengembalikan -1 bila belum ada baris yang mulai.
 */
export function activeLineIndex(
  lines: LrcLine[],
  positionSeconds: number,
): number {
  let active = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].timeSeconds <= positionSeconds) {
      active = i;
    } else {
      break;
    }
  }
  return active;
}
