// @vitest-environment jsdom
/**
 * Tes WipeFlow (Blue 3, Red 3 R15): catatan sinkronisasi tampil
 * bila pengguna sedang masuk, dan copy dialog menyebut server.
 *
 * Render klien (bukan renderToStaticMarkup): render statis
 * memakai snapshot awal Zustand sehingga status yang disetel
 * tes tidak terlihat komponen.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { strings } from '../../strings/id';
import { useSyncStore } from '../../sync/syncStore';
import WipeFlow from './WipeFlow';

// React 19: tandai lingkungan tes supaya act() tidak memperingatkan.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function renderWipe(): Promise<string> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<WipeFlow onClose={() => undefined} />);
  });
  return container.innerHTML;
}

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
  });
});

describe('WipeFlow (R15)', () => {
  it('pengguna masuk melihat catatan sinkronisasi di dialog 1', async () => {
    useSyncStore.setState({
      status: 'signed-in',
      displayName: 'Adip',
      provider: 'google',
    });
    const html = await renderWipe();
    expect(html).toContain('data-testid="wipe-sync-note"');
    expect(html).toContain(strings.backupWipeSyncNote);
  });

  it('pengguna belum masuk tidak melihat catatan sinkronisasi', async () => {
    useSyncStore.setState({ status: 'signed-out' });
    const html = await renderWipe();
    expect(html).not.toContain('data-testid="wipe-sync-note"');
  });

  it('copy dialog 2 menyebut data di server', () => {
    // Dialog 2 baru tampil sesudah klik; copy-nya diperiksa
    // langsung dari strings supaya janji "kembali kosong" tidak
    // kembali tanpa kualifikasi sinkronisasi.
    expect(strings.backupWipeBody2).toContain('server');
  });
});
