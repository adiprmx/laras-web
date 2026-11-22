/**
 * Klien HTTP untuk Worker sinkronisasi (P7).
 *
 * Semua request memakai `credentials: 'include'` (cookie sesi
 * HttpOnly dikirim lintas origin) + timeout eksplisit.
 * Galat dibungkus `SyncApiError` dengan `status` supaya UI bisa
 * membedakan "belum masuk" (401) dari "server sibuk" (429/5xx)
 * dan "tidak ada koneksi" (status 0).
 */
import { SYNC_API_BASE_URL, SYNC_API_TIMEOUT_MS } from './config';

export class SyncApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'SyncApiError';
    this.status = status;
    this.code = code;
  }
}

// Tipe wire (P-Types): SATU sumber kebenaran di
// workers/sync/src/contract.js + contract.d.ts — tipe di sini
// diimpor, bukan didefinisikan ulang. Re-export supaya impor
// yang sudah ada (syncService, syncStore, tes) tidak berubah.
import {
  validatePullResponse,
  validatePushBody,
  validatePushData,
} from '../../../workers/sync/src/contract';
import type {
  ApiEnvelope,
  AuthMeData,
  PullData,
  PushBody,
  PushData,
} from '../../../workers/sync/src/contract';
export type {
  ApiEnvelope,
  AuthMeData,
  PullData,
  PushBody,
  PushData,
  RemoteHistoryEvent,
  RemoteLike,
  RemotePlaylist,
  RemotePlaylistItem,
} from '../../../workers/sync/src/contract';

async function request<T>(
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_API_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${SYNC_API_BASE_URL}${path}`, {
      ...init,
      credentials: 'include',
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => null)) as ApiEnvelope<T> | null;
    if (!res.ok) {
      throw new SyncApiError(
        res.status,
        body?.error?.code ?? 'HTTP_ERROR',
        body?.error?.message ?? `Request gagal (${res.status})`,
      );
    }
    if (!body || !body.success || body.data === undefined) {
      throw new SyncApiError(res.status, 'BAD_RESPONSE', 'Respons server tidak valid');
    }
    return body.data;
  } catch (e) {
    if (e instanceof SyncApiError) throw e;
    // I11: timeout fetch asli adalah DOMException (bukan Error).
    if ((e as { name?: unknown } | null)?.name === 'AbortError') {
      throw new SyncApiError(0, 'TIMEOUT', 'Sinkronisasi terlalu lama');
    }
    throw new SyncApiError(
      0,
      'NETWORK',
      'Tidak bisa terhubung ke server sinkronisasi',
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchAuthMe(
  fetchImpl: typeof fetch = fetch,
): Promise<AuthMeData> {
  return request<AuthMeData>('/api/auth/me', { method: 'GET' }, fetchImpl);
}

export async function fetchLogout(
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await request('/api/auth/logout', { method: 'POST' }, fetchImpl);
}

/** Keluar dari SEMUA perangkat (P-Auth): cabut semua sesi pengguna. */
export async function fetchLogoutAll(
  fetchImpl: typeof fetch = fetch,
): Promise<{ loggedOutEverywhere: boolean; revoked: number }> {
  return request<{ loggedOutEverywhere: boolean; revoked: number }>(
    '/api/auth/logout-all',
    { method: 'POST' },
    fetchImpl,
  );
}

export async function fetchDeleteAccount(
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await request('/api/auth/delete', { method: 'POST' }, fetchImpl);
}

export async function fetchPull(
  since: number,
  fetchImpl: typeof fetch = fetch,
): Promise<PullData> {
  const data = await request<PullData>(
    `/api/sync/pull?since=${since}`,
    { method: 'GET' },
    fetchImpl,
  );
  // P-Types: validasi bentuk respons (menangkap drift server).
  const invalid = validatePullResponse(data);
  if (invalid) {
    throw new SyncApiError(200, 'BAD_RESPONSE', `Respons pull tidak valid: ${invalid}`);
  }
  return data;
}

export async function fetchPush(
  body: PushBody,
  fetchImpl: typeof fetch = fetch,
): Promise<PushData> {
  // P-Types: validasi SEBELUM kirim dengan validator yang SAMA
  // dengan server — body yang cacat gagal lokal dengan pesan jelas,
  // bukan sesudah round-trip (dan bukan diam-diam ditolak server).
  const invalidBody = validatePushBody(body);
  if (invalidBody) {
    throw new SyncApiError(400, 'INVALID_PUSH_BODY', `Body push tidak valid: ${invalidBody}`);
  }
  const data = await request<PushData>(
    '/api/sync/push',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    fetchImpl,
  );
  const invalidData = validatePushData(data);
  if (invalidData) {
    throw new SyncApiError(200, 'BAD_RESPONSE', `Respons push tidak valid: ${invalidData}`);
  }
  return data;
}
