/**
 * Seksi Salinan data di Pengaturan (P8): simpan salinan, pulihkan
 * dari salinan, impor dari Spotify, hapus semua data.
 *
 * Semua fitur jalan tanpa akun (aturan rencana §P8). Seksi ini
 * hidup di dalam SettingsPage yang lazy-load, jadi tidak masuk
 * bundle awal.
 */
import { useState } from 'react';
import { exportBackup } from '../../backup/service';
import { strings } from '../../strings/id';
import ImportBackupDialog from './ImportBackupDialog';
import SpotifyImportDialog from './SpotifyImportDialog';
import WipeFlow from './WipeFlow';

type Dialog = 'import' | 'spotify' | 'wipe' | null;

export default function BackupSection() {
  const [dialog, setDialog] = useState<Dialog>(null);
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<string | null>(null);

  const handleExport = async () => {
    if (exporting) return;
    setExporting(true);
    setExportResult(null);
    try {
      const payload = await exportBackup();
      setExportResult(
        payload.outcome === 'downloaded'
          ? strings.backupExported
          : payload.outcome === 'tooLarge'
            ? strings.backupTooLarge
            : strings.backupExportFailed,
      );
    } catch {
      setExportResult(strings.backupExportFailed);
    } finally {
      setExporting(false);
    }
  };

  return (
    <section
      aria-label={strings.settingsBackupSection}
      data-testid="settings-backup"
      className="mt-8"
    >
      <h2 className="text-lg font-semibold tracking-tight">
        {strings.settingsBackupSection}
      </h2>
      <div className="mt-3">
        <p className="text-sm leading-relaxed text-zinc-400">
          {strings.settingsBackupBody}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void handleExport()}
            disabled={exporting}
            data-testid="backup-export"
            className="h-11 rounded-full bg-white px-6 text-sm font-medium text-black transition-transform active:scale-95 disabled:opacity-50"
          >
            {exporting ? strings.backupExporting : strings.backupExport}
          </button>
          <button
            type="button"
            onClick={() => setDialog('import')}
            data-testid="backup-import-open"
            className="h-11 rounded-full border border-white/15 px-6 text-sm font-medium transition-colors hover:bg-white/5 active:scale-95"
          >
            {strings.backupImport}
          </button>
          <button
            type="button"
            onClick={() => setDialog('spotify')}
            data-testid="backup-spotify-open"
            className="h-11 rounded-full border border-white/15 px-6 text-sm font-medium transition-colors hover:bg-white/5 active:scale-95"
          >
            {strings.spotifyImport}
          </button>
        </div>
        {exportResult ? (
          <p
            data-testid="backup-export-result"
            className="mt-3 text-sm text-zinc-300"
          >
            {exportResult}
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => setDialog('wipe')}
          data-testid="backup-wipe-open"
          className="mt-4 h-11 rounded-full px-3 text-sm font-medium text-red-300 transition-colors hover:bg-white/5 active:scale-95"
        >
          {strings.backupWipe}
        </button>
      </div>
      {dialog === 'import' ? (
        <ImportBackupDialog onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'spotify' ? (
        <SpotifyImportDialog onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'wipe' ? <WipeFlow onClose={() => setDialog(null)} /> : null}
    </section>
  );
}
