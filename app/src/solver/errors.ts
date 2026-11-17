/**
 * Galat lapisan ekstraksi (port minimal `errors.dart` APK).
 *
 * Hanya penyebab yang dipakai solver yang dibawa ke sini; tim ekstraktor
 * P1 memegang definisi lengkapnya. `cause` dipakai orkestrator untuk
 * memilih jalur terdegradasi, jadi nilainya harus stabil dan tidak boleh
 * diganti teks bebas.
 */
export type ResolveFailureCause =
  | 'unknownPlayerHash'
  | 'solverTimeout'
  | 'parseFailed';

export class ExtractorException extends Error {
  readonly cause: ResolveFailureCause;
  readonly detail: string;

  constructor(cause: ResolveFailureCause, detail = '') {
    super(`ExtractorException(${cause}${detail ? `: ${detail}` : ''})`);
    this.name = 'ExtractorException';
    this.cause = cause;
    this.detail = detail;
  }
}
