/**
 * Ringkasan hasil impor (P8): dipakai dialog impor salinan dan
 * dialog impor Spotify. Tiga angka (baru / sudah ada / gagal)
 * dalam bahasa sehari-hari + daftar lagu yang gagal beserta
 * alasannya. Laporan TIDAK disimpan permanen: sesudah dialog
 * ditutup, laporan hilang; datanya tetap tersimpan.
 */
import type { ImportReport, ImportFailureReason } from '../../backup/report';
import { strings } from '../../strings/id';

function reasonText(reason: ImportFailureReason): string {
  switch (reason) {
    case 'notFound':
      return strings.importFailureNotFound;
    case 'skipped':
      return strings.importFailureSkipped;
    case 'cancelled':
      return strings.importFailureCancelled;
    case 'queueFull':
      return strings.importFailureQueueFull;
    case 'searchFailed':
      return strings.importFailureSearchFailed;
    case 'network':
      return strings.importFailureNetwork;
  }
}

export default function ImportReportView({ report }: { report: ImportReport }) {
  return (
    <div data-testid="import-report">
      <ul className="space-y-1 text-sm leading-relaxed text-zinc-300">
        <li data-testid="import-report-added">
          {strings.backupImportAdded(report.succeeded)}
        </li>
        {report.alreadyExisted > 0 ? (
          <li data-testid="import-report-existed">
            {strings.backupImportExisted(report.alreadyExisted)}
          </li>
        ) : null}
        {report.failures.length > 0 ? (
          <li data-testid="import-report-failed">
            {strings.backupImportFailedCount(report.failures.length)}
          </li>
        ) : null}
      </ul>
      {report.failures.length > 0 ? (
        <ul className="mt-3 max-h-40 space-y-1 overflow-y-auto rounded-xl border border-white/10 bg-black/40 p-3">
          {report.failures.map((failure, index) => (
            <li
              key={`${index}-${failure.label}`}
              className="text-sm leading-relaxed text-zinc-400"
            >
              <span className="text-zinc-200">{failure.label}</span>
              {': '}
              {reasonText(failure.reason)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
