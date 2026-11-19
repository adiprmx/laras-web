/**
 * Alur hapus semua data (P8, PRD B7.5): DUA konfirmasi + tombol
 * "Simpan salinan dulu" yang mengekspor backup sebelum menghapus.
 *
 * Dialog 1: penjelasan + "Simpan salinan dulu" + Hapus + Batal.
 * Menyimpan salinan TIDAK otomatis menghapus: pengguna tetap
 * harus menekan Hapus, lalu mengonfirmasi sekali lagi di dialog 2.
 * Bila ekspor gagal, pengguna tetap bisa menghapus (pilihannya
 * sendiri) — kegagalan ekspor tidak boleh mengunci penghapusan.
 *
 * Sesudah wipe berhasil, halaman dimuat ulang: state memori
 * (store, antrean pemutar) ikut bersih — sama seperti APK yang
 * menutup app sesudah wipe.
 */
import { useState } from 'react';
import { exportBackup } from '../../backup/service';
import { wipeAllData } from '../../backup/wipe';
import { strings } from '../../strings/id';

export default function WipeFlow({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<1 | 2>(1);
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [wiping, setWiping] = useState(false);

  const handleSaveFirst = async () => {
    if (exporting) return;
    setExporting(true);
    setExportNote(null);
    try {
      const payload = await exportBackup();
      setExportNote(
        payload.outcome === 'downloaded'
          ? strings.backupWipeSaved
          : payload.outcome === 'tooLarge'
            ? strings.backupTooLarge
            : strings.backupExportFailed,
      );
    } catch {
      setExportNote(strings.backupExportFailed);
    } finally {
      setExporting(false);
    }
  };

  const handleWipe = async () => {
    if (wiping) return;
    setWiping(true);
    try {
      await wipeAllData();
    } finally {
      // Reload apa pun hasilnya: sebagian data mungkin sudah
      // terhapus; membiarkan UI lama tampil adalah keadaan yang
      // lebih membingungkan daripada reload ke keadaan bersih.
      window.location.reload();
    }
  };

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label={
        step === 1 ? strings.backupWipeTitle1 : strings.backupWipeTitle2
      }
      data-testid="wipe-dialog"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-white/10 bg-zinc-900 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        {step === 1 ? (
          <div>
            <h2 className="text-base font-semibold text-zinc-100">
              {strings.backupWipeTitle1}
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-zinc-400">
              {strings.backupWipeBody1}
            </p>
            <button
              type="button"
              onClick={() => void handleSaveFirst()}
              disabled={exporting}
              data-testid="wipe-save-first"
              className="mt-4 h-11 w-full rounded-full border border-white/15 px-6 text-sm font-medium transition-colors hover:bg-white/5 active:scale-95 disabled:opacity-50"
            >
              {exporting ? strings.backupExporting : strings.backupWipeSaveFirst}
            </button>
            {exportNote ? (
              <p
                data-testid="wipe-save-note"
                className="mt-3 text-sm text-zinc-300"
              >
                {exportNote}
              </p>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                data-testid="wipe-cancel"
                className="h-11 rounded-xl px-4 text-sm font-medium text-zinc-100 transition-colors hover:bg-white/10 active:scale-95"
              >
                {strings.cancel}
              </button>
              <button
                type="button"
                onClick={() => setStep(2)}
                data-testid="wipe-next"
                className="h-11 rounded-xl bg-red-500 px-4 text-sm font-medium text-white transition-transform duration-150 active:scale-95"
              >
                {strings.delete}
              </button>
            </div>
          </div>
        ) : (
          <div>
            <h2 className="text-base font-semibold text-zinc-100">
              {strings.backupWipeTitle2}
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-zinc-400">
              {strings.backupWipeBody2}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={wiping}
                data-testid="wipe-cancel-2"
                className="h-11 rounded-xl px-4 text-sm font-medium text-zinc-100 transition-colors hover:bg-white/10 active:scale-95 disabled:opacity-50"
              >
                {strings.cancel}
              </button>
              <button
                type="button"
                onClick={() => void handleWipe()}
                disabled={wiping}
                data-testid="wipe-confirm"
                className="h-11 rounded-xl bg-red-500 px-4 text-sm font-medium text-white transition-transform duration-150 active:scale-95 disabled:opacity-50"
              >
                {wiping ? strings.backupWiping : strings.backupWipeConfirm}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
