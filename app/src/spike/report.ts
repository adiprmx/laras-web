/**
 * Logika murni laporan halaman spike P1 (tanpa DOM, tanpa fetch).
 * Diuji Vitest di report.test.ts.
 */

export type SongStatus =
  | 'menunggu'
  | 'mencari'
  | 'memutar'
  | 'selesai'
  | 'gagal';

export interface SongResult {
  videoId: string;
  title: string;
  lengthSeconds: number;
  status: SongStatus;
  /** Client InnerTube yang berhasil resolve, bila ada. */
  client: string | null;
  itag: number | null;
  /** True bila URL didapat lewat solver (format cipher). */
  usedSolver: boolean;
  resolveMs: number | null;
  /** Posisi putar terakhir yang tercatat, dalam detik. */
  heardSeconds: number;
  /** Durasi yang dilaporkan elemen audio, bila ada. */
  audioDuration: number | null;
  /** Berapa kali resolve ulang di tengah lagu dilakukan. */
  retries: number;
  /** Penyebab gagal (bahasa sehari-hari), bila gagal. */
  failCause: string | null;
  /**
   * Detail teknis untuk laporan (mis. attempts resolve per client),
   * bila ada. TIDAK tampil di layar (tanpa jargon di UI) — hanya di
   * teks laporan yang disalin, supaya §5 berikut bisa didiagnosis
   * tanpa probe tambahan.
   */
  failDetail: string | null;
}

export type SpikeMode = 'cepat' | 'penuh';

export interface ReportMeta {
  mode: SpikeMode;
  startedAt: string;
  finishedAt: string;
  /** Total waktu jalan uji, dalam milidetik. */
  totalMs: number;
  proxyUrl: string;
  playerHash: string | null;
  usedRemoteConfig: boolean;
  userAgent: string;
}

/** Format detik menjadi "4:28". Nilai tidak valid menjadi "0:00". */
export function formatSeconds(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0:00';
  const total = Math.floor(value);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Format milidetik menjadi "3 menit 12 detik" atau "45 detik". */
export function formatDurationMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds} detik`;
  return `${minutes} menit ${seconds} detik`;
}

/** Hitung ringkasan: berapa lagu selesai dari total. */
export function summarize(results: SongResult[]): {
  done: number;
  total: number;
  failed: number;
  untested: number;
} {
  let done = 0;
  let failed = 0;
  let untested = 0;
  for (const result of results) {
    if (result.status === 'selesai') done += 1;
    else if (result.status === 'gagal') failed += 1;
    else untested += 1;
  }
  return { done, total: results.length, failed, untested };
}

/**
 * Laporan teks polos untuk ditempel balik ke koordinator.
 * TIDAK memuat URL stream (aturan PRD B2.1).
 */
export function formatReport(
  results: SongResult[],
  meta: ReportMeta,
): string {
  const summary = summarize(results);
  const lines: string[] = [];
  lines.push('Laporan uji putar lagu Laras Web (spike P1)');
  lines.push(
    `Mode: ${meta.mode === 'cepat' ? 'Periksa cepat (30 detik per lagu)' : 'Putar penuh (5 lagu sampai habis)'}`,
  );
  lines.push(`Mulai: ${meta.startedAt}`);
  lines.push(`Selesai: ${meta.finishedAt}`);
  lines.push(`Total waktu: ${formatDurationMs(meta.totalMs)}`);
  lines.push(`Hasil: ${summary.done}/${summary.total} lagu selesai`);
  lines.push(`Proxy: ${meta.proxyUrl}`);
  lines.push(`Hash pemutar: ${meta.playerHash ?? 'tidak diketahui'}`);
  lines.push(
    `Config: ${meta.usedRemoteConfig ? 'remote (config-v1)' : 'bawaan (remote tidak bisa diambil)'}`,
  );
  lines.push(`Browser: ${meta.userAgent}`);
  lines.push('');
  results.forEach((result, index) => {
    const statusText =
      result.status === 'selesai'
        ? 'SELESAI'
        : result.status === 'gagal'
          ? 'GAGAL'
          : 'TIDAK DIUJI';
    lines.push(`${index + 1}. ${result.title} (${result.videoId}): ${statusText}`);
    if (result.client) {
      const via = result.usedSolver ? 'lewat solver' : 'URL langsung';
      lines.push(`   Jalur: ${result.client}, itag ${result.itag ?? '?'}, ${via}`);
    }
    if (result.resolveMs !== null) {
      lines.push(`   Waktu cari lagu: ${(result.resolveMs / 1000).toFixed(1)} detik`);
    }
    lines.push(
      `   Terdengar: ${formatSeconds(result.heardSeconds)} dari ${formatSeconds(result.lengthSeconds)}`,
    );
    if (result.retries > 0) {
      lines.push(`   Coba ulang di tengah lagu: ${result.retries}x`);
    }
    if (result.failCause) {
      lines.push(`   Penyebab: ${result.failCause}`);
    }
    if (result.failDetail) {
      lines.push(`   Detail: ${result.failDetail}`);
    }
  });
  return lines.join('\n');
}

/** Label status singkat untuk layar. */
export function statusLabel(status: SongStatus): string {
  switch (status) {
    case 'menunggu':
      return 'Menunggu';
    case 'mencari':
      return 'Mencari lagu';
    case 'memutar':
      return 'Memutar';
    case 'selesai':
      return 'Selesai';
    case 'gagal':
      return 'Gagal';
  }
}
