/**
 * Dialog bersama (P-A11y, Koordinator #18).
 *
 * Memakai elemen <dialog> native + showModal(): focus trap dan
 * tutup-dengan-Esc GRATIS dari browser — tidak perlu trap manual.
 * Tampilan disamakan persis dengan dialog lama: kartu tengah di
 * desktop, lembar bawah di HP (margin bawah 16px, samping 16px),
 * backdrop hitam 70%.
 *
 * Perilaku: Esc -> onClose (event `close` native); klik backdrop
 * (target klik = elemen dialog) -> onClose; klik di dalam kartu
 * tidak menutup. onClose dipanggil MAKSIMAL sekali (guard ref)
 * supaya cleanup unmount tidak memanggil ganda.
 *
 * jsdom tidak punya showModal(): pemanggilan dijaga typeof —
 * di tes, elemen dialog tetap ada di DOM dan bisa di-query.
 */
import { useLayoutEffect, useRef, type ReactNode } from 'react';

interface DialogProps {
  /** Label aksesibilitas (aria-label). */
  title: string;
  /** 'alertdialog' untuk konfirmasi destruktif (hapus/wipe). */
  role?: 'dialog' | 'alertdialog';
  /** Dipanggil saat dialog ditutup (Esc / backdrop / close()). */
  onClose: () => void;
  children: ReactNode;
  /** data-testid di elemen <dialog>. */
  testId?: string;
  /** Lebar kartu: sm = max-w-sm (default), md = max-w-md. */
  size?: 'sm' | 'md';
  /** Padding kartu: md = p-5 (default), sm = p-3. */
  padding?: 'md' | 'sm';
  /** Bila daftar bisa panjang: batasi tinggi + scroll di dalam kartu. */
  maxHeight?: '80dvh' | '85vh';
}

export default function Dialog({
  title,
  role = 'dialog',
  onClose,
  children,
  testId,
  size = 'sm',
  padding = 'md',
  maxHeight,
}: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closedRef = useRef(false);

  const fireClose = (): void => {
    if (closedRef.current) return;
    closedRef.current = true;
    onCloseRef.current();
  };

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    // showModal() tidak ada di jsdom — jaga typeof supaya tes
    // unit tetap jalan (elemen dialog tetap ada di DOM).
    if (!dialog.open && typeof dialog.showModal === 'function') {
      dialog.showModal();
    }
    return () => {
      if (dialog.open && typeof dialog.close === 'function') {
        dialog.close();
      }
    };
  }, []);

  const sizeClass = size === 'md' ? 'max-w-md' : 'max-w-sm';
  const paddingClass = padding === 'sm' ? 'p-3' : 'p-5';
  const heightClass =
    maxHeight === '80dvh'
      ? 'max-h-[80dvh] overflow-y-auto'
      : maxHeight === '85vh'
        ? 'max-h-[85vh] overflow-y-auto'
        : '';

  return (
    <dialog
      ref={dialogRef}
      role={role}
      aria-modal="true"
      aria-label={title}
      data-testid={testId}
      onClose={fireClose}
      onClick={(e) => {
        // Klik backdrop = targetnya elemen dialog sendiri.
        if (e.target === e.currentTarget) fireClose();
      }}
      className={`m-auto w-full ${sizeClass} rounded-2xl border border-white/10 bg-zinc-900 ${paddingClass} text-zinc-100 backdrop:bg-black/70 max-sm:mx-4 max-sm:mb-4 max-sm:mt-auto ${heightClass}`}
    >
      {children}
    </dialog>
  );
}
