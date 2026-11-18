/**
 * Baca body respons teks dengan cap ukuran (Red 1 S4/R5).
 *
 * Pola `await res.text()` dulu lalu cek panjang sesudahnya sudah
 * terlambat: seluruh body sudah dimuat ke memori. Helper ini membaca
 * stream per chunk dan membatalkan stream begitu total byte melewati
 * cap, jadi respons raksasa tidak pernah memenuhi memori tab.
 * Port pola `readCapped` di worker proxy ke sisi client.
 */

/** Dilempar `readCappedText` bila body melewati cap. */
export class ResponseTooBigError extends Error {
  readonly capBytes: number;

  constructor(capBytes: number) {
    super(`respons melewati cap ${capBytes} byte`);
    this.name = 'ResponseTooBigError';
    this.capBytes = capBytes;
  }
}

/**
 * Baca seluruh body respons sebagai teks, menolak bila total byte
 * melewati `capBytes`. Mengembalikan teks yang sudah di-decode.
 * Bila header Content-Length sudah di atas cap, ditolak tanpa
 * membaca body sama sekali (penolakan cepat).
 */
export async function readCappedText(
  res: Response,
  capBytes: number,
): Promise<string> {
  const declared = Number(res.headers.get('Content-Length') || 0);
  if (declared > capBytes) throw new ResponseTooBigError(capBytes);
  const body = res.body;
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > capBytes) {
      try {
        await reader.cancel();
      } catch {
        // Pembatalan gagal tidak mengubah vonis: tetap terlalu besar.
      }
      throw new ResponseTooBigError(capBytes);
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return chunks.join('');
}
