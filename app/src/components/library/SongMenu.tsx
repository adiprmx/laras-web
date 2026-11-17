/**
 * Menu lagu (lembar bawah): putar berikutnya, tambah antrean,
 * tambah ke playlist, suka, hapus dari Library / playlist.
 */
import { useEffect, useState } from 'react';
import {
  CaretDown,
  CaretUp,
  Heart,
  ListPlus,
  Play,
  Playlist,
  Trash,
} from '@phosphor-icons/react';
import { getLibraryService } from '../../data/library';
import type { SongView } from '../../data/types';
import { getPlayerService } from '../../player/service';
import { useLibraryStore } from '../../store/library';
import { strings } from '../../strings/id';
import AddToPlaylistDialog from './AddToPlaylistDialog';
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
  const [showAddToPlaylist, setShowAddToPlaylist] = useState(false);
  const track = trackFromView(view);

  useEffect(() => {
    let alive = true;
    getLibraryService()
      .then((service) => service.isLiked(view.song.id))
      .then((value) => {
        if (alive) setLiked(value);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [view.song.id, version]);

  const service = getPlayerService();

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
    <div
      role="dialog"
      aria-modal="true"
      aria-label={view.song.title}
      data-testid="song-menu"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-white/10 bg-zinc-900 p-3"
        onClick={(e) => e.stopPropagation()}
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
      </div>
    </div>
  );
}
