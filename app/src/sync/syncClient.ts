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

export interface AuthMeData {
  displayName: string;
  provider: string;
}

export interface RemotePlaylist {
  clientId: string;
  nama: string;
  deskripsi: string | null;
  updatedAt: number;
  deletedAt: number | null;
}

export interface RemotePlaylistItem {
  playlistClientId: string;
  videoId: string;
  posisi: number;
  title: string | null;
  artist: string | null;
  updatedAt: number;
  deletedAt: number | null;
}

export interface RemoteLike {
  videoId: string;
  likedAt: number;
  title: string | null;
  artist: string | null;
  updatedAt: number;
  deletedAt: number | null;
}

export interface RemoteHistoryEvent {
  videoId: string;
  playedAt: number;
  secondsPlayed: number;
  title: string | null;
  artist: string | null;
  updatedAt: number;
}

export interface PullData {
  serverTime: number;
  playlists: RemotePlaylist[];
  playlistItems: RemotePlaylistItem[];
  likes: RemoteLike[];
  history: RemoteHistoryEvent[];
  settings: { settingsJson: string; updatedAt: number } | null;
}

export interface PushBody {
  deviceId: string;
  playlists?: Array<{
    clientId: string;
    nama: string;
    deskripsi: string | null;
  }>;
  playlistItems?: Array<{
    playlistClientId: string;
    videoId: string;
    posisi: number;
    title: string | null;
    artist: string | null;
  }>;
  likes?: Array<{
    videoId: string;
    likedAt: number;
    title: string | null;
    artist: string | null;
  }>;
  history?: Array<{
    videoId: string;
    playedAt: number;
    secondsPlayed: number;
    title: string | null;
    artist: string | null;
  }>;
  deletedPlaylists?: Array<{ clientId: string }>;
  deletedPlaylistItems?: Array<{
    playlistClientId: string;
    videoId: string;
  }>;
  deletedLikes?: Array<{ videoId: string }>;
  settings?: { settingsJson: string };
  historyClearedBefore?: number;
}

export interface PushData {
  serverTime: number;
  applied: number;
  /** Entri yang ditolak karena bukan milik pendorong (R11). */
  skippedNotOwned?: number;
  /** Entri yang dilewati karena melewati batas total per pengguna (S7). */
  skippedOverLimit?: {
    playlists: number;
    playlistItems: number;
    likes: number;
    history: number;
  };
  /** Batas total server (arsitektur §4.3). */
  limits?: {
    playlists: number;
    itemsPerPlaylist: number;
    likes: number;
    history: number;
  };
  /** Hapus riwayat diabaikan server (S8a: maks sekali per 24 jam). */
  historyClearIgnored?: boolean;
  /** Detik sampai hapus riwayat boleh dicoba lagi (S8a). */
  historyClearRetryAfterSeconds?: number;
}

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

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
    const body = (await res.json().catch(() => null)) as Envelope<T> | null;
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

export async function fetchDeleteAccount(
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await request('/api/auth/delete', { method: 'POST' }, fetchImpl);
}

export async function fetchPull(
  since: number,
  fetchImpl: typeof fetch = fetch,
): Promise<PullData> {
  return request<PullData>(`/api/sync/pull?since=${since}`, { method: 'GET' }, fetchImpl);
}

export async function fetchPush(
  body: PushBody,
  fetchImpl: typeof fetch = fetch,
): Promise<PushData> {
  return request<PushData>(
    '/api/sync/push',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    fetchImpl,
  );
}
