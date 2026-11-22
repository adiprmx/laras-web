// @vitest-environment jsdom
/**
 * Tes Dialog bersama (P-A11y, Koordinator #18).
 *
 * jsdom tidak mengimplementasikan showModal()/close() secara
 * penuh: prototype di-stub di sini (toggle atribut `open`).
 * Yang TIDAK bisa diuji di jsdom: focus trap native + Esc
 * browser (keduanya perilaku browser, bukan kode aplikasi) —
 * yang diuji: showModal dipanggil, event `close` (yang
 * dihasilkan Esc di browser) menutup, klik backdrop menutup,
 * klik di dalam tidak menutup, fokus awal masuk dialog.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import Dialog from './Dialog';

// React 19: tandai lingkungan tes supaya act() tidak memperingatkan.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const origShowModal = HTMLDialogElement.prototype.showModal;
const origClose = HTMLDialogElement.prototype.close;
const showModalSpy = vi.fn(function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
});
const closeSpy = vi.fn(function (this: HTMLDialogElement) {
  this.removeAttribute('open');
});

function renderDialog(props: {
  onClose: () => void;
  role?: 'dialog' | 'alertdialog';
  title?: string;
  withInput?: boolean;
}): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <Dialog
        title={props.title ?? 'Dialog tes'}
        role={props.role}
        onClose={props.onClose}
        testId="dialog-tes"
      >
        {props.withInput ? (
          <input autoFocus data-testid="dialog-input" />
        ) : null}
        <button type="button" data-testid="dialog-button">
          Tombol di dalam
        </button>
      </Dialog>,
    );
  });
}

beforeEach(() => {
  showModalSpy.mockClear();
  closeSpy.mockClear();
  HTMLDialogElement.prototype.showModal = showModalSpy;
  HTMLDialogElement.prototype.close = closeSpy;
});

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
  HTMLDialogElement.prototype.showModal = origShowModal;
  HTMLDialogElement.prototype.close = origClose;
});

describe('Dialog', () => {
  it('showModal dipanggil saat mount, dialog terbuka', () => {
    renderDialog({ onClose: () => {} });
    expect(showModalSpy).toHaveBeenCalledTimes(1);
    const dialog = document.querySelector('dialog');
    expect(dialog?.hasAttribute('open')).toBe(true);
    expect(dialog?.getAttribute('aria-label')).toBe('Dialog tes');
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
  });

  it('role alertdialog diteruskan', () => {
    renderDialog({ onClose: () => {}, role: 'alertdialog' });
    expect(document.querySelector('dialog')?.getAttribute('role')).toBe(
      'alertdialog',
    );
  });

  it('event close (Esc di browser) -> onClose sekali', () => {
    const onClose = vi.fn();
    renderDialog({ onClose });
    const dialog = document.querySelector('dialog')!;
    act(() => {
      dialog.dispatchEvent(new Event('close'));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    // Event close kedua (mis. cleanup) tidak memanggil lagi.
    act(() => {
      dialog.dispatchEvent(new Event('close'));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('klik backdrop (target = dialog) -> onClose', () => {
    const onClose = vi.fn();
    renderDialog({ onClose });
    const dialog = document.querySelector('dialog')!;
    act(() => {
      dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('klik di dalam konten TIDAK menutup', () => {
    const onClose = vi.fn();
    renderDialog({ onClose });
    const button = document.querySelector(
      '[data-testid="dialog-button"]',
    ) as HTMLButtonElement;
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('fokus awal masuk ke dalam dialog (autoFocus)', () => {
    renderDialog({ onClose: () => {}, withInput: true });
    const input = document.querySelector(
      '[data-testid="dialog-input"]',
    ) as HTMLInputElement;
    expect(document.activeElement).toBe(input);
  });

  it('unmount menutup dialog', () => {
    renderDialog({ onClose: () => {} });
    act(() => {
      root!.unmount();
    });
    root = null;
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
