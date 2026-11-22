/**
 * Layar Unduhan / Penyimpanan (P5).
 *
 * Isi: indikator ruang (unduhan + pemakaian app dari
 * `navigator.storage.estimate()`), unduhan yang sedang berjalan
 * (progres nyata per chunk), antrean + gagal, daftar lagu
 * terunduh (ukuran per lagu + total), hapus per lagu, hapus
 * semua (2 konfirmasi). Semua angka dari data nyata; perkiraan
 * selalu dilabeli perkiraan.
 *
 * Data dimuat ulang tiap `libraryVersion` berubah (manajer
 * unduhan menulis progres ke Dexie per chunk, dan tiap tulis
 * menaikkan versi lewat `notify()`).
 */
import { useEffect, useState } from 'react';
import { ArrowClockwise, Play, Trash, X } from '@phosphor-icons/react';
import { getLibraryService } from '../../data/library';
import {
  DownloadJobStatus,
  type SongView,
} from '../../data/types';
import { formatBytes } from '../../downloads/quality';
import {
  getDownloadManager,
  getDownloadStorageStats,
} from '../../downloads/downloadManager';
import { getPlayerService } from '../../player/service';
import { useLibraryStore } from '../../store/library';
import { strings } from '../../strings/id';
import AppLink from '../AppLink';
import SkeletonList from '../SkeletonList';
import ConfirmDialog from '../library/ConfirmDialog';
import { tracksFromViews } from '../library/trackFromView';

interface JobRow {
  songId: string;
  status: number;
  bytesDownloaded: number;
  totalBytes: number | null;
  errorMessage: string | null;
}

interface JobWithSong {
  job: JobRow;
  view: SongView | null;
}

interface StorageStats {
  downloadCount: number;
  downloadBytes: number;
  usageBytes: number | null;
  quotaBytes: number | null;
}

function ProgressBar({ value }: { value: number | null }) {
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value ?? undefined}
      className="h-1.5 w-full overflow-hidden rounded-full bg-white/10"
    >
      <div
        className="h-full rounded-full bg-white transition-[width] duration-300"
        style={{ width: `${value ?? 0}%` }}
      />
    </div>
  );
}

export default function DownloadsPage({
  onNavigate,
}: {
  onNavigate: (path: string) => void;
}) {
  const libraryVersion = useLibraryStore((s) => s.version);
  const [downloaded, setDownloaded] = useState<SongView[]>([]);
  const [jobs, setJobs] = useState<JobWithSong[]>([]);
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [message, setMessage] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<SongView | null>(null);
  const [deleteAllStep, setDeleteAllStep] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    getLibraryService()
      .then(async (service) => {
        const [list, jobRows, storage] = await Promise.all([
          service.downloadedSongsList(),
          service.downloadJobs(),
          getDownloadStorageStats({ library: service }),
        ]);
        const views = await service.songsByIds(
          jobRows.map((j) => j.songId),
        );
        const byId = new Map(views.map((v) => [v.song.id, v]));
        if (!alive) return;
        setDownloaded(list);
        setJobs(
          jobRows.map((job) => ({
            job,
            view: byId.get(job.songId) ?? null,
          })),
        );
        setStats(storage);
        setError(false);
      })
      .catch(() => {
        if (alive) setError(true);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [libraryVersion]);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(''), 3000);
    return () => clearTimeout(timer);
  }, [message]);

  const running = jobs.filter(
    (j) => j.job.status === DownloadJobStatus.running,
  );
  const queued = jobs.filter(
    (j) => j.job.status === DownloadJobStatus.queued,
  );
  const failed = jobs.filter(
    (j) => j.job.status === DownloadJobStatus.failed,
  );

  const playDownloaded = (index: number): void => {
    const tracks = tracksFromViews(downloaded);
    void getPlayerService().playQueue(tracks, index);
  };

  const cancelJob = (songId: string): void => {
    void getDownloadManager()
      .then((manager) => manager.cancel(songId))
      .then(() => setMessage(strings.downloadCancelled))
      .catch(() => undefined);
  };

  const retryJob = (songId: string): void => {
    void getDownloadManager()
      .then((manager) => manager.retry(songId))
      .catch(() => undefined);
  };

  const confirmDeleteOne = (): void => {
    if (!deleteTarget) return;
    const songId = deleteTarget.song.id;
    setDeleteTarget(null);
    void getDownloadManager()
      .then((manager) => manager.deleteDownload(songId))
      .then(() => setMessage(strings.downloadDeleted))
      .catch(() => undefined);
  };

  const confirmDeleteAll = (): void => {
    setDeleteAllStep(0);
    void getDownloadManager()
      .then((manager) => manager.deleteAllDownloads())
      .then(() => setMessage(strings.storageDeletedAll))
      .catch(() => undefined);
  };

  if (error) {
    return (
      <div data-testid="downloads-page" className="pt-4">
        <p className="text-center text-sm text-zinc-400">
          {strings.libraryErrorBody}
        </p>
      </div>
    );
  }

  const usagePercent =
    stats && stats.usageBytes !== null && stats.quotaBytes !== null &&
    stats.quotaBytes > 0
      ? Math.min(100, Math.round((stats.usageBytes / stats.quotaBytes) * 100))
      : null;

  return (
    <div data-testid="downloads-page" className="pt-2">
      <h1 className="text-xl font-bold tracking-tight">{strings.downloads}</h1>

      {message ? (
        <p
          data-testid="downloads-message"
          role="status"
          className="mt-3 rounded-xl border border-white/10 bg-zinc-900 px-4 py-3 text-sm text-zinc-100"
        >
          {message}
        </p>
      ) : null}

      {/* Indikator ruang. */}
      <section
        aria-label={strings.storageTitle}
        data-testid="storage-card"
        className="mt-4 rounded-2xl border border-white/10 bg-zinc-900 p-4"
      >
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium text-zinc-100">
            {strings.storageDownloadedLabel}
          </h2>
          <p
            data-testid="storage-download-total"
            className="text-sm tabular-nums text-zinc-100"
          >
            {stats
              ? `${stats.downloadCount} ${strings.songsLabel} · ${formatBytes(stats.downloadBytes)}`
              : '...'}
          </p>
        </div>
        {usagePercent !== null && stats ? (
          <div className="mt-4">
            <ProgressBar value={usagePercent} />
            <p
              data-testid="storage-usage"
              className="mt-2 text-xs tabular-nums text-zinc-400"
            >
              {strings.storageUsageLabel}:{' '}
              {strings.storageOf(
                formatBytes(stats.usageBytes),
                formatBytes(stats.quotaBytes),
              )}
            </p>
          </div>
        ) : (
          <p
            data-testid="storage-usage"
            className="mt-4 text-xs text-zinc-400"
          >
            {strings.storageUnknownQuota}
          </p>
        )}
      </section>

      {loading ? (
        <div className="mt-4" data-testid="downloads-loading">
          <SkeletonList rows={6} testId="downloads-skeleton" />
        </div>
      ) : (
        <>
          {/* Sedang mengunduh. */}
          {running.map(({ job, view }) => {
            const percent =
              job.totalBytes !== null && job.totalBytes > 0
                ? Math.min(
                    100,
                    Math.round((job.bytesDownloaded / job.totalBytes) * 100),
                  )
                : null;
            return (
              <section
                key={job.songId}
                aria-label={strings.storageDownloading}
                data-testid={`download-active-${job.songId}`}
                className="mt-4 rounded-2xl border border-white/10 bg-zinc-900 p-4"
              >
                <div className="flex items-center gap-3">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-zinc-100">
                      {view?.song.title ?? job.songId}
                    </span>
                    <span className="block text-xs text-zinc-400">
                      {strings.storageDownloading}
                      {percent !== null ? ` · ${percent}%` : ''}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => cancelJob(job.songId)}
                    aria-label={strings.cancelDownload}
                    data-testid={`download-cancel-${job.songId}`}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-zinc-400 transition-colors hover:text-zinc-100 active:scale-95"
                  >
                    <X size={20} />
                  </button>
                </div>
                <div className="mt-3">
                  <ProgressBar value={percent} />
                  <p className="mt-2 text-xs tabular-nums text-zinc-400">
                    {job.totalBytes !== null
                      ? strings.storageOf(
                          formatBytes(job.bytesDownloaded),
                          formatBytes(job.totalBytes),
                        )
                      : formatBytes(job.bytesDownloaded)}
                  </p>
                </div>
              </section>
            );
          })}

          {/* Menunggu giliran + gagal. */}
          {[...queued, ...failed].map(({ job, view }) => {
            const isFailed = job.status === DownloadJobStatus.failed;
            return (
              <section
                key={job.songId}
                data-testid={`download-job-${job.songId}`}
                className="mt-4 flex items-center gap-3 rounded-2xl border border-white/10 bg-zinc-900 p-4"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-zinc-100">
                    {view?.song.title ?? job.songId}
                  </span>
                  <span className="block text-xs leading-relaxed text-zinc-400">
                    {isFailed
                      ? (job.errorMessage ?? strings.storageFailed)
                      : strings.storageQueued}
                  </span>
                </span>
                {isFailed ? (
                  <button
                    type="button"
                    onClick={() => retryJob(job.songId)}
                    data-testid={`download-retry-${job.songId}`}
                    className="flex h-11 shrink-0 items-center gap-1.5 rounded-full border border-white/15 px-4 text-sm font-medium transition-colors hover:bg-white/5 active:scale-95"
                  >
                    <ArrowClockwise size={16} />
                    {strings.retryDownload}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => cancelJob(job.songId)}
                  aria-label={strings.cancelDownload}
                  data-testid={`download-cancel-${job.songId}`}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-zinc-400 transition-colors hover:text-zinc-100 active:scale-95"
                >
                  <X size={20} />
                </button>
              </section>
            );
          })}

          {/* Daftar lagu terunduh. */}
          {downloaded.length > 0 ? (
            <section aria-label={strings.downloads} className="mt-6">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="text-lg font-semibold tracking-tight">
                  {strings.downloads}
                </h2>
                <button
                  type="button"
                  onClick={() => playDownloaded(0)}
                  data-testid="downloads-play-all"
                  className="flex h-11 shrink-0 items-center gap-1.5 rounded-full bg-white px-4 text-sm font-medium text-black transition-transform active:scale-95"
                >
                  <Play size={16} weight="fill" />
                  {strings.storagePlayAll}
                </button>
              </div>
              <ul className="mt-3 divide-y divide-white/5">
                {downloaded.map((view, index) => (
                  <li
                    key={view.song.id}
                    className="flex items-center gap-3 py-2"
                  >
                    <button
                      type="button"
                      onClick={() => playDownloaded(index)}
                      data-testid={`download-row-${view.song.id}`}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    >
                      <span
                        aria-hidden="true"
                        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-zinc-900 text-sm text-zinc-400"
                      >
                        {view.song.title.charAt(0)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-zinc-100">
                          {view.song.title}
                        </span>
                        <span className="block truncate text-xs text-zinc-400">
                          {view.artistNames.join(', ') ||
                            formatBytes(view.song.fileSizeBytes)}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-zinc-400">
                        {formatBytes(view.song.fileSizeBytes)}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteTarget(view)}
                      aria-label={strings.deleteDownload}
                      data-testid={`download-delete-${view.song.id}`}
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-zinc-400 transition-colors hover:text-zinc-100 active:scale-95"
                    >
                      <Trash size={20} />
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => setDeleteAllStep(1)}
                data-testid="storage-delete-all"
                className="mt-6 flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-red-500/40 text-sm font-medium text-red-400 transition-colors hover:bg-red-500/10 active:scale-[0.98]"
              >
                <Trash size={18} />
                {strings.storageDeleteAll}
              </button>
            </section>
          ) : null}

          {downloaded.length === 0 && jobs.length === 0 ? (
            <div data-testid="downloads-empty" className="py-16 text-center">
              <h2 className="text-lg font-semibold tracking-tight">
                {strings.storageEmptyTitle}
              </h2>
              <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-zinc-400">
                {strings.storageEmptyBody}
              </p>
              <AppLink
                to="/search"
                onNavigate={onNavigate}
                testId="downloads-empty-find"
                className="mt-6 inline-flex h-11 items-center rounded-full bg-white px-6 text-sm font-medium text-black transition-transform active:scale-95"
              >
                {strings.findSong}
              </AppLink>
            </div>
          ) : null}
        </>
      )}

      {deleteTarget ? (
        <ConfirmDialog
          title={strings.deleteDownloadTitle}
          body={strings.deleteDownloadBody}
          confirmLabel={strings.delete}
          onConfirm={confirmDeleteOne}
          onCancel={() => setDeleteTarget(null)}
          testId="delete-download-dialog"
        />
      ) : null}

      {deleteAllStep === 1 ? (
        <ConfirmDialog
          title={strings.storageDeleteAllTitle}
          body={strings.storageDeleteAllBody(downloaded.length)}
          confirmLabel={strings.delete}
          onConfirm={() => setDeleteAllStep(2)}
          onCancel={() => setDeleteAllStep(0)}
          testId="delete-all-dialog-1"
        />
      ) : null}
      {deleteAllStep === 2 ? (
        <ConfirmDialog
          title={strings.storageDeleteAllSecondTitle}
          body={strings.storageDeleteAllSecondBody}
          confirmLabel={strings.storageDeleteAllConfirm}
          onConfirm={confirmDeleteAll}
          onCancel={() => setDeleteAllStep(0)}
          testId="delete-all-dialog-2"
        />
      ) : null}
    </div>
  );
}
