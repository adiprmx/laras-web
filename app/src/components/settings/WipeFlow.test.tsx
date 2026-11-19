// @vitest-environment jsdom
/**
 * Tes WipeFlow (Blue 3, Red 3 R15 + Blue 4, Red 4 R17): catatan
 * sinkronisasi tampil bila pengguna sedang masuk; status
 * `unknown` menunggu refreshAuth dulu dan memberi peringatan
 * bila status tetap tidak bisa dipastikan.
 *
 * Render klien (bukan renderToStaticMarkup): render statis
 * memakai snapshot awal Zustand sehingga status yang disetel
 * tes tidak terlihat komponen.
 *
 * fetchLogout/fetchAuthMe di-mock (syncClient) supaya alur
 * logout/refresh bisa dikendalikan; wipeAllData di-mock supaya
 * tes tidak menghapus database sungguhan. location.reload()
 * tidak di-stub (jsdom menolak menimpa reload di instance
 * maupun prototype): pemanggilan aslinya hanya mencatat
 * "not implemented" di jsdom tanpa melempar, dan reload
 * sesudah wipe sudah tercakup tes E2E p8.spec.ts di browser
 * nyata.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { strings } from '../../strings/id';
import { wipeAllData } from '../../backup/wipe';
import {
  fetchAuthMe,
  fetchLogout,
  SyncApiError,
} from '../../sync/syncClient';
import { useSyncStore } from '../../sync/syncStore';
import WipeFlow, { WIPE_REFRESH_TIMEOUT_MS } from './WipeFlow';

vi.mock('../../sync/syncClient', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../sync/syncClient')>();
  return {
    ...actual,
    fetchLogout: vi.fn(),
    fetchAuthMe: vi.fn(),
  };
});

vi.mock('../../backup/wipe', () => ({
  wipeAllData: vi.fn().mockResolvedValue({
    dbDeleted: true,
    cachesDeleted: [],
    localKeysRemoved: [],
    downloadsDeleted: 0,
    failedSteps: [],
  }),
}));

// React 19: tandai lingkungan tes supaya act() tidak memperingatkan.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function renderWipe(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<WipeFlow onClose={() => undefined} />);
  });
}

function html(): string {
  return container?.innerHTML ?? '';
}

async function clickTestId(testId: string): Promise<void> {
  const el = container?.querySelector(`[data-testid="${testId}"]`);
  if (!el) throw new Error(`elemen ${testId} tidak ditemukan`);
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchLogout).mockResolvedValue(undefined);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
  useSyncStore.setState({
    status: 'unknown',
    displayName: null,
    provider: null,
    lastSyncAt: null,
    error: null,
  });
  vi.useRealTimers();
});

describe('WipeFlow (R15)', () => {
  it('pengguna masuk melihat catatan sinkronisasi di dialog 1', async () => {
    useSyncStore.setState({
      status: 'signed-in',
      displayName: 'Adip',
      provider: 'google',
    });
    await renderWipe();
    expect(html()).toContain('data-testid="wipe-sync-note"');
    expect(html()).toContain(strings.backupWipeSyncNote);
  });

  it('pengguna belum masuk tidak melihat catatan sinkronisasi', async () => {
    useSyncStore.setState({ status: 'signed-out' });
    await renderWipe();
    expect(html()).not.toContain('data-testid="wipe-sync-note"');
  });

  it('copy dialog 2 menyebut data di server', () => {
    // Dialog 2 baru tampil sesudah klik; copy-nya diperiksa
    // langsung dari strings supaya janji "kembali kosong" tidak
    // kembali tanpa kualifikasi sinkronisasi.
    expect(strings.backupWipeBody2).toContain('server');
  });

  it('pengguna belum masuk: wipe langsung tanpa logout', async () => {
    useSyncStore.setState({ status: 'signed-out' });
    await renderWipe();
    await clickTestId('wipe-next');
    await clickTestId('wipe-confirm');
    await vi.waitFor(() =>
      expect(vi.mocked(wipeAllData)).toHaveBeenCalledTimes(1),
    );
    expect(fetchLogout).not.toHaveBeenCalled();
  });
});

describe('WipeFlow (R17: status unknown)', () => {
  it('unknown + refreshAuth sukses signed-in -> logout dipanggil SEBELUM wipe', async () => {
    useSyncStore.setState({ status: 'unknown' });
    vi.mocked(fetchAuthMe).mockResolvedValue({
      displayName: 'Adip',
      provider: 'google',
    });
    await renderWipe();
    await clickTestId('wipe-next');
    await clickTestId('wipe-confirm');
    await vi.waitFor(() =>
      expect(vi.mocked(wipeAllData)).toHaveBeenCalledTimes(1),
    );
    expect(fetchLogout).toHaveBeenCalledTimes(1);
    // Urutan: logout dulu, baru wipe.
    const logoutOrder = vi.mocked(fetchLogout).mock.invocationCallOrder[0];
    const wipeOrder = vi.mocked(wipeAllData).mock.invocationCallOrder[0];
    expect(logoutOrder).toBeLessThan(wipeOrder);
  });

  it('unknown + refreshAuth sukses signed-out -> wipe tanpa logout', async () => {
    useSyncStore.setState({ status: 'unknown' });
    vi.mocked(fetchAuthMe).mockRejectedValue(
      new SyncApiError(401, 'UNAUTHORIZED', 'Belum masuk'),
    );
    await renderWipe();
    await clickTestId('wipe-next');
    await clickTestId('wipe-confirm');
    await vi.waitFor(() =>
      expect(vi.mocked(wipeAllData)).toHaveBeenCalledTimes(1),
    );
    expect(fetchLogout).not.toHaveBeenCalled();
    expect(html()).not.toContain('data-testid="wipe-logout-failed"');
  });

  it('unknown + refreshAuth gagal jaringan -> peringatan tampil, wipe tidak lanjut', async () => {
    useSyncStore.setState({ status: 'unknown' });
    vi.mocked(fetchAuthMe).mockRejectedValue(
      new SyncApiError(0, 'NETWORK', 'Tidak bisa terhubung'),
    );
    await renderWipe();
    await clickTestId('wipe-next');
    await clickTestId('wipe-confirm');
    await vi.waitFor(() =>
      expect(html()).toContain('data-testid="wipe-logout-failed"'),
    );
    expect(html()).toContain(strings.backupWipeUnknownStatus);
    expect(html()).toContain('data-testid="wipe-retry-logout"');
    expect(html()).toContain('data-testid="wipe-anyway"');
    expect(wipeAllData).not.toHaveBeenCalled();
    expect(fetchLogout).not.toHaveBeenCalled();
  });

  it('unknown + refreshAuth menggantung -> peringatan tampil sesudah batas 10 detik', async () => {
    vi.useFakeTimers();
    useSyncStore.setState({ status: 'unknown' });
    // refreshAuth tidak pernah selesai (jaringan menggantung).
    vi.mocked(fetchAuthMe).mockImplementation(
      () => new Promise<never>(() => {}),
    );
    await renderWipe();
    await clickTestId('wipe-next');
    await act(async () => {
      const el = container?.querySelector(
        '[data-testid="wipe-confirm"]',
      ) as HTMLElement;
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      // Sebelum batas waktu: belum ada peringatan, wipe belum jalan.
      vi.advanceTimersByTime(WIPE_REFRESH_TIMEOUT_MS - 1000);
      await Promise.resolve();
      expect(html()).not.toContain('data-testid="wipe-logout-failed"');
      expect(wipeAllData).not.toHaveBeenCalled();
      // Melewati batas: peringatan tampil.
      vi.advanceTimersByTime(1000);
    });
    await act(async () => {});
    expect(html()).toContain('data-testid="wipe-logout-failed"');
    expect(html()).toContain(strings.backupWipeUnknownStatus);
    expect(wipeAllData).not.toHaveBeenCalled();
  });

  it('peringatan status unknown: "Tetap hapus" melanjutkan wipe', async () => {
    useSyncStore.setState({ status: 'unknown' });
    vi.mocked(fetchAuthMe).mockRejectedValue(
      new SyncApiError(0, 'NETWORK', 'Tidak bisa terhubung'),
    );
    await renderWipe();
    await clickTestId('wipe-next');
    await clickTestId('wipe-confirm');
    await vi.waitFor(() =>
      expect(html()).toContain('data-testid="wipe-anyway"'),
    );
    await clickTestId('wipe-anyway');
    await vi.waitFor(() =>
      expect(vi.mocked(wipeAllData)).toHaveBeenCalledTimes(1),
    );
  });
});
