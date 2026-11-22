/**
 * Menu lagu (lembar bawah): putar berikutnya, tambah antrean,
 * tambah ke playlist, suka, unduh, hapus dari Library / playlist.
 */
import { useEffect, useState } from 'react';
import {
  ArrowClockwise,
  CaretDown,
  CaretUp,
  Download,
  Heart,
  ListPlus,
  Play,
  Playlist,
  Trash,
  X,
} from '@phosphor-icons/react';
import { getLibraryService } from '../../data/library';
import { DownloadJobStatus, type SongView } from '../../data/types';
import type { DownloadQuality } from '../../downloads/quality';
import { getPlayerService } from '../../player/service';
import { useLibraryStore } from '../../store/library';
import { strings } from '../../strings/id';
import DownloadQualityDialog from '../downloads/DownloadQualityDialog';
import Dialog from '../Dialog';
import AddToPlaylistDialog from './AddToPlaylistDialog';
import ConfirmDialog from './ConfirmDialog';
import { trackFromView } from './trackFromView';

interface SongMenuProps {
  view: SongView;
  /** Bila di dalam detail playlist: tampilkan pindah posisi + hapus. */
  playlistId?: number;
  onClose: () => void;
  onMessage: (message: string) => void;
  onRemoveFromPlaylist?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}

export default function SongMenu({
  view,
  playlistId,
  onClose,
  onMessage,
  onRemoveFromPlaylist,
  onMoveUp,
  onMoveDown,
}: SongMenuProps) {
  const version = useLibraryStore((s) => s.version);
  const [liked, setLiked] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [jobStatus, setJobStatus] = useState<number | null>(null);
  const [showAddToPlaylist, setShowAddToPlaylist] = useState(false);
  const [showQuality, setShowQuality] = useState(false);
  const [showDeleteDownload, setShowDeleteDownload] = useState(false);
  const track = trackFromView(view);
  // Lagu lokal (id = URL) tidak bisa diunduh: filenya sudah lokal.
  const isLocalTrack =
    view.song.id.startsWith('http://') ||
    view.song.id.startsWith('https://');

  useEffect(() => {
    let alive = true;
    getLibraryService()
      .then(async (service) => {
        const [likedValue, downloadedValue, job] = await Promise.all([
          service.isLiked(view.song.id),
          service.isDownloaded(view.song.id),
          service.downloadJobBySongId(view.song.id),
        ]);
        if (!alive) return;
        setLiked(likedValue);
        setDownloaded(downloadedValue);
        setJobStatus(job ? job.status : null);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [view.song.id, version]);

  const service = getPlayerService();

  const downloadManager = async () => {
    const { getDownloadManager } = await import(
      '../../downloads/downloadManager'
    );
    return getDownloadManager();
  };

  const pickQuality = (quality: DownloadQuality): void => {
    setShowQuality(false);
    void downloadManager()
      .then((manager) =>
        manager.enqueue(view.song.id, quality, {
          title: view.song.title,
          durationSeconds: view.song.durationSeconds,
          artistNames: view.artistNames,
        }),
      )
      .then((result) => {
        onMessage(
          result === 'already-downloaded'
            ? strings.downloadAlreadyDownloaded
            : result === 'already-queued'
              ? strings.downloadAlreadyQueued
              : strings.downloadQueued,
        );
        onClose();
      })
      .catch(() => onClose());
  };

  if (showQuality) {
    return (
      <DownloadQualityDialog
        title={view.song.title}
        durationSeconds={view.song.durationSeconds}
        onPick={pickQuality}
        onCancel={() => setShowQuality(false)}
      />
    );
  }

  if (showDeleteDownload) {
    return (
      <ConfirmDialog
        title={strings.deleteDownloadTitle}
        body={strings.deleteDownloadBody}
        confirmLabel={strings.delete}
        onConfirm={() => {
          setShowDeleteDownload(false);
          void downloadManager()
            .then((manager) => manager.deleteDownload(view.song.id))
            .then(() => {
              onMessage(strings.downloadDeleted);
              onClose();
            })
            .catch(() => onClose());
        }}
        onCancel={() => setShowDeleteDownload(false)}
        testId="menu-delete-download-dialog"
      />
    );
  }

  if (showAddToPlaylist) {
    return (
      <AddToPlaylistDialog
        songId={view.song.id}
        onDone={(message) => {
          setShowAddToPlaylist(false);
          onMessage(message);
          onClose();
        }}
        onCancel={() => setShowAddToPlaylist(false)}
      />
    );
  }

  const itemClass =
    'flex h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-[15px] text-zinc-100 transition-colors hover:bg-white/5 active:scale-[0.98]';

  return (
    <Dialog
      title={view.song.title}
      onClose={onClose}
      testId="song-menu"
      padding="sm"
    >
        <p className="truncate px-3 pb-2 pt-1 text-sm font-medium text-zinc-100">
          {view.song.title}
        </p>
        <button
          type="button"
          data-testid="menu-play-next"
          className={itemClass}
          onClick={() => {
            service.playNext([track]);
            onClose();
          }}
        >
          <Play size={20} />
          {strings.playNext}
        </button>
        <button
          type="button"
          data-testid="menu-add-to-queue"
          className={itemClass}
          onClick={() => {
            service.addToQueue([track]);
            onClose();
          }}
        >
          <ListPlus size={20} />
          {strings.addToQueue}
        </button>
        <button
          type="button"
          data-testid="menu-add-to-playlist"
          className={itemClass}
          onClick={() => setShowAddToPlaylist(true)}
        >
          <Playlist size={20} />
          {strings.addToPlaylist}
        </button>
        <button
          type="button"
          data-testid="menu-toggle-like"
          className={itemClass}
          onClick={() => {
            void getLibraryService()
              .then((s) => s.toggleLiked(view.song.id))
              .then(() => onClose())
              .catch(() => onClose());
          }}
        >
          <Heart size={20} weight={liked ? 'fill' : 'regular'} />
          {liked ? strings.unlike : strings.like}
        </button>
        {!isLocalTrack && downloaded ? (
          <button
            type="button"
            data-testid="menu-delete-download"
            className={`${itemClass} text-red-400`}
            onClick={() => setShowDeleteDownload(true)}
          >
            <Trash size={20} />
            {strings.deleteDownload}
          </button>
        ) : null}
        {!isLocalTrack &&
        !downloaded &&
        (jobStatus === DownloadJobStatus.queued ||
          jobStatus === DownloadJobStatus.running) ? (
          <button
            type="button"
            data-testid="menu-cancel-download"
            className={itemClass}
            onClick={() => {
              void downloadManager()
                .then((manager) => manager.cancel(view.song.id))
                .then(() => {
                  onMessage(strings.downloadCancelled);
                  onClose();
                })
                .catch(() => onClose());
            }}
          >
            <X size={20} />
            {strings.cancelDownload}
          </button>
        ) : null}
        {!isLocalTrack &&
        !downloaded &&
        jobStatus === DownloadJobStatus.failed ? (
          <button
            type="button"
            data-testid="menu-retry-download"
            className={itemClass}
            onClick={() => {
              void downloadManager()
                .then((manager) => manager.retry(view.song.id))
                .then(() => {
                  onMessage(strings.downloadQueued);
                  onClose();
                })
                .catch(() => onClose());
            }}
          >
            <ArrowClockwise size={20} />
            {strings.retryDownload}
          </button>
        ) : null}
        {!isLocalTrack &&
        !downloaded &&
        jobStatus !== DownloadJobStatus.queued &&
        jobStatus !== DownloadJobStatus.running &&
        jobStatus !== DownloadJobStatus.failed ? (
          <button
            type="button"
            data-testid="menu-download"
            className={itemClass}
            onClick={() => setShowQuality(true)}
          >
            <Download size={20} />
            {strings.download}
          </button>
        ) : null}
        {playlistId != null && onMoveUp && (
          <button
            type="button"
            data-testid="menu-move-up"
            className={itemClass}
            onClick={() => {
              onMoveUp();
              onClose();
            }}
          >
            <CaretUp size={20} weight="bold" />
            {strings.moveUp}
          </button>
        )}
        {playlistId != null && onMoveDown && (
          <button
            type="button"
            data-testid="menu-move-down"
            className={itemClass}
            onClick={() => {
              onMoveDown();
              onClose();
            }}
          >
            <CaretDown size={20} weight="bold" />
            {strings.moveDown}
          </button>
        )}
        {playlistId != null && onRemoveFromPlaylist && (
          <button
            type="button"
            data-testid="menu-remove-from-playlist"
            className={`${itemClass} text-red-400`}
            onClick={() => {
              onRemoveFromPlaylist();
              onClose();
            }}
          >
            <Trash size={20} />
            {strings.removeFromPlaylist}
          </button>
        )}
        {playlistId == null && view.song.inLibrary === 1 && (
          <button
            type="button"
            data-testid="menu-remove-from-library"
            className={`${itemClass} text-red-400`}
            onClick={() => {
              void getLibraryService()
                .then((s) => s.removeFromLibrary(view.song.id))
                .then(() => onClose())
                .catch(() => onClose());
            }}
          >
            <Trash size={20} />
            {strings.removeFromLibrary}
          </button>
        )}
        <button
          type="button"
          data-testid="menu-close"
          className="mt-2 flex h-11 w-full items-center justify-center rounded-xl text-sm font-medium text-zinc-400 transition-colors hover:bg-white/5"
          onClick={onClose}
        >
          {strings.cancel}
        </button>
    </Dialog>
  );
}
