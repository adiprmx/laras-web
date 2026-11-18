import { describe, expect, it } from 'vitest';
import {
  formatDurationMs,
  formatReport,
  formatSeconds,
  statusLabel,
  summarize,
  type ReportMeta,
  type SongResult,
} from './report';

function makeResult(patch: Partial<SongResult> = {}): SongResult {
  return {
    videoId: 'hhn-nGSuenM',
    title: 'Semua Tentang Kita',
    lengthSeconds: 268,
    status: 'menunggu',
    client: null,
    itag: null,
    usedSolver: false,
    resolveMs: null,
    heardSeconds: 0,
    audioDuration: null,
    retries: 0,
    failCause: null,
    failDetail: null,
    ...patch,
  };
}

const meta: ReportMeta = {
  mode: 'cepat',
  startedAt: '2026-11-18T00:00:00.000Z',
  finishedAt: '2026-11-18T00:03:30.000Z',
  totalMs: 210000,
  proxyUrl: 'https://laras-proxy-spike.hiroohengkerr.workers.dev',
  playerHash: 'b559f50c',
  usedRemoteConfig: true,
  userAgent: 'TestBrowser/1.0',
};

describe('formatSeconds', () => {
  it('memformat detik menjadi menit:detik', () => {
    expect(formatSeconds(0)).toBe('0:00');
    expect(formatSeconds(30)).toBe('0:30');
    expect(formatSeconds(268)).toBe('4:28');
    expect(formatSeconds(1359)).toBe('22:39');
  });

  it('membulatkan ke bawah dan menangani nilai tidak valid', () => {
    expect(formatSeconds(30.9)).toBe('0:30');
    expect(formatSeconds(-5)).toBe('0:00');
    expect(formatSeconds(NaN)).toBe('0:00');
    expect(formatSeconds(Infinity)).toBe('0:00');
  });
});

describe('formatDurationMs', () => {
  it('memformat milidetik menjadi menit dan detik', () => {
    expect(formatDurationMs(45000)).toBe('45 detik');
    expect(formatDurationMs(192000)).toBe('3 menit 12 detik');
    expect(formatDurationMs(1359000)).toBe('22 menit 39 detik');
  });
});

describe('statusLabel', () => {
  it('melabeli semua status', () => {
    expect(statusLabel('menunggu')).toBe('Menunggu');
    expect(statusLabel('mencari')).toBe('Mencari lagu');
    expect(statusLabel('memutar')).toBe('Memutar');
    expect(statusLabel('selesai')).toBe('Selesai');
    expect(statusLabel('gagal')).toBe('Gagal');
  });
});

describe('summarize', () => {
  it('menghitung selesai, gagal, dan belum diuji', () => {
    const results = [
      makeResult({ status: 'selesai' }),
      makeResult({ status: 'selesai' }),
      makeResult({ status: 'gagal' }),
      makeResult({ status: 'memutar' }),
      makeResult({ status: 'menunggu' }),
    ];
    expect(summarize(results)).toEqual({
      done: 2,
      total: 5,
      failed: 1,
      untested: 2,
    });
  });
});

describe('formatReport', () => {
  it('memuat ringkasan, meta, dan tiap lagu', () => {
    const results = [
      makeResult({
        status: 'selesai',
        client: 'WEB_REMIX',
        itag: 251,
        usedSolver: true,
        resolveMs: 3200,
        heardSeconds: 30,
      }),
      makeResult({
        videoId: 'qkC4waEZVt4',
        title: 'Rahasia Hati',
        lengthSeconds: 251,
        status: 'gagal',
        failCause: 'Jaringan terputus saat memutar.',
        heardSeconds: 12,
        retries: 1,
      }),
    ];
    const report = formatReport(results, meta);
    expect(report).toContain('Hasil: 1/2 lagu selesai');
    expect(report).toContain('Mode: Periksa cepat (30 detik per lagu)');
    expect(report).toContain('Hash pemutar: b559f50c');
    expect(report).toContain('Config: remote (config-v1)');
    expect(report).toContain('1. Semua Tentang Kita (hhn-nGSuenM): SELESAI');
    expect(report).toContain('Jalur: WEB_REMIX, itag 251, lewat solver');
    expect(report).toContain('Waktu cari lagu: 3.2 detik');
    expect(report).toContain('Terdengar: 0:30 dari 4:28');
    expect(report).toContain('2. Rahasia Hati (qkC4waEZVt4): GAGAL');
    expect(report).toContain('Coba ulang di tengah lagu: 1x');
    expect(report).toContain('Penyebab: Jaringan terputus saat memutar.');
  });

  it('menampilkan Detail teknis bila ada, menyembunyikannya bila null', () => {
    const withDetail = [
      makeResult({
        status: 'gagal',
        failCause: 'Lagu tidak bisa ditemukan di semua jalur. Coba lagi nanti.',
        failDetail:
          'resolve gagal untuk hhn-nGSuenM: WEB_REMIX=LOGIN_REQUIRED, MWEB=LOGIN_REQUIRED, ANDROID_VR=LOGIN_REQUIRED',
      }),
    ];
    const report = formatReport(withDetail, meta);
    expect(report).toContain(
      'Penyebab: Lagu tidak bisa ditemukan di semua jalur. Coba lagi nanti.',
    );
    expect(report).toContain(
      'Detail: resolve gagal untuk hhn-nGSuenM: WEB_REMIX=LOGIN_REQUIRED, MWEB=LOGIN_REQUIRED, ANDROID_VR=LOGIN_REQUIRED',
    );
    const withoutDetail = [makeResult({ status: 'gagal', failCause: 'x' })];
    expect(formatReport(withoutDetail, meta)).not.toContain('Detail:');
  });

  it('tidak pernah memuat URL stream', () => {
    const results = [makeResult({ status: 'selesai' })];
    const report = formatReport(results, meta);
    expect(report).not.toContain('googlevideo.com');
    expect(report).not.toContain('videoplayback');
  });

  it('melabeli mode penuh dan config bawaan', () => {
    const report = formatReport([makeResult()], {
      ...meta,
      mode: 'penuh',
      usedRemoteConfig: false,
      playerHash: null,
    });
    expect(report).toContain('Mode: Putar penuh (5 lagu sampai habis)');
    expect(report).toContain('Config: bawaan (remote tidak bisa diambil)');
    expect(report).toContain('Hash pemutar: tidak diketahui');
  });
});
