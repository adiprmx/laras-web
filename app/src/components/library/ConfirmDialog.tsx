/** Dialog konfirmasi sederhana (hapus playlist, hapus riwayat). */
import { strings } from '../../strings/id';
import Dialog from '../Dialog';

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
    <Dialog
      title={title}
      role="alertdialog"
      onClose={onCancel}
      testId={testId ?? 'confirm-dialog'}
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
    </Dialog>
  );
}
