/**
 * Laporan hasil impor (P8, PRD B10.4): pola bersama impor backup
 * dan impor Spotify. Port `import_report.dart` APK.
 *
 * Laporan menampilkan tiga angka (berhasil / sudah ada / gagal)
 * plus alasan per lagu yang gagal, dalam bahasa sehari-hari
 * (pemetaan alasan ke string tinggal di UI, `strings/id.ts`).
 * Laporan TIDAK disimpan permanen: sesudah ditutup, laporan
 * hilang; datanya tetap tersimpan.
 */

/** Alasan satu lagu gagal masuk saat impor. */
export type ImportFailureReason =
  /** Tidak ada padanan di YouTube Music (impor Spotify). */
  | 'notFound'
  /** Pengguna melewati lagu ini di layar kandidat (cadangan untuk pemilih kandidat pasca-P8; P8 tidak menghasilkannya). */
  | 'skipped'
  /** Pengguna membatalkan di tengah jalan. */
  | 'cancelled'
  /** Antrean sudah penuh (200 item) sehingga sisanya tidak masuk. */
  | 'queueFull'
  /** Pencarian lagu ini gagal (bukan karena jaringan). */
  | 'searchFailed'
  /** Jaringan putus di tengah pencocokan. */
  | 'network';

/** Satu lagu yang gagal masuk, beserta alasannya. */
export interface ImportFailure {
  /** Label tampil: "Artis - Judul" atau judul saja. */
  label: string;
  reason: ImportFailureReason;
}

/** Ringkasan hasil satu impor. */
export interface ImportReport {
  /** Jumlah item baru yang masuk (lagu, entri playlist, riwayat, antrean — tergantung jalur impor). */
  succeeded: number;
  /** Jumlah item yang dilewati karena sudah ada. */
  alreadyExisted: number;
  /** Lagu yang gagal, masing-masing dengan alasannya. */
  failures: ImportFailure[];
  /** Playlist hasil impor Spotify (null untuk impor backup, dan null bila tidak ada satu pun lagu yang cocok — playlist kosong tidak dibuat, PRD B10.4). */
  playlistId: number | null;
  /** Nama playlist hasil impor Spotify. */
  playlistName: string | null;
  /** Id lagu yang dulu terunduh (menurut file salinan) tapi belum terunduh di perangkat ini — penggerak tombol "Unduh ulang" (PRD B7.5). */
  downloadedSongIds: string[];
  /** Tanggal file salinan dibuat (hanya impor backup). */
  exportedAt: Date | null;
  /** Versi app yang membuat file salinan (hanya impor backup). */
  appVersion: string | null;
}

/** Jumlah lagu yang gagal. */
export function failedCount(report: ImportReport): number {
  return report.failures.length;
}

/** Total item yang diproses. */
export function totalCount(report: ImportReport): number {
  return report.succeeded + report.alreadyExisted + report.failures.length;
}
