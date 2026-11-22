/**
 * Dialog pilih kualitas unduhan (P5): tiga opsi dengan perkiraan
 * ukuran dari durasi lagu. Tanpa kata itag/bitrate/codec di UI —
 * hanya label sehari-hari + perkiraan ukuran.
 */
import { strings } from '../../strings/id';
import Dialog from '../Dialog';
import {
  estimateDownloadBytes,
  formatBytes,
  type DownloadQuality,
} from '../../downloads/quality';

interface DownloadQualityDialogProps {
  title: string;
  durationSeconds: number | null | undefined;
  onPick: (quality: DownloadQuality) => void;
  onCancel: () => void;
}

const OPTIONS: Array<{
  quality: DownloadQuality;
  label: string;
  note: string;
  testId: string;
}> = [
  {
    quality: 'best',
    label: strings.downloadQualityBest,
    note: strings.downloadQualityBestNote,
    testId: 'quality-best',
  },
  {
    quality: 'balanced',
    label: strings.downloadQualityBalanced,
    note: strings.downloadQualityBalancedNote,
    testId: 'quality-balanced',
  },
  {
    quality: 'dataSaver',
    label: strings.downloadQualityDataSaver,
    note: strings.downloadQualityDataSaverNote,
    testId: 'quality-datasaver',
  },
];

export default function DownloadQualityDialog({
  title,
  durationSeconds,
  onPick,
  onCancel,
}: DownloadQualityDialogProps) {
  return (
    <Dialog
      title={strings.downloadQualityTitle}
      onClose={onCancel}
      testId="download-quality-dialog"
      padding="sm"
    >
        <h2 className="px-3 pb-1 pt-2 text-base font-semibold text-zinc-100">
          {strings.downloadQualityTitle}
        </h2>
        <p className="truncate px-3 pb-2 text-sm text-zinc-400">{title}</p>
        {OPTIONS.map((option) => {
          const estimate = estimateDownloadBytes(
            option.quality,
            durationSeconds,
          );
          return (
            <button
              key={option.quality}
              type="button"
              data-testid={option.testId}
              onClick={() => onPick(option.quality)}
              className="flex min-h-[64px] w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-white/5 active:scale-[0.98]"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-medium text-zinc-100">
                  {option.label}
                </span>
                <span className="block text-xs text-zinc-400">
                  {option.note}
                </span>
              </span>
              {estimate !== null ? (
                <span className="shrink-0 text-xs tabular-nums text-zinc-400">
                  {strings.downloadEstimatedSize(formatBytes(estimate))}
                </span>
              ) : null}
            </button>
          );
        })}
        <button
          type="button"
          onClick={onCancel}
          data-testid="quality-cancel"
          className="mt-2 h-11 w-full rounded-xl text-sm font-medium text-zinc-100 transition-colors hover:bg-white/10 active:scale-95"
        >
          {strings.cancel}
        </button>
    </Dialog>
  );
}
