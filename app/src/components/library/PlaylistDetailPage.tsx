/**
 * Layar detail playlist: nama, deskripsi, daftar lagu dengan
 * pindah posisi dan hapus, putar semua, ubah, hapus playlist.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  PencilSimple,
  Play,
  Trash,
} from '@phosphor-icons/react';
import { PAGE_SIZE, type LibraryService } from '../../data/library';
import type { PlaylistRow, PlaylistSongEntry } from '../../data/types';
import { getPlayerService } from '../../player/service';
import { useLibraryService, useLibraryStore } from '../../store/library';
import { strings } from '../../strings/id';
import ConfirmDialog from './ConfirmDialog';
import PlaylistDialog from './PlaylistDialog';
import SongMenu from './SongMenu';
import SongRow from './SongRow';
import { tracksFromViews } from './trackFromView';

interface PlaylistDetailPageProps {
  playlistId: number;
  onNavigate: (path: string) => void;
}

export default function PlaylistDetailPage({
  playlistId,
  onNavigate,
}: PlaylistDetailPageProps) {
  const { service, dbError } = useLibraryService();
  const version = useLibraryStore((s) => s.version);
  const [playlist, setPlaylist] = useState<PlaylistRow | null>(null);
  const [entries, setEntries] = useState<PlaylistSongEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [menuEntry, setMenuEntry] = useState<PlaylistSongEntry | null>(null);
  const [showEdit, setShowEdit] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(
    async (svc: LibraryService) => {
      const token = ++requestRef.current;
      setLoading(true);
      setError(false);
      try {
        const row = await svc.playlistById(playlistId);
        if (token !== requestRef.current) return;
        if (!row) {
          setNotFound(true);
          setLoading(false);
          return;
        }
        setPlaylist(row);
        const page = await svc.playlistSongsPage(playlistId, {});
        if (token !== requestRef.current) return;
        setEntries(page);
        setHasMore(page.length === PAGE_SIZE);
      } catch {
        if (token === requestRef.current) setError(true);
      } finally {
        if (token === requestRef.current) setLoading(false);
      }
    },
    [playlistId],
  );

  useEffect(() => {
    if (!service) return;
    void load(service);
  }, [service, version, load]);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 3000);
    return () => clearTimeout(timer);
  }, [message]);

  const loadMore = (): void => {
    if (!service || loadingMore || !hasMore) return;
    setLoadingMore(true);
    const last = entries[entries.length - 1];
    service
      .playlistSongsPage(playlistId, { after: last })
      .then((page) => {
        setEntries((prev) => [...prev, ...page]);
        setHasMore(page.length === PAGE_SIZE);
      })
      .catch(() => setError(true))
      .finally(() => setLoadingMore(false));
  };

  const playFrom = (index: number): void => {
    const views = entries.map((e) => e.song);
    void getPlayerService().playQueue(tracksFromViews(views), index);
  };

  const move = (entry: PlaylistSongEntry, delta: -1 | 1): void => {
    if (!service) return;
    const target = entry.position + delta;
    if (target < 0 || target >= entries.length) return;
    void service
      .moveSongInPlaylist(playlistId, entry.song.song.id, target)
      .catch(() => undefined);
  };

  const removeEntry = (entry: PlaylistSongEntry): void => {
    if (!service) return;
    void service
      .removeSongFromPlaylist(playlistId, entry.song.song.id)
      .then(() => setMessage(strings.songRemoved))
      .catch(() => undefined);
  };

  if (dbError) {
    return (
      <div className="mx-auto max-w-2xl px-4 pt-8" data-testid="playlist-detail">
        <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-4">
          <p className="text-sm font-medium text-zinc-100">
            {strings.libraryErrorTitle}
          </p>
          <p className="mt-1 text-sm leading-relaxed text-zinc-400">
            {strings.libraryErrorBody}
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-2xl px-4 pt-4" data-testid="playlist-detail">
        <ul aria-busy="true" aria-label="Memuat">
          {Array.from({ length: 6 }, (_, i) => (
            <li key={i} className="flex items-center gap-3 px-2 py-3">
              <span className="h-12 w-12 shrink-0 animate-pulse rounded-lg bg-zinc-900" />
              <span className="flex-1">
                <span className="block h-4 w-2/3 animate-pulse rounded bg-zinc-900" />
                <span className="mt-2 block h-3 w-1/3 animate-pulse rounded bg-zinc-900" />
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (notFound || !playlist) {
    return (
      <div className="mx-auto max-w-2xl px-4 pt-8" data-testid="playlist-detail">
        <div className="rounded-xl border border-white/10 bg-zinc-900/50 px-4 py-8 text-center">
          <p className="text-base font-semibold text-zinc-100">
            {strings.playlistNotFoundTitle}
          </p>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-zinc-400">
            {strings.playlistNotFoundBody}
          </p>
          <button
            type="button"
            onClick={() => onNavigate('/library')}
            data-testid="playlist-not-found-back"
            className="mt-4 h-11 rounded-xl bg-white px-4 text-sm font-medium text-black transition-transform duration-150 active:scale-95"
          >
            {strings.backToLibrary}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 pt-4" data-testid="playlist-detail">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onNavigate('/library')}
          aria-label={strings.backToLibrary}
          data-testid="playlist-back"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-zinc-100 transition-colors hover:bg-white/10 active:scale-95"
        >
          <ArrowLeft size={22} />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-bold tracking-tight">
            {playlist.name}
          </h1>
          <p className="text-sm text-zinc-400">
            {entries.length.toLocaleString('id-ID')} {strings.songsLabel}
          </p>
        </div>
      </div>
      {playlist.description && (
        <p className="mt-3 text-sm leading-relaxed text-zinc-400">
          {playlist.description}
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => playFrom(0)}
          disabled={entries.length === 0}
          data-testid="playlist-play-all"
          className="flex h-11 items-center gap-2 rounded-xl bg-white px-4 text-sm font-medium text-black transition-transform duration-150 active:scale-95 disabled:opacity-50"
        >
          <Play size={18} weight="fill" />
          {strings.playAll}
        </button>
        <button
          type="button"
          onClick={() => setShowEdit(true)}
          data-testid="playlist-edit"
          className="flex h-11 items-center gap-2 rounded-xl border border-white/10 px-4 text-sm font-medium text-zinc-100 transition-colors hover:bg-white/10 active:scale-95"
        >
          <PencilSimple size={18} />
          {strings.editPlaylist}
        </button>
        <button
          type="button"
          onClick={() => setShowDelete(true)}
          data-testid="playlist-delete"
          className="flex h-11 items-center gap-2 rounded-xl border border-white/10 px-4 text-sm font-medium text-red-400 transition-colors hover:bg-white/10 active:scale-95"
        >
          <Trash size={18} />
          {strings.delete}
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-4">
          <p className="text-sm text-zinc-100">{strings.libraryErrorBody}</p>
          <button
            type="button"
            onClick={() => service && void load(service)}
            data-testid="playlist-retry"
            className="mt-3 h-11 rounded-xl bg-white px-4 text-sm font-medium text-black transition-transform duration-150 active:scale-95"
          >
            {strings.retry}
          </button>
        </div>
      )}

      {entries.length === 0 && !error ? (
        <div
          className="mt-6 rounded-xl border border-white/10 bg-zinc-900/50 px-4 py-8 text-center"
          data-testid="playlist-empty"
        >
          <p className="text-base font-semibold text-zinc-100">
            Playlist ini masih kosong
          </p>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-zinc-400">
            Tambahkan lagu dari Library lewat menu titik tiga di tiap lagu.
          </p>
        </div>
      ) : (
        <ul className="mt-4 divide-y divide-white/5" data-testid="playlist-song-list">
          {entries.map((entry, index) => (
            <SongRow
              key={entry.song.song.id}
              view={entry.song}
              onPlay={() => playFrom(index)}
              onMenu={() => setMenuEntry(entry)}
              testId={`playlist-song-${entry.song.song.id}`}
            />
          ))}
        </ul>
      )}

      {!loading && !error && hasMore && (
        <button
          type="button"
          onClick={loadMore}
          disabled={loadingMore}
          data-testid="load-more"
          className="mt-4 h-11 w-full rounded-xl border border-white/10 text-sm font-medium text-zinc-100 transition-colors hover:bg-white/10 active:scale-95 disabled:opacity-50"
        >
          {loadingMore ? strings.loadingMore : strings.loadMore}
        </button>
      )}

      {message && (
        <div
          role="status"
          data-testid="playlist-toast"
          className="fixed bottom-24 left-1/2 z-50 -translate-x-1/2 rounded-xl border border-white/10 bg-zinc-900 px-4 py-3 text-sm text-zinc-100 shadow-xl"
        >
          {message}
        </div>
      )}

      {menuEntry && (
        <SongMenu
          view={menuEntry.song}
          playlistId={playlistId}
          onClose={() => setMenuEntry(null)}
          onMessage={setMessage}
          onRemoveFromPlaylist={() => removeEntry(menuEntry)}
          onMoveUp={
            menuEntry.position > 0
              ? () => move(menuEntry, -1)
              : undefined
          }
          onMoveDown={
            menuEntry.position < entries.length - 1
              ? () => move(menuEntry, 1)
              : undefined
          }
        />
      )}

      {showEdit && (
        <PlaylistDialog
          title={strings.editPlaylist}
          submitLabel={strings.save}
          initialName={playlist.name}
          initialDescription={playlist.description}
          onSubmit={(name, description) => {
            setShowEdit(false);
            if (!service) return;
            void (async () => {
              if (name !== playlist.name) {
                await service.renamePlaylist(playlistId, name);
              }
              if ((description ?? null) !== playlist.description) {
                await service.updatePlaylistDescription(playlistId, description);
              }
              setMessage(strings.playlistSaved);
            })().catch(() => undefined);
          }}
          onCancel={() => setShowEdit(false)}
        />
      )}

      {showDelete && (
        <ConfirmDialog
          title={strings.deletePlaylistTitle}
          body={strings.deletePlaylistBody}
          confirmLabel={strings.delete}
          onConfirm={() => {
            setShowDelete(false);
            if (!service) return;
            void service
              .deletePlaylist(playlistId)
              .then(() => onNavigate('/library'))
              .catch(() => undefined);
          }}
          onCancel={() => setShowDelete(false)}
        />
      )}
    </div>
  );
}
