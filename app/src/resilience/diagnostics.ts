/**
 * Kode diagnostik LRS1 + snapshot pemutar (P6, PRD B9.9).
 *
 * Port format APK (lib/resilience/diagnostic_code.dart):
 * `LRS1-JK-DDMMHHMM-KLIEN-APP-CFG-LAYANAN`.
 *
 * Legenda (APK + perluasan web):
 * - J jenis gagal: N jaringan, T timeout (lambat), U tidak bisa
 *   diputar, E kegagalan pemutar/engine (BARU web: menutup celah
 *   APK, snapshot hanya resolve), X tidak ada kegagalan tercatat.
 * - K penyebab (2 huruf): FH ditolak (403), ER jawaban kosong,
 *   PF bentuk respons berubah, SB format baru (SABR), ST lama
 *   disiapkan (solver timeout), UH pemutar berubah (hash tak
 *   dikenal), LR YouTube menolak (LOGIN_REQUIRED, BARU web),
 *   NF tidak ada format (BARU web), XX tidak diketahui.
 * - DDMMHHMM waktu kegagalan terakhir, waktu lokal.
 * - KLIEN inisial client yang dicoba: W WEB_REMIX, M MWEB,
 *   V ANDROID_VR, ? tidak dikenal, X tidak ada data.
 * - APP versi app tanpa titik + build (0.9.0 -> 0900).
 * - CFG config: R + tanggal versi client utama bila remote,
 *   R bila remote tanpa tanggal, B bila bawaan.
 * - LAYANAN status kanari: O normal, D terganggu, B bermasalah,
 *   ? belum pernah diperiksa.
 *
 * PRIVASI: kode TIDAK berisi judul lagu, videoId, URL, IP, email,
 * cookie, token, atau isi database. Snapshot juga tidak: log
 * pemutar disanitasi di playerLog.ts (URL disamarkan).
 */
import { APP_BUILD, APP_VERSION } from '../core/version';
import { createAppMetaStorage, type KeyValueStorage } from './configStore';
import type { CanaryStatus } from './canary';
import type { FailureCause } from './errors';

/** Kunci snapshot kegagalan terakhir di app_meta. */
export const DIAGNOSTIC_SNAPSHOT_KEY = 'p6.diagnostics.last';

export type DiagnosticKind =
  | 'network'
  | 'timeout'
  | 'unplayable'
  | 'engine';

export type DiagnosticCause =
  | 'http-forbidden'
  | 'empty-response'
  | 'parse-failed'
  | 'sabr-only'
  | 'solver-timeout'
  | 'unknown-hash'
  | 'login-required'
  | 'no-format'
  | 'unknown';

/** Snapshot satu kegagalan (resolve ATAU engine). */
export interface FailureSnapshot {
  /** Lapisan tempat gagal: 'resolve' atau 'engine' (pemutar). */
  layer: 'resolve' | 'engine';
  kind: DiagnosticKind;
  cause: DiagnosticCause;
  failedAt: number;
  clientsTried: string[];
  lastClient: string | null;
  lastPlayability: string | null;
  playerHash: string | null;
}

export interface DiagnosticData {
  kind?: DiagnosticKind;
  cause?: DiagnosticCause;
  failedAt?: number;
  clientsTried: string[];
  configVersion: string | null;
  configIsRemote: boolean;
  serviceStatus: CanaryStatus | null;
}

const KIND_LETTER: Record<DiagnosticKind, string> = {
  network: 'N',
  timeout: 'T',
  unplayable: 'U',
  engine: 'E',
};

const CAUSE_LETTER: Record<DiagnosticCause, string> = {
  'http-forbidden': 'FH',
  'empty-response': 'ER',
  'parse-failed': 'PF',
  'sabr-only': 'SB',
  'solver-timeout': 'ST',
  'unknown-hash': 'UH',
  'login-required': 'LR',
  'no-format': 'NF',
  unknown: 'XX',
};

function two(value: number): string {
  return String(value).padStart(2, '0');
}

function clientInitial(name: string): string {
  switch (name) {
    case 'WEB_REMIX':
      return 'W';
    case 'MWEB':
      return 'M';
    case 'ANDROID_VR':
      return 'V';
    default:
      return '?';
  }
}

function configSegment(
  version: string | null,
  isRemote: boolean,
): string {
  if (!isRemote) return 'B';
  if (!version) return 'R';
  for (const part of version.split('.')) {
    if (
      part.length === 8 &&
      part.startsWith('20') &&
      /^\d+$/.test(part)
    ) {
      return `R${part}`;
    }
  }
  return 'R';
}

/**
 * Rakit kode diagnostik. Murni dan tidak pernah melempar: field
 * yang hilang diganti huruf "tidak diketahui".
 */
export function buildDiagnosticCode(
  data: DiagnosticData,
  nowMs: number = Date.now(),
): string {
  const kind = data.kind ? KIND_LETTER[data.kind] : 'X';
  const cause = data.cause ? CAUSE_LETTER[data.cause] : 'XX';
  const at = new Date(data.failedAt ?? nowMs);
  const time =
    `${two(at.getDate())}${two(at.getMonth() + 1)}` +
    `${two(at.getHours())}${two(at.getMinutes())}`;
  const clients =
    data.clientsTried.length === 0
      ? 'X'
      : data.clientsTried.map(clientInitial).join('');
  const app = `${APP_VERSION.replace(/[^0-9]/g, '')}${APP_BUILD}`;
  const config = configSegment(data.configVersion, data.configIsRemote);
  const service =
    data.serviceStatus === 'ok'
      ? 'O'
      : data.serviceStatus === 'degraded'
        ? 'D'
        : data.serviceStatus === 'broken'
          ? 'B'
          : '?';
  return `LRS1-${kind}${cause}-${time}-${clients}-${app}-${config}-${service}`;
}

/** Petakan penyebab klasifikasi 6 ke penyebab kode diagnostik. */
export function causeFromFailureCause(
  cause: FailureCause,
): DiagnosticCause {
  switch (cause) {
    case 'refused':
      return 'login-required';
    case 'no-format':
      return 'no-format';
    case 'config-stale':
      return 'unknown-hash';
    default:
      return 'unknown';
  }
}

/** Petakan penyebab klasifikasi 6 ke jenis kode diagnostik. */
export function kindFromFailureCause(
  cause: FailureCause,
  isTimeout: boolean,
): DiagnosticKind {
  if (isTimeout) return 'timeout';
  switch (cause) {
    case 'offline':
    case 'proxy-down':
      return 'network';
    default:
      return 'unplayable';
  }
}

// ---------- Penyimpanan snapshot terakhir ----------

let memorySnapshot: FailureSnapshot | null = null;

export function recordFailureSnapshot(
  snapshot: FailureSnapshot,
  storage: KeyValueStorage = createAppMetaStorage(),
): void {
  memorySnapshot = snapshot;
  // Simpan best-effort (async, tidak ditunggu): snapshot tetap
  // tersedia sesudah muat ulang halaman.
  void storage
    .set(DIAGNOSTIC_SNAPSHOT_KEY, JSON.stringify(snapshot))
    .catch(() => undefined);
}

export function getMemorySnapshot(): FailureSnapshot | null {
  return memorySnapshot;
}

export function parseSnapshot(raw: string | null): FailureSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<FailureSnapshot>;
    if (
      (parsed.layer !== 'resolve' && parsed.layer !== 'engine') ||
      typeof parsed.failedAt !== 'number' ||
      !Array.isArray(parsed.clientsTried)
    ) {
      return null;
    }
    return {
      layer: parsed.layer,
      kind: parsed.kind ?? 'unplayable',
      cause: parsed.cause ?? 'unknown',
      failedAt: parsed.failedAt,
      clientsTried: parsed.clientsTried.filter(
        (c): c is string => typeof c === 'string',
      ),
      lastClient: parsed.lastClient ?? null,
      lastPlayability: parsed.lastPlayability ?? null,
      playerHash: parsed.playerHash ?? null,
    };
  } catch {
    return null;
  }
}

export async function loadPersistedSnapshot(
  storage: KeyValueStorage = createAppMetaStorage(),
): Promise<FailureSnapshot | null> {
  try {
    return parseSnapshot(await storage.get(DIAGNOSTIC_SNAPSHOT_KEY));
  } catch {
    return null;
  }
}

/** Reset snapshot memori (tes). */
export function clearMemorySnapshot(): void {
  memorySnapshot = null;
}
