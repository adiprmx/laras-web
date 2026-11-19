/**
 * Store status akun + sinkronisasi (Zustand, P7).
 *
 * Status awal `unknown` sampai `refreshAuth` dipanggil (App
 * memanggilnya sekali, tertunda, sesudah pemutar siap — login
 * tidak pernah memblokir pemutaran). `syncNow` manual hanya
 * dari tombol di Pengaturan; tidak ada sinkronisasi otomatis
 * berkala di v1 (menghemat kuota D1 + baterai; pengguna yang
 * masuk menekan tombol saat butuh).
 *
 * Pesan galat disimpan sebagai kunci string (bukan teks
 * mentah) supaya UI bisa memakai copy strings/id.ts.
 */
import { create } from 'zustand';
import {
  fetchAuthMe,
  fetchDeleteAccount,
  fetchLogout,
  SyncApiError,
} from './syncClient';
import { syncNow as runSync } from './syncService';

export type SyncStatus = 'unknown' | 'signed-out' | 'signed-in';
export type SyncErrorKey =
  | 'syncErrorNetwork'
  | 'syncErrorServer'
  | 'syncErrorRateLimited'
  | 'syncErrorSignedOut'
  | null;

interface SyncState {
  status: SyncStatus;
  displayName: string | null;
  provider: string | null;
  lastSyncAt: number | null;
  syncing: boolean;
  error: SyncErrorKey;
  /** Periksa sesi ke server (dipanggil App sekali + sesudah redirect OAuth). */
  refreshAuth: () => Promise<void>;
  /** Satu putaran sinkronisasi penuh (hanya bila sudah masuk). */
  syncNow: () => Promise<void>;
  signOut: () => Promise<void>;
  deleteAccount: () => Promise<void>;
}

function errorKeyOf(e: unknown): SyncErrorKey {
  if (e instanceof SyncApiError) {
    if (e.status === 401) return 'syncErrorSignedOut';
    if (e.status === 429) return 'syncErrorRateLimited';
    if (e.status === 0) return 'syncErrorNetwork';
    return 'syncErrorServer';
  }
  return 'syncErrorServer';
}

export const useSyncStore = create<SyncState>()((set, get) => ({
  status: 'unknown',
  displayName: null,
  provider: null,
  lastSyncAt: null,
  syncing: false,
  error: null,

  refreshAuth: async () => {
    try {
      const me = await fetchAuthMe();
      set({
        status: 'signed-in',
        displayName: me.displayName,
        provider: me.provider,
        error: null,
      });
    } catch (e) {
      if (e instanceof SyncApiError && e.status === 401) {
        set({ status: 'signed-out', displayName: null, provider: null });
      } else {
        // Jaringan/server bermasalah: status tetap unknown
        // (bukan "belum masuk") supaya UI tidak menyuruh
        // pengguna masuk berulang kali padahal sesinya ada.
        set({ error: errorKeyOf(e) });
      }
    }
  },

  syncNow: async () => {
    if (get().syncing) return;
    if (get().status !== 'signed-in') return;
    set({ syncing: true, error: null });
    try {
      const result = await runSync();
      set({ lastSyncAt: result.serverTime, syncing: false });
    } catch (e) {
      const key = errorKeyOf(e);
      set({
        syncing: false,
        error: key,
        ...(key === 'syncErrorSignedOut'
          ? { status: 'signed-out' as const, displayName: null, provider: null }
          : {}),
      });
    }
  },

  signOut: async () => {
    try {
      await fetchLogout();
    } catch {
      // Cookie sesi mungkin sudah tidak valid; keluar lokal
      // tetap dilakukan supaya pengguna tidak terjebak.
    }
    set({
      status: 'signed-out',
      displayName: null,
      provider: null,
      lastSyncAt: null,
    });
  },

  deleteAccount: async () => {
    await fetchDeleteAccount();
    set({
      status: 'signed-out',
      displayName: null,
      provider: null,
      lastSyncAt: null,
    });
  },
}));
