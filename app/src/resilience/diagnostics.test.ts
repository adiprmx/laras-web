import { describe, expect, it } from 'vitest';
import {
  buildDiagnosticCode,
  causeFromFailureCause,
  clearMemorySnapshot,
  getMemorySnapshot,
  kindFromFailureCause,
  parseSnapshot,
  recordFailureSnapshot,
  type DiagnosticData,
  type FailureSnapshot,
} from './diagnostics';
import { createMemoryStorage } from './configStore';

// Waktu lokal tetap: 16 Nov 2026 19:05 (zona waktu lokal tes).
const FAILED_AT = new Date(2026, 10, 16, 19, 5).getTime();

const BASE: DiagnosticData = {
  kind: 'unplayable',
  cause: 'login-required',
  failedAt: FAILED_AT,
  clientsTried: ['WEB_REMIX', 'MWEB', 'ANDROID_VR'],
  configVersion: '1.20261110.04.00',
  configIsRemote: true,
  serviceStatus: 'degraded',
};

describe('buildDiagnosticCode', () => {
  it('merakit kode format APK (contoh dokumen)', () => {
    const code = buildDiagnosticCode(BASE);
    expect(code).toBe('LRS1-ULR-16111905-WMV-0900-R20261110-D');
  });

  it('jenis engine (E) menutup celah APK: kegagalan pemutar tertangkap', () => {
    const code = buildDiagnosticCode({
      ...BASE,
      kind: 'engine',
      cause: 'http-forbidden',
    });
    expect(code.startsWith('LRS1-EFH-')).toBe(true);
  });

  it('tanpa kegagalan tercatat: X + XX + X', () => {
    const code = buildDiagnosticCode(
      {
        clientsTried: [],
        configVersion: null,
        configIsRemote: false,
        serviceStatus: null,
      },
      FAILED_AT,
    );
    expect(code).toBe('LRS1-XXX-16111905-X-0900-B-?');
  });

  it('config bawaan: segmen B; remote tanpa tanggal: R', () => {
    expect(
      buildDiagnosticCode({ ...BASE, configIsRemote: false }),
    ).toContain('-B-D');
    expect(
      buildDiagnosticCode({
        ...BASE,
        configVersion: '1.65.10',
      }),
    ).toContain('-R-D');
  });

  it('status layanan: O normal, B bermasalah', () => {
    expect(
      buildDiagnosticCode({ ...BASE, serviceStatus: 'ok' }),
    ).toMatch(/-O$/);
    expect(
      buildDiagnosticCode({ ...BASE, serviceStatus: 'broken' }),
    ).toMatch(/-B$/);
  });

  it('client tak dikenal jadi ?', () => {
    const code = buildDiagnosticCode({
      ...BASE,
      clientsTried: ['WEB_REMIX', 'CLIENT_BARU'],
    });
    expect(code).toContain('-W?-');
  });

  it('kode tidak pernah memuat URL, videoId, atau judul', () => {
    const code = buildDiagnosticCode(BASE);
    expect(code).not.toContain('http');
    expect(code).not.toContain('googlevideo');
    expect(code).not.toContain('hhn-nGSuenM');
    expect(code).toMatch(/^LRS1-[A-Z]{3}-\d{8}-[WMV?X]+-\d+-R?\d*-?[ODB?]$/);
  });
});

describe('causeFromFailureCause / kindFromFailureCause', () => {
  it('memetakan 6 penyebab ke kode', () => {
    expect(causeFromFailureCause('refused')).toBe('login-required');
    expect(causeFromFailureCause('no-format')).toBe('no-format');
    expect(causeFromFailureCause('config-stale')).toBe('unknown-hash');
    expect(causeFromFailureCause('offline')).toBe('unknown');
    expect(kindFromFailureCause('offline', false)).toBe('network');
    expect(kindFromFailureCause('proxy-down', false)).toBe('network');
    expect(kindFromFailureCause('refused', false)).toBe('unplayable');
    expect(kindFromFailureCause('proxy-down', true)).toBe('timeout');
  });
});

describe('snapshot kegagalan', () => {
  it('record + getMemorySnapshot menyimpan snapshot terakhir', () => {
    clearMemorySnapshot();
    const snapshot: FailureSnapshot = {
      layer: 'engine',
      kind: 'engine',
      cause: 'http-forbidden',
      failedAt: FAILED_AT,
      clientsTried: ['WEB_REMIX'],
      lastClient: 'WEB_REMIX',
      lastPlayability: 'OK',
      playerHash: 'b559f50c',
    };
    recordFailureSnapshot(snapshot, createMemoryStorage());
    expect(getMemorySnapshot()).toEqual(snapshot);
    clearMemorySnapshot();
    expect(getMemorySnapshot()).toBeNull();
  });

  it('parseSnapshot menolak JSON rusak dan menerima yang valid', () => {
    expect(parseSnapshot(null)).toBeNull();
    expect(parseSnapshot('bukan-json')).toBeNull();
    expect(parseSnapshot(JSON.stringify({ layer: 'aneh' }))).toBeNull();
    const parsed = parseSnapshot(
      JSON.stringify({
        layer: 'resolve',
        kind: 'unplayable',
        cause: 'login-required',
        failedAt: 123,
        clientsTried: ['WEB_REMIX', 42],
        lastClient: 'WEB_REMIX',
        lastPlayability: 'LOGIN_REQUIRED',
        playerHash: null,
      }),
    );
    expect(parsed?.clientsTried).toEqual(['WEB_REMIX']);
    expect(parsed?.layer).toBe('resolve');
  });
});
