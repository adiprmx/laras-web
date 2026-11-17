/** Dialog konfirmasi sederhana (hapus playlist, hapus riwayat). */
import { strings } from '../../strings/id';

interface ConfirmDialogProps {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  testId?: string;
}

export default function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
  testId,
}: ConfirmDialogProps) {
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
      data-testid={testId ?? 'confirm-dialog'}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-white/10 bg-zinc-900 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-zinc-100">{title}</h2>
        <p className="mt-2 text-sm leading-relaxed text-zinc-400">{body}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            data-testid="confirm-cancel"
            className="h-11 rounded-xl px-4 text-sm font-medium text-zinc-100 transition-colors hover:bg-white/10 active:scale-95"
          >
            {strings.cancel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            data-testid="confirm-ok"
            className="h-11 rounded-xl bg-red-500 px-4 text-sm font-medium text-white transition-transform duration-150 active:scale-95"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
