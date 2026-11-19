/**
 * Dialog pulihkan dari salinan (P8, PRD B10.1).
 *
 * Alur: pilih file -> pratinjau isi (tanpa mengubah database) ->
 * Pulihkan (merge satu transaksi) -> ringkasan hasil. File
 * rusak/versi tak dikenal ditolak di pratinjau dengan pesan
 * jelas, bukan crash. Opsi "Pakai juga pengaturan dari file"
 * aktif bawaan; mematikannya hanya memulihkan data.
 *
 * Sesudah impor, lagu yang dulu terunduh (menurut file) bisa
 * diunduh ulang dengan satu tombol — file lagunya tidak ikut
 * tersimpan di salinan.
 */
import { useRef, useState } from 'react';
import {
  BackupException,
  formatBackupDate,
  MAX_BACKUP_BYTES,
  type BackupData,
} from '../../backup/format';
import type { ImportReport } from '../../backup/report';
import {
  capRedownloadIds,
  importBackup,
  previewImport,
} from '../../backup/service';
import { getDownloadManager } from '../../downloads/downloadManager';
import { strings } from '../../strings/id';
import ImportReportView from './ImportReportView';

function errorText(error: unknown): string {
  if (error instanceof BackupException) {
    switch (error.kind) {
      case 'tooLarge':
        return strings.backupErrorTooLarge;
      case 'invalidJson':
        return strings.backupErrorInvalidJson;
      case 'notBackup':
        return strings.backupErrorNotBackup;
      case 'newerVersion':
        return strings.backupErrorNewerVersion;
      case 'invalidStructure':
        return strings.backupErrorInvalidStructure;
    }
  }
  return strings.backupErrorUnknown;
}

function CountRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-white/5 py-2 last:border-b-0">
      <span className="shrink-0 text-sm text-zinc-400">{label}</span>
      <span className="text-sm tabular-nums text-zinc-100">{value}</span>
    </div>
  );
}

export default function ImportBackupDialog({
  onClose,
}: {
  onClose: () => void;
}) {
  const [data, setData] = useState<BackupData | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [applySettings, setApplySettings] = useState(true);
  const [redownloading, setRedownloading] = useState(false);
  const [redownloadDone, setRedownloadDone] = useState(false);
  const [redownloadResult, setRedownloadResult] = useState<{
    queued: number;
    skipped: number;
  } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    // R12: cek ukuran SEBELUM arrayBuffer() — file raksasa tidak
    // boleh dialokasikan ke memori tab dulu (cek di parser tetap
    // ada sebagai lapis kedua).
    if (file.size > MAX_BACKUP_BYTES) {
      setError(strings.backupErrorTooLarge);
      return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      setData(previewImport(bytes));
    } catch (e) {
      setError(errorText(e));
    }
  };

  const handleRestore = async () => {
    if (!data || importing) return;
    setImporting(true);
    setError(null);
    try {
      const result = await importBackup(data, { applySettings });
      setReport(result);
    } catch {
      setError(strings.backupErrorUnknown);
    } finally {
      setImporting(false);
    }
  };

  const handleRedownload = async () => {
    if (!data || !report || redownloading) return;
    setRedownloading(true);
    try {
      // R14: antrean unduh-ulang dibatasi 200 lagu; kelebihan
      // dilaporkan, bukan diam-diam dipotong.
      const { queued, skipped } = capRedownloadIds(report.downloadedSongIds);
      const manager = await getDownloadManager();
      const songsById = new Map(data.songs.map((s) => [s.id, s]));
      for (const songId of queued) {
        const song = songsById.get(songId);
        if (!song) continue;
        await manager.enqueue(songId, 'balanced', {
          title: song.title,
          durationSeconds: song.durationSeconds,
          artistNames: song.artists.map((a) => a.name),
        });
      }
      setRedownloadResult({ queued: queued.length, skipped });
      setRedownloadDone(true);
    } catch {
      // Gagal antre: pengguna bisa mengunduh manual dari Library.
      setRedownloadDone(false);
    } finally {
      setRedownloading(false);
    }
  };

  const done = report !== null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={strings.backupImportTitle}
      data-testid="import-backup-dialog"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-sm overflow-y-auto rounded-2xl border border-white/10 bg-zinc-900 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-zinc-100">
          {done ? strings.backupImportDoneTitle : strings.backupImportTitle}
        </h2>

        {!done && data === null ? (
          <div>
            <p className="mt-2 text-sm leading-relaxed text-zinc-400">
              {strings.backupImportBody}
            </p>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              data-testid="import-backup-file-input"
              onChange={(e) => void handleFile(e.target.files?.[0])}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              data-testid="import-backup-choose"
              className="mt-4 h-11 rounded-full bg-white px-6 text-sm font-medium text-black transition-transform active:scale-95"
            >
              {strings.backupChooseFile}
            </button>
            {error ? (
              <p
                data-testid="import-backup-error"
                className="mt-3 text-sm text-red-300"
              >
                {error}
              </p>
            ) : null}
          </div>
        ) : null}

        {!done && data !== null ? (
          <div>
            <h3 className="mt-3 text-sm font-semibold text-zinc-100">
              {strings.backupPreviewTitle}
            </h3>
            <p className="mt-1 text-sm text-zinc-400">
              {strings.backupPreviewMade(formatBackupDate(data.exportedAt))}
            </p>
            <div className="mt-2" data-testid="import-backup-preview">
              <CountRow
                label={strings.backupPreviewSongs}
                value={data.songs.length}
              />
              <CountRow
                label={strings.backupPreviewPlaylists}
                value={data.playlists.length}
              />
              <CountRow
                label={strings.backupPreviewHistory}
                value={data.playEvents.length}
              />
              <CountRow
                label={strings.backupPreviewQueue}
                value={data.queue.length}
              />
              <CountRow
                label={strings.backupPreviewSearches}
                value={data.searchHistory.length}
              />
            </div>
            {data.settings !== null ? (
              <label className="mt-4 flex cursor-pointer items-center gap-3 text-sm text-zinc-300">
                <input
                  type="checkbox"
                  checked={applySettings}
                  onChange={(e) => setApplySettings(e.target.checked)}
                  data-testid="import-backup-apply-settings"
                  className="h-5 w-5 shrink-0 accent-white"
                />
                {strings.backupImportApplySettings}
              </label>
            ) : null}
            {error ? (
              <p
                data-testid="import-backup-error"
                className="mt-3 text-sm text-red-300"
              >
                {error}
              </p>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                data-testid="import-backup-cancel"
                className="h-11 rounded-xl px-4 text-sm font-medium text-zinc-100 transition-colors hover:bg-white/10 active:scale-95"
              >
                {strings.cancel}
              </button>
              <button
                type="button"
                onClick={() => void handleRestore()}
                disabled={importing}
                data-testid="import-backup-restore"
                className="h-11 rounded-xl bg-white px-4 text-sm font-medium text-black transition-transform active:scale-95 disabled:opacity-50"
              >
                {importing ? strings.backupImporting : strings.backupRestore}
              </button>
            </div>
          </div>
        ) : null}

        {done && report ? (
          <div className="mt-3">
            <ImportReportView report={report} />
            {report.downloadedSongIds.length > 0 ? (
              <div className="mt-4">
                <p className="text-sm leading-relaxed text-zinc-400">
                  {strings.backupRedownloadNote}
                </p>
                {redownloadDone ? (
                  <p
                    data-testid="import-backup-redownload-done"
                    className="mt-2 text-sm text-zinc-300"
                  >
                    {redownloadResult && redownloadResult.skipped > 0
                      ? strings.backupRedownloadPartial(
                          redownloadResult.queued,
                          redownloadResult.skipped,
                        )
                      : strings.backupRedownloadDone}
                  </p>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handleRedownload()}
                    disabled={redownloading}
                    data-testid="import-backup-redownload"
                    className="mt-3 h-11 rounded-full border border-white/15 px-6 text-sm font-medium transition-colors hover:bg-white/5 active:scale-95 disabled:opacity-50"
                  >
                    {strings.backupRedownload}
                  </button>
                )}
              </div>
            ) : null}
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={onClose}
                data-testid="import-backup-close"
                className="h-11 rounded-xl bg-white px-4 text-sm font-medium text-black transition-transform active:scale-95"
              >
                {strings.done}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
